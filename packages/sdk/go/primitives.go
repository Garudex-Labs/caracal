// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// SDK primitives: spawn an agent session and delegate authority.

package sdk

import (
	"context"
	"errors"
)

// LifecycleHook fires before fn runs (start) and after it returns (end).
type LifecycleHook func(context.Context, CaracalContext) error

// SpawnInput controls agent session spawning.
type SpawnInput struct {
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
	OnAgentStart  LifecycleHook
	OnAgentEnd    LifecycleHook
}

// Spawn spawns an agent session, runs fn with the bound CaracalContext,
// then terminates the session. For Kind==KindService, termination is skipped.
func Spawn(ctx context.Context, opts SpawnInput, fn func(context.Context) error) error {
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
		SubjectToken:   opts.SubjectToken,
		ZoneID:         opts.ZoneID,
		ClientID:       opts.ApplicationID,
		AgentSessionID: res.AgentSessionID,
		ParentEdgeID:   parent.DelegationEdgeID,
		SessionID:      sessionID,
		TraceID:        traceID,
		Hop:            parent.Hop,
	}

	child := Bind(ctx, c)
	if opts.OnAgentStart != nil {
		if err := opts.OnAgentStart(child, c); err != nil {
			if kind != KindService {
				return errors.Join(err, TerminateAgent(ctx, opts.Coordinator, opts.SubjectToken, opts.ZoneID, res.AgentSessionID))
			}
			return err
		}
	}
	runErr := fn(child)
	if opts.OnAgentEnd != nil {
		runErr = errors.Join(runErr, opts.OnAgentEnd(child, c))
	}

	if kind != KindService {
		runErr = errors.Join(runErr, TerminateAgent(ctx, opts.Coordinator, opts.SubjectToken, opts.ZoneID, res.AgentSessionID))
	}
	return runErr
}

// DelegateInput controls delegation edge creation.
type DelegateInput struct {
	Coordinator      *CoordinatorClient
	ToAgentSessionID string
	ToApplicationID  string
	Scopes           []string
	Constraints      *DelegationConstraints
	TTLSeconds       int
}

// Delegate creates a delegation edge from the current agent session,
// binds a child context with the edge, and runs fn.
func Delegate(ctx context.Context, opts DelegateInput, fn func(context.Context) error) error {
	c, ok := Current(ctx)
	if !ok || c.AgentSessionID == "" {
		return errors.New("caracal: Delegate requires an active agent session in context")
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

// DelegateToSpawnInput atomically spawns a child agent session and records
// a delegation edge from the parent before running fn.
type DelegateToSpawnInput struct {
	Coordinator          *CoordinatorClient
	ZoneID               string
	ApplicationID        string
	SubjectToken         string
	Scopes               []string
	Constraints          *DelegationConstraints
	DelegationTTLSeconds int
	SessionSID           string
	Kind                 AgentKind
	TTLSeconds           int
	Metadata             map[string]any
	TraceID              string
	OnAgentStart         LifecycleHook
	OnAgentEnd           LifecycleHook
}

// DelegateToSpawn spawns a child session and immediately issues a
// parent→child delegation edge before yielding the child context to fn.
// Use this when handing the resulting context off to a background goroutine
// where the parent may go out of scope before the child issues its first call.
func DelegateToSpawn(ctx context.Context, opts DelegateToSpawnInput, fn func(context.Context) error) error {
	parent, ok := Current(ctx)
	if !ok || parent.AgentSessionID == "" {
		return errors.New("caracal: DelegateToSpawn requires an active agent session in context")
	}
	kind := opts.Kind
	if kind == "" {
		kind = KindInstance
	}

	spawnRes, err := SpawnAgent(ctx, opts.Coordinator, opts.SubjectToken, SpawnRequest{
		ZoneID:        opts.ZoneID,
		ApplicationID: opts.ApplicationID,
		SessionSID:    opts.SessionSID,
		ParentID:      parent.AgentSessionID,
		Kind:          kind,
		TTLSeconds:    opts.TTLSeconds,
		Metadata:      opts.Metadata,
	})
	if err != nil {
		return err
	}

	delRes, err := CreateDelegation(ctx, opts.Coordinator, parent.SubjectToken, DelegationRequest{
		ZoneID:                parent.ZoneID,
		IssuerApplicationID:   parent.ClientID,
		SourceSessionID:       parent.AgentSessionID,
		TargetSessionID:       spawnRes.AgentSessionID,
		ReceiverApplicationID: opts.ApplicationID,
		Scopes:                opts.Scopes,
		Constraints:           opts.Constraints,
		TTLSeconds:            opts.DelegationTTLSeconds,
	})
	if err != nil {
		if kind != KindService {
			return errors.Join(err, TerminateAgent(ctx, opts.Coordinator, opts.SubjectToken, opts.ZoneID, spawnRes.AgentSessionID))
		}
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
		AgentSessionID:   spawnRes.AgentSessionID,
		DelegationEdgeID: delRes.DelegationEdgeID,
		ParentEdgeID:     delRes.DelegationEdgeID,
		SessionID:        sessionID,
		TraceID:          traceID,
		Hop:              parent.Hop + 1,
	}

	child := Bind(ctx, c)
	if opts.OnAgentStart != nil {
		if err := opts.OnAgentStart(child, c); err != nil {
			if kind != KindService {
				return errors.Join(err, TerminateAgent(ctx, opts.Coordinator, opts.SubjectToken, opts.ZoneID, spawnRes.AgentSessionID))
			}
			return err
		}
	}
	runErr := fn(child)
	if opts.OnAgentEnd != nil {
		runErr = errors.Join(runErr, opts.OnAgentEnd(child, c))
	}

	if kind != KindService {
		runErr = errors.Join(runErr, TerminateAgent(ctx, opts.Coordinator, opts.SubjectToken, opts.ZoneID, spawnRes.AgentSessionID))
	}
	return runErr
}
