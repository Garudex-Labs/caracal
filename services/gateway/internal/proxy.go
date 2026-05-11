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
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	sharederr "github.com/garudex-labs/caracal/core/errors"
	"github.com/rs/zerolog"
)

// preflightWindow gives STS time to mint a fresh token before the inbound bearer expires.
// The window is consulted via an unverified JWT peek, so it is a UX optimisation only —
// signature validity is established at STS exchange and at the upstream resource.
const preflightWindow = 35 * time.Second

const maxBearerBytes = 4096

// proxy implements the gateway's reverse-proxy handler.
type proxy struct {
	sts         *stsClient
	jwks        *jwksCache
	guard       *upstreamGuard
	client      *http.Client
	log         zerolog.Logger
	maxBytes    int64
	bindings    *bindingStore
	tracker     *jtiTracker
	revocations *revocationStore
}

func newProxy(sts *stsClient, jwks *jwksCache, guard *upstreamGuard, log zerolog.Logger, maxBytes int64, upstreamTimeout time.Duration, bindings *bindingStore, tracker *jtiTracker, revocations *revocationStore) *proxy {
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
		sts:         sts,
		jwks:        jwks,
		guard:       guard,
		client:      &http.Client{Transport: transport},
		log:         log,
		maxBytes:    maxBytes,
		bindings:    bindings,
		tracker:     tracker,
		revocations: revocations,
	}
}

func (p *proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	requestID := requestIDFromContext(r.Context())
	logger := p.log.With().Str("request_id", requestID).Str("client_ip", clientIP(r.RemoteAddr)).Logger()

	bearer := extractBearer(r.Header.Get("Authorization"))
	if bearer == "" {
		writeErr(w, requestID, http.StatusUnauthorized, sharederr.InvalidToken, "missing bearer token")
		logger.Info().Int("status", http.StatusUnauthorized).Msg("denied: missing bearer")
		return
	}
	if len(bearer) > maxBearerBytes {
		writeErr(w, requestID, http.StatusUnauthorized, sharederr.InvalidToken, "bearer token too large")
		logger.Info().Int("status", http.StatusUnauthorized).Msg("denied: bearer too large")
		return
	}

	exp, ok := jwtExp(bearer)
	if !ok {
		writeErr(w, requestID, http.StatusUnauthorized, sharederr.InvalidToken, "malformed bearer token")
		logger.Info().Int("status", http.StatusUnauthorized).Msg("denied: malformed bearer")
		return
	}
	if time.Until(exp) < preflightWindow {
		writeErr(w, requestID, http.StatusUnauthorized, sharederr.CredentialExpired, "credential expiring within pre-flight window")
		logger.Info().Int("status", http.StatusUnauthorized).Msg("denied: bearer near expiry")
		return
	}

	if r.Header.Get("X-Caracal-Client-ID") != "" {
		writeErr(w, requestID, http.StatusBadRequest, sharederr.InvalidToken, "client id is bound by gateway configuration")
		logger.Info().Int("status", http.StatusBadRequest).Msg("denied: client id header not honored")
		return
	}
	resource := strings.TrimSpace(r.Header.Get("X-Caracal-Resource"))
	if resource == "" {
		writeErr(w, requestID, http.StatusBadRequest, sharederr.InvalidToken, "missing routing headers")
		logger.Info().Int("status", http.StatusBadRequest).Msg("denied: missing routing headers")
		return
	}
	bind, ok := p.bindings.Get(resource)
	if !ok {
		writeErr(w, requestID, http.StatusForbidden, sharederr.AccessDenied, "resource not configured")
		logger.Info().Int("status", http.StatusForbidden).Str("resource", resource).Msg("denied: resource has no client binding")
		return
	}

	if pathContainsTraversal(r.URL.Path) {
		writeErr(w, requestID, http.StatusBadRequest, sharederr.InvalidToken, "path traversal not permitted")
		logger.Info().Int("status", http.StatusBadRequest).Str("path", r.URL.Path).Msg("denied: path traversal")
		return
	}

	logger = logger.With().
		Str("zone_id", bind.ZoneID).
		Str("application_id", bind.ApplicationID).
		Str("resource", resource).
		Str("subject_fp", tokenFingerprint(bearer)).
		Logger()

	if err := p.jwks.Verify(r.Context(), bind.ZoneID, bearer); err != nil {
		writeErr(w, requestID, http.StatusUnauthorized, sharederr.InvalidToken, "bearer signature invalid")
		logger.Info().Err(err).Int("status", http.StatusUnauthorized).Msg("denied: bearer signature")
		return
	}

	if !p.tracker.Check(r.Context(), jwtJTI(bearer), exp, jwtUse(bearer), requestID, resource, bind.ApplicationID, tokenFingerprint(bearer)) {
		writeErr(w, requestID, http.StatusUnauthorized, sharederr.InvalidToken, "token replay detected")
		logger.Info().Int("status", http.StatusUnauthorized).Msg("denied: jti replay")
		return
	}

	sid := jwtSID(bearer)
	if p.revocations.IsRevoked(sid) {
		writeErr(w, requestID, http.StatusUnauthorized, sharederr.InvalidToken, "session revoked")
		logger.Info().Int("status", http.StatusUnauthorized).Str("sid", sid).Msg("denied: session revoked")
		return
	}

	stsCtx, cancel := context.WithTimeout(r.Context(), p.sts.client.Timeout)
	out := p.sts.Exchange(stsCtx, bearer, bind, resource, requestID)
	cancel()
	if out.ClientErr != nil {
		writeErr(w, requestID, out.Status, out.ClientErr.Code, out.ClientErr.Description)
		logger.Warn().
			Int("status", out.Status).
			Str("error_code", string(out.ClientErr.Code)).
			Err(out.InternalErr).
			Msg("sts exchange failed")
		return
	}
	res := out.Result

	upstreamURL, err := p.guard.Check(res.Upstream.URL)
	if err != nil {
		writeErr(w, requestID, http.StatusBadGateway, sharederr.Internal, "upstream not addressable")
		logger.Error().Err(err).Str("upstream_raw", res.Upstream.URL).Msg("upstream rejected by guard")
		return
	}
	logger = logger.With().
		Str("upstream_host", upstreamURL.Host).
		Str("auth_mode", res.Upstream.AuthMode).
		Dur("sts_latency_ms", res.Latency).
		Logger()

	body := http.MaxBytesReader(w, r.Body, p.maxBytes)
	defer body.Close()

	upstreamReq, err := buildUpstreamRequest(r, upstreamURL, res.AccessToken, res.Upstream, body, requestID)
	if err != nil {
		writeErr(w, requestID, http.StatusBadRequest, sharederr.Internal, "upstream request build failed")
		logger.Error().Err(err).Msg("build upstream request")
		return
	}

	start := time.Now()
	resp, err := p.client.Do(upstreamReq)
	if err != nil {
		status, code, msg := classifyUpstreamError(err)
		writeErr(w, requestID, status, code, msg)
		logger.Error().Err(err).Int("status", status).Msg("upstream request failed")
		return
	}
	defer resp.Body.Close()

	stripHopByHop(resp.Header)
	if exp.After(time.Now()) {
		w.Header().Set("X-Caracal-Token-Expires-In", strconv.FormatInt(int64(time.Until(exp).Seconds()), 10))
	}
	copyResponse(w, resp, p.revocations, sid)
	logger.Info().
		Int("status", resp.StatusCode).
		Dur("upstream_latency_ms", time.Since(start)).
		Msg("proxied")
}

// buildUpstreamRequest constructs the outbound request with safe headers, joined path,
// merged query string, and the credential class STS chose for the resource. For
// caracal_jwt mode the Caracal STS-issued bearer is forwarded; for provider_oauth /
// provider_apikey the provider-native credential is substituted into the header the
// upstream expects, and the Caracal JWT is exposed separately as X-Caracal-Identity so
// Caracal-aware sidecars can still attribute the call.
func buildUpstreamRequest(r *http.Request, upstreamURL *url.URL, caracalToken string, directive upstreamDirective, body io.ReadCloser, requestID string) (*http.Request, error) {
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
	req.Header.Del("X-Caracal-Client-ID")
	req.Header.Del("X-Caracal-Resource")
	req.Header.Del("X-Caracal-Upstream")
	req.Header.Del("X-Caracal-Identity")

	authHeader := directive.AuthHeader
	if authHeader == "" {
		authHeader = "Authorization"
	}
	switch directive.AuthMode {
	case "provider_oauth", "provider_apikey":
		scheme := directive.AuthScheme
		value := directive.ProviderToken
		if scheme != "" {
			value = scheme + " " + value
		}
		req.Header.Set(authHeader, value)
		req.Header.Set("X-Caracal-Identity", caracalToken)
	default:
		scheme := directive.AuthScheme
		if scheme == "" {
			scheme = "Bearer"
		}
		req.Header.Set(authHeader, scheme+" "+caracalToken)
	}
	req.Header.Set("X-Request-Id", requestID)
	if req.Header.Get("Traceparent") == "" {
		req.Header.Set("Traceparent", traceparentFromRequestID(requestID))
	}

	// Replace, never append: the gateway is a trust boundary and any caller-supplied
	// X-Forwarded-* values are spoofable. Upstreams that key on the first XFF entry
	// would otherwise read attacker-controlled data.
	req.Header.Del("X-Forwarded-For")
	if ip := clientIP(r.RemoteAddr); ip != "" {
		req.Header.Set("X-Forwarded-For", ip)
	}
	if r.TLS != nil {
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

// copyResponse streams the upstream response back to the client, flushing on every chunk
// so SSE consumers see real-time data without server-side buffering. Between chunks it
// consults revocations: if the session id bound to the token is revoked mid-stream the
// upstream body is closed and the response is truncated. This is the runtime side of
// Issue K — without it, an attacker holding a leaked token keeps the SSE pipe open
// indefinitely even after revocation.
func copyResponse(w http.ResponseWriter, resp *http.Response, revocations *revocationStore, sid string) {
	for key, vals := range resp.Header {
		for _, val := range vals {
			w.Header().Add(key, val)
		}
	}
	w.WriteHeader(resp.StatusCode)

	flusher, _ := w.(http.Flusher)
	if flusher == nil {
		_, _ = io.Copy(w, resp.Body)
		return
	}
	flusher.Flush()
	streamCopy(w, resp.Body, flusher, revocations, sid)
}

// streamCopy reads from src in small chunks and flushes after every successful write.
// On every chunk boundary it re-checks the revocation cache for sid and aborts the
// stream if the session has been revoked while data is in flight.
func streamCopy(w io.Writer, src io.ReadCloser, flusher http.Flusher, revocations *revocationStore, sid string) {
	buf := make([]byte, 4*1024)
	for {
		if revocations.IsRevoked(sid) {
			_ = src.Close()
			return
		}
		n, rerr := src.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			flusher.Flush()
		}
		if rerr != nil {
			return
		}
	}
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

// traceparentFromRequestID builds a W3C traceparent value seeded from the request id
// so a single trace identifier flows from the gateway through to upstream provider hops.
func traceparentFromRequestID(requestID string) string {
	hex := strings.ReplaceAll(requestID, "-", "")
	for len(hex) < 32 {
		hex += "0"
	}
	traceID := hex[:32]
	spanID := hex[:16]
	return "00-" + traceID + "-" + spanID + "-01"
}
