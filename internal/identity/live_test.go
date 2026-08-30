// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package identity

import (
	"context"
	"errors"
	"os"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/garudex-labs/caracal/internal/auth"
)

// TestLiveProvisioning exercises first-contact account provisioning against
// a real schema. Gated: set CARACAL_TEST_PG_URL. All rows it creates are
// removed on cleanup.
func TestLiveProvisioning(t *testing.T) {
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
	d := &Directory{DB: pool}

	cleanupUser := func(id uuid.UUID) {
		t.Cleanup(func() {
			_, _ = pool.Exec(ctx, `DELETE FROM organization_memberships WHERE user_id = $1`, id)
			_, _ = pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, id)
		})
	}

	t.Run("first contact provisions an account with no implicit membership", func(t *testing.T) {
		subject := uuid.New()
		claims := auth.Claims{UserID: subject, Role: "user", Email: "live-prov-" + subject.String()[:8] + "@example.com", Name: "Live Prov"}
		id, err := d.ResolveActive(ctx, claims)
		if err != nil {
			t.Fatalf("provision: %v", err)
		}
		cleanupUser(id)

		var username, name, role, provider string
		if err := pool.QueryRow(ctx,
			`SELECT username, name, role::text, auth_provider FROM users WHERE id = $1`, id,
		).Scan(&username, &name, &role, &provider); err != nil {
			t.Fatalf("read back: %v", err)
		}
		if provider != "better-auth" || role != "user" || name != "Live Prov" || username == "" {
			t.Fatalf("row = %s/%s/%s/%s", username, name, role, provider)
		}

		// Organization membership only comes from creating an org or
		// accepting an invitation; provisioning must not grant one.
		var member bool
		_ = pool.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM organization_memberships WHERE user_id = $1)`, id).Scan(&member)
		if member {
			t.Fatal("provisioning granted an implicit org membership")
		}

		// A fresh account starts with the onboarding profile stage open.
		var completed *string
		_ = pool.QueryRow(ctx,
			`SELECT profile_completed_at::text FROM users WHERE id = $1`, id).Scan(&completed)
		if completed != nil {
			t.Fatal("fresh account has profile_completed_at set")
		}

		// Second contact resolves the same account without a second row.
		again, err := d.ResolveActive(ctx, claims)
		if err != nil || again != id {
			t.Fatalf("re-resolve = %s, %v; want %s, nil", again, err, id)
		}
	})

	t.Run("adoption links a pre-identity account by e-mail", func(t *testing.T) {
		legacyID := uuid.New()
		email := "live-adopt-" + legacyID.String()[:8] + "@example.com"
		if _, err := pool.Exec(ctx,
			`INSERT INTO users (id, email, username, name, role, auth_provider, created_at)
			 VALUES ($1, $2, $3, 'Legacy', 'user', 'local', now())`,
			legacyID, email, "adopt-"+legacyID.String()[:8]); err != nil {
			t.Fatal(err)
		}
		cleanupUser(legacyID)

		subject := uuid.New()
		id, err := d.ResolveActive(ctx, auth.Claims{UserID: subject, Role: "user", Email: email})
		if err != nil || id != legacyID {
			t.Fatalf("adopt = %s, %v; want %s, nil", id, err, legacyID)
		}
		var linked string
		_ = pool.QueryRow(ctx, `SELECT auth_subject_id FROM users WHERE id = $1`, legacyID).Scan(&linked)
		if linked != subject.String() {
			t.Fatalf("linked subject = %q, want %q", linked, subject)
		}

		// A different subject presenting the same e-mail is refused.
		_, err = d.ResolveActive(ctx, auth.Claims{UserID: uuid.New(), Role: "user", Email: email})
		if !errors.Is(err, ErrUnknownUser) {
			t.Fatalf("foreign subject err = %v, want ErrUnknownUser", err)
		}
	})

	t.Run("concurrent first contacts provision exactly one account", func(t *testing.T) {
		subject := uuid.New()
		claims := auth.Claims{UserID: subject, Role: "user", Email: "live-race-" + subject.String()[:8] + "@example.com"}
		const workers = 8
		ids := make([]uuid.UUID, workers)
		errs := make([]error, workers)
		var wg sync.WaitGroup
		for i := range workers {
			wg.Add(1)
			go func() {
				defer wg.Done()
				ids[i], errs[i] = d.ResolveActive(ctx, claims)
			}()
		}
		wg.Wait()
		var winner uuid.UUID
		for i := range workers {
			if errs[i] != nil {
				t.Fatalf("worker %d: %v", i, errs[i])
			}
			if winner == uuid.Nil {
				winner = ids[i]
			} else if ids[i] != winner {
				t.Fatalf("worker %d resolved %s, others %s", i, ids[i], winner)
			}
		}
		cleanupUser(winner)
		var rows int
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE auth_subject_id = $1`, subject.String()).Scan(&rows)
		if rows != 1 {
			t.Fatalf("account rows = %d, want 1", rows)
		}
	})

	t.Run("deactivated accounts stay blocked", func(t *testing.T) {
		subject := uuid.New()
		id := uuid.New()
		if _, err := pool.Exec(ctx,
			`INSERT INTO users (id, email, username, name, role, auth_provider, auth_subject_id, created_at)
			 VALUES ($1, $2, $3, 'Gone', 'user', 'deactivated', $4, now())`,
			id, "live-deact-"+id.String()[:8]+"@example.com", "deact-"+id.String()[:8], subject.String()); err != nil {
			t.Fatal(err)
		}
		cleanupUser(id)
		_, err := d.ResolveActive(ctx, auth.Claims{UserID: subject, Role: "user", Email: "other@example.com"})
		if !errors.Is(err, ErrDeactivated) {
			t.Fatalf("err = %v, want ErrDeactivated", err)
		}
	})

	t.Run("username collision falls through to a suffixed handle", func(t *testing.T) {
		holder := uuid.New()
		local := "live-coll-" + holder.String()[:8]
		if _, err := pool.Exec(ctx,
			`INSERT INTO users (id, email, username, name, role, auth_provider, created_at)
			 VALUES ($1, $2, $3, 'Holder', 'user', 'local', now())`,
			holder, local+"-holder@example.com", local); err != nil {
			t.Fatal(err)
		}
		cleanupUser(holder)

		subject := uuid.New()
		id, err := d.ResolveActive(ctx, auth.Claims{UserID: subject, Role: "user", Email: local + "@example.com"})
		if err != nil {
			t.Fatalf("provision with collision: %v", err)
		}
		cleanupUser(id)
		var username string
		_ = pool.QueryRow(ctx, `SELECT username FROM users WHERE id = $1`, id).Scan(&username)
		if username == local || username == "" {
			t.Fatalf("username = %q, want a suffixed variant of %q", username, local)
		}
	})
}
