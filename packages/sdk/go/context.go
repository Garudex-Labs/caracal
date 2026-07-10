// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// CaracalContext: identity and delegation context threaded through context.Context.

package sdk

import (
	"context"
	"errors"
	"maps"
)

type contextKey struct{}

// CaracalContext carries the Caracal identity and delegation state
// for a single execution path.
type CaracalContext struct {
	// SubjectToken is the bearer credential this context presents: the session
	// mandate every gateway-bound call and token exchange authenticates with.
	// Named for the RFC 8693 subject_token it becomes on the wire; it is not an
	// end-user identity - see SubjectAuthorityRecordID for that.
	SubjectToken             string
	ZoneID                   string
	ApplicationID            string
	SessionID                string
	DelegationID             string
	ParentDelegationID       string
	SubjectAuthorityRecordID string
	// TraceID is the W3C trace id (32 lowercase hex characters) correlating this context's requests.
	TraceID    string
	TraceFlags string
	TraceState string
	Baggage    map[string]string
	// Hop is the delegation depth: how many delegation hand-offs precede this context; 0 at the root.
	Hop int

	// OwnToken marks a context whose subject token came from this process's
	// own credential configuration, so the transport may resolve a fresh
	// token through the client token source instead of pinning the value
	// captured when the session was established. Inbound tokens bound from an
	// envelope stay pinned: substituting the application token for a caller's
	// token would escalate authority. Process-local; never serialized to the
	// envelope.
	OwnToken bool
	// TokenSource resolves a fresh bearer for contexts owned by this process.
	// Inbound contexts remain pinned because OwnToken is false.
	TokenSource func(context.Context) (string, error)
}

func contextBearer(ctx context.Context, c CaracalContext) (string, error) {
	if c.OwnToken && c.TokenSource != nil {
		return c.TokenSource(ctx)
	}
	return c.SubjectToken, nil
}

// AuthoritySummary is a redacted operator view of the bound authority chain.
type AuthoritySummary struct {
	ZoneID                   string
	ApplicationID            string
	SubjectAuthorityRecordID string
	SessionID                string
	DelegationID             string
	ParentDelegationID       string
	TraceID                  string
	Hop                      int
	Chain                    []string
}

// VerifiedClaims is attribution a verify hook proved from the token itself.
// Claims take precedence over the caller-supplied envelope, so a forged or
// stale envelope cannot override what the token asserts. Empty string fields
// and a nil Hop leave the envelope value in place.
type VerifiedClaims struct {
	ZoneID                   string
	ApplicationID            string
	SessionID                string
	DelegationID             string
	ParentDelegationID       string
	SubjectAuthorityRecordID string
	Hop                      *int
}

func cloneBaggage(baggage map[string]string) map[string]string {
	if baggage == nil {
		return nil
	}
	return maps.Clone(baggage)
}

// Bind returns a new context.Context carrying c. The baggage map is cloned so
// concurrent scopes sharing a parent cannot mutate each other's entries.
func Bind(parent context.Context, c CaracalContext) context.Context {
	c.Baggage = cloneBaggage(c.Baggage)
	return context.WithValue(parent, contextKey{}, c)
}

// Current returns the CaracalContext bound on ctx and whether one was found.
// The baggage map is cloned so callers cannot mutate the bound context.
func Current(ctx context.Context) (CaracalContext, bool) {
	v := ctx.Value(contextKey{})
	if v == nil {
		return CaracalContext{}, false
	}
	c := v.(CaracalContext)
	c.Baggage = cloneBaggage(c.Baggage)
	return c, true
}

// Capture returns a copy of the current CaracalContext for explicit task boundaries.
func Capture(ctx context.Context) (CaracalContext, bool) {
	return Current(ctx)
}

// FromEnvelope builds a CaracalContext from a deserialized Envelope.
func FromEnvelope(env Envelope, zoneID, applicationID string) (CaracalContext, error) {
	if env.SubjectToken == "" {
		return CaracalContext{}, errors.New("caracal: envelope missing subject token")
	}
	return CaracalContext{
		SubjectToken:             env.SubjectToken,
		ZoneID:                   zoneID,
		ApplicationID:            applicationID,
		SessionID:                env.SessionID,
		DelegationID:             env.DelegationID,
		ParentDelegationID:       env.ParentDelegationID,
		SubjectAuthorityRecordID: env.SubjectAuthorityRecordID,
		TraceID:                  env.TraceID,
		TraceFlags:               env.TraceFlags,
		TraceState:               env.TraceState,
		Baggage:                  cloneBaggage(env.Baggage),
		Hop:                      env.Hop,
	}, nil
}

// ToEnvelope projects a CaracalContext to a wire Envelope.
func ToEnvelope(c CaracalContext) Envelope {
	return Envelope{
		SubjectToken:             c.SubjectToken,
		SessionID:                c.SessionID,
		DelegationID:             c.DelegationID,
		ParentDelegationID:       c.ParentDelegationID,
		SubjectAuthorityRecordID: c.SubjectAuthorityRecordID,
		TraceID:                  c.TraceID,
		TraceFlags:               c.TraceFlags,
		TraceState:               c.TraceState,
		Baggage:                  c.Baggage,
		Hop:                      c.Hop,
	}
}

// DescribeAuthority returns a redacted authority-chain summary for logs and diagnostics.
func DescribeAuthority(ctx context.Context) (AuthoritySummary, bool) {
	c, ok := Current(ctx)
	if !ok {
		return AuthoritySummary{}, false
	}
	return DescribeContext(c), true
}

// DescribeContext projects a CaracalContext into user-facing authority terms.
func DescribeContext(c CaracalContext) AuthoritySummary {
	chain := []string{}
	if c.SubjectAuthorityRecordID != "" {
		chain = append(chain, "subject:"+c.SubjectAuthorityRecordID)
	}
	if c.SessionID != "" {
		chain = append(chain, "session:"+c.SessionID)
	}
	if c.ParentDelegationID != "" {
		chain = append(chain, "parent-delegation:"+c.ParentDelegationID)
	}
	if c.DelegationID != "" {
		chain = append(chain, "delegation:"+c.DelegationID)
	}
	return AuthoritySummary{
		ZoneID:                   c.ZoneID,
		ApplicationID:            c.ApplicationID,
		SubjectAuthorityRecordID: c.SubjectAuthorityRecordID,
		SessionID:                c.SessionID,
		DelegationID:             c.DelegationID,
		ParentDelegationID:       c.ParentDelegationID,
		TraceID:                  c.TraceID,
		Hop:                      c.Hop,
		Chain:                    chain,
	}
}
