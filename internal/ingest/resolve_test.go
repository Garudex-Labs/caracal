// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package ingest

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type fakeResolveRow struct {
	value string
	err   error
}

func (r fakeResolveRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	*dest[0].(*string) = r.value
	return nil
}

type fakeResolveDB struct {
	rows     map[string]fakeResolveRow
	versions map[string]fakeResolveRow
	queries  int
}

func (f *fakeResolveDB) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	f.queries++
	rows := f.rows
	if strings.Contains(sql, "agent_versions") {
		rows = f.versions
	}
	if row, ok := rows[args[len(args)-1].(string)]; ok {
		return row
	}
	return fakeResolveRow{err: pgx.ErrNoRows}
}

type memCache struct {
	entries map[string]string
}

func newMemCache() *memCache { return &memCache{entries: map[string]string{}} }

func (c *memCache) Get(_ context.Context, key string) (string, bool) {
	v, ok := c.entries[key]
	return v, ok
}

func (c *memCache) Set(_ context.Context, key, value string, _ time.Duration) {
	c.entries[key] = value
}

func strp(s string) *string { return &s }

func TestResolveAgentNameToUUID(t *testing.T) {
	registryID := uuid.NewString()
	db := &fakeResolveDB{rows: map[string]fakeResolveRow{"reviewer": {value: registryID}}}
	r := &AgentResolver{DB: db, Cache: newMemCache()}

	id, version := r.Resolve(context.Background(), "project-1", strp("reviewer"), strp("1.2.0"))
	if id == nil || *id != registryID {
		t.Errorf("id = %v, want %s", id, registryID)
	}
	if version == nil || *version != "1.2.0" {
		t.Errorf("version = %v", version)
	}

	// Second resolution must come from the cache.
	before := db.queries
	if id, _ = r.Resolve(context.Background(), "project-1", strp("reviewer"), nil); *id != registryID {
		t.Errorf("cached id = %v", id)
	}
	if db.queries != before {
		t.Errorf("cache miss caused %d extra queries", db.queries-before)
	}
}

func TestResolveEmptyAttributionSkipsDatabase(t *testing.T) {
	db := &fakeResolveDB{}
	r := &AgentResolver{DB: db, Cache: newMemCache()}

	tests := []struct {
		name    string
		id      *string
		version *string
	}{
		{"nil id", nil, nil},
		{"empty id", strp(""), nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			id, version := r.Resolve(context.Background(), "project-1", tc.id, tc.version)
			if id != nil || !equalPtr(version, tc.version) {
				t.Errorf("Resolve = (%v, %v), want unattributed", id, version)
			}
		})
	}
	if db.queries != 0 {
		t.Errorf("passthrough cases hit the database %d times", db.queries)
	}
}

func TestResolveUnknownNameCachesTheMiss(t *testing.T) {
	db := &fakeResolveDB{}
	r := &AgentResolver{DB: db, Cache: newMemCache()}

	for range 3 {
		id, _ := r.Resolve(context.Background(), "project-1", strp("ghost"), nil)
		if id != nil {
			t.Errorf("unknown name must be unattributed, got %v", id)
		}
	}
	if db.queries != 1 {
		t.Errorf("miss not cached: %d queries", db.queries)
	}
}

func TestResolveUUIDMustBelongToProject(t *testing.T) {
	agentID := uuid.NewString()
	db := &fakeResolveDB{rows: map[string]fakeResolveRow{agentID: {value: agentID}}}
	r := &AgentResolver{DB: db, Cache: newMemCache()}
	id, version := r.Resolve(context.Background(), "project-1", strp(agentID), strp("1.2.0"))
	if id == nil || *id != agentID || version == nil || *version != "1.2.0" {
		t.Fatalf("same-project UUID = (%v, %v)", id, version)
	}

	foreign := &AgentResolver{DB: &fakeResolveDB{}, Cache: newMemCache()}
	id, _ = foreign.Resolve(context.Background(), "project-2", strp(agentID), nil)
	if id != nil {
		t.Fatalf("foreign UUID must be unattributed: %v", id)
	}
}

func TestResolveLatestVersionAlias(t *testing.T) {
	agentID := uuid.NewString()
	db := &fakeResolveDB{
		rows:     map[string]fakeResolveRow{agentID: {value: agentID}},
		versions: map[string]fakeResolveRow{agentID: {value: "3.1.4"}},
	}
	r := &AgentResolver{DB: db, Cache: newMemCache()}

	_, version := r.Resolve(context.Background(), "project-1", strp(agentID), strp("latest"))
	if version == nil || *version != "3.1.4" {
		t.Errorf("version = %v, want 3.1.4", version)
	}

	before := db.queries
	if _, version = r.Resolve(context.Background(), "project-1", strp(agentID), strp("latest")); *version != "3.1.4" {
		t.Errorf("cached version = %v", version)
	}
	if db.queries != before {
		t.Error("latest alias resolution not cached")
	}
}

func TestResolveDatabaseErrorFailsClosed(t *testing.T) {
	db := &fakeResolveDB{rows: map[string]fakeResolveRow{"reviewer": {err: errors.New("conn refused")}}}
	r := &AgentResolver{DB: db, Cache: newMemCache()}

	id, _ := r.Resolve(context.Background(), "project-1", strp("reviewer"), nil)
	if id != nil {
		t.Errorf("id = %v, want unattributed", id)
	}
}

func equalPtr(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
