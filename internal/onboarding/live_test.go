// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package onboarding

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/garudex-labs/caracal/internal/tenancy"
)

// TestLiveOnboardingDerivation walks a fresh account through the derived
// onboarding steps against a real schema. Gated: set CARACAL_TEST_PG_URL.
func TestLiveOnboardingDerivation(t *testing.T) {
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
	s := &Store{DB: pool}

	userID := uuid.New()
	email := fmt.Sprintf("live-onb-%s@example.com", userID.String()[:8])
	if _, err := pool.Exec(ctx,
		`INSERT INTO users (id, email, username, name, role, auth_provider, created_at)
		 VALUES ($1, $2, $3, 'Live Onb', 'user', 'local', now())`,
		userID, email, "live-onb-"+userID.String()[:8]); err != nil {
		t.Fatal(err)
	}
	orgID, projectID := uuid.New(), uuid.New()
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM project_memberships WHERE organization_id = $1`, orgID)
		_, _ = pool.Exec(ctx, `DELETE FROM projects WHERE organization_id = $1`, orgID)
		_, _ = pool.Exec(ctx, `DELETE FROM organization_memberships WHERE organization_id = $1`, orgID)
		_, _ = pool.Exec(ctx, `DELETE FROM organizations WHERE id = $1`, orgID)
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID)
	})

	// A newly provisioned account starts at the profile stage.
	snap, err := s.Snapshot(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if snap.NextStep != StepProfile || snap.Profile.Completed {
		t.Fatalf("fresh account = %s/%v, want profile stage", snap.NextStep, snap.Profile.Completed)
	}

	// Completing the profile is idempotent and moves to the org stage.
	if err := s.CompleteProfile(ctx, userID); err != nil {
		t.Fatal(err)
	}
	if err := s.CompleteProfile(ctx, userID); err != nil {
		t.Fatalf("repeat complete = %v, want nil", err)
	}
	snap, _ = s.Snapshot(ctx, userID)
	if snap.NextStep != StepOrganization {
		t.Fatalf("after profile = %s, want organization", snap.NextStep)
	}

	// Org membership without project access is the no-access project stage.
	slug := "live-onb-" + uuid.NewString()[:8]
	if _, err := pool.Exec(ctx,
		`INSERT INTO organizations (id, slug, name, created_at, updated_at) VALUES ($1, $2, 'Live', now(), now())`,
		orgID, slug); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO organization_memberships (id, organization_id, user_id, role, created_at)
		 VALUES ($1, $2, $3, 'member', now())`, uuid.New(), orgID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO projects (id, organization_id, slug, name, is_default, created_at, updated_at)
		 VALUES ($1, $2, $3, 'Live', true, now(), now())`, projectID, orgID, slug); err != nil {
		t.Fatal(err)
	}
	snap, _ = s.Snapshot(ctx, userID)
	if snap.NextStep != StepProject {
		t.Fatalf("member without access = %s, want project", snap.NextStep)
	}
	if len(snap.Organizations) != 1 || len(snap.Organizations[0].Projects) != 0 {
		t.Fatalf("organizations = %+v, want the org with zero accessible projects", snap.Organizations)
	}

	// Granting project membership completes onboarding; revoking it returns
	// the user to the no-access state (stale context is never preserved).
	if _, err := pool.Exec(ctx,
		`INSERT INTO project_memberships (id, project_id, organization_id, user_id, role, created_at)
		 VALUES ($1, $2, $3, $4, 'user', now())`, uuid.New(), projectID, orgID, userID); err != nil {
		t.Fatal(err)
	}
	snap, _ = s.Snapshot(ctx, userID)
	if snap.NextStep != StepDone {
		t.Fatalf("after grant = %s, want done", snap.NextStep)
	}
	if len(snap.Organizations[0].Projects) != 1 || !snap.Organizations[0].Projects[0].IsDefault {
		t.Fatalf("projects = %+v, want the default project", snap.Organizations[0].Projects)
	}
	if _, err := pool.Exec(ctx,
		`DELETE FROM project_memberships WHERE project_id = $1 AND user_id = $2`, projectID, userID); err != nil {
		t.Fatal(err)
	}
	snap, _ = s.Snapshot(ctx, userID)
	if snap.NextStep != StepProject {
		t.Fatalf("after revocation = %s, want project (no-access state)", snap.NextStep)
	}

	// Unknown callers fail closed.
	if _, err := s.Snapshot(ctx, uuid.New()); err == nil {
		t.Fatal("snapshot for unknown user succeeded")
	} else {
		var te *tenancy.Error
		if !errors.As(err, &te) || te.Status != 401 {
			t.Fatalf("unknown user err = %v, want 401", err)
		}
	}
}
