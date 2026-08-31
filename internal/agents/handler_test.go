// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/httpapi"
)

// ── package-local pgx fake (Values- and Scan-capable) ───────────────────────

type fakeRows struct {
	cols []string
	rows [][]any
	idx  int
}

func (r *fakeRows) Close()                        {}
func (r *fakeRows) Err() error                    { return nil }
func (r *fakeRows) CommandTag() pgconn.CommandTag { return pgconn.CommandTag{} }
func (r *fakeRows) FieldDescriptions() []pgconn.FieldDescription {
	out := make([]pgconn.FieldDescription, len(r.cols))
	for i, c := range r.cols {
		out[i] = pgconn.FieldDescription{Name: c}
	}
	return out
}
func (r *fakeRows) Next() bool             { r.idx++; return r.idx <= len(r.rows) }
func (r *fakeRows) Values() ([]any, error) { return r.rows[r.idx-1], nil }
func (r *fakeRows) RawValues() [][]byte    { return nil }
func (r *fakeRows) Conn() *pgx.Conn        { return nil }

func (r *fakeRows) Scan(dest ...any) error {
	if r.idx == 0 || r.idx > len(r.rows) {
		return pgx.ErrNoRows
	}
	row := r.rows[r.idx-1]
	for i, d := range dest {
		if i >= len(row) {
			break
		}
		switch dd := d.(type) {
		case *int:
			switch v := row[i].(type) {
			case int:
				*dd = v
			case int64:
				*dd = int(v)
			}
		case *int64:
			switch v := row[i].(type) {
			case int:
				*dd = int64(v)
			case int64:
				*dd = v
			}
		case *bool:
			b, _ := row[i].(bool)
			*dd = b
		case *string:
			*dd = fmt.Sprint(row[i])
		case **string:
			if row[i] == nil {
				*dd = nil
			} else {
				s := fmt.Sprint(row[i])
				*dd = &s
			}
		default:
			return fmt.Errorf("unsupported scan destination %T", d)
		}
	}
	return nil
}

type fakeRow struct{ rows *fakeRows }

func (r fakeRow) Scan(dest ...any) error {
	if !r.rows.Next() {
		return pgx.ErrNoRows
	}
	return r.rows.Scan(dest...)
}

type stub struct {
	match string
	rows  *fakeRows
}

type fakeDB struct {
	stubs []stub
	log   []string
}

func (db *fakeDB) route(sql string) *fakeRows {
	db.log = append(db.log, sql)
	for _, s := range db.stubs {
		if strings.Contains(sql, s.match) {
			copyRows := *s.rows
			copyRows.idx = 0
			return &copyRows
		}
	}
	return &fakeRows{}
}

func (db *fakeDB) Query(_ context.Context, sql string, _ ...any) (pgx.Rows, error) {
	return db.route(sql), nil
}

func (db *fakeDB) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	return fakeRow{db.route(sql)}
}

func (db *fakeDB) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	db.log = append(db.log, sql)
	return pgconn.NewCommandTag("UPDATE 1"), nil
}

func (db *fakeDB) Begin(_ context.Context) (pgx.Tx, error) {
	return nil, errors.New("fakeDB: transactions not supported")
}

// ── fixtures ────────────────────────────────────────────────────────────────

var (
	agentTime = time.Date(2026, 8, 30, 8, 0, 0, 0, time.UTC)
	agentCols = []string{
		"id", "name", "namespace", "slug", "owner",
		"project_id", "is_private", "ownership_scope", "category",
		"created_by", "created_at", "updated_at", "deleted_at", "scheduled_purge_at",
		"version", "description", "status", "rejection_reason",
		"supported_harnesses", "model_name", "download_count",
		"component_count", "created_by_email", "created_by_username",
	}
)

func agentRow(id, name, slug string) []any {
	return []any{
		id, name, "acme", slug, "acme-team",
		nil, false, "user", "review",
		"22222222-2222-2222-2222-222222222222", agentTime, agentTime, nil, nil,
		"1.0.0", "reviews code", "approved", nil,
		[]any{"kiro"}, "claude-sonnet-4-5", int64(3),
		int64(2), "r@x.com", "rawx18",
	}
}

func serveAgents(t *testing.T, db *fakeDB, method, target, role, body string) *httptest.ResponseRecorder {
	t.Helper()
	h := &Handler{Store: &Store{DB: db}}
	mux := http.NewServeMux()
	withClaims := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := httpapi.ContextWithClaims(r.Context(), auth.Claims{
				UserID: uuid.MustParse("22222222-2222-2222-2222-222222222222"),
				Role:   role,
			})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
	h.Register(mux, withClaims, withClaims)
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, reader)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

// ── tests ───────────────────────────────────────────────────────────────────

func TestAgentListRendersSummaries(t *testing.T) {
	// The summary projection also contains "count(", so the list stub must
	// match first on its distinctive column alias.
	db := &fakeDB{stubs: []stub{
		{match: "a.id::text AS id", rows: &fakeRows{cols: agentCols, rows: [][]any{
			agentRow("11111111-1111-1111-1111-111111111111", "Review Bot", "review-bot"),
		}}},
		{match: "count(", rows: &fakeRows{cols: []string{"count"}, rows: [][]any{{1}}}},
	}}
	rec := serveAgents(t, db, http.MethodGet, "/api/v1/agents", "user", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("X-Total-Count") != "1" {
		t.Errorf("X-Total-Count = %q", rec.Header().Get("X-Total-Count"))
	}
	var items []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &items); err != nil || len(items) != 1 {
		t.Fatalf("body: %v\n%s", err, rec.Body.String())
	}
	got := items[0]
	if got["qualified_name"] != "acme/review-bot" || got["model_name"] != "claude-sonnet-4-5" {
		t.Errorf("summary: %v", got)
	}
}

func TestAgentListValidatesParams(t *testing.T) {
	db := &fakeDB{}
	for _, target := range []string{
		"/api/v1/agents?limit=0",
		"/api/v1/agents?limit=999",
		"/api/v1/agents?project_id=nope",
	} {
		rec := serveAgents(t, db, http.MethodGet, target, "user", "")
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s: status = %d", target, rec.Code)
		}
	}
	if len(db.log) != 0 {
		t.Errorf("invalid params reached the database: %v", db.log)
	}
}

func TestArchivedRequiresAdminRole(t *testing.T) {
	rec := serveAgents(t, &fakeDB{}, http.MethodGet, "/api/v1/agents/archived", "user", "")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("plain user: status = %d, want 403", rec.Code)
	}
	rec = serveAgents(t, &fakeDB{stubs: []stub{
		{match: "FROM agents", rows: &fakeRows{cols: agentCols, rows: [][]any{}}},
	}}, http.MethodGet, "/api/v1/agents/archived", "operator", "")
	if rec.Code != http.StatusOK {
		t.Errorf("operator: status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestValidateRejectsUnknownComponentType(t *testing.T) {
	body := `{"name": "bot", "components": [{"component_type": "gadget", "component_id": "x"}]}`
	rec := serveAgents(t, &fakeDB{}, http.MethodPost, "/api/v1/agents/validate", "user", body)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	out := rec.Body.String()
	if !strings.Contains(out, "literal_error") || !strings.Contains(out, "'mcp', 'skill', 'hook' or 'prompt'") {
		t.Errorf("literal error shape: %s", out)
	}
}

func TestValidateRejectsMalformedJSON(t *testing.T) {
	rec := serveAgents(t, &fakeDB{}, http.MethodPost, "/api/v1/agents/validate", "user", "{broken")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "json_invalid") {
		t.Errorf("error shape: %s", rec.Body.String())
	}
}
