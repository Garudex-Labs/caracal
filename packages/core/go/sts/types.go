// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Wire types for the RFC 8693 token exchange shared by STS (issuer) and gateway (consumer).

package sts

// UpstreamDirective tells the gateway which URL to dial and which credential
// shape the upstream expects. ProviderToken is populated only on authenticated
// Gateway exchanges or explicit runtime credential injection exchanges; for
// caracal_jwt mode it is empty and the caller forwards TokenResponse.AccessToken.
type UpstreamDirective struct {
	URL                    string   `json:"url"`
	AuthMode               string   `json:"auth_mode"`
	AuthLocation           string   `json:"auth_location,omitempty"`
	AuthHeader             string   `json:"auth_header,omitempty"`
	QueryParamName         string   `json:"query_param_name,omitempty"`
	AuthScheme             string   `json:"auth_scheme,omitempty"`
	AllowedTokenHosts      []string `json:"allowed_token_hosts,omitempty"`
	ProviderToken          string   `json:"provider_token,omitempty"`
	ProviderID             string   `json:"provider_id,omitempty"`
	ConnectionID           string   `json:"connection_id,omitempty"`
	ForwardCaracalIdentity bool     `json:"forward_caracal_identity,omitempty"`
	ExpiresAt              int64    `json:"expires_at,omitempty"`
}

// TokenResponse is the JSON response body for a successful exchange.
type TokenResponse struct {
	AccessToken     string                       `json:"access_token"`
	TokenType       string                       `json:"token_type"`
	ExpiresIn       int                          `json:"expires_in"`
	Scope           string                       `json:"scope,omitempty"`
	IssuedTokenType string                       `json:"issued_token_type"`
	TargetResources []string                     `json:"target_resources,omitempty"`
	Upstreams       map[string]UpstreamDirective `json:"upstreams,omitempty"`
}
