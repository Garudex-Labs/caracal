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

// AgentKind distinguishes the agent session lifecycle.
type AgentKind string

const (
	KindService   AgentKind = "service"
	KindInstance  AgentKind = "instance"
	KindEphemeral AgentKind = "ephemeral"
)

// SpawnRequest parameters for coordinator agent spawn.
type SpawnRequest struct {
	ZoneID         string
	ApplicationID  string
	SessionSID     string
	ParentID       string
	Kind           AgentKind
	TTLSeconds     int
	Metadata       map[string]any
	IdempotencyKey string
}

// SpawnResponse from the coordinator.
type SpawnResponse struct {
	ID             string `json:"id"`
	AgentSessionID string `json:"agent_session_id"`
}

// DelegationConstraints narrows a delegation edge.
type DelegationConstraints struct {
	Resources []string
	Actions   []string
	MaxDepth  int
	ExpiresAt string
}

func (d *DelegationConstraints) toWire() map[string]any {
	out := map[string]any{}
	if d.Resources != nil {
		out["resources"] = d.Resources
	}
	if d.Actions != nil {
		out["actions"] = d.Actions
	}
	if d.MaxDepth > 0 {
		out["max_depth"] = d.MaxDepth
	}
	if d.ExpiresAt != "" {
		out["expires_at"] = d.ExpiresAt
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
	Scopes                []string
	Constraints           *DelegationConstraints
	TTLSeconds            int
}

// DelegationResponse from the coordinator.
type DelegationResponse struct {
	ID               string `json:"id"`
	DelegationEdgeID string `json:"delegation_edge_id"`
}

// SpawnAgent calls POST /zones/:zoneId/agents.
func SpawnAgent(ctx context.Context, client *CoordinatorClient, bearer string, req SpawnRequest) (SpawnResponse, error) {
	body := map[string]any{
		"application_id": req.ApplicationID,
		"kind":           string(req.Kind),
	}
	if req.SessionSID != "" {
		body["session_sid"] = req.SessionSID
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
	if out.AgentSessionID == "" {
		out.AgentSessionID = out.ID
	}
	return out, err
}

// deriveIdempotencyKey produces a stable key for SDK-issued spawn retries.
// Returns empty when no stable inputs are present — in that case the caller's
// retry would still require a fresh session.
func deriveIdempotencyKey(req SpawnRequest) string {
	if req.SessionSID == "" && req.ParentID == "" {
		return ""
	}
	seed := req.ApplicationID + "|" + req.SessionSID + "|" + req.ParentID + "|" + string(req.Kind)
	sum := sha256.Sum256([]byte(seed))
	return hex.EncodeToString(sum[:])
}

// TerminateAgent calls DELETE /zones/:zoneId/agents/:id.
func TerminateAgent(ctx context.Context, client *CoordinatorClient, bearer, zoneID, agentSessionID string) error {
	return doJSON(ctx, client, "DELETE", fmt.Sprintf("/zones/%s/agents/%s", zoneID, agentSessionID), bearer, nil, nil, nil)
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
	if req.Constraints != nil {
		body["constraints"] = req.Constraints.toWire()
	}
	if req.TTLSeconds > 0 {
		body["ttl_seconds"] = req.TTLSeconds
	}

	var out DelegationResponse
	err := doJSON(ctx, client, "POST", fmt.Sprintf("/zones/%s/delegations", req.ZoneID), bearer, body, nil, &out)
	if out.DelegationEdgeID == "" {
		out.DelegationEdgeID = out.ID
	}
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
