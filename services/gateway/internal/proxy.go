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
	"strings"
	"time"

	sharederr "github.com/garudex-labs/caracal/shared/errors"
	"github.com/rs/zerolog"
)

// preflightWindow gives STS time to mint a fresh token before the inbound bearer expires.
const preflightWindow = 35 * time.Second

// proxy implements the gateway's reverse-proxy handler.
type proxy struct {
	sts      *stsClient
	guard    *upstreamGuard
	client   *http.Client
	log      zerolog.Logger
	maxBytes int64
	bindings map[string]string
	tracker  *jtiTracker
}

func newProxy(sts *stsClient, guard *upstreamGuard, log zerolog.Logger, maxBytes int64, upstreamTimeout time.Duration, bindings map[string]string, tracker *jtiTracker) *proxy {
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
		sts:      sts,
		guard:    guard,
		client:   &http.Client{Transport: transport},
		log:      log,
		maxBytes: maxBytes,
		bindings: bindings,
		tracker:  tracker,
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
	clientID, ok := p.bindings[resource]
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
		Str("client_id", clientID).
		Str("resource", resource).
		Str("subject_fp", tokenFingerprint(bearer)).
		Logger()

	p.tracker.Observe(r.Context(), jwtJTI(bearer), exp, requestID, resource, clientID, tokenFingerprint(bearer))

	stsCtx, cancel := context.WithTimeout(r.Context(), p.sts.client.Timeout)
	res, status, cerr, internalErr := p.sts.Exchange(stsCtx, bearer, clientID, resource, requestID)
	cancel()
	if cerr != nil {
		writeErr(w, requestID, status, cerr.Code, cerr.Description)
		logger.Warn().
			Int("status", status).
			Str("error_code", string(cerr.Code)).
			Err(internalErr).
			Msg("sts exchange failed")
		return
	}

	upstreamURL, err := p.guard.Check(res.Upstream)
	if err != nil {
		writeErr(w, requestID, http.StatusBadGateway, sharederr.Internal, "upstream not addressable")
		logger.Error().Err(err).Str("upstream_raw", res.Upstream).Msg("upstream rejected by guard")
		return
	}
	logger = logger.With().
		Str("upstream_host", upstreamURL.Host).
		Dur("sts_latency_ms", res.Latency).
		Logger()

	body := http.MaxBytesReader(w, r.Body, p.maxBytes)
	defer body.Close()

	upstreamReq, err := buildUpstreamRequest(r, upstreamURL, res.AccessToken, body, requestID)
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
	copyResponse(w, resp)
	logger.Info().
		Int("status", resp.StatusCode).
		Dur("upstream_latency_ms", time.Since(start)).
		Msg("proxied")
}

// buildUpstreamRequest constructs the outbound request with safe headers, joined path,
// merged query string, and a fresh STS-issued bearer token. The original Authorization
// header is replaced; Caracal routing headers are stripped.
func buildUpstreamRequest(r *http.Request, upstreamURL *url.URL, token string, body io.ReadCloser, requestID string) (*http.Request, error) {
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
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Request-Id", requestID)

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
		return http.StatusRequestEntityTooLarge, sharederr.InvalidToken, "request body too large"
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
// so SSE consumers see real-time data without server-side buffering.
func copyResponse(w http.ResponseWriter, resp *http.Response) {
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
	streamCopy(w, resp.Body, flusher)
}

// streamCopy reads from src in small chunks and flushes after every successful write.
func streamCopy(w io.Writer, src io.Reader, flusher http.Flusher) {
	buf := make([]byte, 4*1024)
	for {
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
