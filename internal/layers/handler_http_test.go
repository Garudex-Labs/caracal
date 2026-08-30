// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package layers

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/tenancy"
)

// chBackend plays ClickHouse over HTTP, routing by SQL substring.
type chBackend struct {
	existsCount int64
	showRows    []map[string]any
	statements  []string
}

func (b *chBackend) handler(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	sql := r.URL.Query().Get("query") + string(body)
	b.statements = append(b.statements, sql)
	w.Header().Set("Content-Type", "application/json")
	switch {
	case strings.Contains(sql, "count() AS cnt"):
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{"cnt": b.existsCount}}})
	case strings.Contains(sql, "SELECT hash, harness"):
		_ = json.NewEncoder(w).Encode(map[string]any{"data": b.showRows})
	default:
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{}})
	}
}

func serveLayers(t *testing.T, backend *chBackend, method, target, body string, withClaims bool) *httptest.ResponseRecorder {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(backend.handler))
	t.Cleanup(server.Close)
	ch, err := clickhouse.New(server.URL, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	h := &Handler{CH: ch}
	mux := http.NewServeMux()
	identity := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if withClaims {
				ctx := httpapi.ContextWithClaims(r.Context(), auth.Claims{
					UserID: uuid.MustParse("22222222-2222-2222-2222-222222222222"),
					Role:   "user",
				})
				ctx = tenancy.ContextWithProjectID(ctx, "project-1")
				r = r.WithContext(ctx)
			}
			next.ServeHTTP(w, r)
		})
	}
	h.Register(mux, identity)
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func uploadPayload(content string) string {
	blob, _ := json.Marshal(map[string]any{
		"hash": "abcdef1234567890",
		"harnesses": map[string]any{
			"kiro": []map[string]any{{
				"path": "CLAUDE.md", "hash": "h1", "size": 42, "content": content,
			}},
		},
		"lockfile_hash": "lf1",
	})
	return string(blob)
}

func TestUploadStoresRedactedSnapshot(t *testing.T) {
	backend := &chBackend{}
	secret := "api_key = \"sk-live-1234567890abcdefghij\""
	rec := serveLayers(t, backend, http.MethodPost, "/api/v1/layer-snapshots", uploadPayload(secret), true)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["stored"] != true || out["file_count"] != float64(1) {
		t.Errorf("upload result: %v", out)
	}

	var insert string
	for _, sql := range backend.statements {
		if strings.Contains(sql, "INSERT INTO layer_snapshots") {
			insert = sql
		}
	}
	if insert == "" {
		t.Fatalf("no insert reached storage:\n%v", backend.statements)
	}
	// Secrets are stripped before the snapshot is persisted.
	if strings.Contains(insert, "sk-live-1234567890abcdefghij") {
		t.Error("secret stored unredacted")
	}
	if !strings.Contains(insert, `\"REDACTED\"`) && !strings.Contains(insert, "REDACTED") {
		t.Errorf("no redaction marker in stored content:\n%s", insert)
	}
	if !strings.Contains(insert, `\"path\":\"CLAUDE.md\"`) {
		t.Errorf("manifest lost the file entry:\n%s", insert)
	}
}

func TestUploadDeduplicatesByHash(t *testing.T) {
	backend := &chBackend{existsCount: 1}
	rec := serveLayers(t, backend, http.MethodPost, "/api/v1/layer-snapshots", uploadPayload("plain"), true)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["stored"] != false {
		t.Errorf("duplicate must not restore: %v", out)
	}
	for _, sql := range backend.statements {
		if strings.Contains(sql, "INSERT INTO") {
			t.Errorf("duplicate still inserted:\n%s", sql)
		}
	}
}

func TestUploadRejectsMalformedAndInvalidBodies(t *testing.T) {
	backend := &chBackend{}
	rec := serveLayers(t, backend, http.MethodPost, "/api/v1/layer-snapshots", "{broken", true)
	if rec.Code != http.StatusUnprocessableEntity && rec.Code != http.StatusBadRequest {
		t.Errorf("malformed body: status = %d", rec.Code)
	}

	short, _ := json.Marshal(map[string]any{"hash": "abc", "harnesses": map[string]any{}})
	rec = serveLayers(t, backend, http.MethodPost, "/api/v1/layer-snapshots", string(short), true)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("short hash: status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "string_too_short") {
		t.Errorf("validation shape: %s", rec.Body.String())
	}
	if len(backend.statements) != 0 {
		t.Errorf("invalid bodies reached storage: %v", backend.statements)
	}
}

func TestShowScopesReadsToUploader(t *testing.T) {
	manifest := `{"harnesses": {"kiro": [{"path": "CLAUDE.md", "hash": "h1", "size": 42, "source": "user", "content": "x"}]}, "lockfile_hash": "lf1"}`
	backend := &chBackend{showRows: []map[string]any{{
		"hash": "abcdef1234567890", "harness": "kiro", "content": manifest,
		"uploaded_at": "2026-08-30 08:00:00", "file_count": float64(1), "total_size": float64(42),
		"lockfile_hash": "lf1",
	}}}
	rec := serveLayers(t, backend, http.MethodGet, "/api/v1/layer-snapshots/abcdef1234567890", "", true)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "CLAUDE.md") {
		t.Errorf("show body: %s", rec.Body.String())
	}
	// A plain user's read carries the uploader scope.
	found := false
	for _, sql := range backend.statements {
		if strings.Contains(sql, "SELECT hash, harness") && strings.Contains(sql, "AND user_id =") {
			found = true
		}
	}
	if !found {
		t.Errorf("read not scoped to uploader:\n%v", backend.statements)
	}
}

func TestShowWithoutClaimsFailsClosed(t *testing.T) {
	backend := &chBackend{}
	rec := serveLayers(t, backend, http.MethodGet, "/api/v1/layer-snapshots/abcdef1234567890", "", false)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("anonymous read: status = %d", rec.Code)
	}
	// The fail-closed scope matches no rows rather than skipping the guard.
	for _, sql := range backend.statements {
		if strings.Contains(sql, "SELECT hash, harness") && !strings.Contains(sql, `AND user_id = ''`) {
			t.Errorf("anonymous scope missing:\n%s", sql)
		}
	}
}

func TestShowUnknownSnapshotIs404(t *testing.T) {
	rec := serveLayers(t, &chBackend{}, http.MethodGet, "/api/v1/layer-snapshots/ffffffffffffffff", "", true)
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d", rec.Code)
	}
}
