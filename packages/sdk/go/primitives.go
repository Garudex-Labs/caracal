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
	TokenSource      func(context.Context) (string, error)
	Invalidate       func()
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

type sessionInput struct {
	coordinator      *CoordinatorClient
	zoneID           string
	applicationID    string
	subjectToken     string
	tokenSource      func(context.Context) (string, error)
	invalidate       func()
	subjectSessionID string
	parentID         string
	grant            Grant
	ttlSeconds       int
	metadata         map[string]any
	labels           []string
	traceID          string
}

type session struct {
	agentSessionID string
	ctx            CaracalContext
	bearer         func(context.Context) (string, error)
}

// retire terminates a session on a cleanup path. It detaches from the caller's
// cancellation so an expired or canceled caller context cannot strand the
// session, and resolves a fresh bearer when a token source is configured.
func retire(ctx context.Context, coordinator *CoordinatorClient, bearer func(context.Context) (string, error), zoneID, agentSessionID string) error {
	cleanupCtx := context.WithoutCancel(ctx)
	token, err := bearer(cleanupCtx)
	if err != nil {
		return err
	}
	return TerminateAgent(cleanupCtx, coordinator, token, zoneID, agentSessionID)
}

func establishSession(ctx context.Context, in sessionInput, lifecycle Lifecycle) (*session, error) {
	grant := in.grant
	if grant.Mode == "" {
		grant.Mode = GrantModeInherit
	}
	parent, hasParent := Current(ctx)
	parentID := in.parentID
	if parentID == "" {
		parentID = parent.AgentSessionID
	}
	token := in.subjectToken
	bearer := func(c context.Context) (string, error) {
		if in.tokenSource != nil {
			return in.tokenSource(c)
		}
		return token, nil
	}

	var inheritParentEdgeID string
	if grant.Mode == GrantModeInherit && parent.AgentSessionID != "" &&
		parent.DelegationEdgeID != "" && in.applicationID == parent.ApplicationID {
		inheritParentEdgeID = parent.DelegationEdgeID
	}
	req := SpawnRequest{
		ZoneID:              in.zoneID,
		ApplicationID:       in.applicationID,
		SubjectSessionID:    in.subjectSessionID,
		ParentID:            parentID,
		Lifecycle:           lifecycle,
		TTLSeconds:          in.ttlSeconds,
		Metadata:            in.metadata,
		Labels:              in.labels,
		InheritParentEdgeID: inheritParentEdgeID,
	}
	res, err := SpawnAgent(ctx, in.coordinator, token, req)
	if err != nil {
		// A cached token can be rejected before its exp (server-side session
		// revocation after a credential rotation); force one refresh and retry
		// the spawn once.
		var coordErr *CoordinatorError
		if !errors.As(err, &coordErr) || coordErr.StatusCode != 401 || in.invalidate == nil || in.tokenSource == nil {
			return nil, err
		}
		in.invalidate()
		if token, err = in.tokenSource(ctx); err != nil {
			return nil, err
		}
		if res, err = SpawnAgent(ctx, in.coordinator, token, req); err != nil {
			return nil, err
		}
	}

	delegationEdgeID := res.DelegationEdgeID
	hop := parent.Hop
	if delegationEdgeID != "" && hasParent {
		hop = parent.Hop + 1
	}
	if grant.Mode == GrantModeNarrow {
		if parent.AgentSessionID == "" {
			return nil, errors.Join(
				errors.New("caracal: grant narrow requires an active parent agent session"),
				retire(ctx, in.coordinator, bearer, in.zoneID, res.AgentSessionID),
			)
		}
		delRes, derr := CreateDelegation(ctx, in.coordinator, parent.SubjectToken, DelegationRequest{
			ZoneID:                in.zoneID,
			IssuerApplicationID:   parent.ApplicationID,
			SourceSessionID:       parent.AgentSessionID,
			TargetSessionID:       res.AgentSessionID,
			ReceiverApplicationID: in.applicationID,
			ParentEdgeID:          parent.DelegationEdgeID,
			ResourceID:            grant.ResourceID,
			Scopes:                grant.Scopes,
			Constraints:           grant.Constraints,
			TTLSeconds:            grant.TTLSeconds,
		})
		if derr != nil {
			return nil, errors.Join(derr, retire(ctx, in.coordinator, bearer, in.zoneID, res.AgentSessionID))
		}
		delegationEdgeID = delRes.DelegationEdgeID
		hop = parent.Hop + 1
	}

	traceID := in.traceID
	if traceID == "" {
		traceID = parent.TraceID
	}
	sessionID := in.subjectSessionID
	if sessionID == "" {
		sessionID = parent.SessionID
	}

	c := CaracalContext{
		SubjectToken:     token,
		ZoneID:           in.zoneID,
		ApplicationID:    in.applicationID,
		AgentSessionID:   res.AgentSessionID,
		DelegationEdgeID: delegationEdgeID,
		ParentEdgeID:     parent.DelegationEdgeID,
		SessionID:        sessionID,
		TraceID:          traceID,
		TraceFlags:       parent.TraceFlags,
		TraceState:       parent.TraceState,
		Baggage:          parent.Baggage,
		Hop:              hop,
	}
	return &session{agentSessionID: res.AgentSessionID, ctx: c, bearer: bearer}, nil
}

// Spawn spawns a child agent session, runs fn with the bound CaracalContext,
// then terminates the session. The child inherits its application's authority
// by default; set Grant to GrantNarrow(...) to issue a bounded delegation edge
// so the child holds only a subset of scopes.
func Spawn(ctx context.Context, opts SpawnInput, fn func(context.Context) error) error {
	sess, err := establishSession(ctx, sessionInput{
		coordinator:      opts.Coordinator,
		zoneID:           opts.ZoneID,
		applicationID:    opts.ApplicationID,
		subjectToken:     opts.SubjectToken,
		tokenSource:      opts.TokenSource,
		invalidate:       opts.Invalidate,
		subjectSessionID: opts.SubjectSessionID,
		parentID:         opts.ParentID,
		grant:            opts.Grant,
		ttlSeconds:       opts.TTLSeconds,
		metadata:         opts.Metadata,
		labels:           opts.Labels,
		traceID:          opts.TraceID,
	}, "")
	if err != nil {
		return err
	}

	child := Bind(ctx, sess.ctx)
	if opts.OnAgentStart != nil {
		if err := opts.OnAgentStart(child, sess.ctx); err != nil {
			return errors.Join(err, retire(ctx, opts.Coordinator, sess.bearer, opts.ZoneID, sess.agentSessionID))
		}
	}
	runErr := fn(child)
	if opts.OnAgentEnd != nil {
		runErr = errors.Join(runErr, opts.OnAgentEnd(child, sess.ctx))
	}
	return errors.Join(runErr, retire(ctx, opts.Coordinator, sess.bearer, opts.ZoneID, sess.agentSessionID))
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
	TokenSource       func(context.Context) (string, error)
	Invalidate        func()
	SubjectSessionID  string
	ParentID          string
	Grant             Grant
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
	tokenSource func(context.Context) (string, error)
	invalidate  func()
	stop        chan struct{}
	wg          sync.WaitGroup
	closeOnce   sync.Once
	closeErr    error
}

// AgentSessionID returns the service session identifier.
func (s *ServiceAgent) AgentSessionID() string {
	return s.Context.AgentSessionID
}

func (s *ServiceAgent) bearer(ctx context.Context) (string, error) {
	if s.tokenSource != nil {
		return s.tokenSource(ctx)
	}
	return s.Context.SubjectToken, nil
}

// Heartbeat renews the service session lease.
func (s *ServiceAgent) Heartbeat(ctx context.Context) error {
	token, err := s.bearer(ctx)
	if err != nil {
		return err
	}
	err = HeartbeatAgent(ctx, s.coordinator, token, s.Context.ZoneID, s.Context.AgentSessionID)
	if err == nil {
		return nil
	}
	// A cached token can be rejected before its exp (server-side session
	// revocation after a credential rotation); force one refresh and retry so
	// the lease survives the rotation.
	var coordErr *CoordinatorError
	if !errors.As(err, &coordErr) || coordErr.StatusCode != 401 || s.invalidate == nil {
		return err
	}
	s.invalidate()
	if token, err = s.bearer(ctx); err != nil {
		return err
	}
	return HeartbeatAgent(ctx, s.coordinator, token, s.Context.ZoneID, s.Context.AgentSessionID)
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
				tickCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				err := s.Heartbeat(tickCtx)
				cancel()
				if err != nil {
					slog.Warn("caracal auto-heartbeat failed; retrying next tick",
						"agent_session_id", s.Context.AgentSessionID, "err", err)
				}
			}
		}
	}()
}

// Close retires the service session. Idempotent: repeat calls return the
// first result.
func (s *ServiceAgent) Close(ctx context.Context) error {
	s.closeOnce.Do(func() {
		if s.stop != nil {
			close(s.stop)
			s.wg.Wait()
		}
		token, err := s.bearer(ctx)
		if err != nil {
			s.closeErr = err
			return
		}
		s.closeErr = TerminateAgent(ctx, s.coordinator, token, s.Context.ZoneID, s.Context.AgentSessionID)
	})
	return s.closeErr
}

// SpawnService spawns a long-lived service agent session and returns a handle
// the caller owns. The session carries a heartbeat lease; renew it with
// ServiceAgent.Heartbeat and retire it with ServiceAgent.Close. Set Grant to
// GrantNarrow(...) to issue a bounded delegation edge so the handle holds only
// a subset of scopes.
func SpawnService(ctx context.Context, opts SpawnServiceInput) (*ServiceAgent, error) {
	sess, err := establishSession(ctx, sessionInput{
		coordinator:      opts.Coordinator,
		zoneID:           opts.ZoneID,
		applicationID:    opts.ApplicationID,
		subjectToken:     opts.SubjectToken,
		tokenSource:      opts.TokenSource,
		invalidate:       opts.Invalidate,
		subjectSessionID: opts.SubjectSessionID,
		parentID:         opts.ParentID,
		grant:            opts.Grant,
		ttlSeconds:       opts.TTLSeconds,
		metadata:         opts.Metadata,
		labels:           opts.Labels,
		traceID:          opts.TraceID,
	}, LifecycleService)
	if err != nil {
		return nil, err
	}
	if opts.OnAgentStart != nil {
		if err := opts.OnAgentStart(ctx, sess.ctx); err != nil {
			return nil, errors.Join(err, retire(ctx, opts.Coordinator, sess.bearer, opts.ZoneID, sess.agentSessionID))
		}
	}
	agent := &ServiceAgent{
		Context:     sess.ctx,
		coordinator: opts.Coordinator,
		tokenSource: opts.TokenSource,
		invalidate:  opts.Invalidate,
	}
	if opts.HeartbeatInterval > 0 {
		agent.startAutoHeartbeat(opts.HeartbeatInterval)
	}
	return agent, nil
}
