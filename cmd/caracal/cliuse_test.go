// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

func TestUseWithoutContextExplainsList(t *testing.T) {
	// Showing the context reads only the local config: no server needed.
	home := t.TempDir()
	t.Setenv("HOME", home)
	out, err := captureCLI(t, "use")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "No context selected") || !strings.Contains(out, "caracal use --list") {
		t.Errorf("use without context:\n%s", out)
	}
}

func TestUseListRendersOrgsAndProjects(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /api/v1/orgs":               {body: `[{"slug": "acme", "name": "Acme", "role": "owner"}]`},
		"GET /api/v1/orgs/acme/projects": {body: `{"projects": [{"slug": "api", "name": "API"}], "total": 1, "page": 1, "page_size": 100}`},
	})
	out, err := runCLI(t, srv, "use", "--list")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"acme (owner)", "acme/api"} {
		if !strings.Contains(out, want) {
			t.Errorf("use --list missing %q:\n%s", want, out)
		}
	}
}

func TestUseOrgPersistsDefaultOrg(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"GET /api/v1/orgs/acme": {body: `{"slug": "acme", "name": "Acme"}`},
	})
	home := recEnv(t, rec)
	out, err := captureCLI(t, "use", "acme")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "Context set to acme.") {
		t.Errorf("use output:\n%s", out)
	}
	blob, err := os.ReadFile(filepath.Join(home, ".caracal", "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(blob), `"default_org": "acme"`) {
		t.Errorf("config.json after use:\n%s", blob)
	}
}

func TestUseOrgProjectPersistsBoth(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"GET /api/v1/orgs/acme":              {body: `{"slug": "acme"}`},
		"GET /api/v1/orgs/acme/projects/api": {body: `{"slug": "api", "name": "API"}`},
	})
	home := recEnv(t, rec)
	out, err := captureCLI(t, "use", "acme/api")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "Context set to acme/api.") {
		t.Errorf("use output:\n%s", out)
	}
	blob, err := os.ReadFile(filepath.Join(home, ".caracal", "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"default_org": "acme"`, `"default_project": "api"`} {
		if !strings.Contains(string(blob), want) {
			t.Errorf("config.json missing %s:\n%s", want, blob)
		}
	}

	// The argless form now reflects the persisted context.
	out, err = captureCLI(t, "use")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "Context: acme/api") {
		t.Errorf("use show output:\n%s", out)
	}
}

func TestUseUnknownOrgLeavesConfigUntouched(t *testing.T) {
	srv := fakeAPI(t, nil)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CARACAL_SERVER_URL", srv.URL)
	t.Setenv("CARACAL_ACCESS_TOKEN", "test-token")
	_, err := captureCLI(t, "use", "ghost-org")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.NotFound {
		t.Errorf("category = %s", cerr.Category)
	}
	if blob, err := os.ReadFile(filepath.Join(home, ".caracal", "config.json")); err == nil &&
		strings.Contains(string(blob), "default_org") {
		t.Errorf("failed use must not persist a default:\n%s", blob)
	}
}

func TestUseDeniedProjectPersistsNothing(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /api/v1/orgs/acme": {body: `{"slug": "acme"}`},
	})
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CARACAL_SERVER_URL", srv.URL)
	t.Setenv("CARACAL_ACCESS_TOKEN", "test-token")
	_, err := captureCLI(t, "use", "acme/secret")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.NotFound {
		t.Errorf("category = %s", cerr.Category)
	}
	if blob, err := os.ReadFile(filepath.Join(home, ".caracal", "config.json")); err == nil &&
		(strings.Contains(string(blob), "default_org") || strings.Contains(string(blob), "default_project")) {
		t.Errorf("denied project selection must not persist context:\n%s", blob)
	}
}

func TestUseOrgSwitchClearsProjectContext(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"GET /api/v1/orgs/acme":              {body: `{"slug": "acme"}`},
		"GET /api/v1/orgs/beta":              {body: `{"slug": "beta"}`},
		"GET /api/v1/orgs/acme/projects/api": {body: `{"slug": "api"}`},
	})
	home := recEnv(t, rec)
	if _, err := captureCLI(t, "use", "acme/api"); err != nil {
		t.Fatal(err)
	}
	out, err := captureCLI(t, "use", "beta")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "Project selection cleared") {
		t.Errorf("org switch must announce the cleared project:\n%s", out)
	}
	blob, err := os.ReadFile(filepath.Join(home, ".caracal", "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(blob), `"default_org": "beta"`) || strings.Contains(string(blob), `"default_project": "api"`) {
		t.Errorf("stale project context survived the org switch:\n%s", blob)
	}
}

func TestUseInvalidSlugsRejectedLocally(t *testing.T) {
	// Both parts are validated before any request goes out.
	for _, target := range []string{"ab", "acme/a/b"} {
		_, err := runCLI(t, nil, "use", target)
		cerr := asCLIError(t, err)
		if cerr.Category != clierr.Validation {
			t.Errorf("use %s: category = %s / %s", target, cerr.Category, cerr.Message)
		}
	}
}
