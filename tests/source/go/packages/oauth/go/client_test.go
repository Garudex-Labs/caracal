// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// OAuth Go client tests for cache isolation and STS response validation.

package oauth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestExchangeDoesNotShareCacheAcrossClientSecrets(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]any{
			"access_token": "token-" + r.Form.Get("client_secret"),
			"token_type":   "Bearer",
			"expires_in":   3600,
		}); err != nil {
			t.Fatal(err)
		}
	}))
	defer server.Close()

	client := NewClient(server.URL, "zone1", "app1", nil)
	first, err := client.Exchange(context.Background(), "subject", "resource://api", ExchangeOptions{ClientSecret: "a"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := client.Exchange(context.Background(), "subject", "resource://api", ExchangeOptions{ClientSecret: "b"})
	if err != nil {
		t.Fatal(err)
	}
	third, err := client.Exchange(context.Background(), "subject", "resource://api", ExchangeOptions{ClientSecret: "a"})
	if err != nil {
		t.Fatal(err)
	}

	if first.AccessToken != "token-a" || second.AccessToken != "token-b" || third.AccessToken != "token-a" {
		t.Fatalf("unexpected tokens: %q %q %q", first.AccessToken, second.AccessToken, third.AccessToken)
	}
	if requests != 2 {
		t.Fatalf("expected 2 STS requests, got %d", requests)
	}
}

func TestOneShotExchangeBypassesCacheAndInflight(t *testing.T) {
	var mu sync.Mutex
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		calls++
		token := fmt.Sprintf("token-%d", calls)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"access_token":%q,"token_type":"Bearer","expires_in":900}`, token)
	}))
	defer server.Close()
	client := NewClient(server.URL, "zone", "app", nil)
	var wg sync.WaitGroup
	tokens := make([]string, 2)
	for i := range tokens {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			out, err := client.Exchange(context.Background(), "", "resource://pipernet", ExchangeOptions{ClientSecret: "secret", Scopes: []string{"read"}, OneShot: true})
			if err != nil {
				t.Error(err)
				return
			}
			tokens[i] = out.AccessToken
		}(i)
	}
	wg.Wait()
	if tokens[0] == tokens[1] || calls != 2 {
		t.Fatalf("expected two distinct one-shot exchanges, tokens=%v calls=%d", tokens, calls)
	}
}

func TestExchangeResourcesOmitsSubjectTokenForApplicationPrincipal(t *testing.T) {
	var gotResources []string
	var gotSubject string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		gotResources = r.Form["resource"]
		gotSubject = r.Form.Get("subject_token")
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]any{
			"access_token": "token-app",
			"token_type":   "Bearer",
			"expires_in":   3600,
		}); err != nil {
			t.Fatal(err)
		}
	}))
	defer server.Close()

	client := NewClient(server.URL, "zone1", "app1", nil)
	token, err := client.ExchangeResources(context.Background(), "", []string{"resource://a", "resource://b"}, ExchangeOptions{ClientSecret: "secret"})
	if err != nil {
		t.Fatal(err)
	}
	if token.AccessToken != "token-app" {
		t.Fatalf("expected token-app, got %q", token.AccessToken)
	}
	if gotSubject != "" {
		t.Fatalf("expected no subject_token, got %q", gotSubject)
	}
	if len(gotResources) != 2 || gotResources[0] != "resource://a" || gotResources[1] != "resource://b" {
		t.Fatalf("unexpected resources: %#v", gotResources)
	}
}

func TestExchangeRejectsMalformedSuccessResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"access_token":"","token_type":"Bearer","expires_in":3600}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "zone1", "app1", nil)
	if _, err := client.Exchange(context.Background(), "subject", "resource://api", ExchangeOptions{}); err == nil {
		t.Fatal("expected malformed response error")
	}
}

func TestExchangeReturnsApprovalRequiredError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		w.Write([]byte(`{"error":"interaction_required","error_description":"step up","challenge_id":"challenge1","acr_values":"urn:mfa"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "zone1", "app1", nil)
	_, err := client.Exchange(context.Background(), "subject", "resource://api", ExchangeOptions{})
	var interaction *ApprovalRequiredError
	if !errors.As(err, &interaction) {
		t.Fatalf("expected ApprovalRequiredError, got %T", err)
	}
	if interaction.ApprovalID != "challenge1" || interaction.Resource != "resource://api" {
		t.Fatalf("unexpected interaction error: %+v", interaction)
	}
}

func TestExchangeRetriesOnceAfterUnauthorized(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.Header().Set("Content-Type", "application/json")
		if requests == 1 {
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(`{"error_description":"expired client credential"}`))
			return
		}
		w.Write([]byte(`{"access_token":"fresh","token_type":"Bearer","expires_in":3600}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "zone1", "app1", nil)
	token, err := client.Exchange(context.Background(), "subject", "resource://api", ExchangeOptions{Retries: 0})
	if err != nil {
		t.Fatal(err)
	}
	if token.AccessToken != "fresh" || requests != 2 {
		t.Fatalf("expected one 401 retry and fresh token, got token=%q requests=%d", token.AccessToken, requests)
	}
}

func TestExchangeSendsSortedScopesTTLAndOptionalAuthority(t *testing.T) {
	var form url.Values
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		form = r.Form
		w.Header().Set("Content-Type", "application/scim+json")
		w.Write([]byte(`{"access_token":"token","expires_in":3600}`))
	}))
	defer server.Close()

	client := NewClient(server.URL+"/", "zone1", "app1", nil)
	token, err := client.ExchangeResources(context.Background(), "subject", []string{" resource://b ", "", "resource://a"}, ExchangeOptions{
		ClientAssertion:     "assertion",
		ClientAssertionType: "urn:jwt",
		SessionID:           "sid",
		AgentSessionID:      "agent",
		DelegationEdgeID:    "edge",
		Scopes:              []string{"write", "read", "write"},
		TTLSeconds:          300,
	})
	if err != nil {
		t.Fatal(err)
	}
	if token.AccessToken != "token" {
		t.Fatalf("unexpected token: %+v", token)
	}
	if got := form["resource"]; len(got) != 2 || got[0] != "resource://b" || got[1] != "resource://a" {
		t.Fatalf("unexpected resources: %#v", got)
	}
	if form.Get("scope") != "read write" || form.Get("ttl_seconds") != "300" || form.Get("agent_session_id") != "agent" {
		t.Fatalf("unexpected form: %#v", form)
	}
	if _, present := form["actor_token"]; present {
		t.Fatal("actor_token must never be sent")
	}
}

func TestExchangeConcurrentRequestsShareInflightResult(t *testing.T) {
	var requests atomic.Int32
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		<-release
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"access_token":"shared","token_type":"Bearer","expires_in":3600}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "zone1", "app1", nil)
	var wg sync.WaitGroup
	results := make([]TokenExchangeResponse, 2)
	errs := make([]error, 2)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = client.Exchange(context.Background(), "subject", "resource://api", ExchangeOptions{})
		}(i)
	}
	for requests.Load() == 0 {
		time.Sleep(time.Millisecond)
	}
	close(release)
	wg.Wait()

	for _, err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if requests.Load() != 1 || results[0].AccessToken != "shared" || results[1].AccessToken != "shared" {
		t.Fatalf("inflight sharing failed: requests=%d results=%+v", requests.Load(), results)
	}
}

func TestExchangeWaitingInflightHonorsCallerCancellation(t *testing.T) {
	var requests atomic.Int32
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		<-release
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"access_token":"shared","token_type":"Bearer","expires_in":3600}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "zone1", "app1", nil)
	firstDone := make(chan error, 1)
	go func() {
		_, err := client.Exchange(context.Background(), "subject", "resource://api", ExchangeOptions{})
		firstDone <- err
	}()
	for requests.Load() == 0 {
		time.Sleep(time.Millisecond)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := client.Exchange(ctx, "subject", "resource://api", ExchangeOptions{})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected canceled waiter, got %v", err)
	}
	close(release)
	if err := <-firstDone; err != nil {
		t.Fatal(err)
	}
}

func TestExchangeRetriesTransientResponsesAndHTTPFailures(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		w.Header().Set("Content-Type", "application/json")
		if requests == 1 {
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(http.StatusTooManyRequests)
			w.Write([]byte(`{"error_description":"slow"}`))
			return
		}
		w.Write([]byte(`{"access_token":"fresh","token_type":"Bearer","expires_in":3600}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "zone1", "app1", nil)
	token, err := client.Exchange(context.Background(), "subject", "resource://api", ExchangeOptions{Retries: 1, TimeoutMillis: 1000})
	if err != nil {
		t.Fatal(err)
	}
	if token.AccessToken != "fresh" || requests != 2 {
		t.Fatalf("expected retry success, token=%+v requests=%d", token, requests)
	}
}

func TestExchangeErrorAndResponseValidationPaths(t *testing.T) {
	tests := []struct {
		name    string
		handler http.HandlerFunc
		want    string
	}{
		{name: "invalid error json", want: "invalid error response", handler: func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{`))
		}},
		{name: "status fallback", want: "STS error 400", handler: func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{}`))
		}},
		{name: "non json success", want: "expected application/json", handler: func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/plain")
			w.Write([]byte(`ok`))
		}},
		{name: "bad success json", want: "unexpected EOF", handler: func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{`))
		}},
		{name: "bad token type", want: "token_type must be Bearer", handler: func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"access_token":"t","token_type":"MAC","expires_in":1}`))
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(tt.handler)
			defer server.Close()
			client := NewClient(server.URL, "zone1", "app1", nil)
			_, err := client.Exchange(context.Background(), "subject", "resource://api", ExchangeOptions{Retries: 1})
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("expected %q, got %v", tt.want, err)
			}
		})
	}
}

func TestExchangeTimeoutAndRequestBuildErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(20 * time.Millisecond)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"access_token":"t","expires_in":1}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "zone1", "app1", nil)
	if _, err := client.Exchange(context.Background(), "subject", "resource://api", ExchangeOptions{TimeoutMillis: 1}); err == nil {
		t.Fatalf("expected timeout, got %v", err)
	}
	badClient := NewClient("://bad", "zone1", "app1", nil)
	if _, err := badClient.Exchange(context.Background(), "subject", "resource://api", ExchangeOptions{}); err == nil {
		t.Fatal("expected request build error")
	}
}

func TestInMemoryTokenCacheBoundaries(t *testing.T) {
	if _, err := NewInMemoryTokenCache(0); err == nil {
		t.Fatal("expected invalid cache size error")
	}
	panicked := false
	func() {
		defer func() {
			if recover() != nil {
				panicked = true
			}
		}()
		MustInMemoryTokenCache(0)
	}()
	if !panicked {
		t.Fatal("expected MustInMemoryTokenCache panic")
	}

	cache := MustInMemoryTokenCache(1)
	expired := TokenExchangeResponse{AccessToken: "expired", ExpiresIn: 1, IssuedAt: time.Now().Add(-time.Hour).Unix()}
	freshA := TokenExchangeResponse{AccessToken: "a", ExpiresIn: 3600, IssuedAt: time.Now().Unix()}
	freshB := TokenExchangeResponse{AccessToken: "b", ExpiresIn: 3600, IssuedAt: time.Now().Unix()}
	cache.Set("subject", "resource://expired", expired)
	if _, ok := cache.Get("subject", "resource://expired"); ok {
		t.Fatal("expired cache entry should miss")
	}
	cache.Set("subject", "resource://a", freshA)
	cache.Set("subject", "resource://b", freshB)
	if _, ok := cache.Get("subject", "resource://a"); ok {
		t.Fatal("oldest entry should be evicted")
	}
	if got, ok := cache.Get("subject", "resource://b"); !ok || got.AccessToken != "b" {
		t.Fatalf("fresh entry missing: %+v %v", got, ok)
	}
	if key := cacheKey("subject", "resource://b"); key == "" || key == fmt.Sprintf("%x", []byte("subject")) {
		t.Fatalf("unexpected cache key: %q", key)
	}
}

func TestExchangeReturnsTypedCaracalError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		w.Write([]byte(`{"error":"access_denied","error_description":"Denied","requestId":"req-2"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "zone1", "app1", nil)
	_, err := client.Exchange(context.Background(), "subject", "resource://api", ExchangeOptions{})
	var caracalErr *CaracalError
	if !errors.As(err, &caracalErr) {
		t.Fatalf("expected CaracalError, got %T", err)
	}
	if caracalErr.Code != "access_denied" || caracalErr.RequestID != "req-2" || caracalErr.HTTPStatus != http.StatusForbidden {
		t.Fatalf("unexpected typed error: %+v", caracalErr)
	}
	if !strings.Contains(err.Error(), "request_id=req-2") {
		t.Fatalf("expected request id in message, got %q", err.Error())
	}
}

func TestExchangeEmitsEventsForFreshCachedAndFailedExchanges(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		w.Header().Set("Content-Type", "application/json")
		if requests > 1 {
			w.WriteHeader(http.StatusForbidden)
			w.Write([]byte(`{"error":"access_denied","error_description":"Denied"}`))
			return
		}
		w.Write([]byte(`{"access_token":"tok","token_type":"Bearer","expires_in":3600}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "zone1", "app1", nil)
	var events []Event
	client.OnEvent = func(event Event) {
		events = append(events, event)
		panic("sink failure")
	}

	if _, err := client.Exchange(context.Background(), "subject-a", "resource://api", ExchangeOptions{Scopes: []string{"write", "read"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Exchange(context.Background(), "subject-a", "resource://api", ExchangeOptions{Scopes: []string{"read", "write"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Exchange(context.Background(), "subject-b", "resource://api", ExchangeOptions{}); err == nil {
		t.Fatal("expected denial")
	}

	if len(events) != 3 {
		t.Fatalf("expected 3 events, got %d", len(events))
	}
	if events[0].Type != "token.exchange" || !events[0].Ok || events[0].Cached {
		t.Fatalf("unexpected fresh event: %+v", events[0])
	}
	if len(events[0].Resources) != 1 || events[0].Resources[0] != "resource://api" {
		t.Fatalf("unexpected resources: %+v", events[0].Resources)
	}
	if len(events[0].Scopes) != 2 || events[0].Scopes[0] != "read" || events[0].Scopes[1] != "write" {
		t.Fatalf("unexpected scopes: %+v", events[0].Scopes)
	}
	if !events[1].Cached || !events[1].Ok {
		t.Fatalf("expected cached hit event: %+v", events[1])
	}
	if events[2].Ok || events[2].Code != "access_denied" || events[2].Status != http.StatusForbidden {
		t.Fatalf("unexpected failure event: %+v", events[2])
	}
}

func TestWaitForApprovalEmitsEvent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"state":"approved"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "zone1", "app1", nil)
	var events []Event
	client.OnEvent = func(event Event) { events = append(events, event) }

	state, err := client.WaitForApproval(context.Background(), "chal-1", 5*time.Second)
	if err != nil || state != "approved" {
		t.Fatalf("unexpected result: %q %v", state, err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].Type != "approval.wait" || !events[0].Ok || events[0].ApprovalID != "chal-1" || events[0].State != "approved" {
		t.Fatalf("unexpected approval event: %+v", events[0])
	}
}

func TestFederateSubjectPostsIDTokenType(t *testing.T) {
	var gotForm map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		gotForm = map[string]string{
			"subject_token":      r.Form.Get("subject_token"),
			"subject_token_type": r.Form.Get("subject_token_type"),
			"resource":           r.Form.Get("resource"),
			"client_secret":      r.Form.Get("client_secret"),
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]any{
			"access_token": "user-session-token",
			"token_type":   "Bearer",
			"expires_in":   3600,
		}); err != nil {
			t.Fatal(err)
		}
	}))
	defer server.Close()

	client := NewClient(server.URL, "zone1", "app1", nil)
	token, err := client.FederateSubject(context.Background(), "external-id-token", FederateSubjectOptions{ClientSecret: "secret"})
	if err != nil {
		t.Fatal(err)
	}
	if token.AccessToken != "user-session-token" {
		t.Fatalf("expected user-session-token, got %q", token.AccessToken)
	}
	if gotForm["subject_token_type"] != "urn:ietf:params:oauth:token-type:id_token" {
		t.Fatalf("expected id_token type, got %q", gotForm["subject_token_type"])
	}
	if gotForm["resource"] != "" {
		t.Fatalf("federation must not name resources, got %q", gotForm["resource"])
	}
	if gotForm["subject_token"] != "external-id-token" || gotForm["client_secret"] != "secret" {
		t.Fatalf("unexpected form: %#v", gotForm)
	}
	if _, err := client.FederateSubject(context.Background(), "", FederateSubjectOptions{}); err == nil {
		t.Fatal("empty id token must be rejected")
	}
}

func TestDecideApprovalPostsBearerDecision(t *testing.T) {
	var gotAuth, gotPath string
	var gotBody map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatal(err)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client := NewClient(server.URL, "zone1", "app1", nil)
	err := client.DecideApproval(context.Background(), DecideApprovalInput{
		SubjectToken: "user-session-token",
		ApprovalID:   "ch-1",
		Binding:      "abcd",
		Decision:     "approved",
		Reason:       "refund reviewed",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer user-session-token" || gotPath != "/step-up/ch-1/decision" {
		t.Fatalf("unexpected request: auth=%q path=%q", gotAuth, gotPath)
	}
	if gotBody["decision"] != "approved" || gotBody["binding"] != "abcd" || gotBody["reason"] != "refund reviewed" {
		t.Fatalf("unexpected body: %#v", gotBody)
	}
	if err := client.DecideApproval(context.Background(), DecideApprovalInput{ApprovalID: "ch-1"}); err == nil {
		t.Fatal("missing subject token must be rejected")
	}
}

func TestCaracalErrorRetryableHintsTransportFailuresOnly(t *testing.T) {
	cases := []struct {
		err  CaracalError
		want bool
	}{
		{CaracalError{Code: "sts_unavailable"}, true},
		{CaracalError{HTTPStatus: 429}, true},
		{CaracalError{HTTPStatus: 502}, true},
		{CaracalError{Code: "access_denied", HTTPStatus: 403}, false},
		{CaracalError{Code: "invalid_request", HTTPStatus: 400}, false},
	}
	for _, tc := range cases {
		if got := tc.err.Retryable(); got != tc.want {
			t.Fatalf("Retryable(%+v) = %v, want %v", tc.err, got, tc.want)
		}
	}
}
