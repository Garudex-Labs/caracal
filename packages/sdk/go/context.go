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
	SubjectToken     string
	ZoneID           string
	ApplicationID    string
	AgentSessionID   string
	DelegationEdgeID string
	ParentEdgeID     string
	SessionID        string
	TraceID          string
	TraceFlags       string
	TraceState       string
	Baggage          map[string]string
	Hop              int

	// OwnToken marks a context whose subject token came from this process's
	// own credential configuration, so the transport may resolve a fresh
	// token through the client token source instead of pinning the value
	// captured at spawn. Inbound tokens bound from an envelope stay pinned:
	// substituting the application token for a caller's token would escalate
	// authority. Process-local; never serialized to the envelope.
	OwnToken bool
}

// AuthoritySummary is a redacted operator view of the bound authority chain.
type AuthoritySummary struct {
	ZoneID           string
	ApplicationID    string
	SessionID        string
	AgentSessionID   string
	DelegationEdgeID string
	ParentEdgeID     string
	TraceID          string
	Hop              int
	Chain            []string
}

// VerifiedClaims is attribution a verify hook proved from the token itself.
// Claims take precedence over the caller-supplied envelope, so a forged or
// stale envelope cannot override what the token asserts. Empty string fields
// and a nil Hop leave the envelope value in place.
type VerifiedClaims struct {
	ZoneID           string
	ApplicationID    string
	AgentSessionID   string
	DelegationEdgeID string
	ParentEdgeID     string
	SessionID        string
	Hop              *int
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
		SubjectToken:     env.SubjectToken,
		ZoneID:           zoneID,
		ApplicationID:    applicationID,
		AgentSessionID:   env.AgentSessionID,
		DelegationEdgeID: env.DelegationEdgeID,
		ParentEdgeID:     env.ParentEdgeID,
		SessionID:        env.SessionID,
		TraceID:          env.TraceID,
		TraceFlags:       env.TraceFlags,
		TraceState:       env.TraceState,
		Baggage:          cloneBaggage(env.Baggage),
		Hop:              env.Hop,
	}, nil
}

// ToEnvelope projects a CaracalContext to a wire Envelope.
func ToEnvelope(c CaracalContext) Envelope {
	return Envelope{
		SubjectToken:     c.SubjectToken,
		AgentSessionID:   c.AgentSessionID,
		DelegationEdgeID: c.DelegationEdgeID,
		ParentEdgeID:     c.ParentEdgeID,
		SessionID:        c.SessionID,
		TraceID:          c.TraceID,
		TraceFlags:       c.TraceFlags,
		TraceState:       c.TraceState,
		Baggage:          c.Baggage,
		Hop:              c.Hop,
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
	if c.SessionID != "" {
		chain = append(chain, "session:"+c.SessionID)
	}
	if c.AgentSessionID != "" {
		chain = append(chain, "agent-session:"+c.AgentSessionID)
	}
	if c.ParentEdgeID != "" {
		chain = append(chain, "parent-edge:"+c.ParentEdgeID)
	}
	if c.DelegationEdgeID != "" {
		chain = append(chain, "delegation-edge:"+c.DelegationEdgeID)
	}
	return AuthoritySummary{
		ZoneID:           c.ZoneID,
		ApplicationID:    c.ApplicationID,
		SessionID:        c.SessionID,
		AgentSessionID:   c.AgentSessionID,
		DelegationEdgeID: c.DelegationEdgeID,
		ParentEdgeID:     c.ParentEdgeID,
		TraceID:          c.TraceID,
		Hop:              c.Hop,
		Chain:            chain,
	}
}
