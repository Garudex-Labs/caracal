// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Caracal: drop-in bound client wrapping zone, application, subject token, and coordinator.

package sdk

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
)

// Caracal binds the four config values needed to integrate with Caracal.
type Caracal struct {
	Coordinator       *CoordinatorClient
	ZoneID            string
	ApplicationID     string
	SubjectToken      string
	GatewayURL        string
	Resources         []ResourceBinding
	DefaultKind       AgentKind
	DefaultTTLSeconds int

	agentStartHooks []LifecycleHook
	agentEndHooks   []LifecycleHook
}

// ResourceBinding maps a registered Caracal resource id to the upstream URL
// prefix it serves. The prefix is matched against outbound request URLs so the
// transport can rewrite the call through the gateway transparently.
type ResourceBinding struct {
	ResourceID     string
	UpstreamPrefix string
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
		GatewayURL:    os.Getenv("CARACAL_GATEWAY_URL"),
		Resources:     parseResourceBindings(os.Getenv("CARACAL_RESOURCES")),
	}, nil
}

// parseResourceBindings reads the CARACAL_RESOURCES env format
// "rid=https://upstream/prefix,rid2=https://other/prefix".
func parseResourceBindings(raw string) []ResourceBinding {
	if raw == "" {
		return nil
	}
	out := []ResourceBinding{}
	for _, entry := range strings.Split(raw, ",") {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" {
			continue
		}
		idx := strings.Index(trimmed, "=")
		if idx <= 0 {
			continue
		}
		rid := strings.TrimSpace(trimmed[:idx])
		prefix := strings.TrimSpace(trimmed[idx+1:])
		if rid != "" && prefix != "" {
			out = append(out, ResourceBinding{ResourceID: rid, UpstreamPrefix: prefix})
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// OnAgentStart registers a hook fired when Spawn binds a new agent session.
func (c *Caracal) OnAgentStart(h LifecycleHook) {
	c.agentStartHooks = append(c.agentStartHooks, h)
}

// OnAgentEnd registers a hook fired when Spawn unwinds an agent session.
func (c *Caracal) OnAgentEnd(h LifecycleHook) {
	c.agentEndHooks = append(c.agentEndHooks, h)
}

func (c *Caracal) fire(hooks []LifecycleHook, ctx context.Context, cc CaracalContext) error {
	for _, h := range hooks {
		if err := h(ctx, cc); err != nil {
			return err
		}
	}
	return nil
}

// SpawnOptions overrides defaults for a single Spawn call.
type SpawnOptions struct {
	Kind       AgentKind
	TTLSeconds int
	SessionSID string
	ParentID   string
	Metadata   map[string]any
	TraceID    string
}

// Spawn spawns an agent session and invokes fn with the bound context.
func (c *Caracal) Spawn(ctx context.Context, fn func(context.Context) error, opts ...SpawnOptions) error {
	o := SpawnOptions{}
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
	var onStart, onEnd LifecycleHook
	if len(c.agentStartHooks) > 0 {
		onStart = func(cx context.Context, cc CaracalContext) error { return c.fire(c.agentStartHooks, cx, cc) }
	}
	if len(c.agentEndHooks) > 0 {
		onEnd = func(cx context.Context, cc CaracalContext) error { return c.fire(c.agentEndHooks, cx, cc) }
	}
	return Spawn(ctx, SpawnInput{
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
		OnAgentStart:  onStart,
		OnAgentEnd:    onEnd,
	}, fn)
}

// DelegateOptions configures a delegation edge.
type DelegateOptions struct {
	To              string
	ToApplicationID string
	Scopes          []string
	Constraints     *DelegationConstraints
	TTLSeconds      int
}

// Delegate creates a delegation edge from the current session and runs fn under it.
func (c *Caracal) Delegate(ctx context.Context, opts DelegateOptions, fn func(context.Context) error) error {
	return Delegate(ctx, DelegateInput{
		Coordinator:      c.Coordinator,
		ToAgentSessionID: opts.To,
		ToApplicationID:  opts.ToApplicationID,
		Scopes:           opts.Scopes,
		Constraints:      opts.Constraints,
		TTLSeconds:       opts.TTLSeconds,
	}, fn)
}

// Headers returns the envelope headers for the current ctx (or a baseline
// using the configured subject token if no context is bound).
func (c *Caracal) Headers(ctx context.Context) http.Header {
	h := http.Header{}
	cur, ok := Current(ctx)
	if !ok {
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

// Current returns the Caracal context bound on ctx, or a zero value and false.
func (c *Caracal) Current(ctx context.Context) (CaracalContext, bool) {
	return Current(ctx)
}

// Transport returns an *http.Client whose RoundTripper auto-injects the
// Caracal envelope headers from the request's context. Pass to any HTTP or
// provider SDK that accepts a custom *http.Client.
func (c *Caracal) Transport(base *http.Client) *http.Client {
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
	cur, ok := Current(req.Context())
	var env Envelope
	if !ok {
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
	if rewritten := t.client.routeThroughGateway(clone.URL, clone.Header.Get("X-Caracal-Resource")); rewritten != nil {
		clone.URL = rewritten.url
		clone.Host = rewritten.url.Host
		clone.RequestURI = ""
		clone.Header.Set("X-Caracal-Resource", rewritten.resourceID)
		token := env.SubjectToken
		if token == "" {
			token = t.client.SubjectToken
		}
		clone.Header.Set("Authorization", "Bearer "+token)
	}
	return t.base.RoundTrip(clone)
}

type gatewayRoute struct {
	url        *url.URL
	resourceID string
}

// routeThroughGateway rewrites target to point at the gateway when the request
// matches a configured ResourceBinding. Returns nil to leave the request alone.
func (c *Caracal) routeThroughGateway(target *url.URL, explicitResource string) *gatewayRoute {
	if c.GatewayURL == "" || target == nil {
		return nil
	}
	gw, err := url.Parse(c.GatewayURL)
	if err != nil {
		return nil
	}
	if sameOrigin(target, gw) {
		return nil
	}
	var binding *ResourceBinding
	if explicitResource != "" {
		for i := range c.Resources {
			if c.Resources[i].ResourceID == explicitResource {
				binding = &c.Resources[i]
				break
			}
		}
	} else {
		for i := range c.Resources {
			if urlMatchesPrefix(target, c.Resources[i].UpstreamPrefix) {
				binding = &c.Resources[i]
				break
			}
		}
		if binding == nil {
			return nil
		}
	}
	suffix := target.Path
	if target.RawQuery != "" {
		suffix += "?" + target.RawQuery
	}
	if binding != nil {
		prefix, err := url.Parse(binding.UpstreamPrefix)
		if err == nil && prefix.Path != "" && prefix.Path != "/" && strings.HasPrefix(target.Path, prefix.Path) {
			suffix = strings.TrimPrefix(target.Path, prefix.Path)
			if !strings.HasPrefix(suffix, "/") {
				suffix = "/" + suffix
			}
			if target.RawQuery != "" {
				suffix += "?" + target.RawQuery
			}
		}
	}
	base := strings.TrimRight(gw.Scheme+"://"+gw.Host+gw.Path, "/")
	rewritten, err := url.Parse(base + suffix)
	if err != nil {
		return nil
	}
	rid := explicitResource
	if binding != nil {
		rid = binding.ResourceID
	}
	return &gatewayRoute{url: rewritten, resourceID: rid}
}

func sameOrigin(a, b *url.URL) bool {
	return a.Scheme == b.Scheme && a.Host == b.Host
}

func urlMatchesPrefix(target *url.URL, prefix string) bool {
	p, err := url.Parse(prefix)
	if err != nil {
		return false
	}
	if p.Scheme != target.Scheme || p.Host != target.Host {
		return false
	}
	if p.Path == "" || p.Path == "/" {
		return true
	}
	if target.Path == p.Path {
		return true
	}
	pp := p.Path
	if !strings.HasSuffix(pp, "/") {
		pp += "/"
	}
	return strings.HasPrefix(target.Path, pp)
}
