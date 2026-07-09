// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Caracal: drop-in bound client wrapping zone, application, subject token, and coordinator.

package sdk

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/BurntSushi/toml"
	oauth "github.com/garudex-labs/caracal/packages/oauth/go"
)

const defaultSTSURL = "http://localhost:8080"
const defaultCoordinatorURL = "http://localhost:4000"
const defaultGatewayURL = "http://localhost:8081"

const lifecycleScope = "agent:lifecycle"
const appMandateTTLSeconds = 900
const appMandateRefreshMargin = 60 * time.Second
const appSessionTTLBuffer = 120

// Caracal binds the four config values needed to integrate with Caracal.
// DefaultTTLSeconds applies to sessions run with Session only; a session
// started with StartSession lives by
// its heartbeat lease instead.
type Caracal struct {
	Coordinator       *CoordinatorClient
	ZoneID            string
	ApplicationID     string
	SubjectToken      string
	TokenSource       TokenSource
	GatewayURL        string
	Resources         []ResourceBinding
	DefaultTTLSeconds int

	sessionStartHooks []LifecycleHook
	sessionEndHooks   []LifecycleHook
	eventHooks        []func(oauth.Event)
	exchanger         *clientSecretExchanger

	appMandateMu sync.Mutex
	appMandates  map[string]appMandateEntry
	appInflight  map[string]*appMandateCall
}

// TokenSource returns an application subject token for root SDK operations.
type TokenSource func(context.Context) (string, error)

// ClientCredentials is one resolved application credential: the zone,
// application, and client secret the next STS exchange authenticates with.
type ClientCredentials struct {
	ZoneID        string
	ApplicationID string
	ClientSecret  string
}

// CredentialsResolver yields the current application credential before each
// STS exchange, so rotated or re-provisioned secrets take effect without
// rebuilding the client. Return nil to fail closed while no usable credential
// exists.
type CredentialsResolver func(context.Context) (*ClientCredentials, error)

// ErrCredentialsUnavailable reports that the credentials resolver returned no
// usable credential; operations fail closed until the resolver recovers.
var ErrCredentialsUnavailable = errors.New("caracal: credentials are unavailable: the credentials resolver returned no usable credential")

// ResourceBinding maps a registered Caracal resource id to the upstream URL
// prefix it serves. The prefix is matched against outbound request URLs so the
// transport can rewrite the call through the gateway transparently.
type ResourceBinding struct {
	ResourceID     string
	UpstreamPrefix string
}

// GatewayRequest is a Gateway target and resource header for explicit resource routing.
type GatewayRequest struct {
	URL    string
	Header http.Header
}

// New builds a Caracal client from explicit values, a generated profile, or env.
func New(opts ...ClientSecretOptions) (*Caracal, error) {
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

// FromEnv constructs a Caracal client from CARACAL_ZONE_ID,
// CARACAL_APPLICATION_ID, and CARACAL_SUBJECT_TOKEN or CARACAL_APP_CLIENT_SECRET.
func FromEnv() (*Caracal, error) {
	coordinatorURL, err := serviceURL("CARACAL_COORDINATOR_URL", defaultCoordinatorURL)
	if err != nil {
		return nil, err
	}
	zone := os.Getenv("CARACAL_ZONE_ID")
	app := os.Getenv("CARACAL_APPLICATION_ID")
	tok := os.Getenv("CARACAL_SUBJECT_TOKEN")
	stsURL, err := stsURLFromEnv()
	if err != nil {
		return nil, err
	}
	gatewayURL, err := serviceURL("CARACAL_GATEWAY_URL", defaultGatewayURL)
	if err != nil {
		return nil, err
	}
	missing := []string{}
	for k, v := range map[string]string{
		"CARACAL_ZONE_ID":        zone,
		"CARACAL_APPLICATION_ID": app,
	} {
		if v == "" {
			missing = append(missing, k)
		}
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("caracal: FromEnv missing %v", missing)
	}
	clientSecret, err := clientSecretFromEnv(zone, app)
	if err != nil {
		return nil, err
	}
	ttl, err := defaultTTLFromEnv()
	if err != nil {
		return nil, err
	}
	envBindings, err := parseResourceBindings(os.Getenv("CARACAL_RESOURCES"))
	if err != nil {
		return nil, err
	}
	fileBindings, err := resourceBindingsFromFile(os.Getenv("CARACAL_RESOURCES_FILE"))
	if err != nil {
		return nil, err
	}
	credentialIDs, credentialBindings, err := credentialManifestFromEnv(zone, app)
	if err != nil {
		return nil, err
	}
	bindings := sortBindingsLongestFirst(mergeResourceBindings(credentialBindings, fileBindings, envBindings))
	if clientSecret != "" {
		resources := resourceIDsFromEnv(os.Getenv("CARACAL_APP_RESOURCES"), credentialIDs, bindings)
		if len(resources) == 0 {
			return nil, fmt.Errorf("caracal: FromEnv with a client secret requires resources; set CARACAL_APP_RESOURCES, CARACAL_RESOURCES, or CARACAL_RESOURCES_FILE, or provide run credentials")
		}
		return FromClientSecret(ClientSecretOptions{
			CoordinatorURL:    coordinatorURL,
			STSURL:            stsURL,
			ZoneID:            zone,
			ApplicationID:     app,
			ClientSecret:      clientSecret,
			Resources:         resources,
			ResourceBindings:  bindings,
			GatewayURL:        gatewayURL,
			DefaultTTLSeconds: ttl,
		})
	}
	if tok == "" {
		return nil, fmt.Errorf("caracal: FromEnv requires CARACAL_SUBJECT_TOKEN or CARACAL_APP_CLIENT_SECRET")
	}
	if err := validateSubjectToken(tok); err != nil {
		return nil, err
	}
	if err := assertProductionTransport("CARACAL_COORDINATOR_URL", coordinatorURL); err != nil {
		return nil, err
	}
	if err := assertProductionTransport("CARACAL_GATEWAY_URL", gatewayURL); err != nil {
		return nil, err
	}
	return &Caracal{
		Coordinator:       &CoordinatorClient{BaseURL: coordinatorURL},
		ZoneID:            zone,
		ApplicationID:     app,
		SubjectToken:      tok,
		GatewayURL:        gatewayURL,
		Resources:         sortBindingsLongestFirst(bindings),
		DefaultTTLSeconds: ttl,
	}, nil
}

// ClientSecretOptions configures an SDK client backed by STS client-secret exchange.
// DefaultTTLSeconds seeds Caracal.DefaultTTLSeconds for sessions run with Session.
// Credentials replaces the static ZoneID/ApplicationID/ClientSecret triple
// with a resolver consulted before each exchange.
type ClientSecretOptions struct {
	CoordinatorURL    string
	STSURL            string
	ZoneID            string
	ApplicationID     string
	ClientSecret      string
	Credentials       CredentialsResolver
	Resources         []string
	ResourceBindings  []ResourceBinding
	GatewayURL        string
	Scope             string
	HTTPClient        *http.Client
	DefaultTTLSeconds int
}

// FromClientSecret returns a Caracal client that refreshes its application subject token through STS.
func FromClientSecret(opts ClientSecretOptions) (*Caracal, error) {
	if opts.Credentials != nil && (opts.ZoneID != "" || opts.ApplicationID != "" || opts.ClientSecret != "") {
		return nil, fmt.Errorf("caracal: FromClientSecret: pass either Credentials or the ZoneID/ApplicationID/ClientSecret triple, not both")
	}
	required := map[string]string{
		"CoordinatorURL": opts.CoordinatorURL,
		"STSURL":         opts.STSURL,
	}
	if opts.Credentials == nil {
		required["ZoneID"] = opts.ZoneID
		required["ApplicationID"] = opts.ApplicationID
		required["ClientSecret"] = opts.ClientSecret
	}
	missing := []string{}
	for name, value := range required {
		if value == "" {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		return nil, fmt.Errorf("caracal: FromClientSecret missing %v", missing)
	}
	if opts.DefaultTTLSeconds < 0 {
		return nil, fmt.Errorf("caracal: FromClientSecret DefaultTTLSeconds must be a positive integer")
	}
	if err := assertProductionTransport("CoordinatorURL", opts.CoordinatorURL); err != nil {
		return nil, err
	}
	if err := assertProductionTransport("STSURL", opts.STSURL); err != nil {
		return nil, err
	}
	if err := assertProductionTransport("GatewayURL", opts.GatewayURL); err != nil {
		return nil, err
	}
	exchanger := newClientSecretExchanger(opts)
	return &Caracal{
		Coordinator:       &CoordinatorClient{BaseURL: opts.CoordinatorURL},
		ZoneID:            opts.ZoneID,
		ApplicationID:     opts.ApplicationID,
		TokenSource:       exchanger.source,
		GatewayURL:        opts.GatewayURL,
		Resources:         sortBindingsLongestFirst(opts.ResourceBindings),
		DefaultTTLSeconds: opts.DefaultTTLSeconds,
		exchanger:         exchanger,
	}, nil
}

// FromConfig constructs a Caracal client from a generated runtime profile.
func FromConfig(path string) (*Caracal, error) {
	cfg, err := parseProfile(path)
	if err != nil {
		return nil, err
	}
	stsURL := cfg.STSURL
	if stsURL == "" {
		stsURL = cfg.ZoneURL
	}
	if stsURL == "" {
		stsURL, err = stsURLFromEnv()
		if err != nil {
			return nil, err
		}
	}
	coordinatorURL := cfg.CoordinatorURL
	if coordinatorURL == "" {
		coordinatorURL, err = serviceURL("CARACAL_COORDINATOR_URL", defaultCoordinatorURL)
		if err != nil {
			return nil, err
		}
	}
	secret, err := clientSecretFromProfile(path, cfg)
	if err != nil {
		return nil, err
	}
	resourceIDs, profileBindings := resourceIDsFromProfile(cfg)
	credentialIDs, credentialBindings, err := credentialManifestFromEnv(cfg.ZoneID, cfg.ApplicationID)
	if err != nil {
		return nil, err
	}
	fileBindings, err := resourceBindingsFromFile(os.Getenv("CARACAL_RESOURCES_FILE"))
	if err != nil {
		return nil, err
	}
	envBindings, err := parseResourceBindings(os.Getenv("CARACAL_RESOURCES"))
	if err != nil {
		return nil, err
	}
	bindings := sortBindingsLongestFirst(mergeResourceBindings(profileBindings, credentialBindings, fileBindings, envBindings))
	resourceIDs = compactStrings(append(append(resourceIDs, credentialIDs...), bindingResourceIDs(bindings)...))
	if len(resourceIDs) == 0 {
		return nil, fmt.Errorf("caracal: %s requires at least one resource via credentials, CARACAL_RESOURCES, or CARACAL_RESOURCES_FILE", path)
	}
	gatewayURL := cfg.GatewayURL
	if gatewayURL == "" {
		gatewayURL, err = serviceURL("CARACAL_GATEWAY_URL", defaultGatewayURL)
		if err != nil {
			return nil, err
		}
	}
	ttl := cfg.DefaultTTLSeconds
	if ttl == 0 {
		ttl, err = defaultTTLFromEnv()
		if err != nil {
			return nil, err
		}
	}
	return FromClientSecret(ClientSecretOptions{
		CoordinatorURL:    coordinatorURL,
		STSURL:            stsURL,
		ZoneID:            cfg.ZoneID,
		ApplicationID:     cfg.ApplicationID,
		ClientSecret:      secret,
		Resources:         resourceIDs,
		ResourceBindings:  bindings,
		GatewayURL:        gatewayURL,
		DefaultTTLSeconds: ttl,
	})
}

func serviceURL(key string, fallback string) (string, error) {
	if value := os.Getenv(key); value != "" {
		return value, nil
	}
	if productionEnv() {
		return "", fmt.Errorf("caracal: %s is required when CARACAL_ENV=production", key)
	}
	return fallback, nil
}

// productionEnv reports whether the process declares a production environment
// through CARACAL_ENV, the language-neutral gate every Caracal SDK honors.
func productionEnv() bool {
	return os.Getenv("CARACAL_ENV") == "production"
}

func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func assertProductionTransport(name string, value string) error {
	if value == "" || !productionEnv() {
		return nil
	}
	if os.Getenv("CARACAL_ALLOW_INSECURE_CONFIG_URLS") == "true" {
		return nil
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return fmt.Errorf("caracal: %s is not a valid URL: %s", name, value)
	}
	if parsed.Scheme == "https" {
		return nil
	}
	if parsed.Scheme == "http" && isLoopbackHost(parsed.Hostname()) {
		return nil
	}
	return fmt.Errorf("caracal: %s must use https when CARACAL_ENV=production; http is limited to loopback hosts unless CARACAL_ALLOW_INSECURE_CONFIG_URLS=true", name)
}

func defaultTTLFromEnv() (int, error) {
	raw := os.Getenv("CARACAL_DEFAULT_TTL_SECONDS")
	if raw == "" {
		return 0, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("caracal: CARACAL_DEFAULT_TTL_SECONDS must be a positive integer")
	}
	return value, nil
}

func stsURLFromEnv() (string, error) {
	if value := os.Getenv("CARACAL_STS_URL"); value != "" {
		return value, nil
	}
	if value := os.Getenv("CARACAL_ZONE_URL"); value != "" {
		return value, nil
	}
	return serviceURL("CARACAL_STS_URL", defaultSTSURL)
}

// clientSecretExchanger owns the caching STS exchange client for a
// client-secret configuration: it resolves the application credential and
// lifecycle token and mints scoped resource mandates for the current agent
// identity. The oauth client is rebuilt (dropping its token cache) whenever
// the resolver yields a different zone or application.
type clientSecretExchanger struct {
	stsURL      string
	httpClient  *http.Client
	credentials CredentialsResolver
	resources   []string
	scope       string
	mu          sync.Mutex
	force       bool
	client      *oauth.Client
	activeZone  string
	activeApp   string
	onEvent     func(oauth.Event)
}

func newClientSecretExchanger(opts ClientSecretOptions) *clientSecretExchanger {
	scope := opts.Scope
	if scope == "" {
		scope = lifecycleScope
	}
	credentials := opts.Credentials
	if credentials == nil {
		static := ClientCredentials{ZoneID: opts.ZoneID, ApplicationID: opts.ApplicationID, ClientSecret: opts.ClientSecret}
		credentials = func(context.Context) (*ClientCredentials, error) { return &static, nil }
	}
	return &clientSecretExchanger{stsURL: opts.STSURL, httpClient: opts.HTTPClient, credentials: credentials, resources: opts.Resources, scope: scope}
}

// resolve returns the current credential and the oauth client bound to its
// identity, failing closed with ErrCredentialsUnavailable when the resolver
// yields no usable credential.
func (e *clientSecretExchanger) resolve(ctx context.Context) (ClientCredentials, *oauth.Client, error) {
	creds, err := e.credentials(ctx)
	if err != nil {
		return ClientCredentials{}, nil, err
	}
	if creds == nil || creds.ZoneID == "" || creds.ApplicationID == "" || creds.ClientSecret == "" {
		return ClientCredentials{}, nil, ErrCredentialsUnavailable
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.client == nil || e.activeZone != creds.ZoneID || e.activeApp != creds.ApplicationID {
		client := oauth.NewClient(e.stsURL, creds.ZoneID, creds.ApplicationID, nil)
		if e.httpClient != nil {
			client.SetHTTPClient(e.httpClient)
		}
		client.OnEvent = e.onEvent
		e.client = client
		e.activeZone = creds.ZoneID
		e.activeApp = creds.ApplicationID
	}
	return *creds, e.client, nil
}

func (e *clientSecretExchanger) setOnEvent(h func(oauth.Event)) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.onEvent = h
	if e.client != nil {
		e.client.OnEvent = h
	}
}

func (e *clientSecretExchanger) identity(ctx context.Context) (string, string, error) {
	creds, _, err := e.resolve(ctx)
	if err != nil {
		return "", "", err
	}
	return creds.ZoneID, creds.ApplicationID, nil
}

func (e *clientSecretExchanger) source(ctx context.Context) (string, error) {
	if len(e.resources) == 0 {
		return "", fmt.Errorf("caracal: this client has no resources configured; session and lifecycle paths require at least one")
	}
	creds, client, err := e.resolve(ctx)
	if err != nil {
		return "", err
	}
	e.mu.Lock()
	refresh := e.force
	e.force = false
	e.mu.Unlock()
	token, err := client.ExchangeResources(ctx, "", e.resources, oauth.ExchangeOptions{
		ClientSecret: creds.ClientSecret,
		Scopes:       []string{e.scope},
		ForceRefresh: refresh,
	})
	if err != nil {
		return "", err
	}
	return token.AccessToken, nil
}

func (e *clientSecretExchanger) waitForApproval(ctx context.Context, challengeID string, timeout time.Duration) (string, error) {
	_, client, err := e.resolve(ctx)
	if err != nil {
		return "", err
	}
	return client.WaitForApproval(ctx, challengeID, timeout)
}

// invalidate forces the next lifecycle token resolution to mint fresh (a
// verifier can reject a cached token before its exp after a server-side
// revocation).
func (e *clientSecretExchanger) invalidate() {
	e.mu.Lock()
	e.force = true
	e.mu.Unlock()
}

func (e *clientSecretExchanger) mintMandate(ctx context.Context, resourceID string, scopes []string, agentSessionID, delegationID string, opts MandateOptions) (oauth.TokenExchangeResponse, error) {
	creds, client, err := e.resolve(ctx)
	if err != nil {
		return oauth.TokenExchangeResponse{}, err
	}
	return client.Exchange(ctx, "", resourceID, oauth.ExchangeOptions{
		ClientSecret:     creds.ClientSecret,
		Scopes:           scopes,
		AgentSessionID:   agentSessionID,
		DelegationEdgeID: delegationID,
		TTLSeconds:       opts.TTLSeconds,
		ChallengeID:      opts.ApprovalID,
	})
}

func (c *Caracal) invalidateHook() func() {
	if c.exchanger == nil {
		return nil
	}
	return c.exchanger.invalidate
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

func mergeResourceBindings(sources ...[]ResourceBinding) []ResourceBinding {
	order := []string{}
	seen := map[string]bool{}
	byResource := map[string]ResourceBinding{}
	for _, source := range sources {
		for _, binding := range source {
			if !seen[binding.ResourceID] {
				seen[binding.ResourceID] = true
				order = append(order, binding.ResourceID)
			}
			byResource[binding.ResourceID] = binding
		}
	}
	out := make([]ResourceBinding, 0, len(order))
	for _, resourceID := range order {
		out = append(out, byResource[resourceID])
	}
	return out
}

func bindingResourceIDs(bindings []ResourceBinding) []string {
	out := make([]string, 0, len(bindings))
	for _, binding := range bindings {
		out = append(out, binding.ResourceID)
	}
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
		if !isAbsoluteURL(prefix) {
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
	var parsed any
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil, err
	}
	switch value := parsed.(type) {
	case []any:
		out := make([]ResourceBinding, 0, len(value))
		errors := []string{}
		for index, entry := range value {
			record, ok := entry.(map[string]any)
			if !ok {
				errors = append(errors, fmt.Sprintf("[%d]: entry must be an object", index))
				continue
			}
			if len(record) != 2 || record["resource_id"] == nil || record["upstream_prefix"] == nil {
				errors = append(errors, fmt.Sprintf("[%d]: expected exactly resource_id and upstream_prefix", index))
				continue
			}
			resourceID, ok := record["resource_id"].(string)
			if !ok || resourceID == "" {
				errors = append(errors, fmt.Sprintf("[%d]: resource_id must be a non-empty string", index))
				continue
			}
			upstreamPrefix, ok := record["upstream_prefix"].(string)
			if !ok || upstreamPrefix == "" {
				errors = append(errors, fmt.Sprintf("[%d]: upstream_prefix must be a non-empty string", index))
				continue
			}
			if !isAbsoluteURL(upstreamPrefix) {
				errors = append(errors, fmt.Sprintf("[%d]: upstream_prefix must be an absolute URL", index))
				continue
			}
			out = append(out, ResourceBinding{ResourceID: resourceID, UpstreamPrefix: upstreamPrefix})
		}
		if len(errors) > 0 {
			return nil, fmt.Errorf("caracal: invalid CARACAL_RESOURCES_FILE: %s", strings.Join(errors, "; "))
		}
		return out, nil
	case map[string]any:
		out := make([]ResourceBinding, 0, len(value))
		errors := []string{}
		resourceIDs := make([]string, 0, len(value))
		for resourceID := range value {
			resourceIDs = append(resourceIDs, resourceID)
		}
		sort.Strings(resourceIDs)
		for _, resourceID := range resourceIDs {
			rawPrefix := value[resourceID]
			if resourceID == "" {
				errors = append(errors, "key must be a non-empty string")
				continue
			}
			upstreamPrefix, ok := rawPrefix.(string)
			if !ok || upstreamPrefix == "" {
				errors = append(errors, fmt.Sprintf("entry %q upstream_prefix must be a non-empty string", resourceID))
				continue
			}
			if !isAbsoluteURL(upstreamPrefix) {
				errors = append(errors, fmt.Sprintf("entry %q upstream_prefix must be an absolute URL", resourceID))
				continue
			}
			out = append(out, ResourceBinding{ResourceID: resourceID, UpstreamPrefix: upstreamPrefix})
		}
		if len(errors) > 0 {
			return nil, fmt.Errorf("caracal: invalid CARACAL_RESOURCES_FILE: %s", strings.Join(errors, "; "))
		}
		return out, nil
	default:
		return nil, fmt.Errorf("caracal: CARACAL_RESOURCES_FILE must contain an object or array")
	}
}

func isAbsoluteURL(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && parsed.Scheme != "" && parsed.Host != ""
}

func resourceIDsFromEnv(raw string, first []string, bindings []ResourceBinding) []string {
	out := append([]string(nil), first...)
	for _, value := range strings.Split(raw, ",") {
		value = strings.TrimSpace(value)
		if value != "" {
			out = append(out, value)
		}
	}
	// Binding-derived ids always join the STS audience set so a routed
	// resource can never be minted without an audience.
	for _, binding := range bindings {
		out = append(out, binding.ResourceID)
	}
	return compactStrings(out)
}

func defaultProfilePath() string {
	dir := defaultConfigDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "caracal.toml")
}

func defaultConfigDir() string {
	if value := os.Getenv("CARACAL_CONFIG_HOME"); value != "" {
		return value
	}
	if value := os.Getenv("XDG_CONFIG_HOME"); value != "" {
		return filepath.Join(value, "caracal")
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	if runtime.GOOS == "windows" {
		if value := os.Getenv("APPDATA"); value != "" {
			return filepath.Join(value, "Caracal")
		}
		if value := os.Getenv("LOCALAPPDATA"); value != "" {
			return filepath.Join(value, "Caracal")
		}
		return filepath.Join(home, "AppData", "Roaming", "Caracal")
	}
	if runtime.GOOS == "darwin" {
		return filepath.Join(home, "Library", "Application Support", "Caracal")
	}
	return filepath.Join(home, ".config", "caracal")
}

func defaultCredentialDir(zoneID string, applicationID string) string {
	return filepath.Join(defaultConfigDir(), "runtime", safePathSegment(zoneID), safePathSegment(applicationID))
}

func defaultClientSecretPath(zoneID string, applicationID string) string {
	return filepath.Join(defaultCredentialDir(zoneID, applicationID), "client-secret")
}

func defaultRunCredentialsPath(zoneID string, applicationID string) string {
	return filepath.Join(defaultCredentialDir(zoneID, applicationID), "credentials.json")
}

func safePathSegment(value string) string {
	value = strings.TrimSpace(value)
	var b strings.Builder
	lastUnderscore := false
	for _, r := range value {
		ok := r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '.' || r == '-' || r == '_'
		if ok {
			b.WriteRune(r)
			lastUnderscore = false
			continue
		}
		if !lastUnderscore {
			b.WriteByte('_')
			lastUnderscore = true
		}
	}
	out := strings.Trim(b.String(), "_")
	if out == "" {
		return "default"
	}
	return out
}

func existingLocalFile(path string) string {
	if path == "" || productionEnv() {
		return ""
	}
	if _, err := os.Stat(path); err == nil {
		return path
	}
	return ""
}

// POSIX write bits are meaningless on Windows, where NTFS ACLs govern access
// and writable files always report 0666, so the bit check applies elsewhere only.
func permTooBroad(info os.FileInfo) bool {
	return runtime.GOOS != "windows" && info.Mode().Perm()&0o022 != 0
}

// permBeyondOwner reports any group or other access bits: a file carrying a
// secret must be readable only by its owner.
func permBeyondOwner(info os.FileInfo) bool {
	return runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0
}

func readSecretFile(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("caracal: secret file is not readable: %w", err)
	}
	if permBeyondOwner(info) {
		return "", fmt.Errorf("caracal: secret file must be readable only by its owner: %s", path)
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

func clientSecretFromEnv(zoneID string, applicationID string) (string, error) {
	value := os.Getenv("CARACAL_APP_CLIENT_SECRET")
	fileValue := os.Getenv("CARACAL_APP_CLIENT_SECRET_FILE")
	if value != "" && fileValue != "" {
		return "", fmt.Errorf("caracal: set only one of CARACAL_APP_CLIENT_SECRET or CARACAL_APP_CLIENT_SECRET_FILE")
	}
	if fileValue != "" {
		return readSecretFile(fileValue)
	}
	if value != "" {
		return value, nil
	}
	if localFile := existingLocalFile(defaultClientSecretPath(zoneID, applicationID)); localFile != "" {
		return readSecretFile(localFile)
	}
	return "", nil
}

func clientSecretFromProfile(path string, cfg profileFile) (string, error) {
	if cfg.AppClientSecret != "" && cfg.AppClientSecretFile != "" {
		return "", fmt.Errorf("caracal: %s sets both app_client_secret and app_client_secret_file", path)
	}
	if cfg.AppClientSecret != "" {
		info, err := os.Stat(path)
		if err != nil {
			return "", err
		}
		if permBeyondOwner(info) {
			return "", fmt.Errorf("caracal: %s carries an inline app_client_secret and must be readable only by its owner", path)
		}
		return cfg.AppClientSecret, nil
	}
	fileValue := cfg.AppClientSecretFile
	if fileValue == "" {
		fileValue = existingLocalFile(defaultClientSecretPath(cfg.ZoneID, cfg.ApplicationID))
	}
	if fileValue == "" {
		return "", fmt.Errorf("caracal: %s requires a client secret; local dev/stable auto-detects %s when it exists", path, defaultClientSecretPath(cfg.ZoneID, cfg.ApplicationID))
	}
	return readSecretFile(fileValue)
}

type profileCredential struct {
	Resource       string `toml:"resource"`
	UpstreamPrefix string `toml:"upstream_prefix"`
}

// profileFile is the SDK-relevant subset of a generated caracal.toml profile.
// Unknown keys are tolerated so the profile can carry runtime-only settings.
type profileFile struct {
	ZoneID              string              `toml:"zone_id"`
	ApplicationID       string              `toml:"application_id"`
	STSURL              string              `toml:"sts_url"`
	ZoneURL             string              `toml:"zone_url"`
	CoordinatorURL      string              `toml:"coordinator_url"`
	GatewayURL          string              `toml:"gateway_url"`
	AppClientSecret     string              `toml:"app_client_secret"`
	AppClientSecretFile string              `toml:"app_client_secret_file"`
	DefaultTTLSeconds   int                 `toml:"default_ttl_seconds"`
	Credentials         []profileCredential `toml:"credentials"`
	OptionalCredentials []profileCredential `toml:"optional_credentials"`
}

func parseProfile(path string) (profileFile, error) {
	info, err := os.Stat(path)
	if err != nil {
		return profileFile{}, err
	}
	if permTooBroad(info) {
		return profileFile{}, fmt.Errorf("caracal: profile permissions are too broad: %s", path)
	}
	var cfg profileFile
	if _, err := toml.DecodeFile(path, &cfg); err != nil {
		return profileFile{}, fmt.Errorf("caracal: invalid profile %s: %w", path, err)
	}
	if cfg.ZoneID == "" {
		return profileFile{}, fmt.Errorf("caracal: %s requires zone_id", path)
	}
	if cfg.ApplicationID == "" {
		return profileFile{}, fmt.Errorf("caracal: %s requires application_id", path)
	}
	if cfg.DefaultTTLSeconds < 0 {
		return profileFile{}, fmt.Errorf("caracal: %s default_ttl_seconds must be a positive integer", path)
	}
	return cfg, nil
}

func resourceIDsFromProfile(cfg profileFile) ([]string, []ResourceBinding) {
	ids := []string{}
	bindings := []ResourceBinding{}
	seen := map[string]bool{}
	for _, cred := range append(append([]profileCredential{}, cfg.Credentials...), cfg.OptionalCredentials...) {
		if cred.Resource == "" || seen[cred.Resource] {
			continue
		}
		seen[cred.Resource] = true
		ids = append(ids, cred.Resource)
		if cred.UpstreamPrefix != "" {
			bindings = append(bindings, ResourceBinding{ResourceID: cred.Resource, UpstreamPrefix: cred.UpstreamPrefix})
		}
	}
	return ids, sortBindingsLongestFirst(bindings)
}

func credentialManifestFromEnv(zoneID string, applicationID string) ([]string, []ResourceBinding, error) {
	fileValue := os.Getenv("CARACAL_RUN_CREDENTIALS_FILE")
	inline := os.Getenv("CARACAL_RUN_CREDENTIALS")
	if fileValue != "" && inline != "" {
		return nil, nil, fmt.Errorf("caracal: set only one of CARACAL_RUN_CREDENTIALS or CARACAL_RUN_CREDENTIALS_FILE")
	}
	if fileValue == "" && inline == "" {
		fileValue = existingLocalFile(defaultRunCredentialsPath(zoneID, applicationID))
		if fileValue == "" {
			return nil, nil, nil
		}
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

// OnSessionStart registers a hook fired when Session binds a new session.
func (c *Caracal) OnSessionStart(h LifecycleHook) {
	c.sessionStartHooks = append(c.sessionStartHooks, h)
}

// OnSessionEnd registers a hook fired when Session unwinds a session.
func (c *Caracal) OnSessionEnd(h LifecycleHook) {
	c.sessionEndHooks = append(c.sessionEndHooks, h)
}

// OnEvent subscribes to control-plane operation events: token exchanges (with
// cache outcome), approval waits, and coordinator calls, each carrying outcome
// and duration. Bridge them to any metrics or tracing system; a hook that
// panics is ignored and never disturbs the operation that emitted the event.
func (c *Caracal) OnEvent(h func(oauth.Event)) {
	c.eventHooks = append(c.eventHooks, h)
	if c.Coordinator != nil {
		c.Coordinator.OnEvent = c.emitEvent
	}
	if c.exchanger != nil {
		c.exchanger.setOnEvent(c.emitEvent)
	}
}

func (c *Caracal) emitEvent(event oauth.Event) {
	for _, h := range c.eventHooks {
		func() {
			defer func() {
				// The observability sink must never break the operation path.
				_ = recover()
			}()
			h(event)
		}()
	}
}

func (c *Caracal) fire(hooks []LifecycleHook, ctx context.Context, cc CaracalContext) error {
	for _, h := range hooks {
		if err := h(ctx, cc); err != nil {
			return err
		}
	}
	return nil
}

// SessionOptions overrides defaults for a single Session call.
type SessionOptions struct {
	Authority  Authority
	TTLSeconds int
	ParentID   string
	Metadata   map[string]any
	Labels     []string
	TraceID    string
}

// Session runs fn inside a governed session: a bounded identity Caracal
// establishes around whatever fn executes - an AI agent step, a job, a tool
// call, any code. The session binds delegated authority, records audit
// attribution, and is retired when fn returns. By default the coordinator
// carries the parent's effective authority forward by mirroring its active
// narrowing delegation onto the child; set Options.Authority to
// AuthorityNarrow(...) to bound the session to a subset of scopes.
func (c *Caracal) Session(ctx context.Context, fn func(context.Context) error, opts ...SessionOptions) error {
	o := SessionOptions{}
	if len(opts) > 0 {
		o = opts[0]
	}
	ttl := o.TTLSeconds
	if ttl == 0 {
		ttl = c.DefaultTTLSeconds
	}
	var onStart, onEnd LifecycleHook
	if len(c.sessionStartHooks) > 0 {
		onStart = func(cx context.Context, cc CaracalContext) error { return c.fire(c.sessionStartHooks, cx, cc) }
	}
	if len(c.sessionEndHooks) > 0 {
		onEnd = func(cx context.Context, cc CaracalContext) error { return c.fire(c.sessionEndHooks, cx, cc) }
	}
	subjectToken, err := c.rootToken(ctx)
	if err != nil {
		return err
	}
	return Session(ctx, SessionInput{
		Coordinator:    c.Coordinator,
		ZoneID:         c.ZoneID,
		ApplicationID:  c.ApplicationID,
		SubjectToken:   subjectToken,
		TokenSource:    c.TokenSource,
		Invalidate:     c.invalidateHook(),
		ParentID:       o.ParentID,
		Authority:      o.Authority,
		TTLSeconds:     ttl,
		Metadata:       o.Metadata,
		Labels:         o.Labels,
		TraceID:        o.TraceID,
		OnSessionStart: onStart,
		OnSessionEnd:   onEnd,
	}, fn)
}

// StartSessionOptions overrides defaults for a single Service call.
// HeartbeatInterval selects the lease renewal mode: zero (the default)
// derives the cadence from the server lease, a positive value fixes it, and a
// negative value disables the background renewal. OnLeaseLost fires once if
// the coordinator reports the session permanently gone.
type StartSessionOptions struct {
	Authority         Authority
	TTLSeconds        int
	ParentID          string
	Metadata          map[string]any
	Labels            []string
	TraceID           string
	HeartbeatInterval time.Duration
	OnLeaseLost       func(error)
}

// Service starts a long-lived service agent and returns a handle the caller
// owns. Unlike Session, the session is not retired when a block exits: a
// background goroutine renews the lease by default and the handle is retired
// with SessionHandle.Close. Use for daemons and workers that outlive a single
// request.
func (c *Caracal) StartSession(ctx context.Context, opts ...StartSessionOptions) (*SessionHandle, error) {
	o := StartSessionOptions{}
	if len(opts) > 0 {
		o = opts[0]
	}
	var onStart, onEnd LifecycleHook
	if len(c.sessionStartHooks) > 0 {
		onStart = func(cx context.Context, cc CaracalContext) error { return c.fire(c.sessionStartHooks, cx, cc) }
	}
	if len(c.sessionEndHooks) > 0 {
		onEnd = func(cx context.Context, cc CaracalContext) error { return c.fire(c.sessionEndHooks, cx, cc) }
	}
	subjectToken, err := c.rootToken(ctx)
	if err != nil {
		return nil, err
	}
	return StartSession(ctx, StartSessionInput{
		Coordinator:       c.Coordinator,
		ZoneID:            c.ZoneID,
		ApplicationID:     c.ApplicationID,
		SubjectToken:      subjectToken,
		TokenSource:       c.TokenSource,
		Invalidate:        c.invalidateHook(),
		ParentID:          o.ParentID,
		Authority:         o.Authority,
		TTLSeconds:        o.TTLSeconds,
		Metadata:          o.Metadata,
		Labels:            o.Labels,
		TraceID:           o.TraceID,
		HeartbeatInterval: o.HeartbeatInterval,
		OnLeaseLost:       o.OnLeaseLost,
		OnSessionStart:    onStart,
		OnSessionEnd:      onEnd,
	})
}

// DelegateOptions configures a delegation to a peer session.
type DelegateOptions struct {
	To              string
	ToApplicationID string
	Scopes          []string
	Constraints     *DelegationConstraints
	TTLSeconds      int
}

// Delegate delegates a slice of the current session's authority to a peer
// session and returns the created delegation. The caller's context is
// unchanged; hand the delegation id to the receiving session, which presents
// it with AcceptDelegation.
func (c *Caracal) Delegate(ctx context.Context, opts DelegateOptions) (Delegation, error) {
	return Delegate(ctx, DelegateInput{
		Coordinator:     c.Coordinator,
		ToSessionID:     opts.To,
		ToApplicationID: opts.ToApplicationID,
		Scopes:          opts.Scopes,
		Constraints:     opts.Constraints,
		TTLSeconds:      opts.TTLSeconds,
	})
}

// AcceptDelegation derives a receiver context presenting the given
// delegation and binds it: calls made under the returned context carry the
// delegation's bounded authority.
func (c *Caracal) AcceptDelegation(ctx context.Context, delegationID string) (context.Context, error) {
	return AcceptDelegation(ctx, delegationID)
}

// MandateOptions carries optional mint inputs: a TTL override and the
// approval challenge id for retrying an approval-gated mint.
type MandateOptions struct {
	TTLSeconds int
	ApprovalID string
}

// MintMandate mints a resource mandate for the current session: a short-lived
// token audienced to resourceID and narrowed to scopes, carrying the session
// and delegation of the bound CaracalContext. The STS evaluates policy
// against that session's authority, so a narrowed child can mint only what
// its delegation allows. Results are cached per resource, scope set, and
// session identity, and refreshed before expiry.
//
// When a scope is approval-gated the mint returns
// *oauth.ApprovalRequiredError; retry with ApprovalID set to the returned
// challenge id once an authenticated approver has satisfied it. Requires a
// client-secret configuration.
func (c *Caracal) MintMandate(ctx context.Context, resourceID string, scopes []string, opts ...MandateOptions) (string, error) {
	if c.exchanger == nil {
		return "", fmt.Errorf("caracal: MintMandate requires a client-secret configuration")
	}
	var o MandateOptions
	if len(opts) > 0 {
		o = opts[0]
	}
	cur, _ := Current(ctx)
	token, err := c.exchanger.mintMandate(ctx, resourceID, scopes, cur.SessionID, cur.DelegationID, o)
	if err != nil {
		return "", err
	}
	return token.AccessToken, nil
}

// WaitForApproval long-polls an approval challenge until an approver decides
// it, it expires, or the timeout elapses. Returns the final lifecycle state:
// "approved" means retrying the mint with ApprovalID set will succeed;
// "rejected" and "expired" are terminal; "pending" means the timeout elapsed
// with no decision and waiting again is safe.
func (c *Caracal) WaitForApproval(ctx context.Context, challengeID string, timeout time.Duration) (string, error) {
	if c.exchanger == nil {
		return "", fmt.Errorf("caracal: WaitForApproval requires a client-secret configuration")
	}
	return c.exchanger.waitForApproval(ctx, challengeID, timeout)
}

// CallOptions controls explicit use of the application subject token when no
// CaracalContext is bound, and optional bearer verification at the inbound
// boundary. Verify is invoked by BindFromRequest with the inbound token and
// must return an error to reject the request; back it with the identity
// package so binding happens only after the mandate is proven. Claims the
// verifier returns take precedence over the caller-supplied envelope.
// Scopes switches gateway-routed requests from the raw subject token to a
// scoped resource mandate minted for the routed resource and the bound agent
// identity; requires a client-secret configuration. Used by Transport and Fetch.
type CallOptions struct {
	AsApplication bool
	Verify        func(context.Context, string) (*VerifiedClaims, error)
	Scopes        []string
}

func asApplication(opts []CallOptions) bool {
	return len(opts) > 0 && opts[0].AsApplication
}

func scopesOf(opts []CallOptions) []string {
	if len(opts) == 0 {
		return nil
	}
	return opts[0].Scopes
}

// Headers returns the envelope headers plus the bearer credential for the
// current ctx. Root application identity requires CallOptions{AsApplication: true}.
// For contexts this process established from its own credentials, the bearer is
// resolved fresh through the token source so long-lived holders never present
// an expired token.
func (c *Caracal) Headers(ctx context.Context, opts ...CallOptions) (http.Header, error) {
	h := http.Header{}
	cur, ok := Current(ctx)
	if !ok {
		if !allowRoot(opts) {
			return nil, fmt.Errorf("caracal: Headers called without a bound CaracalContext; pass CallOptions{AsApplication: true} to call as the application's own identity")
		}
		subjectToken, err := c.rootToken(ctx)
		if err != nil {
			return nil, err
		}
		InjectHTTP(Envelope{Hop: 0}, h)
		h.Set(HeaderAuthorization, "Bearer "+subjectToken)
		return h, nil
	}
	InjectHTTP(ToEnvelope(cur), h)
	token := cur.SubjectToken
	if cur.OwnToken && c.TokenSource != nil {
		fresh, err := c.TokenSource(ctx)
		if err != nil {
			return nil, err
		}
		token = fresh
	}
	h.Set(HeaderAuthorization, "Bearer "+token)
	return h, nil
}

// BindFromRequest extracts the envelope from an inbound request and returns a
// context bound with the resulting CaracalContext. When CallOptions.Verify is
// set, the inbound bearer is verified before binding and any claims it returns
// override the envelope, so a forged envelope cannot outrun the token.
func (c *Caracal) BindFromRequest(ctx context.Context, r *http.Request, opts ...CallOptions) (context.Context, error) {
	var opt CallOptions
	if len(opts) > 0 {
		opt = opts[0]
	}
	env := FromHTTPRequest(r)
	var claims *VerifiedClaims
	rootInjected := false
	if env.SubjectToken == "" {
		if !opt.AsApplication {
			return ctx, fmt.Errorf("caracal: BindFromRequest missing bearer token")
		}
		subjectToken, err := c.rootToken(ctx)
		if err != nil {
			return ctx, err
		}
		env.SubjectToken = subjectToken
		rootInjected = true
	} else if opt.Verify != nil {
		verified, err := opt.Verify(ctx, env.SubjectToken)
		if err != nil {
			return ctx, err
		}
		claims = verified
	}
	zoneID := c.ZoneID
	applicationID := c.ApplicationID
	if claims != nil {
		if claims.ZoneID != "" {
			zoneID = claims.ZoneID
		}
		if claims.ApplicationID != "" {
			applicationID = claims.ApplicationID
		}
		if claims.SessionID != "" {
			env.SessionID = claims.SessionID
		}
		if claims.DelegationID != "" {
			env.DelegationID = claims.DelegationID
		}
		if claims.ParentDelegationID != "" {
			env.ParentDelegationID = claims.ParentDelegationID
		}
		if claims.SubjectSessionID != "" {
			env.SubjectSessionID = claims.SubjectSessionID
		}
		if claims.Hop != nil {
			env.Hop = *claims.Hop
		}
	}
	cc, err := FromEnvelope(env, zoneID, applicationID)
	if err != nil {
		return ctx, err
	}
	cc.OwnToken = rootInjected
	return Bind(ctx, cc), nil
}

// Current returns the Caracal context bound on ctx, or a zero value and false.
func (c *Caracal) Current(ctx context.Context) (CaracalContext, bool) {
	return Current(ctx)
}

// Transport returns an *http.Client whose RoundTripper merges the Caracal
// context envelope onto each request from its context. The subject token is
// attached only to gateway-routed requests, where the Gateway terminates it
// at the trust boundary. Pass to any HTTP or provider SDK that accepts a
// custom *http.Client.
func (c *Caracal) Transport(base *http.Client, opts ...CallOptions) *http.Client {
	if base == nil {
		base = &http.Client{}
	}
	rt := base.Transport
	if rt == nil {
		rt = http.DefaultTransport
	}
	out := *base
	out.Transport = &caracalTransport{base: rt, client: c, asApplication: asApplication(opts), scopes: scopesOf(opts)}
	return &out
}

// ApplicationTransportOptions configures ApplicationTransport: the scopes
// each mandate carries, the labels stamped on the provisioning cycle's
// sessions, and an optional mandate TTL override.
type ApplicationTransportOptions struct {
	Scopes            []string
	Labels            []string
	MandateTTLSeconds int
}

// ApplicationTransport returns an *http.Client pinned to one resource,
// calling as the application's own identity rather than a bound session
// context: it starts a source and target session, delegates the requested
// scopes across them bounded to resourceID, and mints the mandate from that
// delegation, so each call is policy-checked, delegation-bounded, and fully
// audited without a caller-supplied CaracalContext. Mandates are cached per
// resolved identity, resource, scope set, effective labels, and mandate TTL,
// then re-provisioned before expiry. Requests are rewritten through the gateway.
// Requires a client-secret configuration.
func (c *Caracal) ApplicationTransport(base *http.Client, resourceID string, opts ApplicationTransportOptions) (*http.Client, error) {
	if c.exchanger == nil {
		return nil, fmt.Errorf("caracal: ApplicationTransport requires a client-secret configuration")
	}
	if strings.TrimSpace(resourceID) == "" {
		return nil, fmt.Errorf("caracal: ApplicationTransport requires resourceID")
	}
	if len(opts.Scopes) == 0 {
		return nil, fmt.Errorf("caracal: ApplicationTransport requires at least one scope")
	}
	scopes := compactStrings(append([]string(nil), opts.Scopes...))
	sort.Strings(scopes)
	mandateTTL := opts.MandateTTLSeconds
	if mandateTTL <= 0 {
		mandateTTL = appMandateTTLSeconds
	}
	if base == nil {
		base = &http.Client{}
	}
	rt := base.Transport
	if rt == nil {
		rt = http.DefaultTransport
	}
	out := *base
	out.Transport = &applicationTransport{base: rt, client: c, resourceID: resourceID, scopes: scopes, labels: opts.Labels, mandateTTL: mandateTTL}
	return &out, nil
}

// GatewayRequest builds a Gateway URL and X-Caracal-Resource header for explicit resource routing.
func (c *Caracal) GatewayRequest(resourceID, path string) (GatewayRequest, error) {
	if c.GatewayURL == "" {
		return GatewayRequest{}, fmt.Errorf("caracal: GatewayRequest requires GatewayURL")
	}
	if strings.TrimSpace(resourceID) == "" {
		return GatewayRequest{}, fmt.Errorf("caracal: GatewayRequest requires resourceID")
	}
	target, err := joinGatewayPath(c.GatewayURL, path)
	if err != nil {
		return GatewayRequest{}, err
	}
	header := http.Header{}
	header.Set("X-Caracal-Resource", resourceID)
	return GatewayRequest{URL: target, Header: header}, nil
}

// FetchOptions carries the optional request inputs for Fetch. Scopes
// authorizes with a scoped resource mandate minted for the target resource
// instead of the raw subject token; requires a client-secret configuration.
type FetchOptions struct {
	Body          io.Reader
	Header        http.Header
	AsApplication bool
	Scopes        []string
}

// Fetch is the one-call happy path: it sends an HTTP request to path on the given
// Caracal resource through the Gateway, injecting Caracal context and authority on
// the outbound call. The resource header always wins over any caller-supplied
// X-Caracal-Resource. The caller closes the returned response body.
func (c *Caracal) Fetch(ctx context.Context, method, resourceID, path string, opts ...FetchOptions) (*http.Response, error) {
	var opt FetchOptions
	if len(opts) > 0 {
		opt = opts[0]
	}
	gr, err := c.GatewayRequest(resourceID, path)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, gr.URL, opt.Body)
	if err != nil {
		return nil, err
	}
	if opt.Header != nil {
		req.Header = opt.Header.Clone()
	}
	for key, values := range gr.Header {
		for _, value := range values {
			req.Header.Set(key, value)
		}
	}
	return c.Transport(nil, CallOptions{AsApplication: opt.AsApplication, Scopes: opt.Scopes}).Do(req)
}

type caracalTransport struct {
	base          http.RoundTripper
	client        *Caracal
	asApplication bool
	scopes        []string
}

func (t *caracalTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	cur, ok := Current(req.Context())
	if !ok && !t.asApplication {
		return nil, fmt.Errorf("caracal: Transport request has no bound CaracalContext; pass CallOptions{AsApplication: true} to call as the application's own identity")
	}
	env := Envelope{Hop: 0}
	if ok {
		env = ToEnvelope(cur)
	}
	clone := req.Clone(req.Context())
	InjectHTTP(env, clone.Header)
	if rewritten := t.client.routeThroughGateway(clone.URL, clone.Header.Get("X-Caracal-Resource")); rewritten != nil {
		clone.URL = rewritten.url
		clone.Host = rewritten.url.Host
		clone.RequestURI = ""
		clone.Header.Set("X-Caracal-Resource", rewritten.resourceID)
		token, err := t.gatewayToken(req.Context(), rewritten.resourceID, cur, ok)
		if err != nil {
			return nil, err
		}
		clone.Header.Set("Authorization", "Bearer "+token)
	} else if t.client.targetsGateway(clone.URL) {
		token, err := t.gatewayToken(req.Context(), clone.Header.Get("X-Caracal-Resource"), cur, ok)
		if err != nil {
			return nil, err
		}
		clone.Header.Set("Authorization", "Bearer "+token)
	}
	return t.base.RoundTrip(clone)
}

// gatewayToken resolves the bearer for a gateway-bound request: a scoped
// mandate when the transport carries scopes and the routed resource is known,
// a fresh token from the client token source for contexts this process
// established from its own credentials, the pinned context token for
// inbound-bound contexts, or the application token in root mode.
func (t *caracalTransport) gatewayToken(ctx context.Context, resourceID string, cur CaracalContext, ok bool) (string, error) {
	if len(t.scopes) > 0 && resourceID != "" {
		if t.client.exchanger == nil {
			return "", fmt.Errorf("caracal: Transport scopes require a client-secret configuration")
		}
		token, err := t.client.exchanger.mintMandate(ctx, resourceID, t.scopes, cur.SessionID, cur.DelegationID, MandateOptions{})
		if err != nil {
			return "", err
		}
		return token.AccessToken, nil
	}
	if !ok {
		return t.client.rootToken(ctx)
	}
	if cur.OwnToken && t.client.TokenSource != nil {
		return t.client.TokenSource(ctx)
	}
	return cur.SubjectToken, nil
}

// targetsGateway reports whether the request is already addressed to the
// configured Gateway origin, where the subject token terminates.
func (c *Caracal) targetsGateway(target *url.URL) bool {
	if c.GatewayURL == "" || target == nil {
		return false
	}
	gw, err := url.Parse(c.GatewayURL)
	if err != nil {
		return false
	}
	return sameOrigin(target, gw)
}

type applicationTransport struct {
	base       http.RoundTripper
	client     *Caracal
	resourceID string
	scopes     []string
	labels     []string
	mandateTTL int
}

func (t *applicationTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	token, err := t.client.appMandate(req.Context(), t.resourceID, t.scopes, t.labels, t.mandateTTL)
	if err != nil {
		return nil, err
	}
	clone := req.Clone(req.Context())
	clone.Header.Set("Authorization", "Bearer "+token)
	clone.Header.Set("X-Caracal-Resource", t.resourceID)
	if rewritten := t.client.routeThroughGateway(clone.URL, t.resourceID); rewritten != nil {
		clone.URL = rewritten.url
		clone.Host = rewritten.url.Host
		clone.RequestURI = ""
	}
	return t.base.RoundTrip(clone)
}

type appMandateEntry struct {
	token     string
	expiresAt time.Time
}

type appMandateCall struct {
	done  chan struct{}
	token string
	err   error
}

// appMandate returns a cached or freshly provisioned application mandate
// for the resource, scope set, labels, and TTL under the current resolved identity.
// Concurrent requests for the same key share one provisioning cycle.
func (c *Caracal) appMandate(ctx context.Context, resourceID string, scopes, labels []string, mandateTTL int) (string, error) {
	zoneID, applicationID, err := c.exchanger.identity(ctx)
	if err != nil {
		return "", err
	}
	sessionLabels := labels
	if len(sessionLabels) == 0 {
		sessionLabels = []string{applicationID}
	}
	key := appMandateKey(zoneID, applicationID, resourceID, scopes, sessionLabels, mandateTTL)
	c.appMandateMu.Lock()
	if cached, ok := c.appMandates[key]; ok && time.Until(cached.expiresAt) > appMandateRefreshMargin {
		c.appMandateMu.Unlock()
		return cached.token, nil
	}
	if inflight, ok := c.appInflight[key]; ok {
		c.appMandateMu.Unlock()
		select {
		case <-inflight.done:
			return inflight.token, inflight.err
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	call := &appMandateCall{done: make(chan struct{})}
	if c.appInflight == nil {
		c.appInflight = map[string]*appMandateCall{}
	}
	c.appInflight[key] = call
	c.appMandateMu.Unlock()

	token, expiresAt, err := c.appMandateCycle(ctx, zoneID, applicationID, resourceID, scopes, labels, mandateTTL)
	call.token, call.err = token, err
	c.appMandateMu.Lock()
	delete(c.appInflight, key)
	if err == nil {
		if c.appMandates == nil {
			c.appMandates = map[string]appMandateEntry{}
		}
		c.appMandates[key] = appMandateEntry{token: token, expiresAt: expiresAt}
	}
	c.appMandateMu.Unlock()
	close(call.done)
	return token, err
}

func appMandateKey(zoneID, applicationID, resourceID string, scopes, labels []string, mandateTTL int) string {
	encodedLabels, _ := json.Marshal(labels)
	return zoneID + "::" + applicationID + "::" + resourceID + "::" + strings.Join(scopes, " ") + "::" + string(encodedLabels) + "::" + strconv.Itoa(mandateTTL)
}

// appMandateCycle provisions one application mandate under the application's
// own identity: a lifecycle-scoped bootstrap mandate, a source and target
// session, a delegation narrowing the requested scopes to the resource,
// and the final mandate minted from that delegation. Started sessions are
// terminated on any failure.
func (c *Caracal) appMandateCycle(ctx context.Context, zoneID, applicationID, resourceID string, scopes, labels []string, mandateTTL int) (string, time.Time, error) {
	sessionTTL := mandateTTL + appSessionTTLBuffer
	boot, err := c.exchanger.mintMandate(ctx, resourceID, []string{lifecycleScope}, "", "", MandateOptions{})
	if err != nil {
		return "", time.Time{}, err
	}
	bootstrap := boot.AccessToken
	sessionLabels := labels
	if len(sessionLabels) == 0 {
		sessionLabels = []string{applicationID}
	}
	spawned := []string{}
	cleanup := func() {
		cleanupCtx := context.WithoutCancel(ctx)
		for _, id := range spawned {
			_ = TerminateAgent(cleanupCtx, c.Coordinator, bootstrap, zoneID, id)
		}
	}
	spawn := func() (string, error) {
		res, err := SpawnAgent(ctx, c.Coordinator, bootstrap, SpawnRequest{
			ZoneID:         zoneID,
			ApplicationID:  applicationID,
			Lifecycle:      LifecycleTask,
			TTLSeconds:     sessionTTL,
			Labels:         sessionLabels,
			IdempotencyKey: newRandomHex(16),
		})
		if err != nil {
			return "", err
		}
		spawned = append(spawned, res.AgentSessionID)
		return res.AgentSessionID, nil
	}
	source, err := spawn()
	if err != nil {
		cleanup()
		return "", time.Time{}, err
	}
	target, err := spawn()
	if err != nil {
		cleanup()
		return "", time.Time{}, err
	}
	edge, err := CreateDelegation(ctx, c.Coordinator, bootstrap, DelegationRequest{
		ZoneID:                zoneID,
		IssuerApplicationID:   applicationID,
		SourceSessionID:       source,
		TargetSessionID:       target,
		ReceiverApplicationID: applicationID,
		Scopes:                scopes,
		Constraints:           &DelegationConstraints{Resources: []string{resourceID}},
		TTLSeconds:            sessionTTL,
	})
	if err != nil {
		cleanup()
		return "", time.Time{}, err
	}
	mandate, err := c.exchanger.mintMandate(ctx, resourceID, scopes, target, edge.DelegationEdgeID, MandateOptions{TTLSeconds: mandateTTL})
	if err != nil {
		cleanup()
		return "", time.Time{}, err
	}
	ttl := mandate.ExpiresIn
	if ttl <= 0 {
		ttl = mandateTTL
	}
	return mandate.AccessToken, time.Now().Add(time.Duration(ttl) * time.Second), nil
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

func joinGatewayPath(gatewayURL, path string) (string, error) {
	parsed, err := url.Parse(path)
	if err != nil {
		return "", err
	}
	if parsed.IsAbs() || parsed.Host != "" {
		return "", fmt.Errorf("caracal: GatewayRequest path must be relative to the configured gateway")
	}
	gw, err := url.Parse(gatewayURL)
	if err != nil {
		return "", err
	}
	pathname := parsed.EscapedPath()
	if pathname == "" {
		pathname = parsed.Path
	}
	if pathname == "" {
		pathname = "/"
	}
	if !strings.HasPrefix(pathname, "/") {
		pathname = "/" + pathname
	}
	base := strings.TrimRight(gw.Scheme+"://"+gw.Host+gw.Path, "/")
	if parsed.RawQuery != "" {
		return base + pathname + "?" + parsed.RawQuery, nil
	}
	return base + pathname, nil
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
