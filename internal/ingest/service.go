// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package ingest

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/garudex-labs/caracal/internal/harness"
)

// sourceRecordsPage is the page size used when advancing checkpoints.
const sourceRecordsPage = 5000

// RecordConflictError reports acknowledged source lines that arrived again
// with different content; retrying cannot resolve it.
type RecordConflictError struct {
	Offsets []int
}

func (e *RecordConflictError) Error() string {
	parts := make([]string, len(e.Offsets))
	for i, off := range e.Offsets {
		parts[i] = fmt.Sprint(off)
	}
	return "session source content changed at line(s): " + strings.Join(parts, ", ")
}

// LinesRequest is one delivery of raw transcript lines for a session.
type LinesRequest struct {
	Key             SessionKey
	AgentID         *string
	AgentVersion    *string
	LayerHash       *string
	ParentSessionID *string
	Lines           []string
	StartOffset     int
	EndByteOffsets  []int64 // one per line; nil when the sender has none
	TotalCredits    *float64
}

// Result counts the dispositions of one delivery.
type Result struct {
	Ingested int
	Skipped  int
	Errors   int
}

// IntegrityResult reports the final source-continuity audit for a session.
type IntegrityResult struct {
	OK                 bool
	AcknowledgedLine   int
	AcknowledgedOffset int64
	ExpectedLine       int
	ExpectedOffset     int64
	ServerHash         *string
	RepairFromLine     *int
	RepairOffset       int64
}

// Service implements the session ingest protocol: idempotent line storage
// with conflict detection, contiguous checkpoint acknowledgement, and final
// integrity auditing.
type Service struct {
	Store    Store
	Registry *harness.Registry
	// Agents normalizes attribution before storage; nil skips normalization.
	Agents *AgentResolver
}

// IngestLines stores one delivery. Lines already stored with identical
// content are skipped; already-acknowledged lines with different content are
// a conflict; stored-but-unacknowledged lines are rebuilt so senders can
// repair partial deliveries.
func (s *Service) IngestLines(ctx context.Context, req LinesRequest) (Result, error) {
	if req.EndByteOffsets != nil && len(req.EndByteOffsets) != len(req.Lines) {
		return Result{}, fmt.Errorf("end byte offsets must contain one value per source line")
	}
	if s.Agents != nil {
		req.AgentID, req.AgentVersion = s.Agents.Resolve(ctx, req.Key.ProjectID, req.AgentID, req.AgentVersion)
	}

	if len(req.Lines) == 0 {
		extra := s.extraEvents(req)
		if len(extra) == 0 {
			return Result{}, nil
		}
		if err := s.Store.InsertEvents(ctx, extra); err != nil {
			return Result{}, err
		}
		return Result{}, s.Store.RefreshSummary(ctx, req.Key)
	}

	maxOffset := req.StartOffset + len(req.Lines) - 1
	existing, err := s.Store.ExistingLineHashes(ctx, req.Key, req.StartOffset, maxOffset)
	if err != nil {
		return Result{}, err
	}

	hashes := make([]string, len(req.Lines))
	var conflicts []int
	for i, line := range req.Lines {
		hashes[i] = lineHash(line)
		offset := req.StartOffset + i
		if stored, ok := existing[offset]; ok && stored != hashes[i] {
			conflicts = append(conflicts, offset)
		}
	}

	repairable := map[int]bool{}
	if len(existing) > 0 {
		checkpointLine, _, err := s.Store.Checkpoint(ctx, req.Key)
		if err != nil {
			return Result{}, err
		}
		var blocked []int
		for _, offset := range conflicts {
			if offset <= checkpointLine {
				blocked = append(blocked, offset)
			}
		}
		if len(blocked) > 0 {
			sort.Ints(blocked)
			return Result{}, &RecordConflictError{Offsets: blocked}
		}
		for offset := range existing {
			if offset > checkpointLine {
				repairable[offset] = true
			}
		}
	}

	builder, err := NewBuilder(s.Registry, req.Key.Harness)
	if err != nil {
		return Result{}, err
	}

	var result Result
	events := make([]StoredEvent, 0, len(req.Lines))
	for i, rawLine := range req.Lines {
		offset := req.StartOffset + i
		if _, stored := existing[offset]; stored && !repairable[offset] {
			result.Skipped++
			continue // already stored; contributes nothing, not even a timestamp
		}
		var endOffset int64
		if req.EndByteOffsets != nil {
			endOffset = req.EndByteOffsets[i]
		}
		row, disposition := builder.Build(rawLine, offset, endOffset)
		switch disposition {
		case LineRendered:
			result.Ingested++
		case LineIgnored:
			result.Skipped++
		case LineParseError:
			result.Errors++
		}
		events = append(events, s.storedEvent(req, row))
	}

	if len(events) > 0 {
		if err := s.Store.InsertEvents(ctx, events); err != nil {
			return Result{}, err
		}
	}
	extra := s.extraEvents(req)
	if len(extra) > 0 {
		if err := s.Store.InsertEvents(ctx, extra); err != nil {
			return Result{}, err
		}
	}
	if len(events) > 0 || len(extra) > 0 {
		if err := s.Store.RefreshSummary(ctx, req.Key); err != nil {
			return Result{}, err
		}
	}
	return result, nil
}

func (s *Service) storedEvent(req LinesRequest, row Row) StoredEvent {
	return StoredEvent{
		Row:             row,
		SessionID:       req.Key.SessionID,
		ProjectID:       req.Key.ProjectID,
		UserID:          req.Key.UserID,
		AgentID:         req.AgentID,
		AgentVersion:    req.AgentVersion,
		LayerHash:       req.LayerHash,
		ParentSessionID: req.ParentSessionID,
	}
}

// extraEvents returns harness-specific bookkeeping rows. Kiro sessions store
// one replaceable credits row at a sentinel offset so the sessions list can
// aggregate credits without scanning transcripts.
func (s *Service) extraEvents(req LinesRequest) []StoredEvent {
	parserID, err := s.Registry.SessionParserID(req.Key.Harness)
	if err != nil || parserID != "kiro" {
		return nil
	}
	if req.TotalCredits == nil || *req.TotalCredits <= 0 {
		return nil
	}
	credits := *req.TotalCredits
	rawLine, _ := json.Marshal(map[string]any{"kind": "KiroCredits", "credits": credits, "model": "Kiro Auto"})
	return []StoredEvent{{
		Row: Row{
			Harness:        req.Key.Harness,
			LineOffset:     0xFFFFFFFF,
			IsSourceRecord: 0,
			Rendered:       1,
			EventType:      "kiro_credits",
			Timestamp:      "2099-12-31 00:00:00.000",
			ContentPreview: fmt.Sprintf("%.6f credits", credits),
			RawLine:        string(rawLine),
			Credits:        credits,
		},
		SessionID:    req.Key.SessionID,
		ProjectID:    req.Key.ProjectID,
		UserID:       req.Key.UserID,
		AgentID:      req.AgentID,
		AgentVersion: req.AgentVersion,
	}}
}

// AdvanceCheckpoint extends the acknowledged position over every contiguous
// stored source line and persists the result.
func (s *Service) AdvanceCheckpoint(ctx context.Context, key SessionKey) (int, int64, error) {
	line, offset, err := s.Store.Checkpoint(ctx, key)
	if err != nil {
		return 0, 0, err
	}
	for {
		records, err := s.Store.SourceRecordsAfter(ctx, key, line, sourceRecordsPage)
		if err != nil {
			return 0, 0, err
		}
		if len(records) == 0 {
			break
		}
		expected := line + 1
		advanced := false
		for _, record := range records {
			if record.LineOffset < expected {
				continue
			}
			if record.LineOffset != expected {
				break
			}
			line = record.LineOffset
			offset = record.EndOffset
			expected++
			advanced = true
		}
		if !advanced || len(records) < sourceRecordsPage || records[len(records)-1].LineOffset != line {
			break
		}
	}
	if err := s.Store.InsertCheckpoint(ctx, key, line, offset); err != nil {
		return 0, 0, err
	}
	return line, offset, nil
}

// IntegrityParams carries the sender's view of the complete session source.
type IntegrityParams struct {
	ExpectedLineCount  int
	ExpectedOffset     int64
	AcknowledgedLine   int
	AcknowledgedOffset int64
	ExpectedHash       *string // chained sha256 the sender computed
	HashedLineCount    *int    // lines covered by ExpectedHash
}

// CheckIntegrity audits final source continuity, and content when the sender
// supplied a hash. A non-nil RepairFromLine tells the sender where to replay.
func (s *Service) CheckIntegrity(ctx context.Context, key SessionKey, p IntegrityParams) (IntegrityResult, error) {
	expectedLine := p.ExpectedLineCount - 1
	offsetOK := p.ExpectedOffset == 0 || p.AcknowledgedOffset == 0 || p.AcknowledgedOffset == p.ExpectedOffset

	var repairFromLine *int
	if p.AcknowledgedLine < expectedLine {
		v := p.AcknowledgedLine + 1
		repairFromLine = &v
	}

	var serverHash *string
	var manifest []ManifestEntry
	if p.ExpectedHash != nil {
		var err error
		manifest, err = s.Store.SourceManifest(ctx, key)
		if err != nil {
			return IntegrityResult{}, err
		}
		hashCount := p.ExpectedLineCount
		if p.HashedLineCount != nil {
			hashCount = *p.HashedLineCount
		}
		hasher := sha256.New()
		nextOffset := 0
		var missingOffset *int
		for _, entry := range manifest {
			if entry.LineOffset >= hashCount {
				continue
			}
			hasher.Write([]byte(entry.SourceSHA256))
			hasher.Write([]byte("\n"))
			if missingOffset == nil && entry.LineOffset != nextOffset {
				v := nextOffset
				missingOffset = &v
			}
			nextOffset++
		}
		digest := hex.EncodeToString(hasher.Sum(nil))
		serverHash = &digest
		if missingOffset == nil && nextOffset < hashCount {
			v := nextOffset
			missingOffset = &v
		}
		switch {
		case missingOffset != nil:
			repairFromLine = minLinePtr(repairFromLine, *missingOffset)
		case digest != *p.ExpectedHash:
			repairFromLine = minLinePtr(repairFromLine, 0)
		}
	}

	var repairOffset int64
	if repairFromLine != nil && *repairFromLine > 0 && len(manifest) > 0 {
		for _, entry := range manifest {
			if entry.LineOffset == *repairFromLine-1 {
				repairOffset = entry.EndOffset
				break
			}
		}
	}

	return IntegrityResult{
		OK:                 p.AcknowledgedLine == expectedLine && offsetOK && repairFromLine == nil,
		AcknowledgedLine:   p.AcknowledgedLine,
		AcknowledgedOffset: p.AcknowledgedOffset,
		ExpectedLine:       expectedLine,
		ExpectedOffset:     p.ExpectedOffset,
		ServerHash:         serverHash,
		RepairFromLine:     repairFromLine,
		RepairOffset:       repairOffset,
	}, nil
}

func minLinePtr(current *int, candidate int) *int {
	if current == nil || candidate < *current {
		return &candidate
	}
	return current
}
