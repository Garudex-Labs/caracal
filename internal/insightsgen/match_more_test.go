// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/registry"
)

func TestCatalogOfferAccounting(t *testing.T) {
	var offer *catalogOffer
	if !offer.empty() {
		t.Error("nil offer must read empty")
	}
	offer = &catalogOffer{enabled: true, entriesByType: map[string][]map[string]any{
		"skills": {{"id": "a"}, {"id": "b"}},
		"hooks":  {{"id": "c"}},
	}}
	if offer.itemCount() != 3 || offer.empty() {
		t.Errorf("itemCount = %d", offer.itemCount())
	}
	summary := offer.summary(2)
	if summary["enabled"] != true || summary["offered"] != 3 || summary["reused"] != 2 {
		t.Errorf("summary = %v", summary)
	}
	if summary["registry_has_components"] != nil {
		t.Errorf("unset probe must render null: %v", summary)
	}
	has := false
	offer.registryHasComponents = &has
	if got := offer.summary(0)["registry_has_components"]; got != false {
		t.Errorf("probe result = %v", got)
	}
}

func TestCatalogOfferPromptBlock(t *testing.T) {
	empty := &catalogOffer{}
	if empty.promptBlock() != "" {
		t.Error("empty offer renders no block")
	}
	offer := &catalogOffer{entriesByType: map[string][]map[string]any{
		"skills": {{"id": "abc", "name": "linter"}},
	}}
	block := offer.promptBlock()
	for _, frag := range []string{"Reusable Components Already In This Registry", `"linter"`, "existing_component_id"} {
		if !strings.Contains(block, frag) {
			t.Errorf("prompt block missing %q:\n%s", frag, block)
		}
	}
}

func TestBuildSignals(t *testing.T) {
	agg := &metaAggregate{
		TopTools:            []pair{{Key: "mcp__github__search", Count: 5}, {Key: "bash", Count: 3}},
		TopLanguages:        []pair{{Key: "Go", Count: 4}},
		ToolErrorCategories: newOrderedCount(),
	}
	agg.ToolErrorCategories.add("file_not_found", 2)
	facets := &facetsSummary{
		GoalCategories: []pair{{Key: "fix_bug", Count: 3}, {Key: "", Count: 1}},
		FrictionTypes:  []pair{{Key: "tool_failed", Count: 2}},
		RepeatedInstructions: []map[string]any{
			{"instruction": "always show diffs", "frequency": 3},
		},
	}
	config := map[string]any{
		"system_prompt_excerpt": "You review Go code carefully.",
		"category":              "review",
		"configured_mcps":       []any{"github"},
	}
	signals := buildSignals(agg, facets, config)
	for _, frag := range []string{
		"You review Go code carefully.", "fix_bug", "tool_failed", "Go",
		"mcp__github__search", "github", "file_not_found", "always show diffs", "review",
	} {
		if !strings.Contains(signals, frag) {
			t.Errorf("signals missing %q:\n%s", frag, signals)
		}
	}
	// The mcp server name is extracted once and the configured duplicate
	// dedupes case-insensitively.
	if strings.Count(signals, "github") != 2 {
		// mcp__github__search plus one bare github.
		t.Errorf("github occurrences: %q", signals)
	}
	if got := buildSignals(nil, nil, nil); got != "" {
		t.Errorf("all-nil signals = %q", got)
	}
}

func TestShortlistFamilyList(t *testing.T) {
	families := shortlistFamilyList()
	if len(families) != 4 {
		t.Fatalf("families = %d", len(families))
	}
	if families[0].Name != "skill" || families[3].Name != "mcp" {
		t.Errorf("order: %v, %v", families[0].Name, families[3].Name)
	}
}

func TestRegistryScopeHelpers(t *testing.T) {
	id := uuid.New()
	attached := uuid.New()
	scope := registryScope{UserID: id, HasUser: true, AttachedIDs: []uuid.UUID{attached}}
	v := scope.viewer()
	if v.ID != id || v.Role != "user" {
		t.Errorf("viewer = %+v", v)
	}
	if !scope.excludeSet()[attached.String()] {
		t.Errorf("excludeSet = %v", scope.excludeSet())
	}
	anon := registryScope{}
	if anon.viewer().ID != (uuid.UUID{}) {
		t.Errorf("anonymous viewer = %+v", anon.viewer())
	}
}

func TestResolvedComponentRef(t *testing.T) {
	c := resolvedComponent{componentType: "skill", id: "x", name: "n",
		namespace: "acme", slug: "s", latestVersion: "1.0.0"}
	ref := c.ref()
	if ref["qualified_name"] != "acme/s" || ref["latest_version"] != "1.0.0" || ref["type"] != "skill" {
		t.Errorf("ref = %v", ref)
	}
}

func TestResolveComponents(t *testing.T) {
	id := uuid.New()
	engine := &Engine{DB: &fakeDB{}}
	if got := engine.resolveComponents(context.Background(), nil, registryScope{}); len(got) != 0 {
		t.Errorf("no ids = %v", got)
	}

	db := &fakeDB{stubs: []stub{
		// The same id resolves in two families; the first family wins.
		{match: "FROM skill_listings l", rows: &fakeRows{rows: [][]any{
			{id.String(), "Skill", "acme", "skill", "1.0.0"},
		}}},
		{match: "FROM hook_listings l", rows: &fakeRows{rows: [][]any{
			{id.String(), "Hook", "acme", "hook", "2.0.0"},
		}}},
	}}
	engine = &Engine{DB: db}
	scope := registryScope{UserID: uuid.MustParse(testOwnerID), HasUser: true}
	resolved := engine.resolveComponents(context.Background(), []uuid.UUID{id}, scope)
	if len(resolved) != 1 || resolved[id].componentType != "skill" || resolved[id].latestVersion != "1.0.0" {
		t.Errorf("resolved = %v", resolved)
	}
	// The signed-in scope binds the visibility predicate to the user.
	probes := db.sqlCalls("project_memberships")
	if len(probes) == 0 {
		t.Error("scoped visibility SQL expected")
	}

	// Anonymous scope restricts to public listings only.
	db = &fakeDB{}
	engine = &Engine{DB: db}
	engine.resolveComponents(context.Background(), []uuid.UUID{id}, registryScope{})
	for _, c := range db.sqlCalls("l.id = ANY") {
		if !strings.Contains(c.sql, "l.is_private = FALSE") || strings.Contains(c.sql, "project_memberships") {
			t.Errorf("anonymous visibility: %s", c.sql)
		}
	}
}

func TestValidateReuseSuggestions(t *testing.T) {
	offeredID := uuid.New()
	inventedID := uuid.New()
	narrative := map[string]any{
		"suggestions": map[string]any{
			"features_to_try": []any{
				map[string]any{
					"action_type":           "reuse_existing_component",
					"existing_component_id": offeredID.String(),
					"feature":               "reuse the linter",
				},
				map[string]any{
					"action_type":           "attach_registry_component",
					"existing_component_id": inventedID.String(),
					"feature":               "package as a skill",
				},
				map[string]any{
					"action_type":           "attach_registry_component",
					"existing_component_id": uuid.NewString(),
					"feature":               "plain feature",
				},
				map[string]any{"action_type": "create_new_skill", "feature": "keep"},
				"not-a-map",
			},
		},
	}
	offer := &catalogOffer{offeredIDs: map[uuid.UUID]bool{offeredID: true}}
	db := &fakeDB{stubs: []stub{
		{match: "FROM skill_listings l", rows: &fakeRows{rows: [][]any{
			{offeredID.String(), "Linter", "acme", "linter", "1.2.0"},
		}}},
	}}
	engine := &Engine{DB: db}
	engine.validateReuseSuggestions(context.Background(), narrative, offer, registryScope{})

	features := narrative["suggestions"].(map[string]any)["features_to_try"].([]any)
	kept := features[0].(map[string]any)
	if kept["existing_component_id"] != offeredID.String() || kept["component_ref"] == nil {
		t.Errorf("offered claim must resolve: %v", kept)
	}
	skillRewrite := features[1].(map[string]any)
	if skillRewrite["action_type"] != "create_new_skill" || skillRewrite["existing_component_id"] != nil {
		t.Errorf("invented skill claim: %v", skillRewrite)
	}
	plainRewrite := features[2].(map[string]any)
	if plainRewrite["action_type"] != "no_action" || plainRewrite["component_ref"] != nil {
		t.Errorf("invented plain claim: %v", plainRewrite)
	}
	if countReused(narrative) != 1 {
		t.Errorf("countReused = %d", countReused(narrative))
	}
}

func TestValidateReuseSuggestionsNoClaims(t *testing.T) {
	engine := &Engine{DB: &fakeDB{}}
	engine.validateReuseSuggestions(context.Background(), map[string]any{}, nil, registryScope{})
	narrative := map[string]any{"suggestions": map[string]any{"features_to_try": []any{
		map[string]any{"action_type": "create_new_skill"},
	}}}
	engine.validateReuseSuggestions(context.Background(), narrative, nil, registryScope{})
}

func TestBuildCatalogDisabled(t *testing.T) {
	engine := &Engine{
		Config:  &Config{Settings: cfgMap{bools: map[string]bool{"insights.registry_match_enabled": false}}},
		Catalog: &registry.Store{DB: &fakeDB{}},
	}
	offer := engine.buildCatalog(context.Background(), registryScope{}, "signals")
	if offer.enabled || !offer.empty() {
		t.Errorf("disabled offer = %+v", offer)
	}
}

func TestBuildCatalogEmptyRegistryProbe(t *testing.T) {
	db := &fakeDB{}
	engine := &Engine{
		Config:  &Config{Settings: fakeSettings{}},
		Catalog: &registry.Store{DB: db},
	}
	offer := engine.buildCatalog(context.Background(), registryScope{}, "linting go code")
	if !offer.enabled || !offer.empty() {
		t.Errorf("offer = %+v", offer)
	}
	if offer.registryHasComponents == nil || *offer.registryHasComponents {
		t.Errorf("empty registry probe = %v", offer.registryHasComponents)
	}
}

func TestBuildCatalogShortlistsCandidates(t *testing.T) {
	id := uuid.New()
	db := &fakeDB{stubs: []stub{
		{match: "FROM skill_listings l", rows: &fakeRows{
			cols: []string{"id", "name", "namespace", "slug", "version", "description", "download_count", "task_type"},
			rows: [][]any{{id.String(), "Go Linter", "acme", "go-linter", "1.0.0", "lints go code", int64(10), "general"}},
		}},
	}}
	engine := &Engine{
		Config:  &Config{Settings: fakeSettings{}},
		Catalog: &registry.Store{DB: db},
	}
	offer := engine.buildCatalog(context.Background(), registryScope{}, "linting go code")
	if offer.itemCount() != 1 {
		t.Fatalf("offer = %+v", offer)
	}
	entry := offer.entriesByType["skills"][0]
	if entry["qualified_name"] != "acme/go-linter" || entry["id"] != id.String() {
		t.Errorf("entry = %v", entry)
	}
	if !offer.offeredIDs[id] {
		t.Errorf("offeredIDs = %v", offer.offeredIDs)
	}
	if offer.registryHasComponents != nil {
		t.Error("non-empty offer must skip the registry probe")
	}
}
