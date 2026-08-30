// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

// fakeAPI serves canned JSON per exact request path (query ignored).
// Values may be raw JSON strings, or a status-wrapping response.
type apiResponse struct {
	status int
	body   string
	header map[string]string
}

func fakeAPI(t *testing.T, routes map[string]apiResponse) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		route, ok := routes[r.Method+" "+r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"detail": "no such route"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		for k, v := range route.header {
			w.Header().Set(k, v)
		}
		if route.status != 0 {
			w.WriteHeader(route.status)
		}
		_, _ = w.Write([]byte(route.body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

// runCLI executes the real command tree with isolated state and captures
// standard output.
func runCLI(t *testing.T, srv *httptest.Server, args ...string) (string, error) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	if srv != nil {
		t.Setenv("CARACAL_SERVER_URL", srv.URL)
		t.Setenv("CARACAL_ACCESS_TOKEN", "test-token")
	}
	return captureCLI(t, args...)
}

// captureCLI executes the command tree capturing stdout, leaving env intact.
func captureCLI(t *testing.T, args ...string) (string, error) {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	defer func() { os.Stdout = old }()

	root := newRootCommand()
	root.SetArgs(args)
	execErr := root.Execute()

	_ = w.Close()
	var out strings.Builder
	buf := make([]byte, 1<<16)
	for {
		n, readErr := r.Read(buf)
		out.Write(buf[:n])
		if readErr != nil {
			break
		}
	}
	_ = r.Close()
	return out.String(), execErr
}

func asCLIError(t *testing.T, err error) *clierr.Error {
	t.Helper()
	var cerr *clierr.Error
	if !errors.As(err, &cerr) {
		t.Fatalf("want *clierr.Error, got %T: %v", err, err)
	}
	return cerr
}

const mcpList = `[
  {"id": "0656308f-8bba-472e-ab77-f96a7ac69fd2", "name": "Weather", "version": "1.2.0", "namespace": "acme"},
  {"id": "1766308f-8bba-472e-ab77-f96a7ac69fd3", "name": "Mailer", "version": "0.9.1", "namespace": "acme"}
]`

func TestRegistryListRendersTable(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /api/v1/mcps": {body: mcpList},
	})
	out, err := runCLI(t, srv, "registry", "mcp", "list")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "Weather") || !strings.Contains(out, "Mailer") {
		t.Errorf("table missing rows:\n%s", out)
	}
	if !strings.Contains(out, "0656308f…") {
		t.Errorf("ids must be truncated with an ellipsis:\n%s", out)
	}
}

func TestRegistryListJSONPassesRawThrough(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /api/v1/skills": {body: `[{"id": "s1", "name": "Reviewer", "extra_field": {"nested": true}}]`},
	})
	out, err := runCLI(t, srv, "registry", "skill", "list", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	// JSON output wraps rows in the list envelope.
	var doc struct {
		Items []map[string]any `json:"items"`
		Total int              `json:"total"`
	}
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("output is not JSON: %v\n%s", err, out)
	}
	if doc.Total != 1 || len(doc.Items) != 1 || doc.Items[0]["extra_field"] == nil {
		t.Errorf("server fields must pass through untouched: %v", doc)
	}
}

func TestRegistryListEmptyMessage(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /api/v1/prompts": {body: `[]`},
	})
	out, err := runCLI(t, srv, "registry", "prompt", "list")
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(out) == "" {
		t.Error("empty list must print a message")
	}
}

func TestRegistryListRejectsUnknownFilterLocally(t *testing.T) {
	// No server: the filter must be rejected before any request.
	_, err := runCLI(t, nil, "registry", "hook", "list", "--event", "OnVibes")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation && cerr.Category != clierr.Usage {
		t.Errorf("category = %s", cerr.Category)
	}
	if !strings.Contains(cerr.Message, "OnVibes") {
		t.Errorf("message must name the bad value: %s", cerr.Message)
	}
}

func TestRegistryShowResolvesPositionalRow(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /api/v1/mcps": {body: mcpList},
		// MCP lists sort by name, so row 1 is Mailer.
		"GET /api/v1/mcps/1766308f-8bba-472e-ab77-f96a7ac69fd3": {
			body: `{"id": "1766308f-8bba-472e-ab77-f96a7ac69fd3", "name": "Mailer", "version": "0.9.1"}`,
		},
	})
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CARACAL_SERVER_URL", srv.URL)
	t.Setenv("CARACAL_ACCESS_TOKEN", "test-token")

	// List caches rows, then "2" addresses the second row.
	root := newRootCommand()
	root.SetArgs([]string{"registry", "mcp", "list"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	out, err := func() (string, error) {
		old := os.Stdout
		r, w, _ := os.Pipe()
		os.Stdout = w
		defer func() { os.Stdout = old }()
		root := newRootCommand()
		root.SetArgs([]string{"registry", "mcp", "show", "1"})
		execErr := root.Execute()
		_ = w.Close()
		blob := make([]byte, 1<<16)
		n, _ := r.Read(blob)
		_ = r.Close()
		return string(blob[:n]), execErr
	}()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "Mailer") {
		t.Errorf("show output:\n%s", out)
	}
}

func TestServerErrorsMapToCLICategories(t *testing.T) {
	cases := []struct {
		status   int
		body     string
		category clierr.Category
		exit     int
	}{
		{401, `{}`, clierr.Auth, 3},
		{403, `{"detail": "admins only"}`, clierr.Permission, 4},
		{404, `{"detail": "nope"}`, clierr.NotFound, 5},
		{409, `{"detail": "busy"}`, clierr.Conflict, 6},
		{422, `{"detail": "bad input"}`, clierr.Validation, 7},
		{500, `{}`, clierr.Unavailable, 9},
	}
	for _, tc := range cases {
		srv := fakeAPI(t, map[string]apiResponse{
			"GET /api/v1/mcps": {status: tc.status, body: tc.body},
		})
		_, err := runCLI(t, srv, "registry", "mcp", "list")
		cerr := asCLIError(t, err)
		if cerr.Category != tc.category || cerr.ExitCode() != tc.exit {
			t.Errorf("HTTP %d: category %s exit %d, want %s/%d",
				tc.status, cerr.Category, cerr.ExitCode(), tc.category, tc.exit)
		}
		if cerr.HTTPStatus != tc.status {
			t.Errorf("HTTP %d not carried: %d", tc.status, cerr.HTTPStatus)
		}
	}
}

func TestServerDetailSurfacesInPermissionError(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /api/v1/agents": {status: 403, body: `{"detail": "Deployment admins only"}`},
	})
	_, err := runCLI(t, srv, "agent", "list")
	cerr := asCLIError(t, err)
	if cerr.Message != "Deployment admins only" {
		t.Errorf("server detail must win: %q", cerr.Message)
	}
}

func TestUnauthenticatedCommandFailsWithAuthContract(t *testing.T) {
	// HOME is empty and no env token: every server-backed command must fail
	// with the auth category before any network activity.
	_, err := runCLI(t, nil, "registry", "mcp", "list")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Auth || cerr.ExitCode() != 3 {
		t.Errorf("unauthenticated: %s/%d", cerr.Category, cerr.ExitCode())
	}
	if !strings.Contains(cerr.Remediation, "caracal auth login") {
		t.Errorf("remediation must point at login: %s", cerr.Remediation)
	}
}

func TestUnreachableServerIsUnavailable(t *testing.T) {
	srv := fakeAPI(t, nil)
	url := srv.URL
	srv.Close()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CARACAL_SERVER_URL", url)
	t.Setenv("CARACAL_ACCESS_TOKEN", "tok")
	root := newRootCommand()
	root.SetArgs([]string{"registry", "mcp", "list"})
	cerr := asCLIError(t, root.Execute())
	if cerr.Category != clierr.Unavailable {
		t.Errorf("category = %s", cerr.Category)
	}
}

func TestAPICommandPassesRawResponseThrough(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /api/v1/overview": {body: `{"sessions": 12, "agents": 3}`},
	})
	out, err := runCLI(t, srv, "api", "GET", "/api/v1/overview")
	if err != nil {
		t.Fatal(err)
	}
	// The default rendering is a key-value summary of the document.
	if !strings.Contains(out, "sessions") || !strings.Contains(out, "12") {
		t.Errorf("api output: %s", out)
	}
}

func TestUnknownCommandSuggestsClosest(t *testing.T) {
	root := newRootCommand()
	_, rest, _ := root.Find([]string{"registry", "mpc"})
	if len(rest) == 0 {
		t.Skip("command resolution changed")
	}
	names := []string{}
	for _, sub := range root.Commands() {
		names = append(names, sub.Name())
	}
	if best := closestMatch("registr", names); best != "registry" {
		t.Errorf("closestMatch = %q, want registry", best)
	}
}
