// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package orgs

import (
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/tenancy"
)

// Handler serves the organization and project routes; anything not answered
// natively under the prefix is relayed to the API service by the caller.
type Handler struct {
	Store     *Store
	Settings  Setting
	Pool      TxBeginner
	Events    SecurityEvents
	CH        WorkspaceCH
	SecretKey []byte
}

// Register mounts the organization and project surface.
func (h *Handler) Register(mux *http.ServeMux, withAuth func(http.Handler) http.Handler) {
	mux.Handle("GET /api/v1/orgs", withAuth(http.HandlerFunc(h.myOrgs)))
	mux.Handle("GET /api/v1/orgs/{org}", withAuth(http.HandlerFunc(h.orgDetail)))
	mux.Handle("GET /api/v1/orgs/{org}/audit-log", withAuth(http.HandlerFunc(h.orgAuditLog)))
	mux.Handle("GET /api/v1/orgs/{org}/security-events", withAuth(http.HandlerFunc(h.orgSecurityEvents)))
	mux.Handle("GET /api/v1/orgs/{org}/members", withAuth(http.HandlerFunc(h.orgMembers)))
	mux.Handle("GET /api/v1/orgs/{org}/members/{user}/projects", withAuth(http.HandlerFunc(h.memberProjects)))
	mux.Handle("GET /api/v1/orgs/{org}/projects", withAuth(http.HandlerFunc(h.projects)))
	mux.Handle("GET /api/v1/orgs/{org}/projects/{project}", withAuth(http.HandlerFunc(h.projectDetail)))
	mux.Handle("GET /api/v1/orgs/{org}/projects/{project}/members", withAuth(http.HandlerFunc(h.projectMembers)))
	mux.Handle("GET /api/v1/orgs/{org}/projects/{project}/resources", withAuth(http.HandlerFunc(h.projectResources)))
	mux.Handle("GET /api/v1/orgs/{org}/projects/{project}/retention-policy", withAuth(http.HandlerFunc(h.resourceRetentionPolicy)))
	mux.Handle("PUT /api/v1/orgs/{org}/projects/{project}/retention-policy", withAuth(http.HandlerFunc(h.updateResourceRetentionPolicy)))
	mux.Handle("GET /api/v1/orgs/{org}/projects/{project}/intelligence/briefing", withAuth(http.HandlerFunc(h.intelligenceBriefing)))
	mux.Handle("GET /api/v1/orgs/{org}/projects/{project}/intelligence/resources", withAuth(http.HandlerFunc(h.intelligenceResourceIndex)))
	mux.Handle("GET /api/v1/orgs/{org}/projects/{project}/intelligence/resources/compare", withAuth(http.HandlerFunc(h.intelligenceResourceCompare)))
	mux.Handle("GET /api/v1/orgs/{org}/projects/{project}/intelligence/resources/{resource}/versions", withAuth(http.HandlerFunc(h.intelligenceResourceVersions)))
	mux.Handle("GET /api/v1/orgs/{org}/projects/{project}/intelligence/history", withAuth(http.HandlerFunc(h.intelligenceHistory)))
	mux.Handle("POST /api/v1/orgs", withAuth(http.HandlerFunc(h.createOrg)))
	mux.Handle("PATCH /api/v1/orgs/{org}", withAuth(http.HandlerFunc(h.updateOrg)))
	mux.Handle("DELETE /api/v1/orgs/{org}", withAuth(http.HandlerFunc(h.deleteOrg)))
	mux.Handle("POST /api/v1/orgs/{org}/members", withAuth(http.HandlerFunc(h.upsertOrgMember)))
	mux.Handle("DELETE /api/v1/orgs/{org}/members/{user}", withAuth(http.HandlerFunc(h.removeOrgMember)))
	mux.Handle("POST /api/v1/orgs/{org}/transfer-ownership", withAuth(http.HandlerFunc(h.transferOwnership)))
	mux.Handle("POST /api/v1/orgs/{org}/projects", withAuth(http.HandlerFunc(h.createProject)))
	mux.Handle("PATCH /api/v1/orgs/{org}/projects/{project}", withAuth(http.HandlerFunc(h.updateProject)))
	mux.Handle("DELETE /api/v1/orgs/{org}/projects/{project}", withAuth(http.HandlerFunc(h.deleteProject)))
	mux.Handle("POST /api/v1/orgs/{org}/projects/{project}/members", withAuth(http.HandlerFunc(h.upsertProjectMember)))
	mux.Handle("DELETE /api/v1/orgs/{org}/projects/{project}/members/{user}", withAuth(http.HandlerFunc(h.removeProjectMember)))
	mux.Handle("POST /api/v1/orgs/{org}/invitations", withAuth(http.HandlerFunc(h.createInvitation)))
	mux.Handle("GET /api/v1/orgs/{org}/invitations", withAuth(http.HandlerFunc(h.listInvitations)))
	mux.Handle("DELETE /api/v1/orgs/{org}/invitations/{invitation}", withAuth(http.HandlerFunc(h.revokeInvitation)))
	mux.Handle("GET /api/v1/invitations", withAuth(http.HandlerFunc(h.myInvitations)))
	mux.Handle("POST /api/v1/invitations/{invitation}/accept", withAuth(http.HandlerFunc(h.acceptInvitationByID)))
	mux.Handle("GET /api/v1/invitations/token/{token}", withAuth(http.HandlerFunc(h.previewInvitationToken)))
	mux.Handle("POST /api/v1/invitations/token/{token}/accept", withAuth(http.HandlerFunc(h.acceptInvitationByToken)))
}

func (h *Handler) caller(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	claims, ok := httpapi.ClaimsFrom(r.Context())
	if !ok {
		httpapi.WriteError(w, http.StatusUnauthorized, "Missing credentials")
		return uuid.UUID{}, false
	}
	return claims.UserID, true
}

func writeErr(w http.ResponseWriter, r *http.Request, err error) {
	var te *tenancy.Error
	if errors.As(err, &te) {
		httpapi.WriteError(w, te.Status, te.Detail)
		return
	}
	httpapi.WriteInternalError(w, r, err)
}

func (h *Handler) baseDomain(r *http.Request) string {
	return h.Settings.String(r.Context(), "deployment.base_domain", "")
}

func (h *Handler) org(w http.ResponseWriter, r *http.Request) (*Org, bool) {
	userID, ok := h.caller(w, r)
	if !ok {
		return nil, false
	}
	org, err := h.Store.ResolveOrg(r.Context(), r, h.baseDomain(r), r.PathValue("org"), userID)
	if err != nil {
		writeErr(w, r, err)
		return nil, false
	}
	return org, true
}

func (h *Handler) project(w http.ResponseWriter, r *http.Request) (*Project, bool) {
	userID, ok := h.caller(w, r)
	if !ok {
		return nil, false
	}
	org, err := h.Store.ResolveOrg(r.Context(), r, h.baseDomain(r), r.PathValue("org"), userID)
	if err != nil {
		writeErr(w, r, err)
		return nil, false
	}
	project, err := h.Store.ResolveRequestProject(r.Context(), r, org, r.PathValue("project"), userID)
	if err != nil {
		writeErr(w, r, err)
		return nil, false
	}
	return project, true
}

func (h *Handler) myOrgs(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.caller(w, r)
	if !ok {
		return
	}
	out, err := h.Store.MyOrgs(r.Context(), userID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, out)
}

func (h *Handler) orgDetail(w http.ResponseWriter, r *http.Request) {
	org, ok := h.org(w, r)
	if !ok {
		return
	}
	out, err := h.Store.OrgDetail(r.Context(), org)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, out)
}

// parseListQuery validates the shared roster/project listing controls. Sort
// keys are matched against the given whitelist; anything unrecognized is a
// 422 before touching storage.
func parseListQuery(w http.ResponseWriter, r *http.Request, sortKeys map[string]string, defaultSort string, roles []string) (ListQuery, bool) {
	values := r.URL.Query()
	q := ListQuery{
		Q:        strings.TrimSpace(values.Get("q")),
		Sort:     defaultSort,
		Page:     1,
		PageSize: 50,
	}
	if raw := values.Get("sort"); raw != "" {
		if _, ok := sortKeys[raw]; !ok {
			httpapi.WriteError(w, http.StatusUnprocessableEntity, "sort is not a supported key")
			return ListQuery{}, false
		}
		q.Sort = raw
	}
	switch values.Get("dir") {
	case "", "asc":
		q.Ascending = true
	case "desc":
		q.Ascending = false
	default:
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "dir must be 'asc' or 'desc'")
		return ListQuery{}, false
	}
	if raw := values.Get("role"); raw != "" {
		if !slices.Contains(roles, raw) {
			httpapi.WriteError(w, http.StatusUnprocessableEntity, "role is not a valid filter")
			return ListQuery{}, false
		}
		q.Role = raw
	}
	if raw := values.Get("page"); raw != "" {
		page, err := strconv.Atoi(raw)
		if err != nil || page < 1 {
			httpapi.WriteError(w, http.StatusUnprocessableEntity, "page must be a positive integer")
			return ListQuery{}, false
		}
		q.Page = page
	}
	if raw := values.Get("page_size"); raw != "" {
		size, err := strconv.Atoi(raw)
		if err != nil || size < 1 || size > 200 {
			httpapi.WriteError(w, http.StatusUnprocessableEntity, "page_size must be between 1 and 200")
			return ListQuery{}, false
		}
		q.PageSize = size
	}
	return q, true
}

func parseOrgMemberListQuery(w http.ResponseWriter, r *http.Request) (ListQuery, bool) {
	query, ok := parseListQuery(w, r, orgMemberSortKeys, "email", []string{"owner", "admin", "member"})
	if !ok {
		return ListQuery{}, false
	}
	values := r.URL.Query()
	if raw := strings.TrimSpace(values.Get("project")); raw != "" {
		if _, err := tenancy.Slugify(raw); err != nil || !projectSlugRe.MatchString(raw) {
			httpapi.WriteError(w, http.StatusUnprocessableEntity, "project is not a valid project id")
			return ListQuery{}, false
		}
		query.Project = raw
	}
	if raw := values.Get("project_role"); raw != "" {
		if raw != "lead" && raw != "user" {
			httpapi.WriteError(w, http.StatusUnprocessableEntity, "project_role is not a valid filter")
			return ListQuery{}, false
		}
		query.ProjectRole = raw
	}
	return query, true
}

func parseInvitationListQuery(w http.ResponseWriter, r *http.Request) (InvitationListQuery, bool) {
	values := r.URL.Query()
	query := InvitationListQuery{Q: strings.TrimSpace(values.Get("q"))}
	if raw := values.Get("role"); raw != "" {
		if raw != "admin" && raw != "member" {
			httpapi.WriteError(w, http.StatusUnprocessableEntity, "role is not a valid filter")
			return InvitationListQuery{}, false
		}
		query.Role = raw
	}
	if raw := values.Get("state"); raw != "" {
		if !slices.Contains([]string{"pending", "accepted", "expired", "revoked"}, raw) {
			httpapi.WriteError(w, http.StatusUnprocessableEntity, "state is not a valid filter")
			return InvitationListQuery{}, false
		}
		query.State = raw
	}
	return query, true
}

func (h *Handler) orgMembers(w http.ResponseWriter, r *http.Request) {
	org, ok := h.org(w, r)
	if !ok || !requireOrgPermission(w, org, tenancy.PermissionOrgMembersManage) {
		return
	}
	query, ok := parseOrgMemberListQuery(w, r)
	if !ok {
		return
	}
	out, err := h.Store.OrgMembers(r.Context(), org.ID, query)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, out)
}

// memberProjects answers a member's project access map for administrators.
func (h *Handler) memberProjects(w http.ResponseWriter, r *http.Request) {
	org, ok := h.org(w, r)
	if !ok || !requireOrgPermission(w, org, tenancy.PermissionOrgMembersManage) {
		return
	}
	targetID, err := uuid.Parse(r.PathValue("user"))
	if err != nil {
		httpapi.WriteError(w, http.StatusNotFound, "Member not found")
		return
	}
	out, err := h.Store.MemberProjects(r.Context(), org.ID, targetID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, out)
}

func (h *Handler) projects(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.caller(w, r)
	if !ok {
		return
	}
	org, err := h.Store.ResolveOrg(r.Context(), r, h.baseDomain(r), r.PathValue("org"), userID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	query, ok := parseListQuery(w, r, projectSortKeys, "name", nil)
	if !ok {
		return
	}
	out, err := h.Store.Projects(r.Context(), org, userID, query)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, out)
}

func (h *Handler) projectDetail(w http.ResponseWriter, r *http.Request) {
	project, ok := h.project(w, r)
	if !ok {
		return
	}
	out, err := h.Store.ProjectDetail(r.Context(), project)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, out)
}

func (h *Handler) projectMembers(w http.ResponseWriter, r *http.Request) {
	project, _, _, ok := h.projectForWrite(w, r, true)
	if !ok {
		return
	}
	query, ok := parseListQuery(w, r, projectMemberSortKeys, "email", []string{"lead", "user"})
	if !ok {
		return
	}
	out, err := h.Store.ProjectMembers(r.Context(), project.ID, query)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, out)
}

func (h *Handler) projectResources(w http.ResponseWriter, r *http.Request) {
	project, ok := h.project(w, r)
	if !ok {
		return
	}
	out, err := h.Store.ProjectResources(r.Context(), project.ID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, out)
}
