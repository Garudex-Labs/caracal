// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/garudex-labs/caracal/internal/harnessgen"
	"github.com/garudex-labs/caracal/internal/registry"
)

// errInstallStatus carries a non-404/500 install failure.
type errInstall struct {
	status int
	detail string
}

func (e *errInstall) Error() string { return e.detail }

// familyInstallColumns lists what the generator needs per family, all
// latest-version delegates unless a pinned version overlays them.
func familyInstallColumns(name string) string {
	base := `l.id::text AS id, l.name, l.slug, l.namespace, v.status, v.description`
	switch name {
	case "mcp":
		return base + `, v.transport, v.url, v.command, v.args, v.framework, v.docker_image,
			v.environment_variables, v.auto_approve, v.setup_instructions, v.headers`
	case "skill":
		return base + `, v.slash_command, v.task_type, v.git_url, v.git_ref, v.skill_path,
			v.skill_md_content, v.script_content, v.script_filename`
	case "hook":
		return base + `, v.event, v.handler_type, v.handler_config, v.script_filename, v.script_content`
	case "prompt":
		return base + `, v.template`
	default:
		return base
	}
}

// installListings loads one family's listings for the install, enforcing
// caller visibility and the agent audience's publish scope.
func (s *Store) installListings(ctx context.Context, familyName string, ids []string, viewer *registry.Viewer, targetProjectID string, pins map[string]string) (map[string]harnessgen.Listing, error) {
	if len(ids) == 0 {
		return map[string]harnessgen.Listing{}, nil
	}
	f := registry.Families[familyName+"s"]
	args := []any{}
	visibility := registry.ScopeSQL("l", "l.submitted_by", viewer, &args)
	scope := "l.is_private = FALSE"
	if targetProjectID != "" {
		args = append(args, targetProjectID)
		scope = fmt.Sprintf("(l.is_private = FALSE OR (l.is_private = TRUE AND l.project_id = $%d))", len(args))
	}
	args = append(args, ids)
	sql := fmt.Sprintf(`SELECT %s FROM %s l LEFT JOIN %s v ON l.latest_version_id = v.id
		WHERE %s AND %s AND l.id = ANY($%d)`,
		familyInstallColumns(familyName), f.ListingTable, f.VersionTable, visibility, scope, len(args))
	rows, err := s.DB.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	collected := registry.CollectRows(rows)
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := map[string]harnessgen.Listing{}
	for _, row := range collected {
		out[rowStr(row, "id", "")] = harnessgen.Listing(row)
	}
	// Reproducibility: an agent version pins each dependency to the version it was
	// released against (agent_components.resolved_version). Overlay that exact
	// version so a historical agent version never silently materializes a
	// component's newer latest release. A pin that no longer exists degrades to
	// the already-loaded latest listing.
	for id := range out {
		pin := pins[id]
		if pin == "" || strings.EqualFold(pin, "latest") {
			continue
		}
		pinned, err := s.pinnedListing(ctx, familyName, id, pin, viewer, targetProjectID)
		if err != nil {
			return nil, err
		}
		if pinned != nil {
			out[id] = pinned
		}
	}
	return out, nil
}

// pinnedListing loads one listing at an exact component version, reusing the
// install column set and caller-visibility gate and changing only the version
// join. It returns nil when the pinned version is absent so the caller keeps the
// latest listing rather than failing the whole install.
func (s *Store) pinnedListing(ctx context.Context, familyName, id, version string, viewer *registry.Viewer, targetProjectID string) (harnessgen.Listing, error) {
	f := registry.Families[familyName+"s"]
	args := []any{}
	visibility := registry.ScopeSQL("l", "l.submitted_by", viewer, &args)
	scope := "l.is_private = FALSE"
	if targetProjectID != "" {
		args = append(args, targetProjectID)
		scope = fmt.Sprintf("(l.is_private = FALSE OR (l.is_private = TRUE AND l.project_id = $%d))", len(args))
	}
	args = append(args, id)
	idPos := len(args)
	args = append(args, version)
	verPos := len(args)
	sql := fmt.Sprintf(`SELECT %s FROM %s l JOIN %s v ON v.listing_id = l.id AND v.version = $%d
		WHERE %s AND %s AND l.id = $%d`,
		familyInstallColumns(familyName), f.ListingTable, f.VersionTable, verPos, visibility, scope, idPos)
	rows, err := s.DB.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	collected := registry.CollectRows(rows)
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(collected) == 0 {
		return nil, nil
	}
	return harnessgen.Listing(collected[0]), nil
}

// InstallInputs assembles everything a generation run needs for one agent
// and version: the effective version row, its components, and the loaded
// listings.
type InstallInputs struct {
	VersionRow map[string]any
	Links      []map[string]any
	Families   map[string]map[string]harnessgen.Listing
	NameMap    map[string]string
}

func (s *Store) InstallInputs(ctx context.Context, agentRow map[string]any, viewer *registry.Viewer, requestedVersion string) (*InstallInputs, error) {
	agentID := rowStr(agentRow, "id", "")
	var versionRow map[string]any
	if requestedVersion != "" {
		rows, err := s.DB.Query(ctx, `SELECT v.id::text AS id, v.version, v.description, v.prompt,
			v.model_name, v.models_by_harness, v.external_mcps, v.required_capabilities
			FROM agent_versions v WHERE v.agent_id = $1 AND v.version = $2 AND v.status = 'approved'`,
			agentID, requestedVersion)
		if err != nil {
			return nil, err
		}
		collected := registry.CollectRows(rows)
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		if len(collected) == 0 {
			return nil, &errInstall{404, fmt.Sprintf("Version '%s' not found or not approved for this agent", requestedVersion)}
		}
		versionRow = collected[0]
	} else {
		latestID := rowStr(agentRow, "latest_version_id", "")
		if latestID == "" {
			return nil, &errInstall{400, "Agent has no published version available for install"}
		}
		rows, err := s.DB.Query(ctx, `SELECT v.id::text AS id, v.version, v.description, v.prompt,
			v.model_name, v.models_by_harness, v.external_mcps, v.required_capabilities
			FROM agent_versions v WHERE v.id = $1`, latestID)
		if err != nil {
			return nil, err
		}
		collected := registry.CollectRows(rows)
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		if len(collected) == 0 {
			return nil, &errInstall{400, "Agent has no published version available for install"}
		}
		versionRow = collected[0]
	}

	links, err := s.Components(ctx, rowStr(versionRow, "id", ""))
	if err != nil {
		return nil, err
	}
	targetProjectID := ""
	if rowBool(agentRow, "is_private") {
		if projectID := rowNStr(agentRow, "project_id"); projectID != nil {
			targetProjectID = *projectID
		}
	}
	byType := map[string][]string{}
	for _, link := range links {
		t := rowStr(link, "component_type", "")
		byType[t] = append(byType[t], rowStr(link, "component_id", ""))
	}
	// resolved_version pins each dependency to the version this agent version was
	// released against, so the install reproduces that exact graph.
	pins := map[string]string{}
	for _, link := range links {
		if v := rowStr(link, "resolved_version", ""); v != "" {
			pins[rowStr(link, "component_id", "")] = v
		}
	}
	families := map[string]map[string]harnessgen.Listing{}
	for _, name := range []string{"mcp", "skill", "hook", "prompt"} {
		listings, err := s.installListings(ctx, name, byType[name], viewer, targetProjectID, pins)
		if err != nil {
			return nil, err
		}
		if len(listings) != len(byType[name]) {
			return nil, &errInstall{404, "Agent contains a component unavailable to this agent target"}
		}
		families[name] = listings
	}

	nameMap := map[string]string{}
	for _, listings := range families {
		for id, listing := range listings {
			if n, ok := listing["name"].(string); ok {
				nameMap[id] = n
			}
		}
	}
	return &InstallInputs{VersionRow: versionRow, Links: links, Families: families, NameMap: nameMap}, nil
}

// RecordDownload inserts a deduplicated download row; a first-time download
// refreshes the latest version's aggregate count.
func (s *Store) RecordDownload(ctx context.Context, agentID string, viewer *registry.Viewer, harnessName string) error {
	tag, err := s.Exec(ctx, `INSERT INTO agent_download_records (id, agent_id, user_id, source, harness, installed_at)
		VALUES (gen_random_uuid(), $1, $2, 'api', $3, now())
		ON CONFLICT (agent_id, user_id) DO NOTHING`, agentID, viewer.ID, harnessName)
	if err != nil {
		return err
	}
	if tag == 0 {
		return nil
	}
	_, err = s.Exec(ctx, `UPDATE agent_versions SET download_count =
		(SELECT count(*) FROM agent_download_records WHERE agent_id = $1)
		WHERE id = (SELECT latest_version_id FROM agents WHERE id = $1)`, agentID)
	return err
}

// execer is the write-capable side of a pgx pool.
type execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Exec runs a statement returning the affected-row count.
func (s *Store) Exec(ctx context.Context, sql string, args ...any) (int64, error) {
	db, ok := s.DB.(execer)
	if !ok {
		return 0, fmt.Errorf("store connection is read-only")
	}
	tag, err := db.Exec(ctx, sql, args...)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
