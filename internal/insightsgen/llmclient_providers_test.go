// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// providerClient points every provider base at one test server.
func providerClient(base string) *Client {
	return &Client{
		Config: &Config{Settings: fakeSettings{
			"insights.api_base": base,
			"insights.api_key":  "k",
		}},
		retryWait: func(int) time.Duration { return 0 },
	}
}

func TestAnthropicCompleteParsesTextBlocks(t *testing.T) {
	var gotPath, gotKey, gotVersion string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotKey = r.Header.Get("x-api-key")
		gotVersion = r.Header.Get("anthropic-version")
		w.Header().Set("Content-Type", "application/json")
		// Two text blocks plus a non-text block that must be ignored.
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"{\"a\":"},{"type":"tool_use"},{"type":"text","text":"1}"}]}`))
	}))
	defer srv.Close()

	out, err := providerClient(srv.URL).Complete(context.Background(), "prompt", "anthropic/claude-3", 256)
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if out["a"] != float64(1) {
		t.Errorf("concatenated text should parse to {a:1}, got %v", out)
	}
	if gotPath != "/v1/messages" {
		t.Errorf("path = %q, want /v1/messages", gotPath)
	}
	if gotKey != "k" || gotVersion != "2023-06-01" {
		t.Errorf("headers key=%q version=%q", gotKey, gotVersion)
	}
}

func TestGeminiCompleteParsesCandidateParts(t *testing.T) {
	var gotPath, gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotKey = r.Header.Get("x-goog-api-key")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"candidates":[{"content":{"parts":[{"text":"{\"g\":"},{"text":"true}"}]}}]}`))
	}))
	defer srv.Close()

	out, err := providerClient(srv.URL).Complete(context.Background(), "prompt", "gemini/gemini-1.5", 256)
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if out["g"] != true {
		t.Errorf("parsed parts should yield {g:true}, got %v", out)
	}
	if !strings.HasSuffix(gotPath, ":generateContent") {
		t.Errorf("path = %q, want a generateContent call", gotPath)
	}
	if gotKey != "k" {
		t.Errorf("api key header = %q", gotKey)
	}
}

func TestGeminiCompleteNoCandidatesIsEmpty(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"candidates":[]}`))
	}))
	defer srv.Close()
	// An empty candidate list yields an empty completion, which Complete
	// treats as a degraded-but-successful empty object.
	out, err := providerClient(srv.URL).Complete(context.Background(), "prompt", "gemini/g", 64)
	if err != nil || len(out) != 0 {
		t.Fatalf("out=%v err=%v, want empty object", out, err)
	}
}

func TestAzureCompleteUsesDeploymentURL(t *testing.T) {
	var gotPath, gotKey, gotVersion string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotKey = r.Header.Get("api-key")
		gotVersion = r.URL.Query().Get("api-version")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"z\":1}"}}]}`))
	}))
	defer srv.Close()

	out, err := providerClient(srv.URL).Complete(context.Background(), "prompt", "azure/mydeploy", 256)
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if out["z"] != float64(1) {
		t.Errorf("azure completion parsed = %v", out)
	}
	if gotPath != "/openai/deployments/mydeploy/chat/completions" {
		t.Errorf("path = %q", gotPath)
	}
	if gotKey != "k" || gotVersion == "" {
		t.Errorf("api-key=%q api-version=%q", gotKey, gotVersion)
	}
}

func TestAzureCompleteRequiresApiBase(t *testing.T) {
	c := &Client{
		Config:    &Config{Settings: fakeSettings{"insights.api_key": "k"}},
		retryWait: func(int) time.Duration { return 0 },
	}
	_, err := c.Complete(context.Background(), "prompt", "azure/mydeploy", 64)
	if err == nil || !strings.Contains(err.Error(), "api_base") {
		t.Fatalf("want api_base error, got %v", err)
	}
}
