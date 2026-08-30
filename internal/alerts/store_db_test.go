// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package alerts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

// ── Postgres fake ────────────────────────────────────────────────────────────

// alertRows implements pgx.Rows over literal row data.
type alertRows struct {
	rows [][]any
	idx  int
}

func (r *alertRows) Close()                                       {}
func (r *alertRows) Err() error                                   { return nil }
func (r *alertRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (r *alertRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (r *alertRows) Next() bool                                   { r.idx++; return r.idx <= len(r.rows) }
func (r *alertRows) Values() ([]any, error)                       { return r.rows[r.idx-1], nil }
func (r *alertRows) RawValues() [][]byte                          { return nil }
func (r *alertRows) Conn() *pgx.Conn                              { return nil }

func (r *alertRows) Scan(dest ...any) error {
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
			s, _ := row[i].(string)
			*p = s
		case *float64:
			f, _ := row[i].(float64)
			*p = f
		case *uuid.UUID:
			switch v := row[i].(type) {
			case uuid.UUID:
				*p = v
			case string:
				*p = uuid.MustParse(v)
			}
		case *time.Time:
			ts, _ := row[i].(time.Time)
			*p = ts
		case **time.Time:
			if row[i] == nil {
				*p = nil
			} else {
				ts, _ := row[i].(time.Time)
				*p = &ts
			}
		case **int:
			if row[i] == nil {
				*p = nil
			} else {
				n, _ := row[i].(int)
				*p = &n
			}
		case **string:
			if row[i] == nil {
				*p = nil
			} else {
				s, _ := row[i].(string)
				*p = &s
			}
		default:
			return fmt.Errorf("unsupported scan destination %T", d)
		}
	}
	return nil
}

type alertRow struct{ rows *alertRows }

func (r alertRow) Scan(dest ...any) error {
	if !r.rows.Next() {
		return pgx.ErrNoRows
	}
	return r.rows.Scan(dest...)
}

// alertsDB plays back one result set and records every statement.
type alertsDB struct {
	rows     [][]any
	queryErr error
	execErr  error
	queries  []string
	args     [][]any
	execs    []string
	execArgs [][]any
}

func (db *alertsDB) Query(_ context.Context, sql string, args ...any) (pgx.Rows, error) {
	db.queries = append(db.queries, sql)
	db.args = append(db.args, args)
	if db.queryErr != nil {
		return nil, db.queryErr
	}
	return &alertRows{rows: db.rows}, nil
}

func (db *alertsDB) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	db.queries = append(db.queries, sql)
	db.args = append(db.args, args)
	return alertRow{&alertRows{rows: db.rows}}
}

func (db *alertsDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	db.execs = append(db.execs, sql)
	db.execArgs = append(db.execArgs, args)
	return pgconn.CommandTag{}, db.execErr
}

var (
	ruleID    = uuid.MustParse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
	creatorID = uuid.MustParse("11111111-1111-1111-1111-111111111111")
	createdTS = time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
)

// ruleRow matches scanRule's column order.
func ruleRow(lastTriggered any) []any {
	return []any{
		ruleID, "high errors", "error_rate", 5.5, "above", "agent", "agent-1",
		"https://hooks.example.com/x", "s3cretvalue", "active", lastTriggered,
		creatorID, createdTS,
	}
}

// ── Store ────────────────────────────────────────────────────────────────────

func TestStoreListOwnerScope(t *testing.T) {
	db := &alertsDB{rows: [][]any{ruleRow(nil)}}
	store := &Store{DB: db}

	rules, err := store.List(context.Background(), nil)
	if err != nil || len(rules) != 1 {
		t.Fatalf("list all: %v %v", rules, err)
	}
	if strings.Contains(db.queries[0], "WHERE created_by") || len(db.args[0]) != 0 {
		t.Fatalf("admin scope must not filter: %s %v", db.queries[0], db.args[0])
	}
	got := rules[0]
	if got.ID != ruleID || got.Threshold != 5.5 || got.WebhookSecret != "s3cretvalue" ||
		got.LastTriggered != nil || got.CreatedBy != creatorID || !got.CreatedAt.Equal(createdTS) {
		t.Fatalf("scanned rule = %+v", got)
	}

	owner := creatorID
	if _, err := store.List(context.Background(), &owner); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(db.queries[1], "WHERE created_by = $1") || db.args[1][0] != owner {
		t.Fatalf("owner scope: %s %v", db.queries[1], db.args[1])
	}
}

func TestStoreListQueryFailure(t *testing.T) {
	store := &Store{DB: &alertsDB{queryErr: errors.New("pg down")}}
	if _, err := store.List(context.Background(), nil); err == nil {
		t.Fatal("query failure must surface")
	}
}

func TestStoreCreate(t *testing.T) {
	db := &alertsDB{}
	store := &Store{DB: db}
	created, err := store.Create(context.Background(), Rule{
		Name: "r", Metric: "token_usage", Threshold: 10, Condition: "above",
		TargetType: "all", WebhookSecret: "s", CreatedBy: creatorID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.ID == uuid.Nil || created.Status != "active" || created.CreatedAt.IsZero() {
		t.Fatalf("created = %+v", created)
	}
	if len(db.execs) != 1 || !strings.Contains(db.execs[0], "INSERT INTO alert_rules") {
		t.Fatalf("execs = %v", db.execs)
	}
	if len(db.execArgs[0]) != 12 || db.execArgs[0][0] != created.ID {
		t.Fatalf("args = %v", db.execArgs[0])
	}

	db.execErr = errors.New("pg down")
	if _, err := store.Create(context.Background(), Rule{}); err == nil {
		t.Fatal("insert failure must surface")
	}
}

func TestStoreByIDNotFound(t *testing.T) {
	store := &Store{DB: &alertsDB{}}
	if _, err := store.ByID(context.Background(), ruleID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestStoreUpdate(t *testing.T) {
	fired := time.Date(2026, 5, 2, 8, 0, 0, 0, time.UTC)
	db := &alertsDB{rows: [][]any{ruleRow(fired)}}
	store := &Store{DB: db}
	status := "paused"
	got, err := store.Update(context.Background(), ruleID, &status, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(db.queries[0], "COALESCE($2, status)") {
		t.Fatalf("sql = %s", db.queries[0])
	}
	if db.args[0][0] != ruleID || *(db.args[0][1].(*string)) != "paused" || db.args[0][2] != (*string)(nil) {
		t.Fatalf("args = %v", db.args[0])
	}
	if got.LastTriggered == nil || !got.LastTriggered.Equal(fired) {
		t.Fatalf("last_triggered = %v", got.LastTriggered)
	}
}

func TestStoreUpdateSecret(t *testing.T) {
	db := &alertsDB{rows: [][]any{ruleRow(nil)}}
	store := &Store{DB: db}
	if _, err := store.UpdateSecret(context.Background(), ruleID, "newsecret"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(db.queries[0], "SET webhook_secret = $2") || db.args[0][1] != "newsecret" {
		t.Fatalf("sql = %s args = %v", db.queries[0], db.args[0])
	}
}

func TestStoreDeleteRemovesHistoryToo(t *testing.T) {
	db := &alertsDB{}
	store := &Store{DB: db}
	if err := store.Delete(context.Background(), ruleID); err != nil {
		t.Fatal(err)
	}
	if len(db.execs) != 1 {
		t.Fatalf("execs = %v", db.execs)
	}
	if !strings.Contains(db.execs[0], "DELETE FROM alert_history") ||
		!strings.Contains(db.execs[0], "DELETE FROM alert_rules") {
		t.Fatalf("delete must sweep history in the same statement: %s", db.execs[0])
	}
}

func TestStoreHistoryFor(t *testing.T) {
	fired := time.Date(2026, 5, 2, 8, 0, 0, 0, time.UTC)
	code := 502
	errText := "HTTP 502"
	db := &alertsDB{rows: [][]any{
		{uuid.New(), ruleID, 7.5, 5.0, "above", fired, "failed", code, errText, fired},
		{uuid.New(), ruleID, 6.0, 5.0, "above", fired, "delivered", nil, nil, fired},
	}}
	store := &Store{DB: db}
	history, err := store.HistoryFor(context.Background(), ruleID, 50, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 2 {
		t.Fatalf("history = %v", history)
	}
	if *history[0].ResponseCode != 502 || *history[0].Error != "HTTP 502" {
		t.Fatalf("first = %+v", history[0])
	}
	if history[1].ResponseCode != nil || history[1].Error != nil {
		t.Fatalf("second = %+v", history[1])
	}
	if !strings.Contains(db.queries[0], "LIMIT $2 OFFSET $3") ||
		db.args[0][1] != 50 || db.args[0][2] != 10 {
		t.Fatalf("paging: %s %v", db.queries[0], db.args[0])
	}
}

func TestStoreActiveRules(t *testing.T) {
	db := &alertsDB{rows: [][]any{ruleRow(nil)}}
	store := &Store{DB: db}
	rules, err := store.ActiveRules(context.Background())
	if err != nil || len(rules) != 1 {
		t.Fatalf("rules = %v err = %v", rules, err)
	}
	if !strings.Contains(db.queries[0], "WHERE status = 'active'") {
		t.Fatalf("sql = %s", db.queries[0])
	}
}

func TestStoreRecordFiring(t *testing.T) {
	fired := time.Date(2026, 5, 3, 9, 0, 0, 0, time.UTC)
	db := &alertsDB{}
	store := &Store{DB: db}
	err := store.RecordFiring(context.Background(), History{
		AlertRuleID: ruleID, MetricValue: 42, Threshold: 10, Condition: "above",
		FiredAt: fired, DeliveryStatus: "delivered",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(db.execs) != 1 || !strings.Contains(db.execs[0], "INSERT INTO alert_history") ||
		!strings.Contains(db.execs[0], "UPDATE alert_rules SET last_triggered = $6") {
		t.Fatalf("execs = %v", db.execs)
	}
	args := db.execArgs[0]
	if len(args) != 10 || args[1] != ruleID || args[5] != fired || args[9] != fired {
		t.Fatalf("args = %v", args)
	}
}

// ── Handler storage failures ─────────────────────────────────────────────────

// failingStore wraps fakeStore with per-method error injection.
type failingStore struct {
	*fakeStore
	listErr    error
	createErr  error
	byIDErr    error
	updateErr  error
	secretErr  error
	deleteErr  error
	historyErr error
}

func (f *failingStore) List(ctx context.Context, owner *uuid.UUID) ([]Rule, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	return f.fakeStore.List(ctx, owner)
}

func (f *failingStore) Create(ctx context.Context, r Rule) (Rule, error) {
	if f.createErr != nil {
		return Rule{}, f.createErr
	}
	return f.fakeStore.Create(ctx, r)
}

func (f *failingStore) ByID(ctx context.Context, id uuid.UUID) (Rule, error) {
	if f.byIDErr != nil {
		return Rule{}, f.byIDErr
	}
	return f.fakeStore.ByID(ctx, id)
}

func (f *failingStore) Update(ctx context.Context, id uuid.UUID, status, webhookURL *string) (Rule, error) {
	if f.updateErr != nil {
		return Rule{}, f.updateErr
	}
	return f.fakeStore.Update(ctx, id, status, webhookURL)
}

func (f *failingStore) UpdateSecret(ctx context.Context, id uuid.UUID, secret string) (Rule, error) {
	if f.secretErr != nil {
		return Rule{}, f.secretErr
	}
	return f.fakeStore.UpdateSecret(ctx, id, secret)
}

func (f *failingStore) Delete(ctx context.Context, id uuid.UUID) error {
	if f.deleteErr != nil {
		return f.deleteErr
	}
	return f.fakeStore.Delete(ctx, id)
}

func (f *failingStore) HistoryFor(ctx context.Context, ruleID uuid.UUID, limit, offset int) ([]History, error) {
	if f.historyErr != nil {
		return nil, f.historyErr
	}
	return f.fakeStore.HistoryFor(ctx, ruleID, limit, offset)
}

func sanitized500(t *testing.T, rec *httptest.ResponseRecorder, secret string) {
	t.Helper()
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), secret) {
		t.Fatalf("internal detail leaked: %s", rec.Body.String())
	}
}

func TestHandlerStorageFailuresAreSanitized(t *testing.T) {
	boom := errors.New("pg down: password=hunter2")

	t.Run("list", func(t *testing.T) {
		h := newTestHandler(&fakeStore{}, &fakeSender{})
		h.Store = &failingStore{fakeStore: &fakeStore{}, listErr: boom}
		sanitized500(t, doAs(t, h, http.MethodGet, "/api/v1/alerts", "", ownerID, "user"), "hunter2")
	})
	t.Run("create", func(t *testing.T) {
		h := newTestHandler(&fakeStore{}, &fakeSender{})
		h.Store = &failingStore{fakeStore: &fakeStore{}, createErr: boom}
		rec := doAs(t, h, http.MethodPost, "/api/v1/alerts",
			`{"name":"x","metric":"error_rate","threshold":1,"condition":"above"}`, ownerID, "user")
		sanitized500(t, rec, "hunter2")
	})
	t.Run("byid", func(t *testing.T) {
		store := &fakeStore{}
		rule := seedRule(store, "")
		h := newTestHandler(store, &fakeSender{})
		h.Store = &failingStore{fakeStore: store, byIDErr: boom}
		rec := doAs(t, h, http.MethodPatch, "/api/v1/alerts/"+rule.ID.String(), `{}`, ownerID, "user")
		sanitized500(t, rec, "hunter2")
	})
	t.Run("update", func(t *testing.T) {
		store := &fakeStore{}
		rule := seedRule(store, "")
		h := newTestHandler(store, &fakeSender{})
		h.Store = &failingStore{fakeStore: store, updateErr: boom}
		rec := doAs(t, h, http.MethodPatch, "/api/v1/alerts/"+rule.ID.String(), `{"status":"paused"}`, ownerID, "user")
		sanitized500(t, rec, "hunter2")
	})
	t.Run("delete", func(t *testing.T) {
		store := &fakeStore{}
		rule := seedRule(store, "")
		h := newTestHandler(store, &fakeSender{})
		h.Store = &failingStore{fakeStore: store, deleteErr: boom}
		rec := doAs(t, h, http.MethodDelete, "/api/v1/alerts/"+rule.ID.String(), "", ownerID, "user")
		sanitized500(t, rec, "hunter2")
	})
	t.Run("history", func(t *testing.T) {
		store := &fakeStore{}
		rule := seedRule(store, "")
		h := newTestHandler(store, &fakeSender{})
		h.Store = &failingStore{fakeStore: store, historyErr: boom}
		rec := doAs(t, h, http.MethodGet, "/api/v1/alerts/"+rule.ID.String()+"/history", "", ownerID, "user")
		sanitized500(t, rec, "hunter2")
	})
	t.Run("rotate", func(t *testing.T) {
		store := &fakeStore{}
		rule := seedRule(store, "")
		h := newTestHandler(store, &fakeSender{})
		h.Store = &failingStore{fakeStore: store, secretErr: boom}
		rec := doAs(t, h, http.MethodPost, "/api/v1/alerts/"+rule.ID.String()+"/webhook-secret/rotate", "", otherID, "operator")
		sanitized500(t, rec, "hunter2")
	})
}

func TestUpdateBodyValidation(t *testing.T) {
	store := &fakeStore{}
	rule := seedRule(store, "")
	h := newTestHandler(store, &fakeSender{})

	rec := doAs(t, h, http.MethodPatch, "/api/v1/alerts/"+rule.ID.String(), "not json", ownerID, "user")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid body: %d %s", rec.Code, rec.Body.String())
	}

	h.privateURL = func(context.Context, string) bool { return true }
	rec = doAs(t, h, http.MethodPatch, "/api/v1/alerts/"+rule.ID.String(),
		`{"webhook_url":"https://internal"}`, ownerID, "user")
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "private/internal") {
		t.Fatalf("SSRF rejection on update: %d %s", rec.Code, rec.Body.String())
	}
	if store.rules[rule.ID].WebhookURL != "" {
		t.Fatal("rejected URL must not be stored")
	}
}

func TestHistoryOffsetValidation(t *testing.T) {
	store := &fakeStore{}
	rule := seedRule(store, "")
	h := newTestHandler(store, &fakeSender{})

	for _, query := range []string{"offset=-1", "offset=abc", "limit=abc"} {
		rec := doAs(t, h, http.MethodGet, "/api/v1/alerts/"+rule.ID.String()+"/history?"+query, "", ownerID, "user")
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("%s: status = %d %s", query, rec.Code, rec.Body.String())
		}
	}
}

// ── Wire helpers ─────────────────────────────────────────────────────────────

func TestToJSONEdges(t *testing.T) {
	fired := time.Date(2026, 5, 2, 8, 30, 0, 123456000, time.UTC)
	wire := toJSON(Rule{WebhookSecret: "abc", LastTriggered: &fired, CreatedAt: createdTS})
	// Secrets shorter than four characters pass through whole.
	if wire.WebhookSecretLast != "abc" {
		t.Fatalf("last4 = %q", wire.WebhookSecretLast)
	}
	if wire.LastTriggered == nil || *wire.LastTriggered != "2026-05-02T08:30:00.123456Z" {
		t.Fatalf("last_triggered = %v", wire.LastTriggered)
	}
}

func TestFiredAtSubsecond(t *testing.T) {
	ts := time.Date(2026, 5, 3, 9, 0, 0, 123456000, time.UTC)
	if got := firedAt(ts); got != "2026-05-03T09:00:00.123456+00:00" {
		t.Fatalf("firedAt = %q", got)
	}
}

// ── Evaluator edges ──────────────────────────────────────────────────────────

func TestCycleListFailureStopsQuietly(t *testing.T) {
	store := &fakeEvalStore{listErr: errors.New("pg down")}
	e := newEvaluator(t, store, &fakeSender{}, &chFake{})
	e.Cycle(context.Background())
	if len(store.firings) != 0 {
		t.Fatalf("firings = %v", store.firings)
	}
}

func TestMetricValueCoercions(t *testing.T) {
	t.Run("string usage fires", func(t *testing.T) {
		store := &fakeEvalStore{rules: []Rule{evalRule("token_usage", "above", 100, "")}}
		e := newEvaluator(t, store, &fakeSender{}, &chFake{usage: "123.5"})
		e.Cycle(context.Background())
		if len(store.firings) != 1 || store.firings[0].MetricValue != 123.5 {
			t.Fatalf("firings = %+v", store.firings)
		}
	})
	t.Run("unparseable usage skips", func(t *testing.T) {
		store := &fakeEvalStore{rules: []Rule{evalRule("token_usage", "above", 0, "")}}
		e := newEvaluator(t, store, &fakeSender{}, &chFake{usage: "not-a-number"})
		e.Cycle(context.Background())
		if len(store.firings) != 0 {
			t.Fatalf("firings = %+v", store.firings)
		}
	})
	t.Run("non-numeric usage skips", func(t *testing.T) {
		store := &fakeEvalStore{rules: []Rule{evalRule("token_usage", "above", 0, "")}}
		e := newEvaluator(t, store, &fakeSender{}, &chFake{usage: true})
		e.Cycle(context.Background())
		if len(store.firings) != 0 {
			t.Fatalf("firings = %+v", store.firings)
		}
	})
	t.Run("empty result set skips", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{}})
		}))
		t.Cleanup(server.Close)
		client, err := clickhouse.New(server.URL, server.Client())
		if err != nil {
			t.Fatal(err)
		}
		store := &fakeEvalStore{rules: []Rule{evalRule("token_usage", "below", 100, "")}}
		e := &Evaluator{Store: store, CH: client, Webhook: &fakeSender{}, Lock: fakeLock{allow: true}}
		e.Cycle(context.Background())
		if len(store.firings) != 0 {
			t.Fatalf("firings = %+v", store.firings)
		}
	})
}

// ── Webhook delivery edges ───────────────────────────────────────────────────

func TestDeliverNetworkFailureExhaustsRetries(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	target := server.URL
	server.Close() // now refuses connections
	d := &Deliverer{sleep: func(time.Duration) {}, private: func(context.Context, string) bool { return false }}
	result := d.Deliver(context.Background(), target, "", []byte("{}"), uuid.New())
	if result.Success || result.Attempts != 3 || result.Error == nil {
		t.Fatalf("result = %+v", result)
	}
}

func TestDeliverRecordsDeliveryTrail(t *testing.T) {
	var inserted string
	chServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		inserted = string(body)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(chServer.Close)
	ch, err := clickhouse.New(chServer.URL, chServer.Client())
	if err != nil {
		t.Fatal(err)
	}
	hook := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(hook.Close)

	d := &Deliverer{
		CH:      ch,
		sleep:   func(time.Duration) {},
		private: func(context.Context, string) bool { return false },
	}
	id := uuid.New()
	result := d.Deliver(context.Background(), hook.URL, "s3cret", []byte(`{"a":1}`), id)
	if !result.Success || result.Attempts != 1 {
		t.Fatalf("result = %+v", result)
	}
	if !strings.Contains(inserted, "INSERT INTO webhook_deliveries") {
		t.Fatalf("trail insert missing: %s", inserted)
	}
	if !strings.Contains(inserted, `"alert_rule_id":"`+id.String()+`"`) ||
		!strings.Contains(inserted, `"delivery_status":"delivered"`) ||
		!strings.Contains(inserted, `"payload_size":7`) {
		t.Fatalf("trail record = %s", inserted)
	}
}

// ── SSRF hostname resolution ─────────────────────────────────────────────────

func TestIsPrivateURLHostnames(t *testing.T) {
	ctx := context.Background()
	// localhost resolves through the hosts file to loopback.
	if !IsPrivateURL(ctx, "http://localhost/hook") {
		t.Error("localhost must be private")
	}
	// Unresolvable names fail closed.
	if !IsPrivateURL(ctx, "http://caracal-test.invalid/hook") {
		t.Error("unresolvable hostname must fail closed")
	}
	// Unparseable URLs fail closed.
	if !IsPrivateURL(ctx, "http://%zz") {
		t.Error("unparseable URL must fail closed")
	}
}
