// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// SDK primitives: WithAgent and WithDelegation.

package sdk

import (
	"context"
)

// WithAgentOptions controls agent session spawning.
type WithAgentOptions struct {
	Coordinator   *CoordinatorClient
	ZoneID        string
	ApplicationID string
	SubjectToken  string
	SessionSID    string
	ParentID      string
	Kind          AgentKind
	TTLSeconds    int
	Metadata      map[string]any
	TraceID       string
}

// WithAgent spawns an agent session, runs fn with the bound CaracalContext,
// then terminates the session. For Kind==KindService, termination is skipped.
func WithAgent(ctx context.Context, opts WithAgentOptions, fn func(context.Context) error) error {
	parent, _ := Current(ctx)
	parentID := opts.ParentID
	if parentID == "" {
		parentID = parent.AgentSessionID
	}
	kind := opts.Kind
	if kind == "" {
		kind = KindInstance
	}

	res, err := SpawnAgent(ctx, opts.Coordinator, opts.SubjectToken, SpawnRequest{
		ZoneID:        opts.ZoneID,
		ApplicationID: opts.ApplicationID,
		SessionSID:    opts.SessionSID,
		ParentID:      parentID,
		Kind:          kind,
		TTLSeconds:    opts.TTLSeconds,
		Metadata:      opts.Metadata,
	})
	if err != nil {
		return err
	}

	traceID := opts.TraceID
	if traceID == "" {
		traceID = parent.TraceID
	}
	sessionID := opts.SessionSID
	if sessionID == "" {
		sessionID = parent.SessionID
	}

	c := CaracalContext{
		SubjectToken:     opts.SubjectToken,
		ZoneID:           opts.ZoneID,
		ClientID:         opts.ApplicationID,
		AgentSessionID:   res.AgentSessionID,
		ParentEdgeID:     parent.DelegationEdgeID,
		SessionID:        sessionID,
		TraceID:          traceID,
		Hop:              parent.Hop,
	}

	child := Bind(ctx, c)
	runErr := fn(child)

	if kind != KindService {
		TerminateAgent(ctx, opts.Coordinator, opts.SubjectToken, opts.ZoneID, res.AgentSessionID)
	}
	return runErr
}

// WithDelegationOptions controls delegation edge creation.
type WithDelegationOptions struct {
	Coordinator        *CoordinatorClient
	ToAgentSessionID   string
	ToApplicationID    string
	Scopes             []string
	Constraints        map[string]any
	TTLSeconds         int
}

// WithDelegation creates a delegation edge from the current agent session,
// binds a child context with the edge, and runs fn.
func WithDelegation(ctx context.Context, opts WithDelegationOptions, fn func(context.Context) error) error {
	c, err := Current(ctx)
	if err != nil {
		return err
	}
	if c.AgentSessionID == "" {
		return ErrNoContext
	}

	res, err := CreateDelegation(ctx, opts.Coordinator, c.SubjectToken, DelegationRequest{
		ZoneID:                c.ZoneID,
		IssuerApplicationID:   c.ClientID,
		SourceSessionID:       c.AgentSessionID,
		TargetSessionID:       opts.ToAgentSessionID,
		ReceiverApplicationID: opts.ToApplicationID,
		Scopes:                opts.Scopes,
		Constraints:           opts.Constraints,
		TTLSeconds:            opts.TTLSeconds,
	})
	if err != nil {
		return err
	}

	child := c
	child.ParentEdgeID = c.DelegationEdgeID
	child.DelegationEdgeID = res.DelegationEdgeID
	child.Hop = c.Hop + 1

	return fn(Bind(ctx, child))
}
