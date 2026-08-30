// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package onboarding

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/tenancy"
)

// ── package-local pgx fake ──────────────────────────────────────────────────

type fakeRows struct {
	rows [][]any
	idx  int
}

func (r *fakeRows) Close()                                       {}
func (r *fakeRows) Err() error                                   { return nil }
func (r *fakeRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (r *fakeRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (r *fakeRows) Next() bool                                   { r.idx++; return r.idx <= len(r.rows) }
func (r *fakeRows) Values() ([]any, error)                       { return r.rows[r.idx-1], nil }
func (r *fakeRows) RawValues() [][]byte                          { return nil }
func (r *fakeRows) Conn() *pgx.Conn                              { return nil }

func (r *fakeRows) Scan(dest ...any) error {
	if r.idx == 0 || r.idx > len(r.rows) {
		return pgx.ErrNoRows
	}
	row := r.rows[r.idx-1]
	for i, d := range dest {
		if i >= len(row) {
			break
		}
		if err := assignVal(d, row[i]); err != nil {
			return fmt.Errorf("column %d: %w", i, err)
		}
	}
	return nil
}

func assignVal(dest, value any) error {
	switch d := dest.(type) {
	case *string:
		if value == nil {
			*d = ""
		} else {
			*d = fmt.Sprint(value)
		}
	case **string:
		if value == nil {
			*d = nil
		} else {
			s := fmt.Sprint(value)
			*d = &s
		}
	case *bool:
		b, _ := value.(bool)
		*d = b
	case **bool:
		switch v := value.(type) {
		case nil:
			*d = nil
		case bool:
			b := v
			*d = &b
		}
	case *uuid.UUID:
		u, _ := value.(uuid.UUID)
		*d = u
	case *time.Time:
		t, _ := value.(time.Time)
		*d = t
	case **time.Time:
		switch v := value.(type) {
		case nil:
			*d = nil
		case time.Time:
			t := v
			*d = &t
		}
	default:
		return fmt.Errorf("unsupported scan destination %T", dest)
	}
	return nil
}

type fakeRow struct{ rows *fakeRows }

func (r fakeRow) Scan(dest ...any) error {
	if !r.rows.Next() {
		return pgx.ErrNoRows
	}
	return r.rows.Scan(dest...)
}

type stub struct {
	match string
	rows  [][]any
	err   error
}

type fakeDB struct {
	stubs []stub
}

func (db *fakeDB) match(sql string) (stub, bool) {
	for _, s := range db.stubs {
		if strings.Contains(sql, s.match) {
			return s, true
		}
	}
	return stub{}, false
}

func (db *fakeDB) Query(_ context.Context, sql string, _ ...any) (pgx.Rows, error) {
	s, ok := db.match(sql)
	if !ok {
		return &fakeRows{}, nil
	}
	if s.err != nil {
		return nil, s.err
	}
	return &fakeRows{rows: s.rows}, nil
}

func (db *fakeDB) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	s, ok := db.match(sql)
	if !ok {
		return fakeRow{&fakeRows{}}
	}
	if s.err != nil {
		return errRow{s.err}
	}
	return fakeRow{&fakeRows{rows: s.rows}}
}

type errRow struct{ err error }

func (r errRow) Scan(_ ...any) error { return r.err }

// ── fixtures ─────────────────────────────────────────────────────────────────

var (
	userID   = uuid.MustParse("22222222-2222-2222-2222-222222222222")
	newID    = uuid.MustParse("33333333-3333-3333-3333-333333333333")
	fixedNow = time.Date(2026, 8, 30, 8, 0, 0, 0, time.UTC)
)

// profileMatch is the discriminating substring of the Snapshot profile query;
// CompleteProfile's query lacks "email, avatar_url", so this never collides.
const (
	profileMatch    = "email, avatar_url, profile_completed_at FROM users"
	orgJoinMatch    = "organization_memberships m"
	invitationMatch = "org_invitations i"
	completeSelect  = "username, profile_completed_at FROM users"
	completeUpdate  = "UPDATE users SET profile_completed_at"
)

func TestSnapshotAssemblesOrgsProjectsInvitations(t *testing.T) {
	expiry := fixedNow.Add(48 * time.Hour)
	db := &fakeDB{stubs: []stub{
		{match: profileMatch, rows: [][]any{{"Ada", "ada", "ada@example.com", nil, fixedNow}}},
		{match: orgJoinMatch, rows: [][]any{
			// acme: owner sees a default project.
			{"acme", "Acme", "owner", "core", "Core", true, "admin"},
			// beta: member with no accessible project (LEFT JOIN nulls).
			{"beta", "Beta", "member", nil, nil, nil, nil},
		}},
		{match: invitationMatch, rows: [][]any{
			{"inv-1", "gamma", "Gamma", "member", expiry},
		}},
	}}
	snap, err := (&Store{DB: db}).Snapshot(context.Background(), userID)
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if !snap.Profile.Completed {
		t.Error("profile should be completed when completed_at is set")
	}
	if len(snap.Organizations) != 2 {
		t.Fatalf("orgs = %d, want 2", len(snap.Organizations))
	}
	if got := snap.Organizations[0]; got.Slug != "acme" || len(got.Projects) != 1 {
		t.Errorf("acme = %+v, want one project", got)
	}
	if snap.Organizations[0].Projects[0].Role == nil || *snap.Organizations[0].Projects[0].Role != "admin" {
		t.Error("acme project role should be admin")
	}
	if got := snap.Organizations[1]; got.Slug != "beta" || len(got.Projects) != 0 {
		t.Errorf("beta = %+v, want zero projects", got)
	}
	if len(snap.Invitations) != 1 || snap.Invitations[0].ExpiresAt != wireTime(expiry) {
		t.Errorf("invitations = %+v", snap.Invitations)
	}
	// acme has a project, so onboarding is complete.
	if snap.NextStep != StepDone {
		t.Errorf("next step = %q, want %q", snap.NextStep, StepDone)
	}
}

func TestSnapshotMissingUserIs401(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: profileMatch, err: pgx.ErrNoRows},
	}}
	_, err := (&Store{DB: db}).Snapshot(context.Background(), userID)
	var te *tenancy.Error
	if !errors.As(err, &te) || te.Status != 401 {
		t.Fatalf("err = %v, want tenancy 401", err)
	}
}

func TestSnapshotOrgQueryErrorPropagates(t *testing.T) {
	boom := errors.New("boom")
	db := &fakeDB{stubs: []stub{
		{match: profileMatch, rows: [][]any{{"Ada", "ada", "ada@example.com", nil, nil}}},
		{match: orgJoinMatch, err: boom},
	}}
	_, err := (&Store{DB: db}).Snapshot(context.Background(), userID)
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want boom", err)
	}
}

func TestSnapshotIncompleteProfileStepsToProfile(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: profileMatch, rows: [][]any{{"", "", "ada@example.com", nil, nil}}},
	}}
	snap, err := (&Store{DB: db}).Snapshot(context.Background(), userID)
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if snap.Profile.Completed {
		t.Error("profile with nil completed_at is not complete")
	}
	if snap.NextStep != StepProfile {
		t.Errorf("next step = %q, want %q", snap.NextStep, StepProfile)
	}
}

func TestCompleteProfileStampsWhenReady(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: completeSelect, rows: [][]any{{"Ada", "ada", nil}}},
		{match: completeUpdate, rows: [][]any{{newID}}},
	}}
	if err := (&Store{DB: db}).CompleteProfile(context.Background(), userID); err != nil {
		t.Fatalf("CompleteProfile: %v", err)
	}
}

func TestCompleteProfileAlreadyDoneIsNoop(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: completeSelect, rows: [][]any{{"Ada", "ada", fixedNow}}},
	}}
	if err := (&Store{DB: db}).CompleteProfile(context.Background(), userID); err != nil {
		t.Fatalf("already-complete should be a no-op, got %v", err)
	}
}

func TestCompleteProfileConcurrentWinnerIsNoop(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: completeSelect, rows: [][]any{{"Ada", "ada", nil}}},
		{match: completeUpdate, err: pgx.ErrNoRows},
	}}
	if err := (&Store{DB: db}).CompleteProfile(context.Background(), userID); err != nil {
		t.Fatalf("a race that lost the UPDATE should be a no-op, got %v", err)
	}
}

func TestCompleteProfileRejectsEmptyName(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: completeSelect, rows: [][]any{{"   ", "ada", nil}}},
	}}
	err := (&Store{DB: db}).CompleteProfile(context.Background(), userID)
	var te *tenancy.Error
	if !errors.As(err, &te) || te.Status != 422 {
		t.Fatalf("err = %v, want 422 for blank name", err)
	}
}

func TestCompleteProfileRejectsBadUsername(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: completeSelect, rows: [][]any{{"Ada", "not a valid handle", nil}}},
	}}
	err := (&Store{DB: db}).CompleteProfile(context.Background(), userID)
	var te *tenancy.Error
	if !errors.As(err, &te) || te.Status != 422 {
		t.Fatalf("err = %v, want 422 for bad username", err)
	}
}

func TestCompleteProfileMissingUserIs401(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: completeSelect, err: pgx.ErrNoRows},
	}}
	err := (&Store{DB: db}).CompleteProfile(context.Background(), userID)
	var te *tenancy.Error
	if !errors.As(err, &te) || te.Status != 401 {
		t.Fatalf("err = %v, want 401", err)
	}
}

// ── HTTP surface ─────────────────────────────────────────────────────────────

func authed(r *http.Request) *http.Request {
	ctx := httpapi.ContextWithClaims(r.Context(), auth.Claims{UserID: userID})
	return r.WithContext(ctx)
}

func TestHandlerSnapshotOK(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: profileMatch, rows: [][]any{{"Ada", "ada", "ada@example.com", nil, nil}}},
	}}
	h := &Handler{Store: &Store{DB: db}}
	rec := httptest.NewRecorder()
	h.snapshot(rec, authed(httptest.NewRequest(http.MethodGet, "/api/v1/onboarding", nil)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body Snapshot
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.NextStep != StepProfile {
		t.Errorf("next step = %q, want %q", body.NextStep, StepProfile)
	}
}

func TestHandlerSnapshotUnauthenticatedIs401(t *testing.T) {
	h := &Handler{Store: &Store{DB: &fakeDB{}}}
	rec := httptest.NewRecorder()
	h.snapshot(rec, httptest.NewRequest(http.MethodGet, "/api/v1/onboarding", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestHandlerSnapshotMapsStoreError(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: profileMatch, err: pgx.ErrNoRows},
	}}
	h := &Handler{Store: &Store{DB: db}}
	rec := httptest.NewRecorder()
	h.snapshot(rec, authed(httptest.NewRequest(http.MethodGet, "/api/v1/onboarding", nil)))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 from tenancy error", rec.Code)
	}
}

func TestHandlerCompleteProfileOK(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: completeSelect, rows: [][]any{{"Ada", "ada", fixedNow}}},
	}}
	h := &Handler{Store: &Store{DB: db}}
	rec := httptest.NewRecorder()
	h.completeProfile(rec, authed(httptest.NewRequest(http.MethodPost, "/api/v1/onboarding/profile/complete", nil)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"completed":true`) {
		t.Errorf("body = %s", rec.Body.String())
	}
}

func TestHandlerCompleteProfileMapsValidationError(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: completeSelect, rows: [][]any{{"  ", "ada", nil}}},
	}}
	h := &Handler{Store: &Store{DB: db}}
	rec := httptest.NewRecorder()
	h.completeProfile(rec, authed(httptest.NewRequest(http.MethodPost, "/api/v1/onboarding/profile/complete", nil)))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422", rec.Code)
	}
}

func TestHandlerCompleteProfileUnauthenticatedIs401(t *testing.T) {
	h := &Handler{Store: &Store{DB: &fakeDB{}}}
	rec := httptest.NewRecorder()
	h.completeProfile(rec, httptest.NewRequest(http.MethodPost, "/api/v1/onboarding/profile/complete", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestRegisterMountsRoutes(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: profileMatch, rows: [][]any{{"Ada", "ada", "ada@example.com", nil, nil}}},
	}}
	h := &Handler{Store: &Store{DB: db}}
	mux := http.NewServeMux()
	// withAuth injects claims so the mounted handler has a caller.
	h.Register(mux, func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, authed(r))
		})
	})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/onboarding", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/v1/onboarding via mux = %d, want 200", rec.Code)
	}
}
