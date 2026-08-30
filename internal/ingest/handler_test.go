// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package ingest

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/tenancy"
)

// recordingPublisher captures publishes; Publish runs on handler goroutines.
type recordingPublisher struct {
	mu       sync.Mutex
	channels []string
	done     chan struct{}
}

func newRecordingPublisher(expected int) *recordingPublisher {
	return &recordingPublisher{done: make(chan struct{}, expected)}
}

func (p *recordingPublisher) Publish(_ context.Context, channel string, _ map[string]string) {
	p.mu.Lock()
	p.channels = append(p.channels, channel)
	p.mu.Unlock()
	p.done <- struct{}{}
}

func (p *recordingPublisher) waitFor(t *testing.T, n int) []string {
	t.Helper()
	for range n {
		select {
		case <-p.done:
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for publishes")
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.channels...)
}

// authedRequest builds a request whose context already carries claims,
// bypassing the token verification middleware (covered by internal/auth).
func authedRequest(t *testing.T, method, target, body string) *http.Request {
	t.Helper()
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, reader)
	return req.WithContext(httpapi.ContextWithClaims(req.Context(), auth.Claims{
		UserID: uuid.MustParse("6dc85b0d-9dd8-4e0a-a1cd-6b8c50c00c11"),
		Role:   "user",
	}))
}

type fakeProjectResolver struct {
	projectID string
	err       error
}

func (f fakeProjectResolver) ResolveProjectID(context.Context, *http.Request, uuid.UUID) (string, error) {
	return f.projectID, f.err
}

func newHandler(store Store, pub Publisher) *Handler {
	return &Handler{
		Service:  newService(store),
		Publish:  pub,
		Projects: fakeProjectResolver{projectID: "project-1"},
	}
}

func postIngest(t *testing.T, h *Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, authedRequest(t, http.MethodPost, "/api/v1/ingest/session", body))
	return rec
}

func TestIngestEndpointHappyPath(t *testing.T) {
	store := newFakeStore()
	store.sourceRecords = []SourcePos{{LineOffset: 0, EndOffset: 148}, {LineOffset: 1, EndOffset: 250}}
	pub := newRecordingPublisher(2)
	h := newHandler(store, pub)

	body, _ := json.Marshal(map[string]any{
		"session_id": "sess-1",
		"harness":    "claude-code",
		"lines":      sampleLines,
	})
	rec := postIngest(t, h, string(body))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp["ingested"] != 2.0 || resp["acknowledged_line"] != 1.0 || resp["acknowledged_offset"] != 250.0 {
		t.Errorf("response = %v", resp)
	}
	if resp["integrity_ok"] != nil {
		t.Errorf("integrity_ok must be null for non-final deliveries, got %v", resp["integrity_ok"])
	}

	channels := pub.waitFor(t, 2)
	joined := strings.Join(channels, " ")
	if !strings.Contains(joined, "sessions:project-1:sess-1:updated") || !strings.Contains(joined, "sessions:project-1:updated") {
		t.Errorf("published channels = %v", channels)
	}
}

func TestIngestEndpointConflictBody(t *testing.T) {
	store := newFakeStore()
	store.existing = map[int]string{0: "different"}
	store.checkpointVal = 0
	h := newHandler(store, nil)

	body, _ := json.Marshal(map[string]any{"session_id": "sess-1", "lines": sampleLines})
	rec := postIngest(t, h, string(body))
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d", rec.Code)
	}
	var resp struct {
		Detail struct {
			Message string `json:"message"`
			Offsets []int  `json:"offsets"`
		} `json:"detail"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Detail.Message != "session source changed at an acknowledged line" || len(resp.Detail.Offsets) != 1 {
		t.Errorf("conflict body = %s", rec.Body)
	}
}

func TestIngestEndpointFinalIntegrityRepairRewindsCheckpoint(t *testing.T) {
	store := newFakeStore()
	// Only line 0 stored; sender claims two lines exist.
	store.sourceRecords = []SourcePos{{LineOffset: 0, EndOffset: 148}}
	store.manifest = []ManifestEntry{{LineOffset: 0, EndOffset: 148, SourceSHA256: "aa"}}
	h := newHandler(store, nil)

	t.Run("without hash the rewind replays from byte zero", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{
			"session_id":       "sess-1",
			"lines":            []string{},
			"final":            true,
			"total_line_count": 2,
			"total_offset":     250,
		})
		rec := postIngest(t, h, string(body))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
		}
		var resp map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &resp)
		if resp["integrity_ok"] != false || resp["repair_from_line"] != 1.0 {
			t.Errorf("integrity = (%v, %v)", resp["integrity_ok"], resp["repair_from_line"])
		}
		// No hash means no manifest walk, so the offset conservatively rewinds to 0.
		if resp["acknowledged_line"] != 0.0 || resp["acknowledged_offset"] != 0.0 {
			t.Errorf("rewound checkpoint = (%v, %v)", resp["acknowledged_line"], resp["acknowledged_offset"])
		}
	})

	t.Run("with hash the rewind lands on the last intact byte", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{
			"session_id":        "sess-1",
			"lines":             []string{},
			"final":             true,
			"total_line_count":  2,
			"total_offset":      250,
			"session_hash":      "does-not-matter-gap-detected-first",
			"hashed_line_count": 2,
		})
		rec := postIngest(t, h, string(body))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
		}
		var resp map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &resp)
		if resp["repair_from_line"] != 1.0 {
			t.Errorf("repair_from_line = %v", resp["repair_from_line"])
		}
		if resp["acknowledged_line"] != 0.0 || resp["acknowledged_offset"] != 148.0 {
			t.Errorf("rewound checkpoint = (%v, %v)", resp["acknowledged_line"], resp["acknowledged_offset"])
		}
		last := store.checkpointsSet[len(store.checkpointsSet)-1]
		if last[0] != 0 || last[1] != 148 {
			t.Errorf("persisted checkpoint = %v", last)
		}
	})
}

func TestIngestEndpointValidation(t *testing.T) {
	h := newHandler(newFakeStore(), nil)

	tooMany := make([]string, maxSessionLines+1)
	for i := range tooMany {
		tooMany[i] = "{}"
	}
	tooManyJSON, _ := json.Marshal(map[string]any{"session_id": "s", "lines": tooMany})

	tests := []struct {
		name string
		body string
		want string
	}{
		{"not json", "{", "invalid request body"},
		{"missing session_id", `{"lines":[]}`, "session_id is required"},
		{"missing lines", `{"session_id":"s"}`, "lines is required"},
		{"too many lines", string(tooManyJSON), "lines must contain at most"},
		{"negative start_offset", `{"session_id":"s","lines":[],"start_offset":-1}`, "start_offset cannot be negative"},
		{"offsets length mismatch", `{"session_id":"s","lines":["{}"],"end_byte_offsets":[1,2]}`, "one value per source line"},
		{"unordered offsets", `{"session_id":"s","lines":["{}","{}"],"end_byte_offsets":[5,3]}`, "must be ordered"},
		{"negative offsets", `{"session_id":"s","lines":["{}"],"end_byte_offsets":[-1]}`, "negative values"},
		{"hash without count", `{"session_id":"s","lines":[],"session_hash":"abc"}`, "hashed_line_count is required"},
		{"hashed exceeds total", `{"session_id":"s","lines":[],"session_hash":"a","hashed_line_count":5,"total_line_count":2}`, "cannot exceed total_line_count"},
		{"negative credits", `{"session_id":"s","lines":[],"total_credits":-1}`, "total_credits cannot be negative"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rec := postIngest(t, h, tc.body)
			if rec.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
			}
			if !strings.Contains(rec.Body.String(), tc.want) {
				t.Errorf("detail = %s, want substring %q", rec.Body, tc.want)
			}
		})
	}
}

func TestIngestEndpointRequiresClaims(t *testing.T) {
	h := newHandler(newFakeStore(), nil)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/ingest/session", strings.NewReader(`{}`))
	h.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestIngestEndpointRejectsMissingProjectScope(t *testing.T) {
	store := newFakeStore()
	h := newHandler(store, nil)
	h.Projects = fakeProjectResolver{err: &tenancy.Error{
		Status: http.StatusUnprocessableEntity,
		Detail: "Project scope is required",
	}}
	body, _ := json.Marshal(map[string]any{
		"session_id": "sess-1",
		"harness":    "claude-code",
		"lines":      sampleLines,
	})
	rec := postIngest(t, h, string(body))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "Project scope is required") {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if len(store.insertedBatches) != 0 {
		t.Fatalf("scope failure reached storage: %d batches", len(store.insertedBatches))
	}
}

func TestIngestEndpointNoPublishWhenNothingIngested(t *testing.T) {
	store := newFakeStore()
	store.existing = map[int]string{0: lineHash(sampleLines[0]), 1: lineHash(sampleLines[1])}
	store.checkpointVal = 1
	pub := newRecordingPublisher(2)
	h := newHandler(store, pub)

	body, _ := json.Marshal(map[string]any{"session_id": "sess-1", "lines": sampleLines})
	rec := postIngest(t, h, string(body))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	select {
	case <-pub.done:
		t.Fatal("published despite zero ingested lines")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestCheckpointEndpoint(t *testing.T) {
	store := newFakeStore()
	store.checkpointVal, store.checkpointOff = 41, 4100
	h := newHandler(store, nil)

	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, authedRequest(t, http.MethodGet,
		"/api/v1/ingest/session/checkpoint?session_id=sess-1&harness=claude-code", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	var resp checkpointResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.AcknowledgedLine != 41 || resp.AcknowledgedOffset != 4100 || resp.SessionID != "sess-1" {
		t.Errorf("response = %+v", resp)
	}

	rec = httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, authedRequest(t, http.MethodGet, "/api/v1/ingest/session/checkpoint?session_id=sess-1", ""))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("missing harness: status = %d", rec.Code)
	}
}
