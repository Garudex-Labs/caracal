// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Caracal: drop-in bound client wrapping zone, application, subject token, and coordinator.

package sdk

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
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
const appAuthorityRefreshMargin = 60 * time.Second
const appSessionTTLBuffer = 120

// Each authority entry owns two sessions. Nineteen entries leave room for ten
// ordinary sessions and the next two-session provisioning cycle.
const appAuthorityCacheCap = 19

var credentialFingerprintKey = func() []byte {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		panic(err)
	}
	return key
}()

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

	hookMu            sync.Mutex
	nextHookID        uint64
	sessionStartHooks map[uint64]LifecycleHook
	sessionEndHooks   map[uint64]LifecycleHook
	eventHooks        map[uint64]func(oauth.Event)
	exchanger         *clientSecretExchanger

	appMandateMu  sync.Mutex
	appMandates   map[string]appMandateEntry
	appOrder      []string
	appInflight   map[string]*appMandateCall
	appProvision  chan struct{}
	appGeneration uint64

	unverifiedBoundaryOnce sync.Once
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

// GatewayTarget is a Gateway URL and resource header for explicit resource routing.
type GatewayTarget struct {
	URL    string
	Header http.Header
}

// New builds a Caracal client from CARACAL_CONFIG when set, otherwise from environment variables.
func New() (*Caracal, error) {
	if path := os.Getenv("CARACAL_CONFIG"); path != "" {
		return FromConfig(path)
	}
	return FromEnv()
}

// FromEnv constructs a Caracal client from CARACAL_ZONE_ID,
// CARACAL_APPLICATION_ID, and CARACAL_BOOTSTRAP_TOKEN or CARACAL_APP_CLIENT_SECRET.
func FromEnv() (*Caracal, error) {
	coordinatorURL, err := serviceURL("CARACAL_COORDINATOR_URL", defaultCoordinatorURL)
	if err != nil {
		return nil, err
	}
	zone := os.Getenv("CARACAL_ZONE_ID")
	app := os.Getenv("CARACAL_APPLICATION_ID")
	tok := os.Getenv("CARACAL_BOOTSTRAP_TOKEN")
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
	bindings := sortBindingsLongestFirst(mergeResourceBindings(fileBindings, envBindings))
	if clientSecret != "" && tok != "" {
		return nil, fmt.Errorf("caracal: configure exactly one of CARACAL_APP_CLIENT_SECRET and CARACAL_BOOTSTRAP_TOKEN")
	}
	if clientSecret != "" {
		resources := resourceIDsFromEnv(os.Getenv("CARACAL_APP_RESOURCES"), bindings)
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
		return nil, fmt.Errorf("caracal: FromEnv requires CARACAL_BOOTSTRAP_TOKEN or CARACAL_APP_CLIENT_SECRET")
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
type ClientSecretOptions struct {
	CoordinatorURL    string
	STSURL            string
	ZoneID            string
	ApplicationID     string
	ClientSecret      string
	Resources         []string
	ResourceBindings  []ResourceBinding
	GatewayURL        string
	HTTPClient        *http.Client
	DefaultTTLSeconds int
}

// FromClientSecret returns a Caracal client that refreshes its application subject token through STS.
func FromClientSecret(opts ClientSecretOptions) (*Caracal, error) {
	required := map[string]string{
		"CoordinatorURL": opts.CoordinatorURL,
		"STSURL":         opts.STSURL,
		"ZoneID":         opts.ZoneID,
		"ApplicationID":  opts.ApplicationID,
		"ClientSecret":   opts.ClientSecret,
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
	return fromClientOptions(clientOptions{
		CoordinatorURL:    opts.CoordinatorURL,
		STSURL:            opts.STSURL,
		ZoneID:            opts.ZoneID,
		ApplicationID:     opts.ApplicationID,
		ClientSecret:      opts.ClientSecret,
		Resources:         opts.Resources,
		ResourceBindings:  opts.ResourceBindings,
		GatewayURL:        opts.GatewayURL,
		HTTPClient:        opts.HTTPClient,
		DefaultTTLSeconds: opts.DefaultTTLSeconds,
	})
}

// AdvancedCredentialsOptions configures credentials resolved at operation time.
type AdvancedCredentialsOptions struct {
	CoordinatorURL    string
	STSURL            string
	Credentials       CredentialsResolver
	Resources         []string
	ResourceBindings  []ResourceBinding
	GatewayURL        string
	Scope             string
	HTTPClient        *http.Client
	DefaultTTLSeconds int
}

// FromCredentials returns a client backed by a dynamic credential resolver.
func FromCredentials(opts AdvancedCredentialsOptions) (*Caracal, error) {
	if opts.Credentials == nil {
		return nil, fmt.Errorf("caracal: FromCredentials requires Credentials")
	}
	if opts.CoordinatorURL == "" || opts.STSURL == "" {
		return nil, fmt.Errorf("caracal: FromCredentials requires CoordinatorURL and STSURL")
	}
	if opts.DefaultTTLSeconds < 0 {
		return nil, fmt.Errorf("caracal: FromCredentials DefaultTTLSeconds must be a positive integer")
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
	return fromClientOptions(clientOptions{
		CoordinatorURL:    opts.CoordinatorURL,
		STSURL:            opts.STSURL,
		Credentials:       opts.Credentials,
		Resources:         opts.Resources,
		ResourceBindings:  opts.ResourceBindings,
		GatewayURL:        opts.GatewayURL,
		Scope:             opts.Scope,
		HTTPClient:        opts.HTTPClient,
		DefaultTTLSeconds: opts.DefaultTTLSeconds,
	})
}

type clientOptions struct {
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

func fromClientOptions(opts clientOptions) (*Caracal, error) {
	for _, resourceID := range opts.Resources {
		if strings.TrimSpace(resourceID) == "" {
			return nil, fmt.Errorf("caracal: resource IDs must be non-empty")
		}
	}
	for _, binding := range opts.ResourceBindings {
		if strings.TrimSpace(binding.ResourceID) == "" {
			return nil, fmt.Errorf("caracal: resource IDs must be non-empty")
		}
		if !isAbsoluteURL(binding.UpstreamPrefix) {
			return nil, fmt.Errorf("caracal: UpstreamPrefix must be an absolute http or https URL: %s", binding.UpstreamPrefix)
		}
	}
	exchanger := newClientSecretExchanger(opts)
	return &Caracal{
		Coordinator:       &CoordinatorClient{BaseURL: opts.CoordinatorURL, HTTPClient: opts.HTTPClient},
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
	fileBindings, err := resourceBindingsFromFile(os.Getenv("CARACAL_RESOURCES_FILE"))
	if err != nil {
		return nil, err
	}
	envBindings, err := parseResourceBindings(os.Getenv("CARACAL_RESOURCES"))
	if err != nil {
		return nil, err
	}
	bindings := sortBindingsLongestFirst(mergeResourceBindings(profileBindings, fileBindings, envBindings))
	resourceIDs = compactStrings(append(resourceIDs, bindingResourceIDs(bindings)...))
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

// insecureConfigWarnOnce keeps the plaintext-override banner to a single line
// per process even though every configured URL passes through the check.
var insecureConfigWarnOnce sync.Once

func assertProductionTransport(name string, value string) error {
	if value == "" {
		return nil
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" || parsed.Scheme != "http" && parsed.Scheme != "https" {
		return fmt.Errorf("caracal: %s must be an absolute http or https URL: %s", name, value)
	}
	if !productionEnv() {
		return nil
	}
	if os.Getenv("CARACAL_ALLOW_INSECURE_CONFIG_URLS") == "true" {
		// The override disables the https requirement for the whole control
		// plane, so its presence in production must be loud and unmissable.
		insecureConfigWarnOnce.Do(func() {
			slog.Warn("caracal: CARACAL_ALLOW_INSECURE_CONFIG_URLS is active in production; control-plane traffic may travel over plaintext http - remove the override once TLS is in place")
		})
		return nil
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
	return serviceURL("CARACAL_STS_URL", defaultSTSURL)
}

// clientSecretExchanger owns the caching STS exchange client for a
// client-secret configuration: it resolves the application credential and
// lifecycle token and mints scoped resource mandates for the current agent
// identity. The oauth client is rebuilt (dropping its token cache) whenever
// the resolver yields a different zone or application.
type clientSecretExchanger struct {
	stsURL       string
	httpClient   *http.Client
	credentials  CredentialsResolver
	resources    []string
	scope        string
	mu           sync.Mutex
	force        bool
	client       *oauth.Client
	activeZone   string
	activeApp    string
	activeSecret string
	onEvent      func(oauth.Event)
}

func newClientSecretExchanger(opts clientOptions) *clientSecretExchanger {
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
	mac := hmac.New(sha256.New, credentialFingerprintKey)
	_, _ = mac.Write([]byte(creds.ClientSecret))
	secretID := fmt.Sprintf("%x", mac.Sum(nil))
	if e.client == nil || e.activeZone != creds.ZoneID || e.activeApp != creds.ApplicationID || e.activeSecret != secretID {
		client := oauth.NewClient(e.stsURL, creds.ZoneID, creds.ApplicationID, nil)
		if e.httpClient != nil {
			client.SetHTTPClient(e.httpClient)
		}
		client.OnEvent = e.onEvent
		e.client = client
		e.activeZone = creds.ZoneID
		e.activeApp = creds.ApplicationID
		e.activeSecret = secretID
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

func (e *clientSecretExchanger) credentialGeneration(ctx context.Context) (string, error) {
	if _, _, err := e.resolve(ctx); err != nil {
		return "", err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.activeSecret, nil
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

func (e *clientSecretExchanger) waitForApproval(ctx context.Context, approvalID string, timeout time.Duration) (oauth.ApprovalState, error) {
	_, client, err := e.resolve(ctx)
	if err != nil {
		return "", err
	}
	return client.WaitForApproval(ctx, approvalID, timeout)
}

// invalidate forces the next lifecycle token resolution to mint fresh (a
// verifier can reject a cached token before its exp after a server-side
// revocation).
func (e *clientSecretExchanger) invalidate() {
	e.mu.Lock()
	e.force = true
	client := e.client
	e.mu.Unlock()
	if client != nil {
		client.Invalidate()
	}
}

func (e *clientSecretExchanger) mintMandate(ctx context.Context, resourceID string, scopes []string, sessionID, delegationID string, opts mandateOptions) (oauth.TokenExchangeResponse, error) {
	creds, client, err := e.resolve(ctx)
	if err != nil {
		return oauth.TokenExchangeResponse{}, err
	}
	return client.Exchange(ctx, "", resourceID, oauth.ExchangeOptions{
		ClientSecret: creds.ClientSecret,
		Scopes:       scopes,
		SessionID:    sessionID,
		DelegationID: delegationID,
		TTLSeconds:   opts.TTLSeconds,
		ChallengeID:  opts.ApprovalID,
		OneShot:      opts.OneShot || sessionID != "" && delegationID != "",
	})
}

func (e *clientSecretExchanger) federateSubject(ctx context.Context, idToken string, opts FederateSubjectOptions) (oauth.TokenExchangeResponse, error) {
	creds, client, err := e.resolve(ctx)
	if err != nil {
		return oauth.TokenExchangeResponse{}, err
	}
	return client.FederateSubject(ctx, idToken, oauth.FederateSubjectOptions{
		ClientSecret: creds.ClientSecret,
		TTLSeconds:   opts.TTLSeconds,
		Timeout:      opts.Timeout,
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
// validateSubjectToken is a local sanity check on the bootstrap subject
// token. When the token has a JWT shape it rejects alg "none" tokens - the
// platform never issues them, so the shape only appears in forgeries and
// miswired test fixtures - and tokens whose exp is already in the past.
// Opaque tokens are accepted.
func validateSubjectToken(token string) error {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil
	}
	if header, err := decodeJWTSegment(parts[0]); err == nil {
		var claims struct {
			Alg string `json:"alg"`
		}
		if json.Unmarshal(header, &claims) == nil && strings.EqualFold(claims.Alg, "none") {
			return fmt.Errorf("caracal: CARACAL_BOOTSTRAP_TOKEN uses alg %q: unsigned tokens are never valid; supply a token minted by the platform", "none")
		}
	}
	payload, err := decodeJWTSegment(parts[1])
	if err != nil {
		return nil
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
		return fmt.Errorf("caracal: CARACAL_BOOTSTRAP_TOKEN is expired: refresh the bootstrap token before starting")
	}
	return nil
}

func decodeJWTSegment(segment string) ([]byte, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(segment)
	if err == nil {
		return decoded, nil
	}
	return base64.URLEncoding.DecodeString(segment)
}

// jwtAuthorityRecordID extracts the sid claim of a JWT-shaped token without verifying
// it - verification is the STS's job. Empty for opaque or malformed tokens.
func jwtAuthorityRecordID(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return ""
	}
	payload, err := decodeJWTSegment(parts[1])
	if err != nil {
		return ""
	}
	var claims struct {
		SID string `json:"sid"`
	}
	if json.Unmarshal(payload, &claims) != nil {
		return ""
	}
	return claims.SID
}

// taskMetadata folds the task option into session metadata; an explicit task
// wins over a metadata task the caller also set.
func taskMetadata(task string, metadata map[string]any) map[string]any {
	if task == "" {
		return metadata
	}
	out := make(map[string]any, len(metadata)+1)
	for k, v := range metadata {
		out[k] = v
	}
	out["task"] = task
	return out
}

// Close releases client-held state: cached application mandates and their
// in-flight mint cycles are dropped, the credential exchanger's cached
// lifecycle token is invalidated, and the sessions backing released
// application transports are terminated best-effort - any that termination
// misses retire on their own TTL. The client stays usable; the next call
// simply mints fresh state.
func (c *Caracal) Close() error {
	c.appMandateMu.Lock()
	c.appGeneration++
	inflight := make([]*appMandateCall, 0, len(c.appInflight))
	for _, call := range c.appInflight {
		inflight = append(inflight, call)
	}
	entries := make([]appMandateEntry, 0, len(c.appMandates))
	for _, entry := range c.appMandates {
		if len(entry.sessions) > 0 {
			entries = append(entries, entry)
		}
	}
	c.appMandates = nil
	c.appOrder = nil
	c.appMandateMu.Unlock()
	for _, call := range inflight {
		<-call.done
	}
	if c.exchanger != nil && len(entries) > 0 {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := c.closeSessions(ctx, entries); err != nil {
			slog.Warn("caracal: Close could not retire application-transport sessions; the coordinator TTL sweeper will", "err", err)
		}
	}
	if c.exchanger != nil {
		c.exchanger.invalidate()
	}
	return nil
}

func (c *Caracal) closeSessions(ctx context.Context, entries []appMandateEntry) error {
	zoneID, _, err := c.exchanger.identity(ctx)
	if err != nil {
		return err
	}
	boot, err := c.exchanger.mintMandate(ctx, entries[0].resourceID, []string{lifecycleScope}, "", "", mandateOptions{})
	if err != nil {
		return err
	}
	for _, entry := range entries {
		for _, id := range entry.sessions {
			if terr := TerminateSession(ctx, c.Coordinator, boot.AccessToken, zoneID, id); terr != nil && !isGone(terr) {
				slog.Warn("caracal: Close terminate failed; the coordinator TTL sweeper will retire it", "agent_session_id", id, "err", terr)
			}
		}
	}
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
	return err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.Host != ""
}

func resourceIDsFromEnv(raw string, bindings []ResourceBinding) []string {
	out := []string{}
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
		return "", fmt.Errorf("caracal: %s requires app_client_secret or app_client_secret_file", path)
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
func (c *Caracal) OnSessionStart(h LifecycleHook) func() {
	c.hookMu.Lock()
	c.nextHookID++
	id := c.nextHookID
	if c.sessionStartHooks == nil {
		c.sessionStartHooks = map[uint64]LifecycleHook{}
	}
	c.sessionStartHooks[id] = h
	c.hookMu.Unlock()
	return func() {
		c.hookMu.Lock()
		delete(c.sessionStartHooks, id)
		c.hookMu.Unlock()
	}
}

// OnSessionEnd registers a hook fired when Session unwinds a session.
func (c *Caracal) OnSessionEnd(h LifecycleHook) func() {
	c.hookMu.Lock()
	c.nextHookID++
	id := c.nextHookID
	if c.sessionEndHooks == nil {
		c.sessionEndHooks = map[uint64]LifecycleHook{}
	}
	c.sessionEndHooks[id] = h
	c.hookMu.Unlock()
	return func() {
		c.hookMu.Lock()
		delete(c.sessionEndHooks, id)
		c.hookMu.Unlock()
	}
}

// OnEvent subscribes to control-plane operation events: token exchanges (with
// cache outcome), approval waits, and coordinator calls, each carrying outcome
// and duration. Bridge them to any metrics or tracing system; a hook that
// panics is ignored and never disturbs the operation that emitted the event.
// The returned func removes the hook.
func (c *Caracal) OnEvent(h func(oauth.Event)) func() {
	c.hookMu.Lock()
	c.nextHookID++
	id := c.nextHookID
	if c.eventHooks == nil {
		c.eventHooks = map[uint64]func(oauth.Event){}
	}
	c.eventHooks[id] = h
	c.hookMu.Unlock()
	if c.Coordinator != nil {
		c.Coordinator.OnEvent = c.emitEvent
	}
	if c.exchanger != nil {
		c.exchanger.setOnEvent(c.emitEvent)
	}
	return func() {
		c.hookMu.Lock()
		delete(c.eventHooks, id)
		c.hookMu.Unlock()
	}
}

func (c *Caracal) emitEvent(event oauth.Event) {
	c.hookMu.Lock()
	hooks := make([]func(oauth.Event), 0, len(c.eventHooks))
	for _, h := range c.eventHooks {
		hooks = append(hooks, h)
	}
	c.hookMu.Unlock()
	for _, h := range hooks {
		func() {
			defer func() {
				// The observability sink must never break the operation path.
				_ = recover()
			}()
			h(event)
		}()
	}
}

func (c *Caracal) fire(hooks map[uint64]LifecycleHook, ctx context.Context, cc CaracalContext) error {
	c.hookMu.Lock()
	snapshot := make([]LifecycleHook, 0, len(hooks))
	for _, h := range hooks {
		snapshot = append(snapshot, h)
	}
	c.hookMu.Unlock()
	for _, h := range snapshot {
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
	// SubjectAuthorityRecordID anchors Coordinator attribution; it does not alone propagate the user sub to later mints.
	SubjectAuthorityRecordID string
	// SubjectAuthorityRecordToken is the federated Subject mandate proving control of SubjectAuthorityRecordID.
	SubjectAuthorityRecordToken string
	// Session to parent under; defaults to the session bound on the calling context.
	ParentSessionID string
	// What this session is for, in operator terms; recorded as metadata.task and shown wherever the session is inspected.
	Task     string
	Metadata map[string]any
	// Role labels the zone's grant policy matches (input.principal.labels); descriptive for policy and audit, never grants.
	Labels []string
	// W3C trace id (32 lowercase hex characters) to correlate the session under; generated when absent.
	TraceID string
	// Optional stable operation identifier from a queue, webhook, workflow, or
	// scheduler. Reusing it with identical inputs replays session creation;
	// changed inputs fail with a conflict. It does not suppress fn or make
	// downstream side effects exactly once. Ordinary code should omit it.
	IdempotencyKey string
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
	onStart := func(cx context.Context, cc CaracalContext) error { return c.fire(c.sessionStartHooks, cx, cc) }
	onEnd := func(cx context.Context, cc CaracalContext) error { return c.fire(c.sessionEndHooks, cx, cc) }
	subjectToken, err := c.rootToken(ctx)
	if err != nil {
		return err
	}
	zoneID, applicationID, err := c.Identity(ctx)
	if err != nil {
		return err
	}
	return Session(ctx, SessionInput{
		Coordinator:                 c.Coordinator,
		ZoneID:                      zoneID,
		ApplicationID:               applicationID,
		SubjectToken:                subjectToken,
		TokenSource:                 c.TokenSource,
		Invalidate:                  c.invalidateHook(),
		SubjectAuthorityRecordID:    o.SubjectAuthorityRecordID,
		SubjectAuthorityRecordToken: o.SubjectAuthorityRecordToken,
		ParentSessionID:             o.ParentSessionID,
		Authority:                   o.Authority,
		TTLSeconds:                  ttl,
		Metadata:                    taskMetadata(o.Task, o.Metadata),
		Labels:                      o.Labels,
		TraceID:                     o.TraceID,
		IdempotencyKey:              o.IdempotencyKey,
		OnSessionStart:              onStart,
		OnSessionEnd:                onEnd,
	}, fn)
}

// StartSessionOptions overrides defaults for a single Service call.
// HeartbeatInterval selects the lease renewal mode: zero (the default)
// derives the cadence from the server lease, a positive value fixes it, and a
// negative value disables the background renewal. OnLeaseLost fires once if
// the coordinator reports the session permanently gone.
type StartSessionOptions struct {
	Authority Authority
	// SubjectAuthorityRecordID anchors Coordinator attribution; it does not alone propagate the user sub to later mints.
	SubjectAuthorityRecordID string
	// SubjectAuthorityRecordToken is the federated Subject mandate proving control of SubjectAuthorityRecordID.
	SubjectAuthorityRecordToken string
	// Session to parent under; defaults to the session bound on the calling context.
	ParentSessionID string
	// What this session is for, in operator terms; recorded as metadata.task and shown wherever the session is inspected.
	Task     string
	Metadata map[string]any
	// Role labels the zone's grant policy matches (input.principal.labels); descriptive for policy and audit, never grants.
	Labels []string
	// W3C trace id (32 lowercase hex characters) to correlate the session under; generated when absent.
	TraceID string
	// Optional stable operation identifier; see SessionOptions.IdempotencyKey
	// for its creation-only guarantee.
	IdempotencyKey    string
	HeartbeatInterval time.Duration
	OnLeaseLost       func(error)
	OnStateChange     func(string)
}

// StartSession starts a long-lived Session and returns a handle the caller
// owns. Unlike Session, the session is not retired when a block exits: a
// background goroutine renews the lease by default and the handle is retired
// with SessionHandle.Close. Use for daemons and workers that outlive a single
// request.
func (c *Caracal) StartSession(ctx context.Context, opts ...StartSessionOptions) (*SessionHandle, error) {
	o := StartSessionOptions{}
	if len(opts) > 0 {
		o = opts[0]
	}
	onStart := func(cx context.Context, cc CaracalContext) error { return c.fire(c.sessionStartHooks, cx, cc) }
	onEnd := func(cx context.Context, cc CaracalContext) error { return c.fire(c.sessionEndHooks, cx, cc) }
	subjectToken, err := c.rootToken(ctx)
	if err != nil {
		return nil, err
	}
	zoneID, applicationID, err := c.Identity(ctx)
	if err != nil {
		return nil, err
	}
	return StartSession(ctx, StartSessionInput{
		Coordinator:                 c.Coordinator,
		ZoneID:                      zoneID,
		ApplicationID:               applicationID,
		SubjectToken:                subjectToken,
		TokenSource:                 c.TokenSource,
		Invalidate:                  c.invalidateHook(),
		SubjectAuthorityRecordID:    o.SubjectAuthorityRecordID,
		SubjectAuthorityRecordToken: o.SubjectAuthorityRecordToken,
		ParentSessionID:             o.ParentSessionID,
		Authority:                   o.Authority,
		Metadata:                    taskMetadata(o.Task, o.Metadata),
		Labels:                      o.Labels,
		TraceID:                     o.TraceID,
		IdempotencyKey:              o.IdempotencyKey,
		HeartbeatInterval:           o.HeartbeatInterval,
		OnLeaseLost:                 o.OnLeaseLost,
		OnStateChange:               o.OnStateChange,
		OnSessionStart:              onStart,
		OnSessionEnd:                onEnd,
	})
}

// DelegateOptions configures a delegation to a peer session.
type DelegateOptions struct {
	ToSessionID     string
	ToApplicationID string
	ResourceID      string
	Scopes          []string
	Constraints     *DelegationConstraints
	TTLSeconds      int
}

// Identity returns the zone and application this client acts as. Useful for
// logging and metric labels.
func (c *Caracal) Identity(ctx context.Context) (zoneID, applicationID string, err error) {
	if c.ZoneID != "" && c.ApplicationID != "" {
		return c.ZoneID, c.ApplicationID, nil
	}
	if c.exchanger == nil {
		return "", "", fmt.Errorf("caracal: Identity requires ZoneID and ApplicationID or a client-secret configuration")
	}
	return c.exchanger.identity(ctx)
}

// AttachSessionOptions configures re-attachment to a persisted service
// session. HeartbeatInterval selects the lease renewal mode exactly as in
// StartSessionOptions; OnLeaseLost fires once if the coordinator reports the
// session permanently gone.
type AttachSessionOptions struct {
	HeartbeatInterval time.Duration
	OnLeaseLost       func(error)
	OnStateChange     func(string)
}

// AttachSession re-attaches to a service session that already exists -
// typically after a process restart, using a session id the previous holder
// persisted from StartSession. The session is validated with an immediate
// lease renewal (a session the coordinator no longer holds live fails with
// *CoordinatorError), and the returned handle renews and retires it exactly
// like one from StartSession. Delegations bound by the previous holder are
// re-presented with AcceptDelegation.
func (c *Caracal) AttachSession(ctx context.Context, sessionID string, opts ...AttachSessionOptions) (*SessionHandle, error) {
	o := AttachSessionOptions{}
	if len(opts) > 0 {
		o = opts[0]
	}
	onEnd := func(cx context.Context, cc CaracalContext) error { return c.fire(c.sessionEndHooks, cx, cc) }
	zoneID, applicationID, err := c.Identity(ctx)
	if err != nil {
		return nil, err
	}
	subjectToken, err := c.rootToken(ctx)
	if err != nil {
		return nil, err
	}
	return AttachSession(ctx, AttachSessionInput{
		Coordinator:       c.Coordinator,
		ZoneID:            zoneID,
		ApplicationID:     applicationID,
		SubjectToken:      subjectToken,
		TokenSource:       c.TokenSource,
		Invalidate:        c.invalidateHook(),
		SessionID:         sessionID,
		HeartbeatInterval: o.HeartbeatInterval,
		OnLeaseLost:       o.OnLeaseLost,
		OnStateChange:     o.OnStateChange,
		OnSessionEnd:      onEnd,
	})
}

// Delegate delegates a slice of the current session's authority to a peer
// session and returns the created delegation. The caller's context is
// unchanged; hand the delegation id to the receiving session, which presents
// it with AcceptDelegation.
func (c *Caracal) Delegate(ctx context.Context, opts DelegateOptions) (Delegation, error) {
	if opts.TTLSeconds <= 0 {
		return Delegation{}, errors.New("caracal: Delegate TTLSeconds must be a positive integer")
	}
	return Delegate(ctx, DelegateInput{
		Coordinator:     c.Coordinator,
		ToSessionID:     opts.ToSessionID,
		ToApplicationID: opts.ToApplicationID,
		ResourceID:      opts.ResourceID,
		Scopes:          opts.Scopes,
		Constraints:     opts.Constraints,
		TTLSeconds:      opts.TTLSeconds,
	})
}

// RevokeDelegation revokes a Delegation issued by this application.
func (c *Caracal) RevokeDelegation(ctx context.Context, delegationID string) error {
	cur, _ := Current(ctx)
	zoneID, _, err := c.Identity(ctx)
	if err != nil {
		return err
	}
	bearer, err := contextBearer(ctx, cur)
	if err != nil {
		return err
	}
	if bearer == "" {
		bearer, err = c.rootToken(ctx)
		if err != nil {
			return err
		}
	}
	return RevokeDelegation(ctx, c.Coordinator, bearer, zoneID, delegationID)
}

// AcceptDelegationOptions configures delegation acceptance. Validate confirms
// with the coordinator that the delegation is live for the bound session
// before presenting it, at the cost of one control-plane call.
type AcceptDelegationOptions struct {
	Validate bool
}

// AcceptDelegation derives a receiver context presenting the given
// delegation and binds it: calls made under the returned context carry the
// delegation's bounded authority. Every presentation - and every rejected
// validation - reports a delegation.accept event so forensic consumers can
// correlate which workload presented which delegation on which session.
func (c *Caracal) AcceptDelegation(ctx context.Context, delegationID string, opts ...AcceptDelegationOptions) (context.Context, error) {
	cur, _ := Current(ctx)
	start := time.Now()
	emit := func(ok bool) {
		c.emitEvent(oauth.Event{
			Type:         "delegation.accept",
			Ok:           ok,
			Duration:     time.Since(start),
			DelegationID: delegationID,
			SessionID:    cur.SessionID,
		})
	}
	if len(opts) > 0 && opts[0].Validate {
		if cur.SessionID == "" {
			return nil, fmt.Errorf("caracal: AcceptDelegation validation requires an active session in context")
		}
		bearer, berr := contextBearer(ctx, cur)
		if berr != nil {
			emit(false)
			return nil, berr
		}
		inbound, err := GetInboundDelegation(ctx, c.Coordinator, bearer, cur.ZoneID, cur.SessionID, delegationID)
		if err != nil {
			emit(false)
			return nil, fmt.Errorf("caracal: AcceptDelegation: delegation %s is not live for session %s; confirm the issuer created it for this session and it has not been revoked: %w", delegationID, cur.SessionID, err)
		}
		if inbound.Status != "active" {
			emit(false)
			return nil, fmt.Errorf("caracal: AcceptDelegation: delegation %s is not live for session %s; confirm the issuer created it for this session and it has not been revoked", delegationID, cur.SessionID)
		}
	}
	out, err := AcceptDelegation(ctx, delegationID)
	if err != nil {
		return nil, err
	}
	emit(true)
	return out, nil
}

// MandateOptions carries optional mint inputs: a TTL override and the
// approval id for retrying an approval-gated mint.
type MandateOptions struct {
	TTLSeconds int
	ApprovalID string
}

type mandateOptions struct {
	MandateOptions
	OneShot bool
}

// MintMandate mints a resource mandate for the current session: a short-lived
// token audienced to resourceID and narrowed to scopes, carrying the session
// and delegation of the bound CaracalContext. The STS evaluates policy
// against that session's authority, so a narrowed child can mint only what
// its delegation allows. Results are cached per resource, scope set, and
// session identity, and refreshed before expiry. Returns the mandate token
// with its remaining lifetime.
//
// When a scope is approval-gated the mint returns
// *oauth.ApprovalRequiredError; retry with ApprovalID set to the returned
// approval id once an authenticated approver has satisfied it. Requires a
// client-secret configuration.
func (c *Caracal) MintMandate(ctx context.Context, resourceID string, scopes []string, opts ...MandateOptions) (oauth.MintedMandate, error) {
	if c.exchanger == nil {
		return oauth.MintedMandate{}, fmt.Errorf("caracal: MintMandate requires a client-secret configuration")
	}
	var o MandateOptions
	if len(opts) > 0 {
		o = opts[0]
	}
	cur, _ := Current(ctx)
	token, err := c.exchanger.mintMandate(ctx, resourceID, scopes, cur.SessionID, cur.DelegationID, mandateOptions{MandateOptions: o})
	if err != nil {
		return oauth.MintedMandate{}, lifecycleAuthorityHint(err, cur)
	}
	return oauth.MintedMandate{Token: token.AccessToken, ExpiresInSeconds: token.ExpiresIn}, nil
}

// FederateSubjectOptions configures one subject federation exchange.
type FederateSubjectOptions struct {
	TTLSeconds int
	Timeout    time.Duration
}

// FederatedSubject is a federated Subject and the mandate proving it.
type FederatedSubject struct {
	// Anchors Coordinator attribution when attached to a Session; it does not alone propagate the user sub to later mints.
	SubjectAuthorityRecordID string
	// Token is the Subject mandate used for user-facing flows; it carries no resource authority.
	Token            string
	ExpiresInSeconds int
}

// FederateSubject exchanges an end user's identity token from a zone-trusted
// external issuer for the Subject's Caracal Authority record. The returned
// SubjectAuthorityRecordID anchors governed work to that user (Session with
// SubjectAuthorityRecordID set), and the returned token is the user's own mandate for
// user-facing flows such as approval decisions. Never cached: each federation
// is an explicit identity event, recorded in the audit stream. Requires a
// client-secret configuration and a subject issuer registered on the zone.
func (c *Caracal) FederateSubject(ctx context.Context, idToken string, opts ...FederateSubjectOptions) (FederatedSubject, error) {
	if c.exchanger == nil {
		return FederatedSubject{}, fmt.Errorf("caracal: FederateSubject requires a client-secret configuration")
	}
	var o FederateSubjectOptions
	if len(opts) > 0 {
		o = opts[0]
	}
	minted, err := c.exchanger.federateSubject(ctx, idToken, o)
	if err != nil {
		return FederatedSubject{}, err
	}
	authorityRecordID := jwtAuthorityRecordID(minted.AccessToken)
	if authorityRecordID == "" {
		return FederatedSubject{}, fmt.Errorf("caracal: FederateSubject: the minted Subject mandate carries no authority record ID")
	}
	return FederatedSubject{SubjectAuthorityRecordID: authorityRecordID, Token: minted.AccessToken, ExpiresInSeconds: minted.ExpiresIn}, nil
}

// WaitForApproval long-polls an approval challenge until an approver decides
// it, it expires, or the timeout elapses. Returns the final lifecycle state:
// oauth.ApprovalApproved means retrying the mint with ApprovalID set will
// succeed; ApprovalRejected, ApprovalExpired, and ApprovalConsumed are
// terminal; ApprovalPending means the timeout elapsed with no decision and
// waiting again is safe.
func (c *Caracal) WaitForApproval(ctx context.Context, approvalID string, timeout time.Duration) (oauth.ApprovalState, error) {
	if c.exchanger == nil {
		return "", fmt.Errorf("caracal: WaitForApproval requires a client-secret configuration")
	}
	return c.exchanger.waitForApproval(ctx, approvalID, timeout)
}

// WithApproval runs an approval-gated operation end to end. fn is invoked
// once with an empty approval id; when it returns *oauth.ApprovalRequiredError
// the client long-polls the challenge and, on approval, invokes fn again with
// the approval id so the retried mint consumes the decision. Any other outcome
// (rejected, expired, consumed, or the wait timing out) returns the original
// approval error, whose ApprovalID lets the caller resume the wait later.
func WithApproval[T any](ctx context.Context, c *Caracal, timeout time.Duration, fn func(ctx context.Context, approvalID string) (T, error)) (T, error) {
	out, err := fn(ctx, "")
	if err == nil {
		return out, nil
	}
	var hold *oauth.ApprovalRequiredError
	if !errors.As(err, &hold) {
		return out, err
	}
	state, waitErr := c.WaitForApproval(ctx, hold.ApprovalID, timeout)
	if waitErr != nil {
		var zero T
		return zero, waitErr
	}
	if state != oauth.ApprovalApproved {
		return out, err
	}
	return fn(ctx, hold.ApprovalID)
}

// lifecycleAuthorityHint decorates a policy deny for a session that carries no
// delegation: under the platform decision contract, resource mandates only
// mint over a delegation, so the deny is almost always the
// lifecycle-only-authority trap. The wrap keeps the original error chain for
// errors.As while appending the remediation.
func lifecycleAuthorityHint(err error, cur CaracalContext) error {
	var denied *oauth.CaracalError
	if !errors.As(err, &denied) || denied.Code != "access_denied" {
		return err
	}
	if cur.SessionID == "" || cur.DelegationID != "" {
		return err
	}
	return fmt.Errorf("%w (hint: the bound session has no delegation, so it holds lifecycle-only authority; narrow the session with AuthorityNarrow, accept one with AcceptDelegation, or call as the application with ApplicationTransport; decision contract: https://docs.caracal.run/concepts/policy/)", err)
}

// Propagation selects which outbound hosts receive the Caracal context
// envelope. PropagationGatewayOnly keeps the caracal.* correlation ids off
// requests to hosts that are not gateway-routed, for transports that also
// talk to third parties which must not see them.
type Propagation string

const (
	PropagationAlways      Propagation = "always"
	PropagationGatewayOnly Propagation = "gateway-only"
)

// CallOptions controls explicit use of the application subject token when no
// CaracalContext is bound, and optional bearer verification at the inbound
// boundary. Verify is invoked by BindFromRequest with the inbound token and
// must return an error to reject the request; back it with the identity
// package so binding happens only after the mandate is proven. The verifier
// must return a complete authoritative claims projection.
// Scopes mints the scoped use=gateway mandate required by gateway-routed
// requests for the routed resource and bound agent identity; requires a
// client-secret configuration. Propagation defaults to
// PropagationAlways. Used by Transport and Fetch.
type CallOptions struct {
	AsApplication bool
	Verify        func(context.Context, string) (*VerifiedClaims, error)
	Scopes        []string
	ApprovalID    string
	Propagation   Propagation
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

func approvalIDOf(opts []CallOptions) string {
	if len(opts) == 0 {
		return ""
	}
	return opts[0].ApprovalID
}

func propagationOf(opts []CallOptions) Propagation {
	if len(opts) == 0 || opts[0].Propagation == "" {
		return PropagationAlways
	}
	return opts[0].Propagation
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
		if !asApplication(opts) {
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
	if opt.Verify == nil && productionEnv() {
		c.unverifiedBoundaryOnce.Do(func() {
			slog.Warn("caracal: inbound context is being bound without a Verify hook in production; the envelope is propagation-only - pass CallOptions.Verify or keep this boundary behind a verifier such as the Gateway or the identity package")
		})
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
		env.SessionID = ""
		env.DelegationID = ""
		env.ParentDelegationID = ""
		env.SubjectAuthorityRecordID = ""
		env.Hop = 0
		rootInjected = true
	} else if opt.Verify != nil {
		verified, err := opt.Verify(ctx, env.SubjectToken)
		if err != nil {
			return ctx, err
		}
		if verified == nil {
			return ctx, fmt.Errorf("caracal: BindFromRequest Verify must return complete VerifiedClaims")
		}
		claims = verified
	}
	zoneID := c.ZoneID
	applicationID := c.ApplicationID
	if claims != nil {
		if claims.ZoneID == "" || claims.ApplicationID == "" {
			return ctx, fmt.Errorf("caracal: BindFromRequest verified claims require ZoneID and ApplicationID")
		}
		if claims.Hop < 0 || claims.Hop > MaxHop {
			return ctx, fmt.Errorf("caracal: BindFromRequest verified claims Hop must be from 0 to %d", MaxHop)
		}
		zoneID = claims.ZoneID
		applicationID = claims.ApplicationID
		env.SessionID = claims.SessionID
		env.DelegationID = claims.DelegationID
		env.ParentDelegationID = claims.ParentDelegationID
		env.SubjectAuthorityRecordID = claims.SubjectAuthorityRecordID
		env.Hop = claims.Hop
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
// context envelope onto each request from its context. Gateway-routed calls
// require Scopes or an already gateway-class context token. Pass to any HTTP
// or provider SDK that accepts a custom *http.Client.
func (c *Caracal) Transport(base *http.Client, opts ...CallOptions) *http.Client {
	if base == nil {
		base = &http.Client{}
	}
	rt := base.Transport
	if rt == nil {
		rt = http.DefaultTransport
	}
	out := *base
	out.Transport = &caracalTransport{base: rt, client: c, asApplication: asApplication(opts), scopes: scopesOf(opts), approvalID: approvalIDOf(opts), propagation: propagationOf(opts)}
	out.CheckRedirect = stopGatewayRedirects(c, base.CheckRedirect)
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
// scopes across them bounded to resourceID. Authority state is cached per
// resolved identity, resource, scope set, effective labels, and mandate TTL;
// every request mints a fresh replay-protected mandate against that state.
// Requests are rewritten through the gateway.
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
	if c.GatewayURL == "" {
		return nil, fmt.Errorf("caracal: ApplicationTransport requires GatewayURL so mandates are sent only to the Gateway")
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
	out.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &out, nil
}

// GatewayRequest builds a Gateway URL and X-Caracal-Resource header for explicit resource routing.
func (c *Caracal) GatewayRequest(resourceID, path string) (GatewayTarget, error) {
	if c.GatewayURL == "" {
		return GatewayTarget{}, fmt.Errorf("caracal: GatewayRequest requires GatewayURL")
	}
	if strings.TrimSpace(resourceID) == "" {
		return GatewayTarget{}, fmt.Errorf("caracal: GatewayRequest requires resourceID")
	}
	target, err := joinGatewayPath(c.GatewayURL, path)
	if err != nil {
		return GatewayTarget{}, err
	}
	header := http.Header{}
	header.Set("X-Caracal-Resource", resourceID)
	return GatewayTarget{URL: target, Header: header}, nil
}

// FetchOptions carries the optional request inputs for Fetch. Scopes
// authorizes with a scoped resource mandate minted for the target resource
// instead of the raw subject token; requires a client-secret configuration.
type FetchOptions struct {
	ApprovalID    string
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
	return c.Transport(nil, CallOptions{AsApplication: opt.AsApplication, Scopes: opt.Scopes, ApprovalID: opt.ApprovalID}).Do(req)
}

type caracalTransport struct {
	base          http.RoundTripper
	client        *Caracal
	asApplication bool
	scopes        []string
	approvalID    string
	propagation   Propagation
}

func (t *caracalTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	cur, ok := Current(req.Context())
	if !ok && !t.asApplication {
		return nil, fmt.Errorf("caracal: Transport request has no bound CaracalContext; pass CallOptions{AsApplication: true} to call as the application's own identity")
	}
	clone := req.Clone(req.Context())
	rewritten := t.client.routeThroughGateway(clone.URL, clone.Header.Get("X-Caracal-Resource"))
	gatewayBound := rewritten != nil || t.client.targetsGateway(clone.URL)
	if t.propagation != PropagationGatewayOnly || gatewayBound {
		env := Envelope{Hop: 0}
		if ok {
			env = ToEnvelope(cur)
		}
		InjectHTTP(env, clone.Header)
	}
	if rewritten != nil {
		clone.URL = rewritten.url
		clone.Host = rewritten.url.Host
		clone.RequestURI = ""
		clone.Header.Set("X-Caracal-Resource", rewritten.resourceID)
		token, err := t.gatewayToken(req.Context(), rewritten.resourceID, cur, ok)
		if err != nil {
			return nil, err
		}
		clone.Header.Set("Authorization", "Bearer "+token)
	} else if gatewayBound {
		token, err := t.gatewayToken(req.Context(), clone.Header.Get("X-Caracal-Resource"), cur, ok)
		if err != nil {
			return nil, err
		}
		clone.Header.Set("Authorization", "Bearer "+token)
	}
	return t.base.RoundTrip(clone)
}

// gatewayToken resolves a scoped mandate when the transport carries scopes,
// or validates that an existing context token is Gateway-class.
func (t *caracalTransport) gatewayToken(ctx context.Context, resourceID string, cur CaracalContext, ok bool) (string, error) {
	if len(t.scopes) > 0 && resourceID == "" {
		return "", fmt.Errorf("caracal: Transport scopes require X-Caracal-Resource or a configured resource binding")
	}
	if len(t.scopes) > 0 && resourceID != "" {
		if t.client.exchanger == nil {
			return "", fmt.Errorf("caracal: Transport scopes require a client-secret configuration")
		}
		token, err := t.client.exchanger.mintMandate(ctx, resourceID, t.scopes, cur.SessionID, cur.DelegationID, mandateOptions{MandateOptions: MandateOptions{ApprovalID: t.approvalID}, OneShot: true})
		if err != nil {
			return "", lifecycleAuthorityHint(err, cur)
		}
		return token.AccessToken, nil
	}
	var token string
	var err error
	if !ok {
		token, err = t.client.rootToken(ctx)
	} else if cur.OwnToken && t.client.TokenSource != nil {
		token, err = t.client.TokenSource(ctx)
	} else {
		token = cur.SubjectToken
	}
	if err != nil {
		return "", err
	}
	if use := tokenUse(token); use != "" && use != "gateway" {
		return "", fmt.Errorf("caracal: Transport Gateway calls require a scoped use=gateway mandate; received use=%s; pass Scopes with a delegated session, or use ApplicationTransport for application-owned work", use)
	}
	return token, nil
}

// targetsGateway reports whether the request is inside the configured Gateway
// origin and base path, where the subject token terminates.
func (c *Caracal) targetsGateway(target *url.URL) bool {
	if c.GatewayURL == "" || target == nil {
		return false
	}
	gw, err := url.Parse(c.GatewayURL)
	if err != nil {
		return false
	}
	if !sameOrigin(target, gw) || pathContainsTraversal(target.EscapedPath()) {
		return false
	}
	base := strings.TrimRight(gw.Path, "/")
	if base == "" || base == "/" {
		return true
	}
	return target.Path == base || strings.HasPrefix(target.Path, base+"/")
}

func stopGatewayRedirects(c *Caracal, previous func(*http.Request, []*http.Request) error) func(*http.Request, []*http.Request) error {
	return func(req *http.Request, via []*http.Request) error {
		if len(via) > 0 && c.targetsGateway(via[len(via)-1].URL) {
			return http.ErrUseLastResponse
		}
		if previous != nil {
			return previous(req, via)
		}
		if len(via) >= 10 {
			return errors.New("stopped after 10 redirects")
		}
		return nil
	}
}

func tokenUse(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return ""
	}
	payload, err := decodeJWTSegment(parts[1])
	if err != nil {
		return ""
	}
	var claims struct {
		Use string `json:"use"`
	}
	if json.Unmarshal(payload, &claims) != nil {
		return ""
	}
	return claims.Use
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
	authority, err := t.client.appMandate(req.Context(), t.resourceID, t.scopes, t.labels, t.mandateTTL)
	if err != nil {
		return nil, err
	}
	token, err := t.client.exchanger.mintMandate(req.Context(), t.resourceID, t.scopes, authority.targetSessionID, authority.delegationID, mandateOptions{MandateOptions: MandateOptions{TTLSeconds: t.mandateTTL}, OneShot: true})
	if err != nil {
		return nil, err
	}
	clone := req.Clone(req.Context())
	clone.Header.Set("Authorization", "Bearer "+token.AccessToken)
	clone.Header.Set("X-Caracal-Resource", t.resourceID)
	InjectHTTP(Envelope{SessionID: authority.targetSessionID, DelegationID: authority.delegationID}, clone.Header)
	if rewritten := t.client.routeThroughGateway(clone.URL, t.resourceID); rewritten != nil {
		clone.URL = rewritten.url
		clone.Host = rewritten.url.Host
		clone.RequestURI = ""
	}
	return t.base.RoundTrip(clone)
}

type appMandateEntry struct {
	expiresAt       time.Time
	resourceID      string
	zoneID          string
	applicationID   string
	credentialKey   string
	targetSessionID string
	delegationID    string
	sessions        []string
}

type appMandateCall struct {
	done  chan struct{}
	entry appMandateEntry
	err   error
}

// appMandate returns a cached or freshly provisioned application mandate
// for the resource, scope set, labels, and TTL under the current resolved identity.
// Concurrent requests for the same key share one provisioning cycle.
func (c *Caracal) appMandate(ctx context.Context, resourceID string, scopes, labels []string, mandateTTL int) (appMandateEntry, error) {
	zoneID, applicationID, err := c.exchanger.identity(ctx)
	if err != nil {
		return appMandateEntry{}, err
	}
	sessionLabels := labels
	if len(sessionLabels) == 0 {
		sessionLabels = []string{applicationID}
	}
	generationKey, err := c.exchanger.credentialGeneration(ctx)
	if err != nil {
		return appMandateEntry{}, err
	}
	key := appMandateKey(zoneID, applicationID, generationKey, resourceID, scopes, sessionLabels, mandateTTL)
	c.appMandateMu.Lock()
	generation := c.appGeneration
	stale := []appMandateEntry{}
	for cachedKey, entry := range c.appMandates {
		if !entry.expiresAt.After(time.Now()) || entry.zoneID == zoneID && entry.applicationID == applicationID && entry.credentialKey != generationKey {
			delete(c.appMandates, cachedKey)
			c.removeAppOrder(cachedKey)
			stale = append(stale, entry)
		}
	}
	if cached, ok := c.appMandates[key]; ok && time.Until(cached.expiresAt) > appAuthorityRefreshMargin {
		c.appMandateMu.Unlock()
		for _, entry := range stale {
			c.retireAppAuthority(entry)
		}
		return cached, nil
	}
	inflightKey := strconv.FormatUint(generation, 10) + "::" + key
	if inflight, ok := c.appInflight[inflightKey]; ok {
		c.appMandateMu.Unlock()
		for _, entry := range stale {
			c.retireAppAuthority(entry)
		}
		select {
		case <-inflight.done:
			return inflight.entry, inflight.err
		case <-ctx.Done():
			return appMandateEntry{}, ctx.Err()
		}
	}
	call := &appMandateCall{done: make(chan struct{})}
	if c.appInflight == nil {
		c.appInflight = map[string]*appMandateCall{}
	}
	c.appInflight[inflightKey] = call
	if c.appProvision == nil {
		c.appProvision = make(chan struct{}, 1)
	}
	provision := c.appProvision
	c.appMandateMu.Unlock()
	for _, entry := range stale {
		c.retireAppAuthority(entry)
	}

	select {
	case provision <- struct{}{}:
	case <-ctx.Done():
		c.appMandateMu.Lock()
		delete(c.appInflight, inflightKey)
		call.err = ctx.Err()
		c.appMandateMu.Unlock()
		close(call.done)
		return appMandateEntry{}, ctx.Err()
	}
	entry, err := c.appMandateCycle(ctx, zoneID, applicationID, generationKey, resourceID, scopes, labels, mandateTTL)
	<-provision
	call.entry, call.err = entry, err
	evicted := []appMandateEntry{}
	c.appMandateMu.Lock()
	delete(c.appInflight, inflightKey)
	if err == nil {
		if generation != c.appGeneration {
			evicted = append(evicted, entry)
		} else if c.appMandates == nil {
			c.appMandates = map[string]appMandateEntry{}
		}
		if generation == c.appGeneration {
			if _, exists := c.appMandates[key]; !exists {
				c.appOrder = append(c.appOrder, key)
			}
			c.appMandates[key] = entry
		}
		if len(c.appMandates) > appAuthorityCacheCap {
			now := time.Now()
			for _, k := range append([]string(nil), c.appOrder...) {
				cached, exists := c.appMandates[k]
				if !exists {
					continue
				}
				if !cached.expiresAt.After(now) && k != key {
					delete(c.appMandates, k)
					c.removeAppOrder(k)
					evicted = append(evicted, cached)
				}
			}
			for _, k := range append([]string(nil), c.appOrder...) {
				if len(c.appMandates) <= appAuthorityCacheCap {
					break
				}
				if k != key {
					cached, exists := c.appMandates[k]
					if !exists {
						continue
					}
					delete(c.appMandates, k)
					c.removeAppOrder(k)
					evicted = append(evicted, cached)
				}
			}
		}
	}
	c.appMandateMu.Unlock()
	close(call.done)
	for _, stale := range evicted {
		c.retireAppAuthority(stale)
	}
	return entry, err
}

func (c *Caracal) removeAppOrder(key string) {
	for index, cachedKey := range c.appOrder {
		if cachedKey == key {
			c.appOrder = append(c.appOrder[:index], c.appOrder[index+1:]...)
			return
		}
	}
}

func appMandateKey(zoneID, applicationID, generation, resourceID string, scopes, labels []string, mandateTTL int) string {
	encodedLabels, _ := json.Marshal(labels)
	return zoneID + "::" + applicationID + "::" + generation + "::" + resourceID + "::" + strings.Join(scopes, " ") + "::" + string(encodedLabels) + "::" + strconv.Itoa(mandateTTL)
}

// appMandateCycle provisions one application mandate under the application's
// own identity: a lifecycle-scoped bootstrap mandate, a source and target
// session, and a delegation narrowing the requested scopes to the resource.
// Started sessions are terminated on failure; on success they back fresh
// per-request mandates and are retired by Close, eviction, or their own TTL.
func (c *Caracal) appMandateCycle(ctx context.Context, zoneID, applicationID, credentialKey, resourceID string, scopes, labels []string, mandateTTL int) (appMandateEntry, error) {
	sessionTTL := mandateTTL + appSessionTTLBuffer
	boot, err := c.exchanger.mintMandate(ctx, resourceID, []string{lifecycleScope}, "", "", mandateOptions{})
	if err != nil {
		return appMandateEntry{}, err
	}
	bootstrap := boot.AccessToken
	sessionLabels := labels
	if len(sessionLabels) == 0 {
		sessionLabels = []string{applicationID}
	}
	sessions := []string{}
	cleanup := func() {
		cleanupCtx := context.WithoutCancel(ctx)
		for _, id := range sessions {
			_ = TerminateSession(cleanupCtx, c.Coordinator, bootstrap, zoneID, id)
		}
	}
	start := func() (string, error) {
		res, err := StartCoordinatorSession(ctx, c.Coordinator, bootstrap, StartSessionRequest{
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
		sessions = append(sessions, res.SessionID)
		return res.SessionID, nil
	}
	source, err := start()
	if err != nil {
		cleanup()
		return appMandateEntry{}, err
	}
	target, err := start()
	if err != nil {
		cleanup()
		return appMandateEntry{}, err
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
		return appMandateEntry{}, err
	}
	return appMandateEntry{
		expiresAt:       time.Now().Add(time.Duration(sessionTTL) * time.Second),
		resourceID:      resourceID,
		zoneID:          zoneID,
		applicationID:   applicationID,
		credentialKey:   credentialKey,
		targetSessionID: target,
		delegationID:    edge.DelegationID,
		sessions:        sessions,
	}, nil
}

func (c *Caracal) retireAppAuthority(entry appMandateEntry) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	boot, err := c.exchanger.mintMandate(ctx, entry.resourceID, []string{lifecycleScope}, "", "", mandateOptions{})
	if err != nil {
		slog.Warn("caracal: could not retire application-transport sessions; the coordinator TTL sweeper will", "err", err)
		return
	}
	for _, id := range entry.sessions {
		if err := TerminateSession(ctx, c.Coordinator, boot.AccessToken, entry.zoneID, id); err != nil && !isGone(err) {
			slog.Warn("caracal: terminate failed; the coordinator TTL sweeper will retire it", "agent_session_id", id, "err", err)
		}
	}
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
	if pathContainsTraversal(target.EscapedPath()) {
		return nil
	}
	if c.targetsGateway(target) {
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
	if parsed.Fragment != "" {
		return "", fmt.Errorf("caracal: GatewayRequest path must not contain a fragment")
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
	// Dot segments could climb out of a base-pathed gateway once the URL
	// normalizes, so the path must arrive already resolved.
	if pathContainsTraversal(pathname) {
		return "", fmt.Errorf("caracal: GatewayRequest path must not contain dot segments")
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

func pathContainsTraversal(pathname string) bool {
	decoded := pathname
	for depth := 0; depth < 8; depth++ {
		if strings.Contains(decoded, `\`) {
			return true
		}
		for _, segment := range strings.Split(decoded, "/") {
			if segment == "." || segment == ".." {
				return true
			}
		}
		next, err := url.PathUnescape(decoded)
		if err != nil {
			return true
		}
		if next == decoded {
			return false
		}
		decoded = next
	}
	return true
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
