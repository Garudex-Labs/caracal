// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Coordinator REST client for the Go SDK.

package sdk

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// CoordinatorClient is the Caracal coordinator REST client.
type CoordinatorClient struct {
	BaseURL    string
	HTTPClient *http.Client
}

func (c *CoordinatorClient) http() *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	return http.DefaultClient
}

// AgentLifecycle distinguishes the agent session lifecycle.
type AgentLifecycle string

const (
	LifecycleAgent   AgentLifecycle = "agent"
	LifecycleService AgentLifecycle = "service"
)

// SpawnRequest parameters for coordinator agent spawn.
type SpawnRequest struct {
	ZoneID           string
	ApplicationID    string
	SubjectSessionID string
	ParentID         string
	Lifecycle        AgentLifecycle
	TTLSeconds       int
	Metadata         map[string]any
	Labels           []string
	IdempotencyKey   string
}

// SpawnResponse from the coordinator.
type SpawnResponse struct {
	AgentSessionID string `json:"agent_session_id"`
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

// DelegationResponse from the coordinator.
type DelegationResponse struct {
	DelegationEdgeID string `json:"delegation_edge_id"`
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

	extra := map[string]string{}
	key := req.IdempotencyKey
	if key == "" {
		key = deriveIdempotencyKey(req)
	}
	if key != "" {
		extra["Idempotency-Key"] = key
	}

	var out SpawnResponse
	err := doJSON(ctx, client, "POST", fmt.Sprintf("/zones/%s/agents", req.ZoneID), bearer, body, extra, &out)
	return out, err
}

// deriveIdempotencyKey produces a stable key for SDK-issued spawn retries.
// Returns empty when no stable inputs are present: in that case the caller's
// retry would still require a fresh session.
func deriveIdempotencyKey(req SpawnRequest) string {
	if req.SubjectSessionID == "" && req.ParentID == "" {
		return ""
	}
	seed := req.ApplicationID + "|" + req.SubjectSessionID + "|" + req.ParentID + "|" + string(req.Lifecycle) + "|" + strings.Join(req.Labels, ",")
	sum := sha256.Sum256([]byte(seed))
	return hex.EncodeToString(sum[:])
}

// TerminateAgent calls DELETE /zones/:zoneId/agents/:id.
func TerminateAgent(ctx context.Context, client *CoordinatorClient, bearer, zoneID, agentSessionID string) error {
	return doJSON(ctx, client, "DELETE", fmt.Sprintf("/zones/%s/agents/%s", zoneID, agentSessionID), bearer, nil, nil, nil)
}

// HeartbeatAgent renews a service agent's lease. A service session is reaped by
// the coordinator if it stops heartbeating before the lease expires.
func HeartbeatAgent(ctx context.Context, client *CoordinatorClient, bearer, zoneID, agentSessionID string) error {
	body := map[string]any{"status": "healthy"}
	return doJSON(ctx, client, "POST", fmt.Sprintf("/zones/%s/agents/%s/heartbeat", zoneID, agentSessionID), bearer, body, nil, nil)
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
	err := doJSON(ctx, client, "POST", fmt.Sprintf("/zones/%s/delegations", req.ZoneID), bearer, body, nil, &out)
	return out, err
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

	req, err := http.NewRequestWithContext(ctx, method, client.BaseURL+path, bodyReader)
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

	resp, err := client.http().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		raw, readErr := io.ReadAll(resp.Body)
		if readErr != nil {
			return fmt.Errorf("coordinator %s %s: %d (reading response body: %w)", method, path, resp.StatusCode, readErr)
		}
		return fmt.Errorf("coordinator %s %s: %d %s", method, path, resp.StatusCode, raw)
	}

	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}
