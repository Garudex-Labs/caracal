// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// updateSpec accumulates SET clauses for one row update.
type updateSpec struct {
	sets []string
	vals []any
}

func (u *updateSpec) set(col string, v any) {
	cast := ""
	if jsonColumns[col] {
		var err error
		if v, err = jsonParam(v); err != nil {
			return
		}
		cast = "::json"
	}
	u.vals = append(u.vals, v)
	u.sets = append(u.sets, fmt.Sprintf("%s = $%d%s", col, len(u.vals), cast))
}

// present reports a key that arrived with a non-null value: the update
// contract skips both absent and explicitly null fields.
func (b *draftBody) present(key string) bool {
	v, ok := b.raw[key]
	return ok && v != nil
}

// updateVersionFields collects the family's editable version columns from
// the present request fields.
func updateVersionFields(f Family, b *draftBody, validHarnesses []string, u *updateSpec) {
	setStr := func(key string, col string) {
		if b.present(key) {
			u.set(col, b.str(key, ""))
		}
	}
	setList := func(key string) {
		if b.present(key) {
			u.set(key, b.strList(key, nil))
		}
	}
	setDict := func(key string) {
		if b.present(key) {
			u.set(key, b.dict(key, nil))
		}
	}
	setStr("version", "version")
	setStr("description", "description")
	if b.present("supported_harnesses") {
		u.set("supported_harnesses", b.harnessList(validHarnesses))
	}
	switch f.Prefix {
	case "mcps":
		setStr("framework", "framework")
		setStr("docker_image", "docker_image")
		setStr("command", "command")
		setList("args")
		setStr("url", "url")
		setList("auto_approve")
		setStr("transport", "transport")
		setStr("setup_instructions", "setup_instructions")
		setStr("changelog", "changelog")
		setStr("git_url", "source_url")
		if b.present("headers") {
			u.set("headers", b.namedEntryList("headers", true))
		}
		if b.present("environment_variables") {
			u.set("environment_variables", b.namedEntryList("environment_variables", false))
		}
	case "skills":
		setStr("skill_path", "skill_path")
		setStr("git_url", "git_url")
		setStr("git_ref", "git_ref")
		setStr("skill_md_content", "skill_md_content")
		setStr("delivery_mode", "delivery_mode")
		setStr("script_content", "script_content")
		setStr("script_filename", "script_filename")
		setList("target_agents")
		setStr("task_type", "task_type")
	case "hooks":
		setStr("event", "event")
		setStr("execution_mode", "execution_mode")
		if b.present("priority") {
			u.set("priority", b.intVal("priority", 100))
		}
		setStr("handler_type", "handler_type")
		setDict("handler_config")
		setStr("scope", "scope")
		setList("tool_filter")
		setStr("script_content", "script_content")
		setStr("script_filename", "script_filename")
		setStr("source_url", "source_url")
		setStr("source_ref", "source_ref")
		setStr("source_path", "source_path")
		setList("requirements")
	case "prompts":
		if b.present("category") {
			u.set("category", b.promptCategory())
		}
		setStr("template", "template")
		if b.present("variables") {
			u.set("variables", b.raw["variables"])
		}
		setList("tags")
	}
}

// skillSlashUpdate replays the analyzer dance: an explicit null clears the
// command, new content re-validates, and a bare slash_command re-validates
// against the stored content.
func (s *Store) skillSlashUpdate(b *draftBody, storedContent string, u *updateSpec) *apiError {
	_, keyPresent := b.raw["slash_command"]
	shouldUpdate := keyPresent
	explicitClear := keyPresent && b.raw["slash_command"] == nil
	requested := ""
	if keyPresent && !explicitClear {
		var ok bool
		if requested, ok = b.slashCommand(); !ok {
			return nil
		}
	}

	var final string
	switch {
	case b.present("skill_md_content"):
		analyzed, err := analyzeSkillMD(b.str("skill_md_content", ""), requested)
		if err != nil {
			return err
		}
		final = requested
		if analyzed != "" && !explicitClear {
			final = analyzed
			shouldUpdate = true
		}
	case keyPresent:
		analyzed, err := analyzeSkillMD(storedContent, requested)
		if err != nil {
			return err
		}
		final = requested
		if !explicitClear {
			final = analyzed
		}
	default:
		return nil
	}
	if shouldUpdate {
		if final == "" {
			u.set("slash_command", nil)
		} else {
			u.set("slash_command", final)
		}
	}
	return nil
}

// UpdateDraft edits an unreleased listing in place: version payload fields,
// the forced lock release, and the listing's display fields.
func (s *Store) UpdateDraft(ctx context.Context, f Family, identifier string, viewer *Viewer, b *draftBody, validHarnesses []string) (map[string]any, error) {
	row, err := s.Resolve(ctx, f, identifier, viewer, false)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, notFoundErr()
	}
	if rowPermission(row, viewer) != "owner" {
		return nil, &apiError{Status: 403, Detail: "Not the listing owner"}
	}
	switch rowStr(row, "status", "draft") {
	case "draft", "rejected", "pending":
	default:
		return nil, &apiError{Status: 400, Detail: "Only draft, rejected, or pending listings can be edited"}
	}
	if b.present("visibility") {
		if b.visibility() != rowVisibility(row) {
			return nil, &apiError{Status: 400, Detail: fmt.Sprintf(
				"visibility cannot be changed here. Use PATCH /api/v1/registry/%s/%s/visibility.",
				f.Name, rowStr(row, "id", ""))}
		}
	}
	versionID := rowStr(row, "latest_version_id", "")
	if versionID == "" {
		return nil, &apiError{Status: 400, Detail: "Listing has no version to update"}
	}

	version := &updateSpec{}
	updateVersionFields(f, b, validHarnesses, version)
	if f.Prefix == "skills" {
		stored := ""
		if s := rowNStr(row, "skill_md_content"); s != nil {
			stored = *s
		}
		if err := s.skillSlashUpdate(b, stored, version); err != nil {
			return nil, err
		}
	}
	if len(b.errs) > 0 {
		return nil, &validationError{Errs: b.errs}
	}

	// Saving over another user's active lock is refused; our own or an
	// expired lock is released by the save.
	if rowBool(row, "is_editing") && rowStr(row, "editing_by", "") != viewer.ID.String() {
		if since, ok := row["editing_since"].(time.Time); ok && time.Since(since) <= 30*time.Minute {
			return nil, &apiError{Status: 409,
				Detail: "This item is currently being edited by another user. Please try again later."}
		}
	}
	version.sets = append(version.sets, "is_editing = FALSE", "editing_since = NULL", "editing_by = NULL")
	version.vals = append(version.vals, versionID)
	if _, err := s.DB.Exec(ctx, fmt.Sprintf("UPDATE %s SET %s WHERE id = $%d",
		f.VersionTable, strings.Join(version.sets, ", "), len(version.vals)), version.vals...); err != nil {
		return nil, err
	}

	listing := &updateSpec{}
	if b.present("name") {
		listing.set("name", b.str("name", ""))
	}
	if f.Prefix == "mcps" && b.present("category") {
		listing.set("category", b.str("category", ""))
	}
	if b.present("owner") {
		listing.set("owner", b.str("owner", ""))
	}
	if len(listing.sets) > 0 {
		listing.sets = append(listing.sets, "updated_at = now()")
		listing.vals = append(listing.vals, rowStr(row, "id", ""))
		if _, err := s.DB.Exec(ctx, fmt.Sprintf("UPDATE %s SET %s WHERE id = $%d",
			f.ListingTable, strings.Join(listing.sets, ", "), len(listing.vals)), listing.vals...); err != nil {
			if isUniqueViolation(err) {
				return nil, &apiError{Status: 409, Detail: fmt.Sprintf(
					"A %s with this namespace and slug already exists", draftLabels[f.Prefix].conflict)}
			}
			return nil, err
		}
	}

	fresh, err := s.Resolve(ctx, f, rowStr(row, "id", ""), viewer, false)
	if err != nil || fresh == nil {
		return nil, fmt.Errorf("draft readback: %w", err)
	}
	return fresh, nil
}
