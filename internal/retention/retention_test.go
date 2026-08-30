// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package retention

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/redis/go-redis/v9"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

func intp(v int) *int { return &v }

func TestUpdateValidate(t *testing.T) {
	cases := []struct {
		name string
		u    Update
		want string
	}{
		{"data floor", Update{DataRetentionDays: intp(3)}, "data_retention_days must be >= 7"},
		{"score floor", Update{ScoreRetentionDays: intp(6)}, "score_retention_days must be >= 7"},
		{"count floor", Update{MaxTraceCount: intp(10)}, "max_trace_count must be >= 1000"},
		{"score ordering", Update{DataRetentionDays: intp(90), ScoreRetentionDays: intp(30)},
			"score_retention_days must be >= data_retention_days"},
		{"enable requires horizon", Update{Enabled: true},
			"At least one of data_retention_days or max_trace_count is required when enabling retention"},
		{"valid", Update{Enabled: true, DataRetentionDays: intp(30), ScoreRetentionDays: intp(60)}, ""},
		{"valid disabled empty", Update{}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.u.Validate()
			if tc.want == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || err.Error() != tc.want {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestNextRun(t *testing.T) {
	cases := []struct {
		now  string
		want string
	}{
		{"2026-01-05T00:10:00Z", "2026-01-05T01:30:00Z"},
		{"2026-01-05T01:30:00Z", "2026-01-05T07:30:00Z"},
		{"2026-01-05T13:29:59Z", "2026-01-05T13:30:00Z"},
		{"2026-01-05T20:00:00Z", "2026-01-06T01:30:00Z"},
	}
	for _, tc := range cases {
		now, _ := time.Parse(time.RFC3339, tc.now)
		want, _ := time.Parse(time.RFC3339, tc.want)
		if got := nextRun(now); !got.Equal(want) {
			t.Errorf("nextRun(%s) = %s, want %s", tc.now, got, want)
		}
	}
}

// fakeSettings backs the config with a plain map.
type fakeSettings struct{ values map[string]string }

func (f fakeSettings) String(_ context.Context, key, fallback string) string {
	if v, ok := f.values[key]; ok {
		return v
	}
	return fallback
}

func (f fakeSettings) Bool(_ context.Context, key string, fallback bool) bool {
	if v, ok := f.values[key]; ok {
		return v == "true"
	}
	return fallback
}

func (f fakeSettings) Int(_ context.Context, key string, fallback int) int {
	if v, ok := f.values[key]; ok && v != "" {
		n := 0
		for _, c := range v {
			n = n*10 + int(c-'0')
		}
		return n
	}
	return fallback
}

func (f fakeSettings) Invalidate(...string) {}

// fakeCH records queries and plays back canned rows; errs fails matching
// queries and execErr fails every Exec.
type fakeCH struct {
	rows    map[string][]map[string]any
	errs    map[string]error
	execErr error
	execs   []string
	inserts []string
}

func (f *fakeCH) QueryJSON(_ context.Context, sql string, _ clickhouse.Settings) ([]map[string]any, error) {
	for marker, err := range f.errs {
		if strings.Contains(sql, marker) {
			return nil, err
		}
	}
	for marker, rows := range f.rows {
		if strings.Contains(sql, marker) {
			return rows, nil
		}
	}
	return nil, nil
}

func (f *fakeCH) Exec(_ context.Context, sql string, _ clickhouse.Settings) error {
	f.execs = append(f.execs, sql)
	return f.execErr
}

func (f *fakeCH) InsertJSONEachRow(_ context.Context, sql string, _ []any) error {
	f.inserts = append(f.inserts, sql)
	return nil
}

// fakeDB satisfies PGQuerier with no-op results.
type fakeDB struct{ execs []string }

func (f *fakeDB) Query(context.Context, string, ...any) (pgx.Rows, error) { return nil, pgx.ErrNoRows }
func (f *fakeDB) QueryRow(context.Context, string, ...any) pgx.Row        { return errRow{} }
func (f *fakeDB) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	f.execs = append(f.execs, sql)
	return pgconn.CommandTag{}, nil
}

type errRow struct{}

func (errRow) Scan(...any) error { return pgx.ErrNoRows }

func TestStatsDisabled(t *testing.T) {
	store := &Store{Settings: fakeSettings{values: map[string]string{}}, CH: &fakeCH{}}
	got := store.Stats(context.Background())
	if got["retention_enabled"] != false {
		t.Fatalf("retention_enabled = %v", got["retention_enabled"])
	}
	if got["next_purge_approx"] != nil {
		t.Fatalf("next_purge_approx = %v, want nil", got["next_purge_approx"])
	}
	if got["data_retention_days"] != nil {
		t.Fatalf("data_retention_days = %v, want nil", got["data_retention_days"])
	}
}

func TestStatsEnabled(t *testing.T) {
	ch := &fakeCH{rows: map[string][]map[string]any{
		"count(DISTINCT session_id) AS cnt, ": {{"cnt": "42", "age": "12", "expiring": "5"}},
	}}
	store := &Store{
		Settings: fakeSettings{values: map[string]string{
			"retention.enabled": "true", "retention.trace_days": "30",
		}},
		CH: ch,
	}
	got := store.Stats(context.Background())
	if got["total_traces"] != int64(42) || got["oldest_trace_age_days"] != int64(12) {
		t.Fatalf("stats = %v", got)
	}
	if got["traces_expiring_7d"] != int64(5) {
		t.Fatalf("traces_expiring_7d = %v", got["traces_expiring_7d"])
	}
}

func TestPurgeGates(t *testing.T) {
	ch := &fakeCH{}
	db := &fakeDB{}
	// Disabled: no store calls at all.
	store := &Store{Settings: fakeSettings{values: map[string]string{}}, CH: ch, DB: db}
	if err := store.Purge(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(ch.execs) != 0 {
		t.Fatalf("execs = %v, want none", ch.execs)
	}
	// Enabled with horizons but no data: still no deletions.
	store.Settings = fakeSettings{values: map[string]string{
		"retention.enabled": "true", "retention.trace_days": "30",
	}}
	if err := store.Purge(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(ch.execs) != 0 {
		t.Fatalf("execs = %v, want none without data", ch.execs)
	}
}

func TestPurgeRuns(t *testing.T) {
	ch := &fakeCH{rows: map[string][]map[string]any{
		"SELECT 1 AS one": {{"one": "1"}},
	}}
	db := &fakeDB{}
	store := &Store{
		Settings: fakeSettings{values: map[string]string{
			"retention.enabled": "true", "retention.trace_days": "30",
		}},
		CH: ch, DB: db,
	}
	if err := store.Purge(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(ch.execs) != 2 {
		t.Fatalf("execs = %d, want trace delete + orphan sweep", len(ch.execs))
	}
	if !strings.Contains(ch.execs[0], "DELETE FROM session_events") {
		t.Fatalf("first exec = %s", ch.execs[0])
	}
	if !strings.Contains(ch.execs[1], "DELETE FROM session_stats_agg") {
		t.Fatalf("second exec = %s", ch.execs[1])
	}
	// Score fallback trace_days*2 kicks in: two report deletions.
	if len(db.execs) != 2 {
		t.Fatalf("db execs = %v", db.execs)
	}
}

func TestPurgeOverCount(t *testing.T) {
	ch := &fakeCH{rows: map[string][]map[string]any{
		"SELECT 1 AS one": {{"one": "1"}},
		"GROUP BY day": {
			{"day": "2026-01-05", "cnt": "600"},
			{"day": "2026-01-04", "cnt": "600"},
			{"day": "2026-01-03", "cnt": "600"},
		},
	}}
	db := &fakeDB{}
	store := &Store{
		Settings: fakeSettings{values: map[string]string{
			"retention.enabled": "true", "retention.max_trace_count": "1000",
		}},
		CH: ch, DB: db,
	}
	if err := store.Purge(context.Background()); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, sql := range ch.execs {
		if strings.Contains(sql, "DELETE FROM session_events") {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected count-ceiling delete, execs = %v", ch.execs)
	}
}

func TestPurgeSkipsWhileInsightsInFlight(t *testing.T) {
	ch := &fakeCH{rows: map[string][]map[string]any{
		"SELECT 1 AS one": {{"one": "1"}},
	}}
	db := &stubDB{row: stubRow{vals: []any{"report-1"}}}
	store := &Store{
		Settings: fakeSettings{values: map[string]string{
			"retention.enabled": "true", "retention.trace_days": "30",
		}},
		CH: ch, DB: db,
	}
	if err := store.Purge(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(ch.execs) != 0 || len(db.execs) != 0 {
		t.Fatalf("in-flight insights must block the purge: ch=%v db=%v", ch.execs, db.execs)
	}
}

func TestPurgeScoreOnlyHorizonClampedTo30(t *testing.T) {
	ch := &fakeCH{rows: map[string][]map[string]any{
		"SELECT 1 AS one": {{"one": "1"}},
	}}
	db := &stubDB{row: stubRow{err: pgx.ErrNoRows}}
	store := &Store{
		Settings: fakeSettings{values: map[string]string{
			"retention.enabled": "true", "retention.score_days": "10",
		}},
		CH: ch, DB: db,
	}
	if err := store.Purge(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(ch.execs) != 0 {
		t.Fatalf("score-only purge must not delete traces: %v", ch.execs)
	}
	if len(db.execs) != 2 {
		t.Fatalf("db execs = %v, want the two report deletions", db.execs)
	}
	for i, sql := range db.execs {
		if !strings.Contains(sql, "DELETE FROM insight_reports") {
			t.Fatalf("exec %d = %s", i, sql)
		}
		cutoff, ok := db.execArgs[i][0].(time.Time)
		if !ok {
			t.Fatalf("cutoff arg = %T", db.execArgs[i][0])
		}
		// score_days below the floor clamps the horizon to 30 days.
		age := time.Since(cutoff)
		if age < 29*24*time.Hour || age > 31*24*time.Hour {
			t.Fatalf("cutoff age = %v, want about 30 days", age)
		}
	}
}

func TestPurgeOverCountBelowCapDeletesNothing(t *testing.T) {
	ch := &fakeCH{rows: map[string][]map[string]any{
		"SELECT 1 AS one": {{"one": "1"}},
		"GROUP BY day": {
			{"day": "2026-01-05", "cnt": "400"},
			{"day": "2026-01-04", "cnt": "500"},
		},
	}}
	store := &Store{
		Settings: fakeSettings{values: map[string]string{
			"retention.enabled": "true", "retention.max_trace_count": "1000",
		}},
		CH: ch, DB: &fakeDB{},
	}
	if err := store.Purge(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(ch.execs) != 0 {
		t.Fatalf("under-cap population must not be deleted: %v", ch.execs)
	}
}

func TestPurgeOverCountQueryFailureAborts(t *testing.T) {
	ch := &fakeCH{
		rows: map[string][]map[string]any{"SELECT 1 AS one": {{"one": "1"}}},
		errs: map[string]error{"GROUP BY day": errors.New("ch down")},
	}
	store := &Store{
		Settings: fakeSettings{values: map[string]string{
			"retention.enabled": "true", "retention.max_trace_count": "1000",
		}},
		CH: ch, DB: &fakeDB{},
	}
	if err := store.Purge(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(ch.execs) != 0 {
		t.Fatalf("failed count query must abort the ceiling purge: %v", ch.execs)
	}
}

func TestPurgeTraceDeleteFailureStillExpiresReports(t *testing.T) {
	ch := &fakeCH{
		rows:    map[string][]map[string]any{"SELECT 1 AS one": {{"one": "1"}}},
		execErr: errors.New("mutation rejected"),
	}
	db := &stubDB{row: stubRow{err: pgx.ErrNoRows}}
	store := &Store{
		Settings: fakeSettings{values: map[string]string{
			"retention.enabled": "true", "retention.trace_days": "30",
		}},
		CH: ch, DB: db,
	}
	if err := store.Purge(context.Background()); err != nil {
		t.Fatalf("trace-delete failure must not fail the run: %v", err)
	}
	// Both the trace delete and the orphan sweep were attempted.
	if len(ch.execs) != 2 {
		t.Fatalf("ch execs = %v", ch.execs)
	}
	if len(db.execs) != 2 {
		t.Fatalf("report expiry must still run: %v", db.execs)
	}
}

func TestWriteConfigInvalidatesRedisCache(t *testing.T) {
	db := &stubDB{}
	// A closed local port: the cache drop is best-effort and its error is
	// swallowed, so the write must still succeed.
	client := redis.NewClient(&redis.Options{Addr: "127.0.0.1:1", MaxRetries: -1})
	t.Cleanup(func() { _ = client.Close() })
	store := &Store{
		DB: db, Settings: fakeSettings{values: map[string]string{}}, Redis: client,
	}
	days := 30
	if err := store.WriteConfig(context.Background(), Update{Enabled: true, DataRetentionDays: &days}); err != nil {
		t.Fatal(err)
	}
	if len(db.execs) != 4 {
		t.Fatalf("execs = %d, want one upsert per retention key", len(db.execs))
	}
}

func TestChIntCoercions(t *testing.T) {
	row := map[string]any{"quoted": "42", "native": 7.0, "bad": []any{}}
	if chInt(row, "quoted") != 42 || chInt(row, "native") != 7 {
		t.Errorf("chInt conversions: %v %v", chInt(row, "quoted"), chInt(row, "native"))
	}
	if chInt(row, "bad") != 0 || chInt(row, "missing") != 0 {
		t.Error("unsupported values must read as zero")
	}
}
