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

// ErrNoContext is returned when no CaracalContext is bound.
var ErrNoContext = errors.New("caracal: no context bound on this path")

// Bind returns a new context.Context carrying ctx.
func Bind(parent context.Context, c CaracalContext) context.Context {
	return context.WithValue(parent, contextKey{}, c)
}

// Current returns the CaracalContext from ctx, or ErrNoContext.
func Current(ctx context.Context) (CaracalContext, error) {
	v := ctx.Value(contextKey{})
	if v == nil {
		return CaracalContext{}, ErrNoContext
	}
	return v.(CaracalContext), nil
}

// MustCurrent panics if no CaracalContext is bound.
func MustCurrent(ctx context.Context) CaracalContext {
	c, err := Current(ctx)
	if err != nil {
		panic(err)
	}
	return c
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
