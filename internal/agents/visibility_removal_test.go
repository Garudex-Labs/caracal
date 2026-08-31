// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"net/http"
	"strings"
	"testing"
)

// Agents only carry the project or private scope; the removed "public" value
// must be rejected at creation and can never be derived for an existing agent.

func TestAgentVisibilityLabelNeverPublic(t *testing.T) {
	for _, scope := range []string{"", "project", "private", "team", "user"} {
		for _, priv := range []bool{true, false} {
			if got := visibility(map[string]any{"ownership_scope": scope, "is_private": priv}); got == "public" {
				t.Errorf("scope=%q is_private=%v rendered public", scope, priv)
			}
		}
	}
}

func TestAgentCreateRejectsPublicVisibility(t *testing.T) {
	body := `{"name": "review-bot", "version": "1.0.0", "owner": "me",
		"model_name": "m", "description": "d", "visibility": "public"}`
	rec := serveAgents(t, &fakeDB{}, http.MethodPost, "/api/v1/agents", "user", body)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("public visibility must be rejected: status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "'project' or 'private'") {
		t.Errorf("error must name the supported scopes: %s", rec.Body.String())
	}
}
