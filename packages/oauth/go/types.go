// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// RFC 8693 token exchange request, response, option, and error types.

package oauth

import (
	"fmt"
	"time"
)

// ExchangeOptions configures one token exchange request.
type ExchangeOptions struct {
	ClientSecret        string
	ClientAssertion     string
	ClientAssertionType string
	ActorToken          string
	SessionID           string
	AgentSessionID      string
	DelegationEdgeID    string
	Scopes              []string
	TimeoutMillis       int
	Retries             int
	TTLSeconds          int
	ChallengeID         string
	// ForceRefresh skips the cached token and mints a fresh one; the result
	// still refills the cache.
	ForceRefresh bool
}

// TokenExchangeResponse is a validated STS token exchange result.
type TokenExchangeResponse struct {
	AccessToken string
	TokenType   string
	ExpiresIn   int
	IssuedAt    int64
}

// ApprovalRequiredError carries an STS human-approval hold: the challenge to
// surface to an approver and the binding proving which request it covers.
type ApprovalRequiredError struct {
	Message     string
	ChallengeID string
	Resource    string
	State       string
	Tier        string
	Binding     string
	ExpiresAt   string
	RequestID   string
	HTTPStatus  int
}

func (e *ApprovalRequiredError) Error() string {
	if e.Message == "" {
		return "approval required"
	}
	return fmt.Sprintf("approval required: %s", e.Message)
}

// CaracalError is a platform-reported token exchange failure. Callers branch on
// Code — the canonical error the STS emitted, such as access_denied,
// invalid_token, zone_invalid, or scope_insufficient — via errors.As; the
// description and request id are for logs and triage, never for control flow.
type CaracalError struct {
	Code        string
	Description string
	RequestID   string
	HTTPStatus  int
}

func (e *CaracalError) Error() string {
	msg := e.Description
	if msg == "" {
		msg = fmt.Sprintf("STS error %d", e.HTTPStatus)
	}
	if e.RequestID != "" {
		return fmt.Sprintf("%s (request_id=%s)", msg, e.RequestID)
	}
	return msg
}

// Event is one completed control-plane operation reported to the OnEvent sink.
// Type is "token.exchange" or "approval.wait"; the SDK adds "coordinator.call".
// Cache hits count as exchanges with Cached set; single-flight joiners do not
// report. Status carries the HTTP status when a response arrived and Code the
// platform error code when the operation failed with one.
type Event struct {
	Type        string
	Ok          bool
	Duration    time.Duration
	Resources   []string
	Scopes      []string
	Cached      bool
	Status      int
	Code        string
	Method      string
	Path        string
	ChallengeID string
	State       string
}
