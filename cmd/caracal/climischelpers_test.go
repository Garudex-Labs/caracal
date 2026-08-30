// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

func TestJSONLineWritesUnescapedJSON(t *testing.T) {
	out := captureStdout(t, func() {
		jsonLine(map[string]string{"url": "https://a.example/?x=1&y=2"})
	})
	// SetEscapeHTML(false) keeps & and < literal instead of \u0026.
	if !strings.Contains(out, `"url":"https://a.example/?x=1&y=2"`) {
		t.Errorf("expected unescaped ampersand:\n%s", out)
	}
}

func TestGithubJSONParsesOKBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Accept") != "application/vnd.github+json" {
			t.Errorf("missing github accept header")
		}
		_, _ = w.Write([]byte(`{"tag_name":"v1.5.0"}`))
	}))
	defer srv.Close()
	var out struct {
		TagName string `json:"tag_name"`
	}
	if !githubJSON(srv.URL, time.Second, &out) || out.TagName != "v1.5.0" {
		t.Errorf("githubJSON should parse the body, got %+v", out)
	}
}

func TestGithubJSONRejectsNon200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	var out map[string]any
	if githubJSON(srv.URL, time.Second, &out) {
		t.Error("a 500 response must return false")
	}
}

func TestGithubJSONRejectsOversizedBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("[" + strings.Repeat(" ", 1_048_577) + "]"))
	}))
	defer srv.Close()
	var out []any
	if githubJSON(srv.URL, 2*time.Second, &out) {
		t.Error("a body larger than the 1MiB cap must return false")
	}
}

func TestProcessAlive(t *testing.T) {
	if !processAlive(os.Getpid()) {
		t.Error("the current process must be reported alive")
	}
	// A very high PID that cannot be in use signals not-alive.
	if processAlive(1 << 30) {
		t.Error("an unused PID must be reported not alive")
	}
}

func TestTransportFailureShape(t *testing.T) {
	cerr := transportFailure(os.ErrDeadlineExceeded, "Login", "server x")
	if cerr.Category != clierr.Unavailable || cerr.Operation != "Login" || cerr.Resource != "server x" {
		t.Errorf("transport failure fields = %+v", cerr)
	}
	if cerr.Detail != os.ErrDeadlineExceeded.Error() {
		t.Errorf("detail should carry the underlying error: %q", cerr.Detail)
	}
}

func TestInvalidAuthResponseShape(t *testing.T) {
	cerr := invalidAuthResponse("Login", "server x", "no token field")
	if cerr.Category != clierr.Unexpected || cerr.Detail != "no token field" {
		t.Errorf("invalid auth response fields = %+v", cerr)
	}
}

func TestPostJSONWithBearerSendsToken(t *testing.T) {
	var gotAuth, gotType string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotType = r.Header.Get("Content-Type")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	status, body, cerr := postJSONWithBearer(srv.URL, map[string]any{"a": 1}, "tok123", "Op", "res")
	if cerr != nil {
		t.Fatalf("unexpected error: %v", cerr)
	}
	if status != http.StatusCreated || !strings.Contains(string(body), `"ok":true`) {
		t.Errorf("status=%d body=%s", status, body)
	}
	if gotAuth != "Bearer tok123" || gotType != "application/json" {
		t.Errorf("headers auth=%q type=%q", gotAuth, gotType)
	}
}

func TestPostJSONWithBearerTransportError(t *testing.T) {
	// A malformed URL yields a request-construction transport failure.
	_, _, cerr := postJSONWithBearer("http://%zz", map[string]any{}, "t", "Op", "res")
	if cerr == nil || cerr.Category != clierr.Unavailable {
		t.Fatalf("want unavailable transport error, got %v", cerr)
	}
}

func TestSelfGithubRepoDefaultsWithoutConfig(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if got := selfGithubRepo(); got != selfRepo {
		t.Errorf("with no config override, repo = %q, want %q", got, selfRepo)
	}
}

func TestBulkOwnerFallsBackToWhoami(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	client := &stubAPIClient{body: `{"username":"ada","email":"ada@example.com"}`}
	owner, cerr := bulkOwner(client)
	if cerr != nil {
		t.Fatalf("bulkOwner: %v", cerr)
	}
	if owner != "ada" {
		t.Errorf("owner = %q, want ada", owner)
	}
	if client.path != "/api/v1/auth/whoami" {
		t.Errorf("resolved via %s", client.path)
	}
}

func TestBulkOwnerServerErrorPropagates(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	client := &stubAPIClient{cerr: &clierr.Error{Category: clierr.Unavailable, Message: "down"}}
	if _, cerr := bulkOwner(client); cerr == nil {
		t.Error("a whoami failure must propagate")
	}
}

// withStdin replaces os.Stdin with a pipe carrying content for the duration
// of fn, then restores it.
func withStdin(t *testing.T, content string, fn func()) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	old := os.Stdin
	os.Stdin = r
	defer func() { os.Stdin = old }()
	go func() {
		_, _ = w.WriteString(content)
		_ = w.Close()
	}()
	fn()
	_ = r.Close()
}

func TestReadStdinConfigStopsAtBlankAfterContent(t *testing.T) {
	var got string
	withStdin(t, "line one\nline two\n\ntrailing ignored\n", func() {
		got = readStdinConfig()
	})
	if got != "line one\nline two" {
		t.Errorf("readStdinConfig = %q", got)
	}
}

func TestReadStdinConfigSkipsLeadingBlanks(t *testing.T) {
	var got string
	withStdin(t, "\n\n  \nonly line\n", func() {
		got = readStdinConfig()
	})
	if got != "only line" {
		t.Errorf("leading blanks should be skipped, got %q", got)
	}
}

func TestTextInputReturnsTypedValue(t *testing.T) {
	var got string
	captureStdout(t, func() {
		withStdin(t, "typed answer\n", func() {
			got = textInput("Name", "fallback")
		})
	})
	if got != "typed answer" {
		t.Errorf("textInput = %q", got)
	}
}

func TestTextInputFallsBackToDefault(t *testing.T) {
	var got string
	captureStdout(t, func() {
		withStdin(t, "\n", func() {
			got = textInput("Name", "fallback")
		})
	})
	if got != "fallback" {
		t.Errorf("empty input should yield the default, got %q", got)
	}
}

func TestQuickChoiceReturnsFirstAllowedAnswer(t *testing.T) {
	var got string
	captureStdout(t, func() {
		// textInput builds a fresh reader per call, so a piped test can only
		// assert the first-answer-accepted path.
		withStdin(t, "yes\n", func() {
			got = quickChoice("Proceed?", []string{"yes", "no"})
		})
	})
	if got != "yes" {
		t.Errorf("quickChoice = %q, want yes", got)
	}
}

func TestPasswordInputFallsBackOnNonTerminal(t *testing.T) {
	var got string
	captureStdout(t, func() {
		// A pipe is not a terminal, so ReadPassword fails and the bufio
		// fallback reads the line.
		withStdin(t, "s3cret\n", func() {
			got = passwordInput("Password")
		})
	})
	if got != "s3cret" {
		t.Errorf("passwordInput fallback = %q", got)
	}
}
