// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package retention

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/httpapi"
)

// recordingCH is fakeCH plus query logging and insert-row capture, for
// asserting what actually reaches the analytics store.
type recordingCH struct {
	rows       map[string][]map[string]any
	queries    []string
	execs      []string
	insertSQL  []string
	insertRows [][]any
}

func (f *recordingCH) QueryJSON(_ context.Context, sql string, _ clickhouse.Settings) ([]map[string]any, error) {
	f.queries = append(f.queries, sql)
	for marker, rows := range f.rows {
		if strings.Contains(sql, marker) {
			return rows, nil
		}
	}
	return nil, nil
}

func (f *recordingCH) Exec(_ context.Context, sql string, _ clickhouse.Settings) error {
	f.execs = append(f.execs, sql)
	return nil
}

func (f *recordingCH) InsertJSONEachRow(_ context.Context, sql string, rows []any) error {
	f.insertSQL = append(f.insertSQL, sql)
	f.insertRows = append(f.insertRows, rows)
	return nil
}

// stubRow answers one QueryRow scan positionally.
type stubRow struct {
	vals []any
	err  error
}

func (r stubRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	for i, d := range dest {
		if i >= len(r.vals) {
			break
		}
		switch v := d.(type) {
		case *int64:
			*v = r.vals[i].(int64)
		case *string:
			*v = r.vals[i].(string)
		}
	}
	return nil
}

// agentRows plays back Warnings agent rows: id, nullable name, nullable
// last-report time.
type agentRows struct {
	rows [][]any
	idx  int
}

func (r *agentRows) Close()                                       {}
func (r *agentRows) Err() error                                   { return nil }
func (r *agentRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (r *agentRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (r *agentRows) Next() bool                                   { r.idx++; return r.idx <= len(r.rows) }
func (r *agentRows) Values() ([]any, error)                       { return r.rows[r.idx-1], nil }
func (r *agentRows) RawValues() [][]byte                          { return nil }
func (r *agentRows) Conn() *pgx.Conn                              { return nil }

func (r *agentRows) Scan(dest ...any) error {
	row := r.rows[r.idx-1]
	for i, d := range dest {
		switch v := d.(type) {
		case *string:
			*v = row[i].(string)
		case **string:
			if row[i] == nil {
				*v = nil
			} else {
				s := row[i].(string)
				*v = &s
			}
		case **time.Time:
			if row[i] == nil {
				*v = nil
			} else {
				ts := row[i].(time.Time)
				*v = &ts
			}
		}
	}
	return nil
}

// stubDB routes reads while recording writes; execErr fails every Exec.
type stubDB struct {
	row      stubRow
	rows     pgx.Rows
	queryErr error
	execErr  error
	execs    []string
	execArgs [][]any
}

func (d *stubDB) Query(context.Context, string, ...any) (pgx.Rows, error) {
	if d.queryErr != nil {
		return nil, d.queryErr
	}
	return d.rows, nil
}

func (d *stubDB) QueryRow(context.Context, string, ...any) pgx.Row { return d.row }

func (d *stubDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	d.execs = append(d.execs, sql)
	d.execArgs = append(d.execArgs, args)
	return pgconn.CommandTag{}, d.execErr
}

func doRetention(h *Handler, role, method, target, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req = req.WithContext(httpapi.ContextWithClaims(req.Context(), auth.Claims{
		UserID: uuid.MustParse("22222222-2222-2222-2222-222222222222"), Role: role,
	}))
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	return rec
}

func decodeBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	return body
}

func TestGetConfigWireShape(t *testing.T) {
	h := &Handler{Store: &Store{
		Settings: fakeSettings{values: map[string]string{
			"retention.enabled": "true", "retention.trace_days": "30",
		}},
	}}
	rec := doRetention(h, "operator", http.MethodGet, "/api/v1/operator/retention", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	want := `{"retention_enabled":true,"data_retention_days":30,"score_retention_days":null,"max_trace_count":null,"global_retention_days":90}`
	if got := strings.TrimSpace(rec.Body.String()); got != want {
		t.Fatalf("body = %s, want %s", got, want)
	}
}

func TestPutConfigRequiresOperator(t *testing.T) {
	db := &stubDB{}
	h := &Handler{Store: &Store{DB: db, Settings: fakeSettings{values: map[string]string{}}}}
	rec := doRetention(h, "reviewer", http.MethodPut, "/api/v1/operator/retention",
		`{"retention_enabled":false}`)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	if len(db.execs) != 0 {
		t.Fatalf("denied write must not touch storage: %v", db.execs)
	}
}

func TestPutConfigRejectsInvalidJSON(t *testing.T) {
	db := &stubDB{}
	h := &Handler{Store: &Store{DB: db, Settings: fakeSettings{values: map[string]string{}}}}
	rec := doRetention(h, "operator", http.MethodPut, "/api/v1/operator/retention", "not json")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"type":"json_invalid"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}
	if len(db.execs) != 0 {
		t.Fatalf("invalid body must not touch storage: %v", db.execs)
	}
}

func TestPutConfigValidationEchoesInput(t *testing.T) {
	db := &stubDB{}
	h := &Handler{Store: &Store{DB: db, Settings: fakeSettings{values: map[string]string{}}}}
	rec := doRetention(h, "operator", http.MethodPut, "/api/v1/operator/retention",
		`{"retention_enabled":true}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"type":"value_error"`) ||
		!strings.Contains(body, "At least one of data_retention_days or max_trace_count is required when enabling retention") {
		t.Fatalf("body = %s", body)
	}
	if !strings.Contains(body, `"input":{"retention_enabled":true}`) {
		t.Fatalf("validation detail must echo the raw input: %s", body)
	}
	if len(db.execs) != 0 {
		t.Fatalf("invalid update must not touch storage: %v", db.execs)
	}
}

func TestPutConfigEnforcesGlobalCeiling(t *testing.T) {
	db := &stubDB{}
	h := &Handler{Store: &Store{DB: db, Settings: fakeSettings{values: map[string]string{}}}}
	rec := doRetention(h, "operator", http.MethodPut, "/api/v1/operator/retention",
		`{"retention_enabled":true,"data_retention_days":120}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "data_retention_days cannot exceed global ceiling of 90 days") {
		t.Fatalf("body = %s", rec.Body.String())
	}
	if len(db.execs) != 0 {
		t.Fatalf("over-ceiling update must not touch storage: %v", db.execs)
	}
}

func TestPutConfigPersistsAndAudits(t *testing.T) {
	db := &stubDB{row: stubRow{vals: []any{"ops@example.com", "operator"}}}
	ch := &recordingCH{}
	h := &Handler{Store: &Store{
		DB: db, CH: ch,
		Settings: fakeSettings{values: map[string]string{
			"retention.enabled": "true", "retention.trace_days": "30",
		}},
	}}
	rec := doRetention(h, "operator", http.MethodPut, "/api/v1/operator/retention",
		`{"retention_enabled":true,"data_retention_days":30}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	if len(db.execs) != 4 {
		t.Fatalf("execs = %d, want one upsert per retention key", len(db.execs))
	}
	for _, sql := range db.execs {
		if !strings.Contains(sql, "INSERT INTO enterprise_config") {
			t.Fatalf("unexpected write: %s", sql)
		}
	}
	if len(ch.insertSQL) != 1 || !strings.Contains(ch.insertSQL[0], "security_events") {
		t.Fatalf("audit inserts = %v", ch.insertSQL)
	}
	event := ch.insertRows[0][0].(map[string]any)
	if event["detail"] != "Data retention enabled (days=30, scores=None, max=None)" {
		t.Fatalf("detail = %v", event["detail"])
	}
	if event["actor_email"] != "ops@example.com" || event["event_type"] != "admin.setting.changed" {
		t.Fatalf("event = %v", event)
	}
	if event["event_id"] == "" {
		t.Fatal("event_id must be set")
	}
	want := `{"retention_enabled":true,"data_retention_days":30,"score_retention_days":null,"max_trace_count":null,"global_retention_days":90}`
	if got := strings.TrimSpace(rec.Body.String()); got != want {
		t.Fatalf("body = %s, want %s", got, want)
	}
}

func TestPutConfigStorageFailureIsSanitized(t *testing.T) {
	db := &stubDB{execErr: errors.New("pg down: password=hunter2")}
	h := &Handler{Store: &Store{DB: db, Settings: fakeSettings{values: map[string]string{}}}}
	rec := doRetention(h, "operator", http.MethodPut, "/api/v1/operator/retention",
		`{"retention_enabled":true,"data_retention_days":30}`)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	body := decodeBody(t, rec)
	if body["detail"] != "Internal server error" || body["code"] != "internal_error" {
		t.Fatalf("body = %v", body)
	}
	if strings.Contains(rec.Body.String(), "hunter2") {
		t.Fatalf("internal detail leaked: %s", rec.Body.String())
	}
}

func TestPreviewValidation(t *testing.T) {
	cases := []struct {
		name   string
		target string
		want   string
	}{
		{"missing days", "/api/v1/operator/retention/preview", `"type":"missing"`},
		{"non-integer days", "/api/v1/operator/retention/preview?days=abc", `"type":"int_parsing"`},
		{"days below floor", "/api/v1/operator/retention/preview?days=3", `days must be \u003e= 7`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ch := &recordingCH{}
			h := &Handler{Store: &Store{CH: ch, DB: &stubDB{}, Settings: fakeSettings{values: map[string]string{}}}}
			rec := doRetention(h, "operator", http.MethodGet, tc.target, "")
			if rec.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tc.want) {
				t.Fatalf("body = %s, want %s", rec.Body.String(), tc.want)
			}
			if len(ch.queries) != 0 {
				t.Fatalf("invalid parameters must not reach storage: %v", ch.queries)
			}
		})
	}
}

func TestPreviewRequiresOperator(t *testing.T) {
	h := &Handler{Store: &Store{Settings: fakeSettings{values: map[string]string{}}}}
	rec := doRetention(h, "reviewer", http.MethodGet, "/api/v1/operator/retention/preview?days=30", "")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
}

func TestPreviewCountsBothStores(t *testing.T) {
	ch := &recordingCH{rows: map[string][]map[string]any{
		"FROM session_events": {{"cnt": "12"}},
	}}
	db := &stubDB{row: stubRow{vals: []any{int64(3)}}}
	h := &Handler{Store: &Store{CH: ch, DB: db, Settings: fakeSettings{values: map[string]string{}}}}
	rec := doRetention(h, "operator", http.MethodGet, "/api/v1/operator/retention/preview?days=30", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	body := decodeBody(t, rec)
	if body["session_events"] != float64(12) || body["insight_reports"] != float64(3) {
		t.Fatalf("body = %v", body)
	}
	if len(ch.queries) != 1 || !strings.Contains(ch.queries[0], "INTERVAL {days:UInt32} DAY") {
		t.Fatalf("queries = %v", ch.queries)
	}
}

func TestPreviewStoreFailureIsSanitized(t *testing.T) {
	db := &stubDB{row: stubRow{err: errors.New("pg down")}}
	h := &Handler{Store: &Store{CH: &recordingCH{}, DB: db, Settings: fakeSettings{values: map[string]string{}}}}
	rec := doRetention(h, "operator", http.MethodGet, "/api/v1/operator/retention/preview?days=30", "")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	if body := decodeBody(t, rec); body["detail"] != "Internal server error" {
		t.Fatalf("body = %v", body)
	}
}

func TestStatsRoute(t *testing.T) {
	h := &Handler{Store: &Store{CH: &recordingCH{}, Settings: fakeSettings{values: map[string]string{}}}}
	rec := doRetention(h, "operator", http.MethodGet, "/api/v1/operator/retention/stats", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	if body := decodeBody(t, rec); body["retention_enabled"] != false {
		t.Fatalf("body = %v", body)
	}
}

func TestWarningsDisabledPolicy(t *testing.T) {
	h := &Handler{Store: &Store{Settings: fakeSettings{values: map[string]string{}}}}
	rec := doRetention(h, "operator", http.MethodGet, "/api/v1/operator/retention/warnings", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	body := decodeBody(t, rec)
	if body["retention_enabled"] != false || body["retention_days"] != nil {
		t.Fatalf("body = %v", body)
	}
	if warnings, ok := body["warnings"].([]any); !ok || len(warnings) != 0 {
		t.Fatalf("warnings = %v", body["warnings"])
	}
}

func TestWarningsListsStaleAgents(t *testing.T) {
	fresh := time.Now().UTC()
	stale := time.Date(2025, 3, 4, 5, 6, 7, 123456000, time.UTC)
	db := &stubDB{rows: &agentRows{rows: [][]any{
		{"agent-fresh", "Fresh Bot", fresh},
		{"agent-stale", "Deploy Bot", stale},
		{"agent-never", nil, nil},
		{"agent-blank", "", stale},
	}}}
	h := &Handler{Store: &Store{
		DB: db,
		Settings: fakeSettings{values: map[string]string{
			"retention.enabled": "true", "retention.trace_days": "30",
		}},
	}}
	rec := doRetention(h, "operator", http.MethodGet, "/api/v1/operator/retention/warnings", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	body := decodeBody(t, rec)
	if body["retention_days"] != float64(30) || body["retention_enabled"] != true {
		t.Fatalf("body = %v", body)
	}
	warnings := body["warnings"].([]any)
	if len(warnings) != 3 {
		t.Fatalf("warnings = %v, want the three stale agents", warnings)
	}
	first := warnings[0].(map[string]any)
	if first["agent_id"] != "agent-stale" || first["agent_name"] != "Deploy Bot" {
		t.Fatalf("first warning = %v", first)
	}
	if first["last_insight_report"] != "2025-03-04T05:06:07.123456+00:00" {
		t.Fatalf("last_insight_report = %v", first["last_insight_report"])
	}
	second := warnings[1].(map[string]any)
	if second["agent_name"] != "Unnamed Agent" || second["last_insight_report"] != nil {
		t.Fatalf("never-reported warning = %v", second)
	}
	third := warnings[2].(map[string]any)
	if third["agent_name"] != "Unnamed Agent" {
		t.Fatalf("blank-name warning = %v", third)
	}
}

func TestWarningsStoreFailureIsSanitized(t *testing.T) {
	db := &stubDB{queryErr: errors.New("pg down")}
	h := &Handler{Store: &Store{
		DB: db,
		Settings: fakeSettings{values: map[string]string{
			"retention.enabled": "true", "retention.trace_days": "30",
		}},
	}}
	rec := doRetention(h, "operator", http.MethodGet, "/api/v1/operator/retention/warnings", "")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	if body := decodeBody(t, rec); body["detail"] != "Internal server error" {
		t.Fatalf("body = %v", body)
	}
}

// stubLock records lock attempts and answers with a fixed grant.
type stubLock struct {
	grant bool
	calls chan struct{}
}

func (l *stubLock) TryLock(context.Context, string, time.Duration) bool {
	select {
	case l.calls <- struct{}{}:
	default:
	}
	return l.grant
}

// switchingNow fires the first scheduled run immediately, then pushes the
// next run far into the future so Run blocks on the context.
func switchingNow() func() time.Time {
	fired := false
	return func() time.Time {
		if !fired {
			fired = true
			return time.Now().Add(-24 * time.Hour)
		}
		return time.Now().Add(24 * time.Hour)
	}
}

func TestPurgerRunSkipsWhenLockDenied(t *testing.T) {
	ch := &fakeCH{rows: map[string][]map[string]any{"SELECT 1 AS one": {{"one": "1"}}}}
	store := &Store{
		Settings: fakeSettings{values: map[string]string{
			"retention.enabled": "true", "retention.trace_days": "30",
		}},
		CH: ch, DB: &fakeDB{},
	}
	lock := &stubLock{grant: false, calls: make(chan struct{}, 1)}
	p := &Purger{Store: store, Lock: lock, Now: switchingNow()}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { p.Run(ctx); close(done) }()

	<-lock.calls
	cancel()
	<-done
	if len(ch.execs) != 0 {
		t.Fatalf("denied lock must not purge: %v", ch.execs)
	}
}

func TestPurgerRunPurgesWhenLockGranted(t *testing.T) {
	ch := &fakeCH{rows: map[string][]map[string]any{"SELECT 1 AS one": {{"one": "1"}}}}
	store := &Store{
		Settings: fakeSettings{values: map[string]string{
			"retention.enabled": "true", "retention.trace_days": "30",
		}},
		CH: ch, DB: &fakeDB{},
	}
	lock := &stubLock{grant: true, calls: make(chan struct{}, 1)}
	p := &Purger{Store: store, Lock: lock, Now: switchingNow()}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { p.Run(ctx); close(done) }()

	<-lock.calls
	cancel()
	<-done
	if len(ch.execs) == 0 || !strings.Contains(ch.execs[0], "DELETE FROM session_events") {
		t.Fatalf("granted lock must run the purge: %v", ch.execs)
	}
}
