// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Admin operations services and row types for policy templates, grants, sessions, audit, step-up, agents, and delegations.

package admin

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

func setParam(values url.Values, key, value string) {
	if value != "" {
		values.Set(key, value)
	}
}

func setLimit(values url.Values, limit int) {
	if limit > 0 {
		values.Set("limit", strconv.Itoa(limit))
	}
}

// PolicyTemplate is one curated starter policy row.
type PolicyTemplate struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Content     string `json:"content"`
}

// Grant is the admin API user grant row. Nullable columns are pointers so
// absence and empty stay distinct.
type Grant struct {
	ID              string   `json:"id"`
	ZoneID          string   `json:"zone_id"`
	ApplicationID   string   `json:"application_id"`
	UserID          string   `json:"user_id"`
	ResourceID      string   `json:"resource_id"`
	ProviderID      *string  `json:"provider_id"`
	ApplicationName *string  `json:"application_name"`
	ResourceName    *string  `json:"resource_name"`
	ProviderName    *string  `json:"provider_name"`
	ProviderKind    *string  `json:"provider_kind"`
	Scopes          []string `json:"scopes"`
	Status          string   `json:"status"`
	CreatedAt       string   `json:"created_at"`
}

// GrantQuery filters grant listings. UserID takes precedence over SubjectID
// when both are set.
type GrantQuery struct {
	ApplicationID string
	UserID        string
	SubjectID     string
	ResourceID    string
	ProviderID    string
	Status        string
	Scopes        []string
	Cursor        string
	Limit         int
}

func (q *GrantQuery) values() url.Values {
	if q == nil {
		return nil
	}
	values := url.Values{}
	setParam(values, "application_id", q.ApplicationID)
	userID := q.UserID
	if userID == "" {
		userID = q.SubjectID
	}
	setParam(values, "user_id", userID)
	setParam(values, "resource_id", q.ResourceID)
	setParam(values, "provider_id", q.ProviderID)
	setParam(values, "status", q.Status)
	if len(q.Scopes) > 0 {
		values.Set("scopes", strings.Join(q.Scopes, ","))
	}
	setParam(values, "cursor", q.Cursor)
	setLimit(values, q.Limit)
	return values
}

// ProviderConnection is the admin API provider connection row: one subject's
// authenticated upstream account on a provider.
type ProviderConnection struct {
	ID                 string  `json:"id"`
	ZoneID             string  `json:"zone_id"`
	SubjectID          string  `json:"subject_id"`
	ProviderID         string  `json:"provider_id"`
	Status             string  `json:"status"`
	ExpiresAt          *string `json:"expires_at"`
	UpstreamRevocation string  `json:"upstream_revocation,omitempty"`
	CreatedAt          string  `json:"created_at"`
	UpdatedAt          string  `json:"updated_at"`
}

// ProviderConnectionAuthorize is the started OAuth authorization handshake.
type ProviderConnectionAuthorize struct {
	AuthorizationURL string `json:"authorization_url"`
	State            string `json:"state"`
	ExpiresAt        string `json:"expires_at"`
}

// WorkloadBinding maps an environment variable to a governed resource
// credential for caracal run.
type WorkloadBinding struct {
	Env       string   `json:"env"`
	Resource  string   `json:"resource"`
	Scopes    []string `json:"scopes,omitempty"`
	Optional  bool     `json:"optional,omitempty"`
	OnFailure string   `json:"on_failure,omitempty"`
}

// Workload is the admin API workload row: a launcher identity with its
// credential bindings.
type Workload struct {
	ID                 string            `json:"id"`
	ZoneID             string            `json:"zone_id"`
	Name               string            `json:"name"`
	Bindings           []WorkloadBinding `json:"bindings"`
	CreatedBy          *string           `json:"created_by"`
	CreatedViaOperator bool              `json:"created_via_operator"`
	CreatedAt          string            `json:"created_at"`
	UpdatedBy          *string           `json:"updated_by"`
	UpdatedViaOperator bool              `json:"updated_via_operator"`
	UpdatedAt          string            `json:"updated_at"`
}

// Session is the admin API subject session row.
type Session struct {
	ID              string  `json:"id"`
	ZoneID          string  `json:"zone_id"`
	SessionType     string  `json:"session_type"`
	SubjectID       string  `json:"subject_id"`
	ParentID        *string `json:"parent_id"`
	Status          string  `json:"status"`
	ExpiresAt       string  `json:"expires_at"`
	AuthenticatedAt string  `json:"authenticated_at"`
	CreatedAt       string  `json:"created_at"`
}

// SessionQuery filters session listings.
type SessionQuery struct {
	Status    string
	SubjectID string
	Limit     int
}

func (q *SessionQuery) values() url.Values {
	if q == nil {
		return nil
	}
	values := url.Values{}
	setParam(values, "status", q.Status)
	setParam(values, "subject_id", q.SubjectID)
	setLimit(values, q.Limit)
	return values
}

// AgentSessionRow is the admin API agent session listing row.
type AgentSessionRow struct {
	ID            string   `json:"id"`
	ApplicationID string   `json:"application_id"`
	ParentID      *string  `json:"parent_id"`
	Status        string   `json:"status"`
	Lifecycle     string   `json:"lifecycle"`
	Labels        []string `json:"labels"`
	Depth         int      `json:"depth"`
	ChildCount    int      `json:"child_count"`
	SpawnedAt     string   `json:"spawned_at"`
	LastActiveAt  string   `json:"last_active_at"`
	TerminatedAt  *string  `json:"terminated_at"`
	TTLSeconds    *int     `json:"ttl_seconds"`
}

// AgentSessionQuery filters agent session listings.
type AgentSessionQuery struct {
	Status        string
	Lifecycle     string
	ApplicationID string
	ParentID      string
	Label         string
	Cursor        string
	Limit         int
}

func (q *AgentSessionQuery) values() url.Values {
	if q == nil {
		return nil
	}
	values := url.Values{}
	setParam(values, "status", q.Status)
	setParam(values, "lifecycle", q.Lifecycle)
	setParam(values, "application_id", q.ApplicationID)
	setParam(values, "parent_id", q.ParentID)
	setParam(values, "label", q.Label)
	setParam(values, "cursor", q.Cursor)
	setLimit(values, q.Limit)
	return values
}

// AuditEvent is the audit trail listing row.
type AuditEvent struct {
	ID               string         `json:"id"`
	ZoneID           string         `json:"zone_id"`
	EventType        string         `json:"event_type"`
	RequestID        *string        `json:"request_id"`
	Decision         *string        `json:"decision"`
	EvaluationStatus *string        `json:"evaluation_status"`
	MetadataJSON     map[string]any `json:"metadata_json"`
	OccurredAt       string         `json:"occurred_at"`
	IngestedAt       string         `json:"ingested_at"`
}

// AuditDetail is one audit event with its policy evaluation context.
type AuditDetail struct {
	AuditEvent
	PolicySetID             *string `json:"policy_set_id"`
	PolicySetVersionID      *string `json:"policy_set_version_id"`
	ManifestSHA             *string `json:"manifest_sha"`
	DeterminingPoliciesJSON []any   `json:"determining_policies_json"`
	DiagnosticsJSON         []any   `json:"diagnostics_json"`
}

// DeniedDecisionEvent is one denied decision inside a trace.
type DeniedDecisionEvent struct {
	EventID             string         `json:"event_id"`
	EventType           string         `json:"event_type"`
	EvaluationStatus    *string        `json:"evaluation_status"`
	DeterminingPolicies []any          `json:"determining_policies"`
	Diagnostics         []any          `json:"diagnostics"`
	Metadata            map[string]any `json:"metadata"`
	PolicyInput         map[string]any `json:"policy_input"`
}

// DecisionTrace is the full decision explanation for one request.
type DecisionTrace struct {
	RequestID     string                `json:"request_id"`
	ZoneID        string                `json:"zone_id"`
	FinalDecision string                `json:"final_decision"`
	Denied        []DeniedDecisionEvent `json:"denied"`
	Events        []AuditDetail         `json:"events"`
}

// AuditQuery filters audit trail listings.
type AuditQuery struct {
	Since          string
	Until          string
	RequestID      string
	Decision       string
	EventType      string
	AgentSessionID string
	Label          string
	Cursor         string
	Limit          int
}

func (q *AuditQuery) values() url.Values {
	if q == nil {
		return nil
	}
	values := url.Values{}
	setParam(values, "since", q.Since)
	setParam(values, "until", q.Until)
	setParam(values, "request_id", q.RequestID)
	setParam(values, "decision", q.Decision)
	setParam(values, "event_type", q.EventType)
	setParam(values, "agent_session_id", q.AgentSessionID)
	setParam(values, "label", q.Label)
	setParam(values, "cursor", q.Cursor)
	setLimit(values, q.Limit)
	return values
}

// AdminAuditEvent is the tamper-evident admin action row.
type AdminAuditEvent struct {
	ID          string         `json:"id"`
	RequestID   *string        `json:"request_id"`
	ActorID     *string        `json:"actor_id"`
	ActorName   *string        `json:"actor_name"`
	ActorScope  *string        `json:"actor_scope"`
	Action      string         `json:"action"`
	Method      string         `json:"method"`
	Path        string         `json:"path"`
	EntityType  *string        `json:"entity_type"`
	EntityID    *string        `json:"entity_id"`
	StatusCode  int            `json:"status_code"`
	PayloadJSON map[string]any `json:"payload_json"`
	OccurredAt  string         `json:"occurred_at"`
	ChainSeq    *int           `json:"chain_seq"`
	Signed      bool           `json:"signed"`
}

// AdminAuditQuery filters admin audit listings.
type AdminAuditQuery struct {
	Since      string
	Until      string
	ActorID    string
	EntityType string
	EntityID   string
	Method     string
	Cursor     string
	Limit      int
}

func (q *AdminAuditQuery) values() url.Values {
	if q == nil {
		return nil
	}
	values := url.Values{}
	setParam(values, "since", q.Since)
	setParam(values, "until", q.Until)
	setParam(values, "actor_id", q.ActorID)
	setParam(values, "entity_type", q.EntityType)
	setParam(values, "entity_id", q.EntityID)
	setParam(values, "method", q.Method)
	setParam(values, "cursor", q.Cursor)
	setLimit(values, q.Limit)
	return values
}

// StepUpChallenge is the pending or resolved approval challenge row.
type StepUpChallenge struct {
	ID                string         `json:"id"`
	ZoneID            string         `json:"zone_id"`
	SessionID         string         `json:"session_id"`
	PrincipalID       string         `json:"principal_id"`
	ApplicationID     *string        `json:"application_id"`
	ChallengeType     string         `json:"challenge_type"`
	Tier              *string        `json:"tier"`
	ApproverClass     string         `json:"approver_class"`
	PrivacyMode       string         `json:"privacy_mode"`
	Binding           string         `json:"binding"`
	State             string         `json:"state"`
	MetadataJSON      map[string]any `json:"metadata_json"`
	DecisionReason    *string        `json:"decision_reason"`
	CreatedAt         string         `json:"created_at"`
	ExpiresAt         string         `json:"expires_at"`
	SatisfiedAt       *string        `json:"satisfied_at"`
	RejectedAt        *string        `json:"rejected_at"`
	ConsumedAt        *string        `json:"consumed_at"`
	ApproverSubjectID *string        `json:"approver_subject_id"`
}

// StepUpDecision is the resolution state after an approve or reject.
type StepUpDecision struct {
	ID                string  `json:"id"`
	State             string  `json:"state"`
	SatisfiedAt       *string `json:"satisfied_at"`
	RejectedAt        *string `json:"rejected_at"`
	ApproverSubjectID string  `json:"approver_subject_id"`
}

// AgentSession is the coordinator agent session detail.
type AgentSession struct {
	AgentSessionID      string         `json:"agent_session_id"`
	ZoneID              string         `json:"zone_id"`
	ApplicationID       string         `json:"application_id"`
	ParentID            *string        `json:"parent_id"`
	SubjectSessionID    string         `json:"subject_session_id"`
	Lifecycle           string         `json:"lifecycle"`
	Labels              []string       `json:"labels"`
	Status              string         `json:"status"`
	Depth               int            `json:"depth"`
	TTLSeconds          *int           `json:"ttl_seconds"`
	Metadata            map[string]any `json:"metadata"`
	SpawnedAt           string         `json:"spawned_at"`
	TerminatedAt        *string        `json:"terminated_at"`
	LastHeartbeatAt     *string        `json:"last_heartbeat_at"`
	HeartbeatDeadlineAt *string        `json:"heartbeat_deadline_at"`
}

// AgentListQuery filters coordinator agent listings.
type AgentListQuery struct {
	Status        string
	Lifecycle     string
	ApplicationID string
	Label         string
	Cursor        string
	Limit         int
}

func (q *AgentListQuery) values() url.Values {
	if q == nil {
		return nil
	}
	values := url.Values{}
	setParam(values, "status", q.Status)
	setParam(values, "lifecycle", q.Lifecycle)
	setParam(values, "application_id", q.ApplicationID)
	setParam(values, "label", q.Label)
	setParam(values, "cursor", q.Cursor)
	setLimit(values, q.Limit)
	return values
}

// EffectiveAuthority is the computed authority for one agent session.
type EffectiveAuthority struct {
	AgentSessionID               string   `json:"agent_session_id"`
	InboundEdges                 []string `json:"inbound_edges"`
	EffectiveScopes              []string `json:"effective_scopes"`
	EffectiveResourceIDs         []string `json:"effective_resource_ids"`
	EffectiveResources           []string `json:"effective_resources"`
	EffectiveResourceConstrained bool     `json:"effective_resource_constrained"`
	EffectiveMaxHops             *int     `json:"effective_max_hops"`
	EffectiveTTLSeconds          *int     `json:"effective_ttl_seconds"`
	EarliestExpiresAt            *string  `json:"earliest_expires_at"`
}

// DelegationEdge is one delegation graph edge.
type DelegationEdge struct {
	ID                    string         `json:"id"`
	ZoneID                string         `json:"zone_id"`
	SourceSessionID       string         `json:"source_session_id"`
	TargetSessionID       string         `json:"target_session_id"`
	IssuerApplicationID   string         `json:"issuer_application_id"`
	ReceiverApplicationID string         `json:"receiver_application_id"`
	ParentEdgeID          *string        `json:"parent_edge_id"`
	ResourceID            *string        `json:"resource_id"`
	Scopes                []string       `json:"scopes"`
	ConstraintsJSON       map[string]any `json:"constraints_json"`
	Status                string         `json:"status"`
	ExpiresAt             string         `json:"expires_at"`
	EdgeVersion           int            `json:"edge_version"`
	RevokedAt             *string        `json:"revoked_at"`
	CreatedAt             string         `json:"created_at"`
}

// TraverseNode is one node in a delegation subtree traversal.
type TraverseNode struct {
	ID              string `json:"id"`
	SourceSessionID string `json:"source_session_id"`
	TargetSessionID string `json:"target_session_id"`
	Depth           int    `json:"depth"`
}

// DelegationImpact is the blast radius preview for revoking one edge.
type DelegationImpact struct {
	EdgeID                  string         `json:"edge_id"`
	AffectedEdges           []TraverseNode `json:"affected_edges"`
	AffectedAgents          []string       `json:"affected_agents"`
	AffectedSubjectSessions []string       `json:"affected_subject_sessions"`
}

// ActiveDelegations is one page of active delegation edges.
type ActiveDelegations struct {
	Items      []DelegationEdge `json:"items"`
	NextCursor *string          `json:"next_cursor"`
}

// DelegationRevocation is the result of a cascading edge revocation.
type DelegationRevocation struct {
	RevokedEdges     int `json:"revoked_edges"`
	AffectedSessions int `json:"affected_sessions"`
}

// PolicyTemplatesService covers /v1/policy-templates.
type PolicyTemplatesService struct{ client *AdminClient }

func (s *PolicyTemplatesService) List(ctx context.Context) ([]PolicyTemplate, error) {
	var out []PolicyTemplate
	err := s.client.do(ctx, http.MethodGet, "/v1/policy-templates", nil, &out, false)
	return out, err
}

func (s *PolicyTemplatesService) Get(ctx context.Context, templateID string) (*PolicyTemplate, error) {
	templates, err := s.List(ctx)
	if err != nil {
		return nil, err
	}
	for index := range templates {
		if templates[index].ID == templateID {
			return &templates[index], nil
		}
	}
	return nil, &AdminAPIError{
		Status: http.StatusNotFound,
		Code:   "policy_template_not_found",
		Body:   map[string]any{"error": "policy_template_not_found", "id": templateID},
		Target: baseAPI,
	}
}

// GrantsService covers /v1/zones/{zone}/grants.
type GrantsService struct{ client *AdminClient }

func (s *GrantsService) List(ctx context.Context, zoneID string, query *GrantQuery) ([]Grant, error) {
	var out struct {
		Items []Grant `json:"items"`
	}
	if err := s.client.request(ctx, baseAPI, http.MethodGet, "/v1/zones/"+zoneID+"/grants", query.values(), nil, &out, false); err != nil {
		return nil, err
	}
	if out.Items == nil {
		return nil, errors.New("grants response missing items")
	}
	return out.Items, nil
}

func (s *GrantsService) Get(ctx context.Context, zoneID, grantID string) (*Grant, error) {
	var out Grant
	if err := s.client.do(ctx, http.MethodGet, "/v1/zones/"+zoneID+"/grants/"+grantID, nil, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *GrantsService) Create(ctx context.Context, zoneID string, body map[string]any) (*Grant, error) {
	var out Grant
	if err := s.client.do(ctx, http.MethodPost, "/v1/zones/"+zoneID+"/grants", body, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *GrantsService) Revoke(ctx context.Context, zoneID, grantID string) error {
	return s.client.do(ctx, http.MethodDelete, "/v1/zones/"+zoneID+"/grants/"+grantID, nil, nil, true)
}

// SubjectIssuersService covers /v1/zones/{zone}/subject-issuers.
type SubjectIssuersService struct{ client *AdminClient }

// SubjectIssuer is a zone-scoped trust declaration for one external identity
// system accepted for subject federation.
type SubjectIssuer struct {
	ID       string `json:"id"`
	ZoneID   string `json:"zone_id"`
	Issuer   string `json:"issuer"`
	JWKSURL  string `json:"jwks_url"`
	Audience string `json:"audience"`
}

func (s *SubjectIssuersService) List(ctx context.Context, zoneID string) ([]SubjectIssuer, error) {
	var out struct {
		Items []SubjectIssuer `json:"items"`
	}
	if err := s.client.do(ctx, http.MethodGet, "/v1/zones/"+zoneID+"/subject-issuers", nil, &out, false); err != nil {
		return nil, err
	}
	if out.Items == nil {
		return nil, errors.New("subject issuers response missing items")
	}
	return out.Items, nil
}

func (s *SubjectIssuersService) Get(ctx context.Context, zoneID, issuerID string) (*SubjectIssuer, error) {
	var out SubjectIssuer
	if err := s.client.do(ctx, http.MethodGet, "/v1/zones/"+zoneID+"/subject-issuers/"+issuerID, nil, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *SubjectIssuersService) Create(ctx context.Context, zoneID string, body map[string]any) (*SubjectIssuer, error) {
	var out SubjectIssuer
	if err := s.client.do(ctx, http.MethodPost, "/v1/zones/"+zoneID+"/subject-issuers", body, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *SubjectIssuersService) Patch(ctx context.Context, zoneID, issuerID string, body map[string]any) (*SubjectIssuer, error) {
	var out SubjectIssuer
	if err := s.client.do(ctx, http.MethodPatch, "/v1/zones/"+zoneID+"/subject-issuers/"+issuerID, body, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *SubjectIssuersService) Delete(ctx context.Context, zoneID, issuerID string) error {
	return s.client.do(ctx, http.MethodDelete, "/v1/zones/"+zoneID+"/subject-issuers/"+issuerID, nil, nil, true)
}

// ProviderConnectionsService covers /v1/zones/{zone}/provider-connections.
type ProviderConnectionsService struct{ client *AdminClient }

func (s *ProviderConnectionsService) Create(ctx context.Context, zoneID string, body map[string]any) (*ProviderConnection, error) {
	var out ProviderConnection
	if err := s.client.do(ctx, http.MethodPost, "/v1/zones/"+zoneID+"/provider-connections", body, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *ProviderConnectionsService) AuthorizeOAuth(ctx context.Context, zoneID string, body map[string]any) (*ProviderConnectionAuthorize, error) {
	var out ProviderConnectionAuthorize
	if err := s.client.do(ctx, http.MethodPost, "/v1/zones/"+zoneID+"/provider-connections/oauth/authorize", body, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *ProviderConnectionsService) Revoke(ctx context.Context, zoneID string, body map[string]any) (*ProviderConnection, error) {
	var out ProviderConnection
	if err := s.client.do(ctx, http.MethodPost, "/v1/zones/"+zoneID+"/provider-connections/revoke", body, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

// WorkloadsService covers /v1/zones/{zone}/workloads: launcher identities and
// their credential bindings.
type WorkloadsService struct{ client *AdminClient }

func (s *WorkloadsService) List(ctx context.Context, zoneID string) ([]Workload, error) {
	return listAll[Workload](ctx, s.client, "/v1/zones/"+zoneID+"/workloads", "workloads")
}

func (s *WorkloadsService) Get(ctx context.Context, zoneID, workloadID string) (*Workload, error) {
	var out Workload
	if err := s.client.do(ctx, http.MethodGet, "/v1/zones/"+zoneID+"/workloads/"+workloadID, nil, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

// Create returns the row plus the plaintext workload secret; a sealed custody
// copy stays retrievable through GetSecret.
func (s *WorkloadsService) Create(ctx context.Context, zoneID string, body map[string]any) (map[string]any, error) {
	var out map[string]any
	err := s.client.do(ctx, http.MethodPost, "/v1/zones/"+zoneID+"/workloads", body, &out, false)
	return out, err
}

func (s *WorkloadsService) Update(ctx context.Context, zoneID, workloadID string, body map[string]any) (*Workload, error) {
	var out Workload
	if err := s.client.do(ctx, http.MethodPut, "/v1/zones/"+zoneID+"/workloads/"+workloadID, body, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

// RotateSecret rotates the credential server-side; the response carries the
// plaintext secret and the sealed custody copy in the Secret Store is
// replaced with it.
func (s *WorkloadsService) RotateSecret(ctx context.Context, zoneID, workloadID string) (map[string]any, error) {
	var out map[string]any
	err := s.client.do(ctx, http.MethodPost, "/v1/zones/"+zoneID+"/workloads/"+workloadID+"/rotate-secret", nil, &out, false)
	return out, err
}

// GetSecret retrieves the workload secret from Secret Store custody. Every
// call is recorded in the zone audit timeline as a credential reveal.
func (s *WorkloadsService) GetSecret(ctx context.Context, zoneID, workloadID string) (map[string]any, error) {
	var out map[string]any
	err := s.client.do(ctx, http.MethodGet, "/v1/zones/"+zoneID+"/workloads/"+workloadID+"/secret", nil, &out, false)
	return out, err
}

func (s *WorkloadsService) Delete(ctx context.Context, zoneID, workloadID string) error {
	return s.client.do(ctx, http.MethodDelete, "/v1/zones/"+zoneID+"/workloads/"+workloadID, nil, nil, true)
}

// SessionsService covers /v1/zones/{zone}/sessions reads; revocation is a
// side effect of grant revoke or agent terminate.
type SessionsService struct{ client *AdminClient }

func (s *SessionsService) List(ctx context.Context, zoneID string, query *SessionQuery) ([]Session, error) {
	var out struct {
		Items []Session `json:"items"`
	}
	if err := s.client.request(ctx, baseAPI, http.MethodGet, "/v1/zones/"+zoneID+"/sessions", query.values(), nil, &out, false); err != nil {
		return nil, err
	}
	if out.Items == nil {
		return nil, errors.New("sessions response missing items")
	}
	return out.Items, nil
}

// AgentSessionsService covers /v1/zones/{zone}/agent-sessions reads; CSV
// export is available directly from the API endpoint with format=csv.
type AgentSessionsService struct{ client *AdminClient }

func (s *AgentSessionsService) List(ctx context.Context, zoneID string, query *AgentSessionQuery) ([]AgentSessionRow, error) {
	var out struct {
		Items []AgentSessionRow `json:"items"`
	}
	if err := s.client.request(ctx, baseAPI, http.MethodGet, "/v1/zones/"+zoneID+"/agent-sessions", query.values(), nil, &out, false); err != nil {
		return nil, err
	}
	if out.Items == nil {
		return nil, errors.New("agent-sessions response missing items")
	}
	return out.Items, nil
}

// AuditService covers /v1/zones/{zone}/audit.
type AuditService struct{ client *AdminClient }

func (s *AuditService) List(ctx context.Context, zoneID string, query *AuditQuery) ([]AuditEvent, error) {
	var out struct {
		Items []AuditEvent `json:"items"`
	}
	if err := s.client.request(ctx, baseAPI, http.MethodGet, "/v1/zones/"+zoneID+"/audit", query.values(), nil, &out, false); err != nil {
		return nil, err
	}
	if out.Items == nil {
		return nil, errors.New("audit response missing items")
	}
	return out.Items, nil
}

func (s *AuditService) ByRequest(ctx context.Context, zoneID, requestID string) ([]AuditDetail, error) {
	var out []AuditDetail
	err := s.client.do(ctx, http.MethodGet, "/v1/zones/"+zoneID+"/audit/by-request/"+requestID, nil, &out, false)
	return out, err
}

func (s *AuditService) Explain(ctx context.Context, zoneID, requestID string) (*DecisionTrace, error) {
	var out DecisionTrace
	if err := s.client.do(ctx, http.MethodGet, "/v1/zones/"+zoneID+"/audit/by-request/"+requestID+"/explain", nil, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

// AdminAuditService covers /v1/zones/{zone}/admin-audit.
type AdminAuditService struct{ client *AdminClient }

func (s *AdminAuditService) List(ctx context.Context, zoneID string, query *AdminAuditQuery) ([]AdminAuditEvent, error) {
	var out struct {
		Items []AdminAuditEvent `json:"items"`
	}
	if err := s.client.request(ctx, baseAPI, http.MethodGet, "/v1/zones/"+zoneID+"/admin-audit", query.values(), nil, &out, false); err != nil {
		return nil, err
	}
	if out.Items == nil {
		return nil, errors.New("admin audit response missing items")
	}
	return out.Items, nil
}

// StepUpChallengesService covers /v1/zones/{zone}/step-up-challenges.
type StepUpChallengesService struct{ client *AdminClient }

func (s *StepUpChallengesService) List(ctx context.Context, zoneID string) ([]StepUpChallenge, error) {
	var out struct {
		Items []StepUpChallenge `json:"items"`
	}
	if err := s.client.do(ctx, http.MethodGet, "/v1/zones/"+zoneID+"/step-up-challenges", nil, &out, false); err != nil {
		return nil, err
	}
	if out.Items == nil {
		return nil, errors.New("step-up challenges response missing items")
	}
	return out.Items, nil
}

func (s *StepUpChallengesService) Get(ctx context.Context, zoneID, challengeID string) (*StepUpChallenge, error) {
	var out StepUpChallenge
	if err := s.client.do(ctx, http.MethodGet, "/v1/zones/"+zoneID+"/step-up-challenges/"+challengeID, nil, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

// Approve resolves the challenge; an empty reason is omitted from the body.
func (s *StepUpChallengesService) Approve(ctx context.Context, zoneID, challengeID, reason string) (*StepUpDecision, error) {
	return s.decide(ctx, zoneID, challengeID, "approve", reason)
}

// Reject resolves the challenge; an empty reason is omitted from the body.
func (s *StepUpChallengesService) Reject(ctx context.Context, zoneID, challengeID, reason string) (*StepUpDecision, error) {
	return s.decide(ctx, zoneID, challengeID, "reject", reason)
}

func (s *StepUpChallengesService) decide(ctx context.Context, zoneID, challengeID, action, reason string) (*StepUpDecision, error) {
	body := map[string]any{}
	if reason != "" {
		body["reason"] = reason
	}
	var out StepUpDecision
	if err := s.client.do(ctx, http.MethodPost, "/v1/zones/"+zoneID+"/step-up-challenges/"+challengeID+"/"+action, body, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

// AgentsService covers the coordinator /zones/{zone}/agents surface.
type AgentsService struct{ client *AdminClient }

func (s *AgentsService) List(ctx context.Context, zoneID string, query *AgentListQuery) ([]AgentSession, error) {
	var out struct {
		Items []AgentSession `json:"items"`
	}
	if err := s.client.request(ctx, baseCoordinator, http.MethodGet, "/zones/"+zoneID+"/agents", query.values(), nil, &out, false); err != nil {
		return nil, err
	}
	if out.Items == nil {
		return nil, errors.New("agents response missing items")
	}
	return out.Items, nil
}

func (s *AgentsService) Get(ctx context.Context, zoneID, agentID string) (*AgentSession, error) {
	var out AgentSession
	if err := s.client.request(ctx, baseCoordinator, http.MethodGet, "/zones/"+zoneID+"/agents/"+agentID, nil, nil, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *AgentsService) Children(ctx context.Context, zoneID, agentID string, query *AgentListQuery) ([]AgentSession, error) {
	var out struct {
		Items []AgentSession `json:"items"`
	}
	if err := s.client.request(ctx, baseCoordinator, http.MethodGet, "/zones/"+zoneID+"/agents/"+agentID+"/children", query.values(), nil, &out, false); err != nil {
		return nil, err
	}
	if out.Items == nil {
		return nil, errors.New("agent children response missing items")
	}
	return out.Items, nil
}

func (s *AgentsService) Suspend(ctx context.Context, zoneID, agentID string) (map[string]any, error) {
	var out map[string]any
	err := s.client.request(ctx, baseCoordinator, http.MethodPatch, "/zones/"+zoneID+"/agents/"+agentID+"/suspend", nil, nil, &out, false)
	return out, err
}

func (s *AgentsService) Resume(ctx context.Context, zoneID, agentID string) (map[string]any, error) {
	var out map[string]any
	err := s.client.request(ctx, baseCoordinator, http.MethodPatch, "/zones/"+zoneID+"/agents/"+agentID+"/resume", nil, nil, &out, false)
	return out, err
}

func (s *AgentsService) Terminate(ctx context.Context, zoneID, agentID string) error {
	return s.client.request(ctx, baseCoordinator, http.MethodDelete, "/zones/"+zoneID+"/agents/"+agentID, nil, nil, nil, true)
}

func (s *AgentsService) EffectiveAuthority(ctx context.Context, zoneID, agentID string) (*EffectiveAuthority, error) {
	var out EffectiveAuthority
	if err := s.client.request(ctx, baseCoordinator, http.MethodGet, "/zones/"+zoneID+"/agents/"+agentID+"/effective-authority", nil, nil, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

// DelegationsService covers the coordinator /zones/{zone}/delegations surface.
type DelegationsService struct{ client *AdminClient }

func (s *DelegationsService) Active(ctx context.Context, zoneID string) (*ActiveDelegations, error) {
	var out ActiveDelegations
	if err := s.client.request(ctx, baseCoordinator, http.MethodGet, "/zones/"+zoneID+"/delegations/active", nil, nil, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *DelegationsService) Inbound(ctx context.Context, zoneID, sessionID string) ([]DelegationEdge, error) {
	var out []DelegationEdge
	err := s.client.request(ctx, baseCoordinator, http.MethodGet, "/zones/"+zoneID+"/delegations/inbound/"+sessionID, nil, nil, &out, false)
	return out, err
}

func (s *DelegationsService) Outbound(ctx context.Context, zoneID, sessionID string) ([]DelegationEdge, error) {
	var out []DelegationEdge
	err := s.client.request(ctx, baseCoordinator, http.MethodGet, "/zones/"+zoneID+"/delegations/outbound/"+sessionID, nil, nil, &out, false)
	return out, err
}

func (s *DelegationsService) Traverse(ctx context.Context, zoneID, edgeID string) ([]TraverseNode, error) {
	var out []TraverseNode
	err := s.client.request(ctx, baseCoordinator, http.MethodGet, "/zones/"+zoneID+"/delegations/"+edgeID+"/traverse", nil, nil, &out, false)
	return out, err
}

func (s *DelegationsService) Impact(ctx context.Context, zoneID, edgeID string) (*DelegationImpact, error) {
	var out DelegationImpact
	if err := s.client.request(ctx, baseCoordinator, http.MethodGet, "/zones/"+zoneID+"/delegations/"+edgeID+"/impact", nil, nil, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *DelegationsService) Revoke(ctx context.Context, zoneID, edgeID string) (*DelegationRevocation, error) {
	var out DelegationRevocation
	if err := s.client.request(ctx, baseCoordinator, http.MethodPatch, "/zones/"+zoneID+"/delegations/"+edgeID+"/revoke", nil, nil, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}
