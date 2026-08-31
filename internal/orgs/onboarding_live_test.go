// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package orgs

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/garudex-labs/caracal/internal/tenancy"
)

// livePool connects when CARACAL_TEST_PG_URL is set, else skips.
func livePool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("CARACAL_TEST_PG_URL")
	if url == "" {
		t.Skip("CARACAL_TEST_PG_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func liveUser(t *testing.T, pool *pgxpool.Pool, tag string) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	id := uuid.New()
	email := fmt.Sprintf("live-%s-%s@example.com", tag, id.String()[:8])
	if _, err := pool.Exec(ctx,
		`INSERT INTO users (id, email, username, name, role, auth_provider, created_at)
		 VALUES ($1, $2, $3, 'Live', 'user', 'local', now())`,
		id, email, "live-"+tag+"-"+id.String()[:8]); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM organization_memberships WHERE user_id = $1`, id)
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, id)
	})
	return id
}

func liveOrg(t *testing.T, pool *pgxpool.Pool, s *Store, owner uuid.UUID) (*Org, *Project) {
	t.Helper()
	ctx := context.Background()
	slug := "live-" + uuid.NewString()[:8]
	org, def, err := s.CreateOrg(ctx, pool, owner, slug, "Live Org "+slug, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM org_invitations WHERE organization_id = $1`, org.ID)
		_, _ = pool.Exec(ctx, `DELETE FROM project_memberships WHERE organization_id = $1`, org.ID)
		_, _ = pool.Exec(ctx, `DELETE FROM projects WHERE organization_id = $1`, org.ID)
		_, _ = pool.Exec(ctx, `DELETE FROM organization_memberships WHERE organization_id = $1`, org.ID)
		_, _ = pool.Exec(ctx, `DELETE FROM organizations WHERE id = $1`, org.ID)
	})
	return org, def
}

func tenancyStatus(t *testing.T, err error, want int) {
	t.Helper()
	var te *tenancy.Error
	if !errors.As(err, &te) || te.Status != want {
		t.Fatalf("err = %v, want tenancy status %d", err, want)
	}
}

// TestLiveDefaultProjectInvariants pins the org/default-project lifecycle
// against a real schema. Gated: set CARACAL_TEST_PG_URL.
func TestLiveDefaultProjectInvariants(t *testing.T) {
	pool := livePool(t)
	s := &Store{DB: pool}
	ctx := context.Background()
	owner := liveUser(t, pool, "owner")
	org, def, err := func() (*Org, *Project, error) {
		slug := "live-" + uuid.NewString()[:8]
		return s.CreateOrg(ctx, pool, owner, slug, "Live", nil)
	}()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM project_memberships WHERE organization_id = $1`, org.ID)
		_, _ = pool.Exec(ctx, `DELETE FROM projects WHERE organization_id = $1`, org.ID)
		_, _ = pool.Exec(ctx, `DELETE FROM organization_memberships WHERE organization_id = $1`, org.ID)
		_, _ = pool.Exec(ctx, `DELETE FROM organizations WHERE id = $1`, org.ID)
	})

	if def == nil || !def.IsDefault || def.Slug != org.Slug || def.Name != org.Name {
		t.Fatalf("default project = %+v, want is_default named after the org", def)
	}
	// The default project starts with real membership rows so roster counts and
	// access-management views reflect the protected project's initial state.
	var memberCount int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM project_memberships WHERE project_id = $1`, def.ID).Scan(&memberCount)
	if memberCount != 1 {
		t.Fatalf("default project has %d membership rows, want 1", memberCount)
	}
	resolved, err := s.ResolveProject(ctx, org, def.Slug, owner)
	if err != nil || !resolved.IsDefault {
		t.Fatalf("owner resolve = %+v, %v; want default project access via org role", resolved, err)
	}
	member := liveUser(t, pool, "member")
	if err := s.UpsertOrgMember(ctx, org.ID, &TargetUser{ID: member}, "member"); err != nil {
		t.Fatal(err)
	}
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM project_memberships WHERE project_id = $1`, def.ID).Scan(&memberCount)
	if memberCount != 2 {
		t.Fatalf("default project after member add has %d membership rows, want 2", memberCount)
	}

	// A duplicate creation conflicts instead of duplicating anything.
	if _, _, err := s.CreateOrg(ctx, pool, owner, org.Slug, "Live again", nil); err == nil {
		t.Fatal("duplicate CreateOrg succeeded")
	} else {
		tenancyStatus(t, err, 409)
	}

	// The default project can never be deleted on its own.
	tenancyStatus(t, s.DeleteProject(ctx, pool, resolved), 409)

	// A second project blocks org deletion; once gone, the org and its
	// default project leave together.
	second, err := s.CreateProject(ctx, pool, org, owner, "workbench", "Workbench", nil)
	if err != nil {
		t.Fatal(err)
	}
	tenancyStatus(t, s.DeleteOrg(ctx, pool, org), 409)
	if err := s.DeleteProject(ctx, pool, second); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteOrg(ctx, pool, org); err != nil {
		t.Fatal(err)
	}
	var remaining int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM projects WHERE organization_id = $1`, org.ID).Scan(&remaining)
	if remaining != 0 {
		t.Fatalf("org deletion left %d project(s)", remaining)
	}
}

// TestLiveInvitationLifecycle pins invitation creation, idempotent accepts,
// and revocation semantics. Gated: set CARACAL_TEST_PG_URL.
func TestLiveInvitationLifecycle(t *testing.T) {
	pool := livePool(t)
	s := &Store{DB: pool}
	ctx := context.Background()
	owner := liveUser(t, pool, "inviter")
	invitee := liveUser(t, pool, "invitee")
	var inviteeEmail string
	_ = pool.QueryRow(ctx, `SELECT email FROM users WHERE id = $1`, invitee).Scan(&inviteeEmail)
	org, _ := liveOrg(t, pool, s, owner)

	inv, err := s.CreateInvitation(ctx, org.ID, inviteeEmail, "member", invitationTokenHash("tok-a"), "enc", owner)
	if err != nil {
		t.Fatal(err)
	}
	if inv.State(time.Now().UTC()) != "pending" {
		t.Fatalf("fresh invitation state = %s", inv.State(time.Now().UTC()))
	}

	// One live invitation per address: a second insert violates the partial
	// unique index instead of duplicating.
	if _, err := s.CreateInvitation(ctx, org.ID, inviteeEmail, "member", invitationTokenHash("tok-b"), "enc", owner); !isUnique(err) {
		t.Fatalf("duplicate create = %v, want unique violation", err)
	}
	live, err := s.LiveInvitation(ctx, org.ID, inviteeEmail)
	if err != nil || live == nil || live.ID != inv.ID {
		t.Fatalf("LiveInvitation = %+v, %v", live, err)
	}

	// Accepting twice yields exactly one membership and stays 200-equivalent.
	if err := s.AcceptInvitation(ctx, pool, inv, invitee); err != nil {
		t.Fatal(err)
	}
	if err := s.AcceptInvitation(ctx, pool, inv, invitee); err != nil {
		t.Fatalf("repeat accept = %v, want idempotent nil", err)
	}
	var memberships int
	_ = pool.QueryRow(ctx,
		`SELECT count(*) FROM organization_memberships WHERE organization_id = $1 AND user_id = $2`,
		org.ID, invitee).Scan(&memberships)
	if memberships != 1 {
		t.Fatalf("memberships = %d, want exactly 1", memberships)
	}

	// A different account can never consume the same invitation.
	stranger := liveUser(t, pool, "stranger")
	tenancyStatus(t, s.AcceptInvitation(ctx, pool, inv, stranger), 409)

	// Losing the membership closes the consumed invitation for good: re-entry
	// needs a fresh invitation, never a replay.
	if _, err := pool.Exec(ctx,
		`DELETE FROM organization_memberships WHERE organization_id = $1 AND user_id = $2`,
		org.ID, invitee); err != nil {
		t.Fatal(err)
	}
	tenancyStatus(t, s.AcceptInvitation(ctx, pool, inv, invitee), 409)

	// Accepted invitations can no longer be revoked; revoking a pending one
	// twice is a no-op.
	tenancyStatus(t, s.RevokeInvitation(ctx, org.ID, inv.ID), 409)
	pending, err := s.CreateInvitation(ctx, org.ID, "second-"+inviteeEmail, "admin", invitationTokenHash("tok-c"), "enc", owner)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.RevokeInvitation(ctx, org.ID, pending.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.RevokeInvitation(ctx, org.ID, pending.ID); err != nil {
		t.Fatalf("second revoke = %v, want idempotent nil", err)
	}
	// A revoked invitation cannot be accepted.
	tenancyStatus(t, s.AcceptInvitation(ctx, pool, pending, invitee), 409)
}
