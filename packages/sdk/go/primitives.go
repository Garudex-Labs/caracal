// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// SDK primitives: run governed sessions and delegate authority.

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

// AuthorityMode selects how a child session receives authority.
type AuthorityMode string

const (
	AuthorityModeInherit AuthorityMode = "inherit"
	AuthorityModeNarrow  AuthorityMode = "narrow"
	AuthorityModeNone    AuthorityMode = "none"
)

// Authority is the authority handed to a child session. The zero value (and
// AuthorityInherit) carries the parent's effective authority forward: the
// coordinator resolves the parent's active narrowing delegation server-side
// and mirrors it onto the child, so least-privilege is transitive by default.
// A parent that holds no delegation yields a child running under the
// application's policy-bounded authority; the platform decision contract
// mints resource mandates only over a delegation, so a delegation-less
// session cannot present delegated authority. Inheritance never crosses an
// application boundary. AuthorityNarrow issues a bounded delegation so the
// child holds only the listed scopes; the server re-validates the subset, so
// a narrow can never broaden. AuthorityNone starts the child explicitly
// delegation-less, suppressing server-side inheritance.
type Authority struct {
	Mode        AuthorityMode
	Scopes      []string
	ResourceID  string
	Constraints *DelegationConstraints
	TTLSeconds  int
}

// AuthorityInherit runs the child under its parent's effective authority (the
// default): narrowing applied to the parent is carried forward to the child.
func AuthorityInherit() Authority { return Authority{Mode: AuthorityModeInherit} }

// AuthorityNone starts a child session without any delegation.
func AuthorityNone() Authority { return Authority{Mode: AuthorityModeNone} }

// NarrowOptions refines a narrowing authority.
type NarrowOptions struct {
	ResourceID  string
	Constraints *DelegationConstraints
	TTLSeconds  int
}

// AuthorityNarrow issues a bounded delegation limited to scopes. A narrowing
// delegation defaults to a hop budget of 1; pass Constraints with MaxHops 2
// (or more) when the child must re-delegate or sub-narrow.
func AuthorityNarrow(scopes []string, opts ...NarrowOptions) Authority {
	g := Authority{Mode: AuthorityModeNarrow, Scopes: scopes}
	if len(opts) > 0 {
		g.ResourceID = opts[0].ResourceID
		g.Constraints = opts[0].Constraints
		g.TTLSeconds = opts[0].TTLSeconds
	}
	return g
}

// SessionInput controls agent session spawning.
type SessionInput struct {
	Coordinator      *CoordinatorClient
	ZoneID           string
	ApplicationID    string
	SubjectToken     string
	TokenSource      func(context.Context) (string, error)
	Invalidate       func()
	SubjectSessionID string
	// Session to parent under; defaults to the session bound on the calling context.
	ParentSessionID string
	Authority       Authority
	TTLSeconds      int
	Metadata        map[string]any
	Labels          []string
	TraceID         string
	OnSessionStart  LifecycleHook
	OnSessionEnd    LifecycleHook
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
	authority        Authority
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
	authority := in.authority
	if authority.Mode == "" {
		authority.Mode = AuthorityModeInherit
	}
	parent, hasParent := Current(ctx)
	parentID := in.parentID
	if parentID == "" {
		parentID = parent.SessionID
	}
	token := in.subjectToken
	bearer := func(c context.Context) (string, error) {
		if in.tokenSource != nil {
			return in.tokenSource(c)
		}
		return token, nil
	}

	// A narrowing (or none) authority suppresses server-side edge inheritance:
	// the child must hold exactly the granted slice, not a mirrored copy of
	// the parent's wider edge alongside it.
	parentAuthority := "none"
	if authority.Mode == AuthorityModeInherit {
		parentAuthority = "inherit"
	}
	req := SpawnRequest{
		ZoneID:           in.zoneID,
		ApplicationID:    in.applicationID,
		SubjectSessionID: in.subjectSessionID,
		ParentID:         parentID,
		Lifecycle:        lifecycle,
		TTLSeconds:       in.ttlSeconds,
		Metadata:         in.metadata,
		Labels:           in.labels,
		IdempotencyKey:   newRandomHex(16),
		ParentAuthority:  parentAuthority,
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

	delegationID := res.DelegationEdgeID
	hop := parent.Hop
	if delegationID != "" && hasParent {
		hop = parent.Hop + 1
	}
	if authority.Mode == AuthorityModeNarrow {
		if parent.SessionID == "" {
			logRetire(retire(ctx, in.coordinator, bearer, in.zoneID, res.AgentSessionID), res.AgentSessionID)
			return nil, errors.New("caracal: Authority narrow requires an active parent session")
		}
		delRes, derr := CreateDelegation(ctx, in.coordinator, parent.SubjectToken, DelegationRequest{
			ZoneID:                in.zoneID,
			IssuerApplicationID:   parent.ApplicationID,
			SourceSessionID:       parent.SessionID,
			TargetSessionID:       res.AgentSessionID,
			ReceiverApplicationID: in.applicationID,
			ParentEdgeID:          parent.DelegationID,
			ResourceID:            authority.ResourceID,
			Scopes:                authority.Scopes,
			Constraints:           authority.Constraints,
			TTLSeconds:            authority.TTLSeconds,
		})
		if derr != nil {
			logRetire(retire(ctx, in.coordinator, bearer, in.zoneID, res.AgentSessionID), res.AgentSessionID)
			return nil, derr
		}
		delegationID = delRes.DelegationEdgeID
		hop = parent.Hop + 1
	}

	traceID := in.traceID
	if traceID == "" {
		traceID = parent.TraceID
	}
	sessionID := in.subjectSessionID
	if sessionID == "" {
		sessionID = parent.SubjectSessionID
	}

	c := CaracalContext{
		SubjectToken:       token,
		ZoneID:             in.zoneID,
		ApplicationID:      in.applicationID,
		SessionID:          res.AgentSessionID,
		DelegationID:       delegationID,
		ParentDelegationID: parent.DelegationID,
		SubjectSessionID:   sessionID,
		TraceID:            traceID,
		TraceFlags:         parent.TraceFlags,
		TraceState:         parent.TraceState,
		Baggage:            parent.Baggage,
		Hop:                hop,
		OwnToken:           true,
	}
	return &session{agentSessionID: res.AgentSessionID, ctx: c, bearer: bearer, heartbeatDeadlineAt: res.HeartbeatDeadlineAt}, nil
}

// logRetire records a cleanup-path terminate failure without masking the
// caller's primary outcome; the coordinator's TTL sweeper retires whatever
// this misses.
func logRetire(err error, agentSessionID string) {
	if err != nil {
		slog.Warn("caracal: terminate failed; the coordinator TTL sweeper will retire it",
			"agent_session_id", agentSessionID, "err", err)
	}
}

// Session runs fn inside a governed session: a bounded identity Caracal
// establishes around whatever fn executes, bound into the returned context
// and terminated when fn returns. By default the coordinator carries the
// parent's effective authority forward by mirroring its active narrowing
// delegation onto the child; set Authority to AuthorityNarrow(...) to bound
// the session to a subset of scopes.
func Session(ctx context.Context, opts SessionInput, fn func(context.Context) error) error {
	sess, err := establishSession(ctx, sessionInput{
		coordinator:      opts.Coordinator,
		zoneID:           opts.ZoneID,
		applicationID:    opts.ApplicationID,
		subjectToken:     opts.SubjectToken,
		tokenSource:      opts.TokenSource,
		invalidate:       opts.Invalidate,
		subjectSessionID: opts.SubjectSessionID,
		parentID:         opts.ParentSessionID,
		authority:        opts.Authority,
		ttlSeconds:       opts.TTLSeconds,
		metadata:         opts.Metadata,
		labels:           opts.Labels,
		traceID:          opts.TraceID,
	}, "")
	if err != nil {
		return err
	}

	child := Bind(ctx, sess.ctx)
	if opts.OnSessionStart != nil {
		if err := opts.OnSessionStart(child, sess.ctx); err != nil {
			logRetire(retire(ctx, opts.Coordinator, sess.bearer, opts.ZoneID, sess.agentSessionID), sess.agentSessionID)
			return err
		}
	}
	runErr := fn(child)
	if opts.OnSessionEnd != nil {
		runErr = errors.Join(runErr, opts.OnSessionEnd(child, sess.ctx))
	}
	logRetire(retire(ctx, opts.Coordinator, sess.bearer, opts.ZoneID, sess.agentSessionID), sess.agentSessionID)
	return runErr
}

// DelegateInput controls delegation creation.
type DelegateInput struct {
	Coordinator     *CoordinatorClient
	ToSessionID     string
	ToApplicationID string
	ResourceID      string
	Scopes          []string
	Constraints     *DelegationConstraints
	TTLSeconds      int
}

// Delegation is a delegation issued to a peer session: its id, the scopes it
// carries, and when it expires.
type Delegation struct {
	DelegationID string
	Scopes       []string
	ExpiresAt    string
}

// Delegate delegates a slice of the current session's authority to a peer
// session. The caller is the issuer: its own context is unchanged, because a
// delegation grants authority to the receiver rather than the issuer. Hand
// the returned delegation id to the receiving session, which presents it by
// deriving its context with AcceptDelegation.
func Delegate(ctx context.Context, opts DelegateInput) (Delegation, error) {
	c, ok := Current(ctx)
	if !ok || c.SessionID == "" {
		return Delegation{}, errors.New("caracal: Delegate requires an active session in context")
	}

	res, err := CreateDelegation(ctx, opts.Coordinator, c.SubjectToken, DelegationRequest{
		ZoneID:                c.ZoneID,
		IssuerApplicationID:   c.ApplicationID,
		SourceSessionID:       c.SessionID,
		TargetSessionID:       opts.ToSessionID,
		ReceiverApplicationID: opts.ToApplicationID,
		ParentEdgeID:          c.DelegationID,
		ResourceID:            opts.ResourceID,
		Scopes:                opts.Scopes,
		Constraints:           opts.Constraints,
		TTLSeconds:            opts.TTLSeconds,
	})
	if err != nil {
		return Delegation{}, err
	}
	return Delegation{DelegationID: res.DelegationEdgeID, Scopes: res.Scopes, ExpiresAt: res.ExpiresAt}, nil
}

// AcceptDelegation derives a receiver context presenting the given delegation
// and binds it: calls made under the returned context carry the delegation's
// bounded authority. The receiving session calls this with the delegation id
// the issuer handed over; the source context is untouched.
func AcceptDelegation(ctx context.Context, delegationID string) (context.Context, error) {
	c, ok := Current(ctx)
	if !ok {
		return nil, errors.New("caracal: AcceptDelegation requires a Caracal context")
	}
	child := c
	child.ParentDelegationID = c.DelegationID
	child.DelegationID = delegationID
	child.Hop = c.Hop + 1
	return Bind(ctx, child), nil
}

// StartSessionInput controls long-lived session creation.
// HeartbeatInterval selects the lease renewal mode: zero (the default)
// derives the cadence from the server lease, a positive value fixes it, and
// a negative value disables the background renewal so the holder heartbeats
// manually. OnLeaseLost fires once if the coordinator reports the session
// permanently gone. OnSessionEnd runs inside Close before the session
// terminates, mirroring Session's end hook.
type StartSessionInput struct {
	Coordinator      *CoordinatorClient
	ZoneID           string
	ApplicationID    string
	SubjectToken     string
	TokenSource      func(context.Context) (string, error)
	Invalidate       func()
	SubjectSessionID string
	// Session to parent under; defaults to the session bound on the calling context.
	ParentSessionID   string
	Authority         Authority
	TTLSeconds        int
	Metadata          map[string]any
	Labels            []string
	TraceID           string
	HeartbeatInterval time.Duration
	OnLeaseLost       func(error)
	OnSessionStart    LifecycleHook
	OnSessionEnd      LifecycleHook
}

const (
	minAutoHeartbeat      = time.Second
	maxAutoHeartbeat      = 5 * time.Minute
	fallbackAutoHeartbeat = 30 * time.Second
)

// SessionHandle is a handle for a long-lived service agent session. Unlike
// Session, a service session is not terminated automatically: a background
// goroutine renews the lease by default and the holder retires the session
// with Close. The renewal cadence follows the server lease deadline unless
// StartSessionInput.HeartbeatInterval fixes or disables it; if the
// coordinator reports the session permanently gone the goroutine stops and
// OnLeaseLost fires once.
type SessionHandle struct {
	Context           CaracalContext
	coordinator       *CoordinatorClient
	tokenSource       func(context.Context) (string, error)
	invalidate        func()
	heartbeatInterval time.Duration
	onLeaseLost       func(error)
	onSessionEnd      LifecycleHook
	mu                sync.Mutex
	deadlineAt        time.Time
	stop              chan struct{}
	wg                sync.WaitGroup
	closeOnce         sync.Once
	closeErr          error
}

// SessionID returns the service session identifier.
func (s *SessionHandle) SessionID() string {
	return s.Context.SessionID
}

// DeadlineAt returns the lease deadline the coordinator reported on the last
// renewal; zero until the server reports one.
func (s *SessionHandle) DeadlineAt() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.deadlineAt
}

func (s *SessionHandle) bearer(ctx context.Context) (string, error) {
	if s.tokenSource != nil {
		return s.tokenSource(ctx)
	}
	return s.Context.SubjectToken, nil
}

// Heartbeat renews the service session lease, reporting the given status
// ("healthy" when omitted).
func (s *SessionHandle) Heartbeat(ctx context.Context, status ...string) error {
	st := ""
	if len(status) > 0 {
		st = status[0]
	}
	token, err := s.bearer(ctx)
	if err != nil {
		return err
	}
	res, err := HeartbeatAgent(ctx, s.coordinator, token, s.Context.ZoneID, s.Context.SessionID, st)
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
		if res, err = HeartbeatAgent(ctx, s.coordinator, token, s.Context.ZoneID, s.Context.SessionID, st); err != nil {
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

func (s *SessionHandle) nextDelay() time.Duration {
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

func (s *SessionHandle) startAutoHeartbeat() {
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
							"agent_session_id", s.Context.SessionID, "err", err)
						if s.onLeaseLost != nil {
							s.onLeaseLost(err)
						}
						return
					}
					slog.Warn("caracal auto-heartbeat failed; retrying next tick",
						"agent_session_id", s.Context.SessionID, "err", err)
				}
				timer.Reset(s.nextDelay())
			}
		}
	}()
}

// Close retires the service session. Idempotent: repeat calls return the
// first result. The end hook runs after the renewal goroutine stops and
// before the session terminates. A session the coordinator already retired
// counts as success.
func (s *SessionHandle) Close(ctx context.Context) error {
	s.closeOnce.Do(func() {
		if s.stop != nil {
			close(s.stop)
			s.wg.Wait()
		}
		var endErr error
		if s.onSessionEnd != nil {
			endErr = s.onSessionEnd(ctx, s.Context)
		}
		token, err := s.bearer(ctx)
		if err != nil {
			s.closeErr = errors.Join(endErr, err)
			return
		}
		err = TerminateAgent(ctx, s.coordinator, token, s.Context.ZoneID, s.Context.SessionID)
		if isGone(err) {
			err = nil
		}
		s.closeErr = errors.Join(endErr, err)
	})
	return s.closeErr
}

// StartSession spawns a long-lived service agent session and returns a handle
// the caller owns. A background goroutine renews the heartbeat lease by
// default (see StartSessionInput.HeartbeatInterval); retire the session with
// SessionHandle.Close. Set Authority to AuthorityNarrow(...) to issue a bounded
// delegation edge so the handle holds only a subset of scopes.
func StartSession(ctx context.Context, opts StartSessionInput) (*SessionHandle, error) {
	sess, err := establishSession(ctx, sessionInput{
		coordinator:      opts.Coordinator,
		zoneID:           opts.ZoneID,
		applicationID:    opts.ApplicationID,
		subjectToken:     opts.SubjectToken,
		tokenSource:      opts.TokenSource,
		invalidate:       opts.Invalidate,
		subjectSessionID: opts.SubjectSessionID,
		parentID:         opts.ParentSessionID,
		authority:        opts.Authority,
		ttlSeconds:       opts.TTLSeconds,
		metadata:         opts.Metadata,
		labels:           opts.Labels,
		traceID:          opts.TraceID,
	}, LifecycleService)
	if err != nil {
		return nil, err
	}
	if opts.OnSessionStart != nil {
		if err := opts.OnSessionStart(ctx, sess.ctx); err != nil {
			logRetire(retire(ctx, opts.Coordinator, sess.bearer, opts.ZoneID, sess.agentSessionID), sess.agentSessionID)
			return nil, err
		}
	}
	agent := &SessionHandle{
		Context:           sess.ctx,
		coordinator:       opts.Coordinator,
		tokenSource:       opts.TokenSource,
		invalidate:        opts.Invalidate,
		heartbeatInterval: opts.HeartbeatInterval,
		onLeaseLost:       opts.OnLeaseLost,
		onSessionEnd:      opts.OnSessionEnd,
	}
	if t, perr := time.Parse(time.RFC3339Nano, sess.heartbeatDeadlineAt); perr == nil {
		agent.deadlineAt = t
	}
	if opts.HeartbeatInterval >= 0 {
		agent.startAutoHeartbeat()
	}
	return agent, nil
}
