// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Run credential endpoint: mints one binding's provider credential for an authenticated workload launch.

package internal

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"

	sharederr "github.com/garudex-labs/caracal/packages/core/go/errors"
)

// RunCredentialResponse carries the injected credential for one binding.
type RunCredentialResponse struct {
	Env        string `json:"env"`
	Credential string `json:"credential"`
	ExpiresAt  int64  `json:"expires_at,omitempty"`
}

func workloadAuditMeta(workload *Workload) map[string]any {
	return map[string]any{
		"workload_id":   workload.ID,
		"workload_name": workload.Name,
	}
}

// handleRunCredential resolves a workload binding by env name and mints its provider
// credential. The request carries no authority: the resource, scopes, and provider all
// come from the console-authored binding, so a leaked secret can only replay the
// workload's own least-privilege profile. Every mint is policy-evaluated as a Workload
// principal and can be held for human approval exactly like an application exchange.
func (s *Server) handleRunCredential(w http.ResponseWriter, r *http.Request) {
	form, _, ok := readFormBody(w, r)
	if !ok {
		return
	}
	workloadID := strings.TrimSpace(form.Get("workload_id"))
	secret := form.Get("secret")
	env := strings.TrimSpace(form.Get("env"))
	challengeID := strings.TrimSpace(form.Get("challenge_id"))
	if workloadID == "" || secret == "" || env == "" {
		writeError(w, http.StatusBadRequest, sharederr.New(sharederr.InvalidToken, "workload_id, secret, and env are required"))
		return
	}

	requestID, ok := s.runRequestID(w, r)
	if !ok {
		return
	}
	launchID := launchIDFromHeader(r)

	ctx := r.Context()
	if rateErr := s.checkRateLimit(ctx, "run-credential", workloadID, "mint"); rateErr != nil {
		writeError(w, http.StatusTooManyRequests, rateErr)
		return
	}

	workload := s.requireRunAuth(w, r, requestID, launchID, workloadID, secret)
	if workload == nil {
		return
	}
	zoneID := workload.ZoneID
	meta := workloadAuditMeta(workload)
	if launchID != "" {
		meta["launch_id"] = launchID
	}

	now, timeErr := s.db.CurrentTime(ctx)
	if timeErr != nil {
		writeError(w, http.StatusServiceUnavailable, sharederr.New(sharederr.STSUnavailable, "trusted time unavailable"))
		return
	}

	bindings, bindErr := runBindings(workload)
	if bindErr != nil {
		s.log.Error().Err(bindErr).Str("workload_id", workload.ID).Msg("workload bindings are not valid JSON")
		writeError(w, http.StatusInternalServerError, sharederr.New(sharederr.Internal, "workload bindings are invalid"))
		return
	}
	var binding *RunBinding
	for i := range bindings {
		if bindings[i].Env == env {
			binding = &bindings[i]
			break
		}
	}
	if binding == nil {
		writeError(w, http.StatusNotFound, sharederr.New(sharederr.ResourceNotFound,
			"no credential binding for env "+env+"; define it for this workload on the Launcher page in the Caracal web console"))
		return
	}

	resource, dbErr := s.db.GetResourceByIdentifier(ctx, zoneID, binding.Resource)
	if dbErr != nil {
		if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "resource_not_found", &OPAResult{},
			mergeAuditMeta(meta, map[string]any{"resource": binding.Resource, "env": env})); auditErr != nil {
			writeError(w, http.StatusInternalServerError, auditErr)
			return
		}
		writeError(w, http.StatusNotFound, sharederr.New(sharederr.ResourceNotFound,
			"resource "+binding.Resource+" not found in the workload's zone"))
		return
	}
	resourceMeta := mergeAuditMeta(meta, map[string]any{"resource": resource.Identifier, "env": env})

	if resource.CredentialProviderID == nil {
		if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "credential_not_provisioned", &OPAResult{},
			mergeAuditMeta(resourceMeta, map[string]any{"reason": "no_provider"})); auditErr != nil {
			writeError(w, http.StatusInternalServerError, auditErr)
			return
		}
		writeError(w, http.StatusForbidden, sharederr.New(sharederr.AccessDenied,
			"resource "+resource.Identifier+" has no credential provider; attach one in the Caracal web console"))
		return
	}
	provider, perr := s.db.GetProvider(ctx, *resource.CredentialProviderID)
	if perr != nil {
		if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "provider_unavailable", &OPAResult{},
			mergeAuditMeta(resourceMeta, map[string]any{"reason": "provider_not_found"})); auditErr != nil {
			writeError(w, http.StatusInternalServerError, auditErr)
			return
		}
		writeError(w, http.StatusForbidden, sharederr.New(sharederr.AccessDenied, "credential provider unavailable"))
		return
	}
	providerCfg, cfgErr := providerDirectiveConfig(provider.ConfigJSON)
	if cfgErr != nil {
		if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "provider_unavailable", &OPAResult{},
			mergeAuditMeta(resourceMeta, map[string]any{"reason": "provider_config_invalid"})); auditErr != nil {
			writeError(w, http.StatusInternalServerError, auditErr)
			return
		}
		writeError(w, http.StatusForbidden, sharederr.New(sharederr.AccessDenied, "credential provider unavailable"))
		return
	}
	kind := derefStr(provider.ProviderKind)
	if !providerCfg.AllowRuntimeInjection || kind == "none" || kind == "caracal_mandate" || kind == "http_basic" {
		if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "credential_injection_denied", &OPAResult{},
			mergeAuditMeta(resourceMeta, map[string]any{"reason": "runtime_injection_not_allowed"})); auditErr != nil {
			writeError(w, http.StatusInternalServerError, auditErr)
			return
		}
		writeError(w, http.StatusForbidden, sharederr.New(sharederr.AccessDenied,
			"provider does not allow runtime credential injection for resource "+resource.Identifier))
		return
	}
	if providerRequiresUserGrant(provider) {
		if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "credential_not_provisioned", &OPAResult{},
			mergeAuditMeta(resourceMeta, map[string]any{"reason": "no_user_principal"})); auditErr != nil {
			writeError(w, http.StatusInternalServerError, auditErr)
			return
		}
		writeError(w, http.StatusForbidden, sharederr.New(sharederr.AccessDenied,
			"resource "+resource.Identifier+" uses a user-consent provider; workload launches have no user principal"))
		return
	}

	scopes := binding.Scopes
	boundResources := []string{resource.Identifier}

	challengeResolved := false
	var approval *StepUpChallengePG
	var approvalBundle ZoneBundleInfo
	if challengeID != "" {
		approvalBundle = s.opa.BundleInfo(zoneID)
		// Verify the presented approval against the binding without consuming it:
		// consumption happens after policy evaluation so a downstream deny never
		// burns a granted approval. The generic invalid answer covers lookup failure
		// and every binding mismatch alike.
		existing, lookupErr := s.db.GetStepUpChallenge(ctx, challengeID)
		if lookupErr != nil || existing.ChallengeType != humanApprovalChallengeType ||
			existing.ZoneID != zoneID || existing.PrincipalID != workload.ID ||
			existing.AuthorityRecordID != "" ||
			!bytes.Equal(existing.ResourceSetHash, hashApprovalBinding(boundResources, scopes, approvalBindingContext{
				PrincipalID: workload.ID,
				Bundle:      approvalBundle,
			})) {
			if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "approval_invalid", &OPAResult{}, resourceMeta); auditErr != nil {
				writeError(w, http.StatusInternalServerError, auditErr)
				return
			}
			writeError(w, http.StatusUnauthorized, sharederr.New(sharederr.AccessDenied, "approval not found or bindings do not match"))
			return
		}
		switch challengeLifecycleState(existing, now) {
		case ChallengeStateConsumed:
			if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "approval_already_consumed", &OPAResult{}, resourceMeta); auditErr != nil {
				writeError(w, http.StatusInternalServerError, auditErr)
				return
			}
			writeError(w, http.StatusConflict, sharederr.New(sharederr.ApprovalConsumed, "approval already used; another request consumed it"))
			return
		case ChallengeStateRejected:
			if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "approval_rejected", &OPAResult{},
				mergeAuditMeta(resourceMeta, stepUpAuditMeta(existing))); auditErr != nil {
				writeError(w, http.StatusInternalServerError, auditErr)
				return
			}
			writeError(w, http.StatusForbidden, sharederr.New(sharederr.AccessDenied, "approval was rejected"))
			return
		case ChallengeStateExpired:
			if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "approval_expired", &OPAResult{}, resourceMeta); auditErr != nil {
				writeError(w, http.StatusInternalServerError, auditErr)
				return
			}
			writeError(w, http.StatusUnauthorized, sharederr.New(sharederr.AccessDenied, "approval expired"))
			return
		case ChallengeStatePending:
			writeStepUp(w, requestID, challengeWire(existing, now))
			return
		default:
			approval = existing
			challengeResolved = true
		}
	}

	opaInput := OPAInput{
		SchemaVersion: opaInputSchemaVersion,
		Principal: OPAPrincipal{
			Type:   "Workload",
			ID:     workload.ID,
			ZoneID: zoneID,
		},
		Resource: OPAResource{
			Type:       "Resource",
			ID:         resource.ID,
			Identifier: resource.Identifier,
			Scopes:     resource.Scopes,
		},
		Action: OPAAction{ID: "CredentialInjection"},
		Context: OPAContext{
			ActorClaims:       map[string]any{"caracal_client_id": workload.ID},
			TraceID:           requestID,
			ChallengeResolved: challengeResolved,
			RequestedScopes:   scopes,
		},
	}

	result, evalErr := s.opa.Evaluate(ctx, opaInput)
	bundle := s.opa.BundleInfo(zoneID)
	if evalErr != nil {
		s.log.Error().Err(evalErr).Str("request_id", requestID).Str("zone_id", zoneID).Msg("policy evaluation failed")
		if auditErr := s.emitAuditEventWithBundle(requestID, zoneID, "deny", "policy_eval_failed", policyEvalFailure(evalErr), resourceMeta, bundle); auditErr != nil {
			writeError(w, http.StatusInternalServerError, auditErr)
			return
		}
		writeError(w, http.StatusServiceUnavailable, sharederr.New(sharederr.PolicyEvalFailed, "policy evaluation unavailable"))
		return
	}
	if auditErr := s.emitAuditEventWithBundle(requestID, zoneID, result.Decision, result.EvaluationStatus, result,
		mergeAuditMeta(resourceMeta, map[string]any{"requested_scopes": scopes}), bundle); auditErr != nil {
		writeError(w, http.StatusInternalServerError, auditErr)
		return
	}
	// Only an explicit "complete" status is treated as a usable decision; any other
	// value is a hard deny so an unknown state cannot silently grant access.
	if result.EvaluationStatus != "complete" {
		writeError(w, http.StatusForbidden, sharederr.New(sharederr.PolicyEvalFailed, "policy evaluation incomplete"))
		return
	}
	if challengeResolved && !sameApprovalPolicy(approvalBundle, result.Bundle) {
		if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "approval_policy_changed", &OPAResult{}, resourceMeta); auditErr != nil {
			writeError(w, http.StatusInternalServerError, auditErr)
			return
		}
		writeError(w, http.StatusConflict, sharederr.New(sharederr.AccessDenied, "approval policy changed during retry"))
		return
	}

	if !challengeResolved {
		if gateDecls := parseTierDeclarations(result); len(gateDecls) > 0 {
			// The gate is a hold, not a deny: issuance is idempotent per binding, and a
			// hold an approver has already granted releases the mint right here even
			// when the retry did not carry the challenge id. Workload holds bind to the
			// workload principal with no session.
			resolved, resolveErr := resolveApproval(gateDecls)
			if resolveErr != nil {
				if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "approval_class_conflict", &OPAResult{}, resourceMeta); auditErr != nil {
					writeError(w, http.StatusInternalServerError, auditErr)
					return
				}
				writeError(w, http.StatusForbidden, sharederr.New(sharederr.AccessDenied, resolveErr.Error()))
				return
			}
			hold, created, holdErr := s.ensureApproval(ctx, zoneID, "", "", "", workload.ID, "", "", resolved, result.Bundle, boundResources, scopes, nil)
			if holdErr != nil {
				writeError(w, http.StatusInternalServerError, sharederr.New(sharederr.Internal, "challenge creation failed"))
				return
			}
			approvalBundle = result.Bundle
			switch challengeLifecycleState(hold, now) {
			case ChallengeStateApproved:
				approval = hold
				challengeResolved = true
			case ChallengeStateRejected:
				if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "approval_rejected", &OPAResult{},
					mergeAuditMeta(resourceMeta, stepUpAuditMeta(hold))); auditErr != nil {
					writeError(w, http.StatusInternalServerError, auditErr)
					return
				}
				writeError(w, http.StatusForbidden, sharederr.New(sharederr.AccessDenied, "approval was rejected"))
				return
			default:
				if created {
					if auditErr := s.emitStepUpAudit(requestID, zoneID, "step_up_issued", "pending",
						mergeAuditMeta(resourceMeta, stepUpAuditMeta(hold))); auditErr != nil {
						writeError(w, http.StatusInternalServerError, auditErr)
						return
					}
				}
				writeStepUp(w, requestID, challengeWire(hold, now))
				return
			}
		}
	}

	if result.Decision != "allow" {
		if reason := denyDiagnosticReason(result); reason != "" {
			writeError(w, http.StatusForbidden, sharederr.New(sharederr.AccessDenied, "policy denied ("+reason+")"))
			return
		}
		writeError(w, http.StatusForbidden, sharederr.New(sharederr.AccessDenied, "policy denied"))
		return
	}

	directive, derr := s.buildUpstreamDirective(ctx, zoneID, nil, resource, true, true)
	if derr != nil || directive.ProviderToken == "" {
		reason := "provider token missing"
		if derr != nil {
			reason = derr.Error()
			s.log.Error().Err(derr).Str("zone_id", zoneID).Str("workload_id", workload.ID).Msg("run credential directive build failed")
		}
		if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "provider_credential_unavailable", &OPAResult{},
			mergeAuditMeta(resourceMeta, map[string]any{"reason": reason})); auditErr != nil {
			writeError(w, http.StatusInternalServerError, auditErr)
			return
		}
		writeError(w, http.StatusBadGateway, sharederr.New(sharederr.HTTPRequestFailed,
			"upstream credential for resource "+resource.Identifier+" is unavailable: "+reason))
		return
	}

	if approval != nil {
		if cerr := s.consumeApproval(ctx, zoneID, workload.ID, approval.ID, boundResources, scopes, approvalBindingContext{
			PrincipalID: workload.ID,
			Bundle:      approvalBundle,
		}); cerr != nil {
			if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "approval_already_consumed", &OPAResult{},
				mergeAuditMeta(resourceMeta, stepUpAuditMeta(approval))); auditErr != nil {
				writeError(w, http.StatusInternalServerError, auditErr)
				return
			}
			writeError(w, http.StatusConflict, sharederr.New(sharederr.ApprovalConsumed, "approval no longer valid; another request may have consumed it"))
			return
		}
		if auditErr := s.emitStepUpAudit(requestID, zoneID, "step_up_consumed", "consumed",
			mergeAuditMeta(resourceMeta, stepUpAuditMeta(approval))); auditErr != nil {
			writeError(w, http.StatusInternalServerError, auditErr)
			return
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(RunCredentialResponse{
		Env:        binding.Env,
		Credential: directive.ProviderToken,
		ExpiresAt:  directive.ExpiresAt,
	})
}
