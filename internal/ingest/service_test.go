// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package ingest

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"testing"

	"github.com/garudex-labs/caracal/internal/harness"
)

// fakeStore is an in-memory Store tracking calls for assertions.
type fakeStore struct {
	events        []StoredEvent
	checkpointVal int
	checkpointOff int64
	sourceRecords []SourcePos
	manifest      []ManifestEntry
	existing      map[int]string

	insertedBatches  [][]StoredEvent
	checkpointsSet   [][2]int64
	summaryRefreshes int
	failInsert       error
}

func newFakeStore() *fakeStore {
	return &fakeStore{checkpointVal: -1, existing: map[int]string{}}
}

func (f *fakeStore) InsertEvents(_ context.Context, events []StoredEvent) error {
	if f.failInsert != nil {
		return f.failInsert
	}
	f.events = append(f.events, events...)
	f.insertedBatches = append(f.insertedBatches, events)
	return nil
}

func (f *fakeStore) InsertCheckpoint(_ context.Context, _ SessionKey, line int, offset int64) error {
	f.checkpointVal, f.checkpointOff = line, offset
	f.checkpointsSet = append(f.checkpointsSet, [2]int64{int64(line), offset})
	return nil
}

func (f *fakeStore) RefreshSummary(context.Context, SessionKey) error {
	f.summaryRefreshes++
	return nil
}

func (f *fakeStore) Checkpoint(context.Context, SessionKey) (int, int64, error) {
	return f.checkpointVal, f.checkpointOff, nil
}

func (f *fakeStore) SourceRecordsAfter(_ context.Context, _ SessionKey, afterLine, limit int) ([]SourcePos, error) {
	var out []SourcePos
	for _, r := range f.sourceRecords {
		if r.LineOffset > afterLine {
			out = append(out, r)
		}
		if len(out) == limit {
			break
		}
	}
	return out, nil
}

func (f *fakeStore) SourceManifest(context.Context, SessionKey) ([]ManifestEntry, error) {
	return f.manifest, nil
}

func (f *fakeStore) ExistingLineHashes(_ context.Context, _ SessionKey, minOffset, maxOffset int) (map[int]string, error) {
	out := map[int]string{}
	for off, hash := range f.existing {
		if off >= minOffset && off <= maxOffset {
			out[off] = hash
		}
	}
	return out, nil
}

var testKey = SessionKey{SessionID: "sess-1", ProjectID: "project-test", UserID: "user-1", Harness: "claude-code"}

func newService(store Store) *Service {
	return &Service{Store: store, Registry: harness.MustLoad()}
}

func linesRequest(lines []string, startOffset int) LinesRequest {
	return LinesRequest{Key: testKey, Lines: lines, StartOffset: startOffset}
}

var sampleLines = []string{
	`{"type":"user","uuid":"u1","timestamp":"2026-03-01T10:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}`,
	`{"type":"assistant","uuid":"a1","parentUuid":"u1","message":{"content":[{"type":"text","text":"hello"}]}}`,
}

func TestIngestLinesStoresRowsWithAttribution(t *testing.T) {
	store := newFakeStore()
	svc := newService(store)
	agentID := "agent-1"

	req := linesRequest(sampleLines, 0)
	req.AgentID = &agentID
	result, err := svc.IngestLines(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if result.Ingested != 2 || result.Skipped != 0 || result.Errors != 0 {
		t.Fatalf("result = %+v", result)
	}
	if len(store.events) != 2 {
		t.Fatalf("stored %d events", len(store.events))
	}
	first := store.events[0]
	if first.SessionID != "sess-1" || first.UserID != "user-1" || *first.AgentID != "agent-1" {
		t.Errorf("attribution wrong: %+v", first)
	}
	if first.EventType != "user_prompt" || first.LineOffset != 0 {
		t.Errorf("classification wrong: %+v", first.Row)
	}
	// The second line has no timestamp and must inherit the first line's.
	if store.events[1].Timestamp != "2026-03-01 10:00:00.000" {
		t.Errorf("timestamp inheritance broken: %q", store.events[1].Timestamp)
	}
	if store.summaryRefreshes != 1 {
		t.Errorf("summary refreshed %d times", store.summaryRefreshes)
	}
}

func TestIngestLinesSkipsStoredIdenticalContent(t *testing.T) {
	store := newFakeStore()
	store.existing = map[int]string{0: lineHash(sampleLines[0]), 1: lineHash(sampleLines[1])}
	store.checkpointVal = 1 // both acknowledged
	svc := newService(store)

	result, err := svc.IngestLines(context.Background(), linesRequest(sampleLines, 0))
	if err != nil {
		t.Fatal(err)
	}
	if result.Skipped != 2 || result.Ingested != 0 {
		t.Fatalf("result = %+v", result)
	}
	if len(store.events) != 0 {
		t.Fatalf("stored %d events for a fully deduplicated batch", len(store.events))
	}
}

func TestIngestLinesConflictBelowCheckpoint(t *testing.T) {
	store := newFakeStore()
	store.existing = map[int]string{0: "different-hash"}
	store.checkpointVal = 0 // line 0 acknowledged
	svc := newService(store)

	_, err := svc.IngestLines(context.Background(), linesRequest(sampleLines, 0))
	var conflict *RecordConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("err = %v, want RecordConflictError", err)
	}
	if len(conflict.Offsets) != 1 || conflict.Offsets[0] != 0 {
		t.Errorf("offsets = %v", conflict.Offsets)
	}
	if len(store.events) != 0 {
		t.Error("conflicting batch must not store anything")
	}
}

func TestIngestLinesRepairsAboveCheckpoint(t *testing.T) {
	store := newFakeStore()
	store.existing = map[int]string{1: "stale-hash"} // stored but not acknowledged
	store.checkpointVal = 0
	svc := newService(store)

	result, err := svc.IngestLines(context.Background(), linesRequest(sampleLines, 0))
	if err != nil {
		t.Fatal(err)
	}
	// Line 0 is new, line 1 is repairable: both rebuilt.
	if result.Ingested != 2 {
		t.Fatalf("result = %+v", result)
	}
	if len(store.events) != 2 {
		t.Fatalf("stored %d events", len(store.events))
	}
}

func TestIngestLinesDeduplicatedLineDoesNotFeedTimestamps(t *testing.T) {
	store := newFakeStore()
	store.existing = map[int]string{0: lineHash(sampleLines[0])}
	store.checkpointVal = 0
	svc := newService(store)

	result, err := svc.IngestLines(context.Background(), linesRequest(sampleLines, 0))
	if err != nil {
		t.Fatal(err)
	}
	if result.Skipped != 1 || result.Ingested != 1 {
		t.Fatalf("result = %+v", result)
	}
	// The rebuilt line has no timestamp of its own; the skipped line's
	// timestamp must NOT leak into it, so it falls back to ingestion time.
	if got := store.events[0].Timestamp; got == "2026-03-01 10:00:00.000" {
		t.Errorf("deduplicated line leaked its timestamp into a rebuilt row: %q", got)
	}
}

func TestIngestLinesEmptyWithKiroCredits(t *testing.T) {
	store := newFakeStore()
	svc := newService(store)
	credits := 2.5

	req := LinesRequest{
		Key:          SessionKey{SessionID: "s", ProjectID: "project-test", UserID: "u", Harness: "kiro"},
		TotalCredits: &credits,
	}
	result, err := svc.IngestLines(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if result != (Result{}) {
		t.Fatalf("result = %+v", result)
	}
	if len(store.events) != 1 {
		t.Fatalf("stored %d events", len(store.events))
	}
	row := store.events[0]
	if row.EventType != "kiro_credits" || row.LineOffset != 0xFFFFFFFF || row.Credits != 2.5 {
		t.Errorf("credits row wrong: %+v", row)
	}
	if row.IsSourceRecord != 0 || row.Rendered != 1 {
		t.Errorf("credits row flags wrong: %+v", row)
	}
	if row.ContentPreview != "2.500000 credits" {
		t.Errorf("preview = %q", row.ContentPreview)
	}
	if store.summaryRefreshes != 1 {
		t.Errorf("summary refreshed %d times", store.summaryRefreshes)
	}
}

func TestIngestLinesEmptyWithoutCreditsIsNoOp(t *testing.T) {
	store := newFakeStore()
	svc := newService(store)

	result, err := svc.IngestLines(context.Background(), linesRequest(nil, 0))
	if err != nil {
		t.Fatal(err)
	}
	if result != (Result{}) || len(store.events) != 0 || store.summaryRefreshes != 0 {
		t.Fatalf("empty non-kiro delivery must be a no-op: %+v", result)
	}
}

func TestAdvanceCheckpointStopsAtGap(t *testing.T) {
	store := newFakeStore()
	store.sourceRecords = []SourcePos{
		{LineOffset: 0, EndOffset: 10},
		{LineOffset: 1, EndOffset: 20},
		{LineOffset: 3, EndOffset: 40}, // gap at 2
	}
	svc := newService(store)

	line, offset, err := svc.AdvanceCheckpoint(context.Background(), testKey)
	if err != nil {
		t.Fatal(err)
	}
	if line != 1 || offset != 20 {
		t.Errorf("checkpoint = (%d, %d), want (1, 20)", line, offset)
	}
	if store.checkpointVal != 1 || store.checkpointOff != 20 {
		t.Error("checkpoint not persisted")
	}
}

func TestAdvanceCheckpointContiguous(t *testing.T) {
	store := newFakeStore()
	for i := 0; i < 7; i++ {
		store.sourceRecords = append(store.sourceRecords, SourcePos{LineOffset: i, EndOffset: int64((i + 1) * 10)})
	}
	svc := newService(store)

	line, offset, err := svc.AdvanceCheckpoint(context.Background(), testKey)
	if err != nil {
		t.Fatal(err)
	}
	if line != 6 || offset != 70 {
		t.Errorf("checkpoint = (%d, %d), want (6, 70)", line, offset)
	}
}

func manifestFor(lines []string) []ManifestEntry {
	out := make([]ManifestEntry, len(lines))
	for i, line := range lines {
		row := mustBuildRow(line, i)
		out[i] = ManifestEntry{LineOffset: i, EndOffset: int64((i + 1) * 100), SourceSHA256: row.SourceSHA256}
	}
	return out
}

func mustBuildRow(line string, offset int) Row {
	b, err := NewBuilder(harness.MustLoad(), "claude-code")
	if err != nil {
		panic(err)
	}
	row, _ := b.Build(line, offset, 0)
	return row
}

// chainHash reproduces the sender-side chained source hash.
func chainHash(entries []ManifestEntry) string {
	hasher := sha256.New()
	for _, e := range entries {
		hasher.Write([]byte(e.SourceSHA256))
		hasher.Write([]byte("\n"))
	}
	return hex.EncodeToString(hasher.Sum(nil))
}

func TestCheckIntegrityComplete(t *testing.T) {
	store := newFakeStore()
	store.manifest = manifestFor(sampleLines)
	svc := newService(store)
	expected := chainHash(store.manifest)
	hashed := len(sampleLines)

	res, err := svc.CheckIntegrity(context.Background(), testKey, IntegrityParams{
		ExpectedLineCount:  2,
		ExpectedOffset:     200,
		AcknowledgedLine:   1,
		AcknowledgedOffset: 200,
		ExpectedHash:       &expected,
		HashedLineCount:    &hashed,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !res.OK || res.RepairFromLine != nil {
		t.Errorf("integrity = %+v, want ok", res)
	}
	if res.ServerHash == nil || *res.ServerHash != expected {
		t.Errorf("server hash mismatch")
	}
}

func TestCheckIntegrityMissingLineRequestsRepair(t *testing.T) {
	store := newFakeStore()
	full := manifestFor(sampleLines)
	store.manifest = []ManifestEntry{full[0]} // line 1 missing
	svc := newService(store)
	expected := chainHash(full)
	hashed := 2

	res, err := svc.CheckIntegrity(context.Background(), testKey, IntegrityParams{
		ExpectedLineCount:  2,
		ExpectedOffset:     200,
		AcknowledgedLine:   0,
		AcknowledgedOffset: 100,
		ExpectedHash:       &expected,
		HashedLineCount:    &hashed,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.OK {
		t.Error("integrity must fail with a missing line")
	}
	if res.RepairFromLine == nil || *res.RepairFromLine != 1 {
		t.Fatalf("repair_from_line = %v, want 1", res.RepairFromLine)
	}
	if res.RepairOffset != 100 {
		t.Errorf("repair offset = %d, want the end of line 0", res.RepairOffset)
	}
}

func TestCheckIntegrityHashMismatchReplaysFromStart(t *testing.T) {
	store := newFakeStore()
	store.manifest = manifestFor(sampleLines)
	svc := newService(store)
	wrong := "0000000000000000000000000000000000000000000000000000000000000000"
	hashed := 2

	res, err := svc.CheckIntegrity(context.Background(), testKey, IntegrityParams{
		ExpectedLineCount:  2,
		ExpectedOffset:     200,
		AcknowledgedLine:   1,
		AcknowledgedOffset: 200,
		ExpectedHash:       &wrong,
		HashedLineCount:    &hashed,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.OK || res.RepairFromLine == nil || *res.RepairFromLine != 0 {
		t.Fatalf("integrity = %+v, want repair from 0", res)
	}
	if res.RepairOffset != 0 {
		t.Errorf("repair offset = %d, want 0 for full replay", res.RepairOffset)
	}
}

func TestIngestLinesInsertFailurePropagates(t *testing.T) {
	store := newFakeStore()
	store.failInsert = fmt.Errorf("storage down")
	svc := newService(store)

	if _, err := svc.IngestLines(context.Background(), linesRequest(sampleLines, 0)); err == nil {
		t.Fatal("insert failure must propagate, never silently drop lines")
	}
}
