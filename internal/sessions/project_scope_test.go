// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/tenancy"
)

type deniedProjects struct{}

func (deniedProjects) ResolveProjectID(context.Context, *http.Request, uuid.UUID) (string, error) {
	return "", &tenancy.Error{Status: http.StatusUnprocessableEntity, Detail: "Project scope is required"}
}

func TestTenantSessionRoutesRejectMissingProjectScope(t *testing.T) {
	for _, target := range []string{
		"/api/v1/sessions",
		"/api/v1/sessions/query",
		"/api/v1/sessions/summary",
		"/api/v1/sessions/s1",
		"/api/v1/sessions/s1/bind-agent?agent_name=helper",
	} {
		store := &fakeStore{}
		binder := &fakeBinder{}
		h := newHandler(store, &fakeDir{}, fakeSettings{}, binder)
		h.Projects = deniedProjects{}
		method := http.MethodGet
		if target == "/api/v1/sessions/s1/bind-agent?agent_name=helper" {
			method = http.MethodPost
		}
		rec := do(h, "user", uuid.New(), method, target)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s status = %d, want 422", target, rec.Code)
		}
		if store.listFilter.ProjectID != "" || store.queryFilter.ProjectID != "" || store.summaryProj != "" || binder.key != "" {
			t.Errorf("%s reached a session dependency after scope rejection", target)
		}
	}
}
