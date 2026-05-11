// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// CaracalContext: identity and delegation context threaded through context.Context.

package sdk

import (
	"context"
	"errors"
)

type contextKey struct{}

// CaracalContext carries the Caracal identity and delegation state
// for a single execution path.
type CaracalContext struct {
	SubjectToken     string
	ZoneID           string
	ClientID         string
	AgentSessionID   string
	DelegationEdgeID string
	ParentEdgeID     string
	SessionID        string
	TraceID          string
	Hop              int
}

// Bind returns a new context.Context carrying c.
func Bind(parent context.Context, c CaracalContext) context.Context {
	return context.WithValue(parent, contextKey{}, c)
}

// Current returns the CaracalContext bound on ctx and whether one was found.
func Current(ctx context.Context) (CaracalContext, bool) {
	v := ctx.Value(contextKey{})
	if v == nil {
		return CaracalContext{}, false
	}
	return v.(CaracalContext), true
}

// FromEnvelope builds a CaracalContext from a deserialized Envelope.
func FromEnvelope(env Envelope, zoneID, clientID string) (CaracalContext, error) {
	if env.SubjectToken == "" {
		return CaracalContext{}, errors.New("caracal: envelope missing subject token")
	}
	return CaracalContext{
		SubjectToken:     env.SubjectToken,
		ZoneID:           zoneID,
		ClientID:         clientID,
		AgentSessionID:   env.AgentSessionID,
		DelegationEdgeID: env.DelegationEdgeID,
		ParentEdgeID:     env.ParentEdgeID,
		TraceID:          env.TraceID,
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
		TraceID:          c.TraceID,
		Hop:              c.Hop,
	}
}
