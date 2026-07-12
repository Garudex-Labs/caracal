// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// MCP reverse proxy: per-request STS exchange, SSRF-guarded forwarding, streaming-aware response copy.

package internal

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	sharederr "github.com/garudex-labs/caracal/packages/core/go/errors"
	corests "github.com/garudex-labs/caracal/packages/core/go/sts"
	"github.com/rs/zerolog"
)

// preflightWindow gives STS time to mint a fresh token before the inbound bearer expires.
// The window is consulted via an unverified JWT peek, so it is a UX optimisation only: // signature validity is established at STS exchange and at the upstream resource.
const preflightWindow = 35 * time.Second

const maxBearerBytes = 4096

const (
	stsCircuitFailureLimit = 3
	stsCircuitOpenFor      = 10 * time.Second
)

// proxy implements the gateway's reverse-proxy handler.
type proxy struct {
	sts          *stsClient
	jwks         tokenVerifier
	guard        *upstreamGuard
	client       *http.Client
	writeTimeout time.Duration
	streamIdle   time.Duration
	trustProxy   bool
	log          zerolog.Logger
	maxBytes     int64
	tracker      replayTracker
	revocations  revocationChecker
	metrics      *GatewayMetrics
	audit        auditEmitter
	circuitMu    sync.Mutex
	stsFailures  int
	stsOpenUntil time.Time
}

type tokenVerifier interface {
	Verify(ctx context.Context, zoneID, token string) error
}

type replayTracker interface {
	Check(ctx context.Context, jti string, exp time.Time, use, requestID, resource, zoneID, clientID, subjectFP string) bool
}

type revocationChecker interface {
	IsRevoked(anchorID string) bool
	IsSessionRevoked(sessionID string) bool
	IsDelegationRevoked(delegationEdgeID string) bool
	SnapshotFresh(now time.Time) bool
}

type tokenRevocationAnchors struct {
	AuthorityRecordID     string
	RootAuthorityRecordID string
	SessionID             string
	DelegationEdgeID      string
}

func newProxy(sts *stsClient, jwks tokenVerifier, guard *upstreamGuard, log zerolog.Logger, maxBytes int64, upstreamTimeout time.Duration, tracker replayTracker, revocations revocationChecker, metrics *GatewayMetrics, audit auditEmitter) *proxy {
	if jwks == nil {
		panic("proxy requires jwks verifier")
	}
	if tracker == nil {
		panic("proxy requires jti tracker")
	}
	if revocations == nil {
		panic("proxy requires revocation checker")
	}
	transport := &http.Transport{
		DialContext:           guard.SafeDialContext(5*time.Second, 30*time.Second),
		MaxIdleConns:          200,
		MaxIdleConnsPerHost:   100,
		MaxConnsPerHost:       200,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   5 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		ResponseHeaderTimeout: upstreamTimeout,
		ForceAttemptHTTP2:     true,
	}
	return &proxy{
		sts:          sts,
		jwks:         jwks,
		guard:        guard,
		client:       &http.Client{Transport: transport, CheckRedirect: noRedirect},
		writeTimeout: defaultWriteTimeout,
		streamIdle:   defaultWriteTimeout,
		log:          log,
		maxBytes:     maxBytes,
		tracker:      tracker,
		revocations:  revocations,
		metrics:      metrics,
		audit:        audit,
	}
}

func (p *proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	requestID := requestIDFromContext(r.Context())
	logger := p.log.With().Str("request_id", requestID).Str("client_ip", clientIP(r.RemoteAddr)).Logger()
	p.metrics.RequestsTotal.Add(1)
	if !p.revocations.SnapshotFresh(time.Now()) {
		writeErr(w, requestID, http.StatusServiceUnavailable, sharederr.STSUnavailable, "revocation state unavailable")
		p.metrics.RequestsDenied.Add(1)
		p.metrics.DenialsRevocationStale.Add(1)
		logger.Warn().Int("status", http.StatusServiceUnavailable).Msg("denied: revocation snapshot stale")
		return
	}

	bearer := extractBearer(r.Header.Get("Authorization"))
	if bearer == "" {
		writeErr(w, requestID, http.StatusUnauthorized, sharederr.InvalidToken, "missing bearer token")
		p.metrics.RequestsDenied.Add(1)
		p.metrics.DenialsMissingAuth.Add(1)
		logger.Info().Int("status", http.StatusUnauthorized).Msg("denied: missing bearer")
		return
	}
	if len(bearer) > maxBearerBytes {
		writeErr(w, requestID, http.StatusUnauthorized, sharederr.InvalidToken, "bearer token too large")
		p.metrics.RequestsDenied.Add(1)
		p.metrics.DenialsBadBearer.Add(1)
		logger.Info().Int("status", http.StatusUnauthorized).Msg("denied: bearer too large")
		return
	}

	exp, ok := jwtExp(bearer)
	if !ok {
		writeErr(w, requestID, http.StatusUnauthorized, sharederr.InvalidToken, "malformed bearer token")
		p.metrics.RequestsDenied.Add(1)
		p.metrics.DenialsBadBearer.Add(1)
		logger.Info().Int("status", http.StatusUnauthorized).Msg("denied: malformed bearer")
		return
	}
	if time.Until(exp) < preflightWindow {
		writeErr(w, requestID, http.StatusUnauthorized, sharederr.CredentialExpired, "credential expiring within pre-flight window")
		p.metrics.RequestsDenied.Add(1)
		p.metrics.DenialsExpiring.Add(1)
		logger.Info().Int("status", http.StatusUnauthorized).Msg("denied: bearer near expiry")
		return
	}

	if r.Header.Get("X-Caracal-Client-ID") != "" {
		writeErr(w, requestID, http.StatusBadRequest, sharederr.InvalidToken, "client identity derives from the bearer token")
		p.metrics.RequestsDenied.Add(1)
		p.metrics.DenialsBadRouting.Add(1)
		logger.Info().Int("status", http.StatusBadRequest).Msg("denied: client id header not honored")
		return
	}
	resource := strings.TrimSpace(r.Header.Get("X-Caracal-Resource"))
	if resource == "" {
		writeErr(w, requestID, http.StatusBadRequest, sharederr.InvalidToken, "missing routing headers")
		p.metrics.RequestsDenied.Add(1)
		p.metrics.DenialsBadRouting.Add(1)
		logger.Info().Int("status", http.StatusBadRequest).Msg("denied: missing routing headers")
		return
	}
	zoneID := jwtZoneID(bearer)
	if zoneID == "" {
		writeErr(w, requestID, http.StatusUnauthorized, sharederr.InvalidToken, "missing token zone")
		p.metrics.RequestsDenied.Add(1)
		p.metrics.DenialsBadRouting.Add(1)
		logger.Info().Int("status", http.StatusUnauthorized).Msg("denied: bearer missing zone")
		return
	}
	// The caller's application identity is the client_id claim STS stamped into the
	// mandate at mint. The peek is unverified here; nothing acts on it until the
	// JWKS signature check below proves the token is STS-issued.
	clientID := jwtClientID(bearer)
	if clientID == "" {
		writeErr(w, requestID, http.StatusUnauthorized, sharederr.InvalidToken, "missing token client")
		p.metrics.RequestsDenied.Add(1)
		p.metrics.DenialsBadRouting.Add(1)
		logger.Info().Int("status", http.StatusUnauthorized).Msg("denied: bearer missing client")
		return
	}

	if pathContainsTraversal(r.URL.Path) {
		writeErr(w, requestID, http.StatusBadRequest, sharederr.InvalidToken, "path traversal not permitted")
		p.metrics.RequestsDenied.Add(1)
		p.metrics.DenialsPathTrav.Add(1)
		logger.Info().Int("status", http.StatusBadRequest).Str("path", r.URL.Path).Msg("denied: path traversal")
		return
	}

	logger = logger.With().
		Str("zone_id", zoneID).
		Str("application_id", clientID).
		Str("resource", resource).
		Str("subject_fp", tokenFingerprint(bearer)).
		Logger()

	if err := p.jwks.Verify(r.Context(), zoneID, bearer); err != nil {
		writeErr(w, requestID, http.StatusUnauthorized, sharederr.InvalidToken, "bearer signature invalid")
		p.metrics.RequestsDenied.Add(1)
		p.metrics.DenialsSignature.Add(1)
		logger.Info().Err(err).Int("status", http.StatusUnauthorized).Msg("denied: bearer signature")
		return
	}

	if !p.tracker.Check(r.Context(), jwtJTI(bearer), exp, jwtUse(bearer), requestID, resource, zoneID, clientID, tokenFingerprint(bearer)) {
		writeErr(w, requestID, http.StatusUnauthorized, sharederr.InvalidToken, "token replay detected")
		p.metrics.RequestsDenied.Add(1)
		p.metrics.DenialsJTIReplay.Add(1)
		logger.Info().Int("status", http.StatusUnauthorized).Msg("denied: jti replay")
		return
	}

	revocationAnchors := tokenRevocationAnchors{
		AuthorityRecordID:     jwtAuthorityRecordID(bearer),
		RootAuthorityRecordID: jwtRootAuthorityRecordID(bearer),
		SessionID:             jwtSessionID(bearer),
		DelegationEdgeID:      jwtDelegationEdgeID(bearer),
	}
	if p.revocations.IsRevoked(revocationAnchors.AuthorityRecordID) ||
		p.revocations.IsRevoked(revocationAnchors.RootAuthorityRecordID) ||
		p.revocations.IsSessionRevoked(revocationAnchors.SessionID) ||
		p.revocations.IsDelegationRevoked(revocationAnchors.DelegationEdgeID) {
		writeErr(w, requestID, http.StatusUnauthorized, sharederr.InvalidToken, "session revoked")
		p.metrics.RequestsDenied.Add(1)
		p.metrics.DenialsRevoked.Add(1)
		logger.Info().
			Int("status", http.StatusUnauthorized).
			Str("sid", revocationAnchors.AuthorityRecordID).
			Str("root_sid", revocationAnchors.RootAuthorityRecordID).
			Str("agent_session_id", revocationAnchors.SessionID).
			Str("delegation_edge_id", revocationAnchors.DelegationEdgeID).
			Msg("denied: session revoked")
		return
	}

	if p.stsCircuitOpen() {
		writeErr(w, requestID, http.StatusServiceUnavailable, sharederr.STSUnavailable, "sts unavailable")
		p.metrics.RequestsDenied.Add(1)
		p.metrics.STSExchangeErrors.Add(1)
		p.metrics.STSCircuitFastFail.Add(1)
		logger.Warn().Int("status", http.StatusServiceUnavailable).Msg("sts circuit open")
		return
	}
	stsCtx, cancel := context.WithTimeout(r.Context(), p.sts.client.Timeout)
	out := p.sts.Exchange(stsCtx, bearer, zoneID, clientID, resource, r.Method, r.URL.Path, requestID)
	cancel()
	p.metrics.STSExchangeLatencyMs.Store(uint64(out.Latency / time.Millisecond))
	if out.ClientErr != nil {
		p.recordSTSFailure(out)
		writeErr(w, requestID, out.Status, out.ClientErr.Code, out.ClientErr.Description)
		p.metrics.RequestsDenied.Add(1)
		p.metrics.STSExchangeErrors.Add(1)
		logger.Warn().
			Int("status", out.Status).
			Str("error_code", string(out.ClientErr.Code)).
			Err(out.InternalErr).
			Msg("sts exchange failed")
		return
	}
	p.recordSTSSuccess()
	res := out.Result

	upstreamURL, err := p.guard.Check(res.Upstream.URL)
	if err != nil {
		writeErr(w, requestID, http.StatusBadGateway, sharederr.Internal, "upstream not addressable")
		p.metrics.UpstreamErrors.Add(1)
		logger.Error().Err(err).Str("upstream_raw", res.Upstream.URL).Msg("upstream rejected by guard")
		p.emitActionAudit(gatewayAuditInput{
			RequestID:          requestID,
			ZoneID:             zoneID,
			ApplicationID:      clientID,
			Resource:           resource,
			SubjectFingerprint: tokenFingerprint(bearer),
			Method:             r.Method,
			AuthMode:           res.Upstream.AuthMode,
			ProviderID:         res.Upstream.ProviderID,
			ConnectionID:       res.Upstream.ConnectionID,
			GatewayStatus:      http.StatusBadGateway,
			EvaluationStatus:   "upstream_rejected",
			ErrorKind:          "upstream_not_addressable",
		})
		return
	}
	logger = logger.With().
		Str("upstream_host", upstreamURL.Host).
		Str("auth_mode", res.Upstream.AuthMode).
		Dur("sts_latency_ms", res.Latency).
		Logger()
	if !providerCredentialHostAllowed(upstreamURL, res.Upstream.AllowedTokenHosts) {
		writeErr(w, requestID, http.StatusBadGateway, sharederr.Internal, "provider credential not allowed for upstream host")
		p.metrics.UpstreamErrors.Add(1)
		logger.Warn().Msg("provider credential host rejected")
		p.emitActionAudit(gatewayAuditInput{
			RequestID:          requestID,
			ZoneID:             zoneID,
			ApplicationID:      clientID,
			Resource:           resource,
			SubjectFingerprint: tokenFingerprint(bearer),
			Method:             r.Method,
			UpstreamHost:       upstreamURL.Host,
			AuthMode:           res.Upstream.AuthMode,
			ProviderID:         res.Upstream.ProviderID,
			ConnectionID:       res.Upstream.ConnectionID,
			GatewayStatus:      http.StatusBadGateway,
			EvaluationStatus:   "upstream_rejected",
			ErrorKind:          "provider_host_not_allowed",
		})
		return
	}

	body := http.MaxBytesReader(w, r.Body, p.maxBytes)
	defer body.Close()

	upstreamReq, err := buildUpstreamRequestWithProxy(r, upstreamURL, res.AccessToken, res.Upstream, body, requestID, p.trustProxy)
	if err != nil {
		writeErr(w, requestID, http.StatusBadRequest, sharederr.Internal, "upstream request build failed")
		p.metrics.UpstreamErrors.Add(1)
		logger.Error().Err(err).Msg("build upstream request")
		p.emitActionAudit(gatewayAuditInput{
			RequestID:          requestID,
			ZoneID:             zoneID,
			ApplicationID:      clientID,
			Resource:           resource,
			SubjectFingerprint: tokenFingerprint(bearer),
			Method:             r.Method,
			UpstreamHost:       upstreamURL.Host,
			AuthMode:           res.Upstream.AuthMode,
			ProviderID:         res.Upstream.ProviderID,
			ConnectionID:       res.Upstream.ConnectionID,
			GatewayStatus:      http.StatusBadRequest,
			EvaluationStatus:   "build_failed",
			ErrorKind:          "request_build_failed",
		})
		return
	}

	traceID := traceIDFromTraceparent(upstreamReq.Header.Get("Traceparent"))
	logger = logger.With().Str("trace_id", traceID).Logger()

	upstreamCtx, cancelUpstream := context.WithCancel(r.Context())
	upstreamReq = upstreamReq.WithContext(upstreamCtx)
	start := time.Now()
	resp, err := p.client.Do(upstreamReq)
	latency := time.Since(start)
	if err != nil {
		cancelUpstream()
		status, code, msg := classifyUpstreamError(err)
		writeErr(w, requestID, status, code, msg)
		p.metrics.UpstreamErrors.Add(1)
		logger.Error().Err(err).Int("status", status).Msg("upstream request failed")
		p.emitActionAudit(gatewayAuditInput{
			RequestID:          requestID,
			TraceID:            traceID,
			ZoneID:             zoneID,
			ApplicationID:      clientID,
			Resource:           resource,
			SubjectFingerprint: tokenFingerprint(bearer),
			Method:             r.Method,
			UpstreamHost:       upstreamURL.Host,
			AuthMode:           res.Upstream.AuthMode,
			ProviderID:         res.Upstream.ProviderID,
			ConnectionID:       res.Upstream.ConnectionID,
			GatewayStatus:      status,
			Latency:            latency,
			EvaluationStatus:   "upstream_error",
			ErrorKind:          "transport_error",
		})
		return
	}
	defer cancelUpstream()
	resp.Body = &idleReadCloser{ReadCloser: resp.Body, idle: p.streamIdle, cancel: cancelUpstream}
	defer resp.Body.Close()

	stripHopByHop(resp.Header)
	if exp.After(time.Now()) {
		w.Header().Set("X-Caracal-Token-Expires-In", strconv.FormatInt(int64(time.Until(exp).Seconds()), 10))
	}
	copyResult := copyResponseWithTimeout(w, resp, p.revocations, revocationAnchors, p.writeTimeout, p.streamIdle)
	p.metrics.RequestsAllowed.Add(1)
	evaluationStatus := "executed"
	errorKind := ""
	if copyResult.Err != nil {
		evaluationStatus = "upstream_error"
		errorKind = "response_copy_failed"
		p.metrics.UpstreamErrors.Add(1)
		logger.Warn().Err(copyResult.Err).Msg("upstream response copy incomplete")
	}
	p.emitActionAudit(gatewayAuditInput{
		RequestID:          requestID,
		TraceID:            traceID,
		ZoneID:             zoneID,
		ApplicationID:      clientID,
		Resource:           resource,
		SubjectFingerprint: tokenFingerprint(bearer),
		Method:             r.Method,
		UpstreamHost:       upstreamURL.Host,
		AuthMode:           res.Upstream.AuthMode,
		ProviderID:         res.Upstream.ProviderID,
		ConnectionID:       res.Upstream.ConnectionID,
		GatewayStatus:      resp.StatusCode,
		UpstreamStatus:     resp.StatusCode,
		Latency:            latency,
		ResponseBytes:      copyResult.Bytes,
		RevocationHit:      copyResult.Revoked,
		EvaluationStatus:   evaluationStatus,
		ErrorKind:          errorKind,
	})
	logger.Info().
		Int("status", resp.StatusCode).
		Dur("upstream_latency_ms", latency).
		Msg("proxied")
}

func (p *proxy) emitActionAudit(input gatewayAuditInput) {
	emitGatewayActionAudit(p.audit, func(err error) {
		p.log.Error().Err(err).Str("request_id", input.RequestID).Str("zone_id", input.ZoneID).Msg("gateway audit event creation failed")
	}, input)
}

func (p *proxy) stsCircuitOpen() bool {
	p.circuitMu.Lock()
	defer p.circuitMu.Unlock()
	if time.Now().Before(p.stsOpenUntil) {
		p.metrics.STSCircuitOpen.Store(1)
		return true
	}
	p.metrics.STSCircuitOpen.Store(0)
	return false
}

func (p *proxy) recordSTSSuccess() {
	p.circuitMu.Lock()
	defer p.circuitMu.Unlock()
	p.stsFailures = 0
	p.stsOpenUntil = time.Time{}
	p.metrics.STSCircuitOpen.Store(0)
}

func (p *proxy) recordSTSFailure(out exchangeOutcome) {
	if out.ClientErr == nil || out.ClientErr.Code != sharederr.STSUnavailable || out.Status < http.StatusInternalServerError {
		return
	}
	p.circuitMu.Lock()
	defer p.circuitMu.Unlock()
	p.stsFailures++
	if p.stsFailures >= stsCircuitFailureLimit {
		p.stsOpenUntil = time.Now().Add(stsCircuitOpenFor)
		p.metrics.STSCircuitOpen.Store(1)
		p.metrics.STSCircuitOpened.Add(1)
	}
}

// buildUpstreamRequest constructs the outbound request with safe headers, joined path,
// merged query string, and the credential class STS chose for the resource. For
// none mode forwards no credential; caracal_jwt mode forwards the Caracal
// STS-issued bearer; provider_oauth substitutes provider credentials into
// headers; provider_apikey supports header and query-parameter placement. The
// Caracal JWT is forwarded as X-Caracal-Identity only when the resource/provider
// directive explicitly opts in for a trusted upstream.
func buildUpstreamRequest(r *http.Request, upstreamURL *url.URL, caracalToken string, directive corests.UpstreamDirective, body io.ReadCloser, requestID string) (*http.Request, error) {
	return buildUpstreamRequestWithProxy(r, upstreamURL, caracalToken, directive, body, requestID, false)
}

func buildUpstreamRequestWithProxy(r *http.Request, upstreamURL *url.URL, caracalToken string, directive corests.UpstreamDirective, body io.ReadCloser, requestID string, trustProxy bool) (*http.Request, error) {
	forwardedFor := r.Header.Get("X-Forwarded-For")
	forwardedProto := strings.ToLower(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")))
	joinedPath := joinURLPath(upstreamURL.Path, r.URL.Path)
	mergedQuery, err := mergeQuery(upstreamURL.RawQuery, r.URL.RawQuery)
	if err != nil {
		return nil, err
	}

	target := *upstreamURL
	target.Path = joinedPath
	target.RawPath = ""
	target.RawQuery = mergedQuery
	target.Fragment = ""

	req, err := http.NewRequestWithContext(r.Context(), r.Method, target.String(), body)
	if err != nil {
		return nil, err
	}
	req.Header = r.Header.Clone()
	stripHopByHop(req.Header)
	stripCaracalBaggage(req.Header)
	stripReservedHeaders(req.Header)

	authHeader := directive.AuthHeader
	if authHeader == "" {
		authHeader = "Authorization"
	}
	if !corests.ValidUpstreamCredentialHeader(authHeader) {
		return nil, errors.New("upstream credential header is reserved")
	}
	req.Header.Del("Authorization")
	req.Header.Del(authHeader)
	switch directive.AuthMode {
	case "none":
	case "caracal_jwt":
		scheme := directive.AuthScheme
		if scheme == "" {
			scheme = "Bearer"
		}
		req.Header.Set(authHeader, scheme+" "+caracalToken)
	case "provider_oauth":
		scheme := directive.AuthScheme
		value := directive.ProviderToken
		if scheme != "" {
			value = scheme + " " + value
		}
		req.Header.Set(authHeader, value)
		if directive.ForwardCaracalIdentity {
			req.Header.Set("X-Caracal-Identity", caracalToken)
		}
	case "provider_apikey":
		if directive.AuthLocation == "query" {
			if strings.TrimSpace(directive.QueryParamName) == "" {
				return nil, errors.New("provider api key query parameter missing")
			}
			query := req.URL.Query()
			query.Set(directive.QueryParamName, directive.ProviderToken)
			req.URL.RawQuery = query.Encode()
		} else {
			scheme := directive.AuthScheme
			value := directive.ProviderToken
			if scheme != "" {
				value = scheme + " " + value
			}
			req.Header.Set(authHeader, value)
		}
		if directive.ForwardCaracalIdentity {
			req.Header.Set("X-Caracal-Identity", caracalToken)
		}
	default:
		return nil, errors.New("unsupported upstream auth mode")
	}
	req.Header.Set("X-Request-Id", requestID)
	// The gateway is a trust boundary: a caller-supplied Traceparent is forwarded only
	// when it is a parseable W3C value, otherwise it is replaced so malformed tracing
	// context never propagates upstream.
	if !validTraceparent(req.Header.Get("Traceparent")) {
		req.Header.Set("Traceparent", newTraceparent())
	}

	// Replace, never append: the gateway is a trust boundary and any caller-supplied
	// X-Forwarded-* values are spoofable. Upstreams that key on the first XFF entry
	// would otherwise read attacker-controlled data.
	if trustProxy && validForwardedIP(forwardedFor) {
		req.Header.Set("X-Forwarded-For", strings.TrimSpace(strings.Split(forwardedFor, ",")[0]))
	} else if ip := clientIP(r.RemoteAddr); ip != "" {
		req.Header.Set("X-Forwarded-For", ip)
	}
	if trustProxy && (forwardedProto == "http" || forwardedProto == "https") {
		req.Header.Set("X-Forwarded-Proto", forwardedProto)
	} else if r.TLS != nil {
		req.Header.Set("X-Forwarded-Proto", "https")
	} else {
		req.Header.Set("X-Forwarded-Proto", "http")
	}
	if r.Host != "" {
		req.Header.Set("X-Forwarded-Host", r.Host)
	}
	req.Host = upstreamURL.Host
	return req, nil
}

func validForwardedIP(value string) bool {
	first := strings.TrimSpace(strings.Split(value, ",")[0])
	return net.ParseIP(first) != nil
}

func providerCredentialHostAllowed(upstreamURL *url.URL, hosts []string) bool {
	if len(hosts) == 0 {
		return true
	}
	host := strings.ToLower(upstreamURL.Hostname())
	for _, allowedHost := range hosts {
		if strings.EqualFold(strings.TrimSpace(allowedHost), host) {
			return true
		}
	}
	return false
}

// classifyUpstreamError maps Go HTTP transport errors to safe gateway responses.
func classifyUpstreamError(err error) (int, sharederr.Code, string) {
	if errors.Is(err, context.DeadlineExceeded) {
		return http.StatusGatewayTimeout, sharederr.Internal, "upstream timeout"
	}
	if errors.Is(err, context.Canceled) {
		return 499, sharederr.Internal, "client cancelled"
	}
	var maxBytesErr *http.MaxBytesError
	if errors.As(err, &maxBytesErr) {
		return http.StatusRequestEntityTooLarge, sharederr.PayloadTooLarge, "request body too large"
	}
	return http.StatusBadGateway, sharederr.Internal, "upstream unreachable"
}

// joinURLPath joins the upstream base path with the request path. Callers must reject
// ".." segments in the request path before calling.
func joinURLPath(upstreamPath, requestPath string) string {
	if upstreamPath == "" || upstreamPath == "/" {
		if requestPath == "" {
			return "/"
		}
		return requestPath
	}
	if requestPath == "" || requestPath == "/" {
		return upstreamPath
	}
	return path.Join(upstreamPath, requestPath)
}

// upstreamIdentityHeaders name upstream response headers that only disclose the
// proxied service's server software or framework version. They carry no value for
// clients and reveal the upstream stack, so the gateway drops them on fan-out.
var upstreamIdentityHeaders = []string{
	"Server",
	"X-Powered-By",
	"X-AspNet-Version",
	"X-AspNetMvc-Version",
}

// sanitizeRedirectHeaders neutralizes upstream-controlled redirect targets on response
// fan-out. The gateway is the sole enforcement path and treats upstreams as untrusted, so
// an absolute (or protocol-relative) Location/Content-Location is stripped: forwarding it
// would disclose the upstream's internal topology (private/loopback upstreams are permitted)
// and would steer an agent client off the audited, credential-injected path toward a host
// the SSRF guard and egress allowlist never vetted - an open-redirect primitive. Relative
// references disclose no host and stay within gateway-mediated routing, so they are kept.
// A value that fails to parse is dropped rather than trusted.
func sanitizeRedirectHeaders(h http.Header) {
	for _, name := range []string{"Location", "Content-Location"} {
		val := h.Get(name)
		if val == "" {
			continue
		}
		u, err := url.Parse(val)
		if err != nil || u.Host != "" || u.Scheme != "" {
			h.Del(name)
		}
	}
	// Refresh is a non-standard upstream-controlled redirect directive (`Refresh: 5; url=…`)
	// with no legitimate use on this API gateway; drop it so it cannot smuggle a target.
	h.Del("Refresh")
}

// copyResponse streams the upstream response back to the client, flushing on every chunk
// so SSE consumers see real-time data without server-side buffering. Between chunks it
// consults revocations: if any authority anchor bound to the token is revoked
// mid-stream, the upstream body is closed and the response is truncated.
type responseCopyResult struct {
	Bytes   int64
	Revoked bool
	Err     error
}

type idleReadCloser struct {
	io.ReadCloser
	idle     time.Duration
	cancel   context.CancelFunc
	timedOut atomic.Bool
}

func (r *idleReadCloser) Read(p []byte) (int, error) {
	if r.idle <= 0 {
		return r.ReadCloser.Read(p)
	}
	timer := time.AfterFunc(r.idle, func() {
		r.timedOut.Store(true)
		r.cancel()
		_ = r.ReadCloser.Close()
	})
	n, err := r.ReadCloser.Read(p)
	timer.Stop()
	if r.timedOut.Load() {
		return n, context.DeadlineExceeded
	}
	return n, err
}

func copyResponse(w http.ResponseWriter, resp *http.Response, revocations revocationChecker, ids tokenRevocationAnchors) responseCopyResult {
	return copyResponseWithTimeout(w, resp, revocations, ids, defaultWriteTimeout, defaultWriteTimeout)
}

func copyResponseWithTimeout(w http.ResponseWriter, resp *http.Response, revocations revocationChecker, ids tokenRevocationAnchors, writeTimeout, streamIdle time.Duration) responseCopyResult {
	// X-Caracal-Identity is the gateway-side mirror of the Caracal JWT for
	// provider-native auth modes. Echoing it back to clients would surface a
	// short-TTL but still usable bearer; strip it before fan-out.
	resp.Header.Del("X-Caracal-Identity")
	for _, banner := range upstreamIdentityHeaders {
		resp.Header.Del(banner)
	}
	sanitizeRedirectHeaders(resp.Header)
	for key, vals := range resp.Header {
		for _, val := range vals {
			w.Header().Add(key, val)
		}
	}
	flusher, _ := w.(http.Flusher)
	if flusher == nil {
		if writeTimeout > 0 {
			_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(writeTimeout))
		}
		w.WriteHeader(resp.StatusCode)
		n, err := io.Copy(w, resp.Body)
		return responseCopyResult{Bytes: n, Err: err}
	}
	w.Header().Add("Trailer", "X-Caracal-Revoked")
	controller := http.NewResponseController(w)
	streaming := streamResponse(resp)
	if streaming {
		_ = controller.SetWriteDeadline(time.Now().Add(streamIdle))
	} else if writeTimeout > 0 {
		_ = controller.SetWriteDeadline(time.Now().Add(writeTimeout))
	}
	w.WriteHeader(resp.StatusCode)
	flusher.Flush()
	n, revoked, err := streamCopyWithDeadline(w, resp.Body, flusher, revocations, ids, controller, streaming, streamIdle)
	if revoked {
		w.Header().Set("X-Caracal-Revoked", "true")
	}
	return responseCopyResult{Bytes: n, Revoked: revoked, Err: err}
}

// streamCopy reads from src in small chunks and flushes after every successful write.
// On every chunk boundary it re-checks all authority revocation anchors. Returns
// true when the stream was truncated due to revocation so the caller can emit the
// X-Caracal-Revoked trailer.
func streamCopy(w io.Writer, src io.ReadCloser, flusher http.Flusher, revocations revocationChecker, ids tokenRevocationAnchors) (int64, bool) {
	n, revoked, _ := streamCopyWithDeadline(w, src, flusher, revocations, ids, nil, false, 0)
	return n, revoked
}

func streamCopyWithDeadline(w io.Writer, src io.ReadCloser, flusher http.Flusher, revocations revocationChecker, ids tokenRevocationAnchors, controller *http.ResponseController, streaming bool, streamIdle time.Duration) (int64, bool, error) {
	buf := make([]byte, 4*1024)
	var total int64
	for {
		if revocations.IsRevoked(ids.AuthorityRecordID) ||
			revocations.IsRevoked(ids.RootAuthorityRecordID) ||
			revocations.IsSessionRevoked(ids.SessionID) ||
			revocations.IsDelegationRevoked(ids.DelegationEdgeID) {
			_ = src.Close()
			return total, true, nil
		}
		n, rerr := src.Read(buf)
		if n > 0 {
			if streaming && controller != nil {
				_ = controller.SetWriteDeadline(time.Now().Add(streamIdle))
			}
			if _, werr := w.Write(buf[:n]); werr != nil {
				return total, false, werr
			}
			total += int64(n)
			flusher.Flush()
		}
		if rerr != nil {
			if errors.Is(rerr, io.EOF) {
				return total, false, nil
			}
			return total, false, rerr
		}
	}
}

func streamResponse(resp *http.Response) bool {
	mediaType := strings.ToLower(strings.TrimSpace(strings.Split(resp.Header.Get("Content-Type"), ";")[0]))
	return mediaType == "text/event-stream" || resp.ContentLength < 0
}

// jwtExp decodes the JWT payload to read the exp claim. Signature validation is delegated
// to STS (which receives the bearer as subject_token) and to the upstream resource server.
// This pre-flight check is a UX optimisation, not a security control.
func jwtExp(token string) (time.Time, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return time.Time{}, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return time.Time{}, false
	}
	var claims struct {
		Exp int64 `json:"exp"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil || claims.Exp == 0 {
		return time.Time{}, false
	}
	return time.Unix(claims.Exp, 0), true
}

var claimIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

func jwtZoneID(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims struct {
		ZoneID string `json:"zone_id"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return ""
	}
	if !claimIDPattern.MatchString(claims.ZoneID) {
		return ""
	}
	return claims.ZoneID
}

func jwtClientID(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims struct {
		ClientID string `json:"client_id"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return ""
	}
	if !claimIDPattern.MatchString(claims.ClientID) {
		return ""
	}
	return claims.ClientID
}

func extractBearer(h string) string {
	const prefix = "Bearer "
	if len(h) <= len(prefix) || !strings.EqualFold(h[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(h[len(prefix):])
}

// writeErr writes a sanitised CaracalError JSON response with the request ID echoed.
func writeErr(w http.ResponseWriter, requestID string, status int, code sharederr.Code, desc string) {
	e := sharederr.New(code, desc).WithRequestID(requestID)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Request-Id", requestID)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(e)
}
