// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package alerts

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

type fakeEvalStore struct {
	rules    []Rule
	firings  []History
	listErr  error
	storeErr error
}

func (f *fakeEvalStore) ActiveRules(context.Context) ([]Rule, error) { return f.rules, f.listErr }
func (f *fakeEvalStore) RecordFiring(_ context.Context, h History) error {
	if f.storeErr != nil {
		return f.storeErr
	}
	f.firings = append(f.firings, h)
	return nil
}

type fakeLock struct{ allow bool }

func (f fakeLock) TryLock(context.Context, string, time.Duration) bool { return f.allow }

type chFake struct {
	usage   any
	fail    bool
	lastSQL string
	lastQS  map[string][]string
}

func (c *chFake) handler(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	c.lastSQL = string(body)
	c.lastQS = r.URL.Query()
	if c.fail {
		http.Error(w, "boom", http.StatusInternalServerError)
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{"token_usage": c.usage}}})
}

func newEvaluator(t *testing.T, store *fakeEvalStore, sender Sender, ch *chFake) *Evaluator {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(ch.handler))
	t.Cleanup(server.Close)
	client, err := clickhouse.New(server.URL, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	return &Evaluator{
		Store: store, CH: client, Webhook: sender, Lock: fakeLock{allow: true},
		now: func() time.Time { return time.Date(2026, 5, 3, 9, 0, 0, 0, time.UTC) },
	}
}

func evalRule(metric, condition string, threshold float64, webhookURL string) Rule {
	return Rule{
		ID: uuid.New(), Name: "r", Metric: metric, Threshold: threshold, Condition: condition,
		TargetType: "all", WebhookURL: webhookURL, WebhookSecret: "s3cret", Status: "active",
	}
}

func TestEvaluatorFiresBelowOnPlaceholderMetric(t *testing.T) {
	store := &fakeEvalStore{rules: []Rule{evalRule("error_rate", "below", 1, "")}}
	e := newEvaluator(t, store, &fakeSender{}, &chFake{usage: float64(0)})
	e.Cycle(context.Background())
	if len(store.firings) != 1 {
		t.Fatalf("firings = %d", len(store.firings))
	}
	h := store.firings[0]
	if h.MetricValue != 0 || h.DeliveryStatus != "delivered" || h.ResponseCode != nil || h.Error != nil {
		t.Fatalf("history = %+v", h)
	}
	if !h.FiredAt.Equal(time.Date(2026, 5, 3, 9, 0, 0, 0, time.UTC)) {
		t.Fatalf("fired_at = %v", h.FiredAt)
	}
}

func TestEvaluatorConditionGate(t *testing.T) {
	store := &fakeEvalStore{rules: []Rule{
		evalRule("token_usage", "above", 100, ""),
		evalRule("token_usage", "below", 100, ""),
		evalRule("token_usage", "bogus", 100, ""),
	}}
	e := newEvaluator(t, store, &fakeSender{}, &chFake{usage: float64(500)})
	e.Cycle(context.Background())
	if len(store.firings) != 1 || store.firings[0].Condition != "above" {
		t.Fatalf("firings = %+v", store.firings)
	}
}

func TestEvaluatorTokenQueryScoping(t *testing.T) {
	ch := &chFake{usage: float64(1)}
	store := &fakeEvalStore{rules: []Rule{{
		ID: uuid.New(), Name: "a", Metric: "token_usage", Threshold: 0, Condition: "above",
		TargetType: "agent", TargetID: "agent-1", Status: "active",
	}}}
	e := newEvaluator(t, store, &fakeSender{}, ch)
	e.Cycle(context.Background())
	if !strings.Contains(ch.lastSQL, "AND agent_id = {target_id:String}") {
		t.Fatalf("agent filter missing: %s", ch.lastSQL)
	}
	if got := ch.lastQS["param_target_id"]; len(got) != 1 || got[0] != "agent-1" {
		t.Fatalf("target param: %v", ch.lastQS)
	}
	if got := ch.lastQS["param_lookback"]; len(got) != 1 || got[0] != "5" {
		t.Fatalf("lookback param: %v", ch.lastQS)
	}

	ch.lastSQL = ""
	store.rules[0].TargetType = "mcp"
	store.firings = nil
	e.Cycle(context.Background())
	if strings.Contains(ch.lastSQL, "agent_id") {
		t.Fatalf("mcp target must not filter by agent: %s", ch.lastSQL)
	}
}

func TestEvaluatorWebhookFiring(t *testing.T) {
	sender := &fakeSender{}
	code := 200
	sender.result = DeliveryResult{Success: true, StatusCode: &code, Attempts: 1}
	store := &fakeEvalStore{rules: []Rule{evalRule("token_usage", "above", 100.5, "https://example.com/hook")}}
	e := newEvaluator(t, store, sender, &chFake{usage: float64(250)})
	e.Cycle(context.Background())
	if sender.calls != 1 || sender.url != "https://example.com/hook" {
		t.Fatalf("delivery calls = %d url = %s", sender.calls, sender.url)
	}
	h := store.firings[0]
	if h.DeliveryStatus != "delivered" || *h.ResponseCode != 200 {
		t.Fatalf("history = %+v", h)
	}
}

func TestEvaluatorWebhookFailure(t *testing.T) {
	errText := "HTTP 500"
	sender := &fakeSender{result: DeliveryResult{Attempts: 3, Error: &errText}}
	store := &fakeEvalStore{rules: []Rule{evalRule("error_rate", "below", 1, "https://example.com/hook")}}
	e := newEvaluator(t, store, sender, &chFake{})
	e.Cycle(context.Background())
	h := store.firings[0]
	if h.DeliveryStatus != "failed" || h.ResponseCode != nil || *h.Error != "HTTP 500" {
		t.Fatalf("history = %+v", h)
	}
}

func TestEvaluatorPayloadShape(t *testing.T) {
	var captured []byte
	sender := &captureSender{}
	rule := evalRule("token_usage", "above", 10, "https://example.com/hook")
	rule.Name = "tokens high"
	store := &fakeEvalStore{rules: []Rule{rule}}
	e := newEvaluator(t, store, sender, &chFake{usage: float64(42)})
	e.Cycle(context.Background())
	captured = sender.body
	want := `{"alert_rule_id":"` + rule.ID.String() + `","alert_name":"tokens high","metric":"token_usage",` +
		`"metric_value":42.0,"threshold":10.0,"condition":"above","target_type":"all","target_id":"",` +
		`"fired_at":"2026-05-03T09:00:00+00:00"}`
	if string(captured) != want {
		t.Fatalf("payload:\n got %s\nwant %s", captured, want)
	}
}

type captureSender struct {
	body []byte
}

func (c *captureSender) Deliver(_ context.Context, _, _ string, body []byte, _ uuid.UUID) DeliveryResult {
	c.body = body
	code := 200
	return DeliveryResult{Success: true, StatusCode: &code, Attempts: 1}
}

func TestEvaluatorSkipsWhenMetricUnavailable(t *testing.T) {
	store := &fakeEvalStore{rules: []Rule{evalRule("token_usage", "above", 0, "")}}
	e := newEvaluator(t, store, &fakeSender{}, &chFake{fail: true})
	e.Cycle(context.Background())
	if len(store.firings) != 0 {
		t.Fatalf("CH failure must skip evaluation: %+v", store.firings)
	}

	store = &fakeEvalStore{rules: []Rule{evalRule("unknown_metric", "above", 0, "")}}
	e = newEvaluator(t, store, &fakeSender{}, &chFake{usage: float64(1)})
	e.Cycle(context.Background())
	if len(store.firings) != 0 {
		t.Fatal("unknown metric must not fire")
	}
}

func TestEvaluatorLockGate(t *testing.T) {
	store := &fakeEvalStore{rules: []Rule{evalRule("error_rate", "below", 1, "")}}
	e := newEvaluator(t, store, &fakeSender{}, &chFake{})
	e.Lock = fakeLock{allow: false}
	e.Cycle(context.Background())
	if len(store.firings) != 0 {
		t.Fatal("cycle must not run without the lock")
	}
}

func TestEvaluatorRuleErrorDoesNotStopCycle(t *testing.T) {
	store := &fakeEvalStore{
		rules:    []Rule{evalRule("error_rate", "below", 1, ""), evalRule("error_rate", "below", 1, "")},
		storeErr: errors.New("db down"),
	}
	e := newEvaluator(t, store, &fakeSender{}, &chFake{})
	e.Cycle(context.Background()) // both rules attempted, neither panics the cycle
	if len(store.firings) != 0 {
		t.Fatalf("firings = %d", len(store.firings))
	}
}
