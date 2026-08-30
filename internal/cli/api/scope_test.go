// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestProjectScopedPathsCarrySelectedContextOnly(t *testing.T) {
	var sessionOrg, sessionProject, orgRouteOrg, orgRouteProject string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/sessions":
			sessionOrg = r.Header.Get("X-Caracal-Org")
			sessionProject = r.Header.Get("X-Caracal-Project")
		case "/api/v1/orgs/other/projects":
			orgRouteOrg = r.Header.Get("X-Caracal-Org")
			orgRouteProject = r.Header.Get("X-Caracal-Project")
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	client := testClient(srv.URL)
	client.OrgSlug = "acme"
	client.ProjectSlug = "platform"
	if _, cerr := client.Do(http.MethodGet, "/api/v1/sessions", nil, nil, "", ""); cerr != nil {
		t.Fatal(cerr)
	}
	if _, cerr := client.Do(http.MethodGet, "/api/v1/orgs/other/projects", nil, nil, "", ""); cerr != nil {
		t.Fatal(cerr)
	}
	if sessionOrg != "acme" || sessionProject != "platform" {
		t.Fatalf("session scope = %q/%q", sessionOrg, sessionProject)
	}
	if orgRouteOrg != "" || orgRouteProject != "" {
		t.Fatalf("explicit org route inherited stale scope = %q/%q", orgRouteOrg, orgRouteProject)
	}
}

func TestProjectScopedPathClassification(t *testing.T) {
	for _, path := range []string{
		"/api/v1/sessions", "/api/v1/sessions/s1", "/api/v1/resources",
		"/api/v1/agents/a1/versions", "/api/v1/mcps/m1", "/api/v1/review/queue",
		"/api/v1/insights/status", "/api/v1/inbox", "/api/v1/layer-snapshots",
		"/api/v1/registry/resolve", "/api/v1/component-sources", "/api/v1/recommendations/me", "/api/v1/bulk",
	} {
		if !projectScopedAPIPath(path) {
			t.Errorf("%q must be project-scoped", path)
		}
	}
	for _, path := range []string{
		"/api/v1/orgs/acme/projects", "/api/v1/operator/status",
		"/api/v1/config/public", "/api/v1/auth/whoami",
	} {
		if projectScopedAPIPath(path) {
			t.Errorf("%q must not inherit project scope", path)
		}
	}
}
