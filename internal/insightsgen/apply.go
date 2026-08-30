// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"gopkg.in/yaml.v3"

	"github.com/garudex-labs/caracal/internal/harness"
	"github.com/garudex-labs/caracal/internal/inbox"
	"github.com/garudex-labs/caracal/internal/registry"
)

// ApplyError is a failure that maps to an HTTP status.
type ApplyError struct {
	Status int
	Detail string
}

func (e *ApplyError) Error() string { return e.Detail }

// ApplySelection picks which suggestions to apply, by 0-based index per
// category. A nil slice means every suggestion in that category.
type ApplySelection struct {
	ConfigIndices  []int
	FeatureIndices []int
	PatternIndices []int
}

// selfLearnSeparator is appended before auto-generated prompt additions.
const selfLearnSeparator = "\n\n# ── Auto-learned from Insights ──\n"

// applyMaxNameLen caps generated component names.
const applyMaxNameLen = 48

// applyTypeOrder is the resolution order for reused component references.
var applyTypeOrder = []string{"skill", "hook", "prompt", "mcp", "sandbox"}

// applyTypePrefix maps singular component types to registry family prefixes.
var applyTypePrefix = map[string]string{
	"skill":   "skills",
	"hook":    "hooks",
	"prompt":  "prompts",
	"mcp":     "mcps",
	"sandbox": "sandboxes",
}

var applyHarnessRegistry = sync.OnceValues(harness.Load)

// createdComponent is a listing created during this apply run; such
// listings are always born at version 1.0.0.
type createdComponent struct {
	ctype string
	id    string
}

// applyAgent is the owning agent context for one apply run.
type applyAgent struct {
	id        string
	name      string
	namespace string
	slug      string
	owner     string
	createdBy string
	isPrivate bool
	projectID *uuid.UUID
}

// ApplyReport applies a completed report's suggestions to the agent draft.
//
// Suggested skills, hooks, and prompts become pending registry listings,
// reusable component references are validated and attached, and prompt
// additions land in a new pending agent version. Everything commits in one
// transaction, and reviewers hear about each pending item through their
// inbox. When agentID is non-empty the report must belong to that agent.
// The returned map is the HTTP response document.
func (s *Store) ApplyReport(ctx context.Context, reportID, agentID, actorUserID string, selection *ApplySelection) (map[string]any, error) {
	actor, err := uuid.Parse(actorUserID)
	if err != nil {
		return nil, fmt.Errorf("invalid actor user id: %w", err)
	}
	reportUUID, err := uuid.Parse(strings.TrimSpace(reportID))
	if err != nil {
		return nil, &ApplyError{Status: 404, Detail: "Report not found"}
	}

	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var reportAgentID, reportStatus string
	var appliedAt *time.Time
	var narrativeBlob []byte
	err = tx.QueryRow(ctx, `
		SELECT agent_id::text, status::text, applied_at, narrative
		FROM insight_reports WHERE id = $1`, reportUUID).
		Scan(&reportAgentID, &reportStatus, &appliedAt, &narrativeBlob)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &ApplyError{Status: 404, Detail: "Report not found"}
	}
	if err != nil {
		return nil, err
	}
	if agentID != "" {
		want, err := uuid.Parse(agentID)
		if err != nil || want.String() != reportAgentID {
			return nil, &ApplyError{Status: 404, Detail: "Report not found for agent"}
		}
	}
	if reportStatus != "completed" {
		return nil, &ApplyError{Status: 400, Detail: "Report is not completed"}
	}
	if appliedAt != nil {
		return nil, &ApplyError{Status: 400, Detail: "Suggestions have already been applied for this report"}
	}

	agent := &applyAgent{}
	err = tx.QueryRow(ctx, `
		SELECT id::text, name, namespace, slug, coalesce(owner, ''), created_by::text, is_private, project_id
		FROM agents WHERE id = $1`, reportAgentID).
		Scan(&agent.id, &agent.name, &agent.namespace, &agent.slug, &agent.owner,
			&agent.createdBy, &agent.isPrivate, &agent.projectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &ApplyError{Status: 400, Detail: "Agent not found"}
	}
	if err != nil {
		return nil, err
	}

	// The submitting identity is the agent owner; the triggering admin is
	// the fallback when the owner row no longer exists.
	submitter := actor
	if ownerID, err := uuid.Parse(agent.createdBy); err == nil {
		var one int
		switch err := tx.QueryRow(ctx, `SELECT 1 FROM users WHERE id = $1`, ownerID).Scan(&one); {
		case err == nil:
			submitter = ownerID
		case !errors.Is(err, pgx.ErrNoRows):
			return nil, err
		}
	}

	var narrative map[string]any
	if len(narrativeBlob) > 0 {
		_ = json.Unmarshal(narrativeBlob, &narrative)
	}
	suggestions := asMap(narrative["suggestions"])
	if len(suggestions) == 0 {
		return nil, &ApplyError{Status: 400, Detail: "Report has no suggestions to apply"}
	}

	applied := map[string]any{
		"agent_version":      nil,
		"skills":             []any{},
		"hooks":              []any{},
		"prompts":            []any{},
		"linked_existing":    []any{},
		"removed_components": []any{},
	}

	features := asList(suggestions["features_to_try"])
	patterns := asList(suggestions["usage_patterns"])
	configAdditions := asList(suggestions["config_additions"])

	var selConfig, selFeatures, selPatterns []int
	if selection != nil {
		selConfig, selFeatures, selPatterns = selection.ConfigIndices, selection.FeatureIndices, selection.PatternIndices
	}
	configIndices := resolveIndexSelection(selConfig, len(configAdditions))
	featureIndices := resolveIndexSelection(selFeatures, len(features))
	patternIndices := resolveIndexSelection(selPatterns, len(patterns))

	// Applying a newer report hard-replaces older pending insight-generated
	// versions so users do not see competing fixes.
	superseded, err := withdrawStaleInsightVersions(ctx, tx, agent.id)
	if err != nil {
		return nil, err
	}
	if len(superseded) > 0 {
		applied["superseded_agent_versions"] = superseded
	}

	newComponents := []createdComponent{}
	linkedExisting := []resolvedComponent{}
	removedIDs := []uuid.UUID{}
	appendEntry := func(key string, entry map[string]any) {
		applied[key] = append(applied[key].([]any), entry)
	}

	for _, idx := range featureIndices {
		if idx >= len(features) {
			continue
		}
		feature := asMap(features[idx])
		action := strings.ToLower(str(feature["action_type"]))
		existingID := feature["existing_component_id"]
		if reuseActions[action] && truthyAny(existingID) {
			resolved, err := resolveReusableComponent(ctx, tx, feature, agent)
			if err != nil {
				return nil, err
			}
			if resolved == nil {
				slog.Info("self-learn reuse rejected",
					"agent", agent.name, "component_id", fmt.Sprint(existingID),
					"declared_type", str(feature["feature"]))
				continue
			}
			linkedExisting = append(linkedExisting, *resolved)
			appendEntry("linked_existing", map[string]any{
				"type":           resolved.componentType,
				"id":             resolved.id,
				"name":           resolved.name,
				"qualified_name": resolved.namespace + "/" + resolved.slug,
				"version":        resolved.latestVersion,
				"reason":         feature["why_for_you"],
				"confidence":     feature["confidence"],
				"risk":           feature["risk"],
			})
			continue
		}
		// Creating brand-new MCPs from a model suggestion is never safe:
		// they carry commands, images and credentials. Reuse above is
		// allowed.
		if isMcpSuggestion(feature) {
			continue
		}
		if action == "remove_component" && truthyAny(existingID) {
			cid, err := uuid.Parse(fmt.Sprint(existingID))
			if err != nil {
				continue
			}
			removedIDs = append(removedIDs, cid)
			appendEntry("removed_components", map[string]any{
				"id":         cid.String(),
				"name":       feature["name"],
				"reason":     feature["why_for_you"],
				"confidence": feature["confidence"],
				"risk":       feature["risk"],
			})
			continue
		}
		if isSkillSuggestion(feature) {
			match, err := findExistingSkillMatch(ctx, tx, feature, agent)
			if err != nil {
				return nil, err
			}
			if match != nil {
				linkedExisting = append(linkedExisting, *match)
				risk := feature["risk"]
				if !truthyAny(risk) {
					risk = "low"
				}
				appendEntry("linked_existing", map[string]any{
					"type":           "skill",
					"id":             match.id,
					"name":           match.name,
					"qualified_name": match.namespace + "/" + match.slug,
					"version":        match.latestVersion,
					"reason":         "matched existing registry skill",
					"confidence":     feature["confidence"],
					"risk":           risk,
				})
				continue
			}
			info, err := createSkillListing(ctx, tx, agent, feature, submitter, actor)
			if err != nil {
				return nil, err
			}
			if info != nil {
				info["confidence"] = feature["confidence"]
				info["risk"] = feature["risk"]
				info["why"] = feature["why_for_you"]
				appendEntry("skills", info)
				newComponents = append(newComponents, createdComponent{ctype: "skill", id: str(info["id"])})
			}
		} else if isHookSuggestion(feature) {
			info, err := createHookListing(ctx, tx, agent, feature, submitter, actor)
			if err != nil {
				return nil, err
			}
			if info != nil {
				info["confidence"] = feature["confidence"]
				info["risk"] = feature["risk"]
				info["why"] = feature["why_for_you"]
				appendEntry("hooks", info)
				newComponents = append(newComponents, createdComponent{ctype: "hook", id: str(info["id"])})
			}
		}
	}

	for _, idx := range patternIndices {
		if idx >= len(patterns) {
			continue
		}
		pattern := asMap(patterns[idx])
		if !truthyAny(pattern["copyable_prompt"]) {
			continue
		}
		info, err := createPromptListing(ctx, tx, agent, pattern, submitter, actor)
		if err != nil {
			return nil, err
		}
		if info != nil {
			appendEntry("prompts", info)
			newComponents = append(newComponents, createdComponent{ctype: "prompt", id: str(info["id"])})
		}
	}

	selectedAdditions := []map[string]any{}
	for _, i := range configIndices {
		if i < len(configAdditions) {
			selectedAdditions = append(selectedAdditions, asMap(configAdditions[i]))
		}
	}
	if len(selectedAdditions) > 0 {
		entries := []any{}
		for _, item := range selectedAdditions {
			risk := item["risk"]
			if !truthyAny(risk) {
				risk = "low"
			}
			entries = append(entries, map[string]any{
				"addition":   item["addition"],
				"where":      item["where"],
				"why":        item["why"],
				"confidence": item["confidence"],
				"risk":       risk,
			})
		}
		applied["prompt_additions"] = entries
	}

	if len(selectedAdditions) > 0 || len(newComponents) > 0 || len(linkedExisting) > 0 || len(removedIDs) > 0 {
		versionInfo, err := createAgentVersionWithAdditions(ctx, tx, agent,
			selectedAdditions, submitter, newComponents, linkedExisting, removedIDs, actor)
		if err != nil {
			return nil, err
		}
		if versionInfo != nil {
			applied["agent_version"] = versionInfo
		}
	}

	appliedJSON, err := json.Marshal(applied)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE insight_reports SET applied_at = now(), applied_items = $2::json
		WHERE id = $1`, reportUUID, string(appliedJSON)); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	slog.Info("self-learn suggestions applied",
		"report_id", reportID, "agent", agent.name,
		"version_created", applied["agent_version"] != nil,
		"skills_created", len(applied["skills"].([]any)),
		"hooks_created", len(applied["hooks"].([]any)),
		"prompts_created", len(applied["prompts"].([]any)))

	return map[string]any{
		"applied":   true,
		"report_id": reportID,
		"items":     applied,
	}, nil
}

// resolveIndexSelection keeps the in-range selected indices in caller
// order; nil selects everything.
func resolveIndexSelection(selected []int, n int) []int {
	if selected == nil {
		out := make([]int, n)
		for i := range out {
			out[i] = i
		}
		return out
	}
	out := []int{}
	for _, i := range selected {
		if i >= 0 && i < n {
			out = append(out, i)
		}
	}
	return out
}

func truthyAny(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case float64:
		return t != 0
	case json.Number:
		f, _ := t.Float64()
		return f != 0
	case []any:
		return len(t) > 0
	case map[string]any:
		return len(t) > 0
	}
	return v != nil
}

// withdrawStaleInsightVersions rejects older pending insight-generated
// agent versions before a newer proposal replaces them.
func withdrawStaleInsightVersions(ctx context.Context, tx pgx.Tx, agentID string) ([]any, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, version, description FROM agent_versions
		WHERE agent_id = $1 AND status = 'pending'
		ORDER BY created_at`, agentID)
	if err != nil {
		return nil, err
	}
	withdrawn := []any{}
	ids := []string{}
	for rows.Next() {
		var id, version, description string
		if err := rows.Scan(&id, &version, &description); err != nil {
			rows.Close()
			return nil, err
		}
		if !strings.HasPrefix(description, "Self-learned from insights") {
			continue
		}
		ids = append(ids, id)
		withdrawn = append(withdrawn, map[string]any{"id": id, "version": version})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) > 0 {
		if _, err := tx.Exec(ctx, `
			UPDATE agent_versions
			SET status = 'rejected', rejection_reason = 'Superseded by newer insight-generated proposal'
			WHERE id = ANY($1::uuid[])`, ids); err != nil {
			return nil, err
		}
	}
	return withdrawn, nil
}

// ── Suggestion classification ────────────────────────────────────────────

func isSkillSuggestion(feature map[string]any) bool {
	name := strings.ToLower(str(feature["feature"]))
	return strings.Contains(name, "skill") || strings.Contains(name, "custom skill")
}

func isHookSuggestion(feature map[string]any) bool {
	name := strings.ToLower(str(feature["feature"]))
	return strings.Contains(name, "hook") || strings.Contains(name, "lifecycle") || strings.Contains(name, "pre-commit")
}

func isMcpSuggestion(feature map[string]any) bool {
	name := strings.ToLower(str(feature["feature"]))
	return strings.Contains(name, "mcp") || strings.Contains(name, "server")
}

// declaredComponentType is the best guess at which component type a
// suggestion refers to; empty when the wording is ambiguous.
func declaredComponentType(feature map[string]any) string {
	if isSkillSuggestion(feature) {
		return "skill"
	}
	if isHookSuggestion(feature) {
		return "hook"
	}
	if isMcpSuggestion(feature) {
		return "mcp"
	}
	label := strings.ToLower(str(feature["feature"]) + " " + str(feature["name"]))
	if strings.Contains(label, "prompt") {
		return "prompt"
	}
	if strings.Contains(label, "sandbox") {
		return "sandbox"
	}
	return ""
}

// ── Registry resolution ──────────────────────────────────────────────────

// applyVisibilitySQL is the listing visibility predicate with the viewer
// bound at the given parameter position.
func applyVisibilitySQL(userParam string) string {
	return `(l.is_private = FALSE
		OR (l.is_private = TRUE AND (l.ownership_scope = 'private' OR l.project_id IS NULL) AND l.submitted_by = ` + userParam + `)
		OR (l.is_private = TRUE AND l.project_id IS NOT NULL AND l.ownership_scope != 'private' AND EXISTS (
			SELECT 1 FROM project_memberships pm WHERE pm.project_id = l.project_id AND pm.user_id = ` + userParam + `)))`
}

// resolveReusableComponent validates a reuse suggestion against the
// registry. The declared type is a hint only: the id is resolved across
// every component type and the actual type wins, so a mislabelled
// suggestion still attaches correctly instead of being silently dropped.
// Scoped to the agent creator's visibility so a suggestion can never
// attach another user's private component.
func resolveReusableComponent(ctx context.Context, tx pgx.Tx, feature map[string]any, agent *applyAgent) (*resolvedComponent, error) {
	componentID, ok := coerceUUID(feature["existing_component_id"])
	if !ok {
		return nil, nil
	}
	declared := declaredComponentType(feature)
	ordered := []string{}
	if declared != "" {
		ordered = append(ordered, declared)
	}
	for _, t := range applyTypeOrder {
		if t != declared {
			ordered = append(ordered, t)
		}
	}
	for _, componentType := range ordered {
		family := registry.Families[applyTypePrefix[componentType]]
		sql := fmt.Sprintf(`
			SELECT l.id::text, l.name, l.namespace, l.slug, v.version
			FROM %s l JOIN %s v ON l.latest_version_id = v.id
			WHERE l.id = $1 AND v.status = 'approved' AND %s`,
			family.ListingTable, family.VersionTable, applyVisibilitySQL("$2"))
		var id, name, namespace, slug, version string
		err := tx.QueryRow(ctx, sql, componentID, agent.createdBy).Scan(&id, &name, &namespace, &slug, &version)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			slog.Warn("component resolve failed", "type", componentType, "error", err)
			continue
		}
		return &resolvedComponent{
			componentType: componentType, id: id, name: name,
			namespace: namespace, slug: slug, latestVersion: version,
		}, nil
	}
	return nil, nil
}

// ── Keyword matching ─────────────────────────────────────────────────────

var applyTokenRE = regexp.MustCompile(`[a-z0-9][a-z0-9_-]*`)

var applyKeepTiny = map[string]bool{"ai": true, "go": true, "js": true, "ts": true, "ui": true, "ux": true}

var applySearchStop = map[string]bool{
	"about": true, "agent": true, "all": true, "and": true, "any": true, "are": true,
	"component": true, "components": true, "could": true, "find": true, "for": true,
	"from": true, "good": true, "help": true, "helps": true, "install": true,
	"into": true, "make": true, "mcp": true, "me": true, "need": true, "please": true,
	"registry": true, "server": true, "skill": true, "skills": true, "setup": true,
	"that": true, "the": true, "this": true, "what": true, "when": true, "with": true,
	"would": true, "you": true,
}

// applySearchTokens tokenizes a natural-ish query into useful search words.
func applySearchTokens(query string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, raw := range applyTokenRE.FindAllString(strings.ToLower(query), -1) {
		token := strings.Trim(raw, "-_")
		if strings.HasSuffix(token, "s") && len(token) > 4 && !strings.HasSuffix(token, "ss") {
			token = token[:len(token)-1]
		}
		if (len(token) < 3 && !applyKeepTiny[token]) || applySearchStop[token] {
			continue
		}
		if !seen[token] {
			out = append(out, token)
			seen[token] = true
		}
	}
	return out
}

func applyLikeEscape(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `%`, `\%`)
	return strings.ReplaceAll(s, `_`, `\_`)
}

// findExistingSkillMatch deterministically finds an existing approved skill
// before creating a duplicate. Scoped to the agent creator's visibility:
// matching never reaches into another user's private or project-private skills.
func findExistingSkillMatch(ctx context.Context, tx pgx.Tx, feature map[string]any, agent *applyAgent) (*resolvedComponent, error) {
	rawName := applySlug(str(feature["name"]))
	oneLiner := str(feature["one_liner"])
	if !truthyAny(feature["one_liner"]) {
		oneLiner = str(feature["why_for_you"])
	}
	keywords := []string{}
	for _, kw := range strings.Split(applyExtractKeywords(rawName+" "+oneLiner, 6), "-") {
		if kw != "" {
			keywords = append(keywords, kw)
		}
	}
	if rawName == "" && len(keywords) == 0 {
		return nil, nil
	}

	args := []any{agent.createdBy}
	pattern := func(term string) string {
		args = append(args, "%"+applyLikeEscape(term)+"%")
		return fmt.Sprintf("$%d", len(args))
	}
	where := "v.status = 'approved' AND " + applyVisibilitySQL("$1")
	orderBy := ""
	tokens := applySearchTokens(rawName + " " + oneLiner)
	if len(tokens) > 0 {
		phrase := strings.Join(tokens, " ")
		terms := []string{phrase}
		for _, t := range tokens {
			if t != phrase {
				terms = append(terms, t)
			}
		}
		fields := []string{"l.name", "v.description"}
		clauses := []string{}
		for _, term := range terms {
			p := pattern(term)
			for _, field := range fields {
				clauses = append(clauses, field+" ILIKE "+p)
			}
		}
		rank := "0"
		phraseParam := pattern(phrase)
		rank += " + CASE WHEN l.name ILIKE " + phraseParam + " THEN 100 ELSE 0 END"
		for _, field := range fields {
			rank += " + CASE WHEN " + field + " ILIKE " + phraseParam + " THEN 40 ELSE 0 END"
		}
		for _, token := range tokens {
			tokenParam := pattern(token)
			rank += " + CASE WHEN l.name ILIKE " + tokenParam + " THEN 12 ELSE 0 END"
			for _, field := range fields {
				rank += " + CASE WHEN " + field + " ILIKE " + tokenParam + " THEN 4 ELSE 0 END"
			}
		}
		where += " AND (" + strings.Join(clauses, " OR ") + ")"
		orderBy = " ORDER BY (" + rank + ") DESC"
	}

	rows, err := tx.Query(ctx, `
		SELECT l.id::text, l.name, l.namespace, l.slug, v.version, v.description
		FROM skill_listings l JOIN skill_versions v ON l.latest_version_id = v.id
		WHERE `+where+orderBy+` LIMIT 100`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, name, namespace, slug, version, description string
		if err := rows.Scan(&id, &name, &namespace, &slug, &version, &description); err != nil {
			return nil, err
		}
		listingSlug := applySlug(name)
		haystack := strings.ToLower(name + " " + description)
		hit := rawName != "" &&
			(listingSlug == rawName || strings.Contains(listingSlug, rawName) || strings.Contains(rawName, listingSlug))
		if !hit && len(keywords) > 0 {
			matched := 0
			for _, kw := range keywords {
				if strings.Contains(haystack, kw) {
					matched++
				}
			}
			hit = matched >= min(3, len(keywords))
		}
		if hit {
			return &resolvedComponent{
				componentType: "skill", id: id, name: name,
				namespace: namespace, slug: slug, latestVersion: version,
			}, nil
		}
	}
	return nil, rows.Err()
}

// ── Name generation ──────────────────────────────────────────────────────

var (
	applyFillerRE  = regexp.MustCompile(`\b(custom|for|the|a|an|with|and|from)\b`)
	applyNonSlugRE = regexp.MustCompile(`[^a-z0-9\-]`)
	applyDashRunRE = regexp.MustCompile(`-+`)
)

// applySlug builds a loose display slug for generated names and matching.
func applySlug(text string) string {
	slug := strings.TrimSpace(strings.ToLower(text))
	slug = applyFillerRE.ReplaceAllString(slug, "")
	slug = applyNonSlugRE.ReplaceAllString(slug, "-")
	slug = applyDashRunRE.ReplaceAllString(slug, "-")
	return strings.Trim(slug, "-")
}

var applyKeywordRE = regexp.MustCompile(`[a-z]+`)

var applyKeywordStop = map[string]bool{
	"a": true, "an": true, "the": true, "that": true, "which": true, "this": true,
	"with": true, "and": true, "or": true, "for": true, "from": true, "into": true,
	"onto": true, "upon": true, "about": true, "after": true, "before": true,
	"during": true, "is": true, "are": true, "was": true, "were": true, "be": true,
	"been": true, "being": true, "have": true, "has": true, "had": true, "do": true,
	"does": true, "did": true, "will": true, "would": true, "could": true,
	"should": true, "may": true, "might": true, "shall": true, "can": true,
	"to": true, "of": true, "in": true, "on": true, "at": true, "by": true,
	"up": true, "it": true, "its": true, "custom": true, "performs": true,
	"whether": true, "your": true, "when": true, "how": true,
}

// applyExtractKeywords keeps up to maxWords meaningful words from text,
// joined with hyphens, for slug material.
func applyExtractKeywords(text string, maxWords int) string {
	keywords := []string{}
	for _, w := range applyKeywordRE.FindAllString(strings.ToLower(text), -1) {
		if applyKeywordStop[w] || len(w) <= 2 {
			continue
		}
		keywords = append(keywords, w)
		if len(keywords) == maxWords {
			break
		}
	}
	return strings.Join(keywords, "-")
}

// applyDeriveName generates a readable component name from the agent name
// and a label, favoring the label's key action words over raw truncation.
func applyDeriveName(agentName, label string) string {
	prefix := strings.TrimRight(truncateRunes(applySlug(agentName), 16), "-")
	suffix := applyExtractKeywords(label, 4)
	if suffix == "" {
		suffix = truncateRunes(applySlug(label), 20)
	}
	available := applyMaxNameLen - len(prefix) - 1
	if available < 4 {
		return truncateRunes(applySlug(label), applyMaxNameLen)
	}
	suffix = strings.TrimRight(truncateRunes(suffix, available), "-")
	combined := strings.TrimRight(prefix+"-"+suffix, "-")
	if combined == "" {
		return "unnamed"
	}
	return combined
}

var applyShortNameRE = regexp.MustCompile(`^[a-z0-9\-]+$`)

// preferredComponentName keeps a short, valid model-provided name under the
// agent prefix, or derives one from the label.
func preferredComponentName(agent *applyAgent, feature map[string]any, oneLiner, kind string) string {
	rawName := str(feature["name"])
	if rawName != "" && len(rawName) <= 30 && applyShortNameRE.MatchString(rawName) {
		return strings.TrimRight(truncateRunes(applySlug(agent.name), 16), "-") + "-" + rawName
	}
	label := oneLiner
	if label == "" {
		if v, present := feature["feature"]; present {
			label = str(v)
		} else {
			label = kind
		}
	}
	return applyDeriveName(agent.name, label)
}

// ── Registry slugs ───────────────────────────────────────────────────────

var (
	registrySlugCleanRE = regexp.MustCompile(`[^a-z0-9_-]+`)
	registrySlugRE      = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
	registryReserved    = map[string]bool{
		"archive": true, "draft": true, "install": true, "resolve": true,
		"restore": true, "submit": true, "unarchive": true, "versions": true,
	}
)

// registrySlug converts a name to its canonical registry slug.
func registrySlug(value string) (string, error) {
	slug := registrySlugCleanRE.ReplaceAllString(strings.ToLower(strings.TrimSpace(value)), "-")
	slug = strings.Trim(slug, "-_")
	if slug == "" {
		return "", &ApplyError{Status: 400, Detail: "Name must contain at least one letter or number"}
	}
	slug = strings.TrimRight(truncateRunes(slug, 64), "-_")
	if !registrySlugRE.MatchString(slug) {
		return "", &ApplyError{Status: 400, Detail: "Slug must be at most 64 characters, start with a letter or number, " +
			"and contain only lowercase letters, numbers, hyphens, and underscores"}
	}
	if registryReserved[slug] {
		return "", &ApplyError{Status: 400, Detail: fmt.Sprintf("Slug '%s' is reserved", slug)}
	}
	return slug, nil
}

// ── SKILL.md handling ────────────────────────────────────────────────────

var (
	applyFrontmatterStartRE = regexp.MustCompile(`^---\r?\n`)
	applyFrontmatterRE      = regexp.MustCompile(`(?s)^---\r?\n(.*?)\r?\n---(?:\r?\n|$)`)
	applySlashCommandRE     = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
)

// ensureSkillMDFormat wraps raw example text in SKILL.md frontmatter when
// it is missing.
func ensureSkillMDFormat(name, description, rawExample string) string {
	if strings.HasPrefix(strings.TrimSpace(rawExample), "---") {
		return rawExample
	}
	fm := struct {
		Name        string `yaml:"name"`
		Description string `yaml:"description"`
		Version     string `yaml:"version"`
		TaskType    string `yaml:"task_type"`
	}{Name: name, Description: description, Version: "1.0.0", TaskType: "general"}
	body, err := yaml.Marshal(fm)
	if err != nil {
		body = nil
	}
	return "---\n" + strings.TrimSpace(string(body)) + "\n---\n\n# " + name + "\n\n" + rawExample + "\n"
}

// validateSkillMDFrontmatter checks stored SKILL.md content: frontmatter is
// optional, but a present block must be a valid YAML mapping and a present
// command key must normalize to a safe slash command.
func validateSkillMDFrontmatter(content string) error {
	if content == "" || !applyFrontmatterStartRE.MatchString(content) {
		return nil
	}
	m := applyFrontmatterRE.FindStringSubmatch(content)
	if m == nil {
		return errors.New("Malformed SKILL.md frontmatter")
	}
	var parsed any
	if err := yaml.Unmarshal([]byte(m[1]), &parsed); err != nil {
		return errors.New("Malformed SKILL.md frontmatter")
	}
	if parsed == nil {
		return nil
	}
	mapping, ok := parsed.(map[string]any)
	if !ok {
		return errors.New("SKILL.md frontmatter must be a YAML mapping")
	}
	if raw, present := mapping["command"]; present {
		command, isStr := raw.(string)
		if !isStr || command == "" {
			return errors.New("Invalid slash command: command must match ^[a-z0-9][a-z0-9_-]{0,63}$")
		}
		command = strings.TrimPrefix(command, "/")
		if !applySlashCommandRE.MatchString(command) {
			return errors.New("Invalid slash command: slash_command must match ^[a-z0-9][a-z0-9_-]{0,63}$")
		}
	}
	return nil
}

// ── Component creation ───────────────────────────────────────────────────

// createSkillListing materializes a features_to_try suggestion as a pending
// skill submission; nil means the suggestion was skipped.
func createSkillListing(ctx context.Context, tx pgx.Tx, agent *applyAgent, feature map[string]any, submitter, actor uuid.UUID) (map[string]any, error) {
	oneLiner := str(feature["one_liner"])
	example := str(feature["example"])
	if example == "" {
		return nil, nil
	}
	name := preferredComponentName(agent, feature, oneLiner, "skill")
	skillMD := ensureSkillMDFormat(name, oneLiner, example)
	if err := validateSkillMDFrontmatter(skillMD); err != nil {
		slog.Warn("self-learn skill validation failed", "name", name, "error", err)
		return nil, nil
	}
	description := oneLiner
	if description == "" {
		description = "Skill for " + agent.name
	}
	slug, err := registrySlug(name)
	if err != nil {
		return nil, err
	}
	if exists, err := applyIdentityExists(ctx, tx, "skill_listings", agent.namespace, slug); err != nil || exists {
		return nil, err
	}
	targetAgents, _ := json.Marshal([]string{agent.name})
	listingID, err := applyInsertListing(ctx, tx, "skill_listings", name, agent, slug, submitter)
	if err != nil {
		return nil, err
	}
	var versionID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO skill_versions (
			id, listing_id, version, description, status, download_count,
			released_by, released_at, created_at, supported_harnesses, skill_path,
			skill_md_content, delivery_mode, validated, target_agents, task_type, is_editing)
		VALUES (gen_random_uuid(), $1, '1.0.0', $2, 'pending', 0, $3, now(), now(),
		        '["claude-code", "kiro", "pi"]'::json, '/', $4, 'registry_direct',
		        FALSE, $5::json, 'general', FALSE)
		RETURNING id::text`,
		listingID, description, submitter, skillMD, string(targetAgents)).Scan(&versionID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE skill_listings SET latest_version_id = $1 WHERE id = $2`, versionID, listingID); err != nil {
		return nil, err
	}
	if err := deliverReviewRequested(ctx, tx, listingSubject("skill", listingID, name, agent, slug, "1.0.0"), nil, false, actor); err != nil {
		return nil, err
	}
	return map[string]any{"id": listingID, "name": name, "description": oneLiner, "type": "skill"}, nil
}

// createHookListing materializes a features_to_try suggestion as a pending
// hook submission; nil means the suggestion was skipped.
func createHookListing(ctx context.Context, tx pgx.Tx, agent *applyAgent, feature map[string]any, submitter, actor uuid.UUID) (map[string]any, error) {
	oneLiner := str(feature["one_liner"])
	example := str(feature["example"])
	if example == "" {
		return nil, nil
	}
	name := preferredComponentName(agent, feature, oneLiner, "hook")
	event, executionMode, scriptContent := parseHookExample(example)
	scriptContent = normalizeHookScript(scriptContent, name)
	scriptFilename := name + ".sh"
	description := oneLiner
	if description == "" {
		description = "Hook for " + agent.name
	}
	slug, err := registrySlug(name)
	if err != nil {
		return nil, err
	}
	if exists, err := applyIdentityExists(ctx, tx, "hook_listings", agent.namespace, slug); err != nil || exists {
		return nil, err
	}
	listingID, err := applyInsertListing(ctx, tx, "hook_listings", name, agent, slug, submitter)
	if err != nil {
		return nil, err
	}
	var versionID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO hook_versions (
			id, listing_id, version, description, status, download_count,
			released_by, released_at, created_at, supported_harnesses, event,
			execution_mode, priority, handler_type, handler_config, scope,
			script_content, script_filename, is_editing)
		VALUES (gen_random_uuid(), $1, '1.0.0', $2, 'pending', 0, $3, now(), now(),
		        '["claude-code", "kiro", "pi"]'::json, $4, $5, 100, 'command',
		        '{"inline": true}'::json, 'agent', $6, $7, FALSE)
		RETURNING id::text`,
		listingID, description, submitter, event, executionMode, scriptContent, scriptFilename).Scan(&versionID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE hook_listings SET latest_version_id = $1 WHERE id = $2`, versionID, listingID); err != nil {
		return nil, err
	}
	if err := deliverReviewRequested(ctx, tx, listingSubject("hook", listingID, name, agent, slug, "1.0.0"), nil, false, actor); err != nil {
		return nil, err
	}
	return map[string]any{"id": listingID, "name": name, "description": oneLiner, "type": "hook"}, nil
}

// createPromptListing materializes a usage_patterns suggestion as a pending
// prompt submission; nil means the suggestion was skipped.
func createPromptListing(ctx context.Context, tx pgx.Tx, agent *applyAgent, pattern map[string]any, submitter, actor uuid.UUID) (map[string]any, error) {
	title := str(pattern["title"])
	copyablePrompt := str(pattern["copyable_prompt"])
	detail := str(pattern["detail"])
	if copyablePrompt == "" {
		return nil, nil
	}
	label := title
	if label == "" {
		label = "prompt"
	}
	name := applyDeriveName(agent.name, label)
	description := detail
	if description == "" {
		description = "Prompt pattern for " + agent.name
	}
	slug, err := registrySlug(name)
	if err != nil {
		return nil, err
	}
	if exists, err := applyIdentityExists(ctx, tx, "prompt_listings", agent.namespace, slug); err != nil || exists {
		return nil, err
	}
	tags, _ := json.Marshal([]string{"self-learn", agent.name})
	listingID, err := applyInsertListing(ctx, tx, "prompt_listings", name, agent, slug, submitter)
	if err != nil {
		return nil, err
	}
	var versionID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO prompt_versions (
			id, listing_id, version, description, status, download_count,
			released_by, released_at, created_at, supported_harnesses, category,
			template, variables, tags, is_editing)
		VALUES (gen_random_uuid(), $1, '1.0.0', $2, 'pending', 0, $3, now(), now(),
		        '[]'::json, 'general', $4, '[]'::json, $5::json, FALSE)
		RETURNING id::text`,
		listingID, description, submitter, copyablePrompt, string(tags)).Scan(&versionID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE prompt_listings SET latest_version_id = $1 WHERE id = $2`, versionID, listingID); err != nil {
		return nil, err
	}
	if err := deliverReviewRequested(ctx, tx, listingSubject("prompt", listingID, name, agent, slug, "1.0.0"), nil, false, actor); err != nil {
		return nil, err
	}
	infoDescription := detail
	if infoDescription == "" {
		infoDescription = title
	}
	return map[string]any{"id": listingID, "name": name, "description": infoDescription, "type": "prompt"}, nil
}

func applyIdentityExists(ctx context.Context, tx pgx.Tx, table, namespace, slug string) (bool, error) {
	var one int
	err := tx.QueryRow(ctx, fmt.Sprintf(
		`SELECT 1 FROM %s WHERE namespace = $1 AND slug = $2 LIMIT 1`, table), namespace, slug).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func applyInsertListing(ctx context.Context, tx pgx.Tx, table, name string, agent *applyAgent, slug string, submitter uuid.UUID) (string, error) {
	var listingID string
	err := tx.QueryRow(ctx, fmt.Sprintf(`
		INSERT INTO %s (
			id, name, namespace, slug, owner, is_private, ownership_scope,
			submitted_by, co_authors, unique_agents, created_at, updated_at)
		VALUES (gen_random_uuid(), $1, $2, $3, $4, FALSE, 'project', $5, '[]'::json, 0, now(), now())
		RETURNING id::text`, table),
		name, agent.namespace, slug, agent.owner, submitter).Scan(&listingID)
	return listingID, err
}

// ── Hook script shaping ──────────────────────────────────────────────────

func splitTextLines(s string) []string {
	if s == "" {
		return nil
	}
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	lines := strings.Split(s, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

// parseHookExample reads the hook event and execution mode from "# hook:"
// annotation lines; everything else is the script body.
func parseHookExample(example string) (event, executionMode, scriptContent string) {
	event = "Stop"
	executionMode = "async"
	scriptLines := []string{}
	for _, line := range splitTextLines(strings.TrimSpace(example)) {
		lower := strings.TrimSpace(strings.ToLower(line))
		if strings.HasPrefix(lower, "# hook:") {
			hookDesc := strings.TrimSpace(strings.ReplaceAll(lower, "# hook:", ""))
			switch {
			case strings.Contains(hookDesc, "commit") || strings.Contains(hookDesc, "push") || strings.Contains(hookDesc, "before"):
				event, executionMode = "Stop", "blocking"
			case strings.Contains(hookDesc, "start") || strings.Contains(hookDesc, "init") || strings.Contains(hookDesc, "session"):
				event, executionMode = "SessionStart", "async"
			case strings.Contains(hookDesc, "prompt") || strings.Contains(hookDesc, "submit"):
				event, executionMode = "UserPromptSubmit", "sync"
			case strings.Contains(hookDesc, "tool") && strings.Contains(hookDesc, "pre"):
				event, executionMode = "PreToolUse", "sync"
			case strings.Contains(hookDesc, "tool") && strings.Contains(hookDesc, "post"):
				event, executionMode = "PostToolUse", "async"
			default:
				event, executionMode = "Stop", "async"
			}
		} else {
			scriptLines = append(scriptLines, line)
		}
	}
	scriptContent = strings.TrimSpace(strings.Join(scriptLines, "\n"))
	if scriptContent == "" {
		scriptContent = strings.TrimSpace(example)
	}
	return event, executionMode, scriptContent
}

// normalizeHookScript turns model-generated pseudocode into an executable
// script: shell content gets a bash wrapper, Python-looking content a
// python3 wrapper marked for review, and anything unclear becomes a
// commented placeholder.
func normalizeHookScript(rawScript, name string) string {
	lines := splitTextLines(strings.TrimSpace(rawScript))
	if len(lines) > 0 && strings.HasPrefix(lines[0], "#!") {
		return rawScript
	}
	pythonIndicators := []string{"def ", "import ", "class ", "context.get", "return {"}
	pythonScore := 0
	for _, line := range lines {
		for _, ind := range pythonIndicators {
			if strings.Contains(line, ind) {
				pythonScore++
				break
			}
		}
	}
	shellIndicators := []string{"pytest", "ruff ", "git ", "npm ", "make ", "cd ", "echo ", "exit "}
	shellScore := 0
	for _, line := range lines {
		lower := strings.ToLower(line)
		for _, ind := range shellIndicators {
			if strings.Contains(lower, ind) {
				shellScore++
				break
			}
		}
	}
	if shellScore > pythonScore {
		return "#!/usr/bin/env bash\nset -euo pipefail\n# Generated by Caracal Insights for: " + name + "\n\n" + rawScript
	}
	if pythonScore > 0 {
		return "#!/usr/bin/env python3\n" +
			"# Generated by Caracal Insights for: " + name + "\n" +
			"# NOTE: This script was auto-generated from insight suggestions.\n" +
			"# Review and adapt before approving.\n\n" + rawScript
	}
	commented := []string{}
	for _, line := range lines {
		if strings.TrimSpace(line) != "" {
			commented = append(commented, "# "+line)
		}
	}
	return "#!/usr/bin/env bash\nset -euo pipefail\n" +
		"# Generated by Caracal Insights for: " + name + "\n" +
		"# TODO: Implement the following logic:\n" +
		strings.Join(commented, "\n") + "\n\n" +
		"echo \"[" + name + "] Hook executed successfully\"\n"
}

// ── Agent version assembly ───────────────────────────────────────────────

var applySemverRE = regexp.MustCompile(`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$`)

func bumpPatchVersion(current string) string {
	m := applySemverRE.FindStringSubmatch(current)
	if m == nil {
		return "1.0.0"
	}
	major, err1 := strconv.Atoi(m[1])
	minor, err2 := strconv.Atoi(m[2])
	patch, err3 := strconv.Atoi(m[3])
	if err1 != nil || err2 != nil || err3 != nil {
		return "1.0.0"
	}
	return fmt.Sprintf("%d.%d.%d", major, minor, patch+1)
}

// buildAdditionsText renders the prompt-addition block from the selected
// config_additions entries.
func buildAdditionsText(additions []map[string]any) string {
	lines := []string{}
	for _, addition := range additions {
		text := strings.TrimSpace(str(addition["addition"]))
		if text == "" {
			continue
		}
		where := "system_prompt"
		if v, present := addition["where"]; present {
			where = str(v)
		}
		if where == "system_prompt" || where == "AGENTS.md" || where == "agent_config" {
			if why := str(addition["why"]); why != "" {
				lines = append(lines, "# Reason: "+why)
			}
			lines = append(lines, text, "")
		}
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

// createAgentVersionWithAdditions builds a new pending agent version with
// the selected prompt additions appended, carrying the latest approved
// version's components minus removals plus the created and reused ones.
// The review queue then enforces approval dependency for the whole set.
func createAgentVersionWithAdditions(ctx context.Context, tx pgx.Tx, agent *applyAgent,
	selectedAdditions []map[string]any, submitter uuid.UUID, newComponents []createdComponent,
	linkedExisting []resolvedComponent, removedIDs []uuid.UUID, actor uuid.UUID) (map[string]any, error) {

	var latestID, latestVersion, currentPrompt, modelName string
	var modelConfig, modelsByHarness, externalMcps, supportedHarnesses []byte
	err := tx.QueryRow(ctx, `
		SELECT id::text, version, prompt, model_name, model_config_json,
		       models_by_harness, external_mcps, supported_harnesses
		FROM agent_versions
		WHERE agent_id = $1 AND status = 'approved'
		ORDER BY created_at DESC
		LIMIT 1`, agent.id).
		Scan(&latestID, &latestVersion, &currentPrompt, &modelName,
			&modelConfig, &modelsByHarness, &externalMcps, &supportedHarnesses)
	if errors.Is(err, pgx.ErrNoRows) {
		slog.Warn("self-learn found no approved version", "agent", agent.name)
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	// Additions already present in the prompt verbatim are dropped.
	existingPromptLower := strings.ToLower(currentPrompt)
	additions := []map[string]any{}
	for _, item := range selectedAdditions {
		text := str(item["addition"])
		if !truthyAny(item["addition"]) ||
			strings.Contains(existingPromptLower, strings.ToLower(strings.TrimSpace(text))) {
			continue
		}
		additions = append(additions, item)
	}
	additionsText := buildAdditionsText(additions)

	if strings.TrimSpace(additionsText) == "" && len(newComponents) == 0 &&
		len(linkedExisting) == 0 && len(removedIDs) == 0 {
		return nil, nil
	}

	newPrompt := currentPrompt
	if strings.TrimSpace(additionsText) != "" {
		newPrompt = currentPrompt + selfLearnSeparator + additionsText
	}

	currentVer := latestVersion
	if currentVer == "" {
		currentVer = "1.0.0"
	}
	newVer := bumpPatchVersion(currentVer)
	versionTaken := func(v string) (bool, error) {
		var one int
		err := tx.QueryRow(ctx,
			`SELECT 1 FROM agent_versions WHERE agent_id = $1 AND version = $2 LIMIT 1`, agent.id, v).Scan(&one)
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return err == nil, err
	}
	taken, err := versionTaken(newVer)
	if err != nil {
		return nil, err
	}
	if taken {
		free := false
		for range 10 {
			newVer = bumpPatchVersion(newVer)
			if taken, err = versionTaken(newVer); err != nil {
				return nil, err
			}
			if !taken {
				free = true
				break
			}
		}
		if !free {
			slog.Error("self-learn version numbering exhausted", "agent", agent.name)
			return nil, nil
		}
	}

	totalLinked := len(newComponents) + len(linkedExisting)
	descParts := []string{}
	if len(additions) > 0 {
		descParts = append(descParts, fmt.Sprintf("%d prompt additions", len(additions)))
	}
	if totalLinked > 0 {
		descParts = append(descParts, fmt.Sprintf("%d linked components", totalLinked))
	}
	if len(removedIDs) > 0 {
		descParts = append(descParts, fmt.Sprintf("%d removed components", len(removedIDs)))
	}
	description := "Self-learned from insights: " + strings.Join(descParts, ", ")

	var newVersionID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO agent_versions (
			id, agent_id, version, description, prompt, model_name, model_config_json,
			models_by_harness, external_mcps, supported_harnesses, required_capabilities,
			inferred_supported_harnesses, status, is_prerelease, download_count,
			released_by, released_at, created_at, is_editing)
		VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6::json, $7::json, $8::json,
		        $9::json, '[]'::json, '[]'::json, 'pending', FALSE, 0, $10, now(), now(), FALSE)
		RETURNING id::text`,
		agent.id, newVer, description, newPrompt, modelName, string(modelConfig),
		string(modelsByHarness), string(externalMcps), string(supportedHarnesses),
		submitter).Scan(&newVersionID); err != nil {
		return nil, err
	}

	insertComponent := func(ctype, cid, cname, resolvedVersion string, orderIndex int, configOverride []byte) error {
		var override any
		if configOverride != nil {
			override = string(configOverride)
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO agent_components (
				id, agent_version_id, component_type, component_id, component_name,
				resolved_version, order_index, config_override, created_at)
			VALUES (gen_random_uuid(), $1, $2, $3::uuid, $4, $5, $6, $7::json, now())`,
			newVersionID, ctype, cid, cname, resolvedVersion, orderIndex, override)
		return err
	}

	removedSet := map[string]bool{}
	for _, id := range removedIDs {
		removedSet[id.String()] = true
	}

	// Carry the latest version's components, minus the removals.
	orderIdx := 0
	carriedIDs := map[string]bool{}
	rows, err := tx.Query(ctx, `
		SELECT component_type, component_id::text, component_name, resolved_version,
		       order_index, config_override
		FROM agent_components WHERE agent_version_id = $1
		ORDER BY order_index`, latestID)
	if err != nil {
		return nil, err
	}
	type carriedComponent struct {
		ctype, cid, cname, version string
		order                      int
		override                   []byte
	}
	carried := []carriedComponent{}
	for rows.Next() {
		var c carriedComponent
		if err := rows.Scan(&c.ctype, &c.cid, &c.cname, &c.version, &c.order, &c.override); err != nil {
			rows.Close()
			return nil, err
		}
		carried = append(carried, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, c := range carried {
		if removedSet[c.cid] {
			continue
		}
		carriedIDs[c.cid] = true
		if err := insertComponent(c.ctype, c.cid, c.cname, c.version, c.order, c.override); err != nil {
			return nil, err
		}
		if c.order+1 > orderIdx {
			orderIdx = c.order + 1
		}
	}

	// Components created in this run are always born at 1.0.0; resolve
	// their names so later reports do not fall back to a UUID stub.
	createdNames, err := componentDisplayNames(ctx, tx, newComponents)
	if err != nil {
		return nil, err
	}
	for _, component := range newComponents {
		if err := insertComponent(component.ctype, component.id, createdNames[component.id], "1.0.0", orderIdx, nil); err != nil {
			return nil, err
		}
		orderIdx++
	}

	// Reused registry components attach at the version the registry
	// actually has; pinning a version that does not exist breaks agent
	// pulls. Anything the agent already carries is skipped: an agent can
	// gain a component between report generation and apply, and a second
	// row for one component would pin two differing resolved versions.
	for _, resolved := range linkedExisting {
		if carriedIDs[resolved.id] {
			slog.Info("self-learn reuse already attached",
				"agent", agent.name, "component", resolved.namespace+"/"+resolved.slug)
			continue
		}
		carriedIDs[resolved.id] = true
		if err := insertComponent(resolved.componentType, resolved.id, resolved.name,
			resolved.latestVersion, orderIdx, nil); err != nil {
			return nil, err
		}
		orderIdx++
	}

	if err := refreshCapabilityInference(ctx, tx, newVersionID, externalMcps); err != nil {
		slog.Warn("self-learn capability inference failed", "version", newVer, "error", err)
	}

	// A pending self-learned version sits in the same queue as a
	// hand-released one; the reviewers who will clear it are told the same
	// way.
	subject := inbox.Subject{
		Type:      "agent",
		Name:      agent.name,
		Namespace: &agent.namespace,
		Slug:      &agent.slug,
		Version:   &newVer,
		IsPrivate: agent.isPrivate,
	}
	if id, err := uuid.Parse(agent.id); err == nil {
		subject.ID = &id
	}
	if err := deliverReviewRequested(ctx, tx, subject, agent.projectID, agent.isPrivate, actor); err != nil {
		return nil, err
	}

	return map[string]any{
		"id":                 newVersionID,
		"version":            newVer,
		"additions_count":    len(additions),
		"linked_components":  totalLinked,
		"removed_components": len(removedIDs),
	}, nil
}

// componentDisplayNames looks up display names for freshly created listings.
func componentDisplayNames(ctx context.Context, tx pgx.Tx, components []createdComponent) (map[string]string, error) {
	names := map[string]string{}
	byType := map[string][]string{}
	typeOrder := []string{}
	for _, component := range components {
		if _, seen := byType[component.ctype]; !seen {
			typeOrder = append(typeOrder, component.ctype)
		}
		byType[component.ctype] = append(byType[component.ctype], component.id)
	}
	for _, ctype := range typeOrder {
		prefix, ok := applyTypePrefix[ctype]
		if !ok {
			continue
		}
		rows, err := tx.Query(ctx, fmt.Sprintf(
			`SELECT id::text, name FROM %s WHERE id = ANY($1::uuid[])`,
			registry.Families[prefix].ListingTable), byType[ctype])
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id, name string
			if err := rows.Scan(&id, &name); err != nil {
				rows.Close()
				return nil, err
			}
			names[id] = name
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	return names, nil
}

// refreshCapabilityInference recomputes the required capabilities and the
// harnesses that satisfy them for a freshly built version, so pull-time
// compatibility warnings stay accurate.
func refreshCapabilityInference(ctx context.Context, tx pgx.Tx, versionID string, externalMcps []byte) error {
	rows, err := tx.Query(ctx, `
		SELECT component_type, component_id::text
		FROM agent_components WHERE agent_version_id = $1`, versionID)
	if err != nil {
		return err
	}
	features := map[string]bool{}
	skillIDs := []string{}
	for rows.Next() {
		var ctype, cid string
		if err := rows.Scan(&ctype, &cid); err != nil {
			rows.Close()
			return err
		}
		switch ctype {
		case "mcp":
			features["mcp_servers"] = true
		case "hook":
			features["hooks"] = true
		case "skill":
			skillIDs = append(skillIDs, cid)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	// A skill only demands the skills capability when it carries a slash
	// command.
	if len(skillIDs) > 0 {
		skillRows, err := tx.Query(ctx, `
			SELECT coalesce(v.slash_command, '')
			FROM skill_listings l LEFT JOIN skill_versions v ON l.latest_version_id = v.id
			WHERE l.id = ANY($1::uuid[])`, skillIDs)
		if err != nil {
			return err
		}
		for skillRows.Next() {
			var slash string
			if err := skillRows.Scan(&slash); err != nil {
				skillRows.Close()
				return err
			}
			if slash != "" {
				features["skills"] = true
			}
		}
		skillRows.Close()
		if err := skillRows.Err(); err != nil {
			return err
		}
	}

	var externals []any
	_ = json.Unmarshal(externalMcps, &externals)
	if len(externals) > 0 {
		features["mcp_servers"] = true
	}

	required := make([]string, 0, len(features))
	for feature := range features {
		required = append(required, feature)
	}
	sort.Strings(required)

	reg, err := applyHarnessRegistry()
	if err != nil {
		return err
	}
	supported := []string{}
	for _, name := range reg.Names() {
		spec, ok := reg.Spec(name)
		if !ok {
			continue
		}
		hasAll := true
		for _, feature := range required {
			if !spec.HasCapability(harness.Capability(feature)) {
				hasAll = false
				break
			}
		}
		if hasAll {
			supported = append(supported, name)
		}
	}
	sort.Strings(supported)

	requiredJSON, err := json.Marshal(required)
	if err != nil {
		return err
	}
	supportedJSON, err := json.Marshal(supported)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		UPDATE agent_versions
		SET required_capabilities = $2::json, inferred_supported_harnesses = $3::json
		WHERE id = $1`, versionID, string(requiredJSON), string(supportedJSON))
	return err
}

// ── Review fan-out ───────────────────────────────────────────────────────

func listingSubject(subjectType, listingID, name string, agent *applyAgent, slug, version string) inbox.Subject {
	subject := inbox.Subject{
		Type:      subjectType,
		Name:      name,
		Namespace: &agent.namespace,
		Slug:      &slug,
		Version:   &version,
		IsPrivate: false,
	}
	if id, err := uuid.Parse(listingID); err == nil {
		subject.ID = &id
	}
	return subject
}

// deliverReviewRequested tells everyone who can clear the pending item:
// project-shared work notifies that project's leads; public work notifies
// global reviewers plus the owning project's leads; a private item without
// a project falls back to deployment operators.
func deliverReviewRequested(ctx context.Context, tx pgx.Tx, subject inbox.Subject, projectID *uuid.UUID, isPrivate bool, actor uuid.UUID) error {
	collect := func(sql string, args ...any) ([]uuid.UUID, error) {
		rows, err := tx.Query(ctx, sql, args...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := []uuid.UUID{}
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err != nil {
				return nil, err
			}
			out = append(out, id)
		}
		return out, rows.Err()
	}

	var recipients []uuid.UUID
	var err error
	switch {
	case isPrivate && projectID == nil:
		recipients, err = collect(`SELECT id FROM users WHERE role = 'operator'`)
	case isPrivate:
		recipients, err = collect(
			`SELECT user_id FROM project_memberships WHERE project_id = $1 AND role = 'lead'`, *projectID)
	default:
		recipients, err = collect(`SELECT id FROM users WHERE role IN ('reviewer', 'operator')`)
		if err == nil && projectID != nil {
			leads, leadErr := collect(
				`SELECT user_id FROM project_memberships WHERE project_id = $1 AND role = 'lead'`, *projectID)
			if leadErr != nil {
				return leadErr
			}
			seen := map[uuid.UUID]bool{}
			merged := []uuid.UUID{}
			for _, id := range append(recipients, leads...) {
				if !seen[id] {
					seen[id] = true
					merged = append(merged, id)
				}
			}
			recipients = merged
		}
	}
	if err != nil {
		return err
	}
	_, err = inbox.Deliver(ctx, tx, "review_requested", recipients, subject, &actor, nil, nil, true)
	return err
}
