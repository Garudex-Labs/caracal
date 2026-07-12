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
	ClientSecret      string
	AuthorityRecordID string
	SessionID         string
	DelegationID      string
	Scopes            []string
	TimeoutMillis     int
	TTLSeconds        int
	ChallengeID       string
	// ForceRefresh skips the cached token and mints a fresh one; the result
	// still refills the cache.
	ForceRefresh bool
	// OneShot mints without reading, writing, or joining the token cache.
	OneShot bool
}

// TokenExchangeResponse is a validated STS token exchange result.
type TokenExchangeResponse struct {
	AccessToken     string
	TokenType       string
	ExpiresIn       int
	IssuedAt        int64
	TargetResources []string
}

// MintedMandate is a minted scoped mandate: the bearer token to present and
// how long it stays valid, so callers can schedule refresh without decoding
// the JWT.
type MintedMandate struct {
	Token            string
	ExpiresInSeconds int
}

// ApprovalState is the lifecycle state of an approval challenge.
// ApprovalApproved means a retry of the held mint with the approval id will
// succeed; ApprovalRejected and ApprovalExpired are terminal; ApprovalConsumed
// means another request already spent the approval; ApprovalPending means no
// decision arrived within the wait and polling again is safe.
type ApprovalState string

const (
	ApprovalPending  ApprovalState = "pending"
	ApprovalApproved ApprovalState = "approved"
	ApprovalRejected ApprovalState = "rejected"
	ApprovalExpired  ApprovalState = "expired"
	ApprovalConsumed ApprovalState = "consumed"
)

func approvalState(value string) (ApprovalState, error) {
	switch state := ApprovalState(value); state {
	case ApprovalPending, ApprovalApproved, ApprovalRejected, ApprovalExpired, ApprovalConsumed:
		return state, nil
	default:
		return "", fmt.Errorf("step-up status returned an unknown challenge state: %s", value)
	}
}

// ApprovalRequiredError carries an STS human-approval hold: the approval to
// surface to an approver and the binding proving which request it covers.
type ApprovalRequiredError struct {
	Message    string
	ApprovalID string
	Resource   string
	State      string
	Tier       string
	Binding    string
	ExpiresAt  string
	RequestID  string
	HTTPStatus int
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

// Retryable reports whether retrying the operation may succeed without any
// change on the caller's side: transport-level congestion and availability
// failures are retryable, policy and validation outcomes are not. A hint, not
// a guarantee - callers still own backoff and attempt budgets.
func (e *CaracalError) Retryable() bool {
	if e.Code == "sts_unavailable" {
		return true
	}
	switch e.HTTPStatus {
	case 408, 425, 429:
		return true
	}
	return e.HTTPStatus >= 500
}

// Event is one completed control-plane operation reported to the OnEvent sink.
// Type is "token.exchange" or "approval.wait"; the SDK adds "coordinator.call"
// and "delegation.accept" (carrying DelegationID and SessionID for forensic
// correlation). Cache hits count as exchanges with Cached set; single-flight
// joiners do not report. Status carries the HTTP status when a response
// arrived and Code the platform error code when the operation failed with one.
type Event struct {
	Type         string
	Ok           bool
	Duration     time.Duration
	Resources    []string
	Scopes       []string
	Cached       bool
	Status       int
	Code         string
	RequestID    string
	Replayed     bool
	Method       string
	Path         string
	ApprovalID   string
	State        string
	DelegationID string
	SessionID    string
}
