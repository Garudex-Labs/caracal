// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package orgs

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/tenancy"
)

// SecurityEvents records tenancy administration in the analytics store.
type SecurityEvents interface {
	InsertJSONEachRow(ctx context.Context, sql string, rows []any) error
}

type fieldError struct {
	Type  string         `json:"type"`
	Loc   []string       `json:"loc"`
	Msg   string         `json:"msg"`
	Input any            `json:"input"`
	Ctx   map[string]any `json:"ctx,omitempty"`
}

func write422(w http.ResponseWriter, errs []fieldError) {
	httpapi.WriteJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": errs})
}

func lengthErrs(loc []string, value string, minLen, maxLen int, errs *[]fieldError) {
	if len(value) < minLen {
		*errs = append(*errs, fieldError{Type: "string_too_short", Loc: loc,
			Msg:   fmt.Sprintf("String should have at least %d character%s", minLen, plural(minLen)),
			Input: value, Ctx: map[string]any{"min_length": minLen}})
	} else if maxLen > 0 && len(value) > maxLen {
		*errs = append(*errs, fieldError{Type: "string_too_long", Loc: loc,
			Msg:   fmt.Sprintf("String should have at most %d characters", maxLen),
			Input: value, Ctx: map[string]any{"max_length": maxLen}})
	}
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

func (h *Handler) emitOrgEvent(ctx context.Context, eventType string, actorID uuid.UUID, org *Org, detail string) {
	if h.Events == nil {
		return
	}
	var email, role string
	_ = h.Store.DB.QueryRow(ctx, `SELECT email, role FROM users WHERE id = $1`, actorID).Scan(&email, &role)
	_ = h.Events.InsertJSONEachRow(ctx, "INSERT INTO security_events FORMAT JSONEachRow", []any{
		map[string]any{
			"event_id": uuid.NewString(), "timestamp": time.Now().UTC().Format("2006-01-02 15:04:05.000000"),
			"event_type": eventType, "severity": "info", "actor_id": actorID.String(),
			"actor_email": email, "actor_role": role, "target_id": org.ID.String(),
			"target_type": "organization", "outcome": "success",
			"source_ip": nil, "user_agent": nil, "detail": detail,
		},
	})
}

// memberRequest is the shared member-upsert body.
type memberRequest struct {
	UserID   *uuid.UUID `json:"user_id"`
	Email    string     `json:"email"`
	Username string     `json:"username"`
	Role     string     `json:"role"`
}

func parseMemberRequest(w http.ResponseWriter, r *http.Request, allowed [2]string, defaultRole string) (*memberRequest, bool) {
	var req memberRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		write422(w, []fieldError{{Type: "missing", Loc: []string{"body"}, Msg: "Field required", Input: nil}})
		return nil, false
	}
	if req.Role == "" {
		req.Role = defaultRole
	}
	if req.Role != allowed[0] && req.Role != allowed[1] {
		write422(w, []fieldError{{Type: "literal_error", Loc: []string{"body", "role"},
			Msg:   fmt.Sprintf("Input should be '%s' or '%s'", allowed[0], allowed[1]),
			Input: req.Role, Ctx: map[string]any{"expected": fmt.Sprintf("'%s' or '%s'", allowed[0], allowed[1])}}})
		return nil, false
	}
	if req.UserID == nil && req.Email == "" && req.Username == "" {
		reason := "Provide email, username, or user_id"
		write422(w, []fieldError{{Type: "value_error", Loc: []string{"body"},
			Msg: "Value error, " + reason, Input: map[string]any{"role": req.Role},
			Ctx: map[string]any{"error": map[string]any{}}}})
		return nil, false
	}
	return &req, true
}

func (h *Handler) createOrg(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.caller(w, r)
	if !ok {
		return
	}
	var req struct {
		Name        string  `json:"name"`
		Slug        string  `json:"slug"`
		Description *string `json:"description"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		write422(w, []fieldError{{Type: "missing", Loc: []string{"body"}, Msg: "Field required", Input: nil}})
		return
	}
	errs := []fieldError{}
	lengthErrs([]string{"body", "name"}, req.Name, 1, 255, &errs)
	lengthErrs([]string{"body", "slug"}, req.Slug, 3, 32, &errs)
	if req.Description != nil {
		lengthErrs([]string{"body", "description"}, *req.Description, 0, 2000, &errs)
	}
	if len(errs) > 0 {
		write422(w, errs)
		return
	}
	slug, err := ValidateOrgSlug(req.Slug)
	if err != nil {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	org, def, err := h.Store.CreateOrg(r.Context(), h.Pool, userID, slug, req.Name, req.Description)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	h.emitOrgEvent(r.Context(), "org.created", userID, org, fmt.Sprintf("Created organization '%s'", org.Slug))
	role, one := "owner", 1
	resp := orgWire(org, &role, &one, &one)
	defWire := projectWire(def, role, def.Role, &one)
	resp.DefaultProject = &defWire
	httpapi.WriteJSON(w, http.StatusCreated, resp)
}

func (h *Handler) updateOrg(w http.ResponseWriter, r *http.Request) {
	org, ok := h.org(w, r)
	if !ok || !requireOrgPermission(w, org, tenancy.PermissionOrgUpdate) {
		return
	}
	userID, _ := h.caller(w, r)
	var req struct {
		Name        *string `json:"name"`
		Description *string `json:"description"`
		Slug        *string `json:"slug"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		write422(w, []fieldError{{Type: "missing", Loc: []string{"body"}, Msg: "Field required", Input: nil}})
		return
	}
	errs := []fieldError{}
	if req.Name != nil {
		lengthErrs([]string{"body", "name"}, *req.Name, 1, 255, &errs)
	}
	if req.Slug != nil {
		lengthErrs([]string{"body", "slug"}, *req.Slug, 3, 32, &errs)
	}
	if req.Description != nil {
		lengthErrs([]string{"body", "description"}, *req.Description, 0, 2000, &errs)
	}
	if len(errs) > 0 {
		write422(w, errs)
		return
	}
	renamedFrom, err := h.Store.UpdateOrg(r.Context(), org, org.Role, req.Slug, req.Name, req.Description)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if renamedFrom != "" {
		h.emitOrgEvent(r.Context(), "org.renamed", userID, org,
			fmt.Sprintf("Organization id changed from '%s' to '%s'", renamedFrom, org.Slug))
	}
	role := org.Role
	httpapi.WriteJSON(w, http.StatusOK, orgWire(org, &role, nil, nil))
}

func (h *Handler) deleteOrg(w http.ResponseWriter, r *http.Request) {
	org, ok := h.org(w, r)
	if !ok || !requireOrgPermission(w, org, tenancy.PermissionOrgDelete) {
		return
	}
	userID, _ := h.caller(w, r)
	if err := h.Store.DeleteOrg(r.Context(), h.Pool, org); err != nil {
		writeErr(w, r, err)
		return
	}
	h.emitOrgEvent(r.Context(), "org.deleted", userID, org, fmt.Sprintf("Deleted organization '%s'", org.Slug))
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) upsertOrgMember(w http.ResponseWriter, r *http.Request) {
	org, ok := h.org(w, r)
	if !ok || !requireOrgPermission(w, org, tenancy.PermissionOrgMembersManage) {
		return
	}
	userID, _ := h.caller(w, r)
	req, ok := parseMemberRequest(w, r, [2]string{"admin", "member"}, "member")
	if !ok {
		return
	}
	target, err := h.Store.ResolveUser(r.Context(), req.UserID, req.Email, req.Username)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if err := h.Store.UpsertOrgMember(r.Context(), org.ID, target, req.Role); err != nil {
		writeErr(w, r, err)
		return
	}
	h.emitOrgEvent(r.Context(), "org.membership.changed", userID, org,
		fmt.Sprintf("Set %s to %s in '%s'", target.Email, req.Role, org.Slug))
	httpapi.WriteJSON(w, http.StatusOK, memberResponse{
		ID: target.ID.String(), Email: target.Email, Username: target.Username,
		Name: target.Name, Role: req.Role,
	})
}

func (h *Handler) removeOrgMember(w http.ResponseWriter, r *http.Request) {
	org, ok := h.org(w, r)
	if !ok {
		return
	}
	callerID, _ := h.caller(w, r)
	targetID, err := uuid.Parse(r.PathValue("user"))
	if err != nil {
		write422(w, []fieldError{{Type: "uuid_parsing", Loc: []string{"path", "user_id"},
			Msg: "Input should be a valid UUID", Input: r.PathValue("user")}})
		return
	}
	if targetID != callerID && !tenancy.EffectiveOrgPermissions(org.Role).Has(tenancy.PermissionOrgMembersManage) {
		httpapi.WriteError(w, http.StatusForbidden, "Insufficient organization permissions")
		return
	}
	revoked, err := h.Store.RemoveOrgMember(r.Context(), h.Pool, org.ID, targetID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	h.emitOrgEvent(r.Context(), "org.membership.changed", callerID, org,
		fmt.Sprintf("Removed user %s from '%s' (revoked %d project membership(s))", targetID, org.Slug, revoked))
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) transferOwnership(w http.ResponseWriter, r *http.Request) {
	org, ok := h.org(w, r)
	if !ok || !requireOrgPermission(w, org, tenancy.PermissionOrgOwnershipTransfer) {
		return
	}
	callerID, _ := h.caller(w, r)
	var req struct {
		UserID *uuid.UUID `json:"user_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.UserID == nil {
		write422(w, []fieldError{{Type: "missing", Loc: []string{"body", "user_id"}, Msg: "Field required", Input: map[string]any{}}})
		return
	}
	if *req.UserID == callerID {
		httpapi.WriteError(w, http.StatusConflict, "You already own this organization")
		return
	}
	target, err := h.Store.TransferOwnership(r.Context(), h.Pool, org.ID, callerID, *req.UserID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	h.emitOrgEvent(r.Context(), "org.ownership.transferred", callerID, org,
		fmt.Sprintf("Transferred ownership of '%s' to %s", org.Slug, target.Email))
	httpapi.WriteJSON(w, http.StatusOK, memberResponse{
		ID: target.ID.String(), Email: target.Email, Username: target.Username,
		Name: target.Name, Role: "owner",
	})
}

func (h *Handler) createProject(w http.ResponseWriter, r *http.Request) {
	org, ok := h.org(w, r)
	if !ok || !requireOrgPermission(w, org, tenancy.PermissionOrgProjectsManage) {
		return
	}
	userID, _ := h.caller(w, r)
	var req struct {
		Name        string  `json:"name"`
		Slug        *string `json:"slug"`
		Description *string `json:"description"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		write422(w, []fieldError{{Type: "missing", Loc: []string{"body"}, Msg: "Field required", Input: nil}})
		return
	}
	errs := []fieldError{}
	lengthErrs([]string{"body", "name"}, req.Name, 1, 255, &errs)
	if req.Slug != nil {
		lengthErrs([]string{"body", "slug"}, *req.Slug, 1, 64, &errs)
	}
	if req.Description != nil {
		lengthErrs([]string{"body", "description"}, *req.Description, 0, 2000, &errs)
	}
	if len(errs) > 0 {
		write422(w, errs)
		return
	}
	slugInput := req.Name
	if req.Slug != nil && *req.Slug != "" {
		slugInput = *req.Slug
	}
	project, err := h.Store.CreateProject(r.Context(), h.Pool, org, userID, slugInput, req.Name, req.Description)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	h.emitOrgEvent(r.Context(), "org.project.created", userID, org,
		fmt.Sprintf("Created project '%s/%s'", org.Slug, project.Slug))
	one := 1
	httpapi.WriteJSON(w, http.StatusCreated, projectWire(project, org.Role, project.Role, &one))
}

// projectForWrite resolves the project and enforces administration.
func (h *Handler) projectForWrite(w http.ResponseWriter, r *http.Request, administer bool) (*Project, *Org, uuid.UUID, bool) {
	userID, ok := h.caller(w, r)
	if !ok {
		return nil, nil, uuid.UUID{}, false
	}
	org, err := h.Store.ResolveOrg(r.Context(), r, h.baseDomain(r), r.PathValue("org"), userID)
	if err != nil {
		writeErr(w, r, err)
		return nil, nil, uuid.UUID{}, false
	}
	project, err := h.Store.ResolveRequestProject(r.Context(), r, org, r.PathValue("project"), userID)
	if err != nil {
		writeErr(w, r, err)
		return nil, nil, uuid.UUID{}, false
	}
	if administer {
		role := ""
		if project.Role != nil {
			role = *project.Role
		}
		if !tenancy.CanAdministerProject(org.Role, role) {
			httpapi.WriteError(w, http.StatusForbidden, "Project administration requires a lead role")
			return nil, nil, uuid.UUID{}, false
		}
	}
	return project, org, userID, true
}

func (h *Handler) updateProject(w http.ResponseWriter, r *http.Request) {
	project, _, _, ok := h.projectForWrite(w, r, true)
	if !ok {
		return
	}
	var req struct {
		Name        *string `json:"name"`
		Description *string `json:"description"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		write422(w, []fieldError{{Type: "missing", Loc: []string{"body"}, Msg: "Field required", Input: nil}})
		return
	}
	errs := []fieldError{}
	if req.Name != nil {
		lengthErrs([]string{"body", "name"}, *req.Name, 1, 255, &errs)
	}
	if req.Description != nil {
		lengthErrs([]string{"body", "description"}, *req.Description, 0, 2000, &errs)
	}
	if len(errs) > 0 {
		write422(w, errs)
		return
	}
	if err := h.Store.UpdateProject(r.Context(), project, req.Name, req.Description); err != nil {
		writeErr(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, projectWire(project, project.OrgRole, project.Role, nil))
}

func (h *Handler) deleteProject(w http.ResponseWriter, r *http.Request) {
	project, org, userID, ok := h.projectForWrite(w, r, true)
	if !ok {
		return
	}
	if err := h.Store.DeleteProject(r.Context(), h.Pool, project); err != nil {
		writeErr(w, r, err)
		return
	}
	h.emitOrgEvent(r.Context(), "org.project.deleted", userID, org,
		fmt.Sprintf("Deleted project '%s/%s'", org.Slug, project.Slug))
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) upsertProjectMember(w http.ResponseWriter, r *http.Request) {
	project, org, userID, ok := h.projectForWrite(w, r, true)
	if !ok {
		return
	}
	req, ok := parseMemberRequest(w, r, [2]string{"lead", "user"}, "user")
	if !ok {
		return
	}
	target, err := h.Store.ResolveUser(r.Context(), req.UserID, req.Email, req.Username)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if err := h.Store.UpsertProjectMember(r.Context(), project, target, req.Role); err != nil {
		writeErr(w, r, err)
		return
	}
	h.emitOrgEvent(r.Context(), "org.project.membership.changed", userID, org,
		fmt.Sprintf("Set %s to %s in project '%s/%s'", target.Email, req.Role, org.Slug, project.Slug))
	httpapi.WriteJSON(w, http.StatusOK, memberResponse{
		ID: target.ID.String(), Email: target.Email, Username: target.Username,
		Name: target.Name, Role: req.Role,
	})
}

func (h *Handler) removeProjectMember(w http.ResponseWriter, r *http.Request) {
	project, org, callerID, ok := h.projectForWrite(w, r, false)
	if !ok {
		return
	}
	targetID, err := uuid.Parse(r.PathValue("user"))
	if err != nil {
		write422(w, []fieldError{{Type: "uuid_parsing", Loc: []string{"path", "user_id"},
			Msg: "Input should be a valid UUID", Input: r.PathValue("user")}})
		return
	}
	role := ""
	if project.Role != nil {
		role = *project.Role
	}
	if targetID != callerID && !tenancy.CanAdministerProject(org.Role, role) {
		httpapi.WriteError(w, http.StatusForbidden, "Project administration requires a lead role")
		return
	}
	if err := h.Store.RemoveProjectMember(r.Context(), project, targetID); err != nil {
		writeErr(w, r, err)
		return
	}
	h.emitOrgEvent(r.Context(), "org.project.membership.changed", callerID, org,
		fmt.Sprintf("Removed user %s from project '%s/%s'", targetID, org.Slug, project.Slug))
	w.WriteHeader(http.StatusNoContent)
}
