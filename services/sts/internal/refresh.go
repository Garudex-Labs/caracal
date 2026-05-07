// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Brokered credential refresh: SSRF-hardened OAuth refresh with circuit breaker.

package internal

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	sharederr "github.com/garudex-labs/caracal/shared/errors"
	"golang.org/x/crypto/chacha20poly1305"
)

const (
	providerRefreshTimeout  = 5 * time.Second
	providerRefreshAttempts = 2
	providerCircuitTTL      = 30 * time.Second
	providerFailureTTL      = 5 * time.Minute
	providerFailureLimit    = int64(5)
	providerMaxBodyBytes    = 64 * 1024
	grantPersistAttempts    = 3
	grantPersistBackoff     = 25 * time.Millisecond
	providerRetryBackoff    = 100 * time.Millisecond
)

func sealZEK(zek, plaintext []byte) ([]byte, error) {
	aead, err := chacha20poly1305.New(zek)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	ct := aead.Seal(nil, nonce, plaintext, nil)
	return append(nonce, ct...), nil
}

func openZEK(zek, packed []byte) ([]byte, error) {
	aead, err := chacha20poly1305.New(zek)
	if err != nil {
		return nil, err
	}
	ns := aead.NonceSize()
	if len(packed) < ns {
		return nil, errors.New("ciphertext too short")
	}
	return aead.Open(nil, packed[:ns], packed[ns:], nil)
}

// tryRefreshBrokeredGrant fetches the delegated grant for userID+resourceID,
// refreshes the provider access token if expired, and updates the grant.
func (s *Server) tryRefreshBrokeredGrant(ctx context.Context, zoneID, userID, resourceID string) *sharederr.CaracalError {
	if userID == "" {
		return nil
	}
	grant, err := s.db.GetDelegatedGrant(ctx, zoneID, userID, resourceID)
	if err != nil {
		return nil
	}
	if grant.ExpiresAt != nil && grant.ExpiresAt.After(time.Now()) {
		return nil
	}
	if len(grant.RefreshTokenCt) == 0 || grant.ProviderID == nil {
		return sharederr.New(sharederr.CredentialExpired, "credential_expired_not_renewable")
	}
	provider, err := s.db.GetProvider(ctx, *grant.ProviderID)
	if err != nil {
		return sharederr.New(sharederr.CredentialExpired, "credential_expired_not_renewable")
	}
	var provCfg struct {
		TokenEndpoint     string   `json:"token_endpoint"`
		AllowedTokenHosts []string `json:"allowed_token_hosts"`
	}
	if err := json.Unmarshal(provider.ConfigJSON, &provCfg); err != nil || provCfg.TokenEndpoint == "" {
		return sharederr.New(sharederr.CredentialExpired, "credential_expired_not_renewable")
	}
	tokenEndpoint, err := validateTokenEndpoint(provCfg.TokenEndpoint, provCfg.AllowedTokenHosts)
	if err != nil {
		return sharederr.New(sharederr.CredentialExpired, "credential endpoint not allowed")
	}
	if s.providerCircuitOpen(ctx, provider.ID) {
		return sharederr.New(sharederr.CredentialExpired, "provider refresh circuit open")
	}
	refreshToken, err := openZEK(s.keys.zek, grant.RefreshTokenCt)
	if err != nil {
		return sharederr.New(sharederr.CredentialExpired, "credential_expired_not_renewable")
	}
	form := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {string(refreshToken)}}
	body, err := s.refreshProviderToken(ctx, provider.ID, tokenEndpoint, form)
	if err != nil {
		return sharederr.New(sharederr.CredentialExpired, "credential_expired_not_renewable")
	}
	var tokenResp struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &tokenResp); err != nil || tokenResp.AccessToken == "" {
		return sharederr.New(sharederr.CredentialExpired, "credential_expired_not_renewable")
	}
	newAccessCt, err := sealZEK(s.keys.zek, []byte(tokenResp.AccessToken))
	if err != nil {
		return sharederr.New(sharederr.Internal, "token re-encryption failed")
	}
	newRefresh := tokenResp.RefreshToken
	if newRefresh == "" {
		newRefresh = string(refreshToken)
	}
	newRefreshCt, err := sealZEK(s.keys.zek, []byte(newRefresh))
	if err != nil {
		return sharederr.New(sharederr.Internal, "token re-encryption failed")
	}
	cappedTTL := capGrantTTL(tokenResp.ExpiresIn, s.cfg.MaxGrantTTLSeconds)
	expiresAt := time.Now().Add(cappedTTL)
	if cappedTTL < time.Duration(tokenResp.ExpiresIn)*time.Second {
		s.log.Warn().
			Str("provider", provider.ID).
			Int("provider_expires_in", tokenResp.ExpiresIn).
			Int("max_grant_ttl_seconds", s.cfg.MaxGrantTTLSeconds).
			Msg("capped provider token ttl")
	}
	if err := s.persistRefreshedGrant(ctx, zoneID, userID, resourceID, grant, newAccessCt, newRefreshCt, expiresAt); err != nil {
		return sharederr.New(sharederr.Internal, "grant update failed")
	}
	return nil
}

// capGrantTTL bounds the provider-returned lifetime to STS's configured maximum
// so a misbehaving upstream cannot extend Caracal's short-TTL invariant.
func capGrantTTL(providerSeconds, maxSeconds int) time.Duration {
	if providerSeconds <= 0 {
		return time.Duration(maxSeconds) * time.Second
	}
	if providerSeconds > maxSeconds {
		return time.Duration(maxSeconds) * time.Second
	}
	return time.Duration(providerSeconds) * time.Second
}

// persistRefreshedGrant writes the refreshed tokens with optimistic-lock retries.
// On version conflict it re-reads the grant; if a peer already produced fresh
// tokens, the call returns nil without re-writing.
func (s *Server) persistRefreshedGrant(
	ctx context.Context,
	zoneID, userID, resourceID string,
	grant *DelegatedGrant,
	accessCt, refreshCt []byte,
	expiresAt time.Time,
) error {
	expectedVersion := grant.RefreshTokenVersion
	for attempt := 0; attempt < grantPersistAttempts; attempt++ {
		err := s.db.UpdateGrantTokens(ctx, grant.ID, expectedVersion, accessCt, refreshCt, expiresAt)
		if err == nil {
			return nil
		}
		if !errors.Is(err, ErrConcurrentGrantUpdate) {
			return err
		}
		latest, readErr := s.db.GetDelegatedGrant(ctx, zoneID, userID, resourceID)
		if readErr != nil {
			return readErr
		}
		if latest.ExpiresAt != nil && latest.ExpiresAt.After(time.Now()) {
			return nil
		}
		expectedVersion = latest.RefreshTokenVersion
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(jitteredBackoff(grantPersistBackoff, attempt)):
		}
	}
	return ErrConcurrentGrantUpdate
}

// jitteredBackoff returns base*(attempt+1) plus uniform random jitter in [0, base).
// Decorrelates retries so concurrent contenders do not re-collide on the same tick.
func jitteredBackoff(base time.Duration, attempt int) time.Duration {
	var b [8]byte
	_, _ = rand.Read(b[:])
	jitter := time.Duration(binary.LittleEndian.Uint64(b[:]) % uint64(base))
	return base*time.Duration(attempt+1) + jitter
}

// validateTokenEndpoint enforces SSRF defenses: HTTPS only, mandatory non-empty host
// allowlist (no implicit "any host" mode), case-insensitive exact host match. The host
// is also pre-resolved to reject private/loopback/link-local addresses; the dialer
// re-checks at connect time so DNS rebinding cannot bypass the gate.
func validateTokenEndpoint(raw string, allowedHosts []string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	if u.Scheme != "https" || u.Hostname() == "" {
		return nil, errors.New("provider token endpoint must be https")
	}
	if len(allowedHosts) == 0 {
		return nil, errors.New("provider has no allowed_token_hosts configured")
	}
	matched := false
	for _, host := range allowedHosts {
		if strings.EqualFold(strings.TrimSpace(host), u.Hostname()) {
			matched = true
			break
		}
	}
	if !matched {
		return nil, errors.New("provider token endpoint host is not allowlisted")
	}
	addrs, err := net.LookupIP(u.Hostname())
	if err != nil {
		return nil, fmt.Errorf("provider token endpoint dns lookup failed: %w", err)
	}
	if len(addrs) == 0 {
		return nil, errors.New("provider token endpoint resolves to no addresses")
	}
	for _, ip := range addrs {
		if isUnsafeIP(ip) {
			return nil, errors.New("provider token endpoint resolves to a non-routable address")
		}
	}
	return u, nil
}

// isUnsafeIP returns true for any address class that must not be reachable from STS:
// loopback, link-local, multicast, unspecified, and RFC 1918 / RFC 4193 private space.
func isUnsafeIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsUnspecified() || ip.IsMulticast() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return true
	}
	if ip4 := ip.To4(); ip4 != nil {
		switch {
		case ip4[0] == 10:
			return true
		case ip4[0] == 172 && ip4[1] >= 16 && ip4[1] <= 31:
			return true
		case ip4[0] == 192 && ip4[1] == 168:
			return true
		case ip4[0] == 169 && ip4[1] == 254:
			return true
		case ip4[0] == 100 && ip4[1] >= 64 && ip4[1] <= 127:
			return true
		}
		return false
	}
	if len(ip) == net.IPv6len && ip[0]&0xfe == 0xfc {
		return true
	}
	return false
}

// safeHTTPClient builds a one-shot HTTP client with redirects disabled and a dialer
// that re-validates the resolved address right before the TCP connect.
func safeHTTPClient(timeout time.Duration) *http.Client {
	dialer := &net.Dialer{Timeout: timeout, KeepAlive: timeout}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			ips, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
			if err != nil {
				return nil, err
			}
			for _, ip := range ips {
				if isUnsafeIP(ip) {
					return nil, fmt.Errorf("blocked address %s", ip.String())
				}
			}
			return dialer.DialContext(ctx, network, net.JoinHostPort(ips[0].String(), port))
		},
		TLSHandshakeTimeout: timeout,
	}
	return &http.Client{
		Timeout:   timeout,
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func (s *Server) refreshProviderToken(ctx context.Context, providerID string, endpoint *url.URL, form url.Values) ([]byte, error) {
	client := safeHTTPClient(providerRefreshTimeout)
	var lastErr error
	for attempt := 0; attempt < providerRefreshAttempts; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(jitteredBackoff(providerRetryBackoff, attempt-1)):
			}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), strings.NewReader(form.Encode()))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, providerMaxBodyBytes))
		_ = resp.Body.Close()
		if readErr != nil {
			lastErr = readErr
			continue
		}
		if resp.StatusCode == http.StatusOK {
			s.clearProviderFailures(ctx, providerID)
			return body, nil
		}
		lastErr = fmt.Errorf("provider token endpoint returned %d", resp.StatusCode)
	}
	s.recordProviderFailure(ctx, providerID)
	return nil, lastErr
}

func (s *Server) providerCircuitOpen(ctx context.Context, providerID string) bool {
	if s.redis == nil {
		return false
	}
	open, err := s.redis.Exists(ctx, "provider-refresh-circuit:"+providerID)
	return err == nil && open
}

func (s *Server) recordProviderFailure(ctx context.Context, providerID string) {
	if s.redis == nil {
		return
	}
	key := "provider-refresh-failures:" + providerID
	count, err := s.redis.IncrWithExpiry(ctx, key, providerFailureTTL)
	if err == nil && count >= providerFailureLimit {
		_ = s.redis.SetTTL(ctx, "provider-refresh-circuit:"+providerID, "open", providerCircuitTTL)
	}
}

func (s *Server) clearProviderFailures(ctx context.Context, providerID string) {
	if s.redis == nil {
		return
	}
	_ = s.redis.Del(ctx, "provider-refresh-failures:"+providerID)
	_ = s.redis.Del(ctx, "provider-refresh-circuit:"+providerID)
}
