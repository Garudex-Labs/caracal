// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Wire types for token exchange requests, responses, OPA evaluation, and audit events.

package internal

import (
	"encoding/json"

	"github.com/garudex-labs/caracal/packages/core/go/audit"
	corests "github.com/garudex-labs/caracal/packages/core/go/sts"
)

// AuditEvent is the wire-format audit record produced by STS.
// Aliased from the canonical definition in core/audit so STS and the audit
// service share a single source of truth.
type AuditEvent = audit.Event

// UpstreamDirective and TokenResponse are aliased from core/sts so STS and the
// gateway share a single wire-type definition for the RFC 8693 exchange.
type UpstreamDirective = corests.UpstreamDirective

type TokenResponse = corests.TokenResponse

// TokenExchangeRequest is the parsed body of POST /oauth/2/token (application/x-www-form-urlencoded).
type TokenExchangeRequest struct {
	GrantType                  string
	SubjectToken               string
	SubjectTokenType           string
	ActorToken                 string
	Resources                  []string // one or more resource identifiers; repeated param supported
	Scope                      string
	ZoneID                     string
	ApplicationID              string
	ClientSecret               string
	ClientAssertion            string
	ClientAssertionType        string
	ChallengeID                string // identifier of a previously issued step-up challenge
	ChallengeResponse          string // single-use secret presented to consume the challenge
	SessionID                  string
	AgentSessionID             string
	DelegationEdgeID           string
	TTLSeconds                 int
	GatewayAuthenticated       bool
	RuntimeCredentialInjection bool
}

// UpstreamAuthMode classifies how the gateway must authenticate to a resource.
const (
	UpstreamAuthNone           = "none"
	UpstreamAuthCaracalJWT     = "caracal_jwt"
	UpstreamAuthProviderOAuth  = "provider_oauth"
	UpstreamAuthProviderAPIKey = "provider_apikey"
)

// OPAInput is the canonical input shape for every policy evaluation.
type OPAInput struct {
	SchemaVersion  string             `json:"schema_version"`
	Principal      OPAPrincipal       `json:"principal"`
	Resource       OPAResource        `json:"resource"`
	Action         OPAAction          `json:"action"`
	Session        *OPASession        `json:"session,omitempty"`
	DelegationEdge *OPADelegationEdge `json:"delegation_edge,omitempty"`
	Context        OPAContext         `json:"context"`
}

type OPAPrincipal struct {
	Type               string   `json:"type"`
	ID                 string   `json:"id"`
	ZoneID             string   `json:"zone_id"`
	RegistrationMethod string   `json:"registration_method,omitempty"`
	AgentSessionID     string   `json:"agent_session_id,omitempty"`
	Lifecycle          string   `json:"lifecycle,omitempty"`
	Labels             []string `json:"labels,omitempty"`
}

type OPAResource struct {
	Type       string   `json:"type"`
	ID         string   `json:"id"`
	Identifier string   `json:"identifier"`
	Scopes     []string `json:"scopes"`
}

type OPAAction struct {
	ID string `json:"id"`
}

type OPASession struct {
	ID string `json:"id"`
}

type OPADelegationEdge struct {
	ID                    string          `json:"id"`
	SourceSessionID       string          `json:"source_session_id,omitempty"`
	TargetSessionID       string          `json:"target_session_id,omitempty"`
	IssuerApplicationID   string          `json:"issuer_application_id,omitempty"`
	ReceiverApplicationID string          `json:"receiver_application_id,omitempty"`
	ResourceID            string          `json:"resource_id,omitempty"`
	Scopes                []string        `json:"scopes,omitempty"`
	EdgeVersion           int             `json:"edge_version,omitempty"`
	Path                  []string        `json:"path,omitempty"`
	GraphEpoch            int64           `json:"graph_epoch,omitempty"`
	ConstraintsJSON       json.RawMessage `json:"constraints_json,omitempty"`
}

type OPAContext struct {
	ActorClaims       map[string]any `json:"actor_claims"`
	SubjectClaims     map[string]any `json:"subject_claims,omitempty"`
	TraceID           string         `json:"trace_id,omitempty"`
	SessionID         string         `json:"session_id,omitempty"`
	AgentSessionID    string         `json:"agent_session_id,omitempty"`
	DelegationEdgeID  string         `json:"delegation_edge_id,omitempty"`
	ChallengeResolved bool           `json:"challenge_resolved"`
	RequestedScopes   []string       `json:"requested_scopes"`
}

// OPAResult holds the decoded output of a policy evaluation.
type OPAResult struct {
	Decision            string           `json:"decision"`
	DeterminingPolicies []map[string]any `json:"determining_policies"`
	EvaluationStatus    string           `json:"evaluation_status"`
	Diagnostics         []map[string]any `json:"diagnostics"`
}

// StepUpChallenge describes the 401 response body for interaction_required.
// ChallengeSecret is the high-entropy single-use proof the client must echo back as
// challenge_response on the follow-up token-exchange request.
type StepUpChallenge struct {
	Error              string `json:"error"`
	ErrorDescription   string `json:"error_description"`
	ChallengeID        string `json:"challenge_id"`
	ChallengeType      string `json:"challenge_type"`
	ChallengeSecret    string `json:"challenge_secret"`
	ChallengeExpiresAt string `json:"challenge_expires_at"`
	RequestID          string `json:"requestId"`
}
