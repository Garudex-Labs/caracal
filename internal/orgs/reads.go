// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package orgs

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/garudex-labs/caracal/internal/tenancy"
)

func wireTime(t time.Time) string {
	t = t.UTC()
	if t.Nanosecond() == 0 {
		return t.Format("2006-01-02T15:04:05Z")
	}
	return t.Format("2006-01-02T15:04:05.000000Z")
}

type orgResponse struct {
	ID             string           `json:"id"`
	Slug           string           `json:"slug"`
	Name           string           `json:"name"`
	Description    *string          `json:"description"`
	Role           *string          `json:"role"`
	Permissions    []string         `json:"permissions"`
	MemberCount    *int             `json:"member_count"`
	ProjectCount   *int             `json:"project_count"`
	CreatedAt      *string          `json:"created_at"`
	DefaultProject *projectResponse `json:"default_project,omitempty"`
}

type memberResponse struct {
	ID           string   `json:"id"`
	Email        string   `json:"email"`
	Username     *string  `json:"username"`
	Name         *string  `json:"name"`
	Role         string   `json:"role"`
	OrgRole      *string  `json:"org_role,omitempty"`
	AssignedRole *string  `json:"assigned_role,omitempty"`
	AccessSource string   `json:"access_source,omitempty"`
	Permissions  []string `json:"permissions,omitempty"`
	CreatedAt    *string  `json:"created_at"`
	// ProjectCount is the member's project-membership count inside the
	// organization; only the org roster listing fills it.
	ProjectCount *int `json:"project_count,omitempty"`
}

// membersPage is the bounded roster envelope.
type membersPage struct {
	Members  []memberResponse `json:"members"`
	Total    int              `json:"total"`
	Page     int              `json:"page"`
	PageSize int              `json:"page_size"`
}

// memberProjectResponse is one project a member can access via membership.
type memberProjectResponse struct {
	ID           string   `json:"id"`
	Slug         string   `json:"slug"`
	Name         string   `json:"name"`
	IsDefault    bool     `json:"is_default"`
	Role         string   `json:"role"`
	AssignedRole *string  `json:"assigned_role,omitempty"`
	AccessSource string   `json:"access_source"`
	Permissions  []string `json:"permissions"`
	CreatedAt    string   `json:"created_at"`
}

type projectResponse struct {
	ID             string   `json:"id"`
	OrganizationID string   `json:"organization_id"`
	Slug           string   `json:"slug"`
	Name           string   `json:"name"`
	Description    *string  `json:"description"`
	IsDefault      bool     `json:"is_default"`
	Role           *string  `json:"role"`
	Permissions    []string `json:"permissions"`
	MemberCount    *int     `json:"member_count"`
	CreatedAt      *string  `json:"created_at"`
}

// projectsPage is the bounded project-listing envelope.
type projectsPage struct {
	Projects []projectResponse `json:"projects"`
	Total    int               `json:"total"`
	Page     int               `json:"page"`
	PageSize int               `json:"page_size"`
}

type resourceItem struct {
	ID            string `json:"id"`
	Type          string `json:"type"`
	Name          string `json:"name"`
	QualifiedName string `json:"qualified_name"`
	Visibility    string `json:"visibility"`
}

type resourcesResponse struct {
	Total int            `json:"total"`
	Items []resourceItem `json:"items"`
}

func orgWire(o *Org, role *string, memberCount, projectCount *int) orgResponse {
	created := wireTime(o.CreatedAt)
	roleValue := ""
	if role != nil {
		roleValue = *role
	}
	return orgResponse{
		ID: o.ID.String(), Slug: o.Slug, Name: o.Name, Description: o.Description,
		Role: role, Permissions: tenancy.EffectiveOrgPermissions(roleValue).Strings(),
		MemberCount: memberCount, ProjectCount: projectCount, CreatedAt: &created,
	}
}

func projectWire(p *Project, orgRole string, role *string, memberCount *int) projectResponse {
	created := wireTime(p.CreatedAt)
	roleValue := ""
	if role != nil {
		roleValue = *role
	}
	return projectResponse{
		ID: p.ID.String(), OrganizationID: p.OrganizationID.String(), Slug: p.Slug, Name: p.Name,
		Description: p.Description, IsDefault: p.IsDefault, Role: role,
		Permissions: tenancy.EffectiveProjectPermissions(orgRole, roleValue).Strings(),
		MemberCount: memberCount, CreatedAt: &created,
	}
}

// MyOrgs lists the caller's organizations by name; no global listing exists.
func (s *Store) MyOrgs(ctx context.Context, userID uuid.UUID) ([]orgResponse, error) {
	rows, err := s.DB.Query(ctx,
		`SELECT o.id, o.slug, o.name, o.description, o.created_at, m.role
		 FROM organizations o
		 JOIN organization_memberships m ON m.organization_id = o.id
		 WHERE m.user_id = $1 ORDER BY o.name`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []orgResponse{}
	for rows.Next() {
		var o Org
		if err := rows.Scan(&o.ID, &o.Slug, &o.Name, &o.Description, &o.CreatedAt, &o.Role); err != nil {
			return nil, err
		}
		role := o.Role
		out = append(out, orgWire(&o, &role, nil, nil))
	}
	return out, rows.Err()
}

// OrgDetail fills the membership and project counts for one organization.
func (s *Store) OrgDetail(ctx context.Context, org *Org) (orgResponse, error) {
	var memberCount, projectCount int
	if err := s.DB.QueryRow(ctx,
		`SELECT count(*) FROM organization_memberships WHERE organization_id = $1`, org.ID).Scan(&memberCount); err != nil {
		return orgResponse{}, err
	}
	if err := s.DB.QueryRow(ctx,
		`SELECT count(*) FROM projects WHERE organization_id = $1`, org.ID).Scan(&projectCount); err != nil {
		return orgResponse{}, err
	}
	role := org.Role
	return orgWire(org, &role, &memberCount, &projectCount), nil
}

// ListQuery carries validated pagination, search, and ordering controls for
// the org roster and project listings. Handlers construct it from request
// parameters; sort keys are whitelisted there, never interpolated from input.
type ListQuery struct {
	Q           string
	Role        string
	Project     string
	ProjectRole string
	Sort        string
	Ascending   bool
	Page        int
	PageSize    int
}

func (q ListQuery) offset() int { return (q.Page - 1) * q.PageSize }

func (q ListQuery) direction() string {
	if q.Ascending {
		return "ASC"
	}
	return "DESC"
}

// likePattern turns a raw search term into an infix ILIKE pattern with LIKE
// metacharacters escaped, so user input can never widen the match.
func likePattern(q string) string {
	return "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(q) + "%"
}

func (s *Store) members(ctx context.Context, sql string, scopeID uuid.UUID) ([]memberResponse, error) {
	rows, err := s.DB.Query(ctx, sql, scopeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []memberResponse{}
	for rows.Next() {
		var m memberResponse
		var created time.Time
		if err := rows.Scan(&m.ID, &m.Email, &m.Username, &m.Name, &m.Role, &created); err != nil {
			return nil, err
		}
		w := wireTime(created)
		m.CreatedAt = &w
		out = append(out, m)
	}
	return out, rows.Err()
}

// orgMemberSortKeys whitelists the roster sort keys.
var orgMemberSortKeys = map[string]string{
	"email":  "u.email",
	"name":   "COALESCE(u.name, u.username, u.email)",
	"joined": "m.created_at",
	"role":   "m.role",
}

// OrgMembers lists one bounded, deterministically ordered roster page.
func (s *Store) OrgMembers(ctx context.Context, orgID uuid.UUID, q ListQuery) (membersPage, error) {
	where := []string{"m.organization_id = $1"}
	args := []any{orgID}
	if q.Q != "" {
		args = append(args, likePattern(q.Q))
		p := fmt.Sprintf("$%d", len(args))
		where = append(where, fmt.Sprintf("(u.email ILIKE %[1]s OR u.username ILIKE %[1]s OR u.name ILIKE %[1]s)", p))
	}
	if q.Role != "" {
		args = append(args, q.Role)
		where = append(where, fmt.Sprintf("m.role = $%d", len(args)))
	}
	if q.Project != "" || q.ProjectRole != "" {
		filter := `EXISTS (
			SELECT 1 FROM projects fp
			LEFT JOIN project_memberships fpm ON fpm.project_id = fp.id AND fpm.user_id = u.id
			WHERE fp.organization_id = $1`
		if q.Project != "" {
			args = append(args, q.Project)
			filter += fmt.Sprintf(" AND fp.slug = $%d", len(args))
		}
		filter += " AND (m.role IN ('owner', 'admin') OR fpm.user_id IS NOT NULL)"
		if q.ProjectRole != "" {
			args = append(args, q.ProjectRole)
			filter += fmt.Sprintf(" AND ((m.role IN ('owner', 'admin') AND $%[1]d::project_role = 'lead'::project_role) OR fpm.role = $%[1]d::project_role)", len(args))
		}
		filter += ")"
		where = append(where, filter)
	}
	cond := strings.Join(where, " AND ")
	page := membersPage{Members: []memberResponse{}, Page: q.Page, PageSize: q.PageSize}
	if err := s.DB.QueryRow(ctx,
		`SELECT count(*) FROM users u JOIN organization_memberships m ON m.user_id = u.id WHERE `+cond,
		args...).Scan(&page.Total); err != nil {
		return membersPage{}, err
	}
	args = append(args, q.PageSize, q.offset())
	sql := fmt.Sprintf(
		`SELECT u.id::text, u.email, u.username, u.name, m.role, m.created_at,
		 (SELECT count(*) FROM project_memberships pm JOIN projects p ON p.id = pm.project_id
		  WHERE pm.user_id = u.id AND p.organization_id = $1)
		 FROM users u JOIN organization_memberships m ON m.user_id = u.id
		 WHERE %s ORDER BY %s %s, u.id ASC LIMIT $%d OFFSET $%d`,
		cond, orgMemberSortKeys[q.Sort], q.direction(), len(args)-1, len(args))
	rows, err := s.DB.Query(ctx, sql, args...)
	if err != nil {
		return membersPage{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var m memberResponse
		var created time.Time
		var projectCount int
		if err := rows.Scan(&m.ID, &m.Email, &m.Username, &m.Name, &m.Role, &created, &projectCount); err != nil {
			return membersPage{}, err
		}
		w := wireTime(created)
		m.CreatedAt = &w
		m.ProjectCount = &projectCount
		page.Members = append(page.Members, m)
	}
	return page, rows.Err()
}

// MemberProjects lists the projects a member can access, including inherited
// lead-level access for organization owners and admins. Returns nil (not
// found) when the target is not a member of the organization.
func (s *Store) MemberProjects(ctx context.Context, orgID, userID uuid.UUID) ([]memberProjectResponse, error) {
	var memberRole string
	err := s.DB.QueryRow(ctx,
		`SELECT role FROM organization_memberships WHERE organization_id = $1 AND user_id = $2`,
		orgID, userID).Scan(&memberRole)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &tenancy.Error{Status: 404, Detail: "Member not found"}
	}
	if err != nil {
		return nil, err
	}
	var rows pgx.Rows
	if tenancy.IsOrgAdmin(memberRole) {
		rows, err = s.DB.Query(ctx,
			`SELECT p.id::text, p.slug, p.name, p.is_default, pm.role, COALESCE(pm.created_at, p.created_at)
			 FROM projects p
			 LEFT JOIN project_memberships pm ON pm.project_id = p.id AND pm.user_id = $2
			 WHERE p.organization_id = $1 ORDER BY p.name, p.slug`,
			orgID, userID)
	} else {
		rows, err = s.DB.Query(ctx,
			`SELECT p.id::text, p.slug, p.name, p.is_default, pm.role, pm.created_at
			 FROM project_memberships pm JOIN projects p ON p.id = pm.project_id
			 WHERE p.organization_id = $1 AND pm.user_id = $2 ORDER BY p.name, p.slug`,
			orgID, userID)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []memberProjectResponse{}
	for rows.Next() {
		var p memberProjectResponse
		var created time.Time
		if err := rows.Scan(&p.ID, &p.Slug, &p.Name, &p.IsDefault, &p.AssignedRole, &created); err != nil {
			return nil, err
		}
		if p.AssignedRole != nil {
			p.Role = *p.AssignedRole
			p.AccessSource = "project"
		} else {
			p.Role = "lead"
			p.AccessSource = "organization"
		}
		if tenancy.IsOrgAdmin(memberRole) {
			p.Role = "lead"
			p.AccessSource = "organization"
		}
		p.Permissions = tenancy.EffectiveProjectPermissions(memberRole, p.Role).Strings()
		p.CreatedAt = wireTime(created)
		out = append(out, p)
	}
	return out, rows.Err()
}

// ProjectMembers lists the project roster ordered by email.
func (s *Store) ProjectMembers(ctx context.Context, projectID uuid.UUID, q ListQuery) (membersPage, error) {
	joins := ` FROM projects p
		 JOIN organization_memberships om ON om.organization_id = p.organization_id
		 JOIN users u ON u.id = om.user_id
		 LEFT JOIN project_memberships pm ON pm.project_id = p.id AND pm.user_id = u.id`
	where := []string{"p.id = $1", "(om.role IN ('owner', 'admin') OR pm.user_id IS NOT NULL)"}
	args := []any{projectID}
	if q.Q != "" {
		args = append(args, likePattern(q.Q))
		p := fmt.Sprintf("$%d", len(args))
		where = append(where, fmt.Sprintf("(u.email ILIKE %[1]s OR u.username ILIKE %[1]s OR u.name ILIKE %[1]s)", p))
	}
	if q.Role != "" {
		args = append(args, q.Role)
		where = append(where, fmt.Sprintf("(CASE WHEN om.role IN ('owner', 'admin') THEN 'lead' ELSE pm.role::text END) = $%d", len(args)))
	}
	cond := strings.Join(where, " AND ")
	page := membersPage{Members: []memberResponse{}, Page: q.Page, PageSize: q.PageSize}
	if err := s.DB.QueryRow(ctx, "SELECT count(*)"+joins+" WHERE "+cond, args...).Scan(&page.Total); err != nil {
		return membersPage{}, err
	}
	args = append(args, q.PageSize, q.offset())
	sql := fmt.Sprintf(
		`SELECT u.id::text, u.email, u.username, u.name, om.role, pm.role, COALESCE(pm.created_at, om.created_at)
		 %s WHERE %s ORDER BY %s %s, u.id ASC LIMIT $%d OFFSET $%d`,
		joins, cond, projectMemberSortKeys[q.Sort], q.direction(), len(args)-1, len(args))
	rows, err := s.DB.Query(ctx, sql, args...)
	if err != nil {
		return membersPage{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var m memberResponse
		var orgRole string
		var assignedRole *string
		var created time.Time
		if err := rows.Scan(&m.ID, &m.Email, &m.Username, &m.Name, &orgRole, &assignedRole, &created); err != nil {
			return membersPage{}, err
		}
		m.OrgRole = &orgRole
		m.AssignedRole = assignedRole
		if tenancy.IsOrgAdmin(orgRole) {
			m.Role = "lead"
			m.AccessSource = "organization"
		} else if assignedRole != nil {
			m.Role = *assignedRole
			m.AccessSource = "project"
		}
		m.Permissions = tenancy.EffectiveProjectPermissions(orgRole, m.Role).Strings()
		w := wireTime(created)
		m.CreatedAt = &w
		page.Members = append(page.Members, m)
	}
	return page, rows.Err()
}

// projectMemberSortKeys whitelists the project roster sort keys.
var projectMemberSortKeys = map[string]string{
	"email":    "u.email",
	"name":     "COALESCE(u.name, u.username, u.email)",
	"joined":   "COALESCE(pm.created_at, om.created_at)",
	"role":     "CASE WHEN om.role IN ('owner', 'admin') THEN 'lead' ELSE pm.role::text END",
	"org_role": "om.role",
}

// projectSortKeys whitelists the project-listing sort keys.
var projectSortKeys = map[string]string{
	"name":    "p.name",
	"created": "p.created_at",
	"members": "COALESCE(mc.count, 0)",
}

// Projects lists one bounded page of what the caller can access: their
// memberships, or every project for org owners and admins.
func (s *Store) Projects(ctx context.Context, org *Org, userID uuid.UUID, q ListQuery) (projectsPage, error) {
	joins := ` FROM projects p
	        LEFT JOIN (
	          SELECT p2.id AS project_id, count(DISTINCT om.user_id) AS count
	          FROM projects p2
	          JOIN organization_memberships om ON om.organization_id = p2.organization_id
	          LEFT JOIN project_memberships pm ON pm.project_id = p2.id AND pm.user_id = om.user_id
	          WHERE om.role IN ('owner', 'admin') OR pm.user_id IS NOT NULL
	          GROUP BY p2.id
	        ) mc
	          ON mc.project_id = p.id
	        LEFT JOIN (SELECT project_id, role FROM project_memberships WHERE user_id = $2) my
	          ON my.project_id = p.id`
	where := []string{"p.organization_id = $1"}
	args := []any{org.ID, userID}
	if !tenancy.IsOrgAdmin(org.Role) {
		where = append(where, "my.role IS NOT NULL")
	}
	if q.Q != "" {
		args = append(args, likePattern(q.Q))
		p := fmt.Sprintf("$%d", len(args))
		where = append(where, fmt.Sprintf("(p.name ILIKE %[1]s OR p.slug ILIKE %[1]s)", p))
	}
	cond := strings.Join(where, " AND ")
	page := projectsPage{Projects: []projectResponse{}, Page: q.Page, PageSize: q.PageSize}
	if err := s.DB.QueryRow(ctx, "SELECT count(*)"+joins+" WHERE "+cond, args...).Scan(&page.Total); err != nil {
		return projectsPage{}, err
	}
	args = append(args, q.PageSize, q.offset())
	sql := fmt.Sprintf(
		`SELECT p.id, p.organization_id, p.slug, p.name, p.description, p.created_at, p.is_default,
	        COALESCE(mc.count, 0), my.role%s WHERE %s ORDER BY %s %s, p.slug ASC LIMIT $%d OFFSET $%d`,
		joins, cond, projectSortKeys[q.Sort], q.direction(), len(args)-1, len(args))
	rows, err := s.DB.Query(ctx, sql, args...)
	if err != nil {
		return projectsPage{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var p Project
		var count int
		if err := rows.Scan(&p.ID, &p.OrganizationID, &p.Slug, &p.Name, &p.Description,
			&p.CreatedAt, &p.IsDefault, &count, &p.Role); err != nil {
			return projectsPage{}, err
		}
		page.Projects = append(page.Projects, projectWire(&p, org.Role, p.Role, &count))
	}
	return page, rows.Err()
}

// ProjectDetail fills the member count for one resolved project.
func (s *Store) ProjectDetail(ctx context.Context, p *Project) (projectResponse, error) {
	var memberCount int
	if err := s.DB.QueryRow(ctx,
		`SELECT count(DISTINCT om.user_id)
		 FROM projects p
		 JOIN organization_memberships om ON om.organization_id = p.organization_id
		 LEFT JOIN project_memberships pm ON pm.project_id = p.id AND pm.user_id = om.user_id
		 WHERE p.id = $1 AND (om.role IN ('owner', 'admin') OR pm.user_id IS NOT NULL)`, p.ID).Scan(&memberCount); err != nil {
		return projectResponse{}, err
	}
	return projectWire(p, p.OrgRole, p.Role, &memberCount), nil
}

// resourceTables maps each registry type to its table, in response order.
var resourceTables = []struct{ typeName, table string }{
	{"agent", "agents"},
	{"mcp", "mcp_listings"},
	{"skill", "skill_listings"},
	{"hook", "hook_listings"},
	{"prompt", "prompt_listings"},
}

// ProjectResources lists everything the project owns across resource types.
func (s *Store) ProjectResources(ctx context.Context, projectID uuid.UUID) (resourcesResponse, error) {
	items := []resourceItem{}
	for _, t := range resourceTables {
		rows, err := s.DB.Query(ctx,
			`SELECT id::text, name, namespace || '/' || slug,
			 CASE WHEN ownership_scope = 'private' THEN 'private' ELSE 'project' END
			 FROM `+t.table+` WHERE project_id = $1 ORDER BY slug`, projectID)
		if err != nil {
			return resourcesResponse{}, err
		}
		for rows.Next() {
			item := resourceItem{Type: t.typeName}
			if err := rows.Scan(&item.ID, &item.Name, &item.QualifiedName, &item.Visibility); err != nil {
				rows.Close()
				return resourcesResponse{}, err
			}
			items = append(items, item)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return resourcesResponse{}, err
		}
	}
	rows, err := s.DB.Query(ctx,
		`SELECT id::text, url, 'project'
		 FROM component_sources WHERE project_id = $1 ORDER BY url`, projectID)
	if err != nil {
		return resourcesResponse{}, err
	}
	defer rows.Close()
	for rows.Next() {
		item := resourceItem{Type: "component_source"}
		var url string
		if err := rows.Scan(&item.ID, &url, &item.Visibility); err != nil {
			return resourcesResponse{}, err
		}
		item.Name = url
		item.QualifiedName = url
		items = append(items, item)
	}
	return resourcesResponse{Total: len(items), Items: items}, rows.Err()
}
