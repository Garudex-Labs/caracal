// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared error codes and types for Caracal Go services.

package errors

import "fmt"

// Code is a stable machine-readable error identifier.
type Code string

const (
	AccessDenied        Code = "access_denied"
	InvalidToken        Code = "invalid_token"
	ResourceNotFound    Code = "resource_not_found"
	Internal            Code = "internal_error"
	PolicyEvalFailed    Code = "policy_eval_failed"
	ProviderRateLimited Code = "provider_rate_limited"
	InteractionRequired Code = "interaction_required"
	STSUnavailable      Code = "sts_unavailable"
	CredentialExpired   Code = "credential_expired_not_renewable"
	PayloadTooLarge     Code = "payload_too_large"
)

// CaracalError is the canonical error type for all Caracal service responses.
type CaracalError struct {
	Code        Code   `json:"error"`
	Description string `json:"error_description,omitempty"`
	RequestID   string `json:"requestId,omitempty"`
}

func (e *CaracalError) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Description)
}

// New constructs a CaracalError with the given code and description.
func New(code Code, desc string) *CaracalError {
	return &CaracalError{Code: code, Description: desc}
}

// WithRequestID attaches a request ID to the error.
func (e *CaracalError) WithRequestID(id string) *CaracalError {
	e.RequestID = id
	return e
}
