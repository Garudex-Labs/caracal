// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

// isolateHome points config.Dir() at a scratch directory and clears the
// credential environment so New/refresh flows never read the real profile.
func isolateHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	for _, name := range []string{
		"CARACAL_SERVER_URL", "CARACAL_ACCESS_TOKEN", "CARACAL_ACCESS_TOKEN_FILE",
		"CARACAL_API_KEY", "CARACAL_TOKEN",
	} {
		t.Setenv(name, "")
		os.Unsetenv(name)
	}
	return home
}

func writeConfig(t *testing.T, home string, data map[string]any) {
	t.Helper()
	dir := filepath.Join(home, ".caracal")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	blob, _ := json.Marshal(data)
	if err := os.WriteFile(filepath.Join(dir, "config.json"), blob, 0o600); err != nil {
		t.Fatal(err)
	}
}

func testClient(url string) *Client {
	return &Client{BaseURL: url, Token: "tok", CLIVersion: "1.0.0", Timeout: 5 * time.Second}
}

func TestNew(t *testing.T) {
	t.Run("unconfigured returns auth error", func(t *testing.T) {
		isolateHome(t)
		_, cerr := New("1.0.0")
		if cerr == nil || cerr.Category != clierr.Auth {
			t.Fatalf("want auth error, got %v", cerr)
		}
	})
	t.Run("configured from env", func(t *testing.T) {
		isolateHome(t)
		t.Setenv("CARACAL_SERVER_URL", "https://example.test/")
		t.Setenv("CARACAL_ACCESS_TOKEN", "secret")
		c, cerr := New("2.0.0")
		if cerr != nil {
			t.Fatalf("unexpected error: %v", cerr)
		}
		if c.BaseURL != "https://example.test" {
			t.Errorf("trailing slash not trimmed: %q", c.BaseURL)
		}
		if c.Token != "secret" || c.CLIVersion != "2.0.0" {
			t.Errorf("client fields = %+v", c)
		}
		if c.Timeout != 30*time.Second {
			t.Errorf("default timeout = %v", c.Timeout)
		}
	})
	t.Run("session token mints tenant token", func(t *testing.T) {
		home := isolateHome(t)
		var gotAuth string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/api/auth/tenant-token" {
				t.Fatalf("path = %s", r.URL.Path)
			}
			gotAuth = r.Header.Get("Authorization")
			_, _ = w.Write([]byte(`{"token":"fresh-jwt"}`))
		}))
		defer srv.Close()
		writeConfig(t, home, map[string]any{"server_url": srv.URL, "session_token": "cli-session", "access_token": "stale-jwt"})
		c, cerr := New("2.0.0")
		if cerr != nil {
			t.Fatalf("unexpected error: %v", cerr)
		}
		if gotAuth != "Bearer cli-session" {
			t.Fatalf("tenant-token auth = %q", gotAuth)
		}
		if c.Token != "fresh-jwt" {
			t.Fatalf("client token = %q", c.Token)
		}
	})
	t.Run("revoked session blocks client", func(t *testing.T) {
		home := isolateHome(t)
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, `{"detail":"revoked"}`, http.StatusUnauthorized)
		}))
		defer srv.Close()
		writeConfig(t, home, map[string]any{"server_url": srv.URL, "session_token": "revoked", "access_token": "still-valid"})
		_, cerr := New("2.0.0")
		if cerr == nil || cerr.Category != clierr.Auth {
			t.Fatalf("want auth error, got %v", cerr)
		}
	})
	t.Run("conflicting secret sources fail", func(t *testing.T) {
		home := isolateHome(t)
		secret := filepath.Join(home, "tok")
		if err := os.WriteFile(secret, []byte("v"), 0o600); err != nil {
			t.Fatal(err)
		}
		t.Setenv("CARACAL_SERVER_URL", "https://example.test")
		t.Setenv("CARACAL_ACCESS_TOKEN", "direct")
		t.Setenv("CARACAL_ACCESS_TOKEN_FILE", secret)
		if _, cerr := New("1.0.0"); cerr == nil {
			t.Fatal("want validation error for conflicting token sources")
		}
	})
}

func TestEnforceVersion(t *testing.T) {
	t.Run("exempt subcommands skip", func(t *testing.T) {
		c := testClient("http://127.0.0.1:0")
		if cerr := c.EnforceVersion("self"); cerr != nil {
			t.Fatalf("self exempt: %v", cerr)
		}
		c.versionChecked = false
		if cerr := c.EnforceVersion("server"); cerr != nil {
			t.Fatalf("server exempt: %v", cerr)
		}
	})
	t.Run("dev cli skips", func(t *testing.T) {
		c := testClient("http://127.0.0.1:0")
		c.CLIVersion = "0.0.0"
		if cerr := c.EnforceVersion("pull"); cerr != nil {
			t.Fatalf("dev cli: %v", cerr)
		}
	})
	t.Run("matching version passes", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"server_version":"1.0.0"}`))
		}))
		defer srv.Close()
		c := testClient(srv.URL)
		if cerr := c.EnforceVersion("pull"); cerr != nil {
			t.Fatalf("matching version: %v", cerr)
		}
	})
	t.Run("dev server skips", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"server_version":"dev"}`))
		}))
		defer srv.Close()
		c := testClient(srv.URL)
		if cerr := c.EnforceVersion("pull"); cerr != nil {
			t.Fatalf("dev server: %v", cerr)
		}
	})
	t.Run("mismatch reports version error", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"server_version":"9.9.9"}`))
		}))
		defer srv.Close()
		c := testClient(srv.URL)
		cerr := c.EnforceVersion("pull")
		if cerr == nil || cerr.Category != clierr.Version {
			t.Fatalf("want version mismatch, got %v", cerr)
		}
	})
	t.Run("unreachable server is best effort", func(t *testing.T) {
		c := testClient("http://127.0.0.1:1")
		if cerr := c.EnforceVersion("pull"); cerr != nil {
			t.Fatalf("unreachable should not fail: %v", cerr)
		}
	})
	t.Run("second call is a no-op", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"server_version":"9.9.9"}`))
		}))
		defer srv.Close()
		c := testClient(srv.URL)
		_ = c.EnforceVersion("pull")
		if cerr := c.EnforceVersion("pull"); cerr != nil {
			t.Fatalf("second call must be cached no-op: %v", cerr)
		}
	})
}

func TestRequestSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer tok" {
			t.Errorf("auth header = %q", got)
		}
		if r.URL.Query().Get("limit") != "10" {
			t.Errorf("param not forwarded: %q", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	c := testClient(srv.URL)
	got, cerr := c.Request(http.MethodGet, "/api/v1/thing", map[string]string{"limit": "10"}, nil)
	if cerr != nil {
		t.Fatalf("unexpected error: %v", cerr)
	}
	m, ok := got.(map[string]any)
	if !ok || m["ok"] != true {
		t.Fatalf("decoded = %#v", got)
	}
}

func TestRequestEmptyBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	c := testClient(srv.URL)
	got, cerr := c.Request(http.MethodDelete, "/api/v1/thing/1", nil, nil)
	if cerr != nil || got != nil {
		t.Fatalf("empty body should decode to nil,nil: got=%v err=%v", got, cerr)
	}
}

func TestRequestInvalidJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`not json at all`))
	}))
	defer srv.Close()
	c := testClient(srv.URL)
	_, cerr := c.Request(http.MethodGet, "/x", nil, nil)
	if cerr == nil || cerr.Category != clierr.Unexpected {
		t.Fatalf("want unexpected JSON error, got %v", cerr)
	}
}

func TestRequestBodyMarshalError(t *testing.T) {
	c := testClient("http://127.0.0.1:0")
	_, cerr := c.Request(http.MethodPost, "/x", nil, make(chan int))
	if cerr == nil || cerr.Category != clierr.Validation {
		t.Fatalf("want validation error for unencodable body, got %v", cerr)
	}
}

func TestRequestPostBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("missing content-type on POST")
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["name"] != "widget" {
			t.Errorf("body not forwarded: %#v", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"7"}`))
	}))
	defer srv.Close()
	c := testClient(srv.URL)
	got, cerr := c.Request(http.MethodPost, "/api/v1/widgets", nil, map[string]any{"name": "widget"})
	if cerr != nil {
		t.Fatalf("unexpected error: %v", cerr)
	}
	if got.(map[string]any)["id"] != "7" {
		t.Fatalf("decoded = %#v", got)
	}
}

func TestStatusErrors(t *testing.T) {
	cases := []struct {
		name       string
		status     int
		path       string
		headers    map[string]string
		body       string
		wantCat    clierr.Category
		wantRemedy string
	}{
		{"unauthorized", 401, "/api/v1/agents", nil, "", clierr.Auth, ""},
		{"forbidden", 403, "/api/v1/agents", nil, "", clierr.Permission, ""},
		{"not found agent", 404, "/api/v1/agents/x", nil, "", clierr.NotFound, "caracal agent list"},
		{"not found mcp", 404, "/api/v1/mcps/x", nil, "", clierr.NotFound, "caracal registry mcp list"},
		{"conflict", 409, "/api/v1/agents", nil, "", clierr.Conflict, ""},
		{"upgrade", 426, "/api/v1/agents", nil, "", clierr.Version, ""},
		{"rate limit", 429, "/api/v1/agents", map[string]string{"Retry-After": "12"}, "", clierr.RateLimit, "12"},
		{"server error", 500, "/api/v1/agents", nil, "", clierr.Unavailable, "caracal doctor"},
		{"validation default", 400, "/api/v1/agents", nil, "", clierr.Validation, ""},
		{"detail passthrough", 403, "/api/v1/agents", map[string]string{"Content-Type": "application/json"}, `{"detail":"nope"}`, clierr.Permission, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				for k, v := range tc.headers {
					w.Header().Set(k, v)
				}
				w.WriteHeader(tc.status)
				if tc.body != "" {
					_, _ = w.Write([]byte(tc.body))
				}
			}))
			defer srv.Close()
			c := testClient(srv.URL)
			// POST avoids the GET transient-retry loop for 429.
			_, cerr := c.Request(http.MethodPost, tc.path, nil, nil)
			if cerr == nil {
				t.Fatalf("want error for status %d", tc.status)
			}
			if cerr.Category != tc.wantCat {
				t.Errorf("category = %q want %q", cerr.Category, tc.wantCat)
			}
			if cerr.HTTPStatus != tc.status {
				t.Errorf("http status = %d want %d", cerr.HTTPStatus, tc.status)
			}
			if tc.wantRemedy != "" && !strings.Contains(cerr.Remediation, tc.wantRemedy) {
				t.Errorf("remediation %q missing %q", cerr.Remediation, tc.wantRemedy)
			}
			if tc.body != "" && cerr.Message != "nope" {
				t.Errorf("detail not surfaced: %q", cerr.Message)
			}
		})
	}
}

func TestStatusErrorResourceOverride(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()
	c := testClient(srv.URL)
	_, cerr := c.Do(http.MethodPost, "/api/v1/agents/x", nil, nil, "Install agent", "agent friendly-name")
	if cerr == nil || cerr.Resource != "agent friendly-name" {
		t.Fatalf("resource override lost: %v", cerr)
	}
	if cerr.Operation != "Install agent" {
		t.Errorf("operation label lost: %q", cerr.Operation)
	}
}

func TestTransportUnreachable(t *testing.T) {
	c := testClient("http://127.0.0.1:1")
	_, cerr := c.GetRaw("/x", nil)
	if cerr == nil || cerr.Category != clierr.Unavailable {
		t.Fatalf("want unavailable, got %v", cerr)
	}
	if !strings.Contains(cerr.Message, "Cannot reach") {
		t.Errorf("message = %q", cerr.Message)
	}
}

func TestTransportTimeout(t *testing.T) {
	block := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-block
	}))
	// Defers run LIFO: release the handler before Close waits on it.
	defer srv.Close()
	defer close(block)
	c := testClient(srv.URL)
	c.Timeout = 15 * time.Millisecond
	_, cerr := c.GetRaw("/slow", nil)
	if cerr == nil || cerr.Category != clierr.Unavailable {
		t.Fatalf("want unavailable timeout, got %v", cerr)
	}
	if !strings.Contains(cerr.Message, "timed out") {
		t.Errorf("message = %q", cerr.Message)
	}
}

func TestGetHelpers(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"v":1}`))
	}))
	defer srv.Close()
	c := testClient(srv.URL)
	raw, cerr := c.GetRaw("/x", nil)
	if cerr != nil || string(raw) != `{"v":1}` {
		t.Fatalf("GetRaw = %q err=%v", raw, cerr)
	}
	got, cerr := c.Get("/x", nil)
	if cerr != nil || got.(map[string]any)["v"] != float64(1) {
		t.Fatalf("Get = %#v err=%v", got, cerr)
	}
}

func TestHealth(t *testing.T) {
	t.Run("healthy", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
		}))
		defer srv.Close()
		c := testClient(srv.URL)
		ok, ms := c.Health()
		if !ok || ms < 0 {
			t.Fatalf("healthy=%v ms=%v", ok, ms)
		}
	})
	t.Run("server error is unhealthy", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		}))
		defer srv.Close()
		c := testClient(srv.URL)
		if ok, _ := c.Health(); ok {
			t.Fatal("500 should be unhealthy")
		}
	})
	t.Run("unreachable is unhealthy", func(t *testing.T) {
		c := testClient("http://127.0.0.1:1")
		if ok, ms := c.Health(); ok || ms != 0 {
			t.Fatalf("unreachable health = %v,%v", ok, ms)
		}
	})
}

func TestGetRetriesTransient(t *testing.T) {
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	c := testClient(srv.URL)
	got, cerr := c.Get("/x", nil)
	if cerr != nil {
		t.Fatalf("retry should recover: %v", cerr)
	}
	if got.(map[string]any)["ok"] != true || calls < 2 {
		t.Fatalf("calls=%d got=%#v", calls, got)
	}
}

func TestGetRetryExhausted(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "0")
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()
	c := testClient(srv.URL)
	_, cerr := c.Get("/x", nil)
	if cerr == nil || cerr.Category != clierr.Unavailable {
		t.Fatalf("want unavailable after exhausted retries, got %v", cerr)
	}
}

func TestRefreshFromSession(t *testing.T) {
	home := isolateHome(t)
	var authCalls, tokenCalls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/auth/tenant-token":
			tokenCalls++
			if r.Header.Get("Authorization") != "Bearer sess" {
				t.Errorf("refresh used wrong token: %q", r.Header.Get("Authorization"))
			}
			_, _ = w.Write([]byte(`{"token":"fresh"}`))
		default:
			authCalls++
			if authCalls == 1 {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			if r.Header.Get("Authorization") != "Bearer fresh" {
				t.Errorf("retry did not use refreshed token: %q", r.Header.Get("Authorization"))
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
		}
	}))
	defer srv.Close()
	writeConfig(t, home, map[string]any{"server_url": srv.URL, "session_token": "sess"})
	c := testClient(srv.URL)
	got, cerr := c.Request(http.MethodPost, "/api/v1/thing", nil, nil)
	if cerr != nil {
		t.Fatalf("refresh flow failed: %v", cerr)
	}
	if got.(map[string]any)["ok"] != true || tokenCalls != 1 {
		t.Fatalf("tokenCalls=%d got=%#v", tokenCalls, got)
	}
	if c.Token != "fresh" {
		t.Errorf("client token not updated: %q", c.Token)
	}
}

func TestRefreshFromSessionNoToken(t *testing.T) {
	isolateHome(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()
	c := testClient(srv.URL)
	_, cerr := c.Request(http.MethodPost, "/x", nil, nil)
	if cerr == nil || cerr.Category != clierr.Auth {
		t.Fatalf("without session token the 401 stands: %v", cerr)
	}
}

func TestDoWithHeaders(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Total-Count", "42")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	c := testClient(srv.URL)
	_, header, cerr := c.DoWithHeaders(http.MethodGet, "/x", nil, nil, "", "")
	if cerr != nil {
		t.Fatalf("unexpected error: %v", cerr)
	}
	if header.Get("X-Total-Count") != "42" {
		t.Errorf("header not returned: %v", header)
	}
}

func TestBrowseRemediation(t *testing.T) {
	cases := []struct{ path, want string }{
		{"/api/v1/agents/x", "caracal agent list"},
		{"/api/v1/insights/agents/x", "caracal agent list"},
		{"/api/v1/mcps/x", "caracal registry mcp list"},
		{"/api/v1/skills/x", "caracal registry skill list"},
		{"/api/v1/sandboxes/x", "caracal registry sandbox list"},
		{"/api/v1/unknown/x", "Check the identifier and retry."},
		{"/", "Check the identifier and retry."},
	}
	for _, tc := range cases {
		if got := browseRemediation(tc.path); !strings.Contains(got, tc.want) {
			t.Errorf("browseRemediation(%q) = %q want substring %q", tc.path, got, tc.want)
		}
	}
}

func TestSafeDetail(t *testing.T) {
	jsonResp := &http.Response{Header: http.Header{"Content-Type": {"application/json"}}}
	if got := safeDetail(jsonResp, []byte(`{"detail":"  boom  "}`)); got != "boom" {
		t.Errorf("trimmed detail = %q", got)
	}
	if got := safeDetail(jsonResp, []byte(`not json`)); got != "" {
		t.Errorf("malformed detail should be empty, got %q", got)
	}
	textResp := &http.Response{Header: http.Header{"Content-Type": {"text/plain"}}}
	if got := safeDetail(textResp, []byte(`{"detail":"x"}`)); got != "" {
		t.Errorf("non-json content type should skip detail, got %q", got)
	}
	long := `{"detail":"` + strings.Repeat("a", 600) + `"}`
	if got := safeDetail(jsonResp, []byte(long)); len(got) != 500 {
		t.Errorf("detail not truncated to 500: len=%d", len(got))
	}
}

func TestRequestID(t *testing.T) {
	resp := &http.Response{Header: http.Header{"X-Request-Id": {"abc123"}}}
	if got := requestID(resp); got != "abc123" {
		t.Errorf("x-request-id = %q", got)
	}
	resp = &http.Response{Header: http.Header{"Request-Id": {"def456"}}}
	if got := requestID(resp); got != "def456" {
		t.Errorf("request-id = %q", got)
	}
	if got := requestID(&http.Response{Header: http.Header{}}); got != "" {
		t.Errorf("missing id should be empty, got %q", got)
	}
}

func TestRetryHelpers(t *testing.T) {
	if !isTransient(429) || !isTransient(503) || !isTransient(504) {
		t.Error("transient statuses misclassified")
	}
	if isTransient(200) || isTransient(500) {
		t.Error("non-transient statuses misclassified")
	}
	withHeader := &http.Response{Header: http.Header{"Retry-After": {"3"}}}
	if d := retryDelay(withHeader, 0); d != 3*time.Second {
		t.Errorf("retry-after delay = %v", d)
	}
	noHeader := &http.Response{Header: http.Header{}}
	if d := retryDelay(noHeader, 0); d != 500*time.Millisecond {
		t.Errorf("attempt 0 backoff = %v", d)
	}
	if d := retryDelay(noHeader, 1); d != time.Second {
		t.Errorf("attempt 1 backoff = %v", d)
	}
}
