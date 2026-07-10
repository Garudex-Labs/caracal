// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Token exchange handler: authenticates, evaluates policy per resource, issues JWT.

package internal

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	sharederr "github.com/garudex-labs/caracal/packages/core/go/errors"
	"github.com/garudex-labs/caracal/packages/core/go/secretstore"
	corests "github.com/garudex-labs/caracal/packages/core/go/sts"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

const (
	// ttlResourceMandate caps the lifetime of every resource-bound exchange. The gateway
	// re-exchanges on each request, so streams longer than this lifetime
	// (LLM completions, SSE, websockets) cannot rotate mid-stream. Callers
	// initiating long streams must treat ttlResourceMandate as the contract upper
	// bound: streams running past it should expect upstream-side disconnect
	// or a fresh exchange and reconnect orchestrated by the SDK.
	ttlResourceMandate        = 15 * time.Minute
	ttlAuthorityRecordMandate = 60 * time.Minute
	gatewayExchangeSkew       = 60 * time.Second
	controlInvokeTrait        = "control:invoke"
	controlScopeTrait         = "control:scope:"
	controlMaxTTLTrait        = "control:max-ttl:"
	controlExpiresTrait       = "control:expires:"
	defaultControlAudience    = "caracal-control"
	providerTokenCacheSkew    = 30 * time.Second
	maxDelegationHops         = 10
	tokenExchangeGrantType    = "urn:ietf:params:oauth:grant-type:token-exchange"
	accessTokenType           = "urn:ietf:params:oauth:token-type:access_token"
)

type delegationProof struct {
	edge        *DelegationEdge
	edges       []*DelegationEdge
	source      *Session
	target      *Session
	constraints delegationConstraints
	path        []string
	chain       []ChainHop
	graphEpoch  int64
}

type delegationConstraints struct {
	Resources   []string `json:"resources"`
	TTLSeconds  int      `json:"ttl_seconds"`
	MaxDepth    int      `json:"max_depth"`
	MaxHops     int      `json:"max_hops"`
	Budget      int      `json:"budget"`
	Approved    bool     `json:"policy_approved"`
	ExpiresAt   string   `json:"expires_at"`
	BroadReason string   `json:"broad_reason"`
}

func (s *Server) handleTokenExchange(w http.ResponseWriter, r *http.Request) {
	requestID := r.Header.Get("X-Request-Id")
	if requestID == "" {
		if id, err := uuid.NewV7(); err == nil {
			requestID = id.String()
		} else {
			requestID = uuid.NewString()
		}
	}
	if requestID != "" {
		w.Header().Set("X-Request-Id", requestID)
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)
	if err := r.ParseForm(); err != nil {
		writeError(w, http.StatusBadRequest, sharederr.New(sharederr.InvalidToken, "malformed request body"))
		return
	}
	// RFC 8693 actor tokens are not part of the exchange contract: the acting
	// application authenticates with its own client credentials and rides the
	// policy input as caracal_client_id.
	if r.FormValue("actor_token") != "" {
		writeError(w, http.StatusBadRequest, sharederr.New(sharederr.InvalidToken, "actor_token is not supported: authenticate the acting application with its own client credentials"))
		return
	}
	ttlSeconds := 0
	if rawTTL := r.FormValue("ttl_seconds"); rawTTL != "" {
		parsedTTL, err := strconv.Atoi(rawTTL)
		if err != nil {
			writeError(w, http.StatusBadRequest, sharederr.New(sharederr.InvalidToken, "invalid ttl_seconds"))
			return
		}
		ttlSeconds = parsedTTL
	}

	gatewayAuthenticated, gatewayErr := s.verifyGatewayExchange(r, requestID)
	if gatewayErr != nil {
		writeError(w, http.StatusUnauthorized, sharederr.New(sharederr.AccessDenied, "invalid gateway exchange signature"))
		return
	}

	req := TokenExchangeRequest{
		GrantType:            r.FormValue("grant_type"),
		SubjectToken:         r.FormValue("subject_token"),
		SubjectTokenType:     r.FormValue("subject_token_type"),
		Resources:            r.Form["resource"],
		Scope:                r.FormValue("scope"),
		ZoneID:               r.FormValue("zone_id"),
		ApplicationID:        r.FormValue("application_id"),
		ClientSecret:         r.FormValue("client_secret"),
		ClientAssertion:      r.FormValue("client_assertion"),
		ClientAssertionType:  r.FormValue("client_assertion_type"),
		ChallengeID:          r.FormValue("challenge_id"),
		AuthorityRecordID:    r.FormValue("session_id"),
		SessionID:            r.FormValue("agent_session_id"),
		DelegationEdgeID:     r.FormValue("delegation_edge_id"),
		RequestMethod:        r.FormValue("request_method"),
		RequestPath:          r.FormValue("request_path"),
		TTLSeconds:           ttlSeconds,
		GatewayAuthenticated: gatewayAuthenticated,
	}
	if req.GrantType != tokenExchangeGrantType {
		writeError(w, http.StatusBadRequest, sharederr.New(sharederr.InvalidToken, "unsupported grant_type"))
		return
	}
	if req.SubjectTokenType != "" && req.SubjectTokenType != accessTokenType && req.SubjectTokenType != SubjectTokenTypeIDToken {
		writeError(w, http.StatusBadRequest, sharederr.New(sharederr.InvalidToken, "unsupported subject_token_type"))
		return
	}
	if req.SubjectToken != "" && req.SubjectTokenType == "" {
		writeError(w, http.StatusBadRequest, sharederr.New(sharederr.InvalidToken, "subject_token_type is required with subject_token"))
		return
	}
	if req.SubjectToken == "" && req.SubjectTokenType != "" {
		writeError(w, http.StatusBadRequest, sharederr.New(sharederr.InvalidToken, "subject_token is required with subject_token_type"))
		return
	}
	if !req.GatewayAuthenticated {
		if rateErr := s.checkAuthenticationRateLimit(r.Context(), strings.TrimSpace(req.ApplicationID)); rateErr != nil {
			writeError(w, http.StatusTooManyRequests, rateErr)
			return
		}
	}

	resp, challenge, code, apiErr := s.exchange(r.Context(), req, requestID)
	if !req.GatewayAuthenticated && code == http.StatusUnauthorized && apiErr != nil && apiErr.Description == "invalid client credentials" {
		if rateErr := s.recordAuthenticationFailure(r.Context(), strings.TrimSpace(req.ApplicationID)); rateErr != nil {
			writeError(w, http.StatusTooManyRequests, rateErr)
			return
		}
	}
	if apiErr != nil {
		writeError(w, code, apiErr)
		return
	}
	if challenge != nil {
		writeStepUp(w, requestID, challenge)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		s.log.Warn().Err(err).Str("request_id", requestID).Msg("failed to encode token response")
	}
}

func (s *Server) verifyGatewayExchange(r *http.Request, requestID string) (bool, error) {
	timestamp := r.Header.Get(corests.GatewayTimestampHeader)
	signature := r.Header.Get(corests.GatewaySignatureHeader)
	gatewayRequestID := r.Header.Get(corests.GatewayRequestHeader)
	if timestamp == "" && signature == "" && gatewayRequestID == "" {
		return false, nil
	}
	if r.FormValue("gateway_request_id") != requestID {
		return false, fmt.Errorf("gateway correlation id mismatch")
	}
	if err := corests.VerifyGatewayExchange(s.cfg.GatewayHMACKey, time.Now().UTC(), gatewayExchangeSkew, timestamp, gatewayRequestID, signature, r.Method, r.URL.EscapedPath(), []byte(r.PostForm.Encode())); err != nil {
		return false, err
	}
	if err := s.consumeGatewayNonce(r.Context(), gatewayRequestID); err != nil {
		return false, err
	}
	return true, nil
}

// gatewayActionInput surfaces the upstream operation (HTTP method and path) the
// gateway is authorizing so a policy can gate authority per operation rather than
// only per resource view. The operation is trusted only for gateway-authenticated
// exchanges: the gateway HMAC-signs the request body, so a direct caller cannot
// forge these fields to steer an operation-gating policy. A non-gateway exchange
// carries no upstream operation, leaving the fields empty so operation rules
// fall through to default-deny.
func gatewayActionInput(req TokenExchangeRequest) OPAAction {
	action := OPAAction{ID: "TokenExchange"}
	if req.GatewayAuthenticated {
		action.Method = strings.ToUpper(strings.TrimSpace(req.RequestMethod))
		action.Path = strings.TrimSpace(req.RequestPath)
	}
	return action
}

// mandateScopeSet is the authority a presented mandate carries, parsed from the
// space-delimited scope claim of the subject token. Empty when no mandate or no
// scope claim is present, which fails operation authority closed.
func mandateScopeSet(subjectClaims map[string]any) map[string]struct{} {
	scopes := map[string]struct{}{}
	for _, scope := range strings.Fields(claimString(subjectClaims, "scope")) {
		scopes[scope] = struct{}{}
	}
	return scopes
}

// mintScope is the scope claim the issued mandate carries. An exchange that requests
// scopes explicitly mints exactly those. A Gateway re-exchange requests none, since its
// authority rides in the presented mandate, so the issued upstream mandate inherits the
// presented mandate's scope claim. That makes the upstream mandate self-describing: the
// resource verifies the authority it carries directly, never inferring scope from
// out-of-band partnership terms.
func mintScope(req TokenExchangeRequest, subjectClaims map[string]any) string {
	if req.Scope != "" {
		return req.Scope
	}
	if req.GatewayAuthenticated {
		return claimString(subjectClaims, "scope")
	}
	return req.Scope
}

// authorizeOperation is the native operation-authority floor the Gateway relies on.
// For a resource in enforced mode, the upstream operation (method and path) must be
// declared on the resource and the presented mandate must carry that operation's
// scope; an undeclared operation is denied. The floor is unconditional: adopter
// policy can narrow authority further but can never relax this baseline. A
// transport_uniform resource declares no per-operation map, so its mandate's
// mint-time scope is the only boundary and the floor does not apply.
func authorizeOperation(resource *Resource, method, path string, mandate map[string]struct{}) *sharederr.CaracalError {
	if resource.OperationEnforcement != OperationEnforcementEnforced {
		return nil
	}
	method = strings.ToUpper(strings.TrimSpace(method))
	path = strings.TrimSpace(path)
	for _, op := range resource.Operations {
		if strings.ToUpper(strings.TrimSpace(op.Method)) != method || strings.TrimSpace(op.Path) != path {
			continue
		}
		if _, held := mandate[op.Scope]; !held {
			return sharederr.New(sharederr.OperationNotPermitted, fmt.Sprintf(
				"operation %s %s on resource %s requires scope %s, which the presented mandate does not carry",
				method, path, resource.Identifier, op.Scope))
		}
		return nil
	}
	return sharederr.New(sharederr.OperationNotPermitted, fmt.Sprintf(
		"operation %s %s is not declared on resource %s; declare it on the resource or set operation_enforcement to transport_uniform",
		method, path, resource.Identifier))
}

func (s *Server) exchange(ctx context.Context, req TokenExchangeRequest, requestID string) (*TokenResponse, *challengeState, int, *sharederr.CaracalError) {
	app, zoneID, err := s.authenticateApp(ctx, req)
	if err != nil {
		var zoneErr *zoneMismatchError
		if errors.As(err, &zoneErr) {
			return nil, nil, http.StatusForbidden, sharederr.New(
				sharederr.ZoneInvalid,
				fmt.Sprintf("application is registered in zone %s but the request targeted zone %s; use credentials issued for the targeted zone or correct the zone_id", zoneErr.actual, zoneErr.requested),
			)
		}
		return nil, nil, http.StatusUnauthorized, sharederr.New(sharederr.AccessDenied, "invalid client credentials")
	}

	// Subject federation is a distinct exchange class: the authenticated application
	// presents its end user's external identity token and receives a user subject
	// session, minting no resource authority. It is dispatched before the resource
	// requirement because it names no resources by design.
	if req.SubjectTokenType == SubjectTokenTypeIDToken {
		return s.federateSubject(ctx, req, app, zoneID, requestID)
	}

	if len(req.Resources) == 0 {
		return nil, nil, http.StatusBadRequest, sharederr.New(sharederr.InvalidToken, "at least one resource is required")
	}
	appMeta := applicationAuditMeta(app)
	exchangeNow, timeErr := s.db.CurrentTime(ctx)
	if timeErr != nil {
		return nil, nil, http.StatusServiceUnavailable, sharederr.New(sharederr.STSUnavailable, "trusted time unavailable")
	}

	var subjectClaims map[string]any
	if req.SubjectToken != "" {
		if req.GatewayAuthenticated {
			subjectClaims, err = s.validateGatewaySubjectToken(ctx, req.SubjectToken, zoneID)
		} else {
			subjectClaims, err = s.validateSubjectToken(ctx, req.SubjectToken, zoneID)
		}
		if err != nil {
			return nil, nil, http.StatusUnauthorized, sharederr.New(sharederr.InvalidToken, "invalid subject_token")
		}
		sid, serr := s.validateAuthorityRecord(ctx, zoneID, app.ID, req.AuthorityRecordID, subjectClaims)
		if serr != nil {
			return nil, nil, http.StatusForbidden, serr
		}
		if req.AuthorityRecordID == "" {
			req.AuthorityRecordID = sid
		}
		if aerr := bindGovernedSession(&req, subjectClaims); aerr != nil {
			return nil, nil, http.StatusForbidden, aerr
		}
		if aerr := bindDelegationEdge(&req, subjectClaims); aerr != nil {
			return nil, nil, http.StatusForbidden, aerr
		}
	}

	// The authenticated calling application rides the policy input on
	// actor_claims.caracal_client_id, keeping "who is acting" evaluable
	// without a separate actor credential.
	actorClaims := map[string]any{"caracal_client_id": app.ID}

	principalID := app.ID
	if sub := claimString(subjectClaims, "sub"); sub != "" {
		principalID = sub
	}

	challengeResolved := false
	var approval *StepUpChallengePG
	if req.ChallengeID != "" {
		// Verify the presented approval against every binding without consuming it:
		// consumption happens after the policy loop, immediately before the session is
		// created, so a downstream deny never burns a granted approval. The generic
		// invalid answer covers lookup failure and every binding mismatch alike, so a
		// probe cannot distinguish another zone's challenge from a wrong scope set.
		existing, lookupErr := s.db.GetStepUpChallenge(ctx, req.ChallengeID)
		if lookupErr != nil || existing.ChallengeType != humanApprovalChallengeType ||
			existing.ZoneID != zoneID || existing.PrincipalID != principalID ||
			existing.AuthorityRecordID != req.AuthorityRecordID ||
			!bytes.Equal(existing.ResourceSetHash, hashApprovalBinding(req.Resources, strings.Fields(req.Scope))) {
			if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "approval_invalid", &OPAResult{}, appMeta); auditErr != nil {
				return nil, nil, http.StatusInternalServerError, auditErr
			}
			return nil, nil, http.StatusUnauthorized, sharederr.New(sharederr.AccessDenied, "approval not found or bindings do not match")
		}
		switch challengeLifecycleState(existing, exchangeNow) {
		case ChallengeStateConsumed:
			if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "approval_already_consumed", &OPAResult{}, appMeta); auditErr != nil {
				return nil, nil, http.StatusInternalServerError, auditErr
			}
			return nil, nil, http.StatusConflict, sharederr.New(sharederr.ApprovalConsumed, "approval already used; another request consumed it")
		case ChallengeStateRejected:
			if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "approval_rejected", &OPAResult{},
				mergeAuditMeta(appMeta, stepUpAuditMeta(existing))); auditErr != nil {
				return nil, nil, http.StatusInternalServerError, auditErr
			}
			return nil, nil, http.StatusForbidden, sharederr.New(sharederr.AccessDenied, "approval was rejected")
		case ChallengeStateExpired:
			if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "approval_expired", &OPAResult{}, appMeta); auditErr != nil {
				return nil, nil, http.StatusInternalServerError, auditErr
			}
			return nil, nil, http.StatusUnauthorized, sharederr.New(sharederr.AccessDenied, "approval expired")
		case ChallengeStatePending:
			// Still pending: re-surface the same challenge so a premature retry waits
			// on the approver rather than failing.
			return nil, challengeWire(existing, exchangeNow), http.StatusUnauthorized, nil
		default:
			approval = existing
			challengeResolved = true
		}
	}
	delegation, session, refErr := s.validateSessionReferences(ctx, zoneID, app.ID, req, subjectClaims != nil)
	if refErr != nil {
		return nil, nil, http.StatusForbidden, refErr
	}

	delegationMeta := delegationAuditMeta(delegation)

	scopes := distinctScopes(req.Scope)
	req.Scope = strings.Join(scopes, " ")
	action := gatewayActionInput(req)
	mandate := mandateScopeSet(subjectClaims)
	var grantedResources []string
	// Tracks the last user-consent credential failure so a fully denied exchange can
	// answer with the operational reason instead of a generic policy verdict.
	var providerDenial *sharederr.CaracalError
	grantedDirectives := map[string]UpstreamDirective{}
	grantedResourceRows := map[string]*Resource{}
	var gateDecls []tierDeclaration
	controlKeyExchange := false

	for _, identifier := range req.Resources {
		resource, dbErr := s.db.GetResourceByIdentifier(ctx, zoneID, identifier)
		if dbErr != nil {
			if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "resource_not_found", &OPAResult{},
				mergeAuditMeta(appMeta, map[string]any{"resource": identifier})); auditErr != nil {
				return nil, nil, http.StatusInternalServerError, auditErr
			}
			continue
		}
		if !scopesAllowed(scopes, resourceMintScopes(resource)) {
			if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "scope_mismatch", &OPAResult{},
				mergeAuditMeta(appMeta, map[string]any{"resource": resource.Identifier})); auditErr != nil {
				return nil, nil, http.StatusInternalServerError, auditErr
			}
			continue
		}
		if delegation != nil && !delegationAllowsResource(delegation, resource) {
			if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "resource_outside_delegation", &OPAResult{},
				mergeAuditMeta(mergeAuditMeta(appMeta, map[string]any{"resource": resource.Identifier}), delegationMeta)); auditErr != nil {
				return nil, nil, http.StatusInternalServerError, auditErr
			}
			continue
		}

		// Native operation-authority floor. A Gateway-authenticated exchange carries
		// the trusted upstream operation; an enforced resource denies any operation it
		// has not declared, before any provider or policy work, with an actionable
		// error so the gap can never pass silently.
		if req.GatewayAuthenticated {
			if opErr := authorizeOperation(resource, action.Method, action.Path, mandate); opErr != nil {
				if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "operation_not_permitted", &OPAResult{},
					mergeAuditMeta(appMeta, map[string]any{"resource": resource.Identifier, "method": action.Method, "path": action.Path})); auditErr != nil {
					return nil, nil, http.StatusInternalServerError, auditErr
				}
				return nil, nil, http.StatusForbidden, opErr
			}
		}

		if rateErr := s.checkRateLimit(ctx, zoneID, resource.ID, app.ID); rateErr != nil {
			if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "rate_limited", &OPAResult{},
				mergeAuditMeta(appMeta, map[string]any{"resource": resource.Identifier})); auditErr != nil {
				return nil, nil, http.StatusInternalServerError, auditErr
			}
			continue
		}

		if isControlKeyExchange(app, req, resource, scopes, exchangeNow) {
			result := &OPAResult{
				Decision:            "allow",
				DeterminingPolicies: []map[string]any{{"policy": "control-key"}},
				EvaluationStatus:    "complete",
				Diagnostics:         []map[string]any{},
			}
			if auditErr := s.emitAuditEvent(requestID, zoneID, result.Decision, result.EvaluationStatus, result,
				mergeAuditMeta(appMeta, map[string]any{"resource": resource.Identifier})); auditErr != nil {
				return nil, nil, http.StatusInternalServerError, auditErr
			}
			grantedResources = append(grantedResources, resource.Identifier)
			grantedResourceRows[resource.Identifier] = resource
			controlKeyExchange = true
			continue
		}

		// The control resource is mintable only through the control-key contract above.
		// Any other route to it - a delegated grant on the control resource, a session
		// exchange, a scope outside the key's traits - would mint a control-audience
		// token free of the control-key restrictions, so it is denied categorically.
		if resource.Identifier == controlAudience() {
			if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "control_resource_requires_control_key", &OPAResult{},
				mergeAuditMeta(appMeta, map[string]any{"resource": resource.Identifier})); auditErr != nil {
				return nil, nil, http.StatusInternalServerError, auditErr
			}
			return nil, nil, http.StatusForbidden, sharederr.New(sharederr.AccessDenied,
				"the control resource is mintable only by a control key exchanging its own client credentials for control scopes")
		}

		providerCredentialAccess := req.GatewayAuthenticated
		if providerCredentialAccess && resource.CredentialProviderID != nil {
			provider, perr := s.db.GetProvider(ctx, *resource.CredentialProviderID)
			if perr != nil {
				if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "provider_unavailable", &OPAResult{},
					mergeAuditMeta(appMeta, map[string]any{"resource": resource.Identifier, "reason": "provider_not_found"})); auditErr != nil {
					return nil, nil, http.StatusInternalServerError, auditErr
				}
				continue
			}
			if providerRequiresUserGrant(provider) {
				userID, _ := subjectClaims["sub"].(string)
				if userID == "" {
					if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "credential_not_provisioned", &OPAResult{},
						mergeAuditMeta(appMeta, map[string]any{"resource": resource.Identifier, "reason": "no_user_principal"})); auditErr != nil {
						return nil, nil, http.StatusInternalServerError, auditErr
					}
					providerDenial = sharederr.New(sharederr.AccessDenied,
						"resource "+resource.Identifier+" uses a user-consent provider and this call carries no subject")
					continue
				}
				if rerr := s.tryRefreshProviderConnection(ctx, zoneID, userID, resource.CredentialProviderID); rerr != nil {
					if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "credential_refresh_failed", &OPAResult{},
						mergeAuditMeta(appMeta, map[string]any{"resource": resource.Identifier, "reason": string(rerr.Code)})); auditErr != nil {
						return nil, nil, http.StatusInternalServerError, auditErr
					}
					providerDenial = sharederr.New(rerr.Code,
						"provider connection for resource "+resource.Identifier+" is expired and could not be refreshed; reconnect the subject from the provider's Connections panel")
					continue
				}
				connection, gerr := s.db.GetProviderConnection(ctx, zoneID, userID, resource.CredentialProviderID)
				if gerr != nil || connection == nil || len(connection.AccessTokenCt) == 0 {
					if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "credential_not_provisioned", &OPAResult{},
						mergeAuditMeta(appMeta, map[string]any{"resource": resource.Identifier, "reason": "no_provider_connection"})); auditErr != nil {
						return nil, nil, http.StatusInternalServerError, auditErr
					}
					providerDenial = sharederr.New(sharederr.AccessDenied,
						"no provider connection for subject "+userID+" on resource "+resource.Identifier+"; connect the subject from the provider's Connections panel")
					continue
				}
			}
		}

		opaInput := OPAInput{
			SchemaVersion: opaInputSchemaVersion,
			Principal: OPAPrincipal{
				Type:               "Application",
				ID:                 app.ID,
				ZoneID:             zoneID,
				RegistrationMethod: app.RegistrationMethod,
				SessionID:          req.SessionID,
				Lifecycle:          sessionLifecycle(session),
				Labels:             sessionLabels(session),
			},
			Resource: OPAResource{
				Type:       "Resource",
				ID:         resource.ID,
				Identifier: resource.Identifier,
				Scopes:     resource.Scopes,
			},
			Action:          action,
			AuthorityRecord: sessionInput(req.AuthorityRecordID),
			DelegationEdge:  delegationEdgeInput(delegation),
			Context: OPAContext{
				ActorClaims:       actorClaims,
				SubjectClaims:     subjectClaims,
				TraceID:           requestID,
				AuthorityRecordID: req.AuthorityRecordID,
				SessionID:         req.SessionID,
				DelegationEdgeID:  req.DelegationEdgeID,
				ChallengeResolved: challengeResolved,
				RequestedScopes:   scopes,
			},
		}

		result, evalErr := s.opa.Evaluate(ctx, opaInput)
		bundle := s.opa.BundleInfo(zoneID)
		if evalErr != nil {
			if auditErr := s.emitAuditEventWithBundle(requestID, zoneID, "deny", "policy_eval_failed", &OPAResult{},
				mergeAuditMeta(appMeta, map[string]any{"resource": resource.Identifier}), bundle); auditErr != nil {
				return nil, nil, http.StatusInternalServerError, auditErr
			}
			return nil, nil, http.StatusServiceUnavailable, sharederr.New(sharederr.PolicyEvalFailed, "policy evaluation unavailable")
		}

		if auditErr := s.emitAuditEventWithBundle(requestID, zoneID, result.Decision, result.EvaluationStatus, result,
			mergeAuditMeta(mergeAuditMeta(mergeAuditMeta(appMeta, map[string]any{
				"resource":           resource.Identifier,
				"requested_scopes":   scopes,
				"session_id":         req.AuthorityRecordID,
				"agent_session_id":   req.SessionID,
				"delegation_edge_id": req.DelegationEdgeID,
			}), agentAuditMeta(session)), delegationMeta), bundle); auditErr != nil {
			return nil, nil, http.StatusInternalServerError, auditErr
		}

		// Only an explicit "complete" status is treated as a usable decision; any
		// other value (partial, error, future enum) is a hard deny so an unknown
		// state cannot silently grant access.
		if result.EvaluationStatus != "complete" {
			return nil, nil, http.StatusForbidden, sharederr.New(sharederr.PolicyEvalFailed, "policy evaluation incomplete")
		}

		if !challengeResolved {
			gateDecls = append(gateDecls, parseTierDeclarations(result)...)
		}

		if result.Decision == "allow" {
			grantedResources = append(grantedResources, resource.Identifier)
			grantedResourceRows[resource.Identifier] = resource
		}
	}

	if !challengeResolved && len(gateDecls) > 0 {
		// The gate is a hold, not a deny: the decision was allow, so the mint waits on
		// an approval bound to this exact request. Issuance is idempotent per binding,
		// and a hold an approver has already granted releases the mint right here even
		// when the retry did not carry the challenge id.
		hold, created, holdErr := s.ensureApproval(ctx, zoneID, req.AuthorityRecordID, req.SessionID, req.DelegationEdgeID, principalID, app.ID, resolveApproval(gateDecls), req.Resources, scopes)
		if holdErr != nil {
			return nil, nil, http.StatusInternalServerError, sharederr.New(sharederr.Internal, "challenge creation failed")
		}
		switch challengeLifecycleState(hold, exchangeNow) {
		case ChallengeStateApproved:
			approval = hold
			challengeResolved = true
		case ChallengeStateRejected:
			if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "approval_rejected", &OPAResult{},
				mergeAuditMeta(appMeta, stepUpAuditMeta(hold))); auditErr != nil {
				return nil, nil, http.StatusInternalServerError, auditErr
			}
			return nil, nil, http.StatusForbidden, sharederr.New(sharederr.AccessDenied, "approval was rejected")
		default:
			if created {
				if auditErr := s.emitStepUpAudit(requestID, zoneID, "step_up_issued", "pending",
					mergeAuditMeta(appMeta, stepUpAuditMeta(hold))); auditErr != nil {
					return nil, nil, http.StatusInternalServerError, auditErr
				}
			}
			return nil, challengeWire(hold, exchangeNow), http.StatusUnauthorized, nil
		}
	}

	if len(grantedResources) == 0 {
		if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "exchange_denied", &OPAResult{},
			mergeAuditMeta(appMeta, map[string]any{"requested": req.Resources})); auditErr != nil {
			return nil, nil, http.StatusInternalServerError, auditErr
		}
		// A missing or dead user-consent credential is an operational condition, not a
		// policy verdict; surfacing the precise reason lets the caller fix the connection
		// instead of debugging policy.
		if providerDenial != nil {
			return nil, nil, http.StatusForbidden, providerDenial
		}
		return nil, nil, http.StatusForbidden, sharederr.New(sharederr.AccessDenied, "policy denied")
	}

	if req.SubjectToken != "" && !req.GatewayAuthenticated {
		return nil, nil, http.StatusForbidden, sharederr.New(sharederr.AccessDenied, "resource exchanges must use the Gateway")
	}

	sid, err := uuid.NewV7()
	if err != nil {
		return nil, nil, http.StatusInternalServerError, sharederr.New(sharederr.Internal, "generate authority record id")
	}
	sessID := sid.String()
	now := exchangeNow
	ttl, ttlErr := tokenTTL(req.TTLSeconds, req.SubjectToken == "")
	if ttlErr != nil {
		return nil, nil, http.StatusBadRequest, sharederr.New(sharederr.InvalidToken, ttlErr.Error())
	}
	if ttl, ttlErr = effectiveTokenTTL(ttl, delegation, now); ttlErr != nil {
		return nil, nil, http.StatusForbidden, sharederr.New(sharederr.AccessDenied, ttlErr.Error())
	}
	// A Control key's max-ttl trait caps the issued token lifetime rather than
	// disqualifying the exchange, matching the documented contract.
	if controlKeyExchange {
		if maxTTL := controlMaxTTL(app); maxTTL > 0 {
			if capTTL := time.Duration(maxTTL) * time.Second; ttl > capTTL {
				ttl = capTTL
			}
		}
	}
	subjectID := app.ID
	sessionType := "application"
	if sub := claimString(subjectClaims, "sub"); sub != "" {
		subjectID = sub
		// The subject class propagates from the presented token: a chain descending
		// from a federated user subject stays user-typed, while an application chain
		// re-exchanged through the Gateway stays application-typed. The presence of a
		// subject token alone proves nothing about the subject being a person.
		if claimString(subjectClaims, "sub_type") == SubTypeUser {
			sessionType = "user"
		}
	}

	subType := SubTypeApplication
	if sessionType == "user" {
		subType = SubTypeUser
	}
	// Gateway exchanges mint resource mandates. A direct delegated mint creates
	// a one-shot Gateway-ingress mandate. Bootstrap exchanges remain reusable
	// lifecycle session mandates for Coordinator operations.
	use := UseResource
	if req.SubjectToken == "" && !controlKeyExchange {
		if req.SessionID != "" && req.DelegationEdgeID != "" {
			use = UseGateway
		} else {
			use = UseSession
		}
	}

	record := &AuthorityRecord{
		ID:              sessID,
		ZoneID:          zoneID,
		SessionType:     sessionType,
		SubjectID:       &subjectID,
		ParentID:        parentAuthorityRecordID(req.AuthorityRecordID, use),
		Status:          "active",
		ExpiresAt:       now.Add(ttl),
		AuthenticatedAt: now,
	}

	mintedScope := mintScope(req, subjectClaims)
	issueParams := IssueParams{
		ZoneID:                zoneID,
		AppID:                 app.ID,
		SubjectID:             subjectID,
		SubType:               subType,
		Use:                   use,
		AuthorityRecordID:     sessID,
		RootAuthorityRecordID: rootAuthorityRecordID(subjectClaims, sessID, use),
		Scopes:                mintedScope,
		Resources:             grantedResources,
		TTL:                   ttl,
		SessionID:             req.SessionID,
		IssuedAt:              now,
	}
	if req.DelegationEdgeID != "" {
		issueParams.DelegationEdgeID = req.DelegationEdgeID
		issueParams.SourceSessionID = delegation.edge.SourceSessionID
		issueParams.TargetSessionID = delegation.edge.TargetSessionID
		issueParams.DelegationPath = delegation.path
		issueParams.DelegationChain = delegation.chain
		issueParams.GraphEpoch = delegation.graphEpoch
	}
	token, jti, err := issueToken(ctx, issueParams, s.keys, s.cfg.IssuerURL)
	if err != nil {
		s.log.Error().Err(err).Str("zone_id", zoneID).Str("request_id", requestID).Msg("token issuance failed")
		return nil, nil, http.StatusInternalServerError, sharederr.New(sharederr.Internal, "token issuance failed")
	}
	if err := s.recordIssuedJTI(ctx, jti, app.ID, zoneID, requestID, ttl); err != nil {
		return nil, nil, http.StatusInternalServerError, sharederr.New(sharederr.Internal, "token issuance failed")
	}

	if req.GatewayAuthenticated {
		for _, identifier := range grantedResources {
			directive, err := s.buildUpstreamDirective(ctx, zoneID, subjectClaims, grantedResourceRows[identifier], req.GatewayAuthenticated, false)
			if err != nil {
				// The mint already passed policy; a failure here is the upstream credential
				// plumbing (IdP outage, rejected client, circuit open), so the caller gets
				// the operational reason and the audit trail records the denial.
				if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "provider_credential_unavailable", &OPAResult{},
					mergeAuditMeta(appMeta, map[string]any{"resource": identifier, "reason": err.Error()})); auditErr != nil {
					return nil, nil, http.StatusInternalServerError, auditErr
				}
				return nil, nil, http.StatusBadGateway, sharederr.New(sharederr.HTTPRequestFailed,
					"upstream credential for resource "+identifier+" is unavailable: "+err.Error())
			}
			grantedDirectives[identifier] = directive
		}
	}

	if delegation != nil {
		var approvalParams *ConsumeApprovalParams
		if approval != nil {
			approvalParams = &ConsumeApprovalParams{
				ID: approval.ID, ZoneID: zoneID, PrincipalID: principalID,
				ResourceSetHash: hashApprovalBinding(req.Resources, scopes), Now: now,
			}
		}
		err := s.db.InsertDelegatedAuthorityRecord(ctx, record, delegationIssuanceProof(delegation), approvalParams)
		if err != nil {
			if errors.Is(err, ErrChallengeInvalid) {
				return nil, nil, http.StatusConflict, sharederr.New(sharederr.ApprovalConsumed, "approval no longer valid; another request may have consumed it")
			}
			if errors.Is(err, ErrDelegationChanged) {
				return nil, nil, http.StatusConflict, sharederr.New(sharederr.AccessDenied, "delegation changed during issuance")
			}
			return nil, nil, http.StatusInternalServerError, sharederr.New(sharederr.Internal, "authority record creation failed")
		}
	} else if approval == nil {
		if err := s.db.InsertAuthorityRecord(ctx, record); err != nil {
			return nil, nil, http.StatusInternalServerError, sharederr.New(sharederr.Internal, "authority record creation failed")
		}
	} else {
		err := s.db.InsertAuthorityRecordWithApproval(ctx, record, ConsumeApprovalParams{
			ID:              approval.ID,
			ZoneID:          zoneID,
			PrincipalID:     principalID,
			ResourceSetHash: hashApprovalBinding(req.Resources, scopes),
			Now:             now,
		})
		if err != nil {
			if errors.Is(err, ErrChallengeInvalid) {
				if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "approval_already_consumed", &OPAResult{},
					mergeAuditMeta(appMeta, stepUpAuditMeta(approval))); auditErr != nil {
					return nil, nil, http.StatusInternalServerError, auditErr
				}
				return nil, nil, http.StatusConflict, sharederr.New(sharederr.ApprovalConsumed, "approval no longer valid; another request may have consumed it")
			}
			return nil, nil, http.StatusInternalServerError, sharederr.New(sharederr.Internal, "authority record creation failed")
		}
		if auditErr := s.emitStepUpAudit(requestID, zoneID, "step_up_consumed", "consumed",
			mergeAuditMeta(appMeta, stepUpAuditMeta(approval))); auditErr != nil {
			return nil, nil, http.StatusInternalServerError, auditErr
		}
	}

	return &TokenResponse{
		AccessToken:     token,
		TokenType:       "Bearer",
		ExpiresIn:       int(ttl.Seconds()),
		Scope:           mintedScope,
		IssuedTokenType: "urn:ietf:params:oauth:token-type:access_token",
		TargetResources: grantedResources,
		Upstreams:       grantedDirectives,
	}, nil, http.StatusOK, nil
}

func (s *Server) buildUpstreamDirective(ctx context.Context, zoneID string, subjectClaims map[string]any, resource *Resource, providerCredentialAccess bool, runtimeCredentialInjection bool) (UpstreamDirective, error) {
	directive := UpstreamDirective{
		AuthMode:   UpstreamAuthCaracalJWT,
		AuthHeader: "Authorization",
		AuthScheme: "Bearer",
	}
	if resource.UpstreamURL != nil {
		directive.URL = *resource.UpstreamURL
	}
	if !providerCredentialAccess || resource.CredentialProviderID == nil {
		return directive, nil
	}
	provider, err := s.db.GetProvider(ctx, *resource.CredentialProviderID)
	if err != nil {
		return directive, fmt.Errorf("provider unavailable")
	}
	cfg, err := providerDirectiveConfig(provider.ConfigJSON)
	if err != nil {
		return directive, err
	}
	if runtimeCredentialInjection {
		kind := derefStr(provider.ProviderKind)
		if !cfg.AllowRuntimeInjection || kind == "none" || kind == "caracal_mandate" || kind == "http_basic" {
			return directive, fmt.Errorf("provider runtime injection not allowed")
		}
	}
	if err := applyProviderDirective(provider, &directive, cfg); err != nil {
		return directive, err
	}
	directive.ProviderID = provider.ID
	if kind := derefStr(provider.ProviderKind); kind == "none" || kind == "caracal_mandate" {
		return directive, nil
	}
	if providerRequiresUserGrant(provider) {
		userID, _ := subjectClaims["sub"].(string)
		if userID == "" {
			return directive, fmt.Errorf("provider directive requires subject")
		}
		connection, err := s.db.GetProviderConnection(ctx, zoneID, userID, resource.CredentialProviderID)
		if err != nil || connection == nil || len(connection.AccessTokenCt) == 0 {
			return directive, fmt.Errorf("provider connection unavailable")
		}
		if connection.ProviderID == nil || *connection.ProviderID != provider.ID {
			return directive, fmt.Errorf("provider connection missing provider")
		}
		at, err := s.keys.keyring.Open(connection.AccessTokenCt, secretstore.AADConnectionAccessToken)
		if err != nil {
			return directive, fmt.Errorf("provider connection decrypt failed")
		}
		directive.ProviderToken = string(at)
		directive.ConnectionID = connection.ID
		if connection.ExpiresAt != nil {
			directive.ExpiresAt = connection.ExpiresAt.Unix()
		}
		return directive, nil
	}
	token, err := s.providerServiceToken(ctx, provider)
	if err != nil {
		return directive, err
	}
	directive.ProviderToken = token
	return directive, nil
}

func applyProviderDirective(provider *ProviderConfig, directive *UpstreamDirective, cfg providerForwardingConfig) error {
	directive.ForwardCaracalIdentity = cfg.ForwardCaracalIdentity
	switch derefStr(provider.ProviderKind) {
	case "none":
		directive.AuthMode = UpstreamAuthNone
		directive.AuthHeader = ""
		directive.AuthScheme = ""
	case "caracal_mandate":
		directive.AuthMode = UpstreamAuthCaracalJWT
		directive.AuthHeader = "Authorization"
		directive.AuthScheme = "Bearer"
	case "api_key":
		directive.AuthMode = UpstreamAuthProviderAPIKey
		hosts, err := normalizedProviderHosts(cfg.AllowedTokenHosts)
		if err != nil {
			return fmt.Errorf("provider allowed token hosts invalid")
		}
		directive.AllowedTokenHosts = hosts
		location := strings.TrimSpace(cfg.AuthLocation)
		if location == "" {
			location = "header"
		}
		directive.AuthLocation = location
		switch location {
		case "header":
			header := strings.TrimSpace(cfg.HeaderName)
			if !validProviderHeaderName(header) {
				return fmt.Errorf("provider api key header invalid")
			}
			directive.AuthHeader = header
			directive.AuthScheme = ""
			if scheme := strings.TrimSpace(cfg.AuthScheme); scheme != "" {
				if !validProviderAuthScheme(scheme) {
					return fmt.Errorf("provider auth scheme invalid")
				}
				directive.AuthScheme = scheme
			}
		case "query":
			name := strings.TrimSpace(cfg.QueryParamName)
			if !validProviderQueryParamName(name) {
				return fmt.Errorf("provider api key query parameter invalid")
			}
			if strings.TrimSpace(cfg.AuthScheme) != "" {
				return fmt.Errorf("provider auth scheme invalid")
			}
			directive.AuthHeader = ""
			directive.AuthScheme = ""
			directive.QueryParamName = name
		default:
			return fmt.Errorf("provider api key auth location invalid")
		}
	case "bearer_token":
		directive.AuthMode = UpstreamAuthProviderOAuth
		directive.AuthHeader = "Authorization"
		directive.AuthScheme = "Bearer"
		hosts, err := normalizedProviderHosts(cfg.AllowedTokenHosts)
		if err != nil {
			return fmt.Errorf("provider allowed token hosts invalid")
		}
		directive.AllowedTokenHosts = hosts
		if header := strings.TrimSpace(cfg.AuthHeader); header != "" {
			if !validProviderHeaderName(header) {
				return fmt.Errorf("provider auth header invalid")
			}
			directive.AuthHeader = header
		}
		if scheme := strings.TrimSpace(cfg.AuthScheme); scheme != "" {
			if !validProviderAuthScheme(scheme) {
				return fmt.Errorf("provider auth scheme invalid")
			}
			directive.AuthScheme = scheme
		}
	case "http_basic":
		directive.AuthMode = UpstreamAuthProviderOAuth
		directive.AuthHeader = "Authorization"
		directive.AuthScheme = "Basic"
		hosts, err := normalizedProviderHosts(cfg.AllowedTokenHosts)
		if err != nil {
			return fmt.Errorf("provider allowed token hosts invalid")
		}
		directive.AllowedTokenHosts = hosts
	case "oauth2_authorization_code", "oauth2_client_credentials":
		directive.AuthMode = UpstreamAuthProviderOAuth
		directive.AuthScheme = "Bearer"
		if header := strings.TrimSpace(cfg.AuthHeader); header != "" {
			if !validProviderHeaderName(header) {
				return fmt.Errorf("provider auth header invalid")
			}
			directive.AuthHeader = header
		}
		if scheme := strings.TrimSpace(cfg.AuthScheme); scheme != "" {
			if !validProviderAuthScheme(scheme) {
				return fmt.Errorf("provider auth scheme invalid")
			}
			directive.AuthScheme = scheme
		}
	default:
		return fmt.Errorf("provider kind unsupported")
	}
	return nil
}

func providerRequiresUserGrant(provider *ProviderConfig) bool {
	return derefStr(provider.ProviderKind) == "oauth2_authorization_code"
}

type oauthClientCredentialsConfig struct {
	TokenEndpoint     string            `json:"token_endpoint"`
	ClientID          string            `json:"client_id"`
	ClientAuthMethod  string            `json:"client_auth_method"`
	GrantType         string            `json:"grant_type"`
	AssertionSubject  string            `json:"assertion_subject"`
	AssertionAudience string            `json:"assertion_audience"`
	KeyID             string            `json:"key_id"`
	Certificate       string            `json:"certificate"`
	AuthScheme        string            `json:"auth_scheme"`
	AllowedTokenHosts []string          `json:"allowed_token_hosts"`
	Scopes            []string          `json:"scopes"`
	Audience          string            `json:"audience"`
	Resource          string            `json:"resource"`
	TokenParams       map[string]string `json:"token_params"`
}

type providerServiceTokenCacheEntry struct {
	fingerprint string
	token       string
	expiresAt   time.Time
}

func (s *Server) providerServiceToken(ctx context.Context, provider *ProviderConfig) (string, error) {
	secretConfig, secretDigest, err := s.providerSecretConfig(ctx, provider)
	if err != nil {
		return "", fmt.Errorf("provider secret fetch failed")
	}
	switch derefStr(provider.ProviderKind) {
	case "api_key":
		if secretConfig.APIKey == "" {
			return "", fmt.Errorf("provider api key missing")
		}
		return secretConfig.APIKey, nil
	case "bearer_token":
		if secretConfig.BearerToken == "" {
			return "", fmt.Errorf("provider bearer token missing")
		}
		return secretConfig.BearerToken, nil
	case "http_basic":
		cfg, err := providerDirectiveConfig(provider.ConfigJSON)
		if err != nil || strings.TrimSpace(cfg.Username) == "" {
			return "", fmt.Errorf("provider basic username missing")
		}
		if secretConfig.Password == "" {
			return "", fmt.Errorf("provider basic password missing")
		}
		return base64.StdEncoding.EncodeToString([]byte(strings.TrimSpace(cfg.Username) + ":" + secretConfig.Password)), nil
	case "oauth2_client_credentials":
		var cfg oauthClientCredentialsConfig
		if err := json.Unmarshal(provider.ConfigJSON, &cfg); err != nil || cfg.TokenEndpoint == "" || cfg.ClientID == "" {
			return "", fmt.Errorf("provider oauth2 config invalid")
		}
		fingerprint := providerServiceTokenFingerprint(provider, secretDigest)
		if token, ok := s.cachedProviderServiceToken(provider.ID, fingerprint, time.Now()); ok {
			return token, nil
		}
		value, err, _ := s.refreshGroup.Do("provider-service-token:"+provider.ID+":"+fingerprint, func() (any, error) {
			if token, ok := s.cachedProviderServiceToken(provider.ID, fingerprint, time.Now()); ok {
				return token, nil
			}
			token, expiresAt, err := s.fetchProviderServiceToken(ctx, provider, cfg, secretConfig)
			if err != nil {
				return "", err
			}
			s.storeProviderServiceToken(provider.ID, fingerprint, token, expiresAt)
			return token, nil
		})
		if err != nil {
			return "", err
		}
		token, ok := value.(string)
		if !ok || token == "" {
			return "", fmt.Errorf("provider token response invalid")
		}
		return token, nil
	default:
		return "", fmt.Errorf("provider kind unsupported")
	}
}

func (s *Server) fetchProviderServiceToken(ctx context.Context, provider *ProviderConfig, cfg oauthClientCredentialsConfig, secretConfig providerSecretConfig) (string, time.Time, error) {
	tokenEndpoint, err := validateTokenEndpoint(cfg.TokenEndpoint, cfg.AllowedTokenHosts, s.cfg.PrivateEgressHosts)
	if err != nil {
		return "", time.Time{}, err
	}
	if s.providerCircuitOpen(ctx, provider.ID) {
		return "", time.Time{}, fmt.Errorf("provider token circuit open")
	}
	var form url.Values
	if cfg.GrantType == "jwt_bearer" {
		assertion, err := buildProviderGrantAssertion(cfg, secretConfig.PrivateKey, tokenEndpoint.String(), time.Now().UTC())
		if err != nil {
			return "", time.Time{}, err
		}
		form = url.Values{"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"}, "assertion": {assertion}}
		if err := applyOAuthTokenParams(form, cfg.TokenParams); err != nil {
			return "", time.Time{}, err
		}
	} else {
		var err error
		form, err = oauthClientCredentialsForm(cfg)
		if err != nil {
			return "", time.Time{}, err
		}
	}
	body, err := s.refreshProviderToken(ctx, provider.ID, tokenEndpoint, form, cfg.ClientID, secretConfig.ClientSecret, cfg.ClientAuthMethod, cfg.KeyID, secretConfig.PrivateKey, cfg.Certificate)
	if err != nil {
		return "", time.Time{}, err
	}
	var tokenResp struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &tokenResp); err != nil || tokenResp.AccessToken == "" {
		return "", time.Time{}, fmt.Errorf("provider token response invalid")
	}
	if !validProviderTokenType(tokenResp.TokenType, cfg.AuthScheme) {
		return "", time.Time{}, fmt.Errorf("provider token type unsupported")
	}
	return tokenResp.AccessToken, time.Now().Add(providerServiceTokenTTL(tokenResp.ExpiresIn, s.cfg.MaxGrantTTLSeconds)), nil
}

func oauthClientCredentialsForm(cfg oauthClientCredentialsConfig) (url.Values, error) {
	form := url.Values{"grant_type": {"client_credentials"}}
	if len(cfg.Scopes) > 0 {
		form.Set("scope", strings.Join(cfg.Scopes, " "))
	}
	if strings.TrimSpace(cfg.Audience) != "" {
		form.Set("audience", strings.TrimSpace(cfg.Audience))
	}
	if strings.TrimSpace(cfg.Resource) != "" {
		form.Set("resource", strings.TrimSpace(cfg.Resource))
	}
	if err := applyOAuthTokenParams(form, cfg.TokenParams); err != nil {
		return nil, err
	}
	return form, nil
}

func providerServiceTokenTTL(providerSeconds, maxSeconds int) time.Duration {
	if maxSeconds <= 0 {
		maxSeconds = 3600
	}
	return capGrantTTL(providerSeconds, maxSeconds)
}

func providerServiceTokenFingerprint(provider *ProviderConfig, secretDigest string) string {
	h := sha256.New()
	h.Write([]byte(derefStr(provider.ProviderKind)))
	h.Write([]byte{0})
	h.Write(provider.ConfigJSON)
	h.Write([]byte{0})
	h.Write([]byte(secretDigest))
	return fmt.Sprintf("%x", h.Sum(nil))
}

func (s *Server) cachedProviderServiceToken(providerID, fingerprint string, now time.Time) (string, bool) {
	s.providerTokenMu.RLock()
	defer s.providerTokenMu.RUnlock()
	entry, ok := s.providerTokenCache[providerID]
	if !ok || entry.fingerprint != fingerprint || entry.token == "" || !entry.expiresAt.After(now.Add(providerTokenCacheSkew)) {
		return "", false
	}
	return entry.token, true
}

func (s *Server) storeProviderServiceToken(providerID, fingerprint, token string, expiresAt time.Time) {
	if token == "" || !expiresAt.After(time.Now().Add(providerTokenCacheSkew)) {
		return
	}
	s.providerTokenMu.Lock()
	defer s.providerTokenMu.Unlock()
	if s.providerTokenCache == nil {
		s.providerTokenCache = make(map[string]providerServiceTokenCacheEntry)
	}
	s.providerTokenCache[providerID] = providerServiceTokenCacheEntry{fingerprint: fingerprint, token: token, expiresAt: expiresAt}
}

type providerForwardingConfig struct {
	AuthLocation           string   `json:"auth_location"`
	AuthHeader             string   `json:"auth_header"`
	HeaderName             string   `json:"header_name"`
	QueryParamName         string   `json:"query_param_name"`
	AuthScheme             string   `json:"auth_scheme"`
	Username               string   `json:"username"`
	AllowedTokenHosts      []string `json:"allowed_token_hosts"`
	ForwardCaracalIdentity bool     `json:"forward_caracal_identity"`
	AllowRuntimeInjection  bool     `json:"allow_runtime_injection"`
}

func providerDirectiveConfig(raw json.RawMessage) (providerForwardingConfig, error) {
	var cfg providerForwardingConfig
	if len(raw) == 0 {
		return cfg, nil
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return cfg, fmt.Errorf("provider config invalid")
	}
	return cfg, nil
}

func validProviderHeaderName(name string) bool {
	if name == "" {
		return false
	}
	for _, r := range name {
		if r > 127 || !strings.ContainsRune("!#$%&'*+-.^_`|~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", r) {
			return false
		}
	}
	return true
}

func validProviderAuthScheme(scheme string) bool {
	if scheme == "" {
		return false
	}
	for i, r := range scheme {
		if r > 127 {
			return false
		}
		if i == 0 {
			if (r < 'A' || r > 'Z') && (r < 'a' || r > 'z') {
				return false
			}
			continue
		}
		if (r < 'A' || r > 'Z') && (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '-' {
			return false
		}
	}
	return true
}

func validProviderQueryParamName(name string) bool {
	if name == "" {
		return false
	}
	for _, r := range name {
		if r > 127 {
			return false
		}
		if (r < 'A' || r > 'Z') && (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '.' && r != '_' && r != '~' && r != '-' {
			return false
		}
	}
	return true
}

func normalizedProviderHosts(hosts []string) ([]string, error) {
	if len(hosts) == 0 {
		return nil, nil
	}
	normalized := make([]string, 0, len(hosts))
	for _, item := range hosts {
		host := strings.ToLower(strings.TrimSpace(item))
		if !validProviderHost(host) {
			return nil, fmt.Errorf("provider host invalid")
		}
		normalized = append(normalized, host)
	}
	return normalized, nil
}

func validProviderHost(host string) bool {
	if host == "" || len(host) > 253 || strings.Contains(host, "..") {
		return false
	}
	if !isHostAlnum(host[0]) || !isHostAlnum(host[len(host)-1]) {
		return false
	}
	for _, r := range host {
		if r > 127 {
			return false
		}
		if (r < 'A' || r > 'Z') && (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '.' && r != '-' {
			return false
		}
	}
	return true
}

func isHostAlnum(b byte) bool {
	return (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z') || (b >= '0' && b <= '9')
}

func (s *Server) authenticateApp(ctx context.Context, req TokenExchangeRequest) (*Application, string, error) {
	zoneID := strings.TrimSpace(req.ZoneID)
	appID := strings.TrimSpace(req.ApplicationID)
	if appID == "" {
		return nil, "", fmt.Errorf("missing application_id")
	}
	var app *Application
	var err error
	if zoneID == "" {
		app, err = s.db.GetApplicationByIDGlobal(ctx, appID)
		if err != nil {
			return nil, "", err
		}
		if !hasApplicationTrait(app, controlInvokeTrait) {
			return nil, "", fmt.Errorf("zone_id required for non-control application")
		}
		if !isZoneDerivedControlTokenRequest(req) {
			return nil, "", fmt.Errorf("zone_id required for non-control token exchange")
		}
		zoneID = app.ZoneID
	} else {
		app, err = s.db.GetApplicationByID(ctx, appID, zoneID)
		if err != nil {
			// The zone-scoped lookup missed. The application id may belong to a different
			// zone (a recreated zone, or credentials copied from another zone's provisioning
			// artifact). Resolve it globally and, only when the presented secret proves
			// possession, surface an explicit zone mismatch. Possession is required before
			// confirming existence so this path never becomes an application-enumeration
			// oracle for callers that do not already hold the secret.
			if mismatch := s.detectZoneMismatch(ctx, req, appID, zoneID); mismatch != nil {
				return nil, "", mismatch
			}
			return nil, "", err
		}
	}
	if app.ZoneID != zoneID {
		return nil, "", fmt.Errorf("application zone mismatch")
	}
	if req.GatewayAuthenticated {
		if req.SubjectToken == "" {
			return nil, "", fmt.Errorf("gateway exchanges require subject_token")
		}
		return app, zoneID, nil
	}
	if app.ClientSecretHash != nil {
		if !verifyClientSecret(*app.ClientSecretHash, presentedSecret(req)) {
			return nil, "", errSecretMismatch
		}
	} else {
		return nil, "", fmt.Errorf("client secret not configured")
	}
	return app, zoneID, nil
}

// presentedSecret returns the credential a client offered, preferring the form-encoded
// client secret and falling back to a client assertion.
func presentedSecret(req TokenExchangeRequest) string {
	if req.ClientSecret != "" {
		return req.ClientSecret
	}
	return req.ClientAssertion
}

// zoneMismatchError marks an authentication failure where the application id is valid and
// the presented secret verifies, but the application belongs to a different zone than the
// request targeted. The caller maps it to an explicit zone_invalid response so a cross-zone
// credential is not misreported as an invalid secret.
type zoneMismatchError struct {
	requested string
	actual    string
}

func (e *zoneMismatchError) Error() string {
	return fmt.Sprintf("application registered in zone %s, not requested zone %s", e.actual, e.requested)
}

// detectZoneMismatch reports an explicit zone mismatch when the application id exists in a
// zone other than the requested one and the caller proves possession of its client secret.
// It returns nil when no such mismatch can be confirmed, leaving the caller to surface the
// generic credential failure rather than disclosing application existence.
func (s *Server) detectZoneMismatch(ctx context.Context, req TokenExchangeRequest, appID, zoneID string) error {
	if req.GatewayAuthenticated {
		return nil
	}
	other, err := s.db.GetApplicationByIDGlobal(ctx, appID)
	if err != nil || other == nil || other.ZoneID == zoneID || other.ClientSecretHash == nil {
		return nil
	}
	if !verifyClientSecret(*other.ClientSecretHash, presentedSecret(req)) {
		return nil
	}
	return &zoneMismatchError{requested: zoneID, actual: other.ZoneID}
}

func isZoneDerivedControlTokenRequest(req TokenExchangeRequest) bool {
	if req.SubjectToken != "" || req.AuthorityRecordID != "" || req.SessionID != "" || req.DelegationEdgeID != "" {
		return false
	}
	if len(req.Resources) == 0 {
		return false
	}
	for _, resource := range req.Resources {
		if strings.TrimSpace(resource) != controlAudience() {
			return false
		}
	}
	scopes := strings.Fields(req.Scope)
	if len(scopes) == 0 {
		return false
	}
	for _, scope := range scopes {
		if !strings.HasPrefix(scope, "control:") {
			return false
		}
	}
	return true
}

// validateSubjectToken verifies an inbound STS-issued token: ES256 signature, this STS
// as issuer, the issuer audience, a matching zone_id, and use=session. Resource mandates
// are deliberately rejected here (RFC 8693 §2.1 subject-confusion mitigation): a token
// already narrowed to resources A,B must not bootstrap the minting of one for resource C.
//
// The keyfunc extracts the token's kid header and selects the matching verification key
// from the zone's active + grace-period key set, ensuring tokens signed by a previous
// key during key rotation are still accepted within the 24h grace window.
func (s *Server) validateSubjectToken(ctx context.Context, tokenStr, zoneID string) (map[string]any, error) {
	return s.validateSubjectTokenUse(ctx, tokenStr, zoneID, UseSession)
}

func (s *Server) validateGatewaySubjectToken(ctx context.Context, tokenStr, zoneID string) (map[string]any, error) {
	return s.validateSubjectTokenUse(ctx, tokenStr, zoneID, UseGateway)
}

func (s *Server) validateSubjectTokenUse(ctx context.Context, tokenStr, zoneID, expectedUse string) (map[string]any, error) {
	zoneKeys, err := s.keys.getPublicKeysByZone(ctx, zoneID)
	if err != nil {
		return nil, fmt.Errorf("get zone keys: %w", err)
	}
	claims, err := s.parseSubjectToken(tokenStr, zoneID, expectedUse, zoneKeys)
	if err == nil || !strings.Contains(err.Error(), "unknown signing key kid") {
		return claims, err
	}
	// A peer replica may have rotated the zone key after this process populated its
	// public-key cache. Refresh once on an unknown kid so valid session mandates do
	// not fail for the full cache TTL.
	s.keys.Invalidate(zoneID)
	zoneKeys, refreshErr := s.keys.getPublicKeysByZone(ctx, zoneID)
	if refreshErr != nil {
		return nil, fmt.Errorf("refresh zone keys: %w", refreshErr)
	}
	return s.parseSubjectToken(tokenStr, zoneID, expectedUse, zoneKeys)
}

func (s *Server) parseSubjectToken(tokenStr, zoneID, expectedUse string, zoneKeys map[string]*ecdsa.PublicKey) (map[string]any, error) {
	mc := jwt.MapClaims{}
	_, err := jwt.NewParser(
		jwt.WithValidMethods([]string{"ES256"}),
		jwt.WithIssuer(s.cfg.IssuerURL),
		jwt.WithAudience(s.cfg.IssuerURL),
		jwt.WithExpirationRequired(),
		jwt.WithIssuedAt(),
		jwt.WithLeeway(60*time.Second),
	).ParseWithClaims(tokenStr, mc, func(token *jwt.Token) (any, error) {
		kid, ok := token.Header["kid"].(string)
		if !ok || kid == "" {
			return nil, errors.New("token missing kid header")
		}
		pub, found := zoneKeys[kid]
		if !found {
			return nil, fmt.Errorf("unknown signing key kid %q for zone %s", kid, zoneID)
		}
		return pub, nil
	})
	if err != nil {
		return nil, err
	}
	if claimString(mc, "zone_id") != zoneID {
		return nil, errors.New("token zone mismatch")
	}
	if claimString(mc, "use") != expectedUse {
		return nil, fmt.Errorf("subject_token must be a %s mandate", expectedUse)
	}
	return mc, nil
}

func (s *Server) validateAuthorityRecord(ctx context.Context, zoneID, appID, authorityRecordID string, claims map[string]any) (string, *sharederr.CaracalError) {
	sid := claimString(claims, "sid")
	if sid == "" {
		return "", sharederr.New(sharederr.InvalidToken, "missing token authority record")
	}
	if authorityRecordID != "" && authorityRecordID != sid {
		return "", sharederr.New(sharederr.AccessDenied, "authority record mismatch")
	}
	now, err := s.db.CurrentTime(ctx)
	if err != nil {
		return "", sharederr.New(sharederr.STSUnavailable, "trusted time unavailable")
	}
	record, err := s.db.GetAuthorityRecord(ctx, sid)
	if err != nil || record.ZoneID != zoneID || record.Status != "active" || !record.ExpiresAt.After(now) {
		return "", sharederr.New(sharederr.AccessDenied, "authority record inactive or expired")
	}
	// Defense in depth: even with a valid signature, the authority record's
	// subject must match the JWT sub claim. A leaked signing key or any
	// other path that could mint a structurally-valid token still fails
	// this bind unless the authority record was also tampered with.
	sub := claimString(claims, "sub")
	if sub == "" || record.SubjectID == nil || *record.SubjectID != sub {
		return "", sharederr.New(sharederr.AccessDenied, "authority record subject mismatch")
	}
	if clientID := claimString(claims, "client_id"); clientID == "" || clientID != appID {
		return "", sharederr.New(sharederr.AccessDenied, "authority record client mismatch")
	}
	return sid, nil
}

func parentAuthorityRecordID(authorityRecordID string, use string) *string {
	if use == UseSession || authorityRecordID == "" {
		return nil
	}
	return &authorityRecordID
}

func rootAuthorityRecordID(claims map[string]any, sid string, use string) string {
	if use == UseSession {
		return sid
	}
	if root := claimString(claims, "root_sid"); root != "" {
		return root
	}
	if parent := claimString(claims, "sid"); parent != "" {
		return parent
	}
	return sid
}

func controlAudience() string {
	if value := strings.TrimSpace(os.Getenv("CONTROL_AUDIENCE")); value != "" {
		return value
	}
	return defaultControlAudience
}

func hasApplicationTrait(app *Application, trait string) bool {
	for _, current := range app.Traits {
		if current == trait {
			return true
		}
	}
	return false
}

func controlAllowedScopes(app *Application) map[string]struct{} {
	allowed := map[string]struct{}{}
	for _, trait := range app.Traits {
		scope, ok := strings.CutPrefix(trait, controlScopeTrait)
		if ok && strings.HasPrefix(scope, "control:") {
			allowed[scope] = struct{}{}
		}
	}
	return allowed
}

func controlMaxTTL(app *Application) int {
	for _, trait := range app.Traits {
		value, ok := strings.CutPrefix(trait, controlMaxTTLTrait)
		if !ok {
			continue
		}
		seconds, err := strconv.Atoi(value)
		if err == nil && seconds > 0 {
			return seconds
		}
	}
	return 0
}

func controlExpired(app *Application, now time.Time) bool {
	for _, trait := range app.Traits {
		value, ok := strings.CutPrefix(trait, controlExpiresTrait)
		if !ok {
			continue
		}
		expiresAt, err := time.Parse(time.RFC3339, value)
		if err == nil && !now.Before(expiresAt) {
			return true
		}
	}
	return false
}

func isControlKeyExchange(app *Application, req TokenExchangeRequest, resource *Resource, scopes []string, now time.Time) bool {
	if resource.Identifier != controlAudience() || !hasApplicationTrait(app, controlInvokeTrait) {
		return false
	}
	if controlExpired(app, now.UTC()) {
		return false
	}
	if req.SubjectToken != "" || req.AuthorityRecordID != "" || req.SessionID != "" || req.DelegationEdgeID != "" {
		return false
	}
	if len(scopes) == 0 {
		return false
	}
	allowed := controlAllowedScopes(app)
	if len(allowed) == 0 {
		return false
	}
	for _, scope := range scopes {
		if !strings.HasPrefix(scope, "control:") {
			return false
		}
		if _, ok := allowed[scope]; !ok {
			return false
		}
	}
	return true
}

func (s *Server) emitAuditEvent(requestID, zoneID, decision, status string, result *OPAResult, meta map[string]any) *sharederr.CaracalError {
	return s.emitAuditEventWithBundle(requestID, zoneID, decision, status, result, meta, ZoneBundleInfo{})
}

// emitStepUpAudit records a step-up lifecycle transition (issued, decided, consumed) as
// a first-class audit event distinct from the token-exchange decision events that
// surround it, so the full life of an approval hold is reconstructable from the stream.
func (s *Server) emitStepUpAudit(requestID, zoneID, eventType, decision string, meta map[string]any) *sharederr.CaracalError {
	event, err := buildAuditEventWithBundle(requestID, zoneID, decision, "complete", &OPAResult{}, meta, ZoneBundleInfo{})
	if err != nil {
		s.log.Error().Err(err).Str("request_id", requestID).Str("zone_id", zoneID).Msg("audit event id generation failed")
		return sharederr.New(sharederr.Internal, "audit event creation failed")
	}
	event.EventType = eventType
	s.auditBuffer.Emit(event)
	return nil
}

// stepUpAuditMeta is the challenge context every step-up audit event and step-up deny
// carries: the authorization facts of the hold, never request business context. The
// expiry rides along so a downstream consumer (a notification sink, an export) can state
// the response window without a lookup against a row that may already be swept.
func stepUpAuditMeta(c *StepUpChallengePG) map[string]any {
	meta := map[string]any{
		"challenge_id":   c.ID,
		"tier":           c.Tier,
		"approver_class": c.ApproverClass,
		"privacy_mode":   c.PrivacyMode,
		"binding":        hex.EncodeToString(c.ResourceSetHash),
		"expires_at":     c.ExpiresAt.UTC().Format(time.RFC3339),
	}
	if c.ApplicationID != "" {
		meta["application_id"] = c.ApplicationID
	}
	if c.AuthorityRecordID != "" {
		meta["session_id"] = c.AuthorityRecordID
	}
	return meta
}

// challengeWire converts a stored challenge row to the 401 interaction_required body.
func challengeWire(c *StepUpChallengePG, now time.Time) *challengeState {
	return &challengeState{
		ID:                c.ID,
		ZoneID:            c.ZoneID,
		AuthorityRecordID: c.AuthorityRecordID,
		ChallengeType:     c.ChallengeType,
		State:             challengeLifecycleState(c, now),
		Tier:              c.Tier,
		Binding:           c.ResourceSetHash,
		ExpiresAt:         c.ExpiresAt,
	}
}

func (s *Server) emitAuditEventWithBundle(requestID, zoneID, decision, status string, result *OPAResult, meta map[string]any, bundle ZoneBundleInfo) *sharederr.CaracalError {
	event, err := buildAuditEventWithBundle(requestID, zoneID, decision, status, result, meta, bundle)
	if err != nil {
		s.log.Error().Err(err).Str("request_id", requestID).Str("zone_id", zoneID).Msg("audit event id generation failed")
		return sharederr.New(sharederr.Internal, "audit event creation failed")
	}
	s.auditBuffer.Emit(event)
	return nil
}

func buildAuditEvent(requestID, zoneID, decision, status string, result *OPAResult, meta map[string]any) (AuditEvent, error) {
	return buildAuditEventWithBundle(requestID, zoneID, decision, status, result, meta, ZoneBundleInfo{})
}

func buildAuditEventWithBundle(requestID, zoneID, decision, status string, result *OPAResult, meta map[string]any, bundle ZoneBundleInfo) (AuditEvent, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return AuditEvent{}, err
	}
	dpJSON, _ := json.Marshal(result.DeterminingPolicies)
	diagJSON, _ := json.Marshal(result.Diagnostics)
	var metaJSON json.RawMessage
	if meta != nil {
		if b, err := json.Marshal(meta); err == nil {
			metaJSON = b
		}
	}
	return AuditEvent{
		ID:                      id.String(),
		ZoneID:                  zoneID,
		EventType:               "token_exchange",
		RequestID:               requestID,
		Decision:                decision,
		PolicySetVersionID:      bundle.PolicySetVersionID,
		ManifestSHA:             bundle.ManifestSHA,
		EvaluationStatus:        status,
		DeterminingPoliciesJSON: dpJSON,
		DiagnosticsJSON:         diagJSON,
		MetadataJSON:            metaJSON,
		OccurredAt:              time.Now(),
	}, nil
}

// delegationAuditMeta returns audit metadata extracted from a delegation proof.
// When delegation is nil, returns nil (no delegation active).
func delegationAuditMeta(d *delegationProof) map[string]any {
	if d == nil {
		return nil
	}
	hops := make([]map[string]any, len(d.chain))
	for i, h := range d.chain {
		hops[i] = map[string]any{
			"application_id":     h.AppID,
			"agent_session_id":   h.SessionID,
			"delegation_edge_id": h.DelegationEdgeID,
		}
	}
	return map[string]any{
		"delegation_edge_id":     d.edge.ID,
		"delegation_chain":       hops,
		"delegation_hop_count":   len(d.path),
		"delegation_graph_epoch": d.graphEpoch,
	}
}

// mergeAuditMeta returns a merged metadata map without mutating either input.
func mergeAuditMeta(base, extra map[string]any) map[string]any {
	if base == nil && extra == nil {
		return nil
	}
	merged := make(map[string]any, len(base)+len(extra))
	for k, v := range base {
		merged[k] = v
	}
	for k, v := range extra {
		merged[k] = v
	}
	return merged
}

func sessionInput(sessionID string) *OPAAuthorityRecord {
	if sessionID == "" {
		return nil
	}
	return &OPAAuthorityRecord{ID: sessionID}
}

func sessionLifecycle(session *Session) string {
	if session == nil {
		return ""
	}
	return session.Lifecycle
}

func sessionLabels(session *Session) []string {
	if session == nil || len(session.Labels) == 0 {
		return nil
	}
	return append([]string(nil), session.Labels...)
}

func agentAuditMeta(session *Session) map[string]any {
	if session == nil {
		return nil
	}
	meta := map[string]any{
		"agent_lifecycle": session.Lifecycle,
		"agent_labels":    sessionLabels(session),
		"agent_depth":     session.Depth,
	}
	if session.ParentID != nil {
		meta["agent_parent_id"] = *session.ParentID
	}
	return meta
}

func applicationAuditMeta(app *Application) map[string]any {
	return map[string]any{
		"application_id":                  app.ID,
		"application_name":                app.Name,
		"application_registration_method": app.RegistrationMethod,
	}
}

func bindGovernedSession(req *TokenExchangeRequest, claims map[string]any) *sharederr.CaracalError {
	sessionID := claimString(claims, "agent_session_id")
	if sessionID == "" {
		return nil
	}
	if req.SessionID != "" && req.SessionID != sessionID {
		return sharederr.New(sharederr.AccessDenied, "Session mismatch")
	}
	req.SessionID = sessionID
	return nil
}

func bindDelegationEdge(req *TokenExchangeRequest, claims map[string]any) *sharederr.CaracalError {
	edgeID := claimString(claims, "delegation_edge_id")
	if edgeID == "" {
		if req.DelegationEdgeID != "" {
			return sharederr.New(sharederr.AccessDenied, "delegation claim missing from subject token")
		}
		return nil
	}
	if req.DelegationEdgeID != "" && req.DelegationEdgeID != edgeID {
		return sharederr.New(sharederr.AccessDenied, "delegation mismatch")
	}
	req.DelegationEdgeID = edgeID
	return nil
}

func delegationEdgeInput(proof *delegationProof) *OPADelegationEdge {
	if proof == nil {
		return nil
	}
	edge := proof.edge
	resourceID := ""
	if edge.ResourceID != nil {
		resourceID = *edge.ResourceID
	}
	return &OPADelegationEdge{
		ID:                    edge.ID,
		SourceSessionID:       edge.SourceSessionID,
		TargetSessionID:       edge.TargetSessionID,
		IssuerApplicationID:   edge.IssuerAppID,
		ReceiverApplicationID: edge.ReceiverAppID,
		ResourceID:            resourceID,
		Scopes:                edge.Scopes,
		EdgeVersion:           edge.EdgeVersion,
		Path:                  proof.path,
		GraphEpoch:            proof.graphEpoch,
		ConstraintsJSON:       edge.ConstraintsJSON,
	}
}

func delegationAllowsResource(proof *delegationProof, resource *Resource) bool {
	if proof == nil || proof.edge == nil {
		return true
	}
	if proof.edge.ResourceID != nil && *proof.edge.ResourceID != resource.ID {
		return false
	}
	if len(proof.constraints.Resources) == 0 {
		return true
	}
	return containsString(proof.constraints.Resources, resource.Identifier)
}

// validateSessionOwnership binds the asserted governed Session ID to the calling
// application: the row must exist, be active in this zone, and be owned by app.ID.
// This stops two apps in a zone from forging each other's execution identity.
func (s *Server) validateSessionOwnership(ctx context.Context, zoneID, appID, sessionID string) (*Session, *sharederr.CaracalError) {
	now, err := s.db.CurrentTime(ctx)
	if err != nil {
		return nil, sharederr.New(sharederr.STSUnavailable, "trusted time unavailable")
	}
	session, err := s.db.GetSession(ctx, sessionID)
	if err != nil || !activeSession(session, zoneID, now) {
		return nil, sharederr.New(sharederr.AccessDenied, "session inactive or expired")
	}
	if session.ApplicationID != appID {
		return nil, sharederr.New(sharederr.AccessDenied, "session not owned by caller")
	}
	return session, nil
}

// validateSessionReferences binds a token exchange to an authority record, governed
// Sessions, and Delegations. When a delegation_edge_id is present, the receiving
// target Session's ownership is verified inside
// the delegation block (target.ApplicationID == appID); otherwise the calling
// application's ownership of the asserted Session ID is verified directly,
// preventing peer-app forgery through either path.
func (s *Server) validateSessionReferences(ctx context.Context, zoneID, appID string, req TokenExchangeRequest, hasSubjectToken bool) (*delegationProof, *Session, *sharederr.CaracalError) {
	now, err := s.db.CurrentTime(ctx)
	if err != nil {
		return nil, nil, sharederr.New(sharederr.STSUnavailable, "trusted time unavailable")
	}
	if req.AuthorityRecordID != "" {
		session, err := s.db.GetAuthorityRecord(ctx, req.AuthorityRecordID)
		if err != nil || session.ZoneID != zoneID || session.Status != "active" || !session.ExpiresAt.After(now) {
			return nil, nil, sharederr.New(sharederr.AccessDenied, "authority record inactive or expired")
		}
		// Application-principal flows (no subject_token) must assert a
		// authority record owned by the calling app. Without this, peer apps in a
		// zone could pass another app's session_id and have OPA evaluate
		// against authority state that is not their own.
		if !hasSubjectToken {
			if session.SessionType != "application" || session.SubjectID == nil || *session.SubjectID != appID {
				return nil, nil, sharederr.New(sharederr.AccessDenied, "authority record not owned by caller")
			}
		}
	}
	if req.SessionID != "" && req.DelegationEdgeID == "" {
		session, aerr := s.validateSessionOwnership(ctx, zoneID, appID, req.SessionID)
		if aerr != nil {
			return nil, nil, aerr
		}
		if hasSubjectToken && req.AuthorityRecordID != "" && session.SubjectAuthorityRecordID != req.AuthorityRecordID {
			return nil, nil, sharederr.New(sharederr.AccessDenied, "session authority record binding mismatch")
		}
		return nil, session, nil
	}
	if req.DelegationEdgeID == "" {
		return nil, nil, nil
	}
	if req.SessionID == "" {
		return nil, nil, sharederr.New(sharederr.AccessDenied, "delegation requires a target Session")
	}
	edge, err := s.db.GetDelegationEdge(ctx, req.DelegationEdgeID)
	if err != nil || edge.ZoneID != zoneID || edge.Status != "active" || !edge.ExpiresAt.After(now) || edge.RevokedAt != nil {
		return nil, nil, sharederr.New(sharederr.AccessDenied, "delegation edge inactive or expired")
	}
	if edge.TargetSessionID != req.SessionID {
		return nil, nil, sharederr.New(sharederr.AccessDenied, "delegation edge target mismatch")
	}
	source, err := s.db.GetSession(ctx, edge.SourceSessionID)
	if err != nil || !activeSession(source, zoneID, now) {
		return nil, nil, sharederr.New(sharederr.AccessDenied, "delegation source inactive or expired")
	}
	target, err := s.db.GetSession(ctx, edge.TargetSessionID)
	if err != nil || !activeSession(target, zoneID, now) || target.ApplicationID != appID {
		return nil, nil, sharederr.New(sharederr.AccessDenied, "delegation target inactive or unauthorized")
	}
	if hasSubjectToken && req.AuthorityRecordID != "" && target.SubjectAuthorityRecordID != req.AuthorityRecordID {
		return nil, nil, sharederr.New(sharederr.AccessDenied, "session authority record binding mismatch")
	}
	if source.ApplicationID != edge.IssuerAppID || target.ApplicationID != edge.ReceiverAppID {
		return nil, nil, sharederr.New(sharederr.AccessDenied, "delegation application mismatch")
	}
	constraints, err := parseDelegationConstraints(edge.ConstraintsJSON)
	if err != nil {
		return nil, nil, sharederr.New(sharederr.AccessDenied, "delegation constraints invalid")
	}
	requestedScopes := distinctScopes(req.Scope)
	if !scopesAllowed(requestedScopes, edge.Scopes) {
		return nil, nil, sharederr.New(sharederr.AccessDenied, "requested scopes exceed delegation scopes")
	}
	if constraints.Budget > 0 && len(requestedScopes) > constraints.Budget {
		return nil, nil, sharederr.New(sharederr.AccessDenied, "requested scopes exceed delegation budget")
	}
	if constraints.TTLSeconds > 0 {
		if req.TTLSeconds > constraints.TTLSeconds {
			return nil, nil, sharederr.New(sharederr.AccessDenied, "requested ttl exceeds delegation ttl")
		}
	}
	if constraints.MaxHops <= 0 {
		constraints.MaxHops = 1
	}
	if s.metrics != nil {
		s.metrics.GraphTraversals.Add(1)
	}
	path, err := s.db.GetDelegationLineage(ctx, zoneID, edge.ID, maxDelegationHops)
	if err != nil || len(path) == 0 || len(path) > maxDelegationHops || path[len(path)-1] != edge.ID {
		if s.metrics != nil {
			s.metrics.GraphTraversalErrors.Add(1)
		}
		return nil, nil, sharederr.New(sharederr.AccessDenied, "delegation path invalid")
	}
	graphEpoch, err := s.db.GetDelegationGraphEpoch(ctx, zoneID)
	if err != nil {
		return nil, nil, sharederr.New(sharederr.AccessDenied, "delegation graph epoch unavailable")
	}
	chain, edges, chainErr := s.buildDelegationChain(ctx, path, edge, source, target, now)
	if chainErr != nil {
		return nil, nil, chainErr
	}
	return &delegationProof{
		edge: edge, edges: edges, source: source, target: target,
		constraints: constraints, path: path, chain: chain, graphEpoch: graphEpoch,
	}, target, nil
}

// buildDelegationChain resolves each edge id along the path to a chain hop the
// resource side can audit and authorize against. The chain walks from the
// originating issuer to the immediate receiver in order.
func (s *Server) buildDelegationChain(ctx context.Context, path []string, edge *DelegationEdge, source, target *Session, now time.Time) ([]ChainHop, []*DelegationEdge, *sharederr.CaracalError) {
	if len(path) == 0 {
		return nil, nil, nil
	}
	hops := make([]ChainHop, 0, len(path)+1)
	edges := make([]*DelegationEdge, 0, len(path))
	var prevReceiverApp string
	var prevTargetSessionID string
	var parentEdge *DelegationEdge
	var parentConstraints delegationConstraints
	for index, edgeID := range path {
		var hopEdge *DelegationEdge
		if edgeID == edge.ID {
			hopEdge = edge
		} else {
			fetched, err := s.db.GetDelegationEdge(ctx, edgeID)
			if err != nil || fetched == nil {
				return nil, nil, sharederr.New(sharederr.AccessDenied, "delegation path edge unavailable")
			}
			hopEdge = fetched
		}
		// Every lineage edge must remain active while the auditable chain is built.
		// The guarded insert repeats the check under the Coordinator mutation lock.
		if hopEdge.ZoneID != edge.ZoneID || hopEdge.Status != "active" || hopEdge.RevokedAt != nil || !hopEdge.ExpiresAt.After(now) {
			return nil, nil, sharederr.New(sharederr.AccessDenied, "delegation path edge inactive or revoked")
		}
		hopConstraints, err := parseDelegationConstraints(hopEdge.ConstraintsJSON)
		if err != nil || hopConstraints.MaxHops < len(path)-index {
			return nil, nil, sharederr.New(sharederr.AccessDenied, "delegation hop budget exhausted")
		}
		if prevReceiverApp != "" && hopEdge.IssuerAppID != prevReceiverApp {
			return nil, nil, sharederr.New(sharederr.AccessDenied, "delegation chain discontinuous")
		}
		if prevTargetSessionID != "" && hopEdge.SourceSessionID != prevTargetSessionID {
			return nil, nil, sharederr.New(sharederr.AccessDenied, "delegation Session chain discontinuous")
		}
		if len(hops) > 0 {
			previousEdgeID := hops[len(hops)-1].DelegationEdgeID
			if hopEdge.ParentEdgeID == nil || *hopEdge.ParentEdgeID != previousEdgeID {
				return nil, nil, sharederr.New(sharederr.AccessDenied, "delegation parent lineage discontinuous")
			}
			if err := s.validateAncestorAttenuation(ctx, parentEdge, parentConstraints, hopEdge, hopConstraints); err != nil {
				return nil, nil, sharederr.New(sharederr.AccessDenied, err.Error())
			}
		}
		edges = append(edges, hopEdge)
		hops = append(hops, ChainHop{
			AppID:            hopEdge.IssuerAppID,
			SessionID:        hopEdge.SourceSessionID,
			DelegationEdgeID: hopEdge.ID,
		})
		prevReceiverApp = hopEdge.ReceiverAppID
		prevTargetSessionID = hopEdge.TargetSessionID
		parentEdge = hopEdge
		parentConstraints = hopConstraints
	}
	hops = append(hops, ChainHop{
		AppID:     edge.ReceiverAppID,
		SessionID: target.ID,
	})
	if hops[0].AppID != source.ApplicationID || hops[len(hops)-1].AppID != target.ApplicationID {
		return nil, nil, sharederr.New(sharederr.AccessDenied, "delegation chain endpoints mismatch")
	}
	return hops, edges, nil
}

func delegationIssuanceProof(proof *delegationProof) DelegationIssuanceProof {
	lineage := make([]DelegationIssuanceEdge, 0, len(proof.edges))
	for _, edge := range proof.edges {
		lineage = append(lineage, DelegationIssuanceEdge{
			ID: edge.ID, ParentEdgeID: edge.ParentEdgeID, EdgeVersion: edge.EdgeVersion,
			SourceSessionID: edge.SourceSessionID, TargetSessionID: edge.TargetSessionID,
			IssuerApplicationID: edge.IssuerAppID, ReceiverApplicationID: edge.ReceiverAppID,
			ExpiresAt: edge.ExpiresAt,
		})
	}
	return DelegationIssuanceProof{
		Lineage: lineage, SourceSessionID: proof.source.ID, TargetSessionID: proof.target.ID,
		SourceApplicationID: proof.source.ApplicationID, TargetApplicationID: proof.target.ApplicationID,
		TargetAuthorityRecord: proof.target.SubjectAuthorityRecordID,
		GraphEpoch:            proof.graphEpoch,
	}
}

func (s *Server) validateAncestorAttenuation(ctx context.Context, parent *DelegationEdge, parentConstraints delegationConstraints, child *DelegationEdge, childConstraints delegationConstraints) error {
	if parent == nil || !scopesAllowed(child.Scopes, parent.Scopes) {
		return fmt.Errorf("delegation lineage widens scopes")
	}
	if child.ExpiresAt.After(parent.ExpiresAt) {
		return fmt.Errorf("delegation lineage widens expiry")
	}
	parentExpiry, err := constraintExpiry(parentConstraints.ExpiresAt)
	if err != nil {
		return fmt.Errorf("delegation ancestor constraint expiry invalid")
	}
	childExpiry, err := constraintExpiry(childConstraints.ExpiresAt)
	if err != nil {
		return fmt.Errorf("delegation child constraint expiry invalid")
	}
	if !parentExpiry.IsZero() && (childExpiry.IsZero() || childExpiry.After(parentExpiry)) {
		return fmt.Errorf("delegation lineage widens constraint expiry")
	}
	if parentConstraints.TTLSeconds > 0 && (childConstraints.TTLSeconds == 0 || childConstraints.TTLSeconds > parentConstraints.TTLSeconds) {
		return fmt.Errorf("delegation lineage widens ttl")
	}
	if childConstraints.MaxHops > parentConstraints.MaxHops-1 {
		return fmt.Errorf("delegation lineage widens hop allowance")
	}
	if parentConstraints.Budget > 0 {
		childBudget := childConstraints.Budget
		if childBudget == 0 {
			childBudget = len(uniqueStrings(child.Scopes))
		}
		if childBudget > parentConstraints.Budget {
			return fmt.Errorf("delegation lineage widens budget")
		}
	}
	parentResources, err := s.edgeResourceIDs(ctx, parent)
	if err != nil {
		return fmt.Errorf("delegation ancestor resources invalid")
	}
	childResources, err := s.edgeResourceIDs(ctx, child)
	if err != nil {
		return fmt.Errorf("delegation child resources invalid")
	}
	if len(parentResources) > 0 && (len(childResources) == 0 || !scopesAllowed(childResources, parentResources)) {
		return fmt.Errorf("delegation lineage widens resources")
	}
	return nil
}

func (s *Server) edgeResourceIDs(ctx context.Context, edge *DelegationEdge) ([]string, error) {
	constraints, err := parseDelegationConstraints(edge.ConstraintsJSON)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	if edge.ResourceID != nil {
		resource, err := s.db.GetResourceByIdentifier(ctx, edge.ZoneID, *edge.ResourceID)
		if err != nil {
			return nil, err
		}
		ids = append(ids, resource.ID)
	}
	for _, identifier := range constraints.Resources {
		resource, err := s.db.GetResourceByIdentifier(ctx, edge.ZoneID, identifier)
		if err != nil {
			return nil, err
		}
		ids = append(ids, resource.ID)
	}
	return uniqueStrings(ids), nil
}

func constraintExpiry(value string) (time.Time, error) {
	if value == "" {
		return time.Time{}, nil
	}
	return time.Parse(time.RFC3339, value)
}

func distinctScopes(scope string) []string {
	return uniqueStrings(strings.Fields(scope))
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	slices.Sort(out)
	return out
}

func parseDelegationConstraints(raw json.RawMessage) (delegationConstraints, error) {
	var constraints delegationConstraints
	if len(raw) == 0 {
		constraints.MaxHops = 1
		return constraints, nil
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&constraints); err != nil {
		return constraints, err
	}
	if constraints.TTLSeconds < 0 || constraints.MaxDepth < 0 || constraints.MaxHops < 0 || constraints.Budget < 0 {
		return constraints, fmt.Errorf("delegation constraints must be positive")
	}
	if constraints.MaxDepth > 0 {
		if constraints.MaxHops > 0 && constraints.MaxHops != constraints.MaxDepth {
			return constraints, fmt.Errorf("max_hops conflicts with max_depth")
		}
		constraints.MaxHops = constraints.MaxDepth
	}
	if constraints.MaxHops <= 0 {
		constraints.MaxHops = 1
	}
	return constraints, nil
}

func effectiveTokenTTL(ttl time.Duration, proof *delegationProof, now time.Time) (time.Duration, error) {
	if proof == nil || proof.edge == nil {
		return ttl, nil
	}
	edgeTTL := proof.edge.ExpiresAt.Sub(now)
	if edgeTTL <= 0 {
		return 0, fmt.Errorf("delegation inactive or expired")
	}
	if edgeTTL < ttl {
		ttl = edgeTTL
	}
	if proof.constraints.TTLSeconds > 0 {
		constraintTTL := time.Duration(proof.constraints.TTLSeconds) * time.Second
		if constraintTTL < ttl {
			ttl = constraintTTL
		}
	}
	if proof.constraints.ExpiresAt != "" {
		expiresAt, err := time.Parse(time.RFC3339, proof.constraints.ExpiresAt)
		if err != nil {
			return 0, fmt.Errorf("delegation constraint expiry invalid")
		}
		constraintTTL := expiresAt.Sub(now)
		if constraintTTL <= 0 {
			return 0, fmt.Errorf("delegation constraint expired")
		}
		if constraintTTL < ttl {
			ttl = constraintTTL
		}
	}
	if ttl <= 0 {
		return 0, fmt.Errorf("effective delegation ttl expired")
	}
	return ttl, nil
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func activeSession(session *Session, zoneID string, now time.Time) bool {
	if session == nil || session.ZoneID != zoneID || session.Status != "active" {
		return false
	}
	if session.Lifecycle == "service" {
		return session.HeartbeatDeadlineAt != nil && session.HeartbeatDeadlineAt.After(now)
	}
	if session.TTLSeconds <= 0 {
		return false
	}
	return session.StartedAt.Add(time.Duration(session.TTLSeconds) * time.Second).After(now)
}

func tokenTTL(ttlSeconds int, sessionMandateAllowed bool) (time.Duration, error) {
	if ttlSeconds == 0 {
		return ttlResourceMandate, nil
	}
	if ttlSeconds < 0 {
		return 0, fmt.Errorf("ttl_seconds must be positive")
	}
	ttl := time.Duration(ttlSeconds) * time.Second
	limit := ttlResourceMandate
	if sessionMandateAllowed {
		limit = ttlAuthorityRecordMandate
	}
	if ttl > limit {
		return 0, fmt.Errorf("ttl_seconds exceeds token TTL cap")
	}
	return ttl, nil
}

func claimString(claims map[string]any, key string) string {
	if claims == nil {
		return ""
	}
	value, _ := claims[key].(string)
	return value
}

func scopesAllowed(requested, available []string) bool {
	if len(requested) == 0 {
		return true
	}
	allowed := make(map[string]struct{}, len(available))
	for _, scope := range available {
		allowed[scope] = struct{}{}
	}
	for _, scope := range requested {
		if _, ok := allowed[scope]; !ok {
			return false
		}
	}
	return true
}

// lifecycleScope is the platform-reserved bootstrap scope. The decision contract owns
// its doctrine: bootstrap_exchange permits it exactly and alone, delegated_mint forbids
// it, and the bootstrap allow rule gates on resource ownership rather than declared
// scopes.
const lifecycleScope = "agent:lifecycle"

// resourceMintScopes returns the scopes mintable against a resource: its declared
// business scopes plus the platform-reserved lifecycle bootstrap scope for
// gateway-routed resources. Declared scopes stay the adopter's business vocabulary,
// and the lifecycle invariant holds identically for every creation surface instead of
// depending on clients stamping the scope into the resource row.
func resourceMintScopes(resource *Resource) []string {
	if resource.UpstreamURL == nil || slices.Contains(resource.Scopes, lifecycleScope) {
		return resource.Scopes
	}
	return append(append(make([]string, 0, len(resource.Scopes)+1), resource.Scopes...), lifecycleScope)
}

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func writeError(w http.ResponseWriter, code int, err *sharederr.CaracalError) {
	if err.RequestID == "" {
		err.RequestID = w.Header().Get("X-Request-Id")
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(err)
}

func writeStepUp(w http.ResponseWriter, requestID string, challenge *challengeState) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("WWW-Authenticate", `Bearer error="interaction_required"`)
	w.WriteHeader(http.StatusUnauthorized)
	json.NewEncoder(w).Encode(StepUpChallenge{
		Error:              "interaction_required",
		ErrorDescription:   "Human approval required for this request",
		ChallengeID:        challenge.ID,
		ChallengeType:      challenge.ChallengeType,
		State:              challenge.State,
		Tier:               challenge.Tier,
		Binding:            hex.EncodeToString(challenge.Binding),
		ChallengeExpiresAt: challenge.ExpiresAt.Format(time.RFC3339),
		RequestID:          requestID,
	})
}
