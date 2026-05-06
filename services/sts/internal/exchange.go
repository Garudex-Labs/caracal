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

	sharederr "github.com/garudex-labs/caracal/shared/errors"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

const (
	ttlPerCallSDK = 15 * time.Minute
	ttlAmbient    = 60 * time.Minute
)

type delegationProof struct {
	edge       *DelegationEdge
	path       []string
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
		ClientID:            r.FormValue("client_id"),
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
	json.NewEncoder(w).Encode(resp)
}

func (s *Server) exchange(ctx context.Context, req TokenExchangeRequest, requestID string) (*TokenResponse, *challengeState, int, *sharederr.CaracalError) {
	app, zoneID, err := s.authenticateApp(ctx, req)
	if err != nil {
		return nil, nil, http.StatusUnauthorized, sharederr.New(sharederr.AccessDenied, "invalid client credentials")
	}

	if len(req.Resources) == 0 {
		return nil, nil, http.StatusBadRequest, sharederr.New(sharederr.InvalidToken, "at least one resource is required")
	}

	var subjectClaims map[string]interface{}
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

	actorClaims := map[string]interface{}{}
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
	delegation, refErr := s.validateSessionReferences(ctx, zoneID, app.ID, req)
	if refErr != nil {
		return nil, nil, http.StatusForbidden, refErr
	}

	scopes := strings.Fields(req.Scope)
	var grantedResources []string
	grantedUpstreams := map[string]string{}
	var pendingChallenge *challengeState
	stepUpType := ""

	for _, identifier := range req.Resources {
		resource, dbErr := s.db.GetResourceByIdentifier(ctx, zoneID, identifier)
		if dbErr != nil {
			s.auditBuffer.Emit(buildAuditEvent(requestID, zoneID, "deny", "resource_not_found", &OPAResult{},
				map[string]interface{}{"resource": identifier}))
			continue
		}
		if !scopesAllowed(scopes, resource.Scopes) {
			s.auditBuffer.Emit(buildAuditEvent(requestID, zoneID, "deny", "scope_mismatch", &OPAResult{},
				map[string]interface{}{"resource": resource.Identifier}))
			continue
		}
		if delegation != nil && delegation.edge.ResourceID != nil && *delegation.edge.ResourceID != resource.ID {
			s.auditBuffer.Emit(buildAuditEvent(requestID, zoneID, "deny", "resource_outside_delegation", &OPAResult{},
				map[string]interface{}{"resource": resource.Identifier}))
			continue
		}

		if rateErr := s.checkRateLimit(ctx, zoneID, resource.ID, app.ID); rateErr != nil {
			s.auditBuffer.Emit(buildAuditEvent(requestID, zoneID, "deny", "rate_limited", &OPAResult{},
				map[string]interface{}{"resource": resource.Identifier}))
			continue
		}

		if resource.CredentialProviderID != nil {
			userID, _ := subjectClaims["sub"].(string)
			if rerr := s.tryRefreshBrokeredGrant(ctx, zoneID, userID, resource.ID); rerr != nil {
				s.auditBuffer.Emit(buildAuditEvent(requestID, zoneID, "deny", "credential_refresh_failed", &OPAResult{},
					map[string]interface{}{"resource": resource.Identifier, "reason": string(rerr.Code)}))
				continue
			}
		}

		opaInput := OPAInput{
			Principal: OPAPrincipal{
				Type:           "Application",
				ID:             app.ID,
				ZoneID:         zoneID,
				CredentialType: derefStr(app.CredentialType),
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
				map[string]interface{}{"resource": resource.Identifier}, bundle))
			return nil, nil, http.StatusServiceUnavailable, sharederr.New(sharederr.PolicyEvalFailed, "policy evaluation unavailable")
		}

		s.auditBuffer.Emit(buildAuditEventWithBundle(requestID, zoneID, result.Decision, result.EvaluationStatus, result,
			map[string]interface{}{"resource": resource.Identifier}, bundle))

		// Partial evaluation is a hard-deny invariant: any partial answer fails the
		// entire request rather than silently dropping a resource slot.
		if result.EvaluationStatus == "partial" {
			return nil, nil, http.StatusForbidden, sharederr.New(sharederr.PolicyEvalFailed, "partial policy evaluation")
		}

		if !challengeResolved {
			if t := stepUpRequired(result); t != "" {
				stepUpType = t
			}
		}

		if result.Decision == "allow" {
			grantedResources = append(grantedResources, resource.Identifier)
			if resource.UpstreamURL != nil && *resource.UpstreamURL != "" {
				grantedUpstreams[resource.Identifier] = *resource.UpstreamURL
			}
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
			map[string]interface{}{"requested": req.Resources}))
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
		ZoneID:    zoneID,
		AppID:     app.ID,
		SubjectID: subjectID,
		SID:       sessID,
		Scopes:    req.Scope,
		Resources: grantedResources,
		TTL:       ttl,
	}
	if req.DelegationEdgeID != "" {
		issueParams.DelegationEdgeID = req.DelegationEdgeID
		issueParams.SourceSessionID = delegation.edge.SourceSessionID
		issueParams.TargetSessionID = delegation.edge.TargetSessionID
		issueParams.DelegationPath = delegation.path
		issueParams.GraphEpoch = delegation.graphEpoch
		// On-behalf is the immediate issuer in the delegation chain; surface it in the
		// JWT so downstream resources can render audit subjects without re-walking the graph.
		issueParams.OnBehalfOf = delegation.edge.IssuerAppID
	}
	token, err := issueToken(ctx, issueParams, s.keys, s.cfg.IssuerURL)
	if err != nil {
		return nil, nil, http.StatusInternalServerError, sharederr.New(sharederr.Internal, "token issuance failed")
	}

	return &TokenResponse{
		AccessToken:     token,
		TokenType:       "Bearer",
		ExpiresIn:       int(ttl.Seconds()),
		Scope:           req.Scope,
		IssuedTokenType: "urn:ietf:params:oauth:token-type:access_token",
		TargetResources: grantedResources,
		TargetUpstreams: grantedUpstreams,
	}, nil, http.StatusOK, nil
}

func (s *Server) authenticateApp(ctx context.Context, req TokenExchangeRequest) (*Application, string, error) {
	parts := strings.SplitN(req.ClientID, ":", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return nil, "", fmt.Errorf("invalid client_id format")
	}
	zoneID, appID := parts[0], parts[1]
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
	} else if derefStr(app.CredentialType) != "public" {
		return nil, "", fmt.Errorf("client secret not configured")
	}
	return app, zoneID, nil
}

// validateSubjectToken verifies an inbound STS-issued token: ES256 signature, this STS
// as issuer, the token-exchange audience, and a matching zone_id claim.
func (s *Server) validateSubjectToken(ctx context.Context, tokenStr, zoneID string) (map[string]interface{}, error) {
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
	).ParseWithClaims(tokenStr, mc, func(*jwt.Token) (interface{}, error) {
		return pub, nil
	})
	if err != nil {
		return nil, err
	}
	if claimString(mc, "zone_id") != zoneID {
		return nil, errors.New("token zone mismatch")
	}
	return mc, nil
}

func (s *Server) validateTokenSession(ctx context.Context, zoneID, sessionID string, claims map[string]interface{}) (string, *sharederr.CaracalError) {
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
	return sid, nil
}

func buildAuditEvent(requestID, zoneID, decision, status string, result *OPAResult, meta map[string]interface{}) AuditEvent {
	return buildAuditEventWithBundle(requestID, zoneID, decision, status, result, meta, ZoneBundleInfo{})
}

func buildAuditEventWithBundle(requestID, zoneID, decision, status string, result *OPAResult, meta map[string]interface{}, bundle ZoneBundleInfo) AuditEvent {
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

func (s *Server) validateSessionReferences(ctx context.Context, zoneID, appID string, req TokenExchangeRequest) (*delegationProof, *sharederr.CaracalError) {
	now := time.Now()
	if req.SessionID != "" {
		session, err := s.db.GetSession(ctx, req.SessionID)
		if err != nil || session.ZoneID != zoneID || session.Status != "active" || !session.ExpiresAt.After(now) {
			return nil, sharederr.New(sharederr.AccessDenied, "session inactive or expired")
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
	return &delegationProof{edge: edge, path: path, graphEpoch: graphEpoch}, nil
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

func claimString(claims map[string]interface{}, key string) string {
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
