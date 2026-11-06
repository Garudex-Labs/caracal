// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Audit server admin search and DLQ handler tests.

package internal

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
)

type fakeServerStore struct {
	searchParams SearchParams
	searchRows   []EventRow
	searchErr    error
	pingErr      error
}

func (f *fakeServerStore) Ping(context.Context) error {
	return f.pingErr
}

func (f *fakeServerStore) Search(_ context.Context, params SearchParams) ([]EventRow, error) {
	f.searchParams = params
	return f.searchRows, f.searchErr
}

func (f *fakeServerStore) RehashChains(context.Context, zerolog.Logger) error {
	return nil
}

type fakeServerRedis struct {
	pingErr       error
	xrange        []redis.XMessage
	xrangeErr     error
	xaddErr       error
	xdelErr       error
	xlen          int64
	xlenErr       error
	xpending      *redis.XPending
	xpendingErr   error
	xpendingExt   []redis.XPendingExt
	xpendingExErr error
	added         []map[string]any
	deleted       []string
}

func (f *fakeServerRedis) Ping(context.Context) *redis.StatusCmd {
	return redis.NewStatusResult("PONG", f.pingErr)
}

func (f *fakeServerRedis) XAdd(_ context.Context, args *redis.XAddArgs) *redis.StringCmd {
	if values, ok := args.Values.(map[string]any); ok {
		cp := make(map[string]any, len(values))
		for k, v := range values {
			cp[k] = v
		}
		f.added = append(f.added, cp)
	}
	return redis.NewStringResult("1-0", f.xaddErr)
}

func (f *fakeServerRedis) XDel(_ context.Context, _ string, ids ...string) *redis.IntCmd {
	f.deleted = append(f.deleted, ids...)
	return redis.NewIntResult(int64(len(ids)), f.xdelErr)
}

func (f *fakeServerRedis) XLen(context.Context, string) *redis.IntCmd {
	return redis.NewIntResult(f.xlen, f.xlenErr)
}

func (f *fakeServerRedis) XPending(context.Context, string, string) *redis.XPendingCmd {
	return redis.NewXPendingResult(f.xpending, f.xpendingErr)
}

func (f *fakeServerRedis) XPendingExt(ctx context.Context, _ *redis.XPendingExtArgs) *redis.XPendingExtCmd {
	cmd := redis.NewXPendingExtCmd(ctx)
	if f.xpendingExErr != nil {
		cmd.SetErr(f.xpendingExErr)
		return cmd
	}
	cmd.SetVal(f.xpendingExt)
	return cmd
}

func (f *fakeServerRedis) XRangeN(context.Context, string, string, string, int64) *redis.XMessageSliceCmd {
	return redis.NewXMessageSliceCmdResult(f.xrange, f.xrangeErr)
}

func adminServer(store *fakeServerStore, r *fakeServerRedis) *Server {
	return &Server{
		cfg:          Config{AdminToken: "tok"},
		pg:           store,
		redis:        r,
		log:          zerolog.Nop(),
		consumer:     &Consumer{},
		sweeper:      &TamperSweeper{},
		retention:    &Retention{},
		exporterLead: &Leader{},
		retentLead:   &Leader{},
	}
}

func authorizedRequest(method, target string) *http.Request {
	req := httptest.NewRequest(method, target, nil)
	req.Header.Set("Authorization", "Bearer tok")
	return req
}

func TestHandleSearchReturnsFilteredResultsAndCursor(t *testing.T) {
	store := &fakeServerStore{searchRows: []EventRow{{
		Event:    AuditEvent{ID: "event-1", ZoneID: "zone-1", Decision: "allow", OccurredAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)},
		ChainSeq: 7,
	}}}
	s := adminServer(store, &fakeServerRedis{})
	req := authorizedRequest(http.MethodGet, "/api/audit/search?zone_id=zone-1&decision=allow&request_id=req-1&since=2026-01-01T00:00:00Z&until=2026-01-02T00:00:00Z&limit=5000&cursor=3")
	w := httptest.NewRecorder()

	s.handleSearch(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	if store.searchParams.ZoneID != "zone-1" || store.searchParams.Decision != "allow" || store.searchParams.RequestID != "req-1" {
		t.Fatalf("unexpected search params: %#v", store.searchParams)
	}
	if store.searchParams.Limit != 1000 || store.searchParams.Cursor != 3 {
		t.Fatalf("limit/cursor = %d/%d", store.searchParams.Limit, store.searchParams.Cursor)
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["next_cursor"] != "7" {
		t.Fatalf("body = %#v", body)
	}
}

func TestHandleSearchReportsStoreErrors(t *testing.T) {
	s := adminServer(&fakeServerStore{searchErr: errors.New("query failed")}, &fakeServerRedis{})
	w := httptest.NewRecorder()

	s.handleSearch(w, authorizedRequest(http.MethodGet, "/api/audit/search?zone_id=zone-1&limit=bad&cursor=bad"))

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", w.Code)
	}
}

func TestHandleDLQListValidatesLimitAndReturnsEntries(t *testing.T) {
	s := adminServer(&fakeServerStore{}, &fakeServerRedis{xrange: []redis.XMessage{{
		ID: "1760000000000-0",
		Values: map[string]any{
			"reason":   "pg_permanent_error:duplicate",
			"src_data": validAuditEventJSON(),
		},
	}}})
	w := httptest.NewRecorder()

	s.handleDLQList(w, authorizedRequest(http.MethodGet, "/api/audit/dlq?limit=5000"))

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"next_cursor":"1760000000000-0"`) {
		t.Fatalf("unexpected body: %s", w.Body.String())
	}

	w = httptest.NewRecorder()
	s.handleDLQList(w, authorizedRequest(http.MethodGet, "/api/audit/dlq?limit=0"))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("invalid limit status = %d", w.Code)
	}
}

func TestHandleDLQListReportsRedisError(t *testing.T) {
	s := adminServer(&fakeServerStore{}, &fakeServerRedis{xrangeErr: errors.New("redis down")})
	w := httptest.NewRecorder()

	s.handleDLQList(w, authorizedRequest(http.MethodGet, "/api/audit/dlq"))

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", w.Code)
	}
}

func TestHandleDLQDetailReturnsEntryNotFoundAndValidation(t *testing.T) {
	s := adminServer(&fakeServerStore{}, &fakeServerRedis{xrange: []redis.XMessage{{
		ID:     "1760000000000-0",
		Values: map[string]any{"reason": "pg_permanent_error:duplicate", "src_data": validAuditEventJSON()},
	}}})
	req := authorizedRequest(http.MethodGet, "/api/audit/dlq/1760000000000-0")
	req.SetPathValue("id", "1760000000000-0")
	w := httptest.NewRecorder()

	s.handleDLQDetail(w, req)

	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"source_event"`) {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}

	req = authorizedRequest(http.MethodGet, "/api/audit/dlq/")
	w = httptest.NewRecorder()
	s.handleDLQDetail(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("missing id status = %d", w.Code)
	}

	s = adminServer(&fakeServerStore{}, &fakeServerRedis{})
	req = authorizedRequest(http.MethodGet, "/api/audit/dlq/missing")
	req.SetPathValue("id", "missing")
	w = httptest.NewRecorder()
	s.handleDLQDetail(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("missing entry status = %d", w.Code)
	}

	s = adminServer(&fakeServerStore{}, &fakeServerRedis{xrangeErr: errors.New("redis down")})
	req = authorizedRequest(http.MethodGet, "/api/audit/dlq/error")
	req.SetPathValue("id", "error")
	w = httptest.NewRecorder()
	s.handleDLQDetail(w, req)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("redis error status = %d", w.Code)
	}
}

func TestReplayDLQSkipsMalformedAndReplaysValidEntries(t *testing.T) {
	r := &fakeServerRedis{xrange: []redis.XMessage{
		{ID: "1-0", Values: map[string]any{"reason": "missing_data_field"}},
		{ID: "2-0", Values: map[string]any{"reason": "pg_permanent_error:duplicate", "src_data": validAuditEventJSON(), "src_sig": "sig"}},
	}}
	s := adminServer(&fakeServerStore{}, r)

	summary, err := s.replayDLQ(context.Background(), 10)
	if err != nil {
		t.Fatalf("replayDLQ: %v", err)
	}
	if summary.Scanned != 2 || summary.Skipped != 1 || summary.Replayed != 1 {
		t.Fatalf("summary = %#v", summary)
	}
	if len(r.added) != 1 || r.added[0]["sig"] != "sig" || len(r.deleted) != 1 || r.deleted[0] != "2-0" {
		t.Fatalf("added=%#v deleted=%v", r.added, r.deleted)
	}
}

func TestReplayDLQReportsRedisFailuresAndNilClient(t *testing.T) {
	s := &Server{redis: nil}
	if _, err := s.replayDLQ(context.Background(), 1); err == nil {
		t.Fatal("expected nil redis error")
	}

	for _, tc := range []struct {
		name string
		r    *fakeServerRedis
	}{
		{name: "range", r: &fakeServerRedis{xrangeErr: errors.New("range failed")}},
		{name: "add", r: &fakeServerRedis{xrange: []redis.XMessage{{ID: "1-0", Values: map[string]any{"reason": "pg_permanent_error:duplicate", "src_data": validAuditEventJSON()}}}, xaddErr: errors.New("add failed")}},
		{name: "delete", r: &fakeServerRedis{xrange: []redis.XMessage{{ID: "1-0", Values: map[string]any{"reason": "pg_permanent_error:duplicate", "src_data": validAuditEventJSON()}}}, xdelErr: errors.New("delete failed")}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := adminServer(&fakeServerStore{}, tc.r)
			if _, err := s.replayDLQ(context.Background(), 1); err == nil {
				t.Fatal("expected replay error")
			}
		})
	}
}

func TestHandleDLQReplayValidatesLimitAndReportsErrors(t *testing.T) {
	r := &fakeServerRedis{xrange: []redis.XMessage{{ID: "1-0", Values: map[string]any{"reason": "pg_permanent_error:duplicate", "src_data": validAuditEventJSON()}}}}
	s := adminServer(&fakeServerStore{}, r)
	w := httptest.NewRecorder()
	s.handleDLQReplay(w, authorizedRequest(http.MethodPost, "/api/audit/dlq/replay?limit=5000"))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"replayed":1`) {
		t.Fatalf("success status=%d body=%s", w.Code, w.Body.String())
	}

	s = adminServer(&fakeServerStore{}, &fakeServerRedis{})
	w = httptest.NewRecorder()
	s.handleDLQReplay(w, authorizedRequest(http.MethodPost, "/api/audit/dlq/replay?limit=bad"))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("invalid limit status = %d", w.Code)
	}

	s = adminServer(&fakeServerStore{}, &fakeServerRedis{xrangeErr: errors.New("redis down")})
	w = httptest.NewRecorder()
	s.handleDLQReplay(w, authorizedRequest(http.MethodPost, "/api/audit/dlq/replay"))
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("redis error status = %d", w.Code)
	}
}

func TestReadyAndDLQPollPaths(t *testing.T) {
	s := adminServer(&fakeServerStore{}, &fakeServerRedis{})
	w := httptest.NewRecorder()
	s.handleHealth(w, httptest.NewRequest(http.MethodGet, "/health", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("unhealthy status = %d", w.Code)
	}
	s.consumer.healthy.Store(true)
	w = httptest.NewRecorder()
	s.handleHealth(w, httptest.NewRequest(http.MethodGet, "/health", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("healthy status = %d", w.Code)
	}

	s = adminServer(&fakeServerStore{pingErr: errors.New("pg down")}, &fakeServerRedis{})
	s.consumer.healthy.Store(true)
	w = httptest.NewRecorder()
	s.handleReady(w, httptest.NewRequest(http.MethodGet, "/ready", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("pg ready status = %d", w.Code)
	}

	s = adminServer(&fakeServerStore{}, &fakeServerRedis{pingErr: errors.New("redis down")})
	s.consumer.healthy.Store(true)
	w = httptest.NewRecorder()
	s.handleReady(w, httptest.NewRequest(http.MethodGet, "/ready", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("redis ready status = %d", w.Code)
	}

	s = adminServer(&fakeServerStore{}, &fakeServerRedis{})
	s.consumer.healthy.Store(true)
	s.cfg.ReadyDLQMax = 1
	s.dlqSize.Store(2)
	w = httptest.NewRecorder()
	s.handleReady(w, httptest.NewRequest(http.MethodGet, "/ready", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("dlq threshold status = %d", w.Code)
	}

	s = adminServer(&fakeServerStore{}, &fakeServerRedis{})
	s.consumer.healthy.Store(true)
	s.cfg.ReadyLagMax = 1
	s.consumerLag.Store(2)
	w = httptest.NewRecorder()
	s.handleReady(w, httptest.NewRequest(http.MethodGet, "/ready", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("lag threshold status = %d", w.Code)
	}

	s = adminServer(&fakeServerStore{}, &fakeServerRedis{})
	s.consumer.healthy.Store(true)
	s.cfg.ReadyPELOldestMax = 1
	s.pelOldestAge.Store(2)
	w = httptest.NewRecorder()
	s.handleReady(w, httptest.NewRequest(http.MethodGet, "/ready", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("pel threshold status = %d", w.Code)
	}

	s = adminServer(&fakeServerStore{}, &fakeServerRedis{})
	s.consumer.healthy.Store(true)
	w = httptest.NewRecorder()
	s.handleReady(w, httptest.NewRequest(http.MethodGet, "/ready", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("ready status = %d", w.Code)
	}

	r := &fakeServerRedis{xlen: 2, xrange: []redis.XMessage{{ID: "1760000000000-0"}}}
	s = adminServer(&fakeServerStore{}, r)
	s.pollDLQ(context.Background())
	if s.dlqSize.Load() != 2 || s.dlqOldestAge.Load() < 0 {
		t.Fatalf("dlq metrics size=%d oldest=%d", s.dlqSize.Load(), s.dlqOldestAge.Load())
	}

	s = adminServer(&fakeServerStore{}, &fakeServerRedis{xlenErr: errors.New("redis down")})
	s.pollDLQ(context.Background())
}

func TestSmallServerHelpersCoverBoundaryInputs(t *testing.T) {
	if got := millisStringToRFC3339(""); got != "" {
		t.Fatalf("empty millis = %q", got)
	}
	if got := millisStringToRFC3339("not-ms"); got != "not-ms" {
		t.Fatalf("invalid millis = %q", got)
	}
	if got := millisStringToRFC3339("-1"); got != "-1" {
		t.Fatalf("negative millis = %q", got)
	}
	if boolFloat(true) != 1 || boolFloat(false) != 0 {
		t.Fatal("boolFloat must map true to 1 and false to 0")
	}
	now := time.UnixMilli(1_000)
	for _, id := range []string{"bad", "x-0", "0-0", "2000-0"} {
		if got := redisIDAgeSeconds(id, now); got != 0 {
			t.Fatalf("age for %q = %d, want 0", id, got)
		}
	}
}
