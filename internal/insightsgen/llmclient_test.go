// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

type fakeSettings map[string]string

func (f fakeSettings) String(_ context.Context, key, fallback string) string {
	if v, ok := f[key]; ok {
		return v
	}
	return fallback
}

func (f fakeSettings) Bool(_ context.Context, _ string, fallback bool) bool { return fallback }
func (f fakeSettings) Int(_ context.Context, _ string, fallback int) int    { return fallback }

func TestStripJSONFences(t *testing.T) {
	cases := map[string]string{
		"```json\n{\"a\": 1}\n```":        `{"a": 1}`,
		"prose\n```json\n{\"a\": 1}\n```": `{"a": 1}`,
		"```\n{\"b\": 2}\n```":            `{"b": 2}`,
		`{"c": 3}`:                        `{"c": 3}`,
	}
	for in, want := range cases {
		if got := StripJSONFences(in); got != want {
			t.Errorf("StripJSONFences(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSplitProviderInsights(t *testing.T) {
	if p, m := splitProvider("anthropic/claude-3"); p != "anthropic" || m != "claude-3" {
		t.Errorf("qualified: %s %s", p, m)
	}
	if p, m := splitProvider("gpt-4o"); p != "openai" || m != "gpt-4o" {
		t.Errorf("bare: %s %s", p, m)
	}
}

func TestRetryableCallError(t *testing.T) {
	retryable := []error{
		&httpStatusError{status: 408},
		&httpStatusError{status: 429},
		&httpStatusError{status: 500},
		&httpStatusError{status: 503},
		context.DeadlineExceeded,
	}
	for _, err := range retryable {
		if !retryableCallError(err) {
			t.Errorf("%v must be retryable", err)
		}
	}
	final := []error{
		&httpStatusError{status: 400},
		&httpStatusError{status: 401},
		&httpStatusError{status: 422},
	}
	for _, err := range final {
		if retryableCallError(err) {
			t.Errorf("%v must not be retryable", err)
		}
	}
}

func TestChatCompletionsURL(t *testing.T) {
	if got := chatCompletionsURL("https://api.example.com"); got != "https://api.example.com/v1/chat/completions" {
		t.Errorf("bare base: %q", got)
	}
	if got := chatCompletionsURL("https://proxy.example.com/v1/"); got != "https://proxy.example.com/v1/chat/completions" {
		t.Errorf("v1 base: %q", got)
	}
}

// completionServer returns an OpenAI-shaped completion with the given content.
func completionServer(t *testing.T, calls *atomic.Int64, status int, content string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"choices": [{"message": {"content": ` + strconv.Quote(content) + `}}]}`))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func testClient(base string) *Client {
	return &Client{
		Config:    &Config{Settings: fakeSettings{"insights.api_base": base, "insights.api_key": "k"}},
		retryWait: func(int) time.Duration { return 0 },
	}
}

func TestCompleteParsesModelJSON(t *testing.T) {
	var calls atomic.Int64
	srv := completionServer(t, &calls, 200, "```json\n{\"insight\": \"use skills\"}\n```")
	out, err := testClient(srv.URL).Complete(context.Background(), "prompt", "openai/gpt-5", 512)
	if err != nil {
		t.Fatal(err)
	}
	if out["insight"] != "use skills" {
		t.Errorf("parsed: %v", out)
	}
	if calls.Load() != 1 {
		t.Errorf("calls = %d", calls.Load())
	}
}

func TestCompleteDegradesOnUnparseableContent(t *testing.T) {
	var calls atomic.Int64
	srv := completionServer(t, &calls, 200, "I refuse to answer in JSON.")
	out, err := testClient(srv.URL).Complete(context.Background(), "prompt", "gpt-5", 512)
	if err != nil {
		t.Fatal(err)
	}
	// One bad response degrades a single section, never the whole report.
	if len(out) != 0 {
		t.Errorf("want empty object, got %v", out)
	}
}

func TestCompleteDoesNotRetryFinalRejections(t *testing.T) {
	var calls atomic.Int64
	srv := completionServer(t, &calls, 401, "")
	_, err := testClient(srv.URL).Complete(context.Background(), "prompt", "gpt-5", 512)
	if err == nil {
		t.Fatal("want error on 401")
	}
	if calls.Load() != 1 {
		t.Errorf("401 must not retry: %d calls", calls.Load())
	}
}

func TestCompleteRetriesTransientFailures(t *testing.T) {
	var calls atomic.Int64
	srv := completionServer(t, &calls, 503, "")
	_, err := testClient(srv.URL).Complete(context.Background(), "prompt", "gpt-5", 512)
	if err == nil {
		t.Fatal("want error after exhausted retries")
	}
	if calls.Load() != 3 {
		t.Errorf("want initial call plus two retries, got %d", calls.Load())
	}
}

func TestCompleteSendsAuthAndPayload(t *testing.T) {
	var gotAuth string
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		buf := make([]byte, 1<<16)
		n, _ := r.Body.Read(buf)
		gotBody = buf[:n]
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices": [{"message": {"content": "{}"}}]}`))
	}))
	t.Cleanup(srv.Close)
	if _, err := testClient(srv.URL).Complete(context.Background(), "the prompt", "gpt-5", 256); err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer k" {
		t.Errorf("Authorization = %q", gotAuth)
	}
	for _, frag := range []string{`"model":"gpt-5"`, `"the prompt"`} {
		if !contains(string(gotBody), frag) {
			t.Errorf("request body missing %s:\n%s", frag, gotBody)
		}
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
