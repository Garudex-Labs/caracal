// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Caracal: drop-in bound client wrapping zone, application, subject token, and coordinator.

package sdk

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	oauth "github.com/garudex-labs/caracal/packages/oauth/go"
)

// Caracal binds the four config values needed to integrate with Caracal.
type Caracal struct {
	Coordinator       *CoordinatorClient
	ZoneID            string
	ApplicationID     string
	SubjectToken      string
	TokenSource       TokenSource
	GatewayURL        string
	Resources         []ResourceBinding
	DefaultKind       AgentKind
	DefaultTTLSeconds int

	agentStartHooks []LifecycleHook
	agentEndHooks   []LifecycleHook
}

// TokenSource returns an application subject token for root SDK operations.
type TokenSource func(context.Context) (string, error)

// ResourceBinding maps a registered Caracal resource id to the upstream URL
// prefix it serves. The prefix is matched against outbound request URLs so the
// transport can rewrite the call through the gateway transparently.
type ResourceBinding struct {
	ResourceID     string
	UpstreamPrefix string
}

// Connect builds a Caracal client from explicit values, a generated profile, or env.
func Connect(opts ...ClientSecretOptions) (*Caracal, error) {
	if len(opts) > 0 {
		return FromClientSecret(opts[0])
	}
	if path := os.Getenv("CARACAL_CONFIG"); path != "" {
		return FromConfig(path)
	}
	if path := defaultProfilePath(); path != "" {
		if _, err := os.Stat(path); err == nil {
			return FromConfig(path)
		}
	}
	return FromEnv()
}

// FromEnv constructs a Caracal client from CARACAL_COORDINATOR_URL,
// CARACAL_ZONE_ID, CARACAL_APPLICATION_ID, CARACAL_SUBJECT_TOKEN.
func FromEnv() (*Caracal, error) {
	url := os.Getenv("CARACAL_COORDINATOR_URL")
	zone := os.Getenv("CARACAL_ZONE_ID")
	app := os.Getenv("CARACAL_APPLICATION_ID")
	tok := os.Getenv("CARACAL_SUBJECT_TOKEN")
	clientSecret, err := clientSecretFromEnv()
	if err != nil {
		return nil, err
	}
	stsURL := os.Getenv("CARACAL_STS_URL")
	missing := []string{}
	for k, v := range map[string]string{
		"CARACAL_COORDINATOR_URL": url,
		"CARACAL_ZONE_ID":         zone,
		"CARACAL_APPLICATION_ID":  app,
	} {
		if v == "" {
			missing = append(missing, k)
		}
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("caracal: FromEnv missing %v", missing)
	}
	bindings, err := parseResourceBindings(os.Getenv("CARACAL_RESOURCES"))
	if err != nil {
		return nil, err
	}
	fileBindings, err := resourceBindingsFromFile(os.Getenv("CARACAL_RESOURCES_FILE"))
	if err != nil {
		return nil, err
	}
	bindings = append(fileBindings, bindings...)
	credentialIDs, credentialBindings, err := credentialManifestFromEnv()
	if err != nil {
		return nil, err
	}
	bindings = sortBindingsLongestFirst(append(credentialBindings, bindings...))
	if clientSecret != "" {
		if stsURL == "" {
			return nil, fmt.Errorf("caracal: client-secret env mode requires CARACAL_STS_URL")
		}
		return FromClientSecret(ClientSecretOptions{
			CoordinatorURL:   url,
			STSURL:           stsURL,
			ZoneID:           zone,
			ApplicationID:    app,
			ClientSecret:     clientSecret,
			Resources:        resourceIDsFromEnv(os.Getenv("CARACAL_APP_RESOURCES"), credentialIDs, bindings),
			ResourceBindings: bindings,
			GatewayURL:       os.Getenv("CARACAL_GATEWAY_URL"),
		})
	}
	if tok == "" {
		return nil, fmt.Errorf("caracal: FromEnv requires CARACAL_SUBJECT_TOKEN or CARACAL_APP_CLIENT_SECRET with CARACAL_STS_URL")
	}
	if err := validateSubjectToken(tok); err != nil {
		return nil, err
	}
	return &Caracal{
		Coordinator:   &CoordinatorClient{BaseURL: url},
		ZoneID:        zone,
		ApplicationID: app,
		SubjectToken:  tok,
		GatewayURL:    os.Getenv("CARACAL_GATEWAY_URL"),
		Resources:     sortBindingsLongestFirst(bindings),
	}, nil
}

// ClientSecretOptions configures an SDK client backed by STS client-secret exchange.
type ClientSecretOptions struct {
	CoordinatorURL   string
	STSURL           string
	ZoneID           string
	ApplicationID    string
	ClientSecret     string
	Resources        []string
	ResourceBindings []ResourceBinding
	GatewayURL       string
	Scope            string
}

// FromClientSecret returns a Caracal client that refreshes its application subject token through STS.
func FromClientSecret(opts ClientSecretOptions) (*Caracal, error) {
	if len(opts.Resources) == 0 {
		return nil, fmt.Errorf("caracal: FromClientSecret requires at least one resource")
	}
	return &Caracal{
		Coordinator:   &CoordinatorClient{BaseURL: opts.CoordinatorURL},
		ZoneID:        opts.ZoneID,
		ApplicationID: opts.ApplicationID,
		TokenSource:   clientSecretTokenSource(opts),
		GatewayURL:    opts.GatewayURL,
		Resources:     sortBindingsLongestFirst(opts.ResourceBindings),
	}, nil
}

// FromConfig constructs a Caracal client from a generated runtime profile.
func FromConfig(path string) (*Caracal, error) {
	cfg, err := parseProfile(path)
	if err != nil {
		return nil, err
	}
	stsURL := cfg["sts_url"]
	if stsURL == "" {
		stsURL = cfg["zone_url"]
	}
	if stsURL == "" {
		return nil, fmt.Errorf("caracal: %s requires sts_url or zone_url", path)
	}
	coordinatorURL := cfg["coordinator_url"]
	if coordinatorURL == "" {
		return nil, fmt.Errorf("caracal: %s requires coordinator_url", path)
	}
	secret, err := clientSecretFromProfile(path, cfg)
	if err != nil {
		return nil, err
	}
	resourceIDs, bindings := resourceIDsFromProfile(cfg)
	if len(resourceIDs) == 0 {
		return nil, fmt.Errorf("caracal: %s requires at least one credentials entry", path)
	}
	return FromClientSecret(ClientSecretOptions{
		CoordinatorURL:   coordinatorURL,
		STSURL:           stsURL,
		ZoneID:           cfg["zone_id"],
		ApplicationID:    cfg["application_id"],
		ClientSecret:     secret,
		Resources:        resourceIDs,
		ResourceBindings: bindings,
		GatewayURL:       cfg["gateway_url"],
	})
}

func clientSecretTokenSource(opts ClientSecretOptions) TokenSource {
	client := oauth.NewClient(opts.STSURL, opts.ZoneID, opts.ApplicationID, nil)
	scope := opts.Scope
	if scope == "" {
		scope = "agent:lifecycle"
	}
	return func(ctx context.Context) (string, error) {
		token, err := client.ExchangeResources(ctx, "", opts.Resources, oauth.ExchangeOptions{
			ClientSecret: opts.ClientSecret,
			Scopes:       []string{scope},
		})
		if err != nil {
			return "", err
		}
		return token.AccessToken, nil
	}
}

// sortBindingsLongestFirst returns a copy of bindings sorted by upstream prefix
// length descending so that the most specific prefix wins during gateway
// routing. Stable across equal lengths.
func sortBindingsLongestFirst(bindings []ResourceBinding) []ResourceBinding {
	if len(bindings) <= 1 {
		return bindings
	}
	out := append([]ResourceBinding(nil), bindings...)
	sort.SliceStable(out, func(i, j int) bool {
		return len(out[i].UpstreamPrefix) > len(out[j].UpstreamPrefix)
	})
	return out
}

// validateSubjectToken performs a local sanity check on the bootstrap subject
// token. When the token has a JWT shape, decodes the payload and rejects
// tokens that are malformed or already expired. Opaque tokens are accepted.
func validateSubjectToken(token string) error {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		payload, err = base64.URLEncoding.DecodeString(parts[1])
		if err != nil {
			return nil
		}
	}
	var claims struct {
		Exp int64 `json:"exp"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil
	}
	if claims.Exp == 0 {
		return nil
	}
	if claims.Exp <= time.Now().Unix() {
		return fmt.Errorf("caracal: CARACAL_SUBJECT_TOKEN is expired: refresh the bootstrap token before starting")
	}
	return nil
}

// Close satisfies lifecycle interfaces for clients without open resources.
func (c *Caracal) Close() error {
	return nil
}

// parseResourceBindings reads the CARACAL_RESOURCES env format
// "rid=https://upstream/prefix,rid2=https://other/prefix".
func parseResourceBindings(raw string) ([]ResourceBinding, error) {
	if raw == "" {
		return nil, nil
	}
	out := []ResourceBinding{}
	errors := []string{}
	for index, entry := range strings.Split(raw, ",") {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" {
			continue
		}
		idx := strings.Index(trimmed, "=")
		if idx <= 0 {
			errors = append(errors, fmt.Sprintf("entry %d must use resourceID=upstreamPrefix", index+1))
			continue
		}
		rid := strings.TrimSpace(trimmed[:idx])
		prefix := strings.TrimSpace(trimmed[idx+1:])
		if rid == "" || prefix == "" {
			errors = append(errors, fmt.Sprintf("entry %d must contain non-empty resourceID and upstreamPrefix", index+1))
			continue
		}
		parsed, err := url.Parse(prefix)
		if err != nil || parsed.Scheme == "" || parsed.Host == "" {
			errors = append(errors, fmt.Sprintf("entry %d upstreamPrefix must be an absolute URL", index+1))
			continue
		}
		out = append(out, ResourceBinding{ResourceID: rid, UpstreamPrefix: prefix})
	}
	if len(errors) > 0 {
		return nil, fmt.Errorf("caracal: invalid CARACAL_RESOURCES: %s", strings.Join(errors, "; "))
	}
	if len(out) == 0 {
		return nil, nil
	}
	return out, nil
}

func resourceBindingsFromFile(path string) ([]ResourceBinding, error) {
	if path == "" {
		return nil, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var array []struct {
		ResourceID     string `json:"resource_id"`
		UpstreamPrefix string `json:"upstream_prefix"`
	}
	if err := json.Unmarshal(data, &array); err == nil {
		out := make([]ResourceBinding, 0, len(array))
		for _, entry := range array {
			if entry.ResourceID == "" || entry.UpstreamPrefix == "" {
				return nil, fmt.Errorf("caracal: CARACAL_RESOURCES_FILE requires resource_id and upstream_prefix")
			}
			out = append(out, ResourceBinding{ResourceID: entry.ResourceID, UpstreamPrefix: entry.UpstreamPrefix})
		}
		return out, nil
	}
	var object map[string]string
	if err := json.Unmarshal(data, &object); err != nil {
		return nil, err
	}
	out := make([]ResourceBinding, 0, len(object))
	for resourceID, upstreamPrefix := range object {
		if resourceID == "" || upstreamPrefix == "" {
			return nil, fmt.Errorf("caracal: CARACAL_RESOURCES_FILE requires non-empty resource ids and upstream prefixes")
		}
		out = append(out, ResourceBinding{ResourceID: resourceID, UpstreamPrefix: upstreamPrefix})
	}
	return out, nil
}

func resourceIDsFromEnv(raw string, first []string, bindings []ResourceBinding) []string {
	if raw != "" {
		out := []string{}
		for _, value := range strings.Split(raw, ",") {
			value = strings.TrimSpace(value)
			if value != "" {
				out = append(out, value)
			}
		}
		if len(out) > 0 {
			return out
		}
	}
	out := append([]string(nil), first...)
	for _, binding := range bindings {
		out = append(out, binding.ResourceID)
	}
	return compactStrings(out)
}

func defaultProfilePath() string {
	xdg := os.Getenv("XDG_CONFIG_HOME")
	if xdg == "" {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			return ""
		}
		xdg = filepath.Join(home, ".config")
	}
	return filepath.Join(xdg, "caracal", "caracal.toml")
}

func readSecretFile(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("caracal: secret file is not readable: %w", err)
	}
	if info.Mode().Perm()&0o022 != 0 {
		return "", fmt.Errorf("caracal: secret file permissions are too broad: %s", path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	secret := strings.TrimSpace(string(data))
	if secret == "" {
		return "", fmt.Errorf("caracal: secret file is empty: %s", path)
	}
	return secret, nil
}

func clientSecretFromEnv() (string, error) {
	value := os.Getenv("CARACAL_APP_CLIENT_SECRET")
	fileValue := os.Getenv("CARACAL_APP_CLIENT_SECRET_FILE")
	if value != "" && fileValue != "" {
		return "", fmt.Errorf("caracal: set only one of CARACAL_APP_CLIENT_SECRET or CARACAL_APP_CLIENT_SECRET_FILE")
	}
	if fileValue != "" {
		return readSecretFile(fileValue)
	}
	return value, nil
}

func clientSecretFromProfile(path string, cfg map[string]string) (string, error) {
	value := cfg["app_client_secret"]
	fileValue := cfg["app_client_secret_file"]
	if value != "" && fileValue != "" {
		return "", fmt.Errorf("caracal: %s sets both app_client_secret and app_client_secret_file", path)
	}
	if value != "" {
		return value, nil
	}
	if fileValue == "" {
		return "", fmt.Errorf("caracal: %s requires app_client_secret_file", path)
	}
	return readSecretFile(fileValue)
}

func parseProfile(path string) (map[string]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if info, err := os.Stat(path); err == nil && info.Mode().Perm()&0o022 != 0 {
		return nil, fmt.Errorf("caracal: profile permissions are too broad: %s", path)
	}
	out := map[string]string{}
	section := ""
	credentialIndex := -1
	for lineNo, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(stripTomlComment(line))
		if line == "" {
			continue
		}
		if line == "[[credentials]]" || line == "[[optional_credentials]]" {
			section = strings.Trim(line, "[]")
			credentialIndex++
			continue
		}
		if strings.HasPrefix(line, "[") {
			section = strings.Trim(line, "[]")
			continue
		}
		idx := strings.Index(line, "=")
		if idx <= 0 {
			return nil, fmt.Errorf("caracal: invalid profile line %d", lineNo+1)
		}
		key := strings.TrimSpace(line[:idx])
		value := strings.TrimSpace(line[idx+1:])
		parsed, ok := parseTomlString(value)
		if !ok {
			return nil, fmt.Errorf("caracal: profile line %d must use string values", lineNo+1)
		}
		if section == "credentials" || section == "optional_credentials" {
			out[fmt.Sprintf("%s.%d.%s", section, credentialIndex, key)] = parsed
			continue
		}
		out[key] = parsed
	}
	for _, key := range []string{"zone_id", "application_id"} {
		if out[key] == "" {
			return nil, fmt.Errorf("caracal: %s requires %s", path, key)
		}
	}
	return out, nil
}

func stripTomlComment(line string) string {
	inString := false
	escaped := false
	for i, r := range line {
		if escaped {
			escaped = false
			continue
		}
		if r == '\\' {
			escaped = true
			continue
		}
		if r == '"' {
			inString = !inString
			continue
		}
		if r == '#' && !inString {
			return line[:i]
		}
	}
	return line
}

func parseTomlString(value string) (string, bool) {
	if len(value) < 2 || value[0] != '"' || value[len(value)-1] != '"' {
		return "", false
	}
	var out string
	if err := json.Unmarshal([]byte(value), &out); err != nil {
		return "", false
	}
	return out, true
}

func resourceIDsFromProfile(cfg map[string]string) ([]string, []ResourceBinding) {
	ids := []string{}
	bindings := []ResourceBinding{}
	seen := map[string]bool{}
	counts := credentialCounts(cfg)
	for _, prefix := range []string{"credentials", "optional_credentials"} {
		count := counts[prefix]
		for i := 0; i < count; i++ {
			resource := cfg[fmt.Sprintf("%s.%d.resource", prefix, i)]
			if resource == "" || seen[resource] {
				continue
			}
			seen[resource] = true
			ids = append(ids, resource)
			if upstream := cfg[fmt.Sprintf("%s.%d.upstream_prefix", prefix, i)]; upstream != "" {
				bindings = append(bindings, ResourceBinding{ResourceID: resource, UpstreamPrefix: upstream})
			}
		}
	}
	return ids, sortBindingsLongestFirst(bindings)
}

func credentialCounts(cfg map[string]string) map[string]int {
	counts := map[string]int{"credentials": 0, "optional_credentials": 0}
	for key := range cfg {
		for prefix := range counts {
			start := prefix + "."
			if !strings.HasPrefix(key, start) {
				continue
			}
			rest := strings.TrimPrefix(key, start)
			idx := strings.Index(rest, ".")
			if idx <= 0 {
				continue
			}
			var n int
			if _, err := fmt.Sscanf(rest[:idx], "%d", &n); err == nil && n+1 > counts[prefix] {
				counts[prefix] = n + 1
			}
		}
	}
	return counts
}

func credentialManifestFromEnv() ([]string, []ResourceBinding, error) {
	fileValue := os.Getenv("CARACAL_RUN_CREDENTIALS_FILE")
	inline := os.Getenv("CARACAL_RUN_CREDENTIALS")
	if fileValue != "" && inline != "" {
		return nil, nil, fmt.Errorf("caracal: set only one of CARACAL_RUN_CREDENTIALS or CARACAL_RUN_CREDENTIALS_FILE")
	}
	if fileValue == "" && inline == "" {
		return nil, nil, nil
	}
	raw := []byte(inline)
	if fileValue != "" {
		data, err := os.ReadFile(fileValue)
		if err != nil {
			return nil, nil, err
		}
		raw = data
	}
	type credentialEntry struct {
		Resource       string `json:"resource"`
		UpstreamPrefix string `json:"upstream_prefix"`
	}
	var entries []credentialEntry
	if err := json.Unmarshal(raw, &entries); err != nil {
		var manifest struct {
			Credentials         []credentialEntry `json:"credentials"`
			OptionalCredentials []credentialEntry `json:"optional_credentials"`
		}
		if err := json.Unmarshal(raw, &manifest); err != nil {
			return nil, nil, err
		}
		entries = append(manifest.Credentials, manifest.OptionalCredentials...)
	}
	ids := []string{}
	bindings := []ResourceBinding{}
	for _, entry := range entries {
		if entry.Resource == "" {
			continue
		}
		ids = append(ids, entry.Resource)
		if entry.UpstreamPrefix != "" {
			bindings = append(bindings, ResourceBinding{ResourceID: entry.Resource, UpstreamPrefix: entry.UpstreamPrefix})
		}
	}
	return ids, bindings, nil
}

func compactStrings(values []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, value := range values {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
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
	subjectToken, err := c.rootToken(ctx)
	if err != nil {
		return err
	}
	return Spawn(ctx, SpawnInput{
		Coordinator:   c.Coordinator,
		ZoneID:        c.ZoneID,
		ApplicationID: c.ApplicationID,
		SubjectToken:  subjectToken,
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

// DelegateToSpawnOptions configures the atomic spawn+delegate primitive.
type DelegateToSpawnOptions struct {
	Scopes               []string
	Constraints          *DelegationConstraints
	DelegationTTLSeconds int
	Kind                 AgentKind
	TTLSeconds           int
	Metadata             map[string]any
	TraceID              string
}

// DelegateToSpawn atomically spawns a child session and records a parent→child
// delegation edge before yielding the child context to fn. Use this at fan-out
// boundaries (e.g. before launching a child goroutine) where the parent may
// stop interacting before the child can issue any call.
func (c *Caracal) DelegateToSpawn(ctx context.Context, opts DelegateToSpawnOptions, fn func(context.Context) error) error {
	kind := opts.Kind
	if kind == "" {
		kind = c.DefaultKind
	}
	if kind == "" {
		kind = KindInstance
	}
	ttl := opts.TTLSeconds
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
	subjectToken, err := c.rootToken(ctx)
	if err != nil {
		return err
	}
	return DelegateToSpawn(ctx, DelegateToSpawnInput{
		Coordinator:          c.Coordinator,
		ZoneID:               c.ZoneID,
		ApplicationID:        c.ApplicationID,
		SubjectToken:         subjectToken,
		Scopes:               opts.Scopes,
		Constraints:          opts.Constraints,
		DelegationTTLSeconds: opts.DelegationTTLSeconds,
		Kind:                 kind,
		TTLSeconds:           ttl,
		Metadata:             opts.Metadata,
		TraceID:              opts.TraceID,
		OnAgentStart:         onStart,
		OnAgentEnd:           onEnd,
	}, fn)
}

// RootOptions controls explicit use of the application subject token when no
// CaracalContext is bound.
type RootOptions struct {
	AllowRoot bool
}

func allowRoot(opts []RootOptions) bool {
	return len(opts) > 0 && opts[0].AllowRoot
}

// Headers returns the envelope headers for the current ctx. Root application
// identity requires RootOptions{AllowRoot: true}.
func (c *Caracal) Headers(ctx context.Context, opts ...RootOptions) (http.Header, error) {
	h := http.Header{}
	cur, ok := Current(ctx)
	if !ok {
		if !allowRoot(opts) {
			return nil, fmt.Errorf("caracal: Headers called without a bound CaracalContext; pass RootOptions{AllowRoot: true} to use the application subject token")
		}
		subjectToken, err := c.rootToken(ctx)
		if err != nil {
			return nil, err
		}
		InjectHTTP(Envelope{SubjectToken: subjectToken, Hop: 0}, h)
		return h, nil
	}
	InjectHTTP(ToEnvelope(cur), h)
	return h, nil
}

// BindFromRequest extracts the envelope from an inbound request and returns a
// context bound with the resulting CaracalContext.
func (c *Caracal) BindFromRequest(ctx context.Context, r *http.Request, opts ...RootOptions) (context.Context, error) {
	env := FromHTTPRequest(r)
	if env.SubjectToken == "" {
		if !allowRoot(opts) {
			return ctx, fmt.Errorf("caracal: BindFromRequest missing bearer token")
		}
		subjectToken, err := c.rootToken(ctx)
		if err != nil {
			return ctx, err
		}
		env.SubjectToken = subjectToken
	}
	cc, err := FromEnvelope(env, c.ZoneID, c.ApplicationID)
	if err != nil {
		return ctx, err
	}
	return Bind(ctx, cc), nil
}

// Current returns the Caracal context bound on ctx, or a zero value and false.
func (c *Caracal) Current(ctx context.Context) (CaracalContext, bool) {
	return Current(ctx)
}

// Transport returns an *http.Client whose RoundTripper auto-injects the
// Caracal envelope headers from the request's context. Pass to any HTTP or
// provider SDK that accepts a custom *http.Client.
func (c *Caracal) Transport(base *http.Client, opts ...RootOptions) *http.Client {
	if base == nil {
		base = &http.Client{}
	}
	rt := base.Transport
	if rt == nil {
		rt = http.DefaultTransport
	}
	out := *base
	out.Transport = &caracalTransport{base: rt, client: c, allowRoot: allowRoot(opts)}
	return &out
}

type caracalTransport struct {
	base      http.RoundTripper
	client    *Caracal
	allowRoot bool
}

func (t *caracalTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	cur, ok := Current(req.Context())
	var env Envelope
	if !ok {
		if !t.allowRoot {
			return nil, fmt.Errorf("caracal: Transport request has no bound CaracalContext; pass RootOptions{AllowRoot: true} to use the application subject token")
		}
		subjectToken, err := t.client.rootToken(req.Context())
		if err != nil {
			return nil, err
		}
		env = Envelope{SubjectToken: subjectToken, Hop: 0}
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
		clone.Header.Set("Authorization", "Bearer "+env.SubjectToken)
	}
	return t.base.RoundTrip(clone)
}

func (c *Caracal) rootToken(ctx context.Context) (string, error) {
	if c.TokenSource != nil {
		return c.TokenSource(ctx)
	}
	if c.SubjectToken != "" {
		return c.SubjectToken, nil
	}
	return "", fmt.Errorf("caracal: no subject token source configured")
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
