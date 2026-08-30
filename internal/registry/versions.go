// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// versionExtras lists the DB-backed payload columns each family's version
// rows expose beyond the managed base fields.
var versionExtras = map[string][]string{
	"mcps": {"source_url", "source_ref", "resolved_sha", "transport", "framework", "docker_image",
		"command", "args", "url", "headers", "auto_approve", "environment_variables", "setup_instructions"},
	"skills":    {"skill_path", "git_url", "git_ref", "skill_md_content", "target_agents", "task_type", "slash_command"},
	"hooks":     {"event", "execution_mode", "priority", "handler_type", "handler_config", "scope", "tool_filter", "source_url", "source_ref", "source_path", "resolved_sha", "script_content", "script_filename", "requirements"},
	"prompts":   {"category", "template", "variables", "model_hints", "tags"},
	"sandboxes": {"runtime_type", "image", "resource_limits", "network_policy", "entrypoint", "runtime_config", "source_url", "source_ref", "resolved_sha", "sandbox_path"},
}

func versionColumns(f Family) string {
	cols := []string{
		"v.id::text AS id", "v.listing_id::text AS listing_id", "v.version", "v.description",
		"v.changelog", "v.status", "v.rejection_reason", "v.download_count",
		"v.supported_harnesses", "v.released_by::text AS released_by", "v.released_at", "v.created_at",
	}
	for _, extra := range versionExtras[f.Prefix] {
		cols = append(cols, "v."+extra)
	}
	return strings.Join(cols, ", ")
}

// wireTimePlus renders dict-path datetimes: RFC 3339 with a +00:00 offset,
// microseconds only when nonzero.
func wireTimePlus(v any) any {
	t, ok := v.(time.Time)
	if !ok {
		return nil
	}
	t = t.UTC()
	if t.Nanosecond() == 0 {
		return t.Format("2006-01-02T15:04:05+00:00")
	}
	return t.Format("2006-01-02T15:04:05.000000+00:00")
}

// versionBase is the managed slice of a version row, in contract order.
type versionBase struct {
	ID                 string  `json:"id"`
	ListingID          string  `json:"listing_id"`
	Version            string  `json:"version"`
	Description        string  `json:"description"`
	Changelog          *string `json:"changelog"`
	Status             string  `json:"status"`
	RejectionReason    *string `json:"rejection_reason"`
	DownloadCount      int     `json:"download_count"`
	SupportedHarnesses []any   `json:"supported_harnesses"`
	ReleasedBy         string  `json:"released_by"`
	ReleasedAt         any     `json:"released_at"`
	CreatedAt          any     `json:"created_at"`
}

// versionWire renders one version row: the ordered base followed by the
// family payload columns in stable alphabetical order.
func versionWire(f Family, row map[string]any) (json.RawMessage, error) {
	base, err := json.Marshal(versionBase{
		ID:                 rowStr(row, "id", ""),
		ListingID:          rowStr(row, "listing_id", ""),
		Version:            rowStr(row, "version", ""),
		Description:        rowStr(row, "description", ""),
		Changelog:          rowNStr(row, "changelog"),
		Status:             rowStr(row, "status", ""),
		RejectionReason:    rowNStr(row, "rejection_reason"),
		DownloadCount:      rowInt(row, "download_count", 0),
		SupportedHarnesses: rowList(row, "supported_harnesses"),
		ReleasedBy:         rowStr(row, "released_by", ""),
		ReleasedAt:         wireTimePlus(row["released_at"]),
		CreatedAt:          wireTimePlus(row["created_at"]),
	})
	if err != nil {
		return nil, err
	}
	extras := versionExtras[f.Prefix]
	sorted := append([]string{}, extras...)
	sort.Strings(sorted)
	var buf bytes.Buffer
	buf.Write(base[:len(base)-1])
	for _, key := range sorted {
		blob, err := json.Marshal(row[key])
		if err != nil {
			return nil, err
		}
		buf.WriteString(`,"` + key + `":`)
		buf.Write(blob)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// resolveVisible resolves without a status filter and 404s hidden listings.
func (s *Store) resolveVisible(ctx context.Context, f Family, identifier string, viewer *Viewer) (map[string]any, error) {
	row, err := s.Resolve(ctx, f, identifier, viewer, false)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, notFoundErr()
	}
	return row, nil
}

// versionPage is the paginated version-history envelope.
type versionPage struct {
	Items    []json.RawMessage `json:"items"`
	Total    int               `json:"total"`
	Page     int               `json:"page"`
	PageSize int               `json:"page_size"`
}

// ListVersions returns a listing's version history; unapproved versions are
// reserved for owners and reviewers even when the listing itself is visible.
func (s *Store) ListVersions(ctx context.Context, f Family, identifier string, viewer *Viewer, page, pageSize int) (*versionPage, error) {
	listing, err := s.resolveVisible(ctx, f, identifier, viewer)
	if err != nil {
		return nil, err
	}
	args := []any{rowStr(listing, "id", "")}
	where := "v.listing_id = $1"
	if !mayViewUnapproved(rowPermission(listing, viewer), viewer) {
		where += " AND v.status = 'approved'"
	}
	var total int
	if err := s.DB.QueryRow(ctx,
		fmt.Sprintf("SELECT count(v.id) FROM %s v WHERE %s", f.VersionTable, where), args...).Scan(&total); err != nil {
		return nil, err
	}
	args = append(args, pageSize, (page-1)*pageSize)
	rows, err := s.DB.Query(ctx, fmt.Sprintf(
		"SELECT %s FROM %s v WHERE %s ORDER BY v.released_at DESC LIMIT $2 OFFSET $3",
		versionColumns(f), f.VersionTable, where), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []json.RawMessage{}
	for _, row := range collectRows(rows) {
		blob, err := versionWire(f, row)
		if err != nil {
			return nil, err
		}
		items = append(items, blob)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return &versionPage{Items: items, Total: total, Page: page, PageSize: pageSize}, nil
}

// GetVersion returns one version by exact version string.
func (s *Store) GetVersion(ctx context.Context, f Family, identifier, version string, viewer *Viewer) (json.RawMessage, error) {
	listing, err := s.resolveVisible(ctx, f, identifier, viewer)
	if err != nil {
		return nil, err
	}
	args := []any{rowStr(listing, "id", ""), version}
	where := "v.listing_id = $1 AND v.version = $2"
	if !mayViewUnapproved(rowPermission(listing, viewer), viewer) {
		where += " AND v.status = 'approved'"
	}
	rows, err := s.DB.Query(ctx, fmt.Sprintf(
		"SELECT %s FROM %s v WHERE %s", versionColumns(f), f.VersionTable, where), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	matches := collectRows(rows)
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(matches) == 0 {
		return nil, &apiError{Status: 404, Detail: "Version not found"}
	}
	return versionWire(f, matches[0])
}

// semverRE is strict release-only semver: prerelease tags never win the
// highest-version scan or receive bump suggestions.
var semverRE = regexp.MustCompile(`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$`)

func parseSemver(version string) (major, minor, patch int, ok bool) {
	m := semverRE.FindStringSubmatch(version)
	if m == nil {
		return 0, 0, 0, false
	}
	var err1, err2, err3 error
	major, err1 = strconv.Atoi(m[1])
	minor, err2 = strconv.Atoi(m[2])
	patch, err3 = strconv.Atoi(m[3])
	if err1 != nil || err2 != nil || err3 != nil {
		// Digit runs beyond int range are not comparable versions.
		return 0, 0, 0, false
	}
	return major, minor, patch, true
}

func semverLess(a, b string) bool {
	am, an, ap, aok := parseSemver(a)
	bm, bn, bp, bok := parseSemver(b)
	if !aok || !bok {
		return !aok && bok
	}
	if am != bm {
		return am < bm
	}
	if an != bn {
		return an < bn
	}
	return ap < bp
}

func bumpVersion(current, kind string) string {
	major, minor, patch, ok := parseSemver(current)
	if !ok {
		return "1.0.0"
	}
	switch kind {
	case "major":
		return fmt.Sprintf("%d.0.0", major+1)
	case "minor":
		return fmt.Sprintf("%d.%d.0", major, minor+1)
	default:
		return fmt.Sprintf("%d.%d.%d", major, minor, patch+1)
	}
}

// versionSuggestions is the next-release helper payload.
type versionSuggestions struct {
	Current     string `json:"current"`
	Suggestions struct {
		Patch string `json:"patch"`
		Minor string `json:"minor"`
		Major string `json:"major"`
	} `json:"suggestions"`
}

// SuggestVersions proposes the next releases from the highest version on
// record, pending releases included, so suggestions never collide.
func (s *Store) SuggestVersions(ctx context.Context, f Family, identifier string, viewer *Viewer) (*versionSuggestions, error) {
	listing, err := s.resolveVisible(ctx, f, identifier, viewer)
	if err != nil {
		return nil, err
	}
	rows, err := s.DB.Query(ctx, fmt.Sprintf(
		"SELECT v.version FROM %s v WHERE v.listing_id = $1 ORDER BY v.released_at DESC",
		f.VersionTable), rowStr(listing, "id", ""))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	highest := rowStr(listing, "version", "0.0.0")
	if rowStr(listing, "latest_version_id", "") == "" {
		highest = "0.0.0"
	}
	for rows.Next() {
		var v string
		if rows.Scan(&v) == nil && semverLess(highest, v) {
			highest = v
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := &versionSuggestions{Current: highest}
	out.Suggestions.Patch = bumpVersion(highest, "patch")
	out.Suggestions.Minor = bumpVersion(highest, "minor")
	out.Suggestions.Major = bumpVersion(highest, "major")
	return out, nil
}

// renderResult is the substituted prompt payload.
type renderResult struct {
	ListingID string `json:"listing_id"`
	Rendered  string `json:"rendered"`
}

// RenderPrompt substitutes {{variable}} placeholders in an installable
// prompt template; archived prompts render for everyone, unapproved ones
// only for their owners.
func (s *Store) RenderPrompt(ctx context.Context, identifier string, variables map[string]string, viewer *Viewer) (*renderResult, error) {
	f := Families["prompts"]
	row, err := s.Resolve(ctx, f, identifier, viewer, true)
	if err != nil {
		return nil, err
	}
	if row == nil {
		row, err = s.Resolve(ctx, f, identifier, viewer, false)
		if err != nil {
			return nil, err
		}
		if row == nil || (rowStr(row, "status", "draft") != "archived" && rowPermission(row, viewer) != "owner") {
			return nil, &apiError{Status: 404, Detail: "Listing not found or not approved"}
		}
	}
	rendered := rowStr(row, "template", "")
	for key, value := range variables {
		pattern := regexp.MustCompile(`\{\{\s*` + regexp.QuoteMeta(key) + `\s*\}\}`)
		rendered = pattern.ReplaceAllLiteralString(rendered, value)
	}
	return &renderResult{ListingID: rowStr(row, "id", ""), Rendered: rendered}, nil
}
