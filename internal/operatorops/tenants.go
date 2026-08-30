// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package operatorops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/orgs"
	"github.com/garudex-labs/caracal/internal/tenancy"
)

const (
	defaultPageSize = 50
	maxPageSize     = 100
)

// sortColumns whitelists the SQL-side sort keys for the tenant list; the
// "activity" key is handled separately because it ranks on ClickHouse data.
var sortColumns = map[string]string{
	"created":  "created_at",
	"name":     "lower(name)",
	"members":  "member_count",
	"projects": "project_count",
}

// orgListParams are the validated query parameters of GET /operator/orgs.
type orgListParams struct {
	q      string
	status string // "", "active", "suspended"
	sort   string
	order  string // "asc", "desc"
	limit  int
	offset int
}

func parseOrgListParams(w http.ResponseWriter, r *http.Request) (orgListParams, bool) {
	p := orgListParams{
		q:      strings.TrimSpace(r.URL.Query().Get("q")),
		status: r.URL.Query().Get("status"),
		sort:   r.URL.Query().Get("sort"),
		order:  r.URL.Query().Get("order"),
		limit:  defaultPageSize,
	}
	if p.sort == "" {
		p.sort = "created"
	}
	if _, ok := sortColumns[p.sort]; !ok && p.sort != "activity" {
		httpapi.WriteError(w, http.StatusBadRequest,
			"sort must be one of: created, name, members, projects, activity")
		return p, false
	}
	switch p.order {
	case "":
		p.order = "desc"
	case "asc", "desc":
	default:
		httpapi.WriteError(w, http.StatusBadRequest, "order must be asc or desc")
		return p, false
	}
	switch p.status {
	case "", "active", "suspended":
	default:
		httpapi.WriteError(w, http.StatusBadRequest, "status must be active or suspended")
		return p, false
	}
	for name, dst := range map[string]*int{"limit": &p.limit, "offset": &p.offset} {
		if raw := r.URL.Query().Get(name); raw != "" {
			n, err := strconv.Atoi(raw)
			if err != nil || n < 0 {
				httpapi.WriteError(w, http.StatusBadRequest, name+" must be a non-negative integer")
				return p, false
			}
			*dst = n
		}
	}
	if p.limit < 1 {
		p.limit = 1
	}
	if p.limit > maxPageSize {
		p.limit = maxPageSize
	}
	return p, true
}

// escapeLike neutralizes ILIKE metacharacters in user-supplied search text.
func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

// filterSQL renders the WHERE clause and arguments shared by the count and
// page queries. Conditions are fixed strings; user input only binds as args.
func (p orgListParams) filterSQL() (string, []any) {
	conds := []string{"TRUE"}
	args := []any{}
	if p.q != "" {
		args = append(args, "%"+escapeLike(p.q)+"%")
		conds = append(conds, fmt.Sprintf("(o.name ILIKE $%d OR o.slug ILIKE $%d)", len(args), len(args)))
	}
	switch p.status {
	case "active":
		conds = append(conds, "o.suspended_at IS NULL")
	case "suspended":
		conds = append(conds, "o.suspended_at IS NOT NULL")
	}
	return strings.Join(conds, " AND "), args
}

const orgSelectColumns = `o.id::text AS id, o.slug, o.name, o.created_at, o.suspended_at,
	(SELECT count(*) FROM organization_memberships m WHERE m.organization_id = o.id) AS member_count,
	(SELECT count(*) FROM projects p WHERE p.organization_id = o.id) AS project_count,
	(SELECT u.email FROM organization_memberships m JOIN users u ON u.id = m.user_id
	   WHERE m.organization_id = o.id AND m.role = 'owner'
	   ORDER BY m.created_at LIMIT 1) AS owner_email`

// organizations lists tenants with server-side search, filtering, sorting,
// and pagination. Rows are lifecycle metadata only, never tenant content.
// 30-day session activity is attached from ClickHouse when available and
// reported as unavailable, not zero, when it is not.
func (h *Handler) organizations(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p, ok := parseOrgListParams(w, r)
	if !ok {
		return
	}
	where, args := p.filterSQL()

	activityOK := true
	act, err := h.activityByOrg(ctx)
	if err != nil {
		activityOK = false
		if p.sort == "activity" {
			httpapi.WriteError(w, http.StatusServiceUnavailable,
				"Session activity is unavailable; retry or sort by another column")
			return
		}
	}

	var total int64
	if err := h.DB.QueryRow(ctx,
		"SELECT count(*) FROM organizations o WHERE "+where, args...).Scan(&total); err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}

	var rows pgx.Rows
	var pageOrder []string
	if p.sort == "activity" {
		ids, err := h.activityPageIDs(ctx, where, args, act.orgSessions, p)
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		pageOrder = ids
		if len(ids) == 0 {
			httpapi.WriteJSON(w, http.StatusOK, map[string]any{
				"items": []any{}, "total": total, "limit": p.limit, "offset": p.offset,
				"activity": "ok",
			})
			return
		}
		rows, err = h.DB.Query(ctx, fmt.Sprintf(
			"SELECT %s FROM organizations o WHERE o.id::text = ANY($1)", orgSelectColumns), ids)
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
	} else {
		dir := "DESC"
		if p.order == "asc" {
			dir = "ASC"
		}
		query := fmt.Sprintf(
			"SELECT * FROM (SELECT %s FROM organizations o WHERE %s) t ORDER BY %s %s, created_at DESC, id ASC LIMIT %d OFFSET %d",
			orgSelectColumns, where, sortColumns[p.sort], dir, p.limit, p.offset)
		rows, err = h.DB.Query(ctx, query, args...)
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
	}
	defer rows.Close()

	byID := map[string]map[string]any{}
	items := []map[string]any{}
	for rows.Next() {
		var id, slug, name string
		var created time.Time
		var suspended *time.Time
		var members, projects int64
		var ownerEmail *string
		if err := rows.Scan(&id, &slug, &name, &created, &suspended, &members, &projects, &ownerEmail); err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		item := map[string]any{
			"id": id, "slug": slug, "name": name,
			"created_at":    created.UTC().Format(time.RFC3339),
			"suspended_at":  nil,
			"member_count":  members,
			"project_count": projects,
			"owner_email":   ownerEmail,
			"sessions_30d":  nil,
		}
		if suspended != nil {
			item["suspended_at"] = suspended.UTC().Format(time.RFC3339)
		}
		if activityOK {
			item["sessions_30d"] = act.orgSessions[id]
		}
		items = append(items, item)
		byID[id] = item
	}
	if rows.Err() != nil {
		httpapi.WriteInternalError(w, r, rows.Err())
		return
	}
	if pageOrder != nil {
		ordered := make([]map[string]any, 0, len(pageOrder))
		for _, id := range pageOrder {
			if item, ok := byID[id]; ok {
				ordered = append(ordered, item)
			}
		}
		items = ordered
	}

	activityState := "ok"
	if !activityOK {
		activityState = "unavailable"
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"items": items, "total": total, "limit": p.limit, "offset": p.offset,
		"activity": activityState,
	})
}

// activityPageIDs ranks all matching organization ids by 30-day session
// count (ties broken by creation time, newest first) and returns the ids of
// the requested page in display order. Only two narrow columns are pulled
// for the full match set, so the ranking stays cheap at tenant-list scale.
func (h *Handler) activityPageIDs(ctx context.Context, where string, args []any,
	orgSessions map[string]int64, p orgListParams) ([]string, error) {
	rows, err := h.DB.Query(ctx,
		"SELECT o.id::text, o.created_at FROM organizations o WHERE "+where+
			" ORDER BY o.id LIMIT 100001", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type cand struct {
		id      string
		created time.Time
	}
	all := []cand{}
	for rows.Next() {
		var c cand
		if err := rows.Scan(&c.id, &c.created); err != nil {
			return nil, err
		}
		all = append(all, c)
		if len(all) > maxActivityScope {
			return nil, errActivityScopeTooLarge
		}
	}
	if rows.Err() != nil {
		return nil, rows.Err()
	}
	asc := p.order == "asc"
	sort.Slice(all, func(i, j int) bool {
		si, sj := orgSessions[all[i].id], orgSessions[all[j].id]
		if si != sj {
			if asc {
				return si < sj
			}
			return si > sj
		}
		if !all[i].created.Equal(all[j].created) {
			return all[i].created.After(all[j].created)
		}
		return all[i].id < all[j].id
	})
	if p.offset >= len(all) {
		return []string{}, nil
	}
	end := p.offset + p.limit
	if end > len(all) {
		end = len(all)
	}
	ids := make([]string, 0, end-p.offset)
	for _, c := range all[p.offset:end] {
		ids = append(ids, c.id)
	}
	return ids, nil
}

// confirmBody is the confirmation payload of destructive tenant actions.
type confirmBody struct {
	Confirm string `json:"confirm"`
}

// loadOrgForAction resolves the {id} path segment, decodes and verifies the
// slug confirmation, and returns the org row. Every failure mode answers
// with a specific status so the UI can guide the operator.
func (h *Handler) loadOrgForAction(w http.ResponseWriter, r *http.Request) (id uuid.UUID, slug string, suspendedAt *time.Time, ok bool) {
	parsed, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		httpapi.WriteError(w, http.StatusNotFound, "Organization not found")
		return
	}
	var body confirmBody
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		httpapi.WriteError(w, http.StatusBadRequest, "Request body must be JSON with a confirm field")
		return
	}
	err = h.DB.QueryRow(r.Context(),
		`SELECT slug, suspended_at FROM organizations WHERE id = $1`, parsed).Scan(&slug, &suspendedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		httpapi.WriteError(w, http.StatusNotFound, "Organization not found")
		return
	}
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	if body.Confirm != slug {
		httpapi.WriteError(w, http.StatusBadRequest,
			"Confirmation does not match the organization slug")
		return
	}
	return parsed, slug, suspendedAt, true
}

// suspendOrg marks a tenant suspended: members are locked out of every
// scoped route until the organization is reinstated. Requires the slug to
// be echoed in the request body as confirmation.
func (h *Handler) suspendOrg(w http.ResponseWriter, r *http.Request) {
	id, slug, suspendedAt, ok := h.loadOrgForAction(w, r)
	if !ok {
		return
	}
	if suspendedAt != nil {
		httpapi.WriteError(w, http.StatusConflict, "Organization is already suspended")
		return
	}
	var stamped time.Time
	err := h.DB.QueryRow(r.Context(),
		`UPDATE organizations SET suspended_at = now() WHERE id = $1 AND suspended_at IS NULL
		 RETURNING suspended_at`, id).Scan(&stamped)
	if errors.Is(err, pgx.ErrNoRows) {
		httpapi.WriteError(w, http.StatusConflict, "Organization is already suspended")
		return
	}
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"id": id.String(), "slug": slug,
		"suspended_at": stamped.UTC().Format(time.RFC3339),
	})
}

// reinstateOrg lifts a suspension. Requires slug confirmation.
func (h *Handler) reinstateOrg(w http.ResponseWriter, r *http.Request) {
	id, slug, suspendedAt, ok := h.loadOrgForAction(w, r)
	if !ok {
		return
	}
	if suspendedAt == nil {
		httpapi.WriteError(w, http.StatusConflict, "Organization is not suspended")
		return
	}
	tag, err := h.DB.Exec(r.Context(),
		`UPDATE organizations SET suspended_at = NULL WHERE id = $1 AND suspended_at IS NOT NULL`, id)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	if tag.RowsAffected() == 0 {
		httpapi.WriteError(w, http.StatusConflict, "Organization is not suspended")
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"id": id.String(), "slug": slug, "suspended_at": nil,
	})
}

// deleteOrg removes an empty, already-suspended tenant. Suspension first
// forces a deliberate two-step flow, and the shared orgs deletion path
// refuses organizations that still own projects or resources: the operator
// control plane never bulk-destroys tenant content.
func (h *Handler) deleteOrg(w http.ResponseWriter, r *http.Request) {
	id, slug, suspendedAt, ok := h.loadOrgForAction(w, r)
	if !ok {
		return
	}
	if suspendedAt == nil {
		httpapi.WriteError(w, http.StatusConflict,
			"Suspend the organization before deleting it")
		return
	}
	err := h.Orgs.DeleteSuspendedOrg(r.Context(), h.Tx, &orgs.Org{ID: id, Slug: slug})
	var terr *tenancy.Error
	if errors.As(err, &terr) {
		httpapi.WriteError(w, terr.Status, terr.Detail)
		return
	}
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
