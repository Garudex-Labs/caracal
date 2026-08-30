// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package support

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/redis/go-redis/v9"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/logring"
)

// ── Postgres fake ────────────────────────────────────────────────────────────

// fakeRows implements pgx.Rows over literal row data.
type fakeRows struct {
	rows [][]any
	idx  int
}

func (r *fakeRows) Close()                                       {}
func (r *fakeRows) Err() error                                   { return nil }
func (r *fakeRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (r *fakeRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (r *fakeRows) Next() bool                                   { r.idx++; return r.idx <= len(r.rows) }
func (r *fakeRows) Values() ([]any, error)                       { return r.rows[r.idx-1], nil }
func (r *fakeRows) RawValues() [][]byte                          { return nil }
func (r *fakeRows) Conn() *pgx.Conn                              { return nil }

func (r *fakeRows) Scan(dest ...any) error {
	if r.idx == 0 || r.idx > len(r.rows) {
		return pgx.ErrNoRows
	}
	row := r.rows[r.idx-1]
	for i, d := range dest {
		if i >= len(row) {
			break
		}
		switch p := d.(type) {
		case *string:
			p2, _ := row[i].(string)
			*p = p2
		case *int:
			switch v := row[i].(type) {
			case int:
				*p = v
			case int64:
				*p = int(v)
			}
		case *int64:
			switch v := row[i].(type) {
			case int:
				*p = int64(v)
			case int64:
				*p = v
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

type errRow struct{ err error }

func (r errRow) Scan(...any) error { return r.err }

// stub answers queries whose SQL contains the match fragment.
type stub struct {
	match string
	rows  *fakeRows
}

// fakeDB routes queries to stubs by SQL substring, recording every statement.
// The collectors run concurrently, so all mutation is mutex-guarded.
type fakeDB struct {
	mu    sync.Mutex
	stubs []stub
	err   error // when set, every query fails with it
	log   []string
}

func (db *fakeDB) route(sql string) (*fakeRows, error) {
	db.mu.Lock()
	db.log = append(db.log, sql)
	db.mu.Unlock()
	if db.err != nil {
		return nil, db.err
	}
	for _, s := range db.stubs {
		if strings.Contains(sql, s.match) {
			copyRows := *s.rows
			copyRows.idx = 0
			return &copyRows, nil
		}
	}
	return &fakeRows{}, nil
}

func (db *fakeDB) Query(_ context.Context, sql string, _ ...any) (pgx.Rows, error) {
	return db.route(sql)
}

func (db *fakeDB) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	rows, err := db.route(sql)
	if err != nil {
		return errRow{err}
	}
	return fakeRow{rows}
}

func (db *fakeDB) statements() []string {
	db.mu.Lock()
	defer db.mu.Unlock()
	return append([]string(nil), db.log...)
}

// ── ClickHouse fake ──────────────────────────────────────────────────────────

// chBackend plays ClickHouse over HTTP, routing by SQL substring.
type chBackend struct {
	mu   sync.Mutex
	fail bool
	log  []string
}

func (b *chBackend) handler(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	sql := r.URL.Query().Get("query") + string(body)
	b.mu.Lock()
	b.log = append(b.log, sql)
	fail := b.fail
	b.mu.Unlock()
	if fail {
		http.Error(w, "Code: 999. DB::Exception: boom-ch-secret", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	writeRows := func(rows []map[string]any) {
		_ = json.NewEncoder(w).Encode(map[string]any{"data": rows})
	}
	switch {
	case strings.Contains(sql, "version()"):
		writeRows([]map[string]any{{"v": "24.8.1"}})
	case strings.Contains(sql, "system.tables"):
		writeRows([]map[string]any{{"name": "session_stats_agg"}, {"name": "bad`table"}})
	case strings.Contains(sql, "count() AS cnt"):
		writeRows([]map[string]any{{"cnt": "12"}})
	default:
		writeRows([]map[string]any{})
	}
}

func (b *chBackend) statements() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.log...)
}

// ── Redis and settings fakes ─────────────────────────────────────────────────

// fakeRedis satisfies redis.UniversalClient; only Ping is ever called.
type fakeRedis struct {
	redis.UniversalClient
	err error
}

func (f fakeRedis) Ping(ctx context.Context) *redis.StatusCmd {
	cmd := redis.NewStatusCmd(ctx)
	if f.err != nil {
		cmd.SetErr(f.err)
	} else {
		cmd.SetVal("PONG")
	}
	return cmd
}

type fakeSettings map[string]string

func (f fakeSettings) String(_ context.Context, key, fallback string) string {
	if v, ok := f[key]; ok {
		return v
	}
	return fallback
}

// ── Harness ──────────────────────────────────────────────────────────────────

func healthyDB() *fakeDB {
	return &fakeDB{stubs: []stub{
		{match: "alembic_version", rows: &fakeRows{rows: [][]any{{"rev-42"}}}},
		{match: "pg_tables", rows: &fakeRows{rows: [][]any{{"users"}, {"drop;table"}}}},
		{match: `count(*) FROM "users"`, rows: &fakeRows{rows: [][]any{{int64(5)}}}},
		{match: "SELECT 1", rows: &fakeRows{rows: [][]any{{1}}}},
	}}
}

func newHandler(t *testing.T, db *fakeDB, backend *chBackend, redisErr error) *Handler {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(backend.handler))
	t.Cleanup(server.Close)
	ch, err := clickhouse.New(server.URL, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	return &Handler{
		DB:            db,
		CH:            ch,
		Redis:         fakeRedis{err: redisErr},
		Settings:      fakeSettings{"eval.model_name": "claude-fable-5"},
		Ring:          &logring.Ring{},
		Version:       "9.9.9",
		PostgresURL:   "postgresql://db/caracal",
		ClickHouseURL: "clickhouse://ch/caracal",
		RedisURL:      "redis://cache:6379/0",
	}
}

func postCollect(h *Handler, body string, userID uuid.UUID) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/support/collect", strings.NewReader(body))
	req = req.WithContext(httpapi.ContextWithClaims(req.Context(),
		auth.Claims{UserID: userID, Role: "operator"}))
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	return rec
}

type collectorResult struct {
	OK    bool           `json:"ok"`
	Data  map[string]any `json:"data"`
	Error *string        `json:"error"`
}

type collectResponse struct {
	ServerVersion string                     `json:"server_version"`
	Collectors    map[string]collectorResult `json:"collectors"`
}

func decodeCollect(t *testing.T, rec *httptest.ResponseRecorder) collectResponse {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out collectResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return out
}

var actorRichard = uuid.MustParse("22222222-2222-2222-2222-222222222222")

// ── Tests ────────────────────────────────────────────────────────────────────

func TestCollectRunsEveryCollectorAgainstHealthyBackends(t *testing.T) {
	h := newHandler(t, healthyDB(), &chBackend{}, nil)
	out := decodeCollect(t, postCollect(h, `{}`, actorRichard))

	if out.ServerVersion != "9.9.9" {
		t.Errorf("server_version = %q", out.ServerVersion)
	}
	for _, name := range []string{"versions", "health", "config", "aggregates", "errors", "logs"} {
		res, ok := out.Collectors[name]
		if !ok {
			t.Fatalf("collector %q missing: %v", name, out.Collectors)
		}
		if !res.OK || res.Error != nil {
			t.Errorf("collector %q not ok: %+v", name, res)
		}
	}
	if len(out.Collectors) != 6 {
		t.Errorf("collector count = %d", len(out.Collectors))
	}

	versions := out.Collectors["versions"].Data
	if versions["app_version"] != "9.9.9" || versions["alembic_revision"] != "rev-42" ||
		versions["clickhouse_version"] != "24.8.1" {
		t.Errorf("versions = %v", versions)
	}
	tables, _ := versions["clickhouse_tables"].([]any)
	if len(tables) != 2 || tables[0] != "session_stats_agg" {
		t.Errorf("clickhouse_tables = %v", versions["clickhouse_tables"])
	}

	health := out.Collectors["health"].Data
	for _, dep := range []string{"postgres", "clickhouse", "redis"} {
		probe, _ := health[dep].(map[string]any)
		if probe["status"] != "ok" {
			t.Errorf("health.%s = %v", dep, health[dep])
		}
	}

	config := out.Collectors["config"].Data
	if config["DATABASE_URL"] != "postgresql://db/caracal" ||
		config["JWT_SIGNING_ALGORITHM"] != "ES256" ||
		config["licensed"] != true ||
		config["eval.model_name"] != "claude-fable-5" ||
		config["deployment.frontend_url"] != "http://localhost:8000" {
		t.Errorf("config = %v", config)
	}

	aggregates := out.Collectors["aggregates"].Data
	pgCounts, _ := aggregates["pg_table_counts"].(map[string]any)
	if pgCounts["users"] != float64(5) {
		t.Errorf("pg_table_counts.users = %v", pgCounts["users"])
	}
	chCounts, _ := aggregates["ch_table_counts"].(map[string]any)
	if chCounts["session_stats_agg"] != float64(12) {
		t.Errorf("ch_table_counts.session_stats_agg = %v", chCounts["session_stats_agg"])
	}

	if _, hasNote := out.Collectors["logs"].Data["note"]; !hasNote {
		t.Errorf("empty ring should carry the restart note: %v", out.Collectors["logs"].Data)
	}
}

func TestCollectAggregatesNeverCountsUnsafeTableNames(t *testing.T) {
	db := healthyDB()
	backend := &chBackend{}
	h := newHandler(t, db, backend, nil)
	out := decodeCollect(t, postCollect(h, `{"collectors":["aggregates"]}`, actorRichard))

	aggregates := out.Collectors["aggregates"].Data
	pgCounts, _ := aggregates["pg_table_counts"].(map[string]any)
	if pgCounts["drop;table"] != "error: unsafe table name, skipped" {
		t.Errorf("unsafe pg table not skipped: %v", pgCounts)
	}
	chCounts, _ := aggregates["ch_table_counts"].(map[string]any)
	if chCounts["bad`table"] != "error: unsafe table name, skipped" {
		t.Errorf("unsafe ch table not skipped: %v", chCounts)
	}
	// The skip must happen before storage sees an interpolated identifier.
	for _, sql := range db.statements() {
		if strings.Contains(sql, "drop;table") {
			t.Errorf("unsafe pg identifier reached storage: %s", sql)
		}
	}
	for _, sql := range backend.statements() {
		if strings.Contains(sql, "bad`table") && strings.Contains(sql, "count()") {
			t.Errorf("unsafe ch identifier reached storage: %s", sql)
		}
	}
}

func TestCollectHonorsRequestedSubset(t *testing.T) {
	db := healthyDB()
	backend := &chBackend{}
	h := newHandler(t, db, backend, nil)

	out := decodeCollect(t, postCollect(h, `{"collectors":["config","logs"]}`, actorRichard))
	if len(out.Collectors) != 2 {
		t.Fatalf("collectors = %v", out.Collectors)
	}
	if _, ok := out.Collectors["config"]; !ok {
		t.Error("config missing")
	}
	if _, ok := out.Collectors["logs"]; !ok {
		t.Error("logs missing")
	}
	if n := len(db.statements()); n != 0 {
		t.Errorf("config/logs subset touched postgres %d times", n)
	}
	if n := len(backend.statements()); n != 0 {
		t.Errorf("config/logs subset touched clickhouse %d times", n)
	}

	out = decodeCollect(t, postCollect(h, `{"collectors":["bogus"]}`, actorRichard))
	if len(out.Collectors) != 0 {
		t.Errorf("unknown collector names should yield no results: %v", out.Collectors)
	}
}

func TestCollectReportsBackendFailuresWithoutLeakingDetails(t *testing.T) {
	db := &fakeDB{err: errors.New("pg exploded password=hunter2")}
	backend := &chBackend{fail: true}
	h := newHandler(t, db, backend, errors.New("redis down auth=hunter2"))
	rec := postCollect(h, `{}`, actorRichard)
	out := decodeCollect(t, rec)

	versions := out.Collectors["versions"].Data
	if versions["alembic_revision"] != "unknown" {
		t.Errorf("alembic_revision = %v", versions["alembic_revision"])
	}
	if versions["clickhouse_version"] != "error: QueryError" {
		t.Errorf("clickhouse_version = %v", versions["clickhouse_version"])
	}
	if tables, _ := versions["clickhouse_tables"].([]any); len(tables) != 0 {
		t.Errorf("clickhouse_tables = %v", versions["clickhouse_tables"])
	}

	health := out.Collectors["health"].Data
	for dep, wantErr := range map[string]string{
		"postgres": "QueryError", "clickhouse": "QueryError", "redis": "PingError",
	} {
		probe, _ := health[dep].(map[string]any)
		if probe["status"] != "error" || probe["error"] != wantErr {
			t.Errorf("health.%s = %v", dep, health[dep])
		}
	}

	aggregates := out.Collectors["aggregates"].Data
	pgCounts, _ := aggregates["pg_table_counts"].(map[string]any)
	if pgCounts["error"] != "QueryError" {
		t.Errorf("pg_table_counts = %v", aggregates["pg_table_counts"])
	}
	chCounts, _ := aggregates["ch_table_counts"].(map[string]any)
	if chCounts["error"] != "QueryError" {
		t.Errorf("ch_table_counts = %v", aggregates["ch_table_counts"])
	}

	body := rec.Body.String()
	for _, leak := range []string{"hunter2", "boom-ch-secret", "pg exploded", "redis down"} {
		if strings.Contains(body, leak) {
			t.Errorf("backend detail %q leaked into the bundle", leak)
		}
	}
}

func TestCollectRateLimitsPerActor(t *testing.T) {
	h := &Handler{}
	for i := 0; i < 5; i++ {
		if rec := postCollect(h, `{"collectors":["errors"]}`, actorRichard); rec.Code != http.StatusOK {
			t.Fatalf("request %d = %d", i+1, rec.Code)
		}
	}
	rec := postCollect(h, `{"collectors":["errors"]}`, actorRichard)
	if rec.Code != http.StatusTooManyRequests ||
		!strings.Contains(rec.Body.String(), "Rate limit exceeded: 5 per 1 minute") {
		t.Fatalf("sixth request = %d %s", rec.Code, rec.Body.String())
	}
	jared := uuid.MustParse("33333333-3333-3333-3333-333333333333")
	if rec := postCollect(h, `{"collectors":["errors"]}`, jared); rec.Code != http.StatusOK {
		t.Fatalf("distinct actor = %d", rec.Code)
	}
}

func TestCollectRejectsWrongMethod(t *testing.T) {
	h := &Handler{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/support/collect", nil)
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET collect = %d", rec.Code)
	}
}

func TestChNumberNormalizesQuotedIntegers(t *testing.T) {
	if got := chNumber("12"); got != int64(12) {
		t.Errorf(`chNumber("12") = %v (%T)`, got, got)
	}
	if got := chNumber("nope"); got != "nope" {
		t.Errorf(`chNumber("nope") = %v`, got)
	}
	if got := chNumber(float64(3)); got != float64(3) {
		t.Errorf("chNumber(3.0) = %v (%T)", got, got)
	}
}
