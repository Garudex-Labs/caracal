// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"fmt"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/tenancy"
)

// Viewer is the authenticated principal, or nil for anonymous callers.
type Viewer struct {
	ID        uuid.UUID
	Role      string
	ProjectID string
}

// seesPrivateListings reports whether the viewer bypasses row visibility
// entirely. Reviewers deliberately do not.
func (v *Viewer) seesPrivateListings() bool {
	return v != nil && tenancy.IsOperator(v.Role)
}

// EffectivePermission mirrors the component permission contract: owners,
// and co-authors edit; everyone else views.
func EffectivePermission(submittedBy uuid.UUID, coAuthors []string, viewer *Viewer) string {
	if viewer == nil {
		return "view"
	}
	if submittedBy == viewer.ID {
		return "owner"
	}
	for _, id := range coAuthors {
		if id == viewer.ID.String() {
			return "owner"
		}
	}
	return "view"
}

// mayViewUnapproved gates non-approved listings: owners and reviewers only.
func mayViewUnapproved(permission string, viewer *Viewer) bool {
	return permission == "owner" || (viewer != nil && tenancy.IsGlobalReviewer(viewer.Role))
}

// visibilitySQL renders the list-level row filter for the family's listing
// table alias. Rows are visible to their private creator and to members of the
// owning project. There is no public scope, so anonymous callers see nothing.
func visibilitySQL(alias string, viewer *Viewer, args *[]any) string {
	return visibilitySQLCreator(alias, alias+".submitted_by", viewer, args)
}

// visibilitySQLCreator is visibilitySQL with an explicit creator column for
// tables that track authorship as created_by.
func visibilitySQLCreator(alias, creatorCol string, viewer *Viewer, args *[]any) string {
	base := ""
	if viewer.seesPrivateListings() {
		base = "TRUE"
	} else {
		if viewer == nil {
			// No public scope exists: an anonymous caller sees nothing.
			return "FALSE"
		}
		*args = append(*args, viewer.ID)
		viewerArg := fmt.Sprintf("$%d", len(*args))
		own := fmt.Sprintf(
			"(%s.is_private = TRUE AND (%s.ownership_scope = 'private' OR %s.project_id IS NULL) AND %s = %s)",
			alias, alias, alias, creatorCol, viewerArg)
		projectMember := fmt.Sprintf(
			"(%s.is_private = TRUE AND %s.project_id IS NOT NULL AND %s.ownership_scope != 'private' AND EXISTS ("+
				"SELECT 1 FROM project_memberships pm WHERE pm.project_id = %s.project_id AND pm.user_id = %s))",
			alias, alias, alias, alias, viewerArg)
		base = "(" + own + " OR " + projectMember + ")"
	}
	if viewer != nil && viewer.ProjectID != "" {
		*args = append(*args, viewer.ProjectID)
		return fmt.Sprintf("(%s AND %s.project_id = $%d)", base, alias, len(*args))
	}
	return base
}
