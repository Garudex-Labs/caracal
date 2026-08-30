// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package inbox serves the per-user inbox. Every route is scoped to the
// caller; there is no admin view of another user's inbox. Row visibility is
// re-checked against the CURRENT subject at read time, in SQL, so counts,
// pages, and rows always describe one set.
package inbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/garudex-labs/caracal/internal/tenancy"
)

// PGQuerier is the pgx pool surface the store needs.
type PGQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Store answers inbox reads and state changes.
type Store struct {
	DB PGQuerier
}

// States are the lifecycle states, mirrored from the storage enums.
var States = map[string]bool{"open": true, "done": true, "dismissed": true}

var Kinds = []string{
	"review_requested", "review_approved", "review_rejected", "review_comment",
	"change_requested", "ownership_transfer", "update_available",
	"insight_ready", "system_notice",
}

// noRecheckKinds opt out of the subject re-check: a decision addressed to its
// own submitter is theirs to know regardless of where the listing ended up.
var noRecheckKinds = []string{
	"review_approved", "review_rejected", "change_requested",
	"update_available", "insight_ready", "system_notice",
}

var subjectTables = [][2]string{
	{"agent", "agents"}, {"mcp", "mcp_listings"}, {"skill", "skill_listings"},
	{"hook", "hook_listings"}, {"prompt", "prompt_listings"}, {"sandbox", "sandbox_listings"},
}

// visibleSQL is the set-level twin of the row check: aggregates computed over
// unfiltered rows would still disclose that hidden items exist.
func visibleSQL(role string, args *[]any, userArg string) string {
	if tenancy.IsOperator(role) {
		return "TRUE"
	}
	quoted := make([]string, len(noRecheckKinds))
	types := make([]string, len(subjectTables))
	arms := []string{}
	for i, k := range noRecheckKinds {
		quoted[i] = "'" + k + "'"
	}
	arms = append(arms, "i.kind IN ("+strings.Join(quoted, ", ")+")")
	for i, t := range subjectTables {
		types[i] = "'" + t[0] + "'"
		arms = append(arms, fmt.Sprintf(
			`(i.subject_type = '%s' AND EXISTS (
			   SELECT 1 FROM %s m WHERE m.id = i.subject_id AND (
			     m.is_private = FALSE OR m.project_id IS NULL OR EXISTS (
			       SELECT 1 FROM project_memberships pm WHERE pm.project_id = m.project_id AND pm.user_id = %s))))`,
			t[0], t[1], userArg))
	}
	// Subjects with no listing table keep the write-time snapshot.
	arms = append(arms, fmt.Sprintf(
		`(i.subject_type NOT IN (%s) AND (
		   i.is_private_subject = FALSE OR i.project_id IS NULL OR EXISTS (
		     SELECT 1 FROM project_memberships pm WHERE pm.project_id = i.project_id AND pm.user_id = %s)))`,
		strings.Join(types, ", "), userArg))
	return "(" + strings.Join(arms, " OR ") + ")"
}

// Filters are the shared list/read-all query filters.
type Filters struct {
	State          string
	Kind           string
	ActionRequired *bool
	Unread         *bool
	SubjectType    string
	Q              string
}

func escapeLike(v string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(v)
}

func applyFilters(f Filters, where *[]string, args *[]any) {
	bind := func(v any) string {
		*args = append(*args, v)
		return fmt.Sprintf("$%d", len(*args))
	}
	if f.State != "" {
		*where = append(*where, "i.state = "+bind(f.State))
	}
	if f.Kind != "" {
		*where = append(*where, "i.kind = "+bind(f.Kind))
	}
	if f.ActionRequired != nil {
		*where = append(*where, "i.action_required = "+bind(*f.ActionRequired))
	}
	if f.Unread != nil {
		if *f.Unread {
			*where = append(*where, "i.read_at IS NULL")
		} else {
			*where = append(*where, "i.read_at IS NOT NULL")
		}
	}
	if f.SubjectType != "" {
		*where = append(*where, "i.subject_type = "+bind(f.SubjectType))
	}
	if f.Q != "" {
		needle := bind("%" + escapeLike(strings.TrimSpace(f.Q)) + "%")
		*where = append(*where,
			fmt.Sprintf(`(i.title ILIKE %s ESCAPE '\' OR i.body ILIKE %s ESCAPE '\'
			 OR i.subject_namespace ILIKE %s ESCAPE '\' OR i.subject_slug ILIKE %s ESCAPE '\')`,
				needle, needle, needle, needle))
	}
}

func applyProjectScope(ctx context.Context, where *[]string, args *[]any) {
	projectID, ok := tenancy.ProjectIDFromContext(ctx)
	if !ok {
		*where = append(*where, "FALSE")
		return
	}
	*args = append(*args, projectID)
	*where = append(*where, fmt.Sprintf("i.project_id = $%d", len(*args)))
}

const itemColumns = `i.id::text, i.kind, i.state, i.read_at, i.action_required, i.title, i.body,
	i.subject_type, i.subject_id::text, i.subject_namespace, i.subject_slug,
	i.action_url, i.action_command, i.actor_id::text, i.project_id::text,
	i.payload, i.created_at, i.resolved_at`

// Item is one scanned inbox row.
type Item struct {
	ID               string
	Kind             string
	State            string
	ReadAt           *time.Time
	ActionRequired   bool
	Title            string
	Body             *string
	SubjectType      string
	SubjectID        *string
	SubjectNamespace *string
	SubjectSlug      *string
	ActionURL        *string
	ActionCommand    *string
	ActorID          *string
	ProjectID        *string
	Payload          map[string]any
	CreatedAt        time.Time
	ResolvedAt       *time.Time
}

func scanItem(row pgx.Row) (*Item, error) {
	var it Item
	err := row.Scan(&it.ID, &it.Kind, &it.State, &it.ReadAt, &it.ActionRequired, &it.Title, &it.Body,
		&it.SubjectType, &it.SubjectID, &it.SubjectNamespace, &it.SubjectSlug,
		&it.ActionURL, &it.ActionCommand, &it.ActorID, &it.ProjectID,
		&it.Payload, &it.CreatedAt, &it.ResolvedAt)
	if err != nil {
		return nil, err
	}
	if it.Payload == nil {
		it.Payload = map[string]any{}
	}
	return &it, nil
}

// List returns one page plus the total over the same filtered set.
func (s *Store) List(ctx context.Context, userID uuid.UUID, role string, f Filters, sort string, page, pageSize int) ([]*Item, int, error) {
	args := []any{userID}
	where := []string{"i.user_id = $1", visibleSQL(role, &args, "$1")}
	applyProjectScope(ctx, &where, &args)
	applyFilters(f, &where, &args)
	from := "FROM inbox_items i WHERE " + strings.Join(where, " AND ")

	var total int
	if err := s.DB.QueryRow(ctx, "SELECT count(*) "+from, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	// id breaks ties in the same direction: one fan-out shares created_at to
	// the microsecond, and an unstable tiebreak repeats rows across pages.
	order := "i.created_at DESC, i.id DESC"
	if sort == "oldest" {
		order = "i.created_at ASC, i.id ASC"
	}
	args = append(args, pageSize, (page-1)*pageSize)
	rows, err := s.DB.Query(ctx, fmt.Sprintf("SELECT %s %s ORDER BY %s LIMIT $%d OFFSET $%d",
		itemColumns, from, order, len(args)-1, len(args)), args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := []*Item{}
	for rows.Next() {
		it, err := scanItem(rows)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, it)
	}
	return items, total, rows.Err()
}

// Counts carries the badge numbers and optional facets.
type Counts struct {
	Unread        int
	Action        int
	ByState       map[string]int
	ByKind        map[string]int
	BySubjectType map[string]int
}

// Count computes the badge numbers; facets are opt-in and scoped to one state.
func (s *Store) Count(ctx context.Context, userID uuid.UUID, role string, facets bool, facetState string) (*Counts, error) {
	args := []any{userID}
	where := []string{"i.user_id = $1", visibleSQL(role, &args, "$1")}
	applyProjectScope(ctx, &where, &args)
	mine := strings.Join(where, " AND ")
	out := &Counts{ByState: map[string]int{}, ByKind: map[string]int{}, BySubjectType: map[string]int{}}
	if err := s.DB.QueryRow(ctx,
		"SELECT count(*) FROM inbox_items i WHERE "+mine+" AND i.read_at IS NULL", args...).Scan(&out.Unread); err != nil {
		return nil, err
	}
	if err := s.DB.QueryRow(ctx,
		"SELECT count(*) FROM inbox_items i WHERE "+mine+" AND i.action_required = TRUE AND i.state = 'open'",
		args...).Scan(&out.Action); err != nil {
		return nil, err
	}
	group := func(column, extra string, into map[string]int) error {
		rows, err := s.DB.Query(ctx,
			"SELECT "+column+", count(*) FROM inbox_items i WHERE "+mine+extra+" GROUP BY "+column, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var key *string
			var n int
			if err := rows.Scan(&key, &n); err != nil {
				return err
			}
			if key != nil {
				into[*key] = n
			}
		}
		return rows.Err()
	}
	if err := group("i.state", "", out.ByState); err != nil {
		return nil, err
	}
	if !facets {
		return out, nil
	}
	extra := ""
	if facetState != "" {
		args = append(args, facetState)
		extra = fmt.Sprintf(" AND i.state = $%d", len(args))
	}
	if err := group("i.kind", extra, out.ByKind); err != nil {
		return nil, err
	}
	if err := group("i.subject_type", extra, out.BySubjectType); err != nil {
		return nil, err
	}
	return out, nil
}

// ErrNotFound answers 404 without confirming another user's item exists.
var ErrNotFound = errors.New("inbox item not found")

// LoadOwn fetches one item the caller owns and may still see.
func (s *Store) LoadOwn(ctx context.Context, itemID, userID uuid.UUID, role string) (*Item, error) {
	args := []any{userID, itemID}
	where := []string{"i.id = $2", "i.user_id = $1", visibleSQL(role, &args, "$1")}
	applyProjectScope(ctx, &where, &args)
	it, err := scanItem(s.DB.QueryRow(ctx,
		"SELECT "+itemColumns+" FROM inbox_items i WHERE "+strings.Join(where, " AND "), args...))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return it, err
}

// Event is one history row.
type Event struct {
	ID        string
	Event     string
	ActorID   *string
	Detail    *string
	CreatedAt time.Time
}

// History lists an item's audit trail oldest-first.
func (s *Store) History(ctx context.Context, itemID string) ([]Event, error) {
	rows, err := s.DB.Query(ctx,
		`SELECT id::text, event, actor_id::text, detail, created_at FROM inbox_item_events
		 WHERE item_id = $1 ORDER BY created_at ASC, id ASC`, itemID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var e Event
		if err := rows.Scan(&e.ID, &e.Event, &e.ActorID, &e.Detail, &e.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func recordEvent(ctx context.Context, tx pgx.Tx, itemID string, event string, actorID *uuid.UUID, detail *string) error {
	_, err := tx.Exec(ctx,
		`INSERT INTO inbox_item_events (id, item_id, event, actor_id, detail, created_at)
		 VALUES ($1, $2, $3, $4, $5, now())`, uuid.New(), itemID, event, actorID, detail)
	return err
}

// SetRead flips the read marker without touching lifecycle state.
func (s *Store) SetRead(ctx context.Context, item *Item, userID uuid.UUID, read bool) (*Item, error) {
	if (item.ReadAt != nil) == read {
		return item, nil
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	event := "read"
	set := "read_at = now()"
	if !read {
		event = "unread"
		set = "read_at = NULL"
	}
	if _, err := tx.Exec(ctx, "UPDATE inbox_items SET "+set+" WHERE id = $1", item.ID); err != nil {
		return nil, err
	}
	if err := recordEvent(ctx, tx, item.ID, event, &userID, nil); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.reload(ctx, item.ID)
}

// Resolve moves an item to done or dismissed, or reopens it.
func (s *Store) Resolve(ctx context.Context, item *Item, userID uuid.UUID, state string) (*Item, error) {
	if item.State == state {
		return item, nil
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	event := state
	set := "state = $2, resolved_at = now()"
	if state == "open" {
		event = "reopened"
		set = "state = $2, resolved_at = NULL"
	}
	if _, err := tx.Exec(ctx, "UPDATE inbox_items SET "+set+" WHERE id = $1", item.ID, state); err != nil {
		return nil, err
	}
	if err := recordEvent(ctx, tx, item.ID, event, &userID, nil); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.reload(ctx, item.ID)
}

func (s *Store) reload(ctx context.Context, id string) (*Item, error) {
	return scanItem(s.DB.QueryRow(ctx, "SELECT "+itemColumns+" FROM inbox_items i WHERE i.id = $1", id))
}

// ReadAll marks everything matching the active filter as read; items whose
// subject the caller can no longer see are excluded in SQL.
func (s *Store) ReadAll(ctx context.Context, userID uuid.UUID, role string, f Filters) (int, error) {
	args := []any{userID}
	where := []string{"i.user_id = $1", "i.read_at IS NULL", visibleSQL(role, &args, "$1")}
	applyProjectScope(ctx, &where, &args)
	applyFilters(f, &where, &args)
	rows, err := s.DB.Query(ctx,
		"SELECT i.id::text FROM inbox_items i WHERE "+strings.Join(where, " AND "), args...)
	if err != nil {
		return 0, err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	updated := 0
	for _, id := range ids {
		tag, err := tx.Exec(ctx,
			"UPDATE inbox_items SET read_at = now() WHERE id = $1 AND read_at IS NULL", id)
		if err != nil {
			return 0, err
		}
		if tag.RowsAffected() == 0 {
			continue
		}
		if err := recordEvent(ctx, tx, id, "read", &userID, nil); err != nil {
			return 0, err
		}
		updated++
	}
	return updated, tx.Commit(ctx)
}

// ── update_available delivery (the one kind this API creates) ──

var safeTarget = regexp.MustCompile(`^[a-zA-Z0-9._/-]{1,128}$`)

var safeHarness = regexp.MustCompile(`^[a-zA-Z0-9._-]{1,50}$`)

var componentPlural = map[string]string{
	"mcp": "mcps", "skill": "skills", "hook": "hooks", "prompt": "prompts", "sandbox": "sandboxes",
}

// OutdatedEntry is one CLI-reported finding.
type OutdatedEntry struct {
	Type           string
	ComponentID    uuid.UUID
	Name           string
	Namespace      *string
	Slug           *string
	CurrentVersion string
	LatestVersion  string
	Harness        *string
}

func (e OutdatedEntry) label() string {
	if e.Name != "" {
		return e.Name
	}
	if e.Slug != nil && *e.Slug != "" {
		return *e.Slug
	}
	return e.ComponentID.String()
}

var namespaceRe = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,30}[a-z0-9]$`)

var slugRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

func (e OutdatedEntry) registryURL() *string {
	ns, slug := "", ""
	if e.Namespace != nil {
		ns = strings.TrimSpace(*e.Namespace)
	}
	if e.Slug != nil {
		slug = strings.TrimSpace(*e.Slug)
	}
	canonical := ns == strings.ToLower(ns) && slug == strings.ToLower(slug) &&
		namespaceRe.MatchString(ns) && !strings.Contains(ns, "..") && slugRe.MatchString(slug)
	var url string
	switch {
	case e.Type == "agent" && canonical:
		url = fmt.Sprintf("/agents/%s/%s", ns, slug)
	case e.Type == "agent":
		url = "/agents/" + e.ComponentID.String()
	default:
		plural, ok := componentPlural[e.Type]
		if !ok {
			return nil
		}
		if canonical {
			url = fmt.Sprintf("/components/%s/%s/%s", plural, ns, slug)
		} else {
			url = fmt.Sprintf("/components/%s?type=%s", e.ComponentID, plural)
		}
	}
	if len(url) > 500 {
		url = url[:500]
	}
	return &url
}

func (e OutdatedEntry) upgradeCommand() *string {
	target := ""
	if e.Namespace != nil && *e.Namespace != "" && e.Slug != nil && *e.Slug != "" {
		target = *e.Namespace + "/" + *e.Slug
	} else {
		target = e.ComponentID.String()
	}
	if !safeTarget.MatchString(target) {
		return nil
	}
	var prefix, promptFlag string
	switch e.Type {
	case "agent":
		prefix, promptFlag = "caracal agent pull", " --no-prompt"
	case "mcp":
		prefix, promptFlag = "caracal registry mcp install", " --no-prompt"
	case "skill", "hook":
		prefix, promptFlag = "caracal registry "+e.Type+" install", ""
	default:
		return nil
	}
	if e.Harness == nil || !safeHarness.MatchString(*e.Harness) {
		return nil
	}
	cmd := fmt.Sprintf("%s %s --harness %s%s", prefix, target, *e.Harness, promptFlag)
	if len(cmd) > 500 {
		cmd = cmd[:500]
	}
	return &cmd
}

// orderedPayload keeps the report context keys in delivery order.
type orderedPayload struct {
	CurrentVersion string  `json:"current_version"`
	LatestVersion  string  `json:"latest_version"`
	Harness        *string `json:"harness"`
}

// ReportOutdated records CLI-computed findings: one notice per component,
// keyed on the new version, superseding older open notices.
func (s *Store) ReportOutdated(ctx context.Context, userID uuid.UUID, entries []OutdatedEntry) (created, superseded int, err error) {
	seen := map[uuid.UUID]bool{}
	for _, entry := range entries {
		if seen[entry.ComponentID] {
			continue
		}
		seen[entry.ComponentID] = true
		title := fmt.Sprintf("Update available: %s %s → %s", entry.label(), entry.CurrentVersion, entry.LatestVersion)
		if len(title) > 255 {
			title = title[:255]
		}
		dedupe := fmt.Sprintf("update_available:%s:%s:%s", entry.Type, entry.ComponentID, entry.LatestVersion)
		if len(dedupe) > 255 {
			dedupe = dedupe[:255]
		}
		payload, _ := json.Marshal(orderedPayload{entry.CurrentVersion, entry.LatestVersion, entry.Harness})

		tx, err := s.DB.Begin(ctx)
		if err != nil {
			return created, superseded, err
		}
		newID := uuid.New()
		var insertedID *string
		err = tx.QueryRow(ctx,
			`INSERT INTO inbox_items (
			   id, user_id, kind, state, action_required, title, body,
			   subject_type, subject_id, subject_namespace, subject_slug,
			   action_url, action_command, actor_id, project_id, is_private_subject,
			   dedupe_key, payload, created_at)
			 VALUES ($1, $2, 'update_available', 'open', FALSE, $3, NULL,
			   $4, $5, $6, $7, $8, $9, NULL, NULL, FALSE, $10, $11, now())
			 ON CONFLICT (user_id, dedupe_key) DO NOTHING RETURNING id::text`,
			newID, userID, title, entry.Type, entry.ComponentID, entry.Namespace, entry.Slug,
			entry.registryURL(), entry.upgradeCommand(), dedupe, payload).Scan(&insertedID)
		if errors.Is(err, pgx.ErrNoRows) {
			// Redelivery: content stays current so a manual reopen shows
			// today's facts; a resolved notice stays resolved.
			var existingID, state string
			var readAt *time.Time
			var oldTitle string
			var oldURL, oldCmd *string
			var oldPayload []byte
			err = tx.QueryRow(ctx,
				`SELECT id::text, state, read_at, title, action_url, action_command, payload::text
				 FROM inbox_items WHERE user_id = $1 AND dedupe_key = $2`, userID, dedupe).
				Scan(&existingID, &state, &readAt, &oldTitle, &oldURL, &oldCmd, &oldPayload)
			if err != nil {
				_ = tx.Rollback(ctx)
				return created, superseded, err
			}
			changed := oldTitle != title || !strPtrEq(oldURL, entry.registryURL()) ||
				!strPtrEq(oldCmd, entry.upgradeCommand()) || !jsonEq(oldPayload, payload)
			if changed {
				if _, err := tx.Exec(ctx,
					`UPDATE inbox_items SET title = $2, action_url = $3, action_command = $4, payload = $5
					 WHERE id = $1`, existingID, title, entry.registryURL(), entry.upgradeCommand(), payload); err != nil {
					_ = tx.Rollback(ctx)
					return created, superseded, err
				}
				if state == "open" {
					detail := "Redelivered with updated details"
					if _, err := tx.Exec(ctx,
						"UPDATE inbox_items SET read_at = NULL WHERE id = $1", existingID); err != nil {
						_ = tx.Rollback(ctx)
						return created, superseded, err
					}
					if err := recordEvent(ctx, tx, existingID, "updated", nil, &detail); err != nil {
						_ = tx.Rollback(ctx)
						return created, superseded, err
					}
				}
			}
			if err := tx.Commit(ctx); err != nil {
				return created, superseded, err
			}
			continue
		}
		if err != nil {
			_ = tx.Rollback(ctx)
			return created, superseded, err
		}
		if err := recordEvent(ctx, tx, *insertedID, "created", nil, nil); err != nil {
			_ = tx.Rollback(ctx)
			return created, superseded, err
		}
		created++

		// Older open notices describe a version that is no longer the latest;
		// they close with history rather than disappearing.
		staleRows, err := tx.Query(ctx,
			`SELECT id::text FROM inbox_items
			 WHERE user_id = $1 AND kind = 'update_available' AND subject_id = $2
			   AND state = 'open' AND id != $3`, userID, entry.ComponentID, *insertedID)
		if err != nil {
			_ = tx.Rollback(ctx)
			return created, superseded, err
		}
		stale := []string{}
		for staleRows.Next() {
			var id string
			if err := staleRows.Scan(&id); err != nil {
				staleRows.Close()
				_ = tx.Rollback(ctx)
				return created, superseded, err
			}
			stale = append(stale, id)
		}
		staleRows.Close()
		for _, id := range stale {
			if _, err := tx.Exec(ctx,
				"UPDATE inbox_items SET state = 'done', resolved_at = now() WHERE id = $1", id); err != nil {
				_ = tx.Rollback(ctx)
				return created, superseded, err
			}
			detail := "Superseded by " + dedupe
			if err := recordEvent(ctx, tx, id, "superseded", nil, &detail); err != nil {
				_ = tx.Rollback(ctx)
				return created, superseded, err
			}
			superseded++
		}
		if err := tx.Commit(ctx); err != nil {
			return created, superseded, err
		}
	}
	return created, superseded, nil
}

func strPtrEq(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func jsonEq(a, b []byte) bool {
	var av, bv any
	if json.Unmarshal(a, &av) != nil || json.Unmarshal(b, &bv) != nil {
		return string(a) == string(b)
	}
	an, _ := json.Marshal(av)
	// Compare canonical forms so column formatting differences do not count.
	bn, _ := json.Marshal(bv)
	return string(an) == string(bn)
}
