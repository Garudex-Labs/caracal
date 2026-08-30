// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package orgs

import (
	"encoding/json"
	"net/http"
	"slices"
	"time"

	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/resretention"
	"github.com/garudex-labs/caracal/internal/tenancy"
)

type retentionBounds struct {
	MinDays int `json:"min_days"`
	MaxDays int `json:"max_days"`
}

type retentionConflict struct {
	ID                       string  `json:"id"`
	Name                     string  `json:"name"`
	Namespace                string  `json:"namespace"`
	Slug                     string  `json:"slug"`
	QualifiedName            string  `json:"qualified_name"`
	Visibility               string  `json:"visibility"`
	DeletedAt                string  `json:"deleted_at"`
	ScheduledPurgeAt         *string `json:"scheduled_purge_at"`
	ProposedScheduledPurgeAt string  `json:"proposed_scheduled_purge_at"`
	EligibleAtApply          bool    `json:"eligible_at_apply"`
}

type retentionPolicyResponse struct {
	PrivateRetentionDays int                        `json:"private_retention_days"`
	ProjectRetentionDays int                        `json:"project_retention_days"`
	Bounds               map[string]retentionBounds `json:"bounds"`
	CanUpdate            bool                       `json:"can_update"`
	RequiresConfirmation bool                       `json:"requires_confirmation,omitempty"`
	Applied              bool                       `json:"applied,omitempty"`
	Conflicts            []retentionConflict        `json:"conflicts,omitempty"`
}

type retentionPolicyRequest struct {
	PrivateRetentionDays *int     `json:"private_retention_days"`
	ProjectRetentionDays *int     `json:"project_retention_days"`
	Confirm              bool     `json:"confirm"`
	ConfirmedConflictIDs []string `json:"confirmed_conflict_ids"`
}

func retentionBoundsWire() map[string]retentionBounds {
	return map[string]retentionBounds{
		"private": {MinDays: resretention.PrivateMinDays, MaxDays: resretention.PrivateMaxDays},
		"project": {MinDays: resretention.ProjectMinDays, MaxDays: resretention.ProjectMaxDays},
	}
}

func canUpdateProjectPolicy(project *Project) bool {
	role := ""
	if project.Role != nil {
		role = *project.Role
	}
	return tenancy.EffectiveProjectPermissions(project.OrgRole, role).Has(tenancy.PermissionProjectUpdate)
}

func conflictWire(conflicts []resretention.PolicyConflict) []retentionConflict {
	out := make([]retentionConflict, 0, len(conflicts))
	for _, conflict := range conflicts {
		var scheduled *string
		if conflict.ScheduledPurgeAt != nil {
			value := wireTime(conflict.ScheduledPurgeAt.UTC())
			scheduled = &value
		}
		out = append(out, retentionConflict{
			ID: conflict.ID, Name: conflict.Name, Namespace: conflict.Namespace, Slug: conflict.Slug,
			QualifiedName: conflict.Namespace + "/" + conflict.Slug, Visibility: conflict.Visibility,
			DeletedAt: wireTime(conflict.DeletedAt), ScheduledPurgeAt: scheduled,
			ProposedScheduledPurgeAt: wireTime(conflict.ProposedScheduledPurgeAt),
			EligibleAtApply:          conflict.EligibleAtApply,
		})
	}
	return out
}

func retentionPolicyWire(policy resretention.Policy, canUpdate bool, conflicts []resretention.PolicyConflict) retentionPolicyResponse {
	return retentionPolicyResponse{
		PrivateRetentionDays: policy.PrivateRetentionDays,
		ProjectRetentionDays: policy.ProjectRetentionDays,
		Bounds:               retentionBoundsWire(),
		CanUpdate:            canUpdate,
		RequiresConfirmation: len(conflicts) > 0,
		Conflicts:            conflictWire(conflicts),
	}
}

func (h *Handler) resourceRetentionStore(w http.ResponseWriter) (*resretention.Store, bool) {
	db, ok := h.Store.DB.(resretention.DB)
	if !ok {
		httpapi.WriteError(w, http.StatusInternalServerError, "Resource retention store is not writable")
		return nil, false
	}
	return &resretention.Store{DB: db}, true
}

func (h *Handler) resourceRetentionPolicy(w http.ResponseWriter, r *http.Request) {
	project, ok := h.project(w, r)
	if !ok {
		return
	}
	store, ok := h.resourceRetentionStore(w)
	if !ok {
		return
	}
	policy, err := store.ReadPolicy(r.Context(), project.ID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, retentionPolicyWire(policy, canUpdateProjectPolicy(project), nil))
}

func (h *Handler) updateResourceRetentionPolicy(w http.ResponseWriter, r *http.Request) {
	project, org, userID, ok := h.projectForWrite(w, r, true)
	if !ok {
		return
	}
	store, ok := h.resourceRetentionStore(w)
	if !ok {
		return
	}
	current, err := store.ReadPolicy(r.Context(), project.ID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	var req retentionPolicyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		write422(w, []fieldError{{Type: "missing", Loc: []string{"body"}, Msg: "Field required", Input: nil}})
		return
	}
	policy := current
	if req.PrivateRetentionDays != nil {
		policy.PrivateRetentionDays = *req.PrivateRetentionDays
	}
	if req.ProjectRetentionDays != nil {
		policy.ProjectRetentionDays = *req.ProjectRetentionDays
	}
	if err := resretention.ValidatePolicy(policy.PrivateRetentionDays, policy.ProjectRetentionDays); err != nil {
		write422(w, []fieldError{{Type: "value_error", Loc: []string{"body"}, Msg: err.Error(), Input: req}})
		return
	}
	conflicts, err := store.PreviewPolicyChange(r.Context(), project.ID, policy, time.Now().UTC())
	if err != nil {
		writeErr(w, r, err)
		return
	}
	response := retentionPolicyWire(policy, true, conflicts)
	preview := r.URL.Query().Get("preview") == "true"
	if preview {
		httpapi.WriteJSON(w, http.StatusOK, response)
		return
	}
	if len(conflicts) > 0 && !confirmedConflictIDs(conflicts, req) {
		httpapi.WriteJSON(w, http.StatusConflict, response)
		return
	}
	if err := store.WritePolicy(r.Context(), project.ID, policy); err != nil {
		writeErr(w, r, err)
		return
	}
	h.emitOrgEvent(r.Context(), "org.project.retention.changed", userID, org,
		"Changed resource deletion retention policy for project '"+org.Slug+"/"+project.Slug+"'")
	response.Applied = true
	httpapi.WriteJSON(w, http.StatusOK, response)
}

func confirmedConflictIDs(conflicts []resretention.PolicyConflict, req retentionPolicyRequest) bool {
	if !req.Confirm || len(req.ConfirmedConflictIDs) != len(conflicts) {
		return false
	}
	confirmed := append([]string{}, req.ConfirmedConflictIDs...)
	slices.Sort(confirmed)
	ids := make([]string, 0, len(conflicts))
	for _, conflict := range conflicts {
		ids = append(ids, conflict.ID)
	}
	slices.Sort(ids)
	return slices.Equal(confirmed, ids)
}
