// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// RFC 8693 token exchange request, response, option, and error types.

package oauth

import "fmt"

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
}

// TokenExchangeResponse is a validated STS token exchange result.
type TokenExchangeResponse struct {
	AccessToken string
	TokenType   string
	ExpiresIn   int
	IssuedAt    int64
}

// InteractionRequiredError carries an STS step-up challenge.
type InteractionRequiredError struct {
	Message     string
	ChallengeID string
	Resource    string
	ACRValues   string
}

func (e *InteractionRequiredError) Error() string {
	if e.Message == "" {
		return "interaction required"
	}
	return fmt.Sprintf("interaction required: %s", e.Message)
}
