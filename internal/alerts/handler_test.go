// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package alerts

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/httpapi"
)

type fakeStore struct {
	rules   map[uuid.UUID]Rule
	history []History
	deleted []uuid.UUID
}

func (f *fakeStore) List(_ context.Context, owner *uuid.UUID) ([]Rule, error) {
	out := []Rule{}
	for _, r := range f.rules {
		if owner == nil || r.CreatedBy == *owner {
			out = append(out, r)
		}
	}
	return out, nil
}

func (f *fakeStore) Create(_ context.Context, r Rule) (Rule, error) {
	r.ID = uuid.New()
	r.Status = "active"
	r.CreatedAt = time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	if f.rules == nil {
		f.rules = map[uuid.UUID]Rule{}
	}
	f.rules[r.ID] = r
	return r, nil
}

func (f *fakeStore) ByID(_ context.Context, id uuid.UUID) (Rule, error) {
	r, ok := f.rules[id]
	if !ok {
		return Rule{}, ErrNotFound
	}
	return r, nil
}

func (f *fakeStore) Update(_ context.Context, id uuid.UUID, status, webhookURL *string) (Rule, error) {
	r := f.rules[id]
	if status != nil {
		r.Status = *status
	}
	if webhookURL != nil {
		r.WebhookURL = *webhookURL
	}
	f.rules[id] = r
	return r, nil
}

func (f *fakeStore) UpdateSecret(_ context.Context, id uuid.UUID, secret string) (Rule, error) {
	r := f.rules[id]
	r.WebhookSecret = secret
	f.rules[id] = r
	return r, nil
}

func (f *fakeStore) Delete(_ context.Context, id uuid.UUID) error {
	f.deleted = append(f.deleted, id)
	delete(f.rules, id)
	return nil
}

func (f *fakeStore) HistoryFor(_ context.Context, _ uuid.UUID, limit, offset int) ([]History, error) {
	if offset >= len(f.history) {
		return []History{}, nil
	}
	end := min(offset+limit, len(f.history))
	return f.history[offset:end], nil
}

type fakeSender struct {
	result DeliveryResult
	calls  int
	url    string
}

func (f *fakeSender) Deliver(_ context.Context, url, _ string, _ []byte, _ uuid.UUID) DeliveryResult {
	f.calls++
	f.url = url
	return f.result
}

var (
	ownerID = uuid.MustParse("11111111-1111-1111-1111-111111111111")
	otherID = uuid.MustParse("22222222-2222-2222-2222-222222222222")
)

func seedRule(store *fakeStore, webhookURL string) Rule {
	rule := Rule{
		ID: uuid.New(), Name: "high errors", Metric: "error_rate", Threshold: 5,
		Condition: "above", TargetType: "all", WebhookURL: webhookURL,
		WebhookSecret: strings.Repeat("ab", 32), Status: "active",
		CreatedBy: ownerID, CreatedAt: time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC),
	}
	if store.rules == nil {
		store.rules = map[uuid.UUID]Rule{}
	}
	store.rules[rule.ID] = rule
	return rule
}

func doAs(t *testing.T, h *Handler, method, path, body string, userID uuid.UUID, role string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	req = req.WithContext(httpapi.ContextWithClaims(req.Context(), auth.Claims{UserID: userID, Role: role}))
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	return rec
}

func newTestHandler(store *fakeStore, sender *fakeSender) *Handler {
	return &Handler{
		Store:      store,
		Webhook:    sender,
		privateURL: func(_ context.Context, _ string) bool { return false },
	}
}

func TestListScopesByRole(t *testing.T) {
	store := &fakeStore{}
	seedRule(store, "")
	h := newTestHandler(store, &fakeSender{})

	rec := doAs(t, h, http.MethodGet, "/api/v1/alerts", "", otherID, "user")
	var mine []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &mine); err != nil || len(mine) != 0 {
		t.Fatalf("non-owner user should see nothing: %v %s", err, rec.Body.String())
	}

	rec = doAs(t, h, http.MethodGet, "/api/v1/alerts", "", otherID, "operator")
	var all []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &all); err != nil || len(all) != 1 {
		t.Fatalf("operator should see all rules: %v %s", err, rec.Body.String())
	}
	if all[0]["webhook_secret_last4"] != "ab" && all[0]["webhook_secret_last4"] != "abab"[len("abab")-4:] {
		t.Fatalf("secret must be redacted to last4: %v", all[0]["webhook_secret_last4"])
	}
	if _, exposed := all[0]["webhook_secret"]; exposed {
		t.Fatal("full webhook_secret must not appear in listings")
	}
	if all[0]["threshold"] != 5.0 {
		t.Fatalf("threshold = %v", all[0]["threshold"])
	}
}

func TestCreateValidation(t *testing.T) {
	h := newTestHandler(&fakeStore{}, &fakeSender{})

	rec := doAs(t, h, http.MethodPost, "/api/v1/alerts", `{"name":"x"}`, ownerID, "user")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("missing fields: %d", rec.Code)
	}

	rec = doAs(t, h, http.MethodPost, "/api/v1/alerts",
		`{"name":"x","metric":"error_rate","threshold":1,"condition":"above","webhook_url":"ftp://x"}`, ownerID, "user")
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "http or https") {
		t.Fatalf("scheme rejection: %d %s", rec.Code, rec.Body.String())
	}

	h.privateURL = func(_ context.Context, _ string) bool { return true }
	rec = doAs(t, h, http.MethodPost, "/api/v1/alerts",
		`{"name":"x","metric":"error_rate","threshold":1,"condition":"above","webhook_url":"https://internal"}`, ownerID, "user")
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "private/internal") {
		t.Fatalf("SSRF rejection: %d %s", rec.Code, rec.Body.String())
	}
}

func TestCreateClearsTargetIDForAll(t *testing.T) {
	store := &fakeStore{}
	h := newTestHandler(store, &fakeSender{})
	rec := doAs(t, h, http.MethodPost, "/api/v1/alerts",
		`{"name":"x","metric":"error_rate","threshold":2.5,"condition":"above","target_id":"ignored"}`, ownerID, "user")
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body["target_id"] != "" || body["target_type"] != "all" || body["status"] != "active" {
		t.Fatalf("defaults: %v", body)
	}
	if last4, ok := body["webhook_secret_last4"].(string); !ok || len(last4) != 4 {
		t.Fatalf("secret last4: %v", body["webhook_secret_last4"])
	}
	if body["last_triggered"] != nil {
		t.Fatalf("last_triggered should be null: %v", body["last_triggered"])
	}
}

func TestUpdateOwnership(t *testing.T) {
	store := &fakeStore{}
	rule := seedRule(store, "")
	h := newTestHandler(store, &fakeSender{})

	rec := doAs(t, h, http.MethodPatch, "/api/v1/alerts/"+rule.ID.String(), `{"status":"paused"}`, otherID, "user")
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "Not authorized to modify") {
		t.Fatalf("foreign update: %d %s", rec.Code, rec.Body.String())
	}

	rec = doAs(t, h, http.MethodPatch, "/api/v1/alerts/"+rule.ID.String(), `{"status":"paused"}`, otherID, "operator")
	if rec.Code != http.StatusOK {
		t.Fatalf("operator update: %d %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body["status"] != "paused" {
		t.Fatalf("status: %v", body["status"])
	}

	rec = doAs(t, h, http.MethodPatch, "/api/v1/alerts/"+uuid.NewString(), `{"status":"active"}`, ownerID, "user")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing rule: %d", rec.Code)
	}

	rec = doAs(t, h, http.MethodPatch, "/api/v1/alerts/not-a-uuid", `{}`, ownerID, "user")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad uuid: %d", rec.Code)
	}
}

func TestDelete(t *testing.T) {
	store := &fakeStore{}
	rule := seedRule(store, "")
	h := newTestHandler(store, &fakeSender{})

	rec := doAs(t, h, http.MethodDelete, "/api/v1/alerts/"+rule.ID.String(), "", otherID, "user")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("foreign delete: %d", rec.Code)
	}
	rec = doAs(t, h, http.MethodDelete, "/api/v1/alerts/"+rule.ID.String(), "", ownerID, "user")
	if rec.Code != http.StatusNoContent || rec.Body.Len() != 0 {
		t.Fatalf("delete: %d %q", rec.Code, rec.Body.String())
	}
	if len(store.deleted) != 1 {
		t.Fatal("rule not deleted")
	}
}

func TestHistoryValidation(t *testing.T) {
	store := &fakeStore{}
	rule := seedRule(store, "")
	code := 200
	store.history = []History{{
		ID: uuid.New(), AlertRuleID: rule.ID, MetricValue: 7.5, Threshold: 5,
		Condition: "above", FiredAt: time.Date(2026, 5, 2, 8, 30, 0, 0, time.UTC),
		DeliveryStatus: "delivered", ResponseCode: &code,
		CreatedAt: time.Date(2026, 5, 2, 8, 30, 1, 0, time.UTC),
	}}
	h := newTestHandler(store, &fakeSender{})

	rec := doAs(t, h, http.MethodGet, "/api/v1/alerts/"+rule.ID.String()+"/history?limit=0", "", ownerID, "user")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("limit=0: %d", rec.Code)
	}
	rec = doAs(t, h, http.MethodGet, "/api/v1/alerts/"+rule.ID.String()+"/history?limit=201", "", ownerID, "user")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("limit=201: %d", rec.Code)
	}
	rec = doAs(t, h, http.MethodGet, "/api/v1/alerts/"+rule.ID.String()+"/history", "", otherID, "user")
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "Not authorized") {
		t.Fatalf("foreign history: %d", rec.Code)
	}
	rec = doAs(t, h, http.MethodGet, "/api/v1/alerts/"+rule.ID.String()+"/history", "", ownerID, "user")
	if rec.Code != http.StatusOK {
		t.Fatalf("history: %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"threshold":5.0`) || !strings.Contains(rec.Body.String(), `"fired_at":"2026-05-02T08:30:00Z"`) {
		t.Fatalf("wire shape: %s", rec.Body.String())
	}
}

func TestSecretRoutesOwnerScoped(t *testing.T) {
	store := &fakeStore{}
	rule := seedRule(store, "")
	h := newTestHandler(store, &fakeSender{})

	// The rule's owner manages their own secret without any deployment role.
	rec := doAs(t, h, http.MethodGet, "/api/v1/alerts/"+rule.ID.String()+"/webhook-secret", "", ownerID, "user")
	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if rec.Code != http.StatusOK || body["webhook_secret"] != rule.WebhookSecret {
		t.Fatalf("owner reveal: %d %v", rec.Code, body)
	}

	// A different plain user is rejected.
	for _, route := range []struct{ method, path string }{
		{http.MethodPost, "/api/v1/alerts/" + rule.ID.String() + "/webhook-secret/rotate"},
		{http.MethodGet, "/api/v1/alerts/" + rule.ID.String() + "/webhook-secret"},
	} {
		rec := doAs(t, h, route.method, route.path, "", otherID, "user")
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%s as non-owner: %d", route.path, rec.Code)
		}
	}

	// The deployment operator keeps an explicit, audited support override.
	rec = doAs(t, h, http.MethodGet, "/api/v1/alerts/"+rule.ID.String()+"/webhook-secret", "", otherID, "operator")
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if rec.Code != http.StatusOK || body["webhook_secret"] != rule.WebhookSecret {
		t.Fatalf("operator reveal: %d %v", rec.Code, body)
	}

	before := rule.WebhookSecret
	rec = doAs(t, h, http.MethodPost, "/api/v1/alerts/"+rule.ID.String()+"/webhook-secret/rotate", "", ownerID, "user")
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	last4, _ := body["webhook_secret_last4"].(string)
	if rec.Code != http.StatusOK || len(last4) != 4 || store.rules[rule.ID].WebhookSecret == before {
		t.Fatalf("owner rotate: %d %v", rec.Code, body)
	}
	if len(store.rules[rule.ID].WebhookSecret) != 64 {
		t.Fatalf("secret length: %d", len(store.rules[rule.ID].WebhookSecret))
	}
}

func TestWebhookTest(t *testing.T) {
	store := &fakeStore{}
	bare := seedRule(store, "")
	h := newTestHandler(store, &fakeSender{})

	rec := doAs(t, h, http.MethodPost, "/api/v1/alerts/"+bare.ID.String()+"/webhook/test", "", ownerID, "user")
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "No webhook URL configured") {
		t.Fatalf("no URL: %d %s", rec.Code, rec.Body.String())
	}

	code := 204
	sender := &fakeSender{result: DeliveryResult{Success: true, StatusCode: &code, Attempts: 1, DurationMS: 12}}
	wired := seedRule(store, "https://hooks.example.com/x")
	h = newTestHandler(store, sender)

	rec = doAs(t, h, http.MethodPost, "/api/v1/alerts/"+wired.ID.String()+"/webhook/test", "", otherID, "user")
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "Not authorized to test") {
		t.Fatalf("foreign test: %d", rec.Code)
	}

	rec = doAs(t, h, http.MethodPost, "/api/v1/alerts/"+wired.ID.String()+"/webhook/test", "", ownerID, "user")
	if rec.Code != http.StatusOK || sender.calls != 1 || sender.url != "https://hooks.example.com/x" {
		t.Fatalf("test delivery: %d calls=%d", rec.Code, sender.calls)
	}
	if !strings.Contains(rec.Body.String(), `"success":true`) || !strings.Contains(rec.Body.String(), `"duration_ms":12.0`) {
		t.Fatalf("wire: %s", rec.Body.String())
	}
}

func TestIsPrivateURL(t *testing.T) {
	ctx := context.Background()
	private := []string{
		"", "http://", "http://127.0.0.1/hook", "http://10.1.2.3/x", "http://172.16.0.9/x",
		"http://192.168.1.1/x", "http://169.254.169.254/latest", "http://metadata.google.internal/x",
		"http://[::1]/x", "http://[fe80::1]/x", "http://[fd00:ec2::254]/x", "http://[::ffff:10.0.0.1]/x",
		"http://100.64.3.4/x", "http://0.0.0.0/x", "http://224.0.0.5/x",
	}
	for _, u := range private {
		if !IsPrivateURL(ctx, u) {
			t.Errorf("%q should be private", u)
		}
	}
	public := []string{"https://8.8.8.8/hook", "http://[2606:4700::1111]/x", "http://[::ffff:8.8.8.8]/x"}
	for _, u := range public {
		if IsPrivateURL(ctx, u) {
			t.Errorf("%q should be public", u)
		}
	}
}

func TestDeliverRetriesAndSigning(t *testing.T) {
	var hits atomic.Int32
	var gotSig, gotTS, gotEvent string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotSig = r.Header.Get("X-Caracal-Signature")
		gotTS = r.Header.Get("X-Caracal-Timestamp")
		gotEvent = r.Header.Get("X-Caracal-Event-Id")
		if hits.Add(1) < 3 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	d := &Deliverer{sleep: func(time.Duration) {}, private: func(context.Context, string) bool { return false }}
	body := []byte(`{"test": true}`)
	result := d.Deliver(context.Background(), server.URL, "s3cret", body, uuid.New())
	if !result.Success || result.Attempts != 3 || *result.StatusCode != 200 {
		t.Fatalf("retry outcome: %+v", result)
	}
	if !strings.HasPrefix(gotSig, "sha256=") || gotTS == "" || gotEvent == "" {
		t.Fatalf("signing headers: sig=%q ts=%q event=%q", gotSig, gotTS, gotEvent)
	}
	ts, _ := strconv.ParseInt(gotTS, 10, 64)
	if gotSig != "sha256="+signPayload("s3cret", ts, body) {
		t.Fatal("signature does not verify")
	}
}

func TestDeliverStopsOn4xx(t *testing.T) {
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusForbidden)
	}))
	defer server.Close()

	d := &Deliverer{sleep: func(time.Duration) {}, private: func(context.Context, string) bool { return false }}
	result := d.Deliver(context.Background(), server.URL, "", []byte("{}"), uuid.New())
	if result.Success || hits.Load() != 1 || *result.Error != "HTTP 403" {
		t.Fatalf("4xx handling: %+v hits=%d", result, hits.Load())
	}
}

func TestDeliverBlocksPrivateTargets(t *testing.T) {
	d := &Deliverer{}
	result := d.Deliver(context.Background(), "http://127.0.0.1:1/hook", "", []byte("{}"), uuid.New())
	if result.Success || result.Attempts != 0 || !strings.Contains(*result.Error, "SSRF") {
		t.Fatalf("SSRF block: %+v", result)
	}
}
