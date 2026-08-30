// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/identity"
)

var okHandler = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
})

func requestWithClaims(role string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	return req.WithContext(ContextWithClaims(req.Context(), auth.Claims{UserID: uuid.New(), Role: role}))
}

type staticGate struct {
	id  uuid.UUID
	err error
}

func (g staticGate) ResolveActive(context.Context, auth.Claims) (uuid.UUID, error) {
	return g.id, g.err
}

func TestRequireActiveUser(t *testing.T) {
	localID := uuid.New()
	tests := []struct {
		name       string
		gateErr    error
		wantStatus int
		wantDetail string
	}{
		{"active", nil, http.StatusOK, ""},
		{"unknown user", identity.ErrUnknownUser, http.StatusUnauthorized, "Invalid or expired token"},
		{"deactivated", identity.ErrDeactivated, http.StatusForbidden, "Account deactivated"},
		{"gate outage fails closed", identity.ErrUnavailable, http.StatusServiceUnavailable, "temporarily unavailable"},
		{"unexpected error fails closed", errors.New("boom"), http.StatusServiceUnavailable, "temporarily unavailable"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			RequireActiveUser(staticGate{id: localID, err: tc.gateErr}, okHandler).ServeHTTP(rec, requestWithClaims("user"))
			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d", rec.Code, tc.wantStatus)
			}
			if tc.wantDetail != "" && !strings.Contains(rec.Body.String(), tc.wantDetail) {
				t.Errorf("body = %s, want substring %q", rec.Body, tc.wantDetail)
			}
		})
	}

	t.Run("claims carry the registry user id downstream", func(t *testing.T) {
		var seen uuid.UUID
		capture := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			claims, _ := ClaimsFrom(r.Context())
			seen = claims.UserID
			w.WriteHeader(http.StatusOK)
		})
		rec := httptest.NewRecorder()
		RequireActiveUser(staticGate{id: localID}, capture).ServeHTTP(rec, requestWithClaims("user"))
		if seen != localID {
			t.Errorf("downstream UserID = %s, want %s", seen, localID)
		}
	})

	t.Run("missing claims", func(t *testing.T) {
		rec := httptest.NewRecorder()
		RequireActiveUser(staticGate{}, okHandler).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("status = %d", rec.Code)
		}
	})
}

func TestRequireRole(t *testing.T) {
	tests := []struct {
		role       string
		minRole    string
		wantStatus int
	}{
		{"user", "user", http.StatusOK},
		{"reviewer", "user", http.StatusOK},
		{"operator", "user", http.StatusOK},
		{"admin", "user", http.StatusForbidden},
		{"super_admin", "user", http.StatusForbidden},
		{"user", "operator", http.StatusForbidden},
		{"reviewer", "operator", http.StatusForbidden},
		{"operator", "operator", http.StatusOK},
		{"admin", "operator", http.StatusForbidden},
		{"super_admin", "operator", http.StatusForbidden},
		{"", "user", http.StatusForbidden},
		{"made-up-role", "user", http.StatusForbidden},
	}
	for _, tc := range tests {
		t.Run(tc.role+"->"+tc.minRole, func(t *testing.T) {
			rec := httptest.NewRecorder()
			RequireRole(tc.minRole, okHandler).ServeHTTP(rec, requestWithClaims(tc.role))
			if rec.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d", rec.Code, tc.wantStatus)
			}
		})
	}

	t.Run("unknown floor panics at wiring time", func(t *testing.T) {
		defer func() {
			if recover() == nil {
				t.Error("expected panic for an unknown role floor")
			}
		}()
		RequireRole("made-up", okHandler)
	})
}

func TestRequireAuthContext(t *testing.T) {
	tests := []struct {
		name       string
		context    string
		wantStatus int
	}{
		{"tenant token on tenant route", auth.AuthContextTenant, http.StatusOK},
		{"operator token on tenant route", auth.AuthContextOperator, http.StatusForbidden},
		{"missing context", "", http.StatusForbidden},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := requestWithClaims("user")
			claims, _ := ClaimsFrom(req.Context())
			claims.AuthContext = tc.context
			req = req.WithContext(ContextWithClaims(req.Context(), claims))
			rec := httptest.NewRecorder()
			RequireAuthContext(auth.AuthContextTenant, okHandler).ServeHTTP(rec, req)
			if rec.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d", rec.Code, tc.wantStatus)
			}
		})
	}

	rec := httptest.NewRecorder()
	RequireAuthContext(auth.AuthContextTenant, okHandler).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("missing claims status = %d", rec.Code)
	}
}
