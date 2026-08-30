// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package accounts

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/garudex-labs/caracal/internal/httpapi"
)

// AdminHandler serves the registry-side user administration: roles,
// departments, and account deletion. Identity concerns (passwords, bans,
// sessions) belong to the identity service.
type AdminHandler struct {
	DB     DB
	Events SecurityEvents
	Bridge *Minter
}

var roleRank = map[string]int{"operator": 0, "reviewer": 1, "user": 2}

type adminUser struct {
	ID            uuid.UUID
	Email         string
	Username      *string
	Name          string
	Role          string
	Department    *string
	CreatedAt     *time.Time
	AuthSubjectID *string
}

func (u *adminUser) wire() map[string]any {
	var created *string
	if u.CreatedAt != nil {
		t := u.CreatedAt.UTC()
		c := t.Format("2006-01-02T15:04:05Z")
		if t.Nanosecond() != 0 {
			c = t.Format("2006-01-02T15:04:05.000000Z")
		}
		created = &c
	}
	return map[string]any{
		"id": u.ID.String(), "email": u.Email, "username": u.Username, "name": u.Name,
		"role": u.Role, "department": u.Department, "created_at": created,
	}
}

const adminUserColumns = `id, email, username, name, role, department, created_at, auth_subject_id`

func scanAdminUser(row pgx.Row) (*adminUser, error) {
	var u adminUser
	err := row.Scan(&u.ID, &u.Email, &u.Username, &u.Name, &u.Role, &u.Department, &u.CreatedAt, &u.AuthSubjectID)
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// Register mounts the admin user routes; the caller supplies the auth chain
// and the surrounding role floor.
func (h *AdminHandler) Register(mux *http.ServeMux, withAdmin func(http.Handler) http.Handler) {
	mux.Handle("GET /api/v1/operator/users", withAdmin(http.HandlerFunc(h.list)))
	mux.Handle("PUT /api/v1/operator/users/{id}/role", withAdmin(http.HandlerFunc(h.setRole)))
	mux.Handle("PUT /api/v1/operator/users/{id}/department", withAdmin(http.HandlerFunc(h.setDepartment)))
	mux.Handle("POST /api/v1/operator/users/bulk-department", withAdmin(http.HandlerFunc(h.bulkDepartment)))
	mux.Handle("DELETE /api/v1/operator/users/{id}", withAdmin(http.HandlerFunc(h.deleteUser)))
}

func (h *AdminHandler) caller(w http.ResponseWriter, r *http.Request) (*adminUser, bool) {
	claims, ok := httpapi.ClaimsFrom(r.Context())
	if !ok {
		httpapi.WriteError(w, http.StatusUnauthorized, "Missing credentials")
		return nil, false
	}
	u, err := scanAdminUser(h.DB.QueryRow(r.Context(),
		`SELECT `+adminUserColumns+` FROM users WHERE id = $1`, claims.UserID))
	if err != nil {
		httpapi.WriteError(w, http.StatusUnauthorized, "Unknown user")
		return nil, false
	}
	return u, true
}

func (h *AdminHandler) loadTarget(w http.ResponseWriter, r *http.Request) *adminUser {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		reason := uuidErrorText(r.PathValue("id"))
		httpapi.WriteJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": []map[string]any{{
			"type": "uuid_parsing", "loc": []string{"path", "user_id"},
			"msg":   "Input should be a valid UUID, " + reason,
			"input": r.PathValue("id"), "ctx": map[string]any{"error": reason},
		}}})
		return nil
	}
	u, err := scanAdminUser(h.DB.QueryRow(r.Context(), `SELECT `+adminUserColumns+` FROM users WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		httpapi.WriteError(w, http.StatusNotFound, "User not found")
		return nil
	}
	if err != nil {
		httpapi.WriteError(w, http.StatusInternalServerError, "Internal error")
		return nil
	}
	return u
}

// userSortColumns whitelists the deployment user-list sort keys.
var userSortColumns = map[string]string{
	"created": "u.created_at",
	"email":   "lower(u.email)",
	"name":    "lower(u.name)",
	"role":    "u.role::text",
}

// list serves the deployment-level account inventory with server-side
// search, filtering, sorting, and pagination. Rows carry the deployment
// role and an organization-membership count; per-organization rosters stay
// inside tenant administration.
func (h *AdminHandler) list(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	role := r.URL.Query().Get("role")
	sortKey := r.URL.Query().Get("sort")
	order := r.URL.Query().Get("order")
	if sortKey == "" {
		sortKey = "created"
	}
	sortCol, ok := userSortColumns[sortKey]
	if !ok {
		httpapi.WriteError(w, http.StatusUnprocessableEntity,
			"sort must be one of: created, email, name, role")
		return
	}
	dir := "DESC"
	switch order {
	case "", "desc":
	case "asc":
		dir = "ASC"
	default:
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "order must be asc or desc")
		return
	}
	if role != "" {
		if _, known := roleRank[role]; !known {
			httpapi.WriteError(w, http.StatusUnprocessableEntity,
				"role must be one of: operator, reviewer, user")
			return
		}
	}
	limit, offset := 50, 0
	for name, dst := range map[string]*int{"limit": &limit, "offset": &offset} {
		if raw := r.URL.Query().Get(name); raw != "" {
			n, err := strconv.Atoi(raw)
			if err != nil || n < 0 {
				httpapi.WriteError(w, http.StatusUnprocessableEntity,
					name+" must be a non-negative integer")
				return
			}
			*dst = n
		}
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 100 {
		limit = 100
	}

	conds := []string{"TRUE"}
	args := []any{}
	if q != "" {
		args = append(args, "%"+escapeLike(q)+"%")
		n := strconv.Itoa(len(args))
		conds = append(conds, "(u.email ILIKE $"+n+" OR u.name ILIKE $"+n+" OR u.username ILIKE $"+n+")")
	}
	if role != "" {
		args = append(args, role)
		conds = append(conds, "u.role::text = $"+strconv.Itoa(len(args)))
	}
	where := strings.Join(conds, " AND ")

	var total int64
	if err := h.DB.QueryRow(r.Context(),
		"SELECT count(*) FROM users u WHERE "+where, args...).Scan(&total); err != nil {
		httpapi.WriteError(w, http.StatusInternalServerError, "Internal error")
		return
	}

	rows, err := h.DB.Query(r.Context(),
		`SELECT u.id, u.email, u.username, u.name, u.role, u.department, u.created_at, u.auth_subject_id,
		   (SELECT count(*) FROM organization_memberships m WHERE m.user_id = u.id) AS org_count
		 FROM users u WHERE `+where+
			` ORDER BY `+sortCol+` `+dir+`, u.created_at DESC, u.id ASC`+
			` LIMIT `+strconv.Itoa(limit)+` OFFSET `+strconv.Itoa(offset), args...)
	if err != nil {
		httpapi.WriteError(w, http.StatusInternalServerError, "Internal error")
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var u adminUser
		var orgCount int64
		if err := rows.Scan(&u.ID, &u.Email, &u.Username, &u.Name, &u.Role, &u.Department,
			&u.CreatedAt, &u.AuthSubjectID, &orgCount); err != nil {
			httpapi.WriteError(w, http.StatusInternalServerError, "Internal error")
			return
		}
		item := u.wire()
		item["org_count"] = orgCount
		items = append(items, item)
	}
	if rows.Err() != nil {
		httpapi.WriteError(w, http.StatusInternalServerError, "Internal error")
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"items": items, "total": total, "limit": limit, "offset": offset,
	})
}

func (h *AdminHandler) setRole(w http.ResponseWriter, r *http.Request) {
	actor, ok := h.caller(w, r)
	if !ok {
		return
	}
	target := h.loadTarget(w, r)
	if target == nil {
		return
	}
	var req struct {
		Role *string `json:"role"`
	}
	raw, _ := io.ReadAll(r.Body)
	var echo any
	if json.Unmarshal(raw, &req) != nil || req.Role == nil {
		_ = json.Unmarshal(raw, &echo)
		httpapi.WriteJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": []map[string]any{{
			"type": "missing", "loc": []string{"body", "role"}, "msg": "Field required", "input": echo,
		}}})
		return
	}
	newRole := *req.Role
	if _, known := roleRank[newRole]; !known {
		httpapi.WriteError(w, http.StatusUnprocessableEntity,
			"Invalid role. Must be one of: ['operator', 'reviewer', 'user']")
		return
	}
	if roleRank[newRole] < roleRank[actor.Role] {
		httpapi.WriteError(w, http.StatusForbidden, "Cannot assign a role higher than your own")
		return
	}
	if target.ID == actor.ID && newRole != actor.Role {
		httpapi.WriteError(w, http.StatusBadRequest, "Cannot change your own role")
		return
	}
	oldRole := target.Role
	if _, err := h.DB.Exec(r.Context(), `UPDATE users SET role = $2 WHERE id = $1`, target.ID, newRole); err != nil {
		httpapi.WriteError(w, http.StatusInternalServerError, "Internal error")
		return
	}
	target.Role = newRole
	// Mirror to the identity service so JWT role claims follow (best-effort;
	// the registry DB decides authorization either way).
	if target.AuthSubjectID != nil {
		_ = h.bridgePost(r.Context(), "/internal/set-role",
			map[string]any{"userId": *target.AuthSubjectID, "role": newRole})
	}
	h.emitUserEvent(r.Context(), actor, target.ID, "authz.role_changed", "warning",
		"Role changed from "+oldRole+" to "+newRole)
	httpapi.WriteJSON(w, http.StatusOK, target.wire())
}

func (h *AdminHandler) setDepartment(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.caller(w, r); !ok {
		return
	}
	target := h.loadTarget(w, r)
	if target == nil {
		return
	}
	var req struct {
		Department *string `json:"department"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpapi.WriteJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": []map[string]any{{
			"type": "missing", "loc": []string{"body"}, "msg": "Field required", "input": nil,
		}}})
		return
	}
	if _, err := h.DB.Exec(r.Context(), `UPDATE users SET department = $2 WHERE id = $1`, target.ID, req.Department); err != nil {
		httpapi.WriteError(w, http.StatusInternalServerError, "Internal error")
		return
	}
	target.Department = req.Department
	httpapi.WriteJSON(w, http.StatusOK, target.wire())
}

func (h *AdminHandler) bulkDepartment(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.caller(w, r); !ok {
		return
	}
	var req struct {
		Entries *[]struct {
			Email      *string `json:"email"`
			Department *string `json:"department"`
		} `json:"entries"`
	}
	raw, _ := io.ReadAll(r.Body)
	var echo any
	if json.Unmarshal(raw, &req) != nil || req.Entries == nil {
		_ = json.Unmarshal(raw, &echo)
		httpapi.WriteJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": []map[string]any{{
			"type": "missing", "loc": []string{"body", "entries"}, "msg": "Field required", "input": echo,
		}}})
		return
	}
	updated := 0
	notFound := []string{}
	for i, e := range *req.Entries {
		if e.Email == nil || e.Department == nil {
			field := "email"
			if e.Email != nil {
				field = "department"
			}
			httpapi.WriteJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": []map[string]any{{
				"type": "missing", "loc": []any{"body", "entries", i, field}, "msg": "Field required",
				"input": map[string]any{},
			}}})
			return
		}
		tag, err := h.DB.Exec(r.Context(),
			`UPDATE users SET department = $2 WHERE email = $1`,
			strings.ToLower(strings.TrimSpace(*e.Email)), strings.TrimSpace(*e.Department))
		if err != nil {
			httpapi.WriteError(w, http.StatusInternalServerError, "Internal error")
			return
		}
		if tag.RowsAffected() > 0 {
			updated++
		} else {
			notFound = append(notFound, *e.Email)
		}
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{"updated": updated, "not_found": notFound})
}

func (h *AdminHandler) deleteUser(w http.ResponseWriter, r *http.Request) {
	actor, ok := h.caller(w, r)
	if !ok {
		return
	}
	target := h.loadTarget(w, r)
	if target == nil {
		return
	}
	if target.ID == actor.ID {
		httpapi.WriteError(w, http.StatusBadRequest, "Cannot delete yourself")
		return
	}
	if target.Role == "operator" {
		var operators int
		if err := h.DB.QueryRow(r.Context(),
			`SELECT count(*) FROM users WHERE role::text = 'operator'`).Scan(&operators); err != nil {
			httpapi.WriteError(w, http.StatusInternalServerError, "Internal error")
			return
		}
		if operators <= 1 {
			httpapi.WriteError(w, http.StatusBadRequest, "Cannot delete the last operator")
			return
		}
	}
	h.emitUserEvent(r.Context(), actor, target.ID, "admin.user.deleted", "warning", "Deleted user "+target.Email)
	if _, err := h.DB.Exec(r.Context(), `DELETE FROM users WHERE id = $1`, target.ID); err != nil {
		httpapi.WriteError(w, http.StatusInternalServerError, "Internal error")
		return
	}
	if target.AuthSubjectID != nil {
		_ = h.bridgePost(r.Context(), "/internal/revoke-sessions", map[string]any{"userId": *target.AuthSubjectID})
	}
	w.WriteHeader(http.StatusNoContent)
}

// bridgePost mirrors an account fact to the identity service, best-effort.
func (h *AdminHandler) bridgePost(ctx context.Context, path string, body map[string]any) error {
	if h.Bridge == nil {
		return nil
	}
	payload, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(h.Bridge.BaseURL, "/")+path, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-internal-secret", h.Bridge.InternalSecret)
	client := h.Bridge.Client
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	_ = resp.Body.Close()
	return nil
}

func (h *AdminHandler) emitUserEvent(ctx context.Context, actor *adminUser, targetID uuid.UUID, eventType, severity, detail string) {
	if h.Events == nil {
		return
	}
	_ = h.Events.InsertJSONEachRow(ctx, "INSERT INTO security_events FORMAT JSONEachRow", []any{
		map[string]any{
			"event_id": uuid.NewString(), "timestamp": time.Now().UTC().Format("2006-01-02 15:04:05.000000"),
			"event_type": eventType, "severity": severity, "actor_id": actor.ID.String(),
			"actor_email": actor.Email, "actor_role": actor.Role, "target_id": targetID.String(),
			"target_type": "user", "outcome": "success",
			"source_ip": nil, "user_agent": nil, "detail": detail,
		},
	})
}

func uuidErrorText(raw string) string { return httpapi.UUIDErrorText(raw) }
