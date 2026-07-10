// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// RFC 8693 token exchange client with cache isolation and bounded retries.

package oauth

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultTimeout = 30 * time.Second
	defaultRetries = 3
)

// Client exchanges subject authority with a Caracal STS.
type Client struct {
	stsURL        string
	zoneID        string
	applicationID string
	cache         TokenCache
	httpClient    *http.Client
	mu            sync.Mutex
	inflight      map[string]*exchangeCall
	// OnEvent is the observability sink; each completed exchange and approval
	// wait reports here. Panics inside the sink never reach the caller.
	OnEvent func(Event)
}

type exchangeCall struct {
	done  chan struct{}
	token TokenExchangeResponse
	err   error
}

type stsErrorResponse struct {
	Error              string `json:"error"`
	ErrorDescription   string `json:"error_description"`
	ChallengeID        string `json:"challenge_id"`
	State              string `json:"state"`
	Tier               string `json:"tier"`
	Binding            string `json:"binding"`
	ChallengeExpiresAt string `json:"challenge_expires_at"`
	RequestID          string `json:"requestId"`
}

type stsSuccessResponse struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
	ExpiresIn   int    `json:"expires_in"`
}

// NewClient returns a token exchange client.
func NewClient(stsURL, zoneID, applicationID string, cache TokenCache) *Client {
	if cache == nil {
		cache = MustInMemoryTokenCache(10000)
	}
	return &Client{
		stsURL:        strings.TrimRight(stsURL, "/"),
		zoneID:        zoneID,
		applicationID: applicationID,
		cache:         cache,
		httpClient:    http.DefaultClient,
		inflight:      map[string]*exchangeCall{},
	}
}

// SetHTTPClient sets a custom HTTP client for the token exchange client.
func (c *Client) SetHTTPClient(client *http.Client) {
	if client != nil {
		c.mu.Lock()
		c.httpClient = client
		c.mu.Unlock()
	}
}

func (c *Client) emit(event Event) {
	if c.OnEvent == nil {
		return
	}
	defer func() {
		// The observability sink must never break the token path.
		_ = recover()
	}()
	c.OnEvent(event)
}

// Invalidate drops every cached token derived by this client. In-flight exchanges are not canceled.
func (c *Client) Invalidate() {
	c.cache.Clear()
}

// Exchange performs RFC 8693 token exchange or returns a safe cached response.
func (c *Client) Exchange(ctx context.Context, subjectToken, resource string, opts ExchangeOptions) (TokenExchangeResponse, error) {
	return c.ExchangeResources(ctx, subjectToken, []string{resource}, opts)
}

// ExchangeResources performs token exchange for one or more resources.
func (c *Client) ExchangeResources(ctx context.Context, subjectToken string, resources []string, opts ExchangeOptions) (TokenExchangeResponse, error) {
	timeout := timeoutFromOptions(opts)
	preflightWindow := int64(timeout/time.Second) + 30
	oneShot := opts.OneShot || opts.ChallengeID != ""
	cacheSubject := c.cacheSubject(subjectToken, opts)
	cacheResource := c.cacheResource(resources, opts)
	eventResources := resourceList(resources)
	eventScopes := strings.Fields(normalizedScopes(opts.Scopes))
	if !oneShot && !opts.ForceRefresh {
		if cached, ok := c.cache.Get(cacheSubject, cacheResource); ok {
			// The preflight window is capped at half the token lifetime so
			// short-lived tokens are still served from cache instead of
			// re-exchanged on every call.
			window := min(preflightWindow, int64(cached.ExpiresIn)/2)
			if cached.IssuedAt+int64(cached.ExpiresIn)-time.Now().Unix() > window {
				c.emit(Event{Type: "token.exchange", Ok: true, Cached: true, Resources: eventResources, Scopes: eventScopes})
				return cached, nil
			}
		}
	}

	if oneShot {
		start := time.Now()
		token, err := c.doExchange(ctx, subjectToken, eventResources, opts, false, start.Add(timeout))
		event := Event{Type: "token.exchange", Ok: err == nil, Duration: time.Since(start), Resources: eventResources, Scopes: eventScopes}
		if err != nil {
			var caracalErr *CaracalError
			var approvalErr *ApprovalRequiredError
			if errors.As(err, &caracalErr) {
				event.Code, event.Status = caracalErr.Code, caracalErr.HTTPStatus
			} else if errors.As(err, &approvalErr) {
				event.Code, event.Status = "interaction_required", approvalErr.HTTPStatus
			}
		}
		c.emit(event)
		return token, err
	}

	inflightKey := cacheSubject + "::" + cacheResource
	call, ownsCall := c.beginInflight(inflightKey)
	if !ownsCall {
		select {
		case <-call.done:
			return call.token, call.err
		case <-ctx.Done():
			return TokenExchangeResponse{}, ctx.Err()
		}
	}
	defer c.clearInflight(inflightKey, call)
	defer close(call.done)

	start := time.Now()
	call.token, call.err = c.doExchange(ctx, subjectToken, eventResources, opts, false, start.Add(timeout))
	event := Event{Type: "token.exchange", Ok: call.err == nil, Duration: time.Since(start), Resources: eventResources, Scopes: eventScopes}
	if call.err == nil {
		c.cache.Set(cacheSubject, cacheResource, call.token)
	} else {
		var caracalErr *CaracalError
		var interactionErr *ApprovalRequiredError
		if errors.As(call.err, &caracalErr) {
			event.Code = caracalErr.Code
			event.Status = caracalErr.HTTPStatus
		} else if errors.As(call.err, &interactionErr) {
			event.Code = "interaction_required"
			event.Status = interactionErr.HTTPStatus
		}
	}
	c.emit(event)
	return call.token, call.err
}

func (c *Client) beginInflight(key string) (*exchangeCall, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if call, ok := c.inflight[key]; ok {
		return call, false
	}
	call := &exchangeCall{done: make(chan struct{})}
	c.inflight[key] = call
	return call, true
}

func (c *Client) clearInflight(key string, call *exchangeCall) {
	c.mu.Lock()
	if c.inflight[key] == call {
		delete(c.inflight, key)
	}
	c.mu.Unlock()
}

func (c *Client) cacheSubject(subjectToken string, opts ExchangeOptions) string {
	parts := []string{
		c.zoneID + "::" + c.applicationID,
		hashSecret(subjectToken),
		opts.AuthorityRecordID,
		opts.SessionID,
		opts.DelegationID,
		c.authContext(opts),
		hashSecret(opts.ClientAssertion),
	}
	return strings.Join(parts, "::")
}

func (c *Client) cacheResource(resources []string, opts ExchangeOptions) string {
	return strings.Join([]string{strings.Join(resourceList(resources), " "), normalizedScopes(opts.Scopes), ttlString(opts.TTLSeconds)}, "::")
}

func (c *Client) authContext(opts ExchangeOptions) string {
	secret := ""
	if opts.ClientSecret != "" {
		secret = "secret:" + hashSecret(opts.ClientSecret)
	}
	assertion := ""
	if opts.ClientAssertion != "" {
		assertion = "assertion"
	}
	return strings.Join([]string{secret, assertion, opts.ClientAssertionType}, ":")
}

func (c *Client) doExchange(ctx context.Context, subjectToken string, resources []string, opts ExchangeOptions, isRetry bool, deadline time.Time) (TokenExchangeResponse, error) {
	form := url.Values{
		"grant_type":     {"urn:ietf:params:oauth:grant-type:token-exchange"},
		"zone_id":        {c.zoneID},
		"application_id": {c.applicationID},
	}
	if subjectToken != "" {
		form.Set("subject_token", subjectToken)
		form.Set("subject_token_type", "urn:ietf:params:oauth:token-type:access_token")
	}
	for _, resource := range resources {
		form.Add("resource", resource)
	}
	setFormValue(form, "client_secret", opts.ClientSecret)
	setFormValue(form, "client_assertion", opts.ClientAssertion)
	setFormValue(form, "client_assertion_type", opts.ClientAssertionType)
	setFormValue(form, "session_id", opts.AuthorityRecordID)
	setFormValue(form, "agent_session_id", opts.SessionID)
	setFormValue(form, "delegation_edge_id", opts.DelegationID)
	if scope := normalizedScopes(opts.Scopes); scope != "" {
		form.Set("scope", scope)
	}
	if opts.TTLSeconds > 0 {
		form.Set("ttl_seconds", ttlString(opts.TTLSeconds))
	}
	setFormValue(form, "challenge_id", opts.ChallengeID)

	var res *http.Response
	var err error
	retries := opts.Retries
	if retries == 0 {
		retries = defaultRetries
	}
	for attempt := 0; attempt <= retries; attempt++ {
		if !time.Now().Before(deadline) {
			return TokenExchangeResponse{}, fmt.Errorf("STS request timed out")
		}
		reqCtx, cancel := context.WithDeadline(ctx, deadline)
		req, reqErr := http.NewRequestWithContext(reqCtx, http.MethodPost, c.stsURL+"/oauth/2/token", strings.NewReader(form.Encode()))
		if reqErr != nil {
			cancel()
			return TokenExchangeResponse{}, reqErr
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		c.mu.Lock()
		client := c.httpClient
		c.mu.Unlock()
		res, err = client.Do(req)
		cancel()
		if err == nil && (!transientStatus(res.StatusCode) || attempt == retries) {
			break
		}
		if res != nil {
			res.Body.Close()
		}
		if attempt == retries {
			break
		}
		if sleepErr := sleepWithinDeadline(ctx, retryDelay(res, attempt), deadline); sleepErr != nil {
			return TokenExchangeResponse{}, sleepErr
		}
	}
	if err != nil {
		return TokenExchangeResponse{}, err
	}
	defer res.Body.Close()

	if res.StatusCode < 200 || res.StatusCode >= 300 {
		var body stsErrorResponse
		if decodeErr := json.NewDecoder(io.LimitReader(res.Body, 64*1024)).Decode(&body); decodeErr != nil && decodeErr != io.EOF {
			return TokenExchangeResponse{}, fmt.Errorf("STS error %d: invalid error response", res.StatusCode)
		}
		if body.Error == "interaction_required" {
			msg := body.ErrorDescription
			if msg == "" {
				msg = "Approval required"
			}
			return TokenExchangeResponse{}, &ApprovalRequiredError{
				Message:    msg,
				ApprovalID: body.ChallengeID,
				Resource:   firstResource(resources),
				State:      body.State,
				Tier:       body.Tier,
				Binding:    body.Binding,
				ExpiresAt:  body.ChallengeExpiresAt,
				RequestID:  body.RequestID,
				HTTPStatus: res.StatusCode,
			}
		}
		if res.StatusCode == http.StatusUnauthorized && !isRetry {
			opts.Retries = 0
			return c.doExchange(ctx, subjectToken, resources, opts, true, deadline)
		}
		code := body.Error
		if code == "" {
			code = "error"
		}
		return TokenExchangeResponse{}, &CaracalError{
			Code:        code,
			Description: body.ErrorDescription,
			RequestID:   body.RequestID,
			HTTPStatus:  res.StatusCode,
		}
	}
	if !jsonResponse(res.Header.Get("Content-Type")) {
		return TokenExchangeResponse{}, fmt.Errorf("STS response invalid: expected application/json")
	}
	var body stsSuccessResponse
	if err := json.NewDecoder(io.LimitReader(res.Body, 64*1024)).Decode(&body); err != nil {
		return TokenExchangeResponse{}, err
	}
	return validateSuccess(body)
}

func validateSuccess(body stsSuccessResponse) (TokenExchangeResponse, error) {
	if body.AccessToken == "" {
		return TokenExchangeResponse{}, fmt.Errorf("STS response invalid: access_token is required")
	}
	if body.TokenType != "" && body.TokenType != "Bearer" {
		return TokenExchangeResponse{}, fmt.Errorf("STS response invalid: token_type must be Bearer")
	}
	if body.ExpiresIn <= 0 {
		return TokenExchangeResponse{}, fmt.Errorf("STS response invalid: expires_in must be a positive integer")
	}
	return TokenExchangeResponse{AccessToken: body.AccessToken, TokenType: "Bearer", ExpiresIn: body.ExpiresIn, IssuedAt: time.Now().Unix()}, nil
}

// WaitForApproval long-polls an approval until an approver decides it, it
// expires, or the timeout elapses. Returns the final lifecycle state: ApprovalApproved
// means a retry of Exchange with ChallengeID will mint; ApprovalRejected and
// ApprovalExpired are terminal; ApprovalPending means the timeout elapsed with no
// decision and waiting again is safe.
func (c *Client) WaitForApproval(ctx context.Context, approvalID string, timeout time.Duration) (ApprovalState, error) {
	if approvalID == "" {
		return "", errors.New("WaitForApproval requires an approval id")
	}
	start := time.Now()
	finish := func(state ApprovalState, err error) (ApprovalState, error) {
		c.emit(Event{Type: "approval.wait", Ok: err == nil, Duration: time.Since(start), ApprovalID: approvalID, State: string(state)})
		return state, err
	}
	deadline := start.Add(timeout)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return finish(ApprovalPending, nil)
		}
		wait := int(remaining / time.Second)
		if wait > 25 {
			wait = 25
		}
		if wait < 1 {
			wait = 1
		}
		reqCtx, cancel := context.WithDeadline(ctx, deadline)
		req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, fmt.Sprintf("%s/step-up/%s?wait=%d", c.stsURL, url.PathEscape(approvalID), wait), nil)
		if err != nil {
			cancel()
			return finish("", err)
		}
		c.mu.Lock()
		client := c.httpClient
		c.mu.Unlock()
		res, err := client.Do(req)
		cancel()
		if err != nil {
			return finish("", err)
		}
		var body struct {
			State string `json:"state"`
		}
		decodeErr := json.NewDecoder(io.LimitReader(res.Body, 64*1024)).Decode(&body)
		res.Body.Close()
		if res.StatusCode != http.StatusOK {
			return finish("", fmt.Errorf("step-up status failed: %d", res.StatusCode))
		}
		if decodeErr != nil {
			return finish("", decodeErr)
		}
		if body.State != "" && body.State != "pending" {
			state, stateErr := approvalState(body.State)
			if stateErr != nil {
				return finish("", stateErr)
			}
			return finish(state, nil)
		}
	}
}

func setFormValue(form url.Values, name, value string) {
	if value != "" {
		form.Set(name, value)
	}
}

// FederateSubjectOptions shape the federation exchange.
type FederateSubjectOptions struct {
	ClientSecret string
	TTLSeconds   int
	Timeout      time.Duration
}

// FederateSubject exchanges an end user's identity token from a zone-trusted
// external issuer for a Caracal Subject authority record. The application
// authenticates itself with its client secret and relays the token verbatim;
// the minted record is the Subject's identity anchor and carries no resource
// authority. Never cached: each federation is an explicit identity event.
func (c *Client) FederateSubject(ctx context.Context, idToken string, opts FederateSubjectOptions) (TokenExchangeResponse, error) {
	if idToken == "" {
		return TokenExchangeResponse{}, errors.New("FederateSubject requires the end user identity token")
	}
	form := url.Values{
		"grant_type":         {"urn:ietf:params:oauth:grant-type:token-exchange"},
		"subject_token":      {idToken},
		"subject_token_type": {"urn:ietf:params:oauth:token-type:id_token"},
		"zone_id":            {c.zoneID},
		"application_id":     {c.applicationID},
	}
	setFormValue(form, "client_secret", opts.ClientSecret)
	if opts.TTLSeconds > 0 {
		form.Set("ttl_seconds", strconv.Itoa(opts.TTLSeconds))
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, c.stsURL+"/oauth/2/token", strings.NewReader(form.Encode()))
	if err != nil {
		return TokenExchangeResponse{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	c.mu.Lock()
	client := c.httpClient
	c.mu.Unlock()
	res, err := client.Do(req)
	if err != nil {
		return TokenExchangeResponse{}, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		var body stsErrorResponse
		if decodeErr := json.NewDecoder(io.LimitReader(res.Body, 64*1024)).Decode(&body); decodeErr != nil && decodeErr != io.EOF {
			return TokenExchangeResponse{}, fmt.Errorf("STS error %d: invalid error response", res.StatusCode)
		}
		code := body.Error
		if code == "" {
			code = "federation_failed"
		}
		return TokenExchangeResponse{}, &CaracalError{Code: code, Description: body.ErrorDescription, RequestID: body.RequestID, HTTPStatus: res.StatusCode}
	}
	var body stsSuccessResponse
	if err := json.NewDecoder(io.LimitReader(res.Body, 64*1024)).Decode(&body); err != nil {
		return TokenExchangeResponse{}, err
	}
	return validateSuccess(body)
}

// DecideApprovalInput carries an end user's decision on a subject-reserved
// approval hold.
type DecideApprovalInput struct {
	SubjectToken string
	ApprovalID   string
	Binding      string
	Decision     string
	Reason       string
	Timeout      time.Duration
}

// DecideApproval posts an end user's decision on a subject-reserved approval
// hold. The subject token is the user's federated session mandate, and the
// binding must echo the hold exactly - a prompt that does not know the held
// resource and scope set cannot decide it.
func (c *Client) DecideApproval(ctx context.Context, input DecideApprovalInput) error {
	if input.SubjectToken == "" || input.ApprovalID == "" || input.Binding == "" {
		return errors.New("DecideApproval requires SubjectToken, ApprovalID, and Binding")
	}
	payload := map[string]string{"decision": input.Decision, "binding": input.Binding}
	if input.Reason != "" {
		payload["reason"] = input.Reason
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	timeout := input.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost,
		fmt.Sprintf("%s/step-up/%s/decision", c.stsURL, url.PathEscape(input.ApprovalID)), strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+input.SubjectToken)
	c.mu.Lock()
	client := c.httpClient
	c.mu.Unlock()
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		var errBody stsErrorResponse
		if decodeErr := json.NewDecoder(io.LimitReader(res.Body, 64*1024)).Decode(&errBody); decodeErr != nil && decodeErr != io.EOF {
			return fmt.Errorf("approval decision failed: %d", res.StatusCode)
		}
		code := errBody.Error
		if code == "" {
			code = "decision_failed"
		}
		return &CaracalError{Code: code, Description: errBody.ErrorDescription, RequestID: errBody.RequestID, HTTPStatus: res.StatusCode}
	}
	return nil
}

func normalizedScopes(scopes []string) string {
	seen := map[string]struct{}{}
	out := []string{}
	for _, scope := range scopes {
		if _, ok := seen[scope]; ok {
			continue
		}
		seen[scope] = struct{}{}
		out = append(out, scope)
	}
	sort.Strings(out)
	return strings.Join(out, " ")
}

func resourceList(resources []string) []string {
	out := []string{}
	for _, resource := range resources {
		resource = strings.TrimSpace(resource)
		if resource != "" {
			out = append(out, resource)
		}
	}
	return out
}

func firstResource(resources []string) string {
	if len(resources) == 0 {
		return ""
	}
	return resources[0]
}

func transientStatus(status int) bool {
	return status == http.StatusRequestTimeout || status == http.StatusTooEarly || status == http.StatusTooManyRequests || (status >= 500 && status < 600)
}

func retryDelay(res *http.Response, attempt int) time.Duration {
	if res != nil {
		if raw := res.Header.Get("Retry-After"); raw != "" {
			if seconds, err := time.ParseDuration(raw + "s"); err == nil {
				return seconds
			}
			if when, err := http.ParseTime(raw); err == nil {
				return time.Until(when)
			}
		}
	}
	delay := time.Duration(250*(1<<attempt)) * time.Millisecond
	if delay > 5*time.Second {
		delay = 5 * time.Second
	}
	half := delay / 2
	return half + rand.N(half+1)
}

func sleepWithinDeadline(ctx context.Context, delay time.Duration, deadline time.Time) error {
	if delay < 0 {
		delay = 0
	}
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return fmt.Errorf("STS request timed out")
	}
	if delay > remaining {
		delay = remaining
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func jsonResponse(contentType string) bool {
	if contentType == "" {
		return true
	}
	mediaType := strings.ToLower(strings.Split(contentType, ";")[0])
	return mediaType == "application/json" || strings.HasSuffix(mediaType, "+json")
}

func timeoutFromOptions(opts ExchangeOptions) time.Duration {
	if opts.TimeoutMillis <= 0 {
		return defaultTimeout
	}
	return time.Duration(opts.TimeoutMillis) * time.Millisecond
}

func ttlString(ttl int) string {
	if ttl <= 0 {
		return ""
	}
	return fmt.Sprintf("%d", ttl)
}

// hashSecret derives a cache-key component from a secret with a keyed MAC so
// the component cannot be recomputed from a known token by an observer.
func hashSecret(value string) string {
	if value == "" {
		return ""
	}
	mac := hmac.New(sha256.New, cacheKeySecret)
	mac.Write([]byte(value))
	return hex.EncodeToString(mac.Sum(nil))
}
