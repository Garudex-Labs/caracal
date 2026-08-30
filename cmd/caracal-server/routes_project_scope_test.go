// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/tenancy"
)

type fakeRequestProjectResolver struct {
	projectID string
	err       error
}

func (f fakeRequestProjectResolver) ResolveProjectID(context.Context, *http.Request, uuid.UUID) (string, error) {
	return f.projectID, f.err
}

func TestWithProjectScopeStoresValidatedProject(t *testing.T) {
	userID := uuid.New()
	seen := ""
	next := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		seen, _ = tenancy.ProjectIDFromContext(r.Context())
	})
	handler := withProjectScope(fakeRequestProjectResolver{projectID: "project-1"}, false, next)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/resources", nil)
	req = req.WithContext(httpapi.ContextWithClaims(req.Context(), auth.Claims{UserID: userID, Role: "user"}))
	handler.ServeHTTP(httptest.NewRecorder(), req)
	if seen != "project-1" {
		t.Fatalf("context project = %q", seen)
	}
}

func TestWithProjectScopeRejectsBeforeHandler(t *testing.T) {
	called := false
	next := http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true })
	handler := withProjectScope(fakeRequestProjectResolver{err: &tenancy.Error{
		Status: http.StatusNotFound,
		Detail: "Project not found",
	}}, false, next)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/resources", nil)
	req = req.WithContext(httpapi.ContextWithClaims(req.Context(), auth.Claims{UserID: uuid.New(), Role: "user"}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound || called {
		t.Fatalf("status=%d called=%v", rec.Code, called)
	}
}

func TestWithProjectScopeAllowsAnonymousPublicRead(t *testing.T) {
	called := false
	next := http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true })
	handler := withProjectScope(fakeRequestProjectResolver{}, true, next)
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/v1/mcps", nil))
	if !called {
		t.Fatal("anonymous public registry read was blocked")
	}
}
