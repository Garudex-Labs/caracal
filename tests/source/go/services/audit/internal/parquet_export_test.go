// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Parquet exporter tests: watermark-driven ticks, S3 upload, and catch-up behavior.

package internal

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

// s3Recorder captures object PUTs and optionally rejects them.
type s3Recorder struct {
	mu     sync.Mutex
	puts   []string
	status int
	body   string
}

func (r *s3Recorder) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodPut {
			w.WriteHeader(http.StatusOK)
			return
		}
		r.mu.Lock()
		r.puts = append(r.puts, req.URL.Path)
		r.mu.Unlock()
		if r.status != 0 {
			w.Header().Set("Content-Type", "application/xml")
			w.WriteHeader(r.status)
			_, _ = w.Write([]byte(r.body))
			return
		}
		w.Header().Set("ETag", `"stub"`)
		w.WriteHeader(http.StatusOK)
	})
}

func (r *s3Recorder) putCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.puts)
}

type exportOutcome struct {
	events int64
	failed bool
}

func exporterFixture(t *testing.T, store *fakeLifecycleStore, recorder *s3Recorder) (*ParquetExporter, *[]exportOutcome, *int64) {
	t.Helper()
	t.Setenv("AWS_ACCESS_KEY_ID", "test")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "test")
	t.Setenv("AWS_EC2_METADATA_DISABLED", "true")
	srv := httptest.NewServer(recorder.handler())
	t.Cleanup(srv.Close)

	exporter, err := newParquetExporter(store, Config{
		S3Bucket:   "caracal-audit",
		S3Endpoint: srv.URL,
		S3Region:   "us-east-1",
	}, nil, zerolog.Nop())
	if err != nil {
		t.Fatal(err)
	}
	outcomes := &[]exportOutcome{}
	backlog := new(int64)
	exporter.onExport = func(events, _ int64, failed bool) {
		*outcomes = append(*outcomes, exportOutcome{events: events, failed: failed})
	}
	exporter.onBacklog = func(hours int64) { *backlog = hours }
	return exporter, outcomes, backlog
}

func exportRows(hour time.Time) []EventRow {
	return []EventRow{
		{Event: AuditEvent{ID: "event-1", ZoneID: "zone-1", Decision: "allow", OccurredAt: hour}, ContentSHA256: "sha-1", ChainHMAC: "mac-1", ChainSeq: 1},
		{Event: AuditEvent{ID: "event-2", ZoneID: "zone-1", Decision: "deny", OccurredAt: hour.Add(time.Minute)}, ContentSHA256: "sha-2", ChainHMAC: "mac-2", ChainSeq: 2},
	}
}

func TestParquetTickExportsPreviousHourOnFreshInstall(t *testing.T) {
	target := time.Now().UTC().Truncate(time.Hour).Add(-time.Hour)
	store := &fakeLifecycleStore{events: exportRows(target)}
	recorder := &s3Recorder{}
	exporter, outcomes, backlog := exporterFixture(t, store, recorder)

	exporter.tick(context.Background())

	if recorder.putCount() != 1 {
		t.Fatalf("puts = %d, want 1", recorder.putCount())
	}
	recorder.mu.Lock()
	path := recorder.puts[0]
	recorder.mu.Unlock()
	wantKey := "/caracal-audit/audit/" + target.Format("2006/01/02") + "/" + target.Format("2006-01-02T15") + ".parquet"
	if path != wantKey {
		t.Fatalf("object key = %q, want %q", path, wantKey)
	}
	if len(store.saved) != 1 || !store.saved[0].Equal(target) {
		t.Fatalf("watermark saves = %v, want [%v]", store.saved, target)
	}
	if *backlog != 1 || len(*outcomes) != 1 || (*outcomes)[0].events != 2 || (*outcomes)[0].failed {
		t.Fatalf("backlog=%d outcomes=%v", *backlog, *outcomes)
	}
}

func TestParquetTickCatchesUpBackloggedHours(t *testing.T) {
	target := time.Now().UTC().Truncate(time.Hour).Add(-time.Hour)
	store := &fakeLifecycleStore{events: exportRows(target), watermark: target.Add(-2 * time.Hour)}
	recorder := &s3Recorder{}
	exporter, outcomes, backlog := exporterFixture(t, store, recorder)

	exporter.tick(context.Background())

	if *backlog != 2 {
		t.Fatalf("backlog = %d, want 2", *backlog)
	}
	if recorder.putCount() != 2 || len(store.saved) != 2 {
		t.Fatalf("puts=%d saves=%d, want catch-up across both hours", recorder.putCount(), len(store.saved))
	}
	if len(*outcomes) != 2 {
		t.Fatalf("outcomes = %v", *outcomes)
	}
}

func TestParquetTickSkipsUploadForEmptyHour(t *testing.T) {
	store := &fakeLifecycleStore{}
	recorder := &s3Recorder{}
	exporter, outcomes, _ := exporterFixture(t, store, recorder)

	exporter.tick(context.Background())

	if recorder.putCount() != 0 {
		t.Fatalf("empty hour must not upload, puts=%d", recorder.putCount())
	}
	if len(store.saved) != 1 {
		t.Fatalf("empty hour must still advance the watermark, saves=%v", store.saved)
	}
	if len(*outcomes) != 1 || (*outcomes)[0].events != 0 || (*outcomes)[0].failed {
		t.Fatalf("outcomes = %v", *outcomes)
	}
}

func TestParquetExportTreatsExistingObjectAsSuccess(t *testing.T) {
	target := time.Now().UTC().Truncate(time.Hour).Add(-time.Hour)
	store := &fakeLifecycleStore{events: exportRows(target)}
	recorder := &s3Recorder{
		status: http.StatusPreconditionFailed,
		body:   `<?xml version="1.0" encoding="UTF-8"?><Error><Code>PreconditionFailed</Code><Message>object exists</Message></Error>`,
	}
	exporter, outcomes, _ := exporterFixture(t, store, recorder)

	exporter.tick(context.Background())

	if len(store.saved) != 1 {
		t.Fatalf("existing object must not block the watermark, saves=%v", store.saved)
	}
	if len(*outcomes) != 1 || (*outcomes)[0].failed {
		t.Fatalf("outcomes = %v", *outcomes)
	}
}

func TestParquetTickStopsOnStoreFailures(t *testing.T) {
	t.Run("watermark load failure", func(t *testing.T) {
		store := &fakeLifecycleStore{watermarkEr: errors.New("pg down")}
		recorder := &s3Recorder{}
		exporter, outcomes, _ := exporterFixture(t, store, recorder)
		exporter.tick(context.Background())
		if recorder.putCount() != 0 || len(*outcomes) != 0 {
			t.Fatalf("watermark failure must halt the tick: puts=%d outcomes=%v", recorder.putCount(), *outcomes)
		}
	})

	t.Run("query failure marks the export failed", func(t *testing.T) {
		store := &fakeLifecycleStore{queryErr: errors.New("pg down")}
		recorder := &s3Recorder{}
		exporter, outcomes, _ := exporterFixture(t, store, recorder)
		exporter.tick(context.Background())
		if len(*outcomes) != 1 || !(*outcomes)[0].failed {
			t.Fatalf("outcomes = %v", *outcomes)
		}
		if len(store.saved) != 0 {
			t.Fatalf("failed export must not advance the watermark, saves=%v", store.saved)
		}
	})

	t.Run("save watermark failure stops catch-up", func(t *testing.T) {
		target := time.Now().UTC().Truncate(time.Hour).Add(-time.Hour)
		store := &fakeLifecycleStore{events: exportRows(target), watermark: target.Add(-2 * time.Hour), saveErr: errors.New("pg down")}
		recorder := &s3Recorder{}
		exporter, _, _ := exporterFixture(t, store, recorder)
		exporter.tick(context.Background())
		if recorder.putCount() != 1 {
			t.Fatalf("save failure must stop after the first hour, puts=%d", recorder.putCount())
		}
	})
}

func TestParquetTickDefersToLeaderElection(t *testing.T) {
	target := time.Now().UTC().Truncate(time.Hour).Add(-time.Hour)
	store := &fakeLifecycleStore{events: exportRows(target)}
	recorder := &s3Recorder{}
	exporter, _, _ := exporterFixture(t, store, recorder)
	exporter.leader = newLeader(nil, exportLockKey, zerolog.Nop())

	exporter.tick(context.Background())

	if recorder.putCount() != 0 || len(store.saved) != 0 {
		t.Fatalf("non-leader must not export: puts=%d saves=%v", recorder.putCount(), store.saved)
	}
}
