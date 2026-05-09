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
	"strconv"
	"strings"
	"time"

	sharederr "github.com/garudex-labs/caracal/core/errors"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

const (
	// ttlPerCallSDK caps the lifetime of every per-call exchange. The gateway
	// re-exchanges on each request, so streams longer than this lifetime
	// (LLM completions, SSE, websockets) cannot rotate mid-stream. Callers
	// initiating long streams must treat ttlPerCallSDK as the contract upper
	// bound: streams running past it should expect upstream-side disconnect
	// or a fresh exchange + reconnect orchestrated by the SDK (Issue J).
	ttlPerCallSDK = 15 * time.Minute
	ttlAmbient    = 60 * time.Minute
)

type delegationProof struct {
	edge       *DelegationEdge
	path       []string
	chain      []ChainHop
	graphEpoch int64
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

	req := TokenExchangeRequest{
		GrantType:           r.FormValue("grant_type"),
		SubjectToken:        r.FormValue("subject_token"),
		SubjectTokenType:    r.FormValue("subject_token_type"),
		ActorToken:          r.FormValue("actor_token"),
		Resources:           r.Form["resource"],
		Scope:               r.FormValue("scope"),
		ZoneID:              r.FormValue("zone_id"),
		ApplicationID:       r.FormValue("application_id"),
		ClientSecret:        r.FormValue("client_secret"),
		ClientAssertion:     r.FormValue("client_assertion"),
		ClientAssertionType: r.FormValue("client_assertion_type"),
		ChallengeID:         r.FormValue("challenge_id"),
		ChallengeResponse:   r.FormValue("challenge_response"),
		SessionID:           r.FormValue("session_id"),
		AgentSessionID:      r.FormValue("agent_session_id"),
		DelegationEdgeID:    r.FormValue("delegation_edge_id"),
		TTLSeconds:          ttlSeconds,
	}

	requestID := r.Header.Get("X-Request-Id")
	if requestID == "" {
		id, _ := uuid.NewV7()
		requestID = id.String()
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
		sid, serr := s.validateTokenSession(ctx, zoneID, req.SessionID, subjectClaims)
		if serr != nil {
			return nil, nil, http.StatusForbidden, serr
		}
		if req.SessionID == "" {
			req.SessionID = sid
		}
	}

	actorClaims := map[string]any{}
	if req.ActorToken != "" {
		actorClaims, err = s.validateSubjectToken(ctx, req.ActorToken, zoneID)
		if err != nil {
			return nil, nil, http.StatusUnauthorized, sharederr.New(sharederr.InvalidToken, "invalid actor_token")
		}
		if _, serr := s.validateTokenSession(ctx, zoneID, "", actorClaims); serr != nil {
			return nil, nil, http.StatusForbidden, serr
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
		if cerr := s.verifyAndConsumeChallenge(ctx, zoneID, principalID, req.ChallengeID, req.ChallengeResponse, req.Resources); cerr != nil {
			s.auditBuffer.Emit(buildAuditEvent(requestID, zoneID, "deny", "challenge_invalid", &OPAResult{}, nil))
			return nil, nil, http.StatusUnauthorized, sharederr.New(sharederr.AccessDenied, "challenge not satisfied or expired")
		}
		challengeResolved = true
	}
	delegation, refErr := s.validateSessionReferences(ctx, zoneID, app.ID, req, subjectClaims != nil)
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

	for _, identifier := range req.Resources {
		resource, dbErr := s.db.GetResourceByIdentifier(ctx, zoneID, identifier)
		if dbErr != nil {
			s.auditBuffer.Emit(buildAuditEvent(requestID, zoneID, "deny", "resource_not_found", &OPAResult{},
				map[string]any{"resource": identifier}))
			continue
		}
		if !scopesAllowed(scopes, resource.Scopes) {
			s.auditBuffer.Emit(buildAuditEvent(requestID, zoneID, "deny", "scope_mismatch", &OPAResult{},
				map[string]any{"resource": resource.Identifier}))
			continue
		}
		if delegation != nil && delegation.edge.ResourceID != nil && *delegation.edge.ResourceID != resource.ID {
			s.auditBuffer.Emit(buildAuditEvent(requestID, zoneID, "deny", "resource_outside_delegation", &OPAResult{},
				map[string]any{"resource": resource.Identifier}))
			continue
		}

		if rateErr := s.checkRateLimit(ctx, zoneID, resource.ID, app.ID); rateErr != nil {
			s.auditBuffer.Emit(buildAuditEvent(requestID, zoneID, "deny", "rate_limited", &OPAResult{},
				map[string]any{"resource": resource.Identifier}))
			continue
		}

		if resource.CredentialProviderID != nil {
			userID, _ := subjectClaims["sub"].(string)
			if userID == "" {
				// Provider-credentialed resources require a user-bound grant;
				// application-principal exchanges (no subject_token) cannot
				// produce a usable upstream credential.
				s.auditBuffer.Emit(buildAuditEvent(requestID, zoneID, "deny", "credential_not_provisioned", &OPAResult{},
					map[string]any{"resource": resource.Identifier, "reason": "no_user_principal"}))
				continue
			}
			if rerr := s.tryRefreshBrokeredGrant(ctx, zoneID, userID, resource.ID); rerr != nil {
				s.auditBuffer.Emit(buildAuditEvent(requestID, zoneID, "deny", "credential_refresh_failed", &OPAResult{},
					map[string]any{"resource": resource.Identifier, "reason": string(rerr.Code)}))
				continue
			}
			// Confirm we actually have a usable provider AT before letting
			// OPA approve. Without this, the directive build downstream
			// would silently fall back to caracal_jwt mode and the provider
			// would reject the request with no clear deny signal.
			grant, gerr := s.db.GetDelegatedGrant(ctx, zoneID, userID, resource.ID)
			if gerr != nil || grant == nil || len(grant.AccessTokenCt) == 0 {
				s.auditBuffer.Emit(buildAuditEvent(requestID, zoneID, "deny", "credential_not_provisioned", &OPAResult{},
					map[string]any{"resource": resource.Identifier, "reason": "no_grant"}))
				continue
			}
		}

		opaInput := OPAInput{
			Principal: OPAPrincipal{
				Type:           "Application",
				ID:             app.ID,
				ZoneID:         zoneID,
				CredentialType: derefStr(app.CredentialType),
				AgentSessionID: req.AgentSessionID,
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
			s.auditBuffer.Emit(buildAuditEventWithBundle(requestID, zoneID, "deny", "policy_eval_failed", &OPAResult{},
				map[string]any{"resource": resource.Identifier}, bundle))
			return nil, nil, http.StatusServiceUnavailable, sharederr.New(sharederr.PolicyEvalFailed, "policy evaluation unavailable")
		}

		s.auditBuffer.Emit(buildAuditEventWithBundle(requestID, zoneID, result.Decision, result.EvaluationStatus, result,
			mergeAuditMeta(map[string]any{"resource": resource.Identifier}, delegationMeta), bundle))

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
		s.auditBuffer.Emit(buildAuditEvent(requestID, zoneID, "deny", "exchange_denied", &OPAResult{},
			map[string]any{"requested": req.Resources}))
		return nil, nil, http.StatusForbidden, sharederr.New(sharederr.AccessDenied, "policy denied")
	}

	sid, _ := uuid.NewV7()
	sessID := sid.String()
	now := time.Now()
	ttl, ttlErr := tokenTTL(req.TTLSeconds, req.SubjectToken == "")
	if ttlErr != nil {
		return nil, nil, http.StatusBadRequest, sharederr.New(sharederr.InvalidToken, ttlErr.Error())
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
	if req.SubjectToken == "" {
		use = UseAmbient
	}

	sess := &Session{
		ID:              sessID,
		ZoneID:          zoneID,
		SessionType:     sessionType,
		SubjectID:       &subjectID,
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
	s.recordIssuedJTI(ctx, jti, app.ID, zoneID, requestID, ttl)

	// Build per-resource upstream directives so the gateway can substitute the
	// provider-native credential where the resource expects one.
	for _, identifier := range grantedResources {
		resource := grantedResourceRows[identifier]
		directive := UpstreamDirective{
			AuthMode:   UpstreamAuthCaracalJWT,
			AuthHeader: "Authorization",
			AuthScheme: "Bearer",
		}
		if resource.UpstreamURL != nil {
			directive.URL = *resource.UpstreamURL
		}
		if resource.CredentialProviderID != nil {
			userID, _ := subjectClaims["sub"].(string)
			if userID != "" {
				if grant, gerr := s.db.GetDelegatedGrant(ctx, zoneID, userID, resource.ID); gerr == nil && len(grant.AccessTokenCt) > 0 {
					if at, openErr := openZEK(s.keys.zek, grant.AccessTokenCt); openErr == nil {
						directive.AuthMode = UpstreamAuthProviderOAuth
						directive.ProviderToken = string(at)
						if grant.ExpiresAt != nil {
							directive.ExpiresAt = grant.ExpiresAt.Unix()
						}
					}
				}
			}
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
	if app.ClientSecretHash != nil {
		credential := req.ClientSecret
		if credential == "" {
			credential = req.ClientAssertion
		}
		ok, needsRehash := verifyClientSecret(*app.ClientSecretHash, credential)
		if !ok {
			return nil, "", errSecretMismatch
		}
		if needsRehash {
			if newHash, herr := hashClientSecret(credential); herr == nil {
				_ = s.db.UpdateApplicationSecretHash(ctx, app.ID, app.ZoneID, newHash)
			}
		}
	} else if derefStr(app.CredentialType) == "public" {
		if strings.TrimSpace(req.ClientAssertion) == "" {
			return nil, "", fmt.Errorf("public client requires client_assertion (DPoP/private_key_jwt) — secretless flows are not yet supported")
		}
		// TODO(security/H): verify DPoP proof (RFC 9449) or private_key_jwt assertion against
		// a registered JWK for this application, and bind the issued token via cnf.jkt.
		// Until then, public clients still require a verifiable client_assertion to
		// prevent unauthenticated token minting (Issue H).
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

func (s *Server) validateTokenSession(ctx context.Context, zoneID, sessionID string, claims map[string]any) (string, *sharederr.CaracalError) {
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
	return sid, nil
}

func buildAuditEvent(requestID, zoneID, decision, status string, result *OPAResult, meta map[string]any) AuditEvent {
	return buildAuditEventWithBundle(requestID, zoneID, decision, status, result, meta, ZoneBundleInfo{})
}

func buildAuditEventWithBundle(requestID, zoneID, decision, status string, result *OPAResult, meta map[string]any, bundle ZoneBundleInfo) AuditEvent {
	id, _ := uuid.NewV7()
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
	}
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
			"app":     h.AppID,
			"session": h.AgentSessionID,
			"edge":    h.DelegationEdgeID,
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
func (s *Server) validateAgentSessionOwnership(ctx context.Context, zoneID, appID, agentSessionID string) *sharederr.CaracalError {
	session, err := s.db.GetAgentSession(ctx, agentSessionID)
	if err != nil || !activeAgentSession(session, zoneID, time.Now()) {
		return sharederr.New(sharederr.AccessDenied, "agent session inactive or expired")
	}
	if session.ApplicationID != appID {
		return sharederr.New(sharederr.AccessDenied, "agent session not owned by caller")
	}
	return nil
}

// validateSessionReferences is the single source of truth for binding a token
// exchange to user/agent sessions and delegation edges. When a delegation_edge_id
// is present the source agent session's ownership is verified inside the
// delegation block (source.ApplicationID == appID); otherwise the calling
// application's ownership of the asserted agent_session_id is verified directly
// (Issue I — consolidation prevents peer-app forgery via either path).
func (s *Server) validateSessionReferences(ctx context.Context, zoneID, appID string, req TokenExchangeRequest, hasSubjectToken bool) (*delegationProof, *sharederr.CaracalError) {
	now := time.Now()
	if req.SessionID != "" {
		session, err := s.db.GetSession(ctx, req.SessionID)
		if err != nil || session.ZoneID != zoneID || session.Status != "active" || !session.ExpiresAt.After(now) {
			return nil, sharederr.New(sharederr.AccessDenied, "session inactive or expired")
		}
		// Application-principal flows (no subject_token) must assert a
		// session owned by the calling app. Without this, peer apps in a
		// zone could pass another app's session_id and have OPA evaluate
		// against a session reputation/state that is not their own.
		if !hasSubjectToken {
			if session.SessionType != "application" || session.SubjectID == nil || *session.SubjectID != appID {
				return nil, sharederr.New(sharederr.AccessDenied, "session not owned by caller")
			}
		}
	}
	if req.AgentSessionID != "" && req.DelegationEdgeID == "" {
		if aerr := s.validateAgentSessionOwnership(ctx, zoneID, appID, req.AgentSessionID); aerr != nil {
			return nil, aerr
		}
	}
	if req.DelegationEdgeID == "" {
		return nil, nil
	}
	if req.AgentSessionID == "" {
		return nil, sharederr.New(sharederr.AccessDenied, "delegation edge requires source agent session")
	}
	edge, err := s.db.GetDelegationEdge(ctx, req.DelegationEdgeID)
	if err != nil || edge.ZoneID != zoneID || edge.Status != "active" || !edge.ExpiresAt.After(now) || edge.RevokedAt != nil {
		return nil, sharederr.New(sharederr.AccessDenied, "delegation edge inactive or expired")
	}
	if edge.SourceSessionID != req.AgentSessionID {
		return nil, sharederr.New(sharederr.AccessDenied, "delegation edge source mismatch")
	}
	source, err := s.db.GetAgentSession(ctx, edge.SourceSessionID)
	if err != nil || !activeAgentSession(source, zoneID, now) || source.ApplicationID != appID {
		return nil, sharederr.New(sharederr.AccessDenied, "delegation source inactive or unauthorized")
	}
	target, err := s.db.GetAgentSession(ctx, edge.TargetSessionID)
	if err != nil || !activeAgentSession(target, zoneID, now) {
		return nil, sharederr.New(sharederr.AccessDenied, "delegation target inactive or expired")
	}
	if source.ApplicationID != edge.IssuerAppID || target.ApplicationID != edge.ReceiverAppID {
		return nil, sharederr.New(sharederr.AccessDenied, "delegation application mismatch")
	}
	constraints, err := parseDelegationConstraints(edge.ConstraintsJSON)
	if err != nil {
		return nil, sharederr.New(sharederr.AccessDenied, "delegation constraints invalid")
	}
	if !scopesAllowed(strings.Fields(req.Scope), edge.Scopes) {
		return nil, sharederr.New(sharederr.AccessDenied, "requested scopes exceed delegation scopes")
	}
	if constraints.Budget > 0 && len(strings.Fields(req.Scope)) > constraints.Budget {
		return nil, sharederr.New(sharederr.AccessDenied, "requested scopes exceed delegation budget")
	}
	if constraints.TTLSeconds > 0 {
		requestedTTL := req.TTLSeconds
		if requestedTTL == 0 {
			requestedTTL = int(ttlPerCallSDK.Seconds())
		}
		if requestedTTL > constraints.TTLSeconds {
			return nil, sharederr.New(sharederr.AccessDenied, "requested ttl exceeds delegation ttl")
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
		return nil, sharederr.New(sharederr.AccessDenied, "delegation path invalid")
	}
	graphEpoch, err := s.db.GetDelegationGraphEpoch(ctx, zoneID)
	if err != nil {
		return nil, sharederr.New(sharederr.AccessDenied, "delegation graph epoch unavailable")
	}
	chain, chainErr := s.buildDelegationChain(ctx, path, edge, source, target)
	if chainErr != nil {
		return nil, chainErr
	}
	return &delegationProof{edge: edge, path: path, chain: chain, graphEpoch: graphEpoch}, nil
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
