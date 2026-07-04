// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// SDK primitives: spawn an agent session and delegate authority.

package sdk

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
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
	agentSessionID      string
	ctx                 CaracalContext
	bearer              func(context.Context) (string, error)
	heartbeatDeadlineAt string
}

// isGone reports a session the coordinator no longer holds live (terminated
// or lease-reaped); retiring it again counts as success and heartbeats can
// never revive it.
func isGone(err error) bool {
	var coordErr *CoordinatorError
	return errors.As(err, &coordErr) && (coordErr.StatusCode == 404 || coordErr.StatusCode == 409)
}

// retire terminates a session on a cleanup path. It detaches from the caller's
// cancellation (with its own deadline) so an expired or canceled caller
// context cannot strand the session, resolves a fresh bearer when a token
// source is configured, and treats an already-retired session as success.
func retire(ctx context.Context, coordinator *CoordinatorClient, bearer func(context.Context) (string, error), zoneID, agentSessionID string) error {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	token, err := bearer(cleanupCtx)
	if err != nil {
		return err
	}
	err = TerminateAgent(cleanupCtx, coordinator, token, zoneID, agentSessionID)
	if isGone(err) {
		return nil
	}
	return err
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
		IdempotencyKey:      newRandomHex(16),
		InheritParentEdgeID: inheritParentEdgeID,
	}
	const spawnRetries = 2
	var res SpawnResponse
	refreshed := false
	for attempt := 0; ; {
		var err error
		res, err = SpawnAgent(ctx, in.coordinator, token, req)
		if err == nil {
			break
		}
		var coordErr *CoordinatorError
		if errors.As(err, &coordErr) {
			// A cached token can be rejected before its exp (server-side
			// session revocation after a credential rotation); force one
			// refresh and retry the spawn once.
			if coordErr.StatusCode == 401 && !refreshed && in.invalidate != nil && in.tokenSource != nil {
				refreshed = true
				in.invalidate()
				if token, err = in.tokenSource(ctx); err != nil {
					return nil, err
				}
				continue
			}
			// The idempotency key makes retrying a 5xx safe: the coordinator
			// replays the already-created session instead of minting a duplicate.
			if coordErr.StatusCode < 500 || attempt >= spawnRetries {
				return nil, err
			}
		} else if attempt >= spawnRetries {
			return nil, err
		}
		attempt++
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Duration(attempt)*250*time.Millisecond + rand.N(100*time.Millisecond)):
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
	return &session{agentSessionID: res.AgentSessionID, ctx: c, bearer: bearer, heartbeatDeadlineAt: res.HeartbeatDeadlineAt}, nil
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
// HeartbeatInterval selects the lease renewal mode: zero (the default)
// derives the cadence from the server lease, a positive value fixes it, and
// a negative value disables the background renewal so the holder heartbeats
// manually. OnLeaseLost fires once if the coordinator reports the session
// permanently gone.
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
	OnLeaseLost       func(error)
	OnAgentStart      LifecycleHook
}

const (
	minAutoHeartbeat      = time.Second
	maxAutoHeartbeat      = 5 * time.Minute
	fallbackAutoHeartbeat = 30 * time.Second
)

// ServiceAgent is a handle for a long-lived service agent session. Unlike
// Spawn, a service session is not terminated automatically: a background
// goroutine renews the lease by default and the holder retires the session
// with Close. The renewal cadence follows the server lease deadline unless
// SpawnServiceInput.HeartbeatInterval fixes or disables it; if the
// coordinator reports the session permanently gone the goroutine stops and
// OnLeaseLost fires once.
type ServiceAgent struct {
	Context           CaracalContext
	coordinator       *CoordinatorClient
	tokenSource       func(context.Context) (string, error)
	invalidate        func()
	heartbeatInterval time.Duration
	onLeaseLost       func(error)
	mu                sync.Mutex
	deadlineAt        time.Time
	stop              chan struct{}
	wg                sync.WaitGroup
	closeOnce         sync.Once
	closeErr          error
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

// Heartbeat renews the service session lease, reporting the given status
// ("healthy" when omitted).
func (s *ServiceAgent) Heartbeat(ctx context.Context, status ...string) error {
	st := ""
	if len(status) > 0 {
		st = status[0]
	}
	token, err := s.bearer(ctx)
	if err != nil {
		return err
	}
	res, err := HeartbeatAgent(ctx, s.coordinator, token, s.Context.ZoneID, s.Context.AgentSessionID, st)
	if err != nil {
		// A cached token can be rejected before its exp (server-side session
		// revocation after a credential rotation); force one refresh and retry
		// so the lease survives the rotation.
		var coordErr *CoordinatorError
		if !errors.As(err, &coordErr) || coordErr.StatusCode != 401 || s.invalidate == nil {
			return err
		}
		s.invalidate()
		if token, err = s.bearer(ctx); err != nil {
			return err
		}
		if res, err = HeartbeatAgent(ctx, s.coordinator, token, s.Context.ZoneID, s.Context.AgentSessionID, st); err != nil {
			return err
		}
	}
	if res.HeartbeatDeadlineAt != "" {
		if t, perr := time.Parse(time.RFC3339Nano, res.HeartbeatDeadlineAt); perr == nil {
			s.mu.Lock()
			s.deadlineAt = t
			s.mu.Unlock()
		}
	}
	return nil
}

func (s *ServiceAgent) nextDelay() time.Duration {
	if s.heartbeatInterval > 0 {
		return s.heartbeatInterval
	}
	jitter := 0.9 + rand.Float64()*0.2
	s.mu.Lock()
	deadline := s.deadlineAt
	s.mu.Unlock()
	if deadline.IsZero() {
		return time.Duration(float64(fallbackAutoHeartbeat) * jitter)
	}
	delay := min(max(time.Until(deadline)/3, minAutoHeartbeat), maxAutoHeartbeat)
	return time.Duration(float64(delay) * jitter)
}

func (s *ServiceAgent) startAutoHeartbeat() {
	s.stop = make(chan struct{})
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		timer := time.NewTimer(s.nextDelay())
		defer timer.Stop()
		for {
			select {
			case <-s.stop:
				return
			case <-timer.C:
				tickCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				err := s.Heartbeat(tickCtx)
				cancel()
				if err != nil {
					if isGone(err) {
						// The coordinator no longer holds the session live
						// (terminated or lease-reaped); further beats can never
						// revive it.
						slog.Warn("caracal lease lost; auto-heartbeat stopped",
							"agent_session_id", s.Context.AgentSessionID, "err", err)
						if s.onLeaseLost != nil {
							s.onLeaseLost(err)
						}
						return
					}
					slog.Warn("caracal auto-heartbeat failed; retrying next tick",
						"agent_session_id", s.Context.AgentSessionID, "err", err)
				}
				timer.Reset(s.nextDelay())
			}
		}
	}()
}

// Close retires the service session. Idempotent: repeat calls return the
// first result. A session the coordinator already retired counts as success.
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
		err = TerminateAgent(ctx, s.coordinator, token, s.Context.ZoneID, s.Context.AgentSessionID)
		if isGone(err) {
			err = nil
		}
		s.closeErr = err
	})
	return s.closeErr
}

// SpawnService spawns a long-lived service agent session and returns a handle
// the caller owns. A background goroutine renews the heartbeat lease by
// default (see SpawnServiceInput.HeartbeatInterval); retire the session with
// ServiceAgent.Close. Set Grant to GrantNarrow(...) to issue a bounded
// delegation edge so the handle holds only a subset of scopes.
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
		Context:           sess.ctx,
		coordinator:       opts.Coordinator,
		tokenSource:       opts.TokenSource,
		invalidate:        opts.Invalidate,
		heartbeatInterval: opts.HeartbeatInterval,
		onLeaseLost:       opts.OnLeaseLost,
	}
	if t, perr := time.Parse(time.RFC3339Nano, sess.heartbeatDeadlineAt); perr == nil {
		agent.deadlineAt = t
	}
	if opts.HeartbeatInterval >= 0 {
		agent.startAutoHeartbeat()
	}
	return agent, nil
}
