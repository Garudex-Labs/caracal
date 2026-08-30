// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package tenancy

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TestLiveResolve exercises the database paths against a real schema.
// Gated: set CARACAL_TEST_PG_URL to a database seeded with the e2e users
// and the reg-diff org/project fixtures.
func TestLiveResolve(t *testing.T) {
	url := os.Getenv("CARACAL_TEST_PG_URL")
	if url == "" {
		t.Skip("CARACAL_TEST_PG_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	r := &Resolver{DB: pool}

	var adminID, userID uuid.UUID
	var adminName, userName string
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(pool.QueryRow(ctx, `SELECT id, COALESCE(username, '') FROM users WHERE email='e2e@example.com'`).Scan(&adminID, &adminName))
	must(pool.QueryRow(ctx, `SELECT id, COALESCE(username, '') FROM users WHERE email='fb-diff@example.com'`).Scan(&userID, &userName))
	admin := User{ID: adminID, Username: adminName, Email: "e2e@example.com", Role: "operator"}
	member := User{ID: userID, Username: userName, Email: "fb-diff@example.com", Role: "user"}

	// Personal private publish: creator-only scope with an owning project.
	if member.Username != "" {
		target, err := r.ResolvePublishTarget(ctx, member, "Secret Notes", PublishOptions{Visibility: "private"})
		if err != nil {
			t.Fatalf("private publish: %v", err)
		}
		if target.Scope() != "private" || !target.AutoApprove || target.ProjectID == nil {
			t.Fatalf("private target = %+v", target)
		}
	}

	// Explicit project selection by a non-member reads as nonexistent.
	bogus := uuid.New()
	_, err = r.ResolvePublishTarget(ctx, member, "Thing Two", PublishOptions{ProjectID: &bogus})
	var te *Error
	if ok := errors.As(err, &te); member.Username != "" && (!ok || te.Status != 404 || te.Detail != "Project not found") {
		t.Fatalf("explicit project: %v", err)
	}

	// Project visibility binds to a real project the caller belongs to.
	if _, err := r.ResolvePublishTarget(ctx, member, "Shared Tool", PublishOptions{Visibility: "project", ProjectID: &bogus}); err == nil {
		t.Fatal("project publish into a nonexistent project accepted")
	}

	// Review scope: the plain member holds no reviewing role.
	scope, err := r.ReviewScopeFor(ctx, member)
	if err != nil || !scope.IsEmpty() {
		t.Fatalf("member scope = %+v %v", scope, err)
	}
	someProject := uuid.New()
	adminScope, err := r.ReviewScopeFor(ctx, admin)
	if err != nil || !adminScope.IsGlobalReviewer || adminScope.CanReview(&someProject, true) {
		t.Fatalf("admin scope = %+v %v", adminScope, err)
	}
}
