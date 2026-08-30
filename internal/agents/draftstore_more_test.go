// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/tenancy"
)

func countLog(log []string, fragment string) int {
	n := 0
	for _, sql := range log {
		if strings.Contains(sql, fragment) {
			n++
		}
	}
	return n
}

func TestReplaceComponentsRewritesLinks(t *testing.T) {
	db := &fakeDB{}
	s := &Store{DB: db}
	refs := []componentRef{
		{ComponentType: "mcp", ComponentID: "aaaaaaaa-1111"},
		{ComponentType: "skill", ComponentID: "bbbbbbbb-2222"},
	}
	overrides := []map[string]any{{"k": "v"}, nil}
	resolved := map[string]string{"mcp/aaaaaaaa-1111": "1.2.0"}
	if err := replaceComponents(context.Background(), db, s, versionID, refs, overrides, false, resolved); err != nil {
		t.Fatalf("replaceComponents: %v", err)
	}
	if countLog(db.log, "DELETE FROM agent_components WHERE agent_version_id = $1") != 1 {
		t.Errorf("expected one unconstrained delete: %v", db.log)
	}
	for _, sql := range db.log {
		if strings.HasPrefix(sql, "DELETE") && strings.Contains(sql, "component_type = 'mcp'") {
			t.Errorf("full replace must not scope the delete to mcp: %s", sql)
		}
	}
	if countLog(db.log, "INSERT INTO agent_components") != 2 {
		t.Errorf("expected two inserts: %v", db.log)
	}
}

func TestReplaceComponentsMcpOnlyScopesDelete(t *testing.T) {
	db := &fakeDB{}
	s := &Store{DB: db}
	refs := []componentRef{{ComponentType: "mcp", ComponentID: "aaaaaaaa-1111"}}
	if err := replaceComponents(context.Background(), db, s, versionID, refs, nil, true, nil); err != nil {
		t.Fatalf("replaceComponents: %v", err)
	}
	scoped := false
	for _, sql := range db.log {
		if strings.HasPrefix(sql, "DELETE") && strings.Contains(sql, "AND component_type = 'mcp'") {
			scoped = true
		}
	}
	if !scoped {
		t.Errorf("mcp-only replace must scope the delete: %v", db.log)
	}
}

func TestResolveCurrentVersionsMapsListings(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "FROM mcp_listings", rows: &fakeRows{
			cols: []string{"id", "version"}, rows: [][]any{{"aaaaaaaa-1111", "1.2.0"}}}},
		{match: "FROM skill_listings", rows: &fakeRows{
			cols: []string{"id", "version", "slash"}, rows: [][]any{{"bbbbbbbb-2222", "0.3.0", "/review"}}}},
	}}
	s := &Store{DB: db}
	refs := []componentRef{
		{ComponentType: "mcp", ComponentID: "aaaaaaaa-1111"},
		{ComponentType: "skill", ComponentID: "bbbbbbbb-2222"},
	}
	versions, skillSlash, err := s.resolveCurrentVersions(context.Background(), refs)
	if err != nil {
		t.Fatalf("resolveCurrentVersions: %v", err)
	}
	if versions["mcp/aaaaaaaa-1111"] != "1.2.0" || versions["skill/bbbbbbbb-2222"] != "0.3.0" {
		t.Errorf("versions: %v", versions)
	}
	if !skillSlash["bbbbbbbb-2222"] {
		t.Errorf("skill slash command not detected: %v", skillSlash)
	}
}

func TestRefreshInferenceWritesCapabilities(t *testing.T) {
	mcpID := "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
	db := &fakeDB{stubs: []stub{
		{match: "FROM agent_components WHERE agent_version_id", rows: &fakeRows{cols: linkCols, rows: [][]any{
			{"mcp", mcpID, "github-mcp", "1.2.0", int64(0), nil},
		}}},
		{match: "l.name, l.namespace, l.slug, v.status", rows: &fakeRows{cols: refCols, rows: [][]any{
			{mcpID, "github-mcp", "acme", "github-mcp", "approved"},
		}}},
	}}
	s := &Store{DB: db}
	if err := s.refreshInference(context.Background(), versionID, []any{}); err != nil {
		t.Fatalf("refreshInference: %v", err)
	}
	wrote := false
	for _, sql := range db.log {
		if strings.Contains(sql, "SET required_capabilities") && strings.Contains(sql, "inferred_supported_harnesses") {
			wrote = true
		}
	}
	if !wrote {
		t.Errorf("no capability update issued: %v", db.log)
	}
}

func TestRefreshSnapshotRebuildsYAML(t *testing.T) {
	snapCols := []string{
		"version", "description", "prompt", "model_name", "models_by_harness",
		"external_mcps", "supported_harnesses", "model_config_json", "success_criteria",
	}
	db := &fakeDB{stubs: []stub{
		{match: "FROM agent_versions v WHERE v.id", rows: &fakeRows{cols: snapCols, rows: [][]any{{
			"1.0.0", "reviews code", "You review code.", "claude-sonnet-4-5",
			map[string]any{}, []any{}, []any{"kiro"}, map[string]any{}, nil,
		}}}},
		{match: "FROM agent_components WHERE agent_version_id", rows: &fakeRows{cols: linkCols, rows: [][]any{}}},
	}}
	s := &Store{DB: db}
	if err := s.refreshSnapshot(context.Background(), versionID); err != nil {
		t.Fatalf("refreshSnapshot: %v", err)
	}
	if countLog(db.log, "SET yaml_snapshot = $1") != 1 {
		t.Errorf("no snapshot update issued: %v", db.log)
	}
}

func TestRefreshSnapshotMissingVersionErrors(t *testing.T) {
	db := &fakeDB{}
	s := &Store{DB: db}
	err := s.refreshSnapshot(context.Background(), versionID)
	if err == nil || !strings.Contains(err.Error(), "not found") {
		t.Errorf("missing version must error: %v", err)
	}
}

func TestReleaseEditLockClears(t *testing.T) {
	db := &fakeDB{}
	s := &Store{DB: db}
	if err := s.ReleaseEditLock(context.Background(), versionID); err != nil {
		t.Fatalf("ReleaseEditLock: %v", err)
	}
	cleared := false
	for _, sql := range db.log {
		if strings.Contains(sql, "is_editing = false") && strings.Contains(sql, "editing_by = NULL") {
			cleared = true
		}
	}
	if !cleared {
		t.Errorf("lock not cleared: %v", db.log)
	}
}

func TestEditLockStateReadsRow(t *testing.T) {
	locker := uuid.MustParse(outsiderID)
	when := time.Now()
	db := &richDB{stubs: []richStub{
		{match: "SELECT is_editing", rows: &richRows{
			cols: []string{"is_editing", "editing_by", "editing_since"},
			rows: [][]any{{true, locker, when}}}},
	}}
	s := &Store{DB: db}
	editing, by, since, err := s.editLockState(context.Background(), versionID)
	if err != nil {
		t.Fatalf("editLockState: %v", err)
	}
	if !editing || by == nil || *by != locker || since == nil {
		t.Errorf("lock state: editing=%v by=%v since=%v", editing, by, since)
	}

	free := &richDB{stubs: []richStub{
		{match: "SELECT is_editing", rows: &richRows{
			cols: []string{"is_editing", "editing_by", "editing_since"},
			rows: [][]any{{false, nil, nil}}}},
	}}
	s = &Store{DB: free}
	editing, by, since, err = s.editLockState(context.Background(), versionID)
	if err != nil || editing || by != nil || since != nil {
		t.Errorf("free lock: editing=%v by=%v since=%v err=%v", editing, by, since, err)
	}
}

func TestAcquireEditLockBranches(t *testing.T) {
	lockRow := func(editing bool, by any, since any) []richStub {
		return []richStub{
			{match: "SELECT is_editing", rows: &richRows{
				cols: []string{"is_editing", "editing_by", "editing_since"},
				rows: [][]any{{editing, by, since}}}},
		}
	}

	// A free version can be locked.
	db := &richDB{stubs: lockRow(false, nil, nil)}
	if err := (&Store{DB: db}).AcquireEditLock(context.Background(), versionID, uuid.MustParse(viewerID)); err != nil {
		t.Fatalf("free lock acquire: %v", err)
	}
	if countLog(db.log, "is_editing = true") != 1 {
		t.Errorf("lock not written: %v", db.log)
	}

	// A live foreign lock refuses with 409.
	other := uuid.MustParse(outsiderID)
	db = &richDB{stubs: lockRow(true, other, time.Now())}
	err := (&Store{DB: db}).AcquireEditLock(context.Background(), versionID, uuid.MustParse(viewerID))
	var inst *errInstall
	if !errors.As(err, &inst) || inst.status != 409 {
		t.Fatalf("foreign lock must be 409: %v", err)
	}

	// The same holder may re-acquire.
	self := uuid.MustParse(viewerID)
	db = &richDB{stubs: lockRow(true, self, time.Now())}
	if err := (&Store{DB: db}).AcquireEditLock(context.Background(), versionID, self); err != nil {
		t.Errorf("self re-acquire: %v", err)
	}

	// An expired foreign lock is takeable.
	db = &richDB{stubs: lockRow(true, other, time.Now().Add(-editLockTTL-time.Minute))}
	if err := (&Store{DB: db}).AcquireEditLock(context.Background(), versionID, self); err != nil {
		t.Errorf("expired lock takeover: %v", err)
	}
}

func TestAuthorizeVisibilityChangeGates(t *testing.T) {
	ctx := context.Background()
	projectID := "44444444-4444-4444-4444-444444444444"
	user := tenancy.User{ID: uuid.MustParse(viewerID), Role: "user"}

	// No project context: nothing to authorize.
	if err := (&Store{DB: &fakeDB{}}).authorizeVisibilityChange(ctx, map[string]any{}, user, true); err != nil {
		t.Errorf("public agent must skip the check: %v", err)
	}

	// Operators bypass the lead requirement.
	op := tenancy.User{ID: uuid.MustParse(outsiderID), Role: "operator"}
	if err := (&Store{DB: &fakeDB{}}).authorizeVisibilityChange(ctx,
		map[string]any{"project_id": projectID}, op, true); err != nil {
		t.Errorf("operator must bypass: %v", err)
	}

	// A malformed project id is rejected before any query.
	badDB := &fakeDB{}
	err := (&Store{DB: badDB}).authorizeVisibilityChange(ctx,
		map[string]any{"project_id": "not-a-uuid"}, user, true)
	var inst *errInstall
	if !errors.As(err, &inst) || inst.status != 403 {
		t.Fatalf("bad project id must be 403: %v", err)
	}
	if len(badDB.log) != 0 {
		t.Errorf("bad id must not reach the database: %v", badDB.log)
	}

	// A project lead is authorized.
	leadDB := &fakeDB{stubs: []stub{
		{match: "FROM project_memberships", rows: &fakeRows{cols: []string{"role"}, rows: [][]any{{"lead"}}}},
	}}
	if err := (&Store{DB: leadDB}).authorizeVisibilityChange(ctx,
		map[string]any{"project_id": projectID}, user, false); err != nil {
		t.Errorf("project lead must pass: %v", err)
	}

	// A non-lead member is refused.
	memberDB := &fakeDB{stubs: []stub{
		{match: "FROM project_memberships", rows: &fakeRows{cols: []string{"role"}, rows: [][]any{{"member"}}}},
	}}
	err = (&Store{DB: memberDB}).authorizeVisibilityChange(ctx,
		map[string]any{"project_id": projectID}, user, false)
	if !errors.As(err, &inst) || inst.status != 403 {
		t.Fatalf("non-lead must be 403: %v", err)
	}

	// A non-member is refused as well.
	err = (&Store{DB: &fakeDB{}}).authorizeVisibilityChange(ctx,
		map[string]any{"project_id": projectID}, user, false)
	if !errors.As(err, &inst) || inst.status != 403 {
		t.Fatalf("non-member must be 403: %v", err)
	}
}
