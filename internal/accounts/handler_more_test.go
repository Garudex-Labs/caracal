// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package accounts

import (
	"context"
	"encoding/base64"
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

// ── scan-aware pgx fake with arg-sensitive routing ──────────────────────────

type accRows struct {
	rows [][]any
	idx  int
}

func (r *accRows) Close()                                       {}
func (r *accRows) Err() error                                   { return nil }
func (r *accRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (r *accRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (r *accRows) Next() bool                                   { r.idx++; return r.idx <= len(r.rows) }
func (r *accRows) Values() ([]any, error)                       { return r.rows[r.idx-1], nil }
func (r *accRows) RawValues() [][]byte                          { return nil }
func (r *accRows) Conn() *pgx.Conn                              { return nil }

func (r *accRows) Scan(dest ...any) error {
	if r.idx == 0 || r.idx > len(r.rows) {
		return pgx.ErrNoRows
	}
	row := r.rows[r.idx-1]
	for i, d := range dest {
		if i >= len(row) {
			break
		}
		if err := accAssign(d, row[i]); err != nil {
			return fmt.Errorf("column %d: %w", i, err)
		}
	}
	return nil
}

func accAssign(dest, value any) error {
	switch d := dest.(type) {
	case *string:
		if value == nil {
			*d = ""
		} else {
			*d = fmt.Sprint(value)
		}
	case **string:
		if value == nil {
			*d = nil
		} else {
			s := fmt.Sprint(value)
			*d = &s
		}
	case *int:
		switch v := value.(type) {
		case int:
			*d = v
		case int64:
			*d = int(v)
		}
	case *int64:
		switch v := value.(type) {
		case int:
			*d = int64(v)
		case int64:
			*d = v
		}
	case *uuid.UUID:
		switch v := value.(type) {
		case uuid.UUID:
			*d = v
		case string:
			*d = uuid.MustParse(v)
		}
	case *time.Time:
		t, _ := value.(time.Time)
		*d = t
	case **time.Time:
		switch v := value.(type) {
		case nil:
			*d = nil
		case time.Time:
			t := v
			*d = &t
		}
	default:
		return fmt.Errorf("unsupported scan destination %T", dest)
	}
	return nil
}

type accRow struct{ rows *accRows }

func (r accRow) Scan(dest ...any) error {
	if !r.rows.Next() {
		return pgx.ErrNoRows
	}
	return r.rows.Scan(dest...)
}

// rstub answers queries whose SQL contains match; a non-empty arg further
// requires one query argument to render exactly to it.
type rstub struct {
	match string
	arg   string
	rows  *accRows
}

// execStub picks the command tag for Exec calls carrying arg.
type execStub struct {
	arg string
	tag pgconn.CommandTag
}

type accDB struct {
	stubs   []rstub
	execs   []execStub
	log     []string
	execLog []string
	// txOK makes Begin hand back a fake transaction that routes back into this
	// accDB; the default (false) keeps Begin failing so store-failure paths stay
	// covered.
	txOK bool
}

func (db *accDB) route(sql string, args []any) *accRows {
	db.log = append(db.log, sql)
	for _, s := range db.stubs {
		if !strings.Contains(sql, s.match) {
			continue
		}
		if s.arg != "" {
			found := false
			for _, a := range args {
				if fmt.Sprint(a) == s.arg {
					found = true
					break
				}
			}
			if !found {
				continue
			}
		}
		copyRows := *s.rows
		copyRows.idx = 0
		return &copyRows
	}
	return &accRows{}
}

func (db *accDB) Query(_ context.Context, sql string, args ...any) (pgx.Rows, error) {
	return db.route(sql, args), nil
}

func (db *accDB) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	return accRow{db.route(sql, args)}
}

func (db *accDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	db.execLog = append(db.execLog, sql)
	for _, e := range db.execs {
		for _, a := range args {
			if fmt.Sprint(a) == e.arg {
				return e.tag, nil
			}
		}
	}
	return pgconn.NewCommandTag("UPDATE 1"), nil
}

func (db *accDB) Begin(_ context.Context) (pgx.Tx, error) {
	if db.txOK {
		return &accTx{db: db}, nil
	}
	return nil, errors.New("accDB: transactions not supported")
}

// accTx is a minimal pgx.Tx that routes reads and writes back into the accDB so
// in-transaction UPDATEs land in execLog. Only Exec/Query/QueryRow/Commit/
// Rollback are exercised; the remaining pgx.Tx surface is inert.
type accTx struct {
	db        *accDB
	committed bool
}

func (t *accTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return t.db.Exec(ctx, sql, args...)
}

func (t *accTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	return t.db.Query(ctx, sql, args...)
}

func (t *accTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return t.db.QueryRow(ctx, sql, args...)
}

func (t *accTx) Commit(context.Context) error          { t.committed = true; return nil }
func (t *accTx) Rollback(context.Context) error        { return nil }
func (t *accTx) Begin(context.Context) (pgx.Tx, error) { return t, nil }
func (t *accTx) Conn() *pgx.Conn                       { return nil }
func (t *accTx) LargeObjects() pgx.LargeObjects        { return pgx.LargeObjects{} }
func (t *accTx) Prepare(context.Context, string, string) (*pgconn.StatementDescription, error) {
	return nil, nil
}
func (t *accTx) CopyFrom(context.Context, pgx.Identifier, []string, pgx.CopyFromSource) (int64, error) {
	return 0, nil
}
func (t *accTx) SendBatch(context.Context, *pgx.Batch) pgx.BatchResults { return nil }

// ── shared fixtures ─────────────────────────────────────────────────────────

var (
	accCallerID = uuid.MustParse("22222222-2222-2222-2222-222222222222")
	accTargetID = uuid.MustParse("77777777-7777-7777-7777-777777777777")
	accTime     = time.Date(2026, 8, 30, 8, 0, 0, 0, time.UTC)
)

func profileRowValues(avatar, authSubject any) []any {
	return []any{accCallerID.String(), "a@x.io", "richard", "Richard", "user", avatar, accTime, authSubject}
}

func profileStub(vals []any) rstub {
	return rstub{match: "id::text", rows: &accRows{rows: [][]any{vals}}}
}

type fakeIntSetting struct{}

func (fakeIntSetting) Int(_ context.Context, _ string, fallback int) int { return fallback }

type accEvents struct{ rows []any }

func (e *accEvents) InsertJSONEachRow(_ context.Context, _ string, rows []any) error {
	e.rows = append(e.rows, rows...)
	return nil
}

func serveProfile(t *testing.T, h *Handler, method, target, body string, header map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var req *http.Request
	if body != "" {
		req = httptest.NewRequest(method, target, strings.NewReader(body))
	} else {
		req = httptest.NewRequest(method, target, nil)
	}
	for k, v := range header {
		req.Header.Set(k, v)
	}
	req = req.WithContext(httpapi.ContextWithClaims(req.Context(), auth.Claims{
		UserID: accCallerID, Role: "user",
	}))
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	return rec
}

// ── profile handler ─────────────────────────────────────────────────────────

func TestWhoamiReturnsProfile(t *testing.T) {
	db := &accDB{stubs: []rstub{profileStub(profileRowValues(nil, nil))}}
	rec := serveProfile(t, &Handler{Store: &Store{DB: db}}, http.MethodGet, "/api/v1/auth/whoami", "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["email"] != "a@x.io" || out["username"] != "richard" || out["role"] != "user" {
		t.Errorf("profile wire: %v", out)
	}
	if out["auth_context"] != nil {
		t.Errorf("legacy profile context should omit empty auth_context: %v", out)
	}
	if out["avatar_url"] != nil || out["created_at"] != "2026-08-30T08:00:00Z" {
		t.Errorf("profile wire: %v", out)
	}
}

func TestWhoamiReturnsAuthContext(t *testing.T) {
	db := &accDB{stubs: []rstub{profileStub(profileRowValues(nil, nil))}}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/whoami", nil)
	req = req.WithContext(httpapi.ContextWithClaims(req.Context(), auth.Claims{
		UserID: accCallerID, Role: "operator", AuthContext: auth.AuthContextOperator,
	}))
	rec := httptest.NewRecorder()
	(&Handler{Store: &Store{DB: db}}).Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["auth_context"] != "operator" {
		t.Errorf("auth_context = %v", out["auth_context"])
	}
}

func TestWhoamiUnknownUserIs500(t *testing.T) {
	rec := serveProfile(t, &Handler{Store: &Store{DB: &accDB{}}}, http.MethodGet, "/api/v1/auth/whoami", "", nil)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestSetUsernameValidation(t *testing.T) {
	newH := func() *Handler {
		return &Handler{Store: &Store{DB: &accDB{stubs: []rstub{profileStub(profileRowValues(nil, nil))}}}}
	}
	target := "/api/v1/auth/profile/username"
	cases := []struct {
		body   string
		status int
		needle string
	}{
		{"{", http.StatusUnprocessableEntity, "Field required"},
		{"{}", http.StatusUnprocessableEntity, "Field required"},
		{`{"username":null}`, http.StatusUnprocessableEntity, "Username is required"},
		{`{"username":42}`, http.StatusUnprocessableEntity, "Username is required"},
		{`{"username":"Bad Name!"}`, http.StatusUnprocessableEntity, "value_error"},
	}
	for _, c := range cases {
		rec := serveProfile(t, newH(), http.MethodPut, target, c.body, nil)
		if rec.Code != c.status || !strings.Contains(rec.Body.String(), c.needle) {
			t.Errorf("%s: status = %d: %s", c.body, rec.Code, rec.Body.String())
		}
	}
}

func TestSetUsernameSameValueIsNoOp(t *testing.T) {
	db := &accDB{stubs: []rstub{profileStub(profileRowValues(nil, nil))}}
	rec := serveProfile(t, &Handler{Store: &Store{DB: db}}, http.MethodPut,
		"/api/v1/auth/profile/username", `{"username":"richard"}`, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	for _, sql := range db.execLog {
		t.Errorf("no writes expected, got %s", sql)
	}
}

func TestSetUsernameTakenIs409(t *testing.T) {
	db := &accDB{stubs: []rstub{
		profileStub(profileRowValues(nil, nil)),
		{match: "WHERE username = $1 AND id != $2", rows: &accRows{rows: [][]any{{accTargetID}}}},
	}}
	rec := serveProfile(t, &Handler{Store: &Store{DB: db}}, http.MethodPut,
		"/api/v1/auth/profile/username", `{"username":"jared"}`, nil)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "Username already taken") {
		t.Errorf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestSetUsernameMigratesPublishedResources(t *testing.T) {
	// A user with published resources may still rename: the handle and every
	// Agent/component under the old personal namespace move atomically.
	db := &accDB{txOK: true, stubs: []rstub{profileStub(profileRowValues(nil, nil))}}
	rec := serveProfile(t, &Handler{Store: &Store{DB: db}}, http.MethodPut,
		"/api/v1/auth/profile/username", `{"username":"jared"}`, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	migrated := map[string]bool{}
	sawUserUpdate := false
	for _, sql := range db.execLog {
		if strings.Contains(sql, "UPDATE users SET username") {
			sawUserUpdate = true
		}
		for _, tbl := range resourceTables {
			if strings.Contains(sql, "UPDATE "+tbl+" SET namespace = $1, owner = $1") {
				migrated[tbl] = true
			}
		}
	}
	if !sawUserUpdate {
		t.Errorf("username UPDATE not issued: %v", db.execLog)
	}
	for _, tbl := range resourceTables {
		if !migrated[tbl] {
			t.Errorf("resource table %q was not migrated: %v", tbl, db.execLog)
		}
	}
}

func TestSetUsernameStoreFailureIs500(t *testing.T) {
	// All pre-checks pass; the transaction boundary fails by design.
	db := &accDB{stubs: []rstub{profileStub(profileRowValues(nil, nil))}}
	rec := serveProfile(t, &Handler{Store: &Store{DB: db}}, http.MethodPut,
		"/api/v1/auth/profile/username", `{"username":"jared"}`, nil)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func pngDataURL() string {
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte("\x89PNG\r\n\x1a\ntestdata"))
}

func TestUploadAvatarFlow(t *testing.T) {
	avatar := pngDataURL()
	db := &accDB{stubs: []rstub{profileStub(profileRowValues(avatar, nil))}}
	h := &Handler{Store: &Store{DB: db}}
	target := "/api/v1/auth/profile/avatar"

	rec := serveProfile(t, h, http.MethodPut, target, `{}`, map[string]string{"X-Real-IP": "10.0.0.1"})
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "avatar_url is required") {
		t.Errorf("missing url: status = %d: %s", rec.Code, rec.Body.String())
	}

	rec = serveProfile(t, h, http.MethodPut, target,
		`{"avatar_url":"data:text/plain;base64,aGk="}`, map[string]string{"X-Real-IP": "10.0.0.2"})
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "base64 data URL") {
		t.Errorf("bad url: status = %d: %s", rec.Code, rec.Body.String())
	}

	rec = serveProfile(t, h, http.MethodPut, target,
		`{"avatar_url":"`+avatar+`"}`, map[string]string{"X-Real-IP": "10.0.0.3"})
	if rec.Code != http.StatusOK {
		t.Fatalf("upload: status = %d: %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["avatar_url"] != avatar {
		t.Errorf("avatar wire: %v", out["avatar_url"])
	}

	// The same client key gets one upload per window.
	rec = serveProfile(t, h, http.MethodPut, target,
		`{"avatar_url":"`+avatar+`"}`, map[string]string{"X-Real-IP": "10.0.0.3"})
	if rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") != "60" {
		t.Errorf("rate limit: status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestDeleteAvatar(t *testing.T) {
	db := &accDB{stubs: []rstub{profileStub(profileRowValues(nil, nil))}}
	rec := serveProfile(t, &Handler{Store: &Store{DB: db}}, http.MethodDelete, "/api/v1/auth/profile/avatar", "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	cleared := false
	for _, sql := range db.execLog {
		if strings.Contains(sql, "UPDATE users SET avatar_url") {
			cleared = true
		}
	}
	if !cleared {
		t.Errorf("no avatar UPDATE issued: %v", db.execLog)
	}
}

func TestRateKeyBuckets(t *testing.T) {
	bearer := httptest.NewRequest(http.MethodPut, "/x", nil)
	bearer.Header.Set("Authorization", "Bearer secret-token")
	key := rateKey(bearer)
	if !strings.HasPrefix(key, "token:") || strings.Contains(key, "secret-token") {
		t.Errorf("bearer key must be a digest: %s", key)
	}
	ip := httptest.NewRequest(http.MethodPut, "/x", nil)
	ip.Header.Set("X-Real-IP", "10.1.2.3")
	if rateKey(ip) != "ip:10.1.2.3" {
		t.Errorf("ip key: %s", rateKey(ip))
	}
	fallback := httptest.NewRequest(http.MethodPut, "/x", nil)
	if !strings.HasPrefix(rateKey(fallback), "ip:") {
		t.Errorf("fallback key: %s", rateKey(fallback))
	}
}

// ── admin handler ───────────────────────────────────────────────────────────

func adminRowValues(id uuid.UUID, email, role string, authSubject any) []any {
	return []any{id, email, "richard", "Richard", role, nil, accTime, authSubject}
}

func adminCallerStub(role string) rstub {
	return rstub{match: "department", arg: accCallerID.String(),
		rows: &accRows{rows: [][]any{adminRowValues(accCallerID, "admin@x.io", role, nil)}}}
}

func adminTargetStub(role string, authSubject any) rstub {
	return rstub{match: "department", arg: accTargetID.String(),
		rows: &accRows{rows: [][]any{adminRowValues(accTargetID, "b@x.io", role, authSubject)}}}
}

func serveAdmin(t *testing.T, h *AdminHandler, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	withAdmin := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := httpapi.ContextWithClaims(r.Context(), auth.Claims{UserID: accCallerID, Role: "operator"})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
	h.Register(mux, withAdmin)
	var req *http.Request
	if body != "" {
		req = httptest.NewRequest(method, target, strings.NewReader(body))
	} else {
		req = httptest.NewRequest(method, target, nil)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func TestAdminListProjectsUsers(t *testing.T) {
	callerRow := append(adminRowValues(accCallerID, "admin@x.io", "operator", nil), int64(2))
	db := &accDB{stubs: []rstub{
		{match: "SELECT count(*) FROM users u", rows: &accRows{rows: [][]any{{int64(2)}}}},
		{match: "org_count", rows: &accRows{rows: [][]any{
			callerRow,
			{accTargetID, "b@x.io", nil, "Jared", "user", "Platform", nil, nil, int64(0)},
		}}},
	}}
	rec := serveAdmin(t, &AdminHandler{DB: db}, http.MethodGet, "/api/v1/operator/users", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Items  []map[string]any `json:"items"`
		Total  float64          `json:"total"`
		Limit  float64          `json:"limit"`
		Offset float64          `json:"offset"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || len(out.Items) != 2 {
		t.Fatalf("body: %v\n%s", err, rec.Body.String())
	}
	if out.Total != 2 || out.Limit != 50 || out.Offset != 0 {
		t.Errorf("envelope = total %v limit %v offset %v", out.Total, out.Limit, out.Offset)
	}
	if out.Items[0]["email"] != "admin@x.io" || out.Items[0]["created_at"] != "2026-08-30T08:00:00Z" ||
		out.Items[0]["org_count"] != float64(2) {
		t.Errorf("first wire: %v", out.Items[0])
	}
	if out.Items[1]["username"] != nil || out.Items[1]["department"] != "Platform" ||
		out.Items[1]["created_at"] != nil || out.Items[1]["org_count"] != float64(0) {
		t.Errorf("second wire: %v", out.Items[1])
	}
}

func TestAdminListSearchSortPagination(t *testing.T) {
	db := &accDB{stubs: []rstub{
		{match: "SELECT count(*) FROM users u", rows: &accRows{rows: [][]any{{int64(1)}}}},
		{match: "org_count", rows: &accRows{rows: [][]any{
			{accTargetID, "b@x.io", nil, "Jared", "user", nil, nil, nil, int64(1)},
		}}},
	}}
	rec := serveAdmin(t, &AdminHandler{DB: db}, http.MethodGet,
		"/api/v1/operator/users?q=jar&role=user&sort=email&order=asc&limit=10&offset=20", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var pageSQL string
	for _, sql := range db.log {
		if strings.Contains(sql, "org_count") {
			pageSQL = sql
		}
	}
	if !strings.Contains(pageSQL, "ORDER BY lower(u.email) ASC") ||
		!strings.Contains(pageSQL, "u.created_at DESC, u.id ASC") ||
		!strings.Contains(pageSQL, "LIMIT 10 OFFSET 20") ||
		!strings.Contains(pageSQL, "ILIKE") {
		t.Errorf("page SQL: %s", pageSQL)
	}

	for _, target := range []string{
		"/api/v1/operator/users?sort=height",
		"/api/v1/operator/users?order=up",
		"/api/v1/operator/users?role=boss",
		"/api/v1/operator/users?limit=lots",
	} {
		rec := serveAdmin(t, &AdminHandler{DB: db}, http.MethodGet, target, "")
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s: status = %d, want 422", target, rec.Code)
		}
	}
}

func TestAdminSetRoleValidation(t *testing.T) {
	base := "/api/v1/operator/users/"
	newDB := func(callerRole string) *accDB {
		return &accDB{stubs: []rstub{adminCallerStub(callerRole), adminTargetStub("user", nil)}}
	}

	rec := serveAdmin(t, &AdminHandler{DB: newDB("operator")}, http.MethodPut, base+"nope/role", `{"role":"user"}`)
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "uuid_parsing") {
		t.Errorf("bad uuid: status = %d: %s", rec.Code, rec.Body.String())
	}

	missing := &accDB{stubs: []rstub{adminCallerStub("operator")}}
	rec = serveAdmin(t, &AdminHandler{DB: missing}, http.MethodPut, base+accTargetID.String()+"/role", `{"role":"user"}`)
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "User not found") {
		t.Errorf("missing target: status = %d: %s", rec.Code, rec.Body.String())
	}

	rec = serveAdmin(t, &AdminHandler{DB: newDB("operator")}, http.MethodPut, base+accTargetID.String()+"/role", `{}`)
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "Field required") {
		t.Errorf("missing role: status = %d: %s", rec.Code, rec.Body.String())
	}

	rec = serveAdmin(t, &AdminHandler{DB: newDB("operator")}, http.MethodPut, base+accTargetID.String()+"/role", `{"role":"boss"}`)
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "Invalid role") {
		t.Errorf("unknown role: status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestAdminSetRoleRankRules(t *testing.T) {
	base := "/api/v1/operator/users/" + accTargetID.String() + "/role"

	// A reviewer cannot mint an operator.
	db := &accDB{stubs: []rstub{adminCallerStub("reviewer"), adminTargetStub("user", nil)}}
	rec := serveAdmin(t, &AdminHandler{DB: db}, http.MethodPut, base, `{"role":"operator"}`)
	if rec.Code != http.StatusForbidden ||
		!strings.Contains(rec.Body.String(), "Cannot assign a role higher than your own") {
		t.Errorf("escalation: status = %d: %s", rec.Code, rec.Body.String())
	}

	// Nobody demotes themselves.
	self := &accDB{stubs: []rstub{adminCallerStub("operator")}}
	rec = serveAdmin(t, &AdminHandler{DB: self}, http.MethodPut,
		"/api/v1/operator/users/"+accCallerID.String()+"/role", `{"role":"user"}`)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "Cannot change your own role") {
		t.Errorf("self change: status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestAdminSetRoleApplies(t *testing.T) {
	db := &accDB{stubs: []rstub{adminCallerStub("operator"), adminTargetStub("user", nil)}}
	events := &accEvents{}
	rec := serveAdmin(t, &AdminHandler{DB: db, Events: events}, http.MethodPut,
		"/api/v1/operator/users/"+accTargetID.String()+"/role", `{"role":"reviewer"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["role"] != "reviewer" || out["id"] != accTargetID.String() {
		t.Errorf("role wire: %v", out)
	}
	if len(events.rows) != 1 {
		t.Errorf("role events emitted: %d", len(events.rows))
	}
}

func TestAdminSetDepartment(t *testing.T) {
	db := &accDB{stubs: []rstub{adminCallerStub("operator"), adminTargetStub("user", nil)}}
	rec := serveAdmin(t, &AdminHandler{DB: db}, http.MethodPut,
		"/api/v1/operator/users/"+accTargetID.String()+"/department", `{`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("bad body: status = %d: %s", rec.Code, rec.Body.String())
	}

	db = &accDB{stubs: []rstub{adminCallerStub("operator"), adminTargetStub("user", nil)}}
	rec = serveAdmin(t, &AdminHandler{DB: db}, http.MethodPut,
		"/api/v1/operator/users/"+accTargetID.String()+"/department", `{"department":"Platform"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["department"] != "Platform" {
		t.Errorf("department wire: %v", out)
	}
}

func TestAdminBulkDepartment(t *testing.T) {
	target := "/api/v1/operator/users/bulk-department"

	db := &accDB{stubs: []rstub{adminCallerStub("operator")}}
	rec := serveAdmin(t, &AdminHandler{DB: db}, http.MethodPost, target, `{}`)
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "entries") {
		t.Errorf("missing entries: status = %d: %s", rec.Code, rec.Body.String())
	}

	db = &accDB{stubs: []rstub{adminCallerStub("operator")}}
	rec = serveAdmin(t, &AdminHandler{DB: db}, http.MethodPost, target,
		`{"entries":[{"department":"Platform"}]}`)
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "email") {
		t.Errorf("entry missing email: status = %d: %s", rec.Code, rec.Body.String())
	}

	db = &accDB{stubs: []rstub{adminCallerStub("operator")},
		execs: []execStub{{arg: "ghost@x.io", tag: pgconn.NewCommandTag("UPDATE 0")}}}
	rec = serveAdmin(t, &AdminHandler{DB: db}, http.MethodPost, target,
		`{"entries":[{"email":" B@x.io ","department":"Platform"},{"email":"ghost@x.io","department":"Ops"}]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	notFound, _ := out["not_found"].([]any)
	if out["updated"] != float64(1) || len(notFound) != 1 || notFound[0] != "ghost@x.io" {
		t.Errorf("bulk wire: %v", out)
	}
}

func TestAdminDeleteUserGuards(t *testing.T) {
	rec := serveAdmin(t, &AdminHandler{DB: &accDB{stubs: []rstub{adminCallerStub("operator")}}},
		http.MethodDelete, "/api/v1/operator/users/"+accCallerID.String(), "")
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "Cannot delete yourself") {
		t.Errorf("self delete: status = %d: %s", rec.Code, rec.Body.String())
	}

	lastOperator := &accDB{stubs: []rstub{
		adminCallerStub("operator"), adminTargetStub("operator", nil),
		{match: "count(*) FROM users WHERE role::text", rows: &accRows{rows: [][]any{{1}}}},
	}}
	rec = serveAdmin(t, &AdminHandler{DB: lastOperator}, http.MethodDelete,
		"/api/v1/operator/users/"+accTargetID.String(), "")
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "Cannot delete the last operator") {
		t.Errorf("last operator: status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestAdminDeleteUserRemovesAndNotifiesBridge(t *testing.T) {
	var gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	db := &accDB{stubs: []rstub{
		adminCallerStub("operator"), adminTargetStub("operator", "auth-9"),
		{match: "count(*) FROM users WHERE role::text", rows: &accRows{rows: [][]any{{2}}}},
	}}
	events := &accEvents{}
	h := &AdminHandler{DB: db, Events: events, Bridge: &Minter{BaseURL: srv.URL, InternalSecret: "shh"}}
	rec := serveAdmin(t, h, http.MethodDelete, "/api/v1/operator/users/"+accTargetID.String(), "")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	deleted := false
	for _, sql := range db.execLog {
		if strings.Contains(sql, "DELETE FROM users") {
			deleted = true
		}
	}
	if !deleted {
		t.Errorf("no DELETE issued: %v", db.execLog)
	}
	if gotPath != "/internal/revoke-sessions" || gotBody["userId"] != "auth-9" {
		t.Errorf("bridge call: %s %v", gotPath, gotBody)
	}
	if len(events.rows) != 1 {
		t.Errorf("delete events emitted: %d", len(events.rows))
	}
}
