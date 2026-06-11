// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Token exchange handler: authenticates, evaluates policy per resource, issues JWT.

package internal

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	sharederr "github.com/garudex-labs/caracal/packages/core/go/errors"
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
	ttlResourceMandate     = 15 * time.Minute
	ttlSessionMandate      = 60 * time.Minute
	gatewayExchangeSkew    = 60 * time.Second
	controlInvokeTrait     = "control:invoke"
	controlScopeTrait      = "control:scope:"
	controlMaxTTLTrait     = "control:max-ttl:"
	controlExpiresTrait    = "control:expires:"
	defaultControlAudience = "caracal-control"
	providerTokenCacheSkew = 30 * time.Second
)

type delegationProof struct {
	edge        *DelegationEdge
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
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)
	if err := r.ParseForm(); err != nil {
		writeError(w, http.StatusBadRequest, sharederr.New(sharederr.InvalidToken, "malformed request body"))
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
	runtimeCredentialInjection := false
	if rawRuntimeInjection := r.FormValue("runtime_credential_injection"); rawRuntimeInjection != "" {
		if rawRuntimeInjection != "true" && rawRuntimeInjection != "false" {
			writeError(w, http.StatusBadRequest, sharederr.New(sharederr.InvalidToken, "invalid runtime_credential_injection"))
			return
		}
		runtimeCredentialInjection = rawRuntimeInjection == "true"
	}

	requestID := r.Header.Get("X-Request-Id")
	if requestID == "" {
		id, err := uuid.NewV7()
		if err != nil {
			s.log.Error().Err(err).Msg("request id generation failed")
			writeError(w, http.StatusInternalServerError, sharederr.New(sharederr.Internal, "generate request id"))
			return
		}
		requestID = id.String()
	}
	gatewayAuthenticated, gatewayErr := s.verifyGatewayExchange(r, requestID)
	if gatewayErr != nil {
		writeError(w, http.StatusUnauthorized, sharederr.New(sharederr.AccessDenied, "invalid gateway exchange signature"))
		return
	}

	req := TokenExchangeRequest{
		GrantType:                  r.FormValue("grant_type"),
		SubjectToken:               r.FormValue("subject_token"),
		SubjectTokenType:           r.FormValue("subject_token_type"),
		ActorToken:                 r.FormValue("actor_token"),
		Resources:                  r.Form["resource"],
		Scope:                      r.FormValue("scope"),
		ZoneID:                     r.FormValue("zone_id"),
		ApplicationID:              r.FormValue("application_id"),
		ClientSecret:               r.FormValue("client_secret"),
		ClientAssertion:            r.FormValue("client_assertion"),
		ClientAssertionType:        r.FormValue("client_assertion_type"),
		ChallengeID:                r.FormValue("challenge_id"),
		ChallengeResponse:          r.FormValue("challenge_response"),
		SessionID:                  r.FormValue("session_id"),
		AgentSessionID:             r.FormValue("agent_session_id"),
		DelegationEdgeID:           r.FormValue("delegation_edge_id"),
		TTLSeconds:                 ttlSeconds,
		GatewayAuthenticated:       gatewayAuthenticated,
		RuntimeCredentialInjection: runtimeCredentialInjection,
	}

	resp, challenge, code, apiErr := s.exchange(r.Context(), req, requestID)
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
	if gatewayRequestID != requestID {
		return false, fmt.Errorf("gateway request id mismatch")
	}
	if err := corests.VerifyGatewayExchange(s.cfg.GatewayHMACKey, time.Now().UTC(), gatewayExchangeSkew, timestamp, gatewayRequestID, signature, r.Method, r.URL.EscapedPath(), []byte(r.PostForm.Encode())); err != nil {
		return false, err
	}
	if err := s.consumeGatewayNonce(r.Context(), gatewayRequestID); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Server) exchange(ctx context.Context, req TokenExchangeRequest, requestID string) (*TokenResponse, *challengeState, int, *sharederr.CaracalError) {
	app, zoneID, err := s.authenticateApp(ctx, req)
	if err != nil {
		return nil, nil, http.StatusUnauthorized, sharederr.New(sharederr.AccessDenied, "invalid client credentials")
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
		subjectClaims, err = s.validateSubjectToken(ctx, req.SubjectToken, zoneID)
		if err != nil {
			return nil, nil, http.StatusUnauthorized, sharederr.New(sharederr.InvalidToken, "invalid subject_token")
		}
		sid, serr := s.validateTokenSession(ctx, zoneID, app.ID, req.SessionID, subjectClaims)
		if serr != nil {
			return nil, nil, http.StatusForbidden, serr
		}
		if req.SessionID == "" {
			req.SessionID = sid
		}
		if aerr := bindSubjectAgentSession(&req, subjectClaims); aerr != nil {
			return nil, nil, http.StatusForbidden, aerr
		}
	}

	actorClaims := map[string]any{}
	if req.ActorToken != "" {
		actorClaims, err = s.validateSubjectToken(ctx, req.ActorToken, zoneID)
		if err != nil {
			return nil, nil, http.StatusUnauthorized, sharederr.New(sharederr.InvalidToken, "invalid actor_token")
		}
		if _, serr := s.validateTokenSession(ctx, zoneID, app.ID, "", actorClaims); serr != nil {
			return nil, nil, http.StatusForbidden, serr
		}
		if sameTokenPrincipal(subjectClaims, actorClaims) {
			return nil, nil, http.StatusBadRequest, sharederr.New(sharederr.InvalidToken, "actor_token and subject_token must identify distinct principals")
		}
	}
	// client_id is the authenticated calling application; it is published on a separate
	// key so it never shadows actor token claims (which carry a distinct application id).
	actorClaims["caracal_client_id"] = app.ID

	principalID := app.ID
	if sub := claimString(subjectClaims, "sub"); sub != "" {
		principalID = sub
	}

	challengeResolved := false
	if req.ChallengeID != "" || req.ChallengeResponse != "" {
		if ok, _ := s.stepUpThrottle.Allow(zoneID, principalID); !ok {
			if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "challenge_cooldown", &OPAResult{}, appMeta); auditErr != nil {
				return nil, nil, http.StatusInternalServerError, auditErr
			}
			return nil, nil, http.StatusTooManyRequests, sharederr.New(sharederr.AccessDenied, "too many failed step-up attempts; try again later")
		}
		if cerr := s.verifyAndConsumeChallenge(ctx, zoneID, principalID, req.ChallengeID, req.ChallengeResponse, req.Resources); cerr != nil {
			s.stepUpThrottle.RecordFailure(zoneID, principalID)
			if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "challenge_invalid", &OPAResult{}, appMeta); auditErr != nil {
				return nil, nil, http.StatusInternalServerError, auditErr
			}
			return nil, nil, http.StatusUnauthorized, sharederr.New(sharederr.AccessDenied, "challenge not satisfied or expired")
		}
		s.stepUpThrottle.RecordSuccess(zoneID, principalID)
		challengeResolved = true
	}
	delegation, agentSession, refErr := s.validateSessionReferences(ctx, zoneID, app.ID, req, subjectClaims != nil)
	if refErr != nil {
		return nil, nil, http.StatusForbidden, refErr
	}

	delegationMeta := delegationAuditMeta(delegation)

	scopes := strings.Fields(req.Scope)
	var grantedResources []string
	grantedDirectives := map[string]UpstreamDirective{}
	grantedResourceRows := map[string]*Resource{}
	var pendingChallenge *challengeState
	stepUpType := ""
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
		if !scopesAllowed(scopes, resource.Scopes) {
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

		providerCredentialAccess := req.GatewayAuthenticated || req.RuntimeCredentialInjection
		if req.RuntimeCredentialInjection && resource.CredentialProviderID == nil {
			if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "credential_not_provisioned", &OPAResult{},
				mergeAuditMeta(appMeta, map[string]any{"resource": resource.Identifier, "reason": "no_provider"})); auditErr != nil {
				return nil, nil, http.StatusInternalServerError, auditErr
			}
			continue
		}
		if providerCredentialAccess && resource.CredentialProviderID != nil {
			provider, perr := s.db.GetProvider(ctx, *resource.CredentialProviderID)
			if perr != nil {
				if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "provider_unavailable", &OPAResult{},
					mergeAuditMeta(appMeta, map[string]any{"resource": resource.Identifier, "reason": "provider_not_found"})); auditErr != nil {
					return nil, nil, http.StatusInternalServerError, auditErr
				}
				continue
			}
			if req.RuntimeCredentialInjection {
				providerCfg, cfgErr := providerDirectiveConfig(provider.ConfigJSON)
				if cfgErr != nil {
					if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "provider_unavailable", &OPAResult{},
						mergeAuditMeta(appMeta, map[string]any{"resource": resource.Identifier, "reason": "provider_config_invalid"})); auditErr != nil {
						return nil, nil, http.StatusInternalServerError, auditErr
					}
					continue
				}
				kind := derefStr(provider.ProviderKind)
				if !providerCfg.AllowRuntimeInjection || kind == "none" || kind == "caracal_mandate" {
					if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "credential_injection_denied", &OPAResult{},
						mergeAuditMeta(appMeta, map[string]any{"resource": resource.Identifier, "reason": "runtime_injection_not_allowed"})); auditErr != nil {
						return nil, nil, http.StatusInternalServerError, auditErr
					}
					continue
				}
			}
			if providerRequiresUserGrant(provider) {
				userID, _ := subjectClaims["sub"].(string)
				if userID == "" {
					if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "credential_not_provisioned", &OPAResult{},
						mergeAuditMeta(appMeta, map[string]any{"resource": resource.Identifier, "reason": "no_user_principal"})); auditErr != nil {
						return nil, nil, http.StatusInternalServerError, auditErr
					}
					continue
				}
				if rerr := s.tryRefreshBrokeredGrant(ctx, zoneID, userID, resource.ID, resource.CredentialProviderID); rerr != nil {
					if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "credential_refresh_failed", &OPAResult{},
						mergeAuditMeta(appMeta, map[string]any{"resource": resource.Identifier, "reason": string(rerr.Code)})); auditErr != nil {
						return nil, nil, http.StatusInternalServerError, auditErr
					}
					continue
				}
				grant, gerr := s.db.GetProviderGrant(ctx, zoneID, userID, resource.ID, resource.CredentialProviderID)
				if gerr != nil || grant == nil || len(grant.AccessTokenCt) == 0 {
					if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "credential_not_provisioned", &OPAResult{},
						mergeAuditMeta(appMeta, map[string]any{"resource": resource.Identifier, "reason": "no_provider_grant"})); auditErr != nil {
						return nil, nil, http.StatusInternalServerError, auditErr
					}
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
				AgentSessionID:     req.AgentSessionID,
				Lifecycle:          agentSessionLifecycle(agentSession),
				Labels:             agentSessionLabels(agentSession),
			},
			Resource: OPAResource{
				Type:       "Resource",
				ID:         resource.ID,
				Identifier: resource.Identifier,
				Scopes:     resource.Scopes,
			},
			Action:         OPAAction{ID: "TokenExchange"},
			Session:        sessionInput(req.SessionID),
			DelegationEdge: delegationEdgeInput(delegation),
			Context: OPAContext{
				ActorClaims:       actorClaims,
				SubjectClaims:     subjectClaims,
				TraceID:           requestID,
				SessionID:         req.SessionID,
				AgentSessionID:    req.AgentSessionID,
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
				"resource":                     resource.Identifier,
				"requested_scopes":             scopes,
				"session_id":                   req.SessionID,
				"agent_session_id":             req.AgentSessionID,
				"delegation_edge_id":           req.DelegationEdgeID,
				"runtime_credential_injection": req.RuntimeCredentialInjection,
			}), agentAuditMeta(agentSession)), delegationMeta), bundle); auditErr != nil {
			return nil, nil, http.StatusInternalServerError, auditErr
		}

		// Only an explicit "complete" status is treated as a usable decision; any
		// other value (partial, error, future enum) is a hard deny so an unknown
		// state cannot silently grant access.
		if result.EvaluationStatus != "complete" {
			return nil, nil, http.StatusForbidden, sharederr.New(sharederr.PolicyEvalFailed, "policy evaluation incomplete")
		}

		if !challengeResolved {
			if t := stepUpRequired(result); t != "" {
				stepUpType = t
			}
		}

		if result.Decision == "allow" {
			grantedResources = append(grantedResources, resource.Identifier)
			grantedResourceRows[resource.Identifier] = resource
		}
	}

	if !challengeResolved && stepUpType != "" {
		c, cErr := s.createChallenge(ctx, zoneID, req.SessionID, principalID, stepUpType, req.Resources)
		if cErr != nil {
			return nil, nil, http.StatusInternalServerError, sharederr.New(sharederr.Internal, "challenge creation failed")
		}
		pendingChallenge = c
	}

	if pendingChallenge != nil {
		return nil, pendingChallenge, http.StatusUnauthorized, nil
	}

	if len(grantedResources) == 0 {
		if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "exchange_denied", &OPAResult{},
			mergeAuditMeta(appMeta, map[string]any{"requested": req.Resources})); auditErr != nil {
			return nil, nil, http.StatusInternalServerError, auditErr
		}
		return nil, nil, http.StatusForbidden, sharederr.New(sharederr.AccessDenied, "policy denied")
	}

	if req.SubjectToken != "" && !req.GatewayAuthenticated {
		return nil, nil, http.StatusForbidden, sharederr.New(sharederr.AccessDenied, "resource exchanges must use the Gateway")
	}

	sid, err := uuid.NewV7()
	if err != nil {
		return nil, nil, http.StatusInternalServerError, sharederr.New(sharederr.Internal, "generate session id")
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
		sessionType = "user"
	}

	subType := SubTypeApplication
	if sessionType == "user" {
		subType = SubTypeUser
	}
	// Gateway exchanges mint resource mandates. Exchanges minted without a
	// subject_token bootstrap a session mandate that the application presents to
	// Gateway for resource-scoped narrowing.
	use := UseResource
	if req.SubjectToken == "" && !controlKeyExchange {
		use = UseSession
	}

	sess := &Session{
		ID:              sessID,
		ZoneID:          zoneID,
		SessionType:     sessionType,
		SubjectID:       &subjectID,
		ParentID:        parentSessionID(req.SessionID, use),
		Status:          "active",
		ExpiresAt:       now.Add(ttl),
		AuthenticatedAt: now,
	}
	if err := s.db.InsertSession(ctx, sess); err != nil {
		return nil, nil, http.StatusInternalServerError, sharederr.New(sharederr.Internal, "session creation failed")
	}

	issueParams := IssueParams{
		ZoneID:         zoneID,
		AppID:          app.ID,
		SubjectID:      subjectID,
		SubType:        subType,
		Use:            use,
		SID:            sessID,
		RootSID:        rootSessionID(subjectClaims, sessID, use),
		Scopes:         req.Scope,
		Resources:      grantedResources,
		TTL:            ttl,
		AgentSessionID: req.AgentSessionID,
		IssuedAt:       now,
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

	if req.GatewayAuthenticated || req.RuntimeCredentialInjection {
		for _, identifier := range grantedResources {
			directive, err := s.buildUpstreamDirective(ctx, zoneID, subjectClaims, grantedResourceRows[identifier], req.GatewayAuthenticated || req.RuntimeCredentialInjection, req.RuntimeCredentialInjection)
			if err != nil {
				return nil, nil, http.StatusInternalServerError, sharederr.New(sharederr.Internal, "upstream directive build failed")
			}
			grantedDirectives[identifier] = directive
		}
	}

	return &TokenResponse{
		AccessToken:     token,
		TokenType:       "Bearer",
		ExpiresIn:       int(ttl.Seconds()),
		Scope:           req.Scope,
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
		if !cfg.AllowRuntimeInjection || kind == "none" || kind == "caracal_mandate" {
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
		grant, err := s.db.GetProviderGrant(ctx, zoneID, userID, resource.ID, resource.CredentialProviderID)
		if err != nil || grant == nil || len(grant.AccessTokenCt) == 0 {
			return directive, fmt.Errorf("provider grant unavailable")
		}
		if grant.ProviderID == nil || *grant.ProviderID != provider.ID {
			return directive, fmt.Errorf("provider grant missing provider")
		}
		at, err := openZEK(s.keys.zek, grant.AccessTokenCt)
		if err != nil {
			return directive, fmt.Errorf("provider grant decrypt failed")
		}
		directive.ProviderToken = string(at)
		directive.GrantID = grant.ID
		if grant.ExpiresAt != nil {
			directive.ExpiresAt = grant.ExpiresAt.Unix()
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
	KeyID             string            `json:"key_id"`
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
	secretConfig, err := openProviderSecretConfig(s.keys.zek, provider)
	if err != nil {
		return "", fmt.Errorf("provider secret decrypt failed")
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
	case "oauth2_client_credentials":
		var cfg oauthClientCredentialsConfig
		if err := json.Unmarshal(provider.ConfigJSON, &cfg); err != nil || cfg.TokenEndpoint == "" || cfg.ClientID == "" {
			return "", fmt.Errorf("provider oauth2 config invalid")
		}
		fingerprint := providerServiceTokenFingerprint(provider)
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
	tokenEndpoint, err := validateTokenEndpoint(cfg.TokenEndpoint, cfg.AllowedTokenHosts)
	if err != nil {
		return "", time.Time{}, err
	}
	if s.providerCircuitOpen(ctx, provider.ID) {
		return "", time.Time{}, fmt.Errorf("provider token circuit open")
	}
	form, err := oauthClientCredentialsForm(cfg)
	if err != nil {
		return "", time.Time{}, err
	}
	body, err := s.refreshProviderToken(ctx, provider.ID, tokenEndpoint, form, cfg.ClientID, secretConfig.ClientSecret, cfg.ClientAuthMethod, cfg.KeyID, secretConfig.PrivateKey)
	if err != nil {
		return "", time.Time{}, err
	}
	var tokenResp struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &tokenResp); err != nil || tokenResp.AccessToken == "" {
		return "", time.Time{}, fmt.Errorf("provider token response invalid")
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

func providerServiceTokenFingerprint(provider *ProviderConfig) string {
	h := sha256.New()
	h.Write([]byte(derefStr(provider.ProviderKind)))
	h.Write([]byte{0})
	h.Write(provider.ConfigJSON)
	h.Write([]byte{0})
	h.Write(provider.SecretConfigCt)
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
		credential := req.ClientSecret
		if credential == "" {
			credential = req.ClientAssertion
		}
		ok := verifyClientSecret(*app.ClientSecretHash, credential)
		if !ok {
			return nil, "", errSecretMismatch
		}
	} else {
		return nil, "", fmt.Errorf("client secret not configured")
	}
	return app, zoneID, nil
}

func isZoneDerivedControlTokenRequest(req TokenExchangeRequest) bool {
	if req.SubjectToken != "" || req.ActorToken != "" || req.SessionID != "" || req.AgentSessionID != "" || req.DelegationEdgeID != "" {
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
	zoneKeys, err := s.keys.getPublicKeysByZone(ctx, zoneID)
	if err != nil {
		return nil, fmt.Errorf("get zone keys: %w", err)
	}
	mc := jwt.MapClaims{}
	_, err = jwt.NewParser(
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
	if claimString(mc, "use") != UseSession {
		return nil, errors.New("subject_token must be a session mandate")
	}
	return mc, nil
}

func (s *Server) validateTokenSession(ctx context.Context, zoneID, appID, sessionID string, claims map[string]any) (string, *sharederr.CaracalError) {
	sid := claimString(claims, "sid")
	if sid == "" {
		return "", sharederr.New(sharederr.InvalidToken, "missing token session")
	}
	if sessionID != "" && sessionID != sid {
		return "", sharederr.New(sharederr.AccessDenied, "session mismatch")
	}
	now, err := s.db.CurrentTime(ctx)
	if err != nil {
		return "", sharederr.New(sharederr.STSUnavailable, "trusted time unavailable")
	}
	session, err := s.db.GetSession(ctx, sid)
	if err != nil || session.ZoneID != zoneID || session.Status != "active" || !session.ExpiresAt.After(now) {
		return "", sharederr.New(sharederr.AccessDenied, "session inactive or expired")
	}
	// Defense in depth: even with a valid signature, the session row's
	// subject must match the JWT sub claim. A leaked signing key or any
	// other path that could mint a structurally-valid token still fails
	// this bind unless the session row was also tampered with.
	sub := claimString(claims, "sub")
	if sub == "" || session.SubjectID == nil || *session.SubjectID != sub {
		return "", sharederr.New(sharederr.AccessDenied, "session subject mismatch")
	}
	if clientID := claimString(claims, "client_id"); clientID == "" || clientID != appID {
		return "", sharederr.New(sharederr.AccessDenied, "session client mismatch")
	}
	return sid, nil
}

func parentSessionID(sessionID string, use string) *string {
	if use != UseResource || sessionID == "" {
		return nil
	}
	return &sessionID
}

func rootSessionID(claims map[string]any, sid string, use string) string {
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
	if req.SubjectToken != "" || req.ActorToken != "" || req.SessionID != "" || req.AgentSessionID != "" || req.DelegationEdgeID != "" {
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
			"agent_session_id":   h.AgentSessionID,
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

func stepUpRequired(result *OPAResult) string {
	for _, d := range result.Diagnostics {
		if ct, ok := d["step_up_required"].(string); ok {
			return ct
		}
	}
	return ""
}

func sessionInput(sessionID string) *OPASession {
	if sessionID == "" {
		return nil
	}
	return &OPASession{ID: sessionID}
}

func agentSessionLifecycle(session *AgentSession) string {
	if session == nil {
		return ""
	}
	return session.Lifecycle
}

func agentSessionLabels(session *AgentSession) []string {
	if session == nil || len(session.Labels) == 0 {
		return nil
	}
	return append([]string(nil), session.Labels...)
}

func agentAuditMeta(session *AgentSession) map[string]any {
	if session == nil {
		return nil
	}
	meta := map[string]any{
		"agent_lifecycle": session.Lifecycle,
		"agent_labels":    agentSessionLabels(session),
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

func bindSubjectAgentSession(req *TokenExchangeRequest, claims map[string]any) *sharederr.CaracalError {
	agentSessionID := claimString(claims, "agent_session_id")
	if agentSessionID == "" {
		return nil
	}
	if req.AgentSessionID != "" && req.AgentSessionID != agentSessionID {
		return sharederr.New(sharederr.AccessDenied, "agent session mismatch")
	}
	req.AgentSessionID = agentSessionID
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

// validateAgentSessionOwnership binds the asserted agent_session_id to the calling
// application: the row must exist, be active in this zone, and be owned by app.ID.
// This stops two apps in a zone from forging each other's agent identity by passing
// a peer's agent_session_id.
func (s *Server) validateAgentSessionOwnership(ctx context.Context, zoneID, appID, agentSessionID string) (*AgentSession, *sharederr.CaracalError) {
	now, err := s.db.CurrentTime(ctx)
	if err != nil {
		return nil, sharederr.New(sharederr.STSUnavailable, "trusted time unavailable")
	}
	session, err := s.db.GetAgentSession(ctx, agentSessionID)
	if err != nil || !activeAgentSession(session, zoneID, now) {
		return nil, sharederr.New(sharederr.AccessDenied, "agent session inactive or expired")
	}
	if session.ApplicationID != appID {
		return nil, sharederr.New(sharederr.AccessDenied, "agent session not owned by caller")
	}
	return session, nil
}

// validateSessionReferences is the single source of truth for binding a token
// exchange to user/agent sessions and delegation edges. When a delegation_edge_id
// is present the receiving target agent session's ownership is verified inside
// the delegation block (target.ApplicationID == appID); otherwise the calling
// application's ownership of the asserted agent_session_id is verified directly,
// preventing peer-app forgery through either path.
func (s *Server) validateSessionReferences(ctx context.Context, zoneID, appID string, req TokenExchangeRequest, hasSubjectToken bool) (*delegationProof, *AgentSession, *sharederr.CaracalError) {
	now, err := s.db.CurrentTime(ctx)
	if err != nil {
		return nil, nil, sharederr.New(sharederr.STSUnavailable, "trusted time unavailable")
	}
	if req.SessionID != "" {
		session, err := s.db.GetSession(ctx, req.SessionID)
		if err != nil || session.ZoneID != zoneID || session.Status != "active" || !session.ExpiresAt.After(now) {
			return nil, nil, sharederr.New(sharederr.AccessDenied, "session inactive or expired")
		}
		// Application-principal flows (no subject_token) must assert a
		// session owned by the calling app. Without this, peer apps in a
		// zone could pass another app's session_id and have OPA evaluate
		// against a session reputation/state that is not their own.
		if !hasSubjectToken {
			if session.SessionType != "application" || session.SubjectID == nil || *session.SubjectID != appID {
				return nil, nil, sharederr.New(sharederr.AccessDenied, "session not owned by caller")
			}
		}
	}
	if req.AgentSessionID != "" && req.DelegationEdgeID == "" {
		agentSession, aerr := s.validateAgentSessionOwnership(ctx, zoneID, appID, req.AgentSessionID)
		if aerr != nil {
			return nil, nil, aerr
		}
		return nil, agentSession, nil
	}
	if req.DelegationEdgeID == "" {
		return nil, nil, nil
	}
	if req.AgentSessionID == "" {
		return nil, nil, sharederr.New(sharederr.AccessDenied, "delegation edge requires target agent session")
	}
	edge, err := s.db.GetDelegationEdge(ctx, req.DelegationEdgeID)
	if err != nil || edge.ZoneID != zoneID || edge.Status != "active" || !edge.ExpiresAt.After(now) || edge.RevokedAt != nil {
		return nil, nil, sharederr.New(sharederr.AccessDenied, "delegation edge inactive or expired")
	}
	if edge.TargetSessionID != req.AgentSessionID {
		return nil, nil, sharederr.New(sharederr.AccessDenied, "delegation edge target mismatch")
	}
	source, err := s.db.GetAgentSession(ctx, edge.SourceSessionID)
	if err != nil || !activeAgentSession(source, zoneID, now) {
		return nil, nil, sharederr.New(sharederr.AccessDenied, "delegation source inactive or expired")
	}
	target, err := s.db.GetAgentSession(ctx, edge.TargetSessionID)
	if err != nil || !activeAgentSession(target, zoneID, now) || target.ApplicationID != appID {
		return nil, nil, sharederr.New(sharederr.AccessDenied, "delegation target inactive or unauthorized")
	}
	if source.ApplicationID != edge.IssuerAppID || target.ApplicationID != edge.ReceiverAppID {
		return nil, nil, sharederr.New(sharederr.AccessDenied, "delegation application mismatch")
	}
	constraints, err := parseDelegationConstraints(edge.ConstraintsJSON)
	if err != nil {
		return nil, nil, sharederr.New(sharederr.AccessDenied, "delegation constraints invalid")
	}
	if !scopesAllowed(strings.Fields(req.Scope), edge.Scopes) {
		return nil, nil, sharederr.New(sharederr.AccessDenied, "requested scopes exceed delegation scopes")
	}
	if constraints.Budget > 0 && len(strings.Fields(req.Scope)) > constraints.Budget {
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
	path, err := s.db.GetDelegationPath(ctx, zoneID, edge.SourceSessionID, edge.TargetSessionID, constraints.MaxHops)
	if err != nil || len(path) == 0 || len(path) > constraints.MaxHops || !containsString(path, edge.ID) {
		if s.metrics != nil {
			s.metrics.GraphTraversalErrors.Add(1)
		}
		return nil, nil, sharederr.New(sharederr.AccessDenied, "delegation path invalid")
	}
	graphEpoch, err := s.db.GetDelegationGraphEpoch(ctx, zoneID)
	if err != nil {
		return nil, nil, sharederr.New(sharederr.AccessDenied, "delegation graph epoch unavailable")
	}
	chain, chainErr := s.buildDelegationChain(ctx, path, edge, source, target, now)
	if chainErr != nil {
		return nil, nil, chainErr
	}
	return &delegationProof{edge: edge, constraints: constraints, path: path, chain: chain, graphEpoch: graphEpoch}, target, nil
}

// buildDelegationChain resolves each edge id along the path to a chain hop the
// resource side can audit and authorize against. The chain walks from the
// originating issuer to the immediate receiver in order.
func (s *Server) buildDelegationChain(ctx context.Context, path []string, edge *DelegationEdge, source, target *AgentSession, now time.Time) ([]ChainHop, *sharederr.CaracalError) {
	if len(path) == 0 {
		return nil, nil
	}
	hops := make([]ChainHop, 0, len(path)+1)
	var prevReceiverApp string
	for _, edgeID := range path {
		var hopEdge *DelegationEdge
		if edgeID == edge.ID {
			hopEdge = edge
		} else {
			fetched, err := s.db.GetDelegationEdge(ctx, edgeID)
			if err != nil || fetched == nil {
				return nil, sharederr.New(sharederr.AccessDenied, "delegation path edge unavailable")
			}
			hopEdge = fetched
		}
		// Re-validate each path edge against current state. GetDelegationPath
		// filters in SQL, but a revoke racing the path computation could
		// otherwise let a stale-but-attested chain hop ship in the JWT.
		if hopEdge.ZoneID != edge.ZoneID || hopEdge.Status != "active" || hopEdge.RevokedAt != nil || !hopEdge.ExpiresAt.After(now) {
			return nil, sharederr.New(sharederr.AccessDenied, "delegation path edge inactive or revoked")
		}
		if prevReceiverApp != "" && hopEdge.IssuerAppID != prevReceiverApp {
			return nil, sharederr.New(sharederr.AccessDenied, "delegation chain discontinuous")
		}
		hops = append(hops, ChainHop{
			AppID:            hopEdge.IssuerAppID,
			AgentSessionID:   hopEdge.SourceSessionID,
			DelegationEdgeID: hopEdge.ID,
		})
		prevReceiverApp = hopEdge.ReceiverAppID
	}
	hops = append(hops, ChainHop{
		AppID:          edge.ReceiverAppID,
		AgentSessionID: target.ID,
	})
	if hops[0].AppID != source.ApplicationID || hops[len(hops)-1].AppID != target.ApplicationID {
		return nil, sharederr.New(sharederr.AccessDenied, "delegation chain endpoints mismatch")
	}
	return hops, nil
}

func parseDelegationConstraints(raw json.RawMessage) (delegationConstraints, error) {
	var constraints delegationConstraints
	if len(raw) == 0 {
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
		return 0, fmt.Errorf("delegation edge inactive or expired")
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

func activeAgentSession(session *AgentSession, zoneID string, now time.Time) bool {
	if session == nil || session.ZoneID != zoneID || session.Status != "active" {
		return false
	}
	if session.Lifecycle == "service" {
		return session.HeartbeatDeadlineAt != nil && session.HeartbeatDeadlineAt.After(now)
	}
	if session.TTLSeconds <= 0 {
		return false
	}
	return session.SpawnedAt.Add(time.Duration(session.TTLSeconds) * time.Second).After(now)
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
		limit = ttlSessionMandate
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

func sameTokenPrincipal(subjectClaims, actorClaims map[string]any) bool {
	subject := claimString(subjectClaims, "sub")
	actor := claimString(actorClaims, "sub")
	if subject == "" || actor == "" || subject != actor {
		return false
	}
	subjectClient := claimString(subjectClaims, "client_id")
	actorClient := claimString(actorClaims, "client_id")
	return subjectClient == "" || actorClient == "" || subjectClient == actorClient
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

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func writeError(w http.ResponseWriter, code int, err *sharederr.CaracalError) {
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
		ErrorDescription:   "Step-up authorization required for this resource",
		ChallengeID:        challenge.ID,
		ChallengeType:      challenge.ChallengeType,
		ChallengeSecret:    challenge.Secret,
		ChallengeExpiresAt: challenge.ExpiresAt.Format(time.RFC3339),
		RequestID:          requestID,
	})
}
