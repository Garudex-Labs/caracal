// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package accounts

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// liveTx opens a transaction against CARACAL_TEST_PG_URL that is always rolled
// back, so the username-change flow runs against the real schema and its
// namespace/slug uniqueness constraints without leaving residue.
func liveTx(t *testing.T) (context.Context, pgx.Tx, uuid.UUID) {
	t.Helper()
	dsn := os.Getenv("CARACAL_TEST_PG_URL")
	if dsn == "" {
		t.Skip("CARACAL_TEST_PG_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(ctx) })
	var userID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT id FROM users ORDER BY created_at LIMIT 1`).Scan(&userID); err != nil {
		t.Skipf("no users seeded: %v", err)
	}
	return ctx, tx, userID
}

// TestLiveSetUsernameMigratesOwnedAgent proves a published Agent moves to the
// new personal namespace atomically, so ownership and namespace/slug URLs keep
// resolving after a rename.
func TestLiveSetUsernameMigratesOwnedAgent(t *testing.T) {
	ctx, tx, userID := liveTx(t)
	store := &Store{DB: tx}

	profile, err := store.Load(ctx, userID)
	if err != nil {
		t.Fatalf("load profile: %v", err)
	}
	old := profile.Username
	if old == "" {
		t.Skip("seeded user has no username")
	}

	agentID := uuid.NewString()
	if _, err := tx.Exec(ctx, `INSERT INTO agents
		(id, name, namespace, slug, owner, is_private, ownership_scope, co_authors,
		 created_by, created_at, updated_at)
		VALUES ($1, 'live rename probe', $2, 'live-rename-probe', $2, true, 'private',
		        '[]', $3, now(), now())`,
		agentID, old, userID); err != nil {
		t.Fatalf("seed agent: %v", err)
	}

	newName := "liverename" + strings.ToLower(uuid.NewString()[:6])
	fresh, err := store.SetUsername(ctx, profile, newName)
	if err != nil {
		t.Fatalf("SetUsername: %v", err)
	}
	if fresh.Username != newName {
		t.Fatalf("profile username = %q, want %q", fresh.Username, newName)
	}

	var namespace, owner string
	if err := tx.QueryRow(ctx,
		`SELECT namespace, owner FROM agents WHERE id = $1`, agentID).Scan(&namespace, &owner); err != nil {
		t.Fatalf("reload agent: %v", err)
	}
	if namespace != newName || owner != newName {
		t.Fatalf("agent not migrated: namespace=%q owner=%q, want %q", namespace, owner, newName)
	}
}
