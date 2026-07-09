// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Coordinator REST client for the Go SDK.

package sdk

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	oauth "github.com/garudex-labs/caracal/packages/oauth/go"
)

// CoordinatorClient is the Caracal coordinator REST client.
type CoordinatorClient struct {
	BaseURL    string
	HTTPClient *http.Client
	// OnEvent is the observability sink attached by the Caracal facade; each
	// completed request reports here. Panics inside the sink never reach the
	// caller.
	OnEvent func(oauth.Event)
}

// CoordinatorError is a non-2xx coordinator response, carrying the status code
// so callers can branch on it (e.g. refresh a rejected bearer on 401).
type CoordinatorError struct {
	Method     string
	Path       string
	StatusCode int
	Body       string
}

func (e *CoordinatorError) Error() string {
	return fmt.Sprintf("coordinator %s %s: %d %s", e.Method, e.Path, e.StatusCode, e.Body)
}

// defaultHTTPClient bounds coordinator calls when no client is injected, so a
// stalled coordinator cannot hang a caller that forgot a context deadline.
var defaultHTTPClient = &http.Client{Timeout: 10 * time.Second}

func (c *CoordinatorClient) http() *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	return defaultHTTPClient
}

// Lifecycle distinguishes the session kinds: a task session lives by its
// wall-clock TTL and suits bounded work; a service session lives by its
// heartbeat lease and suits daemons and workers. Session records a task,
// StartSession records a service.
type Lifecycle string

const (
	LifecycleTask    Lifecycle = "task"
	LifecycleService Lifecycle = "service"
)

// SpawnRequest parameters for coordinator agent spawn.
type SpawnRequest struct {
	ZoneID           string
	ApplicationID    string
	SubjectSessionID string
	ParentID         string
	Lifecycle        Lifecycle
	TTLSeconds       int
	Metadata         map[string]any
	Labels           []string
	IdempotencyKey   string
	ParentAuthority  string
}

// SpawnResponse from the coordinator.
type SpawnResponse struct {
	AgentSessionID      string `json:"agent_session_id"`
	DelegationEdgeID    string `json:"delegation_edge_id"`
	HeartbeatDeadlineAt string `json:"heartbeat_deadline_at"`
}

// DelegationConstraints narrows a delegation edge.
type DelegationConstraints struct {
	Resources      []string
	MaxDepth       int
	MaxHops        int
	TTLSeconds     int
	Budget         int
	PolicyApproved bool
	ExpiresAt      string
	BroadReason    string
}

func (d *DelegationConstraints) toWire() map[string]any {
	out := map[string]any{}
	if d.Resources != nil {
		out["resources"] = d.Resources
	}
	if d.MaxDepth > 0 {
		out["max_depth"] = d.MaxDepth
	}
	if d.MaxHops > 0 {
		out["max_hops"] = d.MaxHops
	}
	if d.TTLSeconds > 0 {
		out["ttl_seconds"] = d.TTLSeconds
	}
	if d.Budget > 0 {
		out["budget"] = d.Budget
	}
	if d.PolicyApproved {
		out["policy_approved"] = d.PolicyApproved
	}
	if d.ExpiresAt != "" {
		out["expires_at"] = d.ExpiresAt
	}
	if d.BroadReason != "" {
		out["broad_reason"] = d.BroadReason
	}
	return out
}

// DelegationRequest parameters for coordinator delegation edge creation.
type DelegationRequest struct {
	ZoneID                string
	IssuerApplicationID   string
	SourceSessionID       string
	TargetSessionID       string
	ReceiverApplicationID string
	ParentEdgeID          string
	ResourceID            string
	Scopes                []string
	Constraints           *DelegationConstraints
	TTLSeconds            int
}

// DelegationResponse is the created delegation edge: its id, the scopes it
// bounds, and when it lapses.
type DelegationResponse struct {
	DelegationEdgeID string   `json:"delegation_edge_id"`
	Scopes           []string `json:"scopes"`
	ExpiresAt        string   `json:"expires_at"`
}

// HeartbeatResponse reports the session state and renewed lease deadline.
type HeartbeatResponse struct {
	Status              string
	HeartbeatDeadlineAt string
}

// SpawnAgent calls POST /zones/:zoneId/agents.
func SpawnAgent(ctx context.Context, client *CoordinatorClient, bearer string, req SpawnRequest) (SpawnResponse, error) {
	body := map[string]any{
		"application_id": req.ApplicationID,
	}
	if req.Lifecycle != "" {
		body["lifecycle"] = string(req.Lifecycle)
	}
	if req.SubjectSessionID != "" {
		body["subject_session_id"] = req.SubjectSessionID
	}
	if req.ParentID != "" {
		body["parent_id"] = req.ParentID
	}
	if req.TTLSeconds > 0 {
		body["ttl_seconds"] = req.TTLSeconds
	}
	if req.Metadata != nil {
		body["metadata"] = req.Metadata
	}
	if len(req.Labels) > 0 {
		body["labels"] = req.Labels
	}
	if req.ParentAuthority != "" {
		body["parent_authority"] = req.ParentAuthority
	}

	extra := map[string]string{}
	if req.IdempotencyKey != "" {
		extra["Idempotency-Key"] = req.IdempotencyKey
	}

	var out SpawnResponse
	if err := doJSON(ctx, client, "POST", "/zones/"+url.PathEscape(req.ZoneID)+"/agents", bearer, body, extra, &out); err != nil {
		return out, err
	}
	if out.AgentSessionID == "" {
		return out, errors.New("caracal: coordinator spawn response missing agent_session_id")
	}
	return out, nil
}

// TerminateAgent calls DELETE /zones/:zoneId/agents/:id.
func TerminateAgent(ctx context.Context, client *CoordinatorClient, bearer, zoneID, agentSessionID string) error {
	return doJSON(ctx, client, "DELETE", "/zones/"+url.PathEscape(zoneID)+"/agents/"+url.PathEscape(agentSessionID), bearer, nil, nil, nil)
}

// HeartbeatAgent renews a service agent's lease. A service session is reaped by
// the coordinator if it stops heartbeating before the lease expires; the
// response reports the renewed deadline so callers can pace renewals. An empty
// status reports "healthy".
func HeartbeatAgent(ctx context.Context, client *CoordinatorClient, bearer, zoneID, agentSessionID, status string) (HeartbeatResponse, error) {
	if status == "" {
		status = "healthy"
	}
	body := map[string]any{"status": status}
	var wire struct {
		Agent struct {
			Status              string `json:"status"`
			HeartbeatDeadlineAt string `json:"heartbeat_deadline_at"`
		} `json:"agent"`
	}
	err := doJSON(ctx, client, "POST", "/zones/"+url.PathEscape(zoneID)+"/agents/"+url.PathEscape(agentSessionID)+"/heartbeat", bearer, body, nil, &wire)
	return HeartbeatResponse{Status: wire.Agent.Status, HeartbeatDeadlineAt: wire.Agent.HeartbeatDeadlineAt}, err
}

// CreateDelegation calls POST /zones/:zoneId/delegations.
func CreateDelegation(ctx context.Context, client *CoordinatorClient, bearer string, req DelegationRequest) (DelegationResponse, error) {
	body := map[string]any{
		"issuer_application_id":   req.IssuerApplicationID,
		"source_session_id":       req.SourceSessionID,
		"target_session_id":       req.TargetSessionID,
		"receiver_application_id": req.ReceiverApplicationID,
		"scopes":                  req.Scopes,
	}
	if req.ResourceID != "" {
		body["resource_id"] = req.ResourceID
	}
	if req.ParentEdgeID != "" {
		body["parent_edge_id"] = req.ParentEdgeID
	}
	if req.Constraints != nil {
		body["constraints"] = req.Constraints.toWire()
	}
	if req.TTLSeconds > 0 {
		body["ttl_seconds"] = req.TTLSeconds
	}

	var out DelegationResponse
	if err := doJSON(ctx, client, "POST", "/zones/"+url.PathEscape(req.ZoneID)+"/delegations", bearer, body, nil, &out); err != nil {
		return out, err
	}
	if out.DelegationEdgeID == "" {
		return out, errors.New("caracal: coordinator delegation response missing delegation_edge_id")
	}
	return out, nil
}

func doJSON(ctx context.Context, client *CoordinatorClient, method, path, bearer string, body any, extraHeaders map[string]string, out any) error {
	var bodyReader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		bodyReader = bytes.NewReader(b)
	}

	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(client.BaseURL, "/")+path, bodyReader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+bearer)
	for k, v := range extraHeaders {
		req.Header.Set(k, v)
	}

	start := time.Now()
	emit := func(status int, ok bool) {
		if client.OnEvent == nil {
			return
		}
		defer func() {
			// The observability sink must never break the coordinator path.
			_ = recover()
		}()
		client.OnEvent(oauth.Event{Type: "coordinator.call", Method: method, Path: path, Status: status, Ok: ok, Duration: time.Since(start)})
	}
	resp, err := client.http().Do(req)
	if err != nil {
		emit(0, false)
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		emit(resp.StatusCode, false)
		raw, readErr := io.ReadAll(resp.Body)
		if readErr != nil {
			return &CoordinatorError{Method: method, Path: path, StatusCode: resp.StatusCode, Body: fmt.Sprintf("(reading response body: %v)", readErr)}
		}
		return &CoordinatorError{Method: method, Path: path, StatusCode: resp.StatusCode, Body: string(raw)}
	}
	emit(resp.StatusCode, true)

	if out != nil && resp.StatusCode != http.StatusNoContent {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}
