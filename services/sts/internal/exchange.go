// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Token exchange handler: authenticates, evaluates policy per resource, issues JWT.

package internal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
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
	// ttlPerCallSDK caps the lifetime of every per-call exchange. The gateway
	// re-exchanges on each request, so streams longer than this lifetime
	// (LLM completions, SSE, websockets) cannot rotate mid-stream. Callers
	// initiating long streams must treat ttlPerCallSDK as the contract upper
	// bound: streams running past it should expect upstream-side disconnect
	// or a fresh exchange and reconnect orchestrated by the SDK.
	ttlPerCallSDK          = 15 * time.Minute
	ttlAmbient             = 60 * time.Minute
	gatewayExchangeSkew    = 60 * time.Second
	controlInvokeTrait     = "control:invoke"
	defaultControlAudience = "caracal-control"
)

type delegationProof struct {
	edge        *DelegationEdge
	constraints delegationConstraints
	path        []string
	chain       []ChainHop
	graphEpoch  int64
}

type delegationConstraints struct {
	TTLSeconds int  `json:"ttl_seconds"`
	MaxHops    int  `json:"max_hops"`
	Budget     int  `json:"budget"`
	Approved   bool `json:"policy_approved"`
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
		GrantType:            r.FormValue("grant_type"),
		SubjectToken:         r.FormValue("subject_token"),
		SubjectTokenType:     r.FormValue("subject_token_type"),
		ActorToken:           r.FormValue("actor_token"),
		Resources:            r.Form["resource"],
		Scope:                r.FormValue("scope"),
		ZoneID:               r.FormValue("zone_id"),
		ApplicationID:        r.FormValue("application_id"),
		ClientSecret:         r.FormValue("client_secret"),
		ClientAssertion:      r.FormValue("client_assertion"),
		ClientAssertionType:  r.FormValue("client_assertion_type"),
		ChallengeID:          r.FormValue("challenge_id"),
		ChallengeResponse:    r.FormValue("challenge_response"),
		SessionID:            r.FormValue("session_id"),
		AgentSessionID:       r.FormValue("agent_session_id"),
		DelegationEdgeID:     r.FormValue("delegation_edge_id"),
		TTLSeconds:           ttlSeconds,
		GatewayAuthenticated: gatewayAuthenticated,
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
	if err := corests.VerifyGatewayExchange(s.cfg.GatewayHMACKey, time.Now().UTC(), gatewayExchangeSkew, timestamp, gatewayRequestID, signature, []byte(r.PostForm.Encode())); err != nil {
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
			if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "challenge_cooldown", &OPAResult{}, nil); auditErr != nil {
				return nil, nil, http.StatusInternalServerError, auditErr
			}
			return nil, nil, http.StatusTooManyRequests, sharederr.New(sharederr.AccessDenied, "too many failed step-up attempts; try again later")
		}
		if cerr := s.verifyAndConsumeChallenge(ctx, zoneID, principalID, req.ChallengeID, req.ChallengeResponse, req.Resources); cerr != nil {
			s.stepUpThrottle.RecordFailure(zoneID, principalID)
			if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "challenge_invalid", &OPAResult{}, nil); auditErr != nil {
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
				map[string]any{"resource": identifier}); auditErr != nil {
				return nil, nil, http.StatusInternalServerError, auditErr
			}
			continue
		}
		if !scopesAllowed(scopes, resource.Scopes) {
			if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "scope_mismatch", &OPAResult{},
				map[string]any{"resource": resource.Identifier}); auditErr != nil {
				return nil, nil, http.StatusInternalServerError, auditErr
			}
			continue
		}
		if delegation != nil && delegation.edge.ResourceID != nil && *delegation.edge.ResourceID != resource.ID {
			if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "resource_outside_delegation", &OPAResult{},
				map[string]any{"resource": resource.Identifier}); auditErr != nil {
				return nil, nil, http.StatusInternalServerError, auditErr
			}
			continue
		}

		if rateErr := s.checkRateLimit(ctx, zoneID, resource.ID, app.ID); rateErr != nil {
			if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "rate_limited", &OPAResult{},
				map[string]any{"resource": resource.Identifier}); auditErr != nil {
				return nil, nil, http.StatusInternalServerError, auditErr
			}
			continue
		}

		if isControlKeyExchange(app, req, resource, scopes) {
			result := &OPAResult{
				Decision:            "allow",
				DeterminingPolicies: []map[string]any{{"policy": "control-key"}},
				EvaluationStatus:    "complete",
				Diagnostics:         []map[string]any{},
			}
			if auditErr := s.emitAuditEvent(requestID, zoneID, result.Decision, result.EvaluationStatus, result,
				map[string]any{"resource": resource.Identifier}); auditErr != nil {
				return nil, nil, http.StatusInternalServerError, auditErr
			}
			grantedResources = append(grantedResources, resource.Identifier)
			grantedResourceRows[resource.Identifier] = resource
			controlKeyExchange = true
			continue
		}

		if resource.CredentialProviderID != nil {
			userID, _ := subjectClaims["sub"].(string)
			if userID == "" {
				// Provider-credentialed resources require a user-bound grant;
				// application-principal exchanges (no subject_token) cannot
				// produce a usable upstream credential.
				if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "credential_not_provisioned", &OPAResult{},
					map[string]any{"resource": resource.Identifier, "reason": "no_user_principal"}); auditErr != nil {
					return nil, nil, http.StatusInternalServerError, auditErr
				}
				continue
			}
			if rerr := s.tryRefreshBrokeredGrant(ctx, zoneID, userID, resource.ID, resource.CredentialProviderID); rerr != nil {
				if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "credential_refresh_failed", &OPAResult{},
					map[string]any{"resource": resource.Identifier, "reason": string(rerr.Code)}); auditErr != nil {
					return nil, nil, http.StatusInternalServerError, auditErr
				}
				continue
			}
			// Confirm we actually have a usable provider AT before letting
			// OPA approve. Without this, the directive build downstream
			// would silently fall back to caracal_jwt mode and the provider
			// would reject the request with no clear deny signal.
			grant, gerr := s.db.GetDelegatedGrant(ctx, zoneID, userID, resource.ID, resource.CredentialProviderID)
			if gerr != nil || grant == nil || len(grant.AccessTokenCt) == 0 {
				if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "credential_not_provisioned", &OPAResult{},
					map[string]any{"resource": resource.Identifier, "reason": "no_grant"}); auditErr != nil {
					return nil, nil, http.StatusInternalServerError, auditErr
				}
				continue
			}
		}

		opaInput := OPAInput{
			SchemaVersion: opaInputSchemaVersion,
			Principal: OPAPrincipal{
				Type:           "Application",
				ID:             app.ID,
				ZoneID:         zoneID,
				CredentialType: derefStr(app.CredentialType),
				AgentSessionID: req.AgentSessionID,
				AgentKind:      agentSessionKind(agentSession),
				Capabilities:   agentSessionCapabilities(agentSession),
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
				map[string]any{"resource": resource.Identifier}, bundle); auditErr != nil {
				return nil, nil, http.StatusInternalServerError, auditErr
			}
			return nil, nil, http.StatusServiceUnavailable, sharederr.New(sharederr.PolicyEvalFailed, "policy evaluation unavailable")
		}

		if auditErr := s.emitAuditEventWithBundle(requestID, zoneID, result.Decision, result.EvaluationStatus, result,
			mergeAuditMeta(mergeAuditMeta(map[string]any{
				"resource":           resource.Identifier,
				"requested_scopes":   scopes,
				"session_id":         req.SessionID,
				"agent_session_id":   req.AgentSessionID,
				"delegation_edge_id": req.DelegationEdgeID,
			}, agentAuditMeta(agentSession)), delegationMeta), bundle); auditErr != nil {
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
			map[string]any{"requested": req.Resources}); auditErr != nil {
			return nil, nil, http.StatusInternalServerError, auditErr
		}
		return nil, nil, http.StatusForbidden, sharederr.New(sharederr.AccessDenied, "policy denied")
	}

	sid, err := uuid.NewV7()
	if err != nil {
		return nil, nil, http.StatusInternalServerError, sharederr.New(sharederr.Internal, "generate session id")
	}
	sessID := sid.String()
	now := time.Now()
	ttl, ttlErr := tokenTTL(req.TTLSeconds, req.SubjectToken == "")
	if ttlErr != nil {
		return nil, nil, http.StatusBadRequest, sharederr.New(sharederr.InvalidToken, ttlErr.Error())
	}
	if ttl, ttlErr = effectiveTokenTTL(ttl, delegation, now); ttlErr != nil {
		return nil, nil, http.StatusForbidden, sharederr.New(sharederr.AccessDenied, ttlErr.Error())
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
	// Per-call by default. Tokens minted without a subject_token (first-mile
	// bootstrap of an application principal) are ambient session tokens so they
	// can be re-presented to STS for narrowing.
	use := UsePerCall
	if req.SubjectToken == "" && !controlKeyExchange {
		use = UseAmbient
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

	// Build per-resource upstream directives so the gateway can substitute the
	// provider-native credential where the resource expects one.
	for _, identifier := range grantedResources {
		directive, err := s.buildUpstreamDirective(ctx, zoneID, subjectClaims, grantedResourceRows[identifier], req.GatewayAuthenticated)
		if err != nil {
			return nil, nil, http.StatusInternalServerError, sharederr.New(sharederr.Internal, "upstream directive build failed")
		}
		grantedDirectives[identifier] = directive
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

func (s *Server) buildUpstreamDirective(ctx context.Context, zoneID string, subjectClaims map[string]any, resource *Resource, gatewayAuthenticated bool) (UpstreamDirective, error) {
	directive := UpstreamDirective{
		AuthMode:   UpstreamAuthCaracalJWT,
		AuthHeader: "Authorization",
		AuthScheme: "Bearer",
	}
	if resource.UpstreamURL != nil {
		directive.URL = *resource.UpstreamURL
	}
	if !gatewayAuthenticated || resource.CredentialProviderID == nil {
		return directive, nil
	}
	userID, _ := subjectClaims["sub"].(string)
	if userID == "" {
		return directive, fmt.Errorf("provider directive requires subject")
	}
	grant, err := s.db.GetDelegatedGrant(ctx, zoneID, userID, resource.ID, resource.CredentialProviderID)
	if err != nil || grant == nil || len(grant.AccessTokenCt) == 0 {
		return directive, fmt.Errorf("provider grant unavailable")
	}
	if grant.ProviderID == nil {
		return directive, fmt.Errorf("provider grant missing provider")
	}
	provider, err := s.db.GetProvider(ctx, *grant.ProviderID)
	if err != nil {
		return directive, fmt.Errorf("provider unavailable")
	}
	at, err := openZEK(s.keys.zek, grant.AccessTokenCt)
	if err != nil {
		return directive, fmt.Errorf("provider grant decrypt failed")
	}
	if err := applyProviderDirective(provider, &directive); err != nil {
		return directive, err
	}
	directive.ProviderToken = string(at)
	directive.ProviderID = provider.ID
	directive.GrantID = grant.ID
	if grant.ExpiresAt != nil {
		directive.ExpiresAt = grant.ExpiresAt.Unix()
	}
	return directive, nil
}

func applyProviderDirective(provider *ProviderConfig, directive *UpstreamDirective) error {
	cfg, err := providerDirectiveConfig(provider.ConfigJSON)
	if err != nil {
		return err
	}
	directive.ForwardCaracalIdentity = cfg.ForwardCaracalIdentity
	switch derefStr(provider.ProviderKind) {
	case "apikey":
		header := strings.TrimSpace(cfg.AuthHeader)
		if header == "" {
			header = strings.TrimSpace(cfg.HeaderName)
		}
		if !validProviderHeaderName(header) {
			return fmt.Errorf("provider api key header invalid")
		}
		directive.AuthMode = UpstreamAuthProviderAPIKey
		directive.AuthHeader = header
		directive.AuthScheme = strings.TrimSpace(cfg.AuthScheme)
	case "", "oauth2", "oidc":
		directive.AuthMode = UpstreamAuthProviderOAuth
		if header := strings.TrimSpace(cfg.AuthHeader); header != "" {
			if !validProviderHeaderName(header) {
				return fmt.Errorf("provider auth header invalid")
			}
			directive.AuthHeader = header
		}
		if scheme := strings.TrimSpace(cfg.AuthScheme); scheme != "" {
			directive.AuthScheme = scheme
		}
	default:
		return fmt.Errorf("provider kind unsupported")
	}
	return nil
}

type providerForwardingConfig struct {
	AuthHeader             string `json:"auth_header"`
	HeaderName             string `json:"header_name"`
	AuthScheme             string `json:"auth_scheme"`
	ForwardCaracalIdentity bool   `json:"forward_caracal_identity"`
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

func (s *Server) authenticateApp(ctx context.Context, req TokenExchangeRequest) (*Application, string, error) {
	zoneID := strings.TrimSpace(req.ZoneID)
	appID := strings.TrimSpace(req.ApplicationID)
	if zoneID == "" || appID == "" {
		return nil, "", fmt.Errorf("missing zone_id or application_id")
	}
	app, err := s.db.GetApplicationByID(ctx, appID, zoneID)
	if err != nil {
		return nil, "", err
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
	} else if derefStr(app.CredentialType) == "public" {
		return nil, "", fmt.Errorf("public clients are not supported: register a confidential application (client_secret) to issue tokens")
	} else {
		return nil, "", fmt.Errorf("client secret not configured")
	}
	return app, zoneID, nil
}

// validateSubjectToken verifies an inbound STS-issued token: ES256 signature, this STS
// as issuer, the issuer audience, a matching zone_id, and use=ambient. Per-call tokens
// are deliberately rejected here (RFC 8693 §2.1 subject-confusion mitigation): a token
// already narrowed to resources A,B must not bootstrap the minting of one for resource C.
func (s *Server) validateSubjectToken(ctx context.Context, tokenStr, zoneID string) (map[string]any, error) {
	pub, _, err := s.keys.getPublicKeyAndKid(ctx, zoneID)
	if err != nil {
		return nil, fmt.Errorf("get zone key: %w", err)
	}
	mc := jwt.MapClaims{}
	_, err = jwt.NewParser(
		jwt.WithValidMethods([]string{"ES256"}),
		jwt.WithIssuer(s.cfg.IssuerURL),
		jwt.WithAudience(s.cfg.IssuerURL),
		jwt.WithExpirationRequired(),
		jwt.WithIssuedAt(),
		jwt.WithLeeway(60*time.Second),
	).ParseWithClaims(tokenStr, mc, func(*jwt.Token) (any, error) {
		return pub, nil
	})
	if err != nil {
		return nil, err
	}
	if claimString(mc, "zone_id") != zoneID {
		return nil, errors.New("token zone mismatch")
	}
	if claimString(mc, "use") != UseAmbient {
		return nil, errors.New("subject_token must be an ambient session token")
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
	session, err := s.db.GetSession(ctx, sid)
	if err != nil || session.ZoneID != zoneID || session.Status != "active" || !session.ExpiresAt.After(time.Now()) {
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
	if use != UsePerCall || sessionID == "" {
		return nil
	}
	return &sessionID
}

func rootSessionID(claims map[string]any, sid string, use string) string {
	if use == UseAmbient {
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

func isControlKeyExchange(app *Application, req TokenExchangeRequest, resource *Resource, scopes []string) bool {
	if resource.Identifier != controlAudience() || !hasApplicationTrait(app, controlInvokeTrait) {
		return false
	}
	if req.SubjectToken != "" || req.ActorToken != "" || req.SessionID != "" || req.AgentSessionID != "" || req.DelegationEdgeID != "" {
		return false
	}
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

// mergeAuditMeta merges extra key/value pairs into base, returning base.
func mergeAuditMeta(base, extra map[string]any) map[string]any {
	for k, v := range extra {
		base[k] = v
	}
	return base
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

func agentSessionKind(session *AgentSession) string {
	if session == nil {
		return ""
	}
	return session.Kind
}

func agentSessionCapabilities(session *AgentSession) []string {
	if session == nil || len(session.Capabilities) == 0 {
		return nil
	}
	return append([]string(nil), session.Capabilities...)
}

func agentAuditMeta(session *AgentSession) map[string]any {
	if session == nil {
		return nil
	}
	return map[string]any{
		"agent_kind":         session.Kind,
		"agent_capabilities": agentSessionCapabilities(session),
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

// validateAgentSessionOwnership binds the asserted agent_session_id to the calling
// application: the row must exist, be active in this zone, and be owned by app.ID.
// This stops two apps in a zone from forging each other's agent identity by passing
// a peer's agent_session_id.
func (s *Server) validateAgentSessionOwnership(ctx context.Context, zoneID, appID, agentSessionID string) (*AgentSession, *sharederr.CaracalError) {
	session, err := s.db.GetAgentSession(ctx, agentSessionID)
	if err != nil || !activeAgentSession(session, zoneID, time.Now()) {
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
	now := time.Now()
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
	chain, chainErr := s.buildDelegationChain(ctx, path, edge, source, target)
	if chainErr != nil {
		return nil, nil, chainErr
	}
	return &delegationProof{edge: edge, constraints: constraints, path: path, chain: chain, graphEpoch: graphEpoch}, target, nil
}

// buildDelegationChain resolves each edge id along the path to a chain hop the
// resource side can audit and authorize against. The chain walks from the
// originating issuer to the immediate receiver in order.
func (s *Server) buildDelegationChain(ctx context.Context, path []string, edge *DelegationEdge, source, target *AgentSession) ([]ChainHop, *sharederr.CaracalError) {
	if len(path) == 0 {
		return nil, nil
	}
	now := time.Now()
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
	constraints := delegationConstraints{MaxHops: 1}
	if len(raw) == 0 {
		return constraints, nil
	}
	if err := json.Unmarshal(raw, &constraints); err != nil {
		return constraints, err
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
	return session.SpawnedAt.Add(time.Duration(session.TTLSeconds) * time.Second).After(now)
}

func tokenTTL(ttlSeconds int, ambientAllowed bool) (time.Duration, error) {
	if ttlSeconds == 0 {
		return ttlPerCallSDK, nil
	}
	if ttlSeconds < 0 {
		return 0, fmt.Errorf("ttl_seconds must be positive")
	}
	ttl := time.Duration(ttlSeconds) * time.Second
	limit := ttlPerCallSDK
	if ambientAllowed {
		limit = ttlAmbient
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
