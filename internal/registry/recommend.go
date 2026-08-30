// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

const (
	recommendDefaultLimit = 8
	candidatePool         = 40
	popularityWeight      = 0.4
	popularityCap         = 50
	shortlistOverfetch    = 3
)

// wireFloat renders like the upstream serializer: integral values keep a
// trailing .0 so a float never reads as an int.
type wireFloat float64

func (f wireFloat) MarshalJSON() ([]byte, error) {
	if f == wireFloat(math.Trunc(float64(f))) && math.Abs(float64(f)) < 1e15 {
		return []byte(strconv.FormatFloat(float64(f), 'f', 1, 64)), nil
	}
	return []byte(strconv.FormatFloat(float64(f), 'g', -1, 64)), nil
}

// candidate is a registry component that plausibly matches the signals.
type candidate struct {
	Type          string    `json:"type"`
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	Namespace     string    `json:"namespace"`
	Slug          string    `json:"slug"`
	QualifiedName string    `json:"qualified_name"`
	Description   string    `json:"description"`
	Category      *string   `json:"category"`
	LatestVersion string    `json:"latest_version"`
	DownloadCount int       `json:"download_count"`
	MatchedOn     []string  `json:"matched_on"`
	Score         wireFloat `json:"score"`

	componentType string
	// rawScore orders candidates; Score is its display rounding.
	rawScore float64
}

// recommendation adds the "why you" line to a candidate.
type recommendation struct {
	candidate
	Reason string `json:"reason"`
}

// recommenderVisibilitySQL is the worker-safe visibility rule: public,
// personal-private for the submitter, and project-private for members. It is
// deliberately the recommender's own rule, without the scoped-listing arms.
func recommenderVisibilitySQL(viewer *Viewer, args *[]any) string {
	*args = append(*args, viewer.ID)
	arg := fmt.Sprintf("$%d", len(*args))
	return fmt.Sprintf(`(l.is_private = FALSE
		OR (l.is_private = TRUE AND (l.ownership_scope = 'private' OR l.project_id IS NULL) AND l.submitted_by = %s)
		OR (l.is_private = TRUE AND l.project_id IS NOT NULL AND l.ownership_scope != 'private' AND EXISTS (
			SELECT 1 FROM project_memberships pm WHERE pm.project_id = l.project_id AND pm.user_id = %s)))`, arg, arg)
}

// recommendSearchFields are the text columns worth matching per family.
func recommendSearchFields(f Family) []string {
	fields := []string{"l.name", "v.description"}
	switch f.Prefix {
	case "mcps":
		fields = append(fields, "l.category")
	case "skills":
		fields = append(fields, "v.task_type")
	case "hooks":
		fields = append(fields, "v.event")
	case "prompts":
		fields = append(fields, "v.category")
	}
	return fields
}

func candidateCategory(f Family, row map[string]any) *string {
	switch f.Prefix {
	case "mcps", "prompts":
		return rowNStr(row, "category")
	case "skills":
		return rowNStr(row, "task_type")
	case "hooks":
		return rowNStr(row, "event")
	}
	return nil
}

var signalWordRE = regexp.MustCompile(`[A-Za-z0-9][A-Za-z0-9_-]*`)

// tokenDisplayMap restores each stemmed token to the word the caller wrote,
// so matches never read as typos ("postgre" shows as "postgres").
func tokenDisplayMap(signals string) map[string]string {
	mapping := map[string]string{}
	for _, word := range signalWordRE.FindAllString(signals, -1) {
		for _, token := range searchTerms(word) {
			if _, seen := mapping[token]; !seen {
				mapping[token] = strings.ToLower(word)
			}
		}
	}
	return mapping
}

// recommendTokens tokenizes signals without the phrase entry the search
// terms prepend; matching happens per token.
func recommendTokens(signals string) []string {
	terms := searchTerms(signals)
	if len(terms) <= 1 {
		return terms
	}
	return terms[1:]
}

func matchedTerms(tokens []string, haystack string, display map[string]string) []string {
	lowered := strings.ToLower(haystack)
	out := []string{}
	for _, token := range tokens {
		if strings.Contains(lowered, token) {
			if shown, ok := display[token]; ok {
				out = append(out, shown)
			} else {
				out = append(out, token)
			}
		}
	}
	return out
}

// Shortlist returns the most relevant visible approved components for the
// signals; empty signals fall back to popularity, which cold starts want.
func (s *Store) Shortlist(ctx context.Context, signals string, families []Family, viewer *Viewer, excludeIDs map[string]bool, perTypeLimit, totalLimit int) ([]candidate, error) {
	tokens := recommendTokens(signals)
	display := tokenDisplayMap(signals)

	candidates := []candidate{}
	for _, f := range families {
		args := []any{}
		where := []string{"v.status = 'approved'", recommenderVisibilitySQL(viewer, &args)}
		if len(excludeIDs) > 0 {
			ids := make([]string, 0, len(excludeIDs))
			for id := range excludeIDs {
				ids = append(ids, id)
			}
			args = append(args, ids)
			where = append(where, fmt.Sprintf("l.id != ALL($%d::uuid[])", len(args)))
		}
		order := "v.download_count DESC, l.created_at DESC"
		if terms := searchTerms(signals); terms != nil {
			cond, rank := searchSQL(terms, "l.name", recommendSearchFields(f), &args)
			where = append(where, cond)
			order = "(" + rank + ") DESC, v.download_count DESC"
		}
		args = append(args, perTypeLimit*shortlistOverfetch)
		sql := fmt.Sprintf(`SELECT %s FROM %s l
			JOIN %s v ON l.latest_version_id = v.id
			WHERE %s ORDER BY %s LIMIT $%d`,
			detailColumns(f), f.ListingTable, f.VersionTable,
			strings.Join(where, " AND "), order, len(args))
		rows, err := s.DB.Query(ctx, sql, args...)
		if err != nil {
			continue
		}
		scanned := collectRows(rows)
		rows.Close()

		typed := []candidate{}
		for _, row := range scanned {
			category := candidateCategory(f, row)
			haystackParts := []string{rowStr(row, "name", ""), rowStr(row, "description", "")}
			if category != nil {
				haystackParts = append(haystackParts, *category)
			}
			matched := matchedTerms(tokens, strings.Join(haystackParts, " "), display)
			downloads := rowInt(row, "download_count", 0)
			capped := downloads
			if capped > popularityCap {
				capped = popularityCap
			}
			score := float64(len(matched)) + float64(capped)/popularityCap*popularityWeight
			typed = append(typed, candidate{
				Type:          f.Name,
				ID:            rowStr(row, "id", ""),
				Name:          rowStr(row, "name", ""),
				Namespace:     rowStr(row, "namespace", ""),
				Slug:          rowStr(row, "slug", ""),
				QualifiedName: rowStr(row, "namespace", "") + "/" + rowStr(row, "slug", ""),
				Description:   rowStr(row, "description", ""),
				Category:      category,
				LatestVersion: rowStr(row, "version", ""),
				DownloadCount: downloads,
				MatchedOn:     matched,
				Score:         wireFloat(math.Round(score*1000) / 1000),
				componentType: f.Name,
				rawScore:      score,
			})
		}
		sort.SliceStable(typed, func(i, j int) bool {
			if typed[i].rawScore != typed[j].rawScore {
				return typed[i].rawScore > typed[j].rawScore
			}
			if typed[i].DownloadCount != typed[j].DownloadCount {
				return typed[i].DownloadCount > typed[j].DownloadCount
			}
			return strings.ToLower(typed[i].Name) < strings.ToLower(typed[j].Name)
		})
		if len(typed) > perTypeLimit {
			typed = typed[:perTypeLimit]
		}
		candidates = append(candidates, typed...)
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].rawScore != candidates[j].rawScore {
			return candidates[i].rawScore > candidates[j].rawScore
		}
		if candidates[i].DownloadCount != candidates[j].DownloadCount {
			return candidates[i].DownloadCount > candidates[j].DownloadCount
		}
		if candidates[i].componentType != candidates[j].componentType {
			return candidates[i].componentType < candidates[j].componentType
		}
		return strings.ToLower(candidates[i].Name) < strings.ToLower(candidates[j].Name)
	})
	if len(candidates) > totalLimit {
		candidates = candidates[:totalLimit]
	}
	return candidates, nil
}

// installedComponentIDs derives adoption from agent installs.
func (s *Store) installedComponentIDs(ctx context.Context, userID uuid.UUID) map[string]bool {
	out := map[string]bool{}
	rows, err := s.DB.Query(ctx, `
		SELECT ac.component_id::text
		FROM agent_components ac
		JOIN agent_versions av ON ac.agent_version_id = av.id
		JOIN agents a ON a.latest_version_id = av.id
		JOIN agent_download_records adr ON adr.agent_id = a.id
		WHERE adr.user_id = $1`, userID)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			out[id] = true
		}
	}
	return out
}

// suppressedComponentIDs are the ones the user told us to stop suggesting.
func (s *Store) suppressedComponentIDs(ctx context.Context, userID uuid.UUID) map[string]bool {
	out := map[string]bool{}
	rows, err := s.DB.Query(ctx, `
		SELECT component_id::text FROM recommendation_feedback
		WHERE user_id = $1 AND action IN ('dismissed', 'not_relevant', 'installed')`, userID)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			out[id] = true
		}
	}
	return out
}

// explain says why a component was recommended, from what actually matched.
func explain(c candidate, profile *WorkProfile) string {
	if len(c.MatchedOn) > 0 {
		shown := c.MatchedOn
		if len(shown) > 3 {
			shown = shown[:3]
		}
		return "Matches your work on " + strings.Join(shown, ", ")
	}
	if profile.isEmpty() {
		return "Popular in your registry"
	}
	return "Popular among components like the ones you use"
}

// RecommendForUser ranks components for one user; failures degrade to an
// empty or popularity-only rail, never an error.
func (s *Store) RecommendForUser(ctx context.Context, viewer *Viewer, profile *WorkProfile, families []Family, limit int) []recommendation {
	exclude := s.installedComponentIDs(ctx, viewer.ID)
	for id := range s.suppressedComponentIDs(ctx, viewer.ID) {
		exclude[id] = true
	}
	perType := limit
	if perType < 4 {
		perType = 4
	}
	candidates, err := s.Shortlist(ctx, profile.searchSignals(), families, viewer, exclude, perType, candidatePool)
	if err != nil {
		return []recommendation{}
	}
	if len(candidates) > limit {
		candidates = candidates[:limit]
	}
	out := make([]recommendation, 0, limit)
	for _, c := range candidates {
		out = append(out, recommendation{candidate: c, Reason: explain(c, profile)})
	}
	// A thin profile can match almost nothing; top up with popularity,
	// labelled as popularity rather than a personal match.
	if len(out) < limit {
		already := map[string]bool{}
		for id := range exclude {
			already[id] = true
		}
		for _, r := range out {
			already[r.ID] = true
		}
		filler, err := s.Shortlist(ctx, "", families, viewer, already, limit, limit-len(out))
		if err == nil {
			for _, c := range filler {
				out = append(out, recommendation{candidate: c, Reason: "Popular in your registry"})
			}
		}
	}
	return out
}

// RecordFeedback persists a dismissal or install report, first writer wins.
func (s *Store) RecordFeedback(ctx context.Context, userID uuid.UUID, componentType string, componentID uuid.UUID, action string) error {
	_, err := s.DB.Exec(ctx, `
		INSERT INTO recommendation_feedback (id, user_id, component_type, component_id, action, created_at)
		VALUES (gen_random_uuid(), $1, $2, $3, $4, now())
		ON CONFLICT (user_id, component_type, component_id) DO NOTHING`,
		userID, componentType, componentID, action)
	if isUniqueViolation(err) {
		return nil
	}
	return err
}
