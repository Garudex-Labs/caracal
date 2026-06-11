// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// SDK primitives: spawn an agent session and delegate authority.

package sdk

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"
)

// LifecycleHook fires before fn runs (start) and after it returns (end).
type LifecycleHook func(context.Context, CaracalContext) error

// GrantMode selects how a spawned child receives authority.
type GrantMode string

const (
	GrantModeInherit GrantMode = "inherit"
	GrantModeNarrow  GrantMode = "narrow"
	GrantModeNone    GrantMode = "none"
)

// Grant is the authority handed to a spawned child. The zero value (and
// GrantInherit) runs the child under its parent's effective session: a child
// of a narrowed parent inherits that same narrowing (the server mirrors the
// parent's edge onto the child), so least-privilege is transitive by default,
// while a child of a root parent runs under full application authority.
// GrantNarrow issues a bounded delegation edge so the child holds only the
// listed scopes; the server re-validates the subset, so a narrow can never
// broaden. GrantNone spawns without issuing any edge.
type Grant struct {
	Mode        GrantMode
	Scopes      []string
	ResourceID  string
	Constraints *DelegationConstraints
	TTLSeconds  int
}

// GrantInherit runs the child under its parent's effective authority (the
// default): narrowing applied to the parent is carried forward to the child.
func GrantInherit() Grant { return Grant{Mode: GrantModeInherit} }

// GrantNone spawns a child without any delegation edge.
func GrantNone() Grant { return Grant{Mode: GrantModeNone} }

// GrantNarrow issues a bounded delegation edge limited to scopes. Set
// ResourceID, Constraints, or TTLSeconds on the returned Grant for finer control.
func GrantNarrow(scopes ...string) Grant {
	return Grant{Mode: GrantModeNarrow, Scopes: scopes}
}

// SpawnInput controls agent session spawning.
type SpawnInput struct {
	Coordinator      *CoordinatorClient
	ZoneID           string
	ApplicationID    string
	SubjectToken     string
	SubjectSessionID string
	ParentID         string
	Grant            Grant
	TTLSeconds       int
	Metadata         map[string]any
	Labels           []string
	TraceID          string
	OnAgentStart     LifecycleHook
	OnAgentEnd       LifecycleHook
}

// Spawn spawns a child agent session, runs fn with the bound CaracalContext,
// then terminates the session. The child inherits its application's authority
// by default; set Grant to GrantNarrow(...) to issue a bounded delegation edge
// so the child holds only a subset of scopes.
func Spawn(ctx context.Context, opts SpawnInput, fn func(context.Context) error) error {
	grant := opts.Grant
	if grant.Mode == "" {
		grant.Mode = GrantModeInherit
	}
	parent, _ := Current(ctx)
	parentID := opts.ParentID
	if parentID == "" {
		parentID = parent.AgentSessionID
	}

	var inheritParentEdgeID string
	if grant.Mode == GrantModeInherit && parent.AgentSessionID != "" &&
		parent.DelegationEdgeID != "" && opts.ApplicationID == parent.ApplicationID {
		inheritParentEdgeID = parent.DelegationEdgeID
	}

	res, err := SpawnAgent(ctx, opts.Coordinator, opts.SubjectToken, SpawnRequest{
		ZoneID:              opts.ZoneID,
		ApplicationID:       opts.ApplicationID,
		SubjectSessionID:    opts.SubjectSessionID,
		ParentID:            parentID,
		TTLSeconds:          opts.TTLSeconds,
		Metadata:            opts.Metadata,
		Labels:              opts.Labels,
		InheritParentEdgeID: inheritParentEdgeID,
	})
	if err != nil {
		return err
	}

	delegationEdgeID := res.DelegationEdgeID
	hop := parent.Hop
	if delegationEdgeID != "" {
		hop = parent.Hop + 1
	}
	if grant.Mode == GrantModeNarrow {
		if parent.AgentSessionID == "" {
			return errors.Join(
				errors.New("caracal: grant narrow requires an active parent agent session"),
				TerminateAgent(ctx, opts.Coordinator, opts.SubjectToken, opts.ZoneID, res.AgentSessionID),
			)
		}
		delRes, derr := CreateDelegation(ctx, opts.Coordinator, parent.SubjectToken, DelegationRequest{
			ZoneID:                opts.ZoneID,
			IssuerApplicationID:   parent.ApplicationID,
			SourceSessionID:       parent.AgentSessionID,
			TargetSessionID:       res.AgentSessionID,
			ReceiverApplicationID: opts.ApplicationID,
			ParentEdgeID:          parent.DelegationEdgeID,
			ResourceID:            grant.ResourceID,
			Scopes:                grant.Scopes,
			Constraints:           grant.Constraints,
			TTLSeconds:            grant.TTLSeconds,
		})
		if derr != nil {
			return errors.Join(derr, TerminateAgent(ctx, opts.Coordinator, opts.SubjectToken, opts.ZoneID, res.AgentSessionID))
		}
		delegationEdgeID = delRes.DelegationEdgeID
		hop = parent.Hop + 1
	}

	traceID := opts.TraceID
	if traceID == "" {
		traceID = parent.TraceID
	}
	sessionID := opts.SubjectSessionID
	if sessionID == "" {
		sessionID = parent.SessionID
	}

	c := CaracalContext{
		SubjectToken:     opts.SubjectToken,
		ZoneID:           opts.ZoneID,
		ApplicationID:    opts.ApplicationID,
		AgentSessionID:   res.AgentSessionID,
		DelegationEdgeID: delegationEdgeID,
		ParentEdgeID:     parent.DelegationEdgeID,
		SessionID:        sessionID,
		TraceID:          traceID,
		Hop:              hop,
	}

	child := Bind(ctx, c)
	if opts.OnAgentStart != nil {
		if err := opts.OnAgentStart(child, c); err != nil {
			return errors.Join(err, TerminateAgent(ctx, opts.Coordinator, opts.SubjectToken, opts.ZoneID, res.AgentSessionID))
		}
	}
	runErr := fn(child)
	if opts.OnAgentEnd != nil {
		runErr = errors.Join(runErr, opts.OnAgentEnd(child, c))
	}
	runErr = errors.Join(runErr, TerminateAgent(ctx, opts.Coordinator, opts.SubjectToken, opts.ZoneID, res.AgentSessionID))
	return runErr
}

// DelegateInput controls delegation edge creation.
type DelegateInput struct {
	Coordinator      *CoordinatorClient
	ToAgentSessionID string
	ToApplicationID  string
	ResourceID       string
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
		IssuerApplicationID:   c.ApplicationID,
		SourceSessionID:       c.AgentSessionID,
		TargetSessionID:       opts.ToAgentSessionID,
		ReceiverApplicationID: opts.ToApplicationID,
		ParentEdgeID:          c.DelegationEdgeID,
		ResourceID:            opts.ResourceID,
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

// SpawnServiceInput controls long-lived service agent spawning.
type SpawnServiceInput struct {
	Coordinator       *CoordinatorClient
	ZoneID            string
	ApplicationID     string
	SubjectToken      string
	SubjectSessionID  string
	ParentID          string
	TTLSeconds        int
	Metadata          map[string]any
	Labels            []string
	TraceID           string
	HeartbeatInterval time.Duration
	OnAgentStart      LifecycleHook
}

// ServiceAgent is a handle for a long-lived service agent session. Unlike
// Spawn, a service session is not terminated automatically: the holder must
// Heartbeat to keep its lease and Close to retire it. Set
// SpawnServiceInput.HeartbeatInterval to renew the lease from a background
// goroutine so it survives long provider/resource streams.
type ServiceAgent struct {
	Context     CaracalContext
	coordinator *CoordinatorClient
	stop        chan struct{}
	stopOnce    sync.Once
	wg          sync.WaitGroup
}

// AgentSessionID returns the service session identifier.
func (s *ServiceAgent) AgentSessionID() string {
	return s.Context.AgentSessionID
}

// Heartbeat renews the service session lease.
func (s *ServiceAgent) Heartbeat(ctx context.Context) error {
	return HeartbeatAgent(ctx, s.coordinator, s.Context.SubjectToken, s.Context.ZoneID, s.Context.AgentSessionID)
}

func (s *ServiceAgent) startAutoHeartbeat(interval time.Duration) {
	s.stop = make(chan struct{})
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-s.stop:
				return
			case <-ticker.C:
				if err := s.Heartbeat(context.Background()); err != nil {
					slog.Warn("caracal auto-heartbeat failed; retrying next tick",
						"agent_session_id", s.Context.AgentSessionID, "err", err)
				}
			}
		}
	}()
}

// Close retires the service session.
func (s *ServiceAgent) Close(ctx context.Context) error {
	if s.stop != nil {
		s.stopOnce.Do(func() { close(s.stop) })
		s.wg.Wait()
	}
	return TerminateAgent(ctx, s.coordinator, s.Context.SubjectToken, s.Context.ZoneID, s.Context.AgentSessionID)
}

// SpawnService spawns a long-lived service agent session and returns a handle
// the caller owns. The session carries a heartbeat lease; renew it with
// ServiceAgent.Heartbeat and retire it with ServiceAgent.Close.
func SpawnService(ctx context.Context, opts SpawnServiceInput) (*ServiceAgent, error) {
	parent, _ := Current(ctx)
	parentID := opts.ParentID
	if parentID == "" {
		parentID = parent.AgentSessionID
	}

	res, err := SpawnAgent(ctx, opts.Coordinator, opts.SubjectToken, SpawnRequest{
		ZoneID:           opts.ZoneID,
		ApplicationID:    opts.ApplicationID,
		SubjectSessionID: opts.SubjectSessionID,
		ParentID:         parentID,
		Lifecycle:        LifecycleService,
		TTLSeconds:       opts.TTLSeconds,
		Metadata:         opts.Metadata,
		Labels:           opts.Labels,
	})
	if err != nil {
		return nil, err
	}

	traceID := opts.TraceID
	if traceID == "" {
		traceID = parent.TraceID
	}
	sessionID := opts.SubjectSessionID
	if sessionID == "" {
		sessionID = parent.SessionID
	}

	c := CaracalContext{
		SubjectToken:   opts.SubjectToken,
		ZoneID:         opts.ZoneID,
		ApplicationID:  opts.ApplicationID,
		AgentSessionID: res.AgentSessionID,
		ParentEdgeID:   parent.DelegationEdgeID,
		SessionID:      sessionID,
		TraceID:        traceID,
		Hop:            parent.Hop,
	}
	if opts.OnAgentStart != nil {
		if err := opts.OnAgentStart(ctx, c); err != nil {
			return nil, errors.Join(err, TerminateAgent(ctx, opts.Coordinator, opts.SubjectToken, opts.ZoneID, res.AgentSessionID))
		}
	}
	agent := &ServiceAgent{Context: c, coordinator: opts.Coordinator}
	if opts.HeartbeatInterval > 0 {
		agent.startAutoHeartbeat(opts.HeartbeatInterval)
	}
	return agent, nil
}
