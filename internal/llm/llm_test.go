// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package llm

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestNormalizeModelID(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"openai/gpt-4o", "openai/gpt-4o"},
		{"anthropic/claude-sonnet-4-5", "anthropic/claude-sonnet-4-5"},
		{"us.anthropic.claude-sonnet-4-5", "bedrock/us.anthropic.claude-sonnet-4-5"},
		{"eu.anthropic.claude-haiku", "bedrock/eu.anthropic.claude-haiku"},
		{"apac.anthropic.claude-haiku", "bedrock/apac.anthropic.claude-haiku"},
		{"kimi-k2", "openai/kimi-k2"},
		{"moonshot-v1", "openai/moonshot-v1"},
		{"gpt-4o", "gpt-4o"},
		{"", ""},
	}
	for _, tc := range cases {
		if got := NormalizeModelID(tc.in); got != tc.want {
			t.Errorf("NormalizeModelID(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestSplitProvider(t *testing.T) {
	cases := []struct {
		in, provider, bare string
	}{
		{"anthropic/claude-3", "anthropic", "claude-3"},
		{"bedrock/us.anthropic.claude", "bedrock", "us.anthropic.claude"},
		{"gpt-4o", "openai", "gpt-4o"},
		{"azure/dep/loyment", "azure", "dep/loyment"},
	}
	for _, tc := range cases {
		provider, bare := splitProvider(tc.in)
		if provider != tc.provider || bare != tc.bare {
			t.Errorf("splitProvider(%q) = (%q, %q), want (%q, %q)", tc.in, provider, bare, tc.provider, tc.bare)
		}
	}
}

func TestBaseOr(t *testing.T) {
	if got := baseOr(Config{}, "https://api.openai.com"); got != "https://api.openai.com" {
		t.Errorf("empty base: got %q", got)
	}
	if got := baseOr(Config{APIBase: "https://proxy.example.com/"}, "x"); got != "https://proxy.example.com" {
		t.Errorf("trailing slash not trimmed: got %q", got)
	}
}

// capture records the one request the provider under test sends.
type capture struct {
	path    string
	headers http.Header
	body    map[string]any
}

func providerServer(t *testing.T, status int, reply string) (*httptest.Server, *capture) {
	t.Helper()
	cap := &capture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cap.path = r.URL.RequestURI()
		cap.headers = r.Header.Clone()
		if err := json.NewDecoder(r.Body).Decode(&cap.body); err != nil {
			t.Errorf("request body is not JSON: %v", err)
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(reply))
	}))
	t.Cleanup(srv.Close)
	return srv, cap
}

func TestCompletionOpenAI(t *testing.T) {
	srv, cap := providerServer(t, http.StatusOK, "{}")
	ms, err := TestCompletion(context.Background(), Config{Model: "openai/gpt-4o", APIKey: "sk-test", APIBase: srv.URL})
	if err != nil {
		t.Fatalf("TestCompletion: %v", err)
	}
	if ms < 0 {
		t.Errorf("latency = %d, want >= 0", ms)
	}
	if cap.path != "/v1/chat/completions" {
		t.Errorf("path = %q", cap.path)
	}
	if got := cap.headers.Get("Authorization"); got != "Bearer sk-test" {
		t.Errorf("Authorization = %q", got)
	}
	if got := cap.body["model"]; got != "gpt-4o" {
		t.Errorf("model = %v, want bare id", got)
	}
}

func TestCompletionOpenAIRespectsV1Base(t *testing.T) {
	srv, cap := providerServer(t, http.StatusOK, "{}")
	_, err := TestCompletion(context.Background(), Config{Model: "gpt-4o", APIBase: srv.URL + "/v1"})
	if err != nil {
		t.Fatalf("TestCompletion: %v", err)
	}
	if cap.path != "/v1/chat/completions" {
		t.Errorf("path = %q, want single /v1 segment", cap.path)
	}
}

func TestCompletionAnthropic(t *testing.T) {
	srv, cap := providerServer(t, http.StatusOK, "{}")
	_, err := TestCompletion(context.Background(), Config{Model: "anthropic/claude-sonnet-4-5", APIKey: "ak", APIBase: srv.URL})
	if err != nil {
		t.Fatalf("TestCompletion: %v", err)
	}
	if cap.path != "/v1/messages" {
		t.Errorf("path = %q", cap.path)
	}
	if got := cap.headers.Get("x-api-key"); got != "ak" {
		t.Errorf("x-api-key = %q", got)
	}
	if got := cap.headers.Get("anthropic-version"); got == "" {
		t.Error("anthropic-version header missing")
	}
}

func TestCompletionGemini(t *testing.T) {
	srv, cap := providerServer(t, http.StatusOK, "{}")
	_, err := TestCompletion(context.Background(), Config{Model: "gemini/gemini-2.0-flash", APIKey: "gk", APIBase: srv.URL})
	if err != nil {
		t.Fatalf("TestCompletion: %v", err)
	}
	if want := "/v1beta/models/gemini-2.0-flash:generateContent"; cap.path != want {
		t.Errorf("path = %q, want %q", cap.path, want)
	}
	if got := cap.headers.Get("x-goog-api-key"); got != "gk" {
		t.Errorf("x-goog-api-key = %q", got)
	}
}

func TestCompletionAzure(t *testing.T) {
	srv, cap := providerServer(t, http.StatusOK, "{}")
	_, err := TestCompletion(context.Background(), Config{Model: "azure/my-deployment", APIKey: "azk", APIBase: srv.URL, APIVersion: "2024-06-01"})
	if err != nil {
		t.Fatalf("TestCompletion: %v", err)
	}
	if want := "/openai/deployments/my-deployment/chat/completions?api-version=2024-06-01"; cap.path != want {
		t.Errorf("path = %q, want %q", cap.path, want)
	}
	if got := cap.headers.Get("api-key"); got != "azk" {
		t.Errorf("api-key = %q", got)
	}
}

func TestCompletionAzureRequiresBase(t *testing.T) {
	_, err := TestCompletion(context.Background(), Config{Model: "azure/dep"})
	if err == nil || !strings.Contains(err.Error(), "Base URL") {
		t.Errorf("want base-URL error, got %v", err)
	}
}

func TestCompletionBedrock(t *testing.T) {
	t.Setenv("AWS_BEARER_TOKEN_BEDROCK", "")
	srv, cap := providerServer(t, http.StatusOK, "{}")
	_, err := TestCompletion(context.Background(), Config{Model: "bedrock/us.anthropic.claude", APIKey: "bk", APIBase: srv.URL})
	if err != nil {
		t.Fatalf("TestCompletion: %v", err)
	}
	if want := "/model/us.anthropic.claude/converse"; cap.path != want {
		t.Errorf("path = %q, want %q", cap.path, want)
	}
	if got := cap.headers.Get("Authorization"); got != "Bearer bk" {
		t.Errorf("Authorization = %q", got)
	}
}

func TestCompletionBedrockRequiresKey(t *testing.T) {
	t.Setenv("AWS_BEARER_TOKEN_BEDROCK", "")
	_, err := TestCompletion(context.Background(), Config{Model: "bedrock/us.anthropic.claude"})
	if err == nil || !strings.Contains(err.Error(), "API key") {
		t.Errorf("want missing-key error, got %v", err)
	}
}

func TestCompletionSurfacesProviderError(t *testing.T) {
	srv, _ := providerServer(t, http.StatusUnauthorized, `{"error":"bad key"}`)
	_, err := TestCompletion(context.Background(), Config{Model: "openai/gpt-4o", APIBase: srv.URL})
	if err == nil {
		t.Fatal("want error on 401")
	}
	for _, want := range []string{"401", "Unauthorized", "bad key"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q missing %q", err, want)
		}
	}
}

func TestCompletionHonorsTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Drain the body so the connection's background read can observe the
		// client disconnect and cancel this handler's context.
		_, _ = io.Copy(io.Discard, r.Body)
		<-r.Context().Done()
	}))
	t.Cleanup(srv.Close)
	start := time.Now()
	_, err := TestCompletion(context.Background(), Config{Model: "openai/gpt-4o", APIBase: srv.URL, Timeout: 50 * time.Millisecond})
	if err == nil {
		t.Fatal("want timeout error")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("timeout not honored: took %v", elapsed)
	}
}
