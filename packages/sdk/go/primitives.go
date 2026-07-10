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
	"strings"
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

// SessionInput controls governed Session creation.
type SessionInput struct {
	Coordinator   *CoordinatorClient
	ZoneID        string
	ApplicationID string
	SubjectToken  string
	TokenSource   func(context.Context) (string, error)
	Invalidate    func()
	// SubjectAuthorityRecordID anchors Coordinator attribution; it does not alone propagate the user sub to later mints.
	SubjectAuthorityRecordID string
	// Session to parent under; defaults to the session bound on the calling context.
	ParentSessionID string
	Authority       Authority
	TTLSeconds      int
	Metadata        map[string]any
	Labels          []string
	TraceID         string
	// Caller-supplied Session-start idempotency key; redelivery resumes the Session instead of creating a duplicate.
	IdempotencyKey string
	OnSessionStart LifecycleHook
	OnSessionEnd   LifecycleHook
}

type sessionInput struct {
	coordinator              *CoordinatorClient
	zoneID                   string
	applicationID            string
	subjectToken             string
	tokenSource              func(context.Context) (string, error)
	invalidate               func()
	subjectAuthorityRecordID string
	parentID                 string
	authority                Authority
	ttlSeconds               int
	metadata                 map[string]any
	labels                   []string
	traceID                  string
	idempotencyKey           string
}

type session struct {
	sessionID           string
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

// retryAfterCap bounds a server-requested Retry-After so a hostile or
// misconfigured header cannot stall the caller for minutes.
const retryAfterCap = 10 * time.Second

func retryDelay(attempt int, err error) time.Duration {
	var coordErr *CoordinatorError
	if errors.As(err, &coordErr) && coordErr.RetryAfterSeconds > 0 {
		hinted := time.Duration(coordErr.RetryAfterSeconds * float64(time.Second))
		return min(hinted, retryAfterCap) + rand.N(100*time.Millisecond)
	}
	return time.Duration(attempt+1)*250*time.Millisecond + rand.N(100*time.Millisecond)
}

// retire terminates a session on a cleanup path. It detaches from the caller's
// cancellation (with its own deadline) so an expired or canceled caller
// context cannot strand the session, resolves a fresh bearer when a token
// source is configured, and treats an already-retired session as success.
func retire(ctx context.Context, coordinator *CoordinatorClient, bearer func(context.Context) (string, error), zoneID, sessionID string) error {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	token, err := bearer(cleanupCtx)
	if err != nil {
		return err
	}
	err = TerminateSession(cleanupCtx, coordinator, token, zoneID, sessionID)
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
	idempotencyKey := in.idempotencyKey
	if idempotencyKey == "" {
		idempotencyKey = newRandomHex(16)
	} else if err := validateIdempotencyKey(idempotencyKey); err != nil {
		return nil, err
	}
	req := StartSessionRequest{
		ZoneID:                   in.zoneID,
		ApplicationID:            in.applicationID,
		SubjectAuthorityRecordID: in.subjectAuthorityRecordID,
		ParentID:                 parentID,
		Lifecycle:                lifecycle,
		TTLSeconds:               in.ttlSeconds,
		Metadata:                 in.metadata,
		Labels:                   in.labels,
		IdempotencyKey:           idempotencyKey,
		IdempotencyKeyGenerated:  in.idempotencyKey == "",
		ParentAuthority:          parentAuthority,
	}
	const sessionStartRetries = 2
	var res StartSessionResponse
	refreshed := false
	for attempt := 0; ; {
		var err error
		res, err = StartCoordinatorSession(ctx, in.coordinator, token, req)
		if err == nil {
			break
		}
		var coordErr *CoordinatorError
		if errors.As(err, &coordErr) {
			// A cached token can be rejected before its exp (server-side
			// session revocation after a credential rotation); force one
			// refresh and retry the Session start once. The jittered pause spreads
			// the refresh across a fleet so a mass revocation cannot
			// stampede the STS.
			if coordErr.StatusCode == 401 && !refreshed && in.invalidate != nil && in.tokenSource != nil {
				refreshed = true
				in.invalidate()
				select {
				case <-ctx.Done():
					return nil, ctx.Err()
				case <-time.After(rand.N(250 * time.Millisecond)):
				}
				if token, err = in.tokenSource(ctx); err != nil {
					return nil, err
				}
				continue
			}
			// The idempotency key makes retrying a 5xx safe: the coordinator
			// replays the already-created session instead of minting a duplicate.
			if coordErr.StatusCode < 500 || attempt >= sessionStartRetries {
				return nil, err
			}
		} else if attempt >= sessionStartRetries {
			return nil, err
		}
		delay := retryDelay(attempt, err)
		attempt++
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(delay):
		}
	}

	delegationID := res.DelegationID
	hop := parent.Hop
	if delegationID != "" && hasParent {
		hop = parent.Hop + 1
	}
	if authority.Mode == AuthorityModeNarrow {
		if parent.SessionID == "" {
			logRetire(retire(ctx, in.coordinator, bearer, in.zoneID, res.SessionID), res.SessionID)
			return nil, errors.New("caracal: Authority narrow requires an active parent session")
		}
		delRes, derr := CreateDelegation(ctx, in.coordinator, parent.SubjectToken, DelegationRequest{
			ZoneID:                in.zoneID,
			IssuerApplicationID:   parent.ApplicationID,
			SourceSessionID:       parent.SessionID,
			TargetSessionID:       res.SessionID,
			ReceiverApplicationID: in.applicationID,
			ParentEdgeID:          parent.DelegationID,
			ResourceID:            authority.ResourceID,
			Scopes:                authority.Scopes,
			Constraints:           authority.Constraints,
			TTLSeconds:            authority.TTLSeconds,
		})
		if derr != nil {
			logRetire(retire(ctx, in.coordinator, bearer, in.zoneID, res.SessionID), res.SessionID)
			return nil, derr
		}
		delegationID = delRes.DelegationID
		hop = parent.Hop + 1
	}

	traceID := in.traceID
	if traceID == "" {
		traceID = parent.TraceID
	}
	sessionID := in.subjectAuthorityRecordID
	if sessionID == "" {
		sessionID = parent.SubjectAuthorityRecordID
	}

	c := CaracalContext{
		SubjectToken:             token,
		ZoneID:                   in.zoneID,
		ApplicationID:            in.applicationID,
		SessionID:                res.SessionID,
		DelegationID:             delegationID,
		ParentDelegationID:       parent.DelegationID,
		SubjectAuthorityRecordID: sessionID,
		TraceID:                  traceID,
		TraceFlags:               parent.TraceFlags,
		TraceState:               parent.TraceState,
		Baggage:                  parent.Baggage,
		Hop:                      hop,
		OwnToken:                 true,
	}
	return &session{sessionID: res.SessionID, ctx: c, bearer: bearer, heartbeatDeadlineAt: res.HeartbeatDeadlineAt}, nil
}

func validateIdempotencyKey(key string) error {
	if key == "" || key != strings.TrimSpace(key) || len([]byte(key)) > 255 {
		return errors.New("caracal: IdempotencyKey must be non-empty, at most 255 UTF-8 bytes, and contain no surrounding whitespace or control characters")
	}
	for _, char := range key {
		if char < 32 || char == 127 {
			return errors.New("caracal: IdempotencyKey must be non-empty, at most 255 UTF-8 bytes, and contain no surrounding whitespace or control characters")
		}
	}
	return nil
}

// logRetire records a cleanup-path terminate failure without masking the
// caller's primary outcome; the coordinator's TTL sweeper retires whatever
// this misses.
func logRetire(err error, sessionID string) {
	if err != nil {
		slog.Warn("caracal: terminate failed; the coordinator TTL sweeper will retire it",
			"agent_session_id", sessionID, "err", err)
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
		coordinator:              opts.Coordinator,
		zoneID:                   opts.ZoneID,
		applicationID:            opts.ApplicationID,
		subjectToken:             opts.SubjectToken,
		tokenSource:              opts.TokenSource,
		invalidate:               opts.Invalidate,
		subjectAuthorityRecordID: opts.SubjectAuthorityRecordID,
		parentID:                 opts.ParentSessionID,
		authority:                opts.Authority,
		ttlSeconds:               opts.TTLSeconds,
		metadata:                 opts.Metadata,
		labels:                   opts.Labels,
		traceID:                  opts.TraceID,
		idempotencyKey:           opts.IdempotencyKey,
	}, "")
	if err != nil {
		return err
	}

	child := Bind(ctx, sess.ctx)
	if opts.OnSessionStart != nil {
		if err := opts.OnSessionStart(child, sess.ctx); err != nil {
			logRetire(retire(ctx, opts.Coordinator, sess.bearer, opts.ZoneID, sess.sessionID), sess.sessionID)
			return err
		}
	}
	runErr := fn(child)
	if opts.OnSessionEnd != nil {
		runErr = errors.Join(runErr, opts.OnSessionEnd(child, sess.ctx))
	}
	logRetire(retire(ctx, opts.Coordinator, sess.bearer, opts.ZoneID, sess.sessionID), sess.sessionID)
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
// deriving its context with AcceptDelegation. A transient coordinator failure
// is retried once under an idempotency key, so the coordinator replays the
// already-created edge instead of issuing a duplicate.
func Delegate(ctx context.Context, opts DelegateInput) (Delegation, error) {
	c, ok := Current(ctx)
	if !ok || c.SessionID == "" {
		return Delegation{}, errors.New("caracal: Delegate requires an active session in context")
	}

	req := DelegationRequest{
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
		IdempotencyKey:        newRandomHex(16),
	}
	var res DelegationResponse
	for attempt := 0; ; {
		var err error
		res, err = CreateDelegation(ctx, opts.Coordinator, c.SubjectToken, req)
		if err == nil {
			break
		}
		var coordErr *CoordinatorError
		if errors.As(err, &coordErr) && coordErr.StatusCode < 500 {
			return Delegation{}, err
		}
		if attempt >= 1 {
			return Delegation{}, err
		}
		delay := retryDelay(0, err)
		attempt++
		select {
		case <-ctx.Done():
			return Delegation{}, ctx.Err()
		case <-time.After(delay):
		}
	}
	return Delegation{DelegationID: res.DelegationID, Scopes: res.Scopes, ExpiresAt: res.ExpiresAt}, nil
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
	Coordinator   *CoordinatorClient
	ZoneID        string
	ApplicationID string
	SubjectToken  string
	TokenSource   func(context.Context) (string, error)
	Invalidate    func()
	// SubjectAuthorityRecordID anchors Coordinator attribution; it does not alone propagate the user sub to later mints.
	SubjectAuthorityRecordID string
	// Session to parent under; defaults to the session bound on the calling context.
	ParentSessionID string
	Authority       Authority
	TTLSeconds      int
	Metadata        map[string]any
	Labels          []string
	TraceID         string
	// Caller-supplied Session-start idempotency key; redelivery resumes the Session instead of creating a duplicate.
	IdempotencyKey    string
	HeartbeatInterval time.Duration
	OnLeaseLost       func(error)
	OnStateChange     func(string)
	OnSessionStart    LifecycleHook
	OnSessionEnd      LifecycleHook
}

const (
	minAutoHeartbeat      = time.Second
	maxAutoHeartbeat      = 5 * time.Minute
	fallbackAutoHeartbeat = 30 * time.Second
)

// SessionHandle is a handle for a long-lived service Session. Unlike
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
	onStateChange     func(string)
	onSessionEnd      LifecycleHook
	mu                sync.Mutex
	deadlineAt        time.Time
	status            string
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

// Status returns the coordinator-reported service-session state.
func (s *SessionHandle) Status() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status
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
	res, err := HeartbeatSession(ctx, s.coordinator, token, s.Context.ZoneID, s.Context.SessionID, st)
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
		if res, err = HeartbeatSession(ctx, s.coordinator, token, s.Context.ZoneID, s.Context.SessionID, st); err != nil {
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
	if res.Status != "" {
		s.mu.Lock()
		changed := res.Status != s.status
		s.status = res.Status
		s.mu.Unlock()
		if changed && s.onStateChange != nil {
			func() {
				defer func() {
					if recovered := recover(); recovered != nil {
						slog.Warn("caracal state-change callback failed", "agent_session_id", s.Context.SessionID, "panic", recovered)
					}
				}()
				s.onStateChange(res.Status)
			}()
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
				if s.Status() == "suspended" {
					return
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
		err = TerminateSession(ctx, s.coordinator, token, s.Context.ZoneID, s.Context.SessionID)
		if isGone(err) {
			err = nil
		}
		s.closeErr = errors.Join(endErr, err)
	})
	return s.closeErr
}

// StartSession starts a long-lived service Session and returns a handle
// the caller owns. A background goroutine renews the heartbeat lease by
// default (see StartSessionInput.HeartbeatInterval); retire the session with
// SessionHandle.Close. Set Authority to AuthorityNarrow(...) to issue a bounded
// Delegation so the handle holds only a subset of scopes.
func StartSession(ctx context.Context, opts StartSessionInput) (*SessionHandle, error) {
	sess, err := establishSession(ctx, sessionInput{
		coordinator:              opts.Coordinator,
		zoneID:                   opts.ZoneID,
		applicationID:            opts.ApplicationID,
		subjectToken:             opts.SubjectToken,
		tokenSource:              opts.TokenSource,
		invalidate:               opts.Invalidate,
		subjectAuthorityRecordID: opts.SubjectAuthorityRecordID,
		parentID:                 opts.ParentSessionID,
		authority:                opts.Authority,
		ttlSeconds:               opts.TTLSeconds,
		metadata:                 opts.Metadata,
		labels:                   opts.Labels,
		traceID:                  opts.TraceID,
		idempotencyKey:           opts.IdempotencyKey,
	}, LifecycleService)
	if err != nil {
		return nil, err
	}
	if opts.OnSessionStart != nil {
		if err := opts.OnSessionStart(ctx, sess.ctx); err != nil {
			logRetire(retire(ctx, opts.Coordinator, sess.bearer, opts.ZoneID, sess.sessionID), sess.sessionID)
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
		onStateChange:     opts.OnStateChange,
		status:            "active",
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

// AttachSessionInput controls re-attachment to an existing service session.
type AttachSessionInput struct {
	Coordinator   *CoordinatorClient
	ZoneID        string
	ApplicationID string
	SubjectToken  string
	TokenSource   func(context.Context) (string, error)
	Invalidate    func()
	// The service session to re-attach to, from a previous StartSession in this or another process.
	SessionID         string
	HeartbeatInterval time.Duration
	OnLeaseLost       func(error)
	OnStateChange     func(string)
	OnSessionEnd      LifecycleHook
}

// AttachSession re-attaches to a service session that already exists -
// typically after a process restart, using a session id the previous holder
// persisted. The session is validated with an immediate lease renewal (a
// session the coordinator no longer holds live fails with *CoordinatorError),
// and the returned handle renews and retires it exactly like one from
// StartSession. The rebuilt context carries the session identity only;
// delegations bound by the previous holder are re-presented with
// AcceptDelegation.
func AttachSession(ctx context.Context, opts AttachSessionInput) (*SessionHandle, error) {
	token := opts.SubjectToken
	if opts.TokenSource != nil {
		fresh, err := opts.TokenSource(ctx)
		if err != nil {
			return nil, err
		}
		token = fresh
	}
	first, err := HeartbeatSession(ctx, opts.Coordinator, token, opts.ZoneID, opts.SessionID, "")
	if err != nil {
		var coordErr *CoordinatorError
		if !errors.As(err, &coordErr) || coordErr.StatusCode != 401 || opts.Invalidate == nil || opts.TokenSource == nil {
			return nil, err
		}
		opts.Invalidate()
		token, err = opts.TokenSource(ctx)
		if err != nil {
			return nil, err
		}
		first, err = HeartbeatSession(ctx, opts.Coordinator, token, opts.ZoneID, opts.SessionID, "")
		if err != nil {
			return nil, err
		}
	}
	agent := &SessionHandle{
		Context: CaracalContext{
			SubjectToken:  token,
			ZoneID:        opts.ZoneID,
			ApplicationID: opts.ApplicationID,
			SessionID:     opts.SessionID,
			OwnToken:      true,
		},
		coordinator:       opts.Coordinator,
		tokenSource:       opts.TokenSource,
		invalidate:        opts.Invalidate,
		heartbeatInterval: opts.HeartbeatInterval,
		onLeaseLost:       opts.OnLeaseLost,
		onStateChange:     opts.OnStateChange,
		status:            first.Status,
		onSessionEnd:      opts.OnSessionEnd,
	}
	if t, perr := time.Parse(time.RFC3339Nano, first.HeartbeatDeadlineAt); perr == nil {
		agent.deadlineAt = t
	}
	if opts.HeartbeatInterval >= 0 {
		agent.startAutoHeartbeat()
	}
	return agent, nil
}
