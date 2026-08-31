// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/registry"
)

// reuseActions are the suggestion action types that mean "attach something
// that already exists".
var reuseActions = map[string]bool{
	"reuse_existing_component":  true,
	"attach_registry_component": true,
}

// registryScope describes which components an agent may be offered and
// which it already has attached.
type registryScope struct {
	UserID      uuid.UUID
	HasUser     bool
	AttachedIDs []uuid.UUID
}

// catalogOffer is the shortlist that was actually shown to the model, kept
// so validation can check the model only referenced what it was given and
// so the report can say why there were no reuse suggestions.
type catalogOffer struct {
	entriesByType map[string][]map[string]any
	typeOrder     []string
	offeredIDs    map[uuid.UUID]bool
	// registryHasComponents is false when the agent can see no approved
	// components at all; nil when the check was unnecessary.
	registryHasComponents *bool
	enabled               bool
}

func (o *catalogOffer) itemCount() int {
	total := 0
	for _, entries := range o.entriesByType {
		total += len(entries)
	}
	return total
}

func (o *catalogOffer) empty() bool { return o == nil || len(o.entriesByType) == 0 }

// summary is persisted alongside the narrative so the UI can explain what
// the reuse search did.
func (o *catalogOffer) summary(reused int) map[string]any {
	var hasComponents any
	if o.registryHasComponents != nil {
		hasComponents = *o.registryHasComponents
	}
	return map[string]any{
		"enabled":                 o.enabled,
		"offered":                 o.itemCount(),
		"reused":                  reused,
		"registry_has_components": hasComponents,
	}
}

// promptBlock renders the shortlist for the suggestions prompt.
func (o *catalogOffer) promptBlock() string {
	if o.empty() {
		return ""
	}
	blob, err := json.MarshalIndent(o.entriesByType, "", "  ")
	if err != nil {
		return ""
	}
	return "\n\n## Reusable Components Already In This Registry\n" +
		"These are approved components this agent is NOT currently using. " +
		"When one of them solves an observed problem, prefer reusing it over " +
		"inventing something new. Copy `id` verbatim into " +
		"`existing_component_id` - never invent an id.\n" + string(blob)
}

// Enough of the prompt to carry the domain, not so much that boilerplate
// drowns out the specific words.
const promptSignalChars = 400

// buildSignals distils the report's aggregates and facets into the search
// string that drives the shortlist: what the agent does and where it
// struggles are both reasons to reach for an existing component.
func buildSignals(agg *metaAggregate, facets *facetsSummary, agentConfig map[string]any) string {
	parts := [][]string{}

	// Domain vocabulary describing what this agent is for; tool names and
	// languages carry mechanics but no domain words.
	domain := []string{}
	if agentConfig != nil {
		if excerpt := str(agentConfig["system_prompt_excerpt"]); strings.TrimSpace(excerpt) != "" {
			domain = append(domain, truncateRunes(excerpt, promptSignalChars))
		}
		for _, key := range []string{"name", "description", "category"} {
			if value := str(agentConfig[key]); strings.TrimSpace(value) != "" {
				domain = append(domain, value)
			}
		}
	}
	parts = append(parts, domain)

	pairLabels := func(pairs []pair, limit int) []string {
		out := []string{}
		for _, p := range pairs {
			if p.Key == "" {
				continue
			}
			out = append(out, p.Key)
			if len(out) == limit {
				break
			}
		}
		return out
	}

	var goals, friction []string
	var repeatedInstr []string
	if facets != nil {
		goals = pairLabels(facets.GoalCategories, 10)
		friction = pairLabels(facets.FrictionTypes, 8)
		for _, item := range facets.RepeatedInstructions {
			if instr := str(item["instruction"]); instr != "" {
				repeatedInstr = append(repeatedInstr, instr)
			}
			if len(repeatedInstr) == 5 {
				break
			}
		}
	}
	tools := []string{}
	langs := []string{}
	errorCats := []string{}
	if agg != nil {
		tools = pairLabels(agg.TopTools, 12)
		langs = pairLabels(agg.TopLanguages, 6)
		errorCats = pairLabels(rankedPairs(agg.ToolErrorCategories.counts, agg.ToolErrorCategories.order, 5), 5)
	}

	// An MCP tool reads as one opaque token; the server name inside it is
	// the useful signal.
	mcpServers := []string{}
	for _, name := range tools {
		if !strings.HasPrefix(name, "mcp__") {
			continue
		}
		segments := strings.Split(name, "__")
		if len(segments) >= 2 && segments[1] != "" {
			mcpServers = append(mcpServers, segments[1])
		}
	}

	category := []string{}
	configuredMcps := []string{}
	if agentConfig != nil {
		if c := str(agentConfig["category"]); c != "" {
			category = append(category, c)
		}
		for _, m := range asList(agentConfig["configured_mcps"]) {
			if s := str(m); s != "" {
				configuredMcps = append(configuredMcps, s)
			}
		}
	}

	parts = append(parts, goals, friction, langs, tools, mcpServers, errorCats, repeatedInstr, category, configuredMcps)

	// Flatten preserving order and dropping duplicates case-insensitively.
	seen := map[string]bool{}
	out := []string{}
	for _, group := range parts {
		for _, item := range group {
			text := strings.TrimSpace(item)
			if text == "" || seen[strings.ToLower(text)] {
				continue
			}
			seen[strings.ToLower(text)] = true
			out = append(out, text)
		}
	}
	return strings.Join(out, " ")
}

// shortlistFamilies is the tie-break order used when trimming the blended
// shortlist.
var shortlistFamilies = []string{"skills", "hooks", "prompts", "mcps"}

func shortlistFamilyList() []registry.Family {
	families := make([]registry.Family, 0, len(shortlistFamilies))
	for _, prefix := range shortlistFamilies {
		families = append(families, registry.Families[prefix])
	}
	return families
}

func (s registryScope) viewer() *registry.Viewer {
	viewer := &registry.Viewer{Role: "user"}
	if s.HasUser {
		viewer.ID = s.UserID
	}
	return viewer
}

func (s registryScope) excludeSet() map[string]bool {
	exclude := map[string]bool{}
	for _, id := range s.AttachedIDs {
		exclude[id.String()] = true
	}
	return exclude
}

// buildCatalog shortlists components for the suggestions prompt. An empty
// offer simply omits the catalog block; a lookup failure must never fail
// the report.
func (e *Engine) buildCatalog(ctx context.Context, scope registryScope, signals string) *catalogOffer {
	if !e.Config.Bool(ctx, "insights.registry_match_enabled", true) {
		return &catalogOffer{enabled: false, offeredIDs: map[uuid.UUID]bool{}}
	}
	offer := &catalogOffer{
		enabled:       true,
		entriesByType: map[string][]map[string]any{},
		offeredIDs:    map[uuid.UUID]bool{},
	}
	// A zero or negative cap would render the feature broken rather than
	// disabled; registry_match_enabled is the off switch.
	perType := max(1, e.Config.Int(ctx, "insights.registry_match_per_type", 6))
	total := max(1, e.Config.Int(ctx, "insights.registry_match_max_items", 24))

	candidates, err := e.Catalog.Shortlist(ctx, signals, shortlistFamilyList(), scope.viewer(), scope.excludeSet(), perType, total)
	if err != nil {
		slog.Warn("registry shortlist failed", "error", err)
		return offer
	}
	for _, c := range candidates {
		id, err := uuid.Parse(c.ID)
		if err != nil {
			continue
		}
		entry := map[string]any{
			"type":           c.Type,
			"id":             c.ID,
			"qualified_name": c.QualifiedName,
			"name":           c.Name,
			"description":    truncateRunes(c.Description, 160),
		}
		if c.Category != nil && *c.Category != "" {
			entry["category"] = *c.Category
		}
		if len(c.MatchedOn) > 0 {
			entry["matched_on"] = c.MatchedOn
		}
		key := c.Type + "s"
		if _, seen := offer.entriesByType[key]; !seen {
			offer.typeOrder = append(offer.typeOrder, key)
		}
		offer.entriesByType[key] = append(offer.entriesByType[key], entry)
		offer.offeredIDs[id] = true
	}

	if offer.empty() {
		// Nothing matched: distinguish an empty registry from an
		// irrelevant one; the report says different things in each case.
		hasComponents := e.registryHasAny(ctx, scope)
		offer.registryHasComponents = &hasComponents
	}

	slog.Info("registry shortlist built",
		"items", offer.itemCount(), "signal_chars", len(signals),
		"registry_has_components", offer.registryHasComponents != nil && *offer.registryHasComponents)
	return offer
}

func (e *Engine) registryHasAny(ctx context.Context, scope registryScope) bool {
	probe, err := e.Catalog.Shortlist(ctx, "", shortlistFamilyList(), scope.viewer(), scope.excludeSet(), 1, 1)
	if err != nil {
		slog.Warn("registry probe failed", "error", err)
		return false
	}
	return len(probe) > 0
}

// resolvedComponent is a registry reference that survived validation.
type resolvedComponent struct {
	componentType string
	id            string
	name          string
	namespace     string
	slug          string
	latestVersion string
}

func (c resolvedComponent) ref() map[string]any {
	return map[string]any{
		"type":           c.componentType,
		"id":             c.id,
		"name":           c.name,
		"qualified_name": c.namespace + "/" + c.slug,
		"latest_version": c.latestVersion,
	}
}

// resolveComponents validates component ids against the registry: a
// reference resolves only when the listing exists, its latest version is
// approved, and it is visible to the scope's user.
func (e *Engine) resolveComponents(ctx context.Context, ids []uuid.UUID, scope registryScope) map[uuid.UUID]resolvedComponent {
	resolved := map[uuid.UUID]resolvedComponent{}
	if len(ids) == 0 {
		return resolved
	}
	idStrings := make([]string, 0, len(ids))
	for _, id := range ids {
		idStrings = append(idStrings, id.String())
	}
	for _, prefix := range shortlistFamilies {
		family := registry.Families[prefix]
		args := []any{idStrings}
		visibility := "l.is_private = FALSE"
		if scope.HasUser {
			args = append(args, scope.UserID)
			userArg := fmt.Sprintf("$%d", len(args))
			visibility = `(l.is_private = FALSE
				OR (l.is_private = TRUE AND (l.ownership_scope = 'private' OR l.project_id IS NULL) AND l.submitted_by = ` + userArg + `)
				OR (l.is_private = TRUE AND l.project_id IS NOT NULL AND l.ownership_scope != 'private' AND EXISTS (
					SELECT 1 FROM project_memberships pm WHERE pm.project_id = l.project_id AND pm.user_id = ` + userArg + `)))`
		}
		sql := fmt.Sprintf(`SELECT l.id::text, l.name, l.namespace, l.slug, v.version
			FROM %s l JOIN %s v ON l.latest_version_id = v.id
			WHERE l.id = ANY($1::uuid[]) AND v.status = 'approved' AND %s`,
			family.ListingTable, family.VersionTable, visibility)
		rows, err := e.DB.Query(ctx, sql, args...)
		if err != nil {
			slog.Warn("component resolve failed", "family", family.Name, "error", err)
			continue
		}
		for rows.Next() {
			var idText, name, namespace, slug, version string
			if rows.Scan(&idText, &name, &namespace, &slug, &version) != nil {
				continue
			}
			id, err := uuid.Parse(idText)
			if err != nil {
				continue
			}
			if _, taken := resolved[id]; taken {
				continue
			}
			resolved[id] = resolvedComponent{
				componentType: family.Name, id: idText, name: name,
				namespace: namespace, slug: slug, latestVersion: version,
			}
		}
		rows.Close()
	}
	return resolved
}

func coerceUUID(value any) (uuid.UUID, bool) {
	if value == nil {
		return uuid.UUID{}, false
	}
	s := strings.TrimSpace(str(value))
	if s == "" {
		return uuid.UUID{}, false
	}
	id, err := uuid.Parse(s)
	if err != nil {
		return uuid.UUID{}, false
	}
	return id, true
}

// validateReuseSuggestions grounds every reuse suggestion against the
// registry: a features_to_try entry claiming to reuse a component is kept
// only when its id was in the offered shortlist and still resolves to an
// approved, visible listing. Anything else is rewritten into a plain
// suggestion with the bogus reference stripped.
func (e *Engine) validateReuseSuggestions(ctx context.Context, narrative map[string]any, offer *catalogOffer, scope registryScope) {
	suggestions := asMap(narrative["suggestions"])
	if suggestions == nil {
		return
	}
	features := asList(suggestions["features_to_try"])
	if features == nil {
		return
	}

	type claim struct {
		index int
		id    uuid.UUID
	}
	wanted := []claim{}
	for idx, featureAny := range features {
		feature := asMap(featureAny)
		if feature == nil {
			continue
		}
		action := strings.ToLower(str(feature["action_type"]))
		if !reuseActions[action] {
			continue
		}
		if id, ok := coerceUUID(feature["existing_component_id"]); ok {
			wanted = append(wanted, claim{index: idx, id: id})
		}
	}
	if len(wanted) == 0 {
		return
	}

	// Only ids that were actually offered are eligible: this is what stops
	// a plausible-looking but invented identifier from reaching the UI.
	eligible := []uuid.UUID{}
	for _, c := range wanted {
		if offer != nil && offer.offeredIDs[c.id] {
			eligible = append(eligible, c.id)
		}
	}
	resolved := e.resolveComponents(ctx, eligible, scope)

	dropped := 0
	for _, c := range wanted {
		feature := asMap(features[c.index])
		component, ok := resolved[c.id]
		if !ok {
			dropped++
			if looksLikeSkill(feature) {
				feature["action_type"] = "create_new_skill"
			} else {
				feature["action_type"] = "no_action"
			}
			feature["existing_component_id"] = nil
			feature["component_ref"] = nil
			continue
		}
		feature["existing_component_id"] = component.id
		feature["component_ref"] = component.ref()
	}
	if dropped > 0 {
		offered := 0
		if offer != nil {
			offered = len(offer.offeredIDs)
		}
		slog.Warn("reuse suggestions rejected",
			"dropped", dropped, "offered", offered, "claimed", len(wanted))
	}
}

func looksLikeSkill(feature map[string]any) bool {
	return strings.Contains(strings.ToLower(str(feature["feature"])), "skill")
}

// countReused reports how many suggestions survived validation with a real
// component reference.
func countReused(narrative map[string]any) int {
	suggestions := asMap(narrative["suggestions"])
	if suggestions == nil {
		return 0
	}
	count := 0
	for _, featureAny := range asList(suggestions["features_to_try"]) {
		if feature := asMap(featureAny); feature != nil && feature["component_ref"] != nil {
			count++
		}
	}
	return count
}
