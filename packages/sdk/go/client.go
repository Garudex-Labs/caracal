// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Caracal: drop-in bound client wrapping zone, application, subject token, and coordinator.

package sdk

import (
	"context"
	"fmt"
	"net/http"
	"os"
)

// Caracal binds the four config values needed to integrate with Caracal.
type Caracal struct {
	Coordinator       *CoordinatorClient
	ZoneID            string
	ApplicationID     string
	SubjectToken      string
	DefaultKind       AgentKind
	DefaultTTLSeconds int
}

// FromEnv constructs a Caracal client from CARACAL_COORDINATOR_URL,
// CARACAL_ZONE_ID, CARACAL_APPLICATION_ID, CARACAL_SUBJECT_TOKEN.
func FromEnv() (*Caracal, error) {
	url := os.Getenv("CARACAL_COORDINATOR_URL")
	zone := os.Getenv("CARACAL_ZONE_ID")
	app := os.Getenv("CARACAL_APPLICATION_ID")
	tok := os.Getenv("CARACAL_SUBJECT_TOKEN")
	missing := []string{}
	for k, v := range map[string]string{
		"CARACAL_COORDINATOR_URL": url,
		"CARACAL_ZONE_ID":         zone,
		"CARACAL_APPLICATION_ID":  app,
		"CARACAL_SUBJECT_TOKEN":   tok,
	} {
		if v == "" {
			missing = append(missing, k)
		}
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("caracal: FromEnv missing %v", missing)
	}
	return &Caracal{
		Coordinator:   &CoordinatorClient{BaseURL: url},
		ZoneID:        zone,
		ApplicationID: app,
		SubjectToken:  tok,
	}, nil
}

// RunOptions overrides defaults for a single Run call.
type RunOptions struct {
	Kind       AgentKind
	TTLSeconds int
	SessionSID string
	ParentID   string
	Metadata   map[string]any
	TraceID    string
}

// Run spawns an agent session and invokes fn with the bound context.
func (c *Caracal) Run(ctx context.Context, fn func(context.Context) error, opts ...RunOptions) error {
	o := RunOptions{}
	if len(opts) > 0 {
		o = opts[0]
	}
	kind := o.Kind
	if kind == "" {
		kind = c.DefaultKind
	}
	if kind == "" {
		kind = KindInstance
	}
	ttl := o.TTLSeconds
	if ttl == 0 {
		ttl = c.DefaultTTLSeconds
	}
	return WithAgent(ctx, WithAgentOptions{
		Coordinator:   c.Coordinator,
		ZoneID:        c.ZoneID,
		ApplicationID: c.ApplicationID,
		SubjectToken:  c.SubjectToken,
		SessionSID:    o.SessionSID,
		ParentID:      o.ParentID,
		Kind:          kind,
		TTLSeconds:    ttl,
		Metadata:      o.Metadata,
		TraceID:       o.TraceID,
	}, fn)
}

// DelegateOptions configures a delegation edge.
type DelegateOptions struct {
	To              string
	ToApplicationID string
	Scopes          []string
	Constraints     map[string]any
	TTLSeconds      int
}

// Delegate creates a delegation edge from the current session and runs fn under it.
func (c *Caracal) Delegate(ctx context.Context, opts DelegateOptions, fn func(context.Context) error) error {
	return WithDelegation(ctx, WithDelegationOptions{
		Coordinator:        c.Coordinator,
		ToAgentSessionID:   opts.To,
		ToApplicationID:    opts.ToApplicationID,
		Scopes:             opts.Scopes,
		Constraints:        opts.Constraints,
		TTLSeconds:         opts.TTLSeconds,
	}, fn)
}

// Headers returns the envelope headers for the current ctx (or a baseline
// using the configured subject token if no context is bound).
func (c *Caracal) Headers(ctx context.Context) http.Header {
	h := http.Header{}
	cur, err := Current(ctx)
	if err != nil {
		InjectHTTP(Envelope{SubjectToken: c.SubjectToken, Hop: 0}, h)
		return h
	}
	InjectHTTP(ToEnvelope(cur), h)
	return h
}

// BindFromRequest extracts the envelope from an inbound request and returns a
// context bound with the resulting CaracalContext. If the inbound request has
// no subject token, the configured default is used.
func (c *Caracal) BindFromRequest(ctx context.Context, r *http.Request) context.Context {
	env := FromHTTPRequest(r)
	if env.SubjectToken == "" {
		env.SubjectToken = c.SubjectToken
	}
	cc, err := FromEnvelope(env, c.ZoneID, c.ApplicationID)
	if err != nil {
		return ctx
	}
	return Bind(ctx, cc)
}

// Context returns the current Caracal context bound on ctx. Returns an error
// if no Caracal context has been bound on this execution path.
func (c *Caracal) Context(ctx context.Context) (CaracalContext, error) {
	return Current(ctx)
}

// TryContext returns the current Caracal context if one is bound on ctx, or
// the zero value and false otherwise.
func (c *Caracal) TryContext(ctx context.Context) (CaracalContext, bool) {
	cur, err := Current(ctx)
	if err != nil {
		return CaracalContext{}, false
	}
	return cur, true
}

// HTTPClient returns an *http.Client whose RoundTripper auto-injects the
// Caracal envelope headers from the request's context.
func (c *Caracal) HTTPClient(base *http.Client) *http.Client {
	if base == nil {
		base = &http.Client{}
	}
	rt := base.Transport
	if rt == nil {
		rt = http.DefaultTransport
	}
	out := *base
	out.Transport = &caracalTransport{base: rt, client: c}
	return &out
}

type caracalTransport struct {
	base   http.RoundTripper
	client *Caracal
}

func (t *caracalTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	cur, err := Current(req.Context())
	var env Envelope
	if err != nil {
		env = Envelope{SubjectToken: t.client.SubjectToken, Hop: 0}
	} else {
		env = ToEnvelope(cur)
	}
	clone := req.Clone(req.Context())
	EncodeEnvelope(env, func(name, value string) {
		canon := http.CanonicalHeaderKey(name)
		if clone.Header.Get(canon) == "" {
			clone.Header.Set(canon, value)
		}
	})
	return t.base.RoundTrip(clone)
}
