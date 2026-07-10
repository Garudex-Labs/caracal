// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// AdminClient: typed wrapper over the Caracal admin API and coordinator surfaces.

package admin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/garudex-labs/caracal/packages/core/go/logging"
)

const (
	defaultTimeout  = 30 * time.Second
	defaultRetries  = 3
	maxRetryAfter   = 30 * time.Second
	baseAPI         = "api"
	baseCoordinator = "coordinator"
)

// ErrCoordinatorURLNotConfigured is returned when a coordinator-backed call
// runs without CoordinatorURL configured.
var ErrCoordinatorURLNotConfigured = errors.New("coordinator_url_not_configured")

// ErrCoordinatorTokenNotConfigured is returned when a coordinator-backed call
// runs without CoordinatorToken configured.
var ErrCoordinatorTokenNotConfigured = errors.New("coordinator_token_not_configured")

// AdminAPIError is a non-2xx admin API response, carrying the HTTP status,
// the stable wire code, the redacted response body, and the target base
// ("api" or "coordinator").
type AdminAPIError struct {
	Status int
	Code   string
	Body   any
	Target string
}

func (e *AdminAPIError) Error() string {
	return fmt.Sprintf("%s (HTTP %d)", e.Code, e.Status)
}

// AdminClientOptions configures an AdminClient. Retries 0 means the default
// of 3; a negative value disables retries. CoordinatorURL and
// CoordinatorToken are required only for coordinator-backed surfaces (sessions
// and delegations).
type AdminClientOptions struct {
	APIURL           string
	AdminToken       string
	CoordinatorURL   string
	CoordinatorToken string
	HTTPClient       *http.Client
	Retries          int
	Headers          map[string]string
}

// AdminClient is an admin API client covering provisioning (zones,
// applications, resources, providers, policies, policy sets, policy
// templates, grants) and operations (authority records, sessions, audit, approvals,
// delegations) surfaces. Only idempotent (GET/HEAD) requests are retried, on
// transient statuses with jittered backoff honoring Retry-After.
type AdminClient struct {
	apiURL           string
	token            string
	coordinatorURL   string
	coordinatorToken string
	httpClient       *http.Client
	retries          int
	headers          map[string]string

	Zones               *ZonesService
	Applications        *ApplicationsService
	Resources           *ResourcesService
	Providers           *ProvidersService
	Policies            *PoliciesService
	PolicyTemplates     *PolicyTemplatesService
	PolicySets          *PolicySetsService
	Grants              *GrantsService
	SubjectIssuers      *SubjectIssuersService
	ProviderConnections *ProviderConnectionsService
	Workloads           *WorkloadsService
	AuthorityRecords    *AuthorityRecordsService
	Subjects            *SubjectsService
	Sessions            *SessionsService
	Audit               *AuditService
	AdminAudit          *AdminAuditService
	StepUpChallenges    *StepUpChallengesService
	Delegations         *DelegationsService
}

// NewAdminClient builds an AdminClient from options, trimming the trailing
// slash from the base URLs.
func NewAdminClient(opts AdminClientOptions) *AdminClient {
	httpClient := opts.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: defaultTimeout}
	}
	retries := opts.Retries
	if retries == 0 {
		retries = defaultRetries
	}
	if retries < 0 {
		retries = 0
	}
	client := &AdminClient{
		apiURL:           strings.TrimRight(opts.APIURL, "/"),
		token:            opts.AdminToken,
		coordinatorURL:   strings.TrimRight(opts.CoordinatorURL, "/"),
		coordinatorToken: opts.CoordinatorToken,
		httpClient:       httpClient,
		retries:          retries,
		headers:          opts.Headers,
	}
	client.Zones = &ZonesService{client}
	client.Applications = &ApplicationsService{client}
	client.Resources = &ResourcesService{client}
	client.Providers = &ProvidersService{client}
	client.Policies = &PoliciesService{client}
	client.PolicyTemplates = &PolicyTemplatesService{client}
	client.PolicySets = &PolicySetsService{client}
	client.Grants = &GrantsService{client}
	client.SubjectIssuers = &SubjectIssuersService{client}
	client.ProviderConnections = &ProviderConnectionsService{client}
	client.Workloads = &WorkloadsService{client}
	client.AuthorityRecords = &AuthorityRecordsService{client}
	client.Subjects = &SubjectsService{client}
	client.Sessions = &SessionsService{client}
	client.Audit = &AuditService{client}
	client.AdminAudit = &AdminAuditService{client}
	client.StepUpChallenges = &StepUpChallengesService{client}
	client.Delegations = &DelegationsService{client}
	return client
}

// WithDefaultHeaders returns a derived client sharing this client's transport
// and configuration with the given headers merged over the defaults.
func (c *AdminClient) WithDefaultHeaders(headers map[string]string) *AdminClient {
	merged := make(map[string]string, len(c.headers)+len(headers))
	for key, value := range c.headers {
		merged[key] = value
	}
	for key, value := range headers {
		merged[key] = value
	}
	return NewAdminClient(AdminClientOptions{
		APIURL:           c.apiURL,
		AdminToken:       c.token,
		CoordinatorURL:   c.coordinatorURL,
		CoordinatorToken: c.coordinatorToken,
		HTTPClient:       c.httpClient,
		Retries:          c.retries,
		Headers:          merged,
	})
}

func (c *AdminClient) do(ctx context.Context, method, path string, body any, out any, expectEmpty bool) error {
	return c.request(ctx, baseAPI, method, path, nil, body, out, expectEmpty)
}

func (c *AdminClient) request(ctx context.Context, base, method, path string, query url.Values, body any, out any, expectEmpty bool) error {
	baseURL := c.apiURL
	token := c.token
	if base == baseCoordinator {
		if c.coordinatorURL == "" {
			return ErrCoordinatorURLNotConfigured
		}
		if c.coordinatorToken == "" {
			return ErrCoordinatorTokenNotConfigured
		}
		baseURL = c.coordinatorURL
		token = c.coordinatorToken
	}
	requestURL := baseURL + path
	if len(query) > 0 {
		requestURL += "?" + query.Encode()
	}
	var payload []byte
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		payload = encoded
	}
	retries := 0
	if method == http.MethodGet || method == http.MethodHead {
		retries = c.retries
	}
	for attempt := 0; ; attempt++ {
		var reader io.Reader
		if payload != nil {
			reader = bytes.NewReader(payload)
		}
		req, err := http.NewRequestWithContext(ctx, method, requestURL, reader)
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		for key, value := range c.headers {
			req.Header.Set(key, value)
		}
		if payload != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		res, err := c.httpClient.Do(req)
		if err != nil {
			if attempt < retries {
				if waitErr := sleepFor(ctx, jitterBackoff(attempt)); waitErr != nil {
					return waitErr
				}
				continue
			}
			return err
		}
		data, readErr := io.ReadAll(res.Body)
		res.Body.Close()
		if readErr != nil {
			return readErr
		}
		if res.StatusCode >= 400 {
			if attempt < retries && shouldRetry(res.StatusCode) {
				delay, ok := retryAfterDelay(res.Header.Get("Retry-After"))
				if !ok {
					delay = jitterBackoff(attempt)
				}
				if waitErr := sleepFor(ctx, delay); waitErr != nil {
					return waitErr
				}
				continue
			}
			return apiError(res.StatusCode, data, base)
		}
		if expectEmpty || res.StatusCode == http.StatusNoContent || out == nil {
			return nil
		}
		return json.Unmarshal(data, out)
	}
}

func apiError(status int, data []byte, target string) *AdminAPIError {
	code := http.StatusText(status)
	if code == "" {
		code = "request_failed"
	}
	var parsed any = string(data)
	if len(data) == 0 {
		parsed = map[string]any{}
	} else {
		var decoded any
		if json.Unmarshal(data, &decoded) == nil {
			parsed = decoded
			if envelope, ok := decoded.(map[string]any); ok {
				if wireCode, ok := envelope["error"].(string); ok && wireCode != "" {
					code = wireCode
				}
			}
		}
	}
	return &AdminAPIError{Status: status, Code: code, Body: redactBody(parsed), Target: target}
}

func redactBody(body any) any {
	switch value := body.(type) {
	case map[string]any:
		return logging.RedactMap(value)
	case string:
		return logging.RedactString(value)
	default:
		return body
	}
}

func shouldRetry(status int) bool {
	return status == http.StatusRequestTimeout || status == http.StatusTooEarly || status == http.StatusTooManyRequests || status >= 500
}

func jitterBackoff(attempt int) time.Duration {
	base := min(time.Duration(1<<attempt)*250*time.Millisecond, 5*time.Second)
	return base/2 + rand.N(base/2)
}

func retryAfterDelay(header string) (time.Duration, bool) {
	if header == "" {
		return 0, false
	}
	if seconds, err := strconv.ParseFloat(header, 64); err == nil {
		return clampDelay(time.Duration(seconds * float64(time.Second))), true
	}
	if when, err := http.ParseTime(header); err == nil {
		return clampDelay(time.Until(when)), true
	}
	return 0, false
}

func clampDelay(delay time.Duration) time.Duration {
	return min(max(delay, 0), maxRetryAfter)
}

func sleepFor(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// Zone is the admin API zone row subset the provisioning surface reads.
type Zone struct {
	ID          string `json:"id"`
	Slug        string `json:"slug"`
	DisplayName string `json:"display_name"`
}

// Application is the admin API application row subset the provisioning
// surface reads.
type Application struct {
	ID                 string   `json:"id"`
	Name               string   `json:"name"`
	RegistrationMethod string   `json:"registration_method"`
	ExpiresAt          *string  `json:"expires_at"`
	Traits             []string `json:"traits"`
}

// Provider is the admin API credential provider row subset the provisioning
// surface reads.
type Provider struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Identifier string `json:"identifier"`
	Kind       string `json:"kind"`
}

// Resource is the admin API resource row subset the provisioning surface
// reads. Nullable columns are pointers so absence and empty stay distinct.
type Resource struct {
	ID                   string   `json:"id"`
	Name                 string   `json:"name"`
	Identifier           string   `json:"identifier"`
	Scopes               []string `json:"scopes"`
	UpstreamURL          *string  `json:"upstream_url"`
	CredentialProviderID *string  `json:"credential_provider_id"`
	OperationEnforcement *string  `json:"operation_enforcement"`
}

// Policy is the admin API policy list row.
type Policy struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// PolicyVersion is one immutable version row on a policy detail.
type PolicyVersion struct {
	ID            string `json:"id"`
	Version       int    `json:"version"`
	ContentSHA256 string `json:"content_sha256"`
}

// PolicyDetail is the admin API policy detail with its version history.
type PolicyDetail struct {
	ID       string          `json:"id"`
	Name     string          `json:"name"`
	Versions []PolicyVersion `json:"versions"`
}

// PolicyCreated is the creation result carrying the first version id.
type PolicyCreated struct {
	ID        string `json:"id"`
	VersionID string `json:"version_id"`
}

// PolicyVersionAdded is the result of appending a policy version.
type PolicyVersionAdded struct {
	VersionID string `json:"version_id"`
}

// PolicySet is the admin API policy set row.
type PolicySet struct {
	ID              string  `json:"id"`
	Name            string  `json:"name"`
	ActiveVersionID *string `json:"active_version_id"`
}

// PolicySetVersion is the result of appending a policy set version.
type PolicySetVersion struct {
	VersionID string `json:"version_id"`
}

// ZonesService covers /v1/zones.
type ZonesService struct{ client *AdminClient }

const maxListPages = 50

// listAll drains a keyset-paginated collection by following next_cursor until
// exhausted, so a list is the complete collection rather than a silently
// truncated first page. The page cap bounds the walk against a server bug that
// never terminates the cursor chain.
func listAll[T any](ctx context.Context, client *AdminClient, path, label string) ([]T, error) {
	items := []T{}
	cursor := ""
	for page := 0; page < maxListPages; page++ {
		requestPath := path
		if cursor != "" {
			requestPath += "?cursor=" + url.QueryEscape(cursor)
		}
		var out struct {
			Items      []T     `json:"items"`
			NextCursor *string `json:"next_cursor"`
		}
		if err := client.do(ctx, http.MethodGet, requestPath, nil, &out, false); err != nil {
			return nil, err
		}
		if out.Items == nil {
			return nil, errors.New(label + " response missing items")
		}
		items = append(items, out.Items...)
		if out.NextCursor == nil || *out.NextCursor == "" {
			return items, nil
		}
		cursor = *out.NextCursor
	}
	return nil, errors.New(label + " pagination did not terminate")
}

func (s *ZonesService) List(ctx context.Context) ([]Zone, error) {
	return listAll[Zone](ctx, s.client, "/v1/zones", "zones")
}

func (s *ZonesService) Get(ctx context.Context, zoneID string) (*Zone, error) {
	var out Zone
	if err := s.client.do(ctx, http.MethodGet, "/v1/zones/"+zoneID, nil, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *ZonesService) DCRStatus(ctx context.Context, zoneID string) (map[string]any, error) {
	var out map[string]any
	err := s.client.do(ctx, http.MethodGet, "/v1/zones/"+zoneID+"/dcr-status", nil, &out, false)
	return out, err
}

func (s *ZonesService) Create(ctx context.Context, body map[string]any) (*Zone, error) {
	var out Zone
	if err := s.client.do(ctx, http.MethodPost, "/v1/zones", body, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *ZonesService) Patch(ctx context.Context, zoneID string, body map[string]any) (*Zone, error) {
	var out Zone
	if err := s.client.do(ctx, http.MethodPatch, "/v1/zones/"+zoneID, body, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *ZonesService) Delete(ctx context.Context, zoneID string) error {
	return s.client.do(ctx, http.MethodDelete, "/v1/zones/"+zoneID, nil, nil, true)
}

// ApplicationsService covers /v1/zones/{zone}/applications.
type ApplicationsService struct{ client *AdminClient }

func (s *ApplicationsService) List(ctx context.Context, zoneID string) ([]Application, error) {
	return listAll[Application](ctx, s.client, "/v1/zones/"+zoneID+"/applications", "applications")
}

func (s *ApplicationsService) Get(ctx context.Context, zoneID, applicationID string) (*Application, error) {
	var out Application
	if err := s.client.do(ctx, http.MethodGet, "/v1/zones/"+zoneID+"/applications/"+applicationID, nil, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *ApplicationsService) Create(ctx context.Context, zoneID string, body map[string]any) (*Application, error) {
	var out Application
	if err := s.client.do(ctx, http.MethodPost, "/v1/zones/"+zoneID+"/applications", body, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *ApplicationsService) Patch(ctx context.Context, zoneID, applicationID string, body map[string]any) (*Application, error) {
	var out Application
	if err := s.client.do(ctx, http.MethodPatch, "/v1/zones/"+zoneID+"/applications/"+applicationID, body, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

// RotateSecret rotates the credential server-side; the response carries the
// plaintext secret and the sealed custody copy in the Secret Store is
// replaced with it.
func (s *ApplicationsService) RotateSecret(ctx context.Context, zoneID, applicationID string) (map[string]any, error) {
	var out map[string]any
	err := s.client.do(ctx, http.MethodPost, "/v1/zones/"+zoneID+"/applications/"+applicationID+"/rotate-secret", nil, &out, false)
	return out, err
}

// GetClientSecret retrieves the client secret from Secret Store custody.
// Every call is recorded in the zone audit timeline as a credential reveal.
func (s *ApplicationsService) GetClientSecret(ctx context.Context, zoneID, applicationID string) (map[string]any, error) {
	var out map[string]any
	err := s.client.do(ctx, http.MethodGet, "/v1/zones/"+zoneID+"/applications/"+applicationID+"/client-secret", nil, &out, false)
	return out, err
}

func (s *ApplicationsService) Delete(ctx context.Context, zoneID, applicationID string) error {
	return s.client.do(ctx, http.MethodDelete, "/v1/zones/"+zoneID+"/applications/"+applicationID, nil, nil, true)
}

// DCR (Dynamic Client Registration) is the sole programmatic path for minting
// short-lived self-registering client identities. Creation requires an admin
// token, the zone's dcr_enabled gate, and is rate-limited, capped per zone,
// and auto-expiring; the client secret is returned once and never retrievable
// again.
func (s *ApplicationsService) DCR(ctx context.Context, zoneID string, body map[string]any) (map[string]any, error) {
	var out map[string]any
	err := s.client.do(ctx, http.MethodPost, "/v1/zones/"+zoneID+"/applications/dcr", body, &out, false)
	return out, err
}

// ResourcesService covers /v1/zones/{zone}/resources.
type ResourcesService struct{ client *AdminClient }

func (s *ResourcesService) List(ctx context.Context, zoneID string) ([]Resource, error) {
	return listAll[Resource](ctx, s.client, "/v1/zones/"+zoneID+"/resources", "resources")
}

func (s *ResourcesService) Get(ctx context.Context, zoneID, resourceID string) (*Resource, error) {
	var out Resource
	if err := s.client.do(ctx, http.MethodGet, "/v1/zones/"+zoneID+"/resources/"+resourceID, nil, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *ResourcesService) Create(ctx context.Context, zoneID string, body map[string]any) (*Resource, error) {
	var out Resource
	if err := s.client.do(ctx, http.MethodPost, "/v1/zones/"+zoneID+"/resources", body, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *ResourcesService) Patch(ctx context.Context, zoneID, resourceID string, body map[string]any) (*Resource, error) {
	var out Resource
	if err := s.client.do(ctx, http.MethodPatch, "/v1/zones/"+zoneID+"/resources/"+resourceID, body, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *ResourcesService) Delete(ctx context.Context, zoneID, resourceID string) error {
	return s.client.do(ctx, http.MethodDelete, "/v1/zones/"+zoneID+"/resources/"+resourceID, nil, nil, true)
}

// ProvidersService covers /v1/zones/{zone}/providers.
type ProvidersService struct{ client *AdminClient }

func (s *ProvidersService) List(ctx context.Context, zoneID string) ([]Provider, error) {
	return listAll[Provider](ctx, s.client, "/v1/zones/"+zoneID+"/providers", "providers")
}

func (s *ProvidersService) Get(ctx context.Context, zoneID, providerID string) (*Provider, error) {
	var out Provider
	if err := s.client.do(ctx, http.MethodGet, "/v1/zones/"+zoneID+"/providers/"+providerID, nil, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *ProvidersService) Create(ctx context.Context, zoneID string, body map[string]any) (*Provider, error) {
	var out Provider
	if err := s.client.do(ctx, http.MethodPost, "/v1/zones/"+zoneID+"/providers", body, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *ProvidersService) Patch(ctx context.Context, zoneID, providerID string, body map[string]any) (*Provider, error) {
	var out Provider
	if err := s.client.do(ctx, http.MethodPatch, "/v1/zones/"+zoneID+"/providers/"+providerID, body, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *ProvidersService) Delete(ctx context.Context, zoneID, providerID string) error {
	return s.client.do(ctx, http.MethodDelete, "/v1/zones/"+zoneID+"/providers/"+providerID, nil, nil, true)
}

// PoliciesService covers /v1/zones/{zone}/policies and /v1/policies/validate.
type PoliciesService struct{ client *AdminClient }

func (s *PoliciesService) List(ctx context.Context, zoneID string) ([]Policy, error) {
	return listAll[Policy](ctx, s.client, "/v1/zones/"+zoneID+"/policies", "policies")
}

func (s *PoliciesService) Get(ctx context.Context, zoneID, policyID string) (*PolicyDetail, error) {
	var out PolicyDetail
	if err := s.client.do(ctx, http.MethodGet, "/v1/zones/"+zoneID+"/policies/"+policyID, nil, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *PoliciesService) Create(ctx context.Context, zoneID string, body map[string]any) (*PolicyCreated, error) {
	var out PolicyCreated
	if err := s.client.do(ctx, http.MethodPost, "/v1/zones/"+zoneID+"/policies", body, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

// Validate checks policy content without persisting it.
func (s *PoliciesService) Validate(ctx context.Context, content string) (map[string]any, error) {
	body := map[string]any{"content": content}
	var out map[string]any
	err := s.client.do(ctx, http.MethodPost, "/v1/policies/validate", body, &out, false)
	return out, err
}

// AddVersion appends an immutable content version to the policy.
func (s *PoliciesService) AddVersion(ctx context.Context, zoneID, policyID, content string) (*PolicyVersionAdded, error) {
	var out PolicyVersionAdded
	body := map[string]any{"content": content}
	if err := s.client.do(ctx, http.MethodPost, "/v1/zones/"+zoneID+"/policies/"+policyID+"/versions", body, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *PoliciesService) Delete(ctx context.Context, zoneID, policyID string) error {
	return s.client.do(ctx, http.MethodDelete, "/v1/zones/"+zoneID+"/policies/"+policyID, nil, nil, true)
}

// PolicySetsService covers /v1/zones/{zone}/policy-sets.
type PolicySetsService struct{ client *AdminClient }

func (s *PolicySetsService) List(ctx context.Context, zoneID string) ([]PolicySet, error) {
	return listAll[PolicySet](ctx, s.client, "/v1/zones/"+zoneID+"/policy-sets", "policy sets")
}

func (s *PolicySetsService) Get(ctx context.Context, zoneID, setID string) (*PolicySet, error) {
	var out PolicySet
	if err := s.client.do(ctx, http.MethodGet, "/v1/zones/"+zoneID+"/policy-sets/"+setID, nil, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

// Create makes a policy set; an empty description is omitted from the body.
func (s *PolicySetsService) Create(ctx context.Context, zoneID, name, description string) (*PolicySet, error) {
	body := map[string]any{"name": name}
	if description != "" {
		body["description"] = description
	}
	var out PolicySet
	if err := s.client.do(ctx, http.MethodPost, "/v1/zones/"+zoneID+"/policy-sets", body, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

// AddVersion appends a manifest version to the set.
func (s *PolicySetsService) AddVersion(ctx context.Context, zoneID, setID string, manifest []map[string]any) (*PolicySetVersion, error) {
	body := map[string]any{"manifest": manifest}
	var out PolicySetVersion
	if err := s.client.do(ctx, http.MethodPost, "/v1/zones/"+zoneID+"/policy-sets/"+setID+"/versions", body, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListVersions returns the set's immutable versions, newest first.
func (s *PolicySetsService) ListVersions(ctx context.Context, zoneID, setID string) ([]PolicySetVersion, error) {
	return listAll[PolicySetVersion](ctx, s.client, "/v1/zones/"+zoneID+"/policy-sets/"+setID+"/versions", "policy set versions")
}

// Simulate evaluates a set version against an input without activating it. A
// nil input is omitted from the body.
func (s *PolicySetsService) Simulate(ctx context.Context, zoneID, setID, versionID string, input map[string]any) (map[string]any, error) {
	body := map[string]any{"version_id": versionID}
	if input != nil {
		body["input"] = input
	}
	var out map[string]any
	err := s.client.do(ctx, http.MethodPost, "/v1/zones/"+zoneID+"/policy-sets/"+setID+"/simulate", body, &out, false)
	return out, err
}

// Activate promotes a set version to govern the zone.
func (s *PolicySetsService) Activate(ctx context.Context, zoneID, setID, versionID string) (map[string]any, error) {
	body := map[string]any{"version_id": versionID}
	var out map[string]any
	err := s.client.do(ctx, http.MethodPost, "/v1/zones/"+zoneID+"/policy-sets/"+setID+"/activate", body, &out, false)
	return out, err
}

// ActivationStatus reports how far an activation has propagated into the STS
// runtime. Empty versionID and outboxID are omitted so the server reports the
// currently active version.
func (s *PolicySetsService) ActivationStatus(ctx context.Context, zoneID, setID, versionID, outboxID string) (map[string]any, error) {
	path := "/v1/zones/" + zoneID + "/policy-sets/" + setID + "/activation-status"
	query := url.Values{}
	if versionID != "" {
		query.Set("version_id", versionID)
	}
	if outboxID != "" {
		query.Set("outbox_id", outboxID)
	}
	if encoded := query.Encode(); encoded != "" {
		path += "?" + encoded
	}
	var out map[string]any
	err := s.client.do(ctx, http.MethodGet, path, nil, &out, false)
	return out, err
}

func (s *PolicySetsService) Delete(ctx context.Context, zoneID, setID string) error {
	return s.client.do(ctx, http.MethodDelete, "/v1/zones/"+zoneID+"/policy-sets/"+setID, nil, nil, true)
}
