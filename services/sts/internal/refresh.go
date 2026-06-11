// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Brokered credential refresh: SSRF-hardened OAuth refresh with circuit breaker.

package internal

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	sharedcrypto "github.com/garudex-labs/caracal/packages/core/go/crypto"
	sharederr "github.com/garudex-labs/caracal/packages/core/go/errors"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
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
	refreshLeaseTTL         = 15 * time.Second
	refreshResultTTL        = 5 * time.Second
	refreshWaitInterval     = 50 * time.Millisecond
)

var reservedOAuthTokenParams = map[string]struct{}{
	"client_assertion":      {},
	"client_assertion_type": {},
	"client_id":             {},
	"client_secret":         {},
	"code":                  {},
	"code_verifier":         {},
	"grant_type":            {},
	"redirect_uri":          {},
	"refresh_token":         {},
	"scope":                 {},
}

type distributedRefreshResult struct {
	OK          bool           `json:"ok"`
	Code        sharederr.Code `json:"code,omitempty"`
	Description string         `json:"description,omitempty"`
}

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
func (s *Server) tryRefreshBrokeredGrant(ctx context.Context, zoneID, userID, resourceID string, providerID *string) *sharederr.CaracalError {
	if userID == "" {
		return nil
	}
	grant, err := s.db.GetProviderGrant(ctx, zoneID, userID, resourceID, providerID)
	if err != nil {
		return nil
	}
	now, err := s.db.CurrentTime(ctx)
	if err != nil {
		return sharederr.New(sharederr.STSUnavailable, "trusted time unavailable")
	}
	if grant.ExpiresAt != nil && grant.ExpiresAt.After(now) {
		return nil
	}
	if len(grant.RefreshTokenCt) == 0 || grant.ProviderID == nil {
		return sharederr.New(sharederr.CredentialExpired, "credential_expired_not_renewable")
	}
	return s.coordinatedGrantRefresh(ctx, refreshGrantKey(zoneID, userID, resourceID, providerID, grant), func(runCtx context.Context) *sharederr.CaracalError {
		return s.refreshExpiredBrokeredGrant(runCtx, zoneID, userID, resourceID, providerID)
	})
}

func (s *Server) refreshExpiredBrokeredGrant(ctx context.Context, zoneID, userID, resourceID string, providerID *string) *sharederr.CaracalError {
	grant, err := s.db.GetProviderGrant(ctx, zoneID, userID, resourceID, providerID)
	if err != nil {
		return nil
	}
	now, err := s.db.CurrentTime(ctx)
	if err != nil {
		return sharederr.New(sharederr.STSUnavailable, "trusted time unavailable")
	}
	if grant.ExpiresAt != nil && grant.ExpiresAt.After(now) {
		return nil
	}
	if len(grant.RefreshTokenCt) == 0 || grant.ProviderID == nil {
		return sharederr.New(sharederr.CredentialExpired, "credential_expired_not_renewable")
	}
	provider, err := s.db.GetProvider(ctx, *grant.ProviderID)
	if err != nil {
		return sharederr.New(sharederr.CredentialExpired, "credential_expired_not_renewable")
	}
	if kind := derefStr(provider.ProviderKind); kind != "oauth2_authorization_code" {
		return sharederr.New(sharederr.CredentialExpired, "credential_expired_not_renewable")
	}
	var provCfg struct {
		TokenEndpoint     string            `json:"token_endpoint"`
		ClientID          string            `json:"client_id"`
		ClientAuthMethod  string            `json:"client_auth_method"`
		AllowedTokenHosts []string          `json:"allowed_token_hosts"`
		TokenParams       map[string]string `json:"token_params"`
	}
	if err := json.Unmarshal(provider.ConfigJSON, &provCfg); err != nil || provCfg.TokenEndpoint == "" || provCfg.ClientID == "" {
		return sharederr.New(sharederr.CredentialExpired, "credential_expired_not_renewable")
	}
	secretConfig, err := openProviderSecretConfig(s.keys.zek, provider)
	if err != nil {
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
	defer clear(refreshToken)
	form := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {string(refreshToken)}}
	if err := applyOAuthTokenParams(form, provCfg.TokenParams); err != nil {
		return sharederr.New(sharederr.CredentialExpired, "provider token params invalid")
	}
	body, err := s.refreshProviderToken(ctx, provider.ID, tokenEndpoint, form, provCfg.ClientID, secretConfig.ClientSecret, provCfg.ClientAuthMethod, "", "")
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
	var newRefreshCt []byte
	if tokenResp.RefreshToken != "" {
		newRefreshCt, err = sealZEK(s.keys.zek, []byte(tokenResp.RefreshToken))
	} else {
		newRefreshCt, err = sealZEK(s.keys.zek, refreshToken)
	}
	if err != nil {
		return sharederr.New(sharederr.Internal, "token re-encryption failed")
	}
	cappedTTL := capGrantTTL(tokenResp.ExpiresIn, s.cfg.MaxGrantTTLSeconds)
	now, err = s.db.CurrentTime(ctx)
	if err != nil {
		return sharederr.New(sharederr.STSUnavailable, "trusted time unavailable")
	}
	expiresAt := now.Add(cappedTTL)
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

func (s *Server) coordinatedGrantRefresh(ctx context.Context, key string, refresh func(context.Context) *sharederr.CaracalError) *sharederr.CaracalError {
	ch := s.refreshGroup.DoChan(key, func() (any, error) {
		return nil, s.coordinatedDistributedGrantRefresh(ctx, key, refresh)
	})
	select {
	case result := <-ch:
		if result.Shared && s.metrics != nil {
			s.metrics.ProviderRefreshShared.Add(1)
		}
		if result.Err == nil {
			return nil
		}
		var caracalErr *sharederr.CaracalError
		if errors.As(result.Err, &caracalErr) {
			return caracalErr
		}
		return sharederr.New(sharederr.Internal, "credential refresh failed")
	case <-ctx.Done():
		return sharederr.New(sharederr.STSUnavailable, "credential refresh canceled")
	}
}

func (s *Server) coordinatedDistributedGrantRefresh(ctx context.Context, key string, refresh func(context.Context) *sharederr.CaracalError) *sharederr.CaracalError {
	if s.redis == nil {
		return refresh(ctx)
	}
	lockKey, resultKey := refreshCoordinationKeys(key)
	for {
		if res, ok, err := s.readRefreshResult(ctx, resultKey); err != nil {
			if s.metrics != nil {
				s.metrics.ProviderRefreshErrors.Add(1)
			}
			return sharederr.New(sharederr.STSUnavailable, "credential refresh coordination unavailable")
		} else if ok {
			if s.metrics != nil {
				s.metrics.ProviderRefreshWaited.Add(1)
			}
			return res
		}
		leaseID, err := uuid.NewV7()
		if err != nil {
			return sharederr.New(sharederr.Internal, "credential refresh lease id failed")
		}
		acquired, err := s.redis.SetNXTTL(ctx, lockKey, leaseID.String(), refreshLeaseTTL)
		if err != nil {
			if s.metrics != nil {
				s.metrics.ProviderRefreshErrors.Add(1)
			}
			return sharederr.New(sharederr.STSUnavailable, "credential refresh coordination unavailable")
		}
		if acquired {
			if s.metrics != nil {
				s.metrics.ProviderRefreshLeased.Add(1)
			}
			err := refresh(ctx)
			if setErr := s.redis.SetTTL(ctx, resultKey, refreshResultFromError(err), refreshResultTTL); setErr != nil {
				if s.metrics != nil {
					s.metrics.ProviderRefreshErrors.Add(1)
				}
				s.log.Error().Err(setErr).Msg("provider refresh result publish failed")
			}
			if delErr := s.redis.DelIfValue(context.Background(), lockKey, leaseID.String()); delErr != nil {
				if s.metrics != nil {
					s.metrics.ProviderRefreshErrors.Add(1)
				}
				s.log.Error().Err(delErr).Msg("provider refresh lease release failed")
			}
			return err
		}
		if s.metrics != nil {
			s.metrics.ProviderRefreshWaited.Add(1)
		}
		select {
		case <-ctx.Done():
			return sharederr.New(sharederr.STSUnavailable, "credential refresh canceled")
		case <-time.After(jitteredBackoff(refreshWaitInterval, 0)):
		}
	}
}

func refreshCoordinationKeys(key string) (string, string) {
	sum := sha256.Sum256([]byte(key))
	base := "provider-refresh:" + hex.EncodeToString(sum[:])
	return base + ":lock", base + ":result"
}

func refreshResultFromError(err *sharederr.CaracalError) distributedRefreshResult {
	if err == nil {
		return distributedRefreshResult{OK: true}
	}
	return distributedRefreshResult{Code: err.Code, Description: err.Description}
}

func (s *Server) readRefreshResult(ctx context.Context, key string) (*sharederr.CaracalError, bool, error) {
	raw, err := s.redis.Get(ctx, key)
	if err != nil {
		if errors.Is(err, redis.Nil) {
			return nil, false, nil
		}
		return nil, false, err
	}
	var result distributedRefreshResult
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		return nil, false, err
	}
	if result.OK {
		return nil, true, nil
	}
	if result.Code == "" {
		return sharederr.New(sharederr.Internal, "credential refresh failed"), true, nil
	}
	return sharederr.New(result.Code, result.Description), true, nil
}

func refreshGrantKey(zoneID, userID, resourceID string, providerID *string, grant *ProviderGrant) string {
	if grant != nil && grant.ID != "" {
		return "grant\x00" + grant.ID
	}
	provider := ""
	if providerID != nil {
		provider = *providerID
	}
	return zoneID + "\x00" + userID + "\x00" + resourceID + "\x00" + provider
}

type providerSecretConfig struct {
	ClientSecret string `json:"client_secret"`
	PrivateKey   string `json:"private_key"`
	APIKey       string `json:"api_key"`
	BearerToken  string `json:"bearer_token"`
}

func openProviderSecretConfig(zek []byte, provider *ProviderConfig) (providerSecretConfig, error) {
	var cfg providerSecretConfig
	if len(provider.SecretConfigCt) == 0 {
		return cfg, nil
	}
	plaintext, err := sharedcrypto.Open(zek, provider.SecretConfigNonce, provider.SecretConfigCt)
	if err != nil {
		return cfg, err
	}
	defer clear(plaintext)
	if err := json.Unmarshal(plaintext, &cfg); err != nil {
		return cfg, err
	}
	return cfg, nil
}

func normalizeOAuthClientAuthMethod(method string) string {
	switch strings.TrimSpace(method) {
	case "client_secret_post", "private_key_jwt", "none":
		return method
	default:
		return "client_secret_basic"
	}
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
	grant *ProviderGrant,
	accessCt, refreshCt []byte,
	expiresAt time.Time,
) error {
	expectedVersion := grant.RefreshTokenVersion
	for attempt := 0; attempt < grantPersistAttempts; attempt++ {
		err := s.db.UpdateProviderGrantTokens(ctx, grant.ID, expectedVersion, accessCt, refreshCt, expiresAt)
		if err == nil {
			return nil
		}
		if !errors.Is(err, ErrConcurrentGrantUpdate) {
			return err
		}
		latest, readErr := s.db.GetProviderGrant(ctx, zoneID, userID, resourceID, grant.ProviderID)
		if readErr != nil {
			return readErr
		}
		now, timeErr := s.db.CurrentTime(ctx)
		if timeErr != nil {
			return timeErr
		}
		if latest.ExpiresAt != nil && latest.ExpiresAt.After(now) {
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

func applyOAuthTokenParams(form url.Values, params map[string]string) error {
	for key, value := range params {
		name := strings.TrimSpace(key)
		text := strings.TrimSpace(value)
		if name == "" || text == "" {
			return errors.New("provider token params must be non-empty")
		}
		if _, reserved := reservedOAuthTokenParams[name]; reserved {
			return fmt.Errorf("provider token param %s is reserved", name)
		}
		form.Set(name, text)
	}
	return nil
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
	// NAT64 well-known prefix (RFC 6052) embeds an IPv4 target in the low 32 bits;
	// re-check the embedded address so 64:ff9b::<private-or-metadata-v4> cannot
	// tunnel past the guard while genuine NAT64 to public addresses still resolves.
	if embedded := nat64Embedded(ip); embedded != nil {
		return isUnsafeIP(embedded)
	}
	return false
}

// nat64WellKnownPrefix is the RFC 6052 well-known prefix 64:ff9b::/96.
var nat64WellKnownPrefix = [12]byte{0x00, 0x64, 0xff, 0x9b}

// nat64Embedded returns the IPv4 address carried in a 64:ff9b::/96 address, or
// nil when ip is not a NAT64 well-known-prefix address.
func nat64Embedded(ip net.IP) net.IP {
	if ip.To4() != nil {
		return nil
	}
	ip16 := ip.To16()
	if ip16 == nil {
		return nil
	}
	for i := 0; i < 12; i++ {
		if ip16[i] != nat64WellKnownPrefix[i] {
			return nil
		}
	}
	return net.IPv4(ip16[12], ip16[13], ip16[14], ip16[15])
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

func (s *Server) refreshProviderToken(ctx context.Context, providerID string, endpoint *url.URL, form url.Values, clientID, clientSecret, clientAuthMethod, keyID, privateKey string) ([]byte, error) {
	method := normalizeOAuthClientAuthMethod(clientAuthMethod)
	if clientID == "" {
		return nil, errors.New("provider oauth client_id missing")
	}
	if method == "private_key_jwt" && privateKey == "" {
		return nil, errors.New("provider oauth private_key missing")
	}
	if method != "none" && method != "private_key_jwt" && clientSecret == "" {
		return nil, errors.New("provider oauth client_secret missing")
	}
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
		req, err := buildProviderTokenRequest(ctx, endpoint, form, clientID, clientSecret, method, keyID, privateKey)
		if err != nil {
			return nil, err
		}
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

func buildProviderTokenRequest(ctx context.Context, endpoint *url.URL, form url.Values, clientID, clientSecret, method, keyID, privateKey string) (*http.Request, error) {
	requestForm := url.Values{}
	for key, values := range form {
		requestForm[key] = append([]string(nil), values...)
	}
	switch method {
	case "client_secret_post":
		requestForm.Set("client_id", clientID)
		requestForm.Set("client_secret", clientSecret)
	case "private_key_jwt":
		assertion, err := buildProviderClientAssertion(endpoint.String(), clientID, keyID, privateKey, time.Now().UTC())
		if err != nil {
			return nil, err
		}
		requestForm.Set("client_id", clientID)
		requestForm.Set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer")
		requestForm.Set("client_assertion", assertion)
	case "none":
		requestForm.Set("client_id", clientID)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), strings.NewReader(requestForm.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if method == "client_secret_basic" {
		req.SetBasicAuth(clientID, clientSecret)
	}
	return req, nil
}

func buildProviderClientAssertion(audience, clientID, keyID, privateKey string, now time.Time) (string, error) {
	method, key, err := providerSigningKey(privateKey)
	if err != nil {
		return "", err
	}
	token := jwt.NewWithClaims(method, jwt.MapClaims{
		"iss": clientID,
		"sub": clientID,
		"aud": audience,
		"iat": now.Unix(),
		"exp": now.Add(time.Minute).Unix(),
		"jti": uuid.NewString(),
	})
	if text := strings.TrimSpace(keyID); text != "" {
		token.Header["kid"] = text
	}
	return token.SignedString(key)
}

func providerSigningKey(privateKey string) (jwt.SigningMethod, any, error) {
	block, _ := pem.Decode([]byte(privateKey))
	if block == nil {
		return nil, nil, errors.New("provider oauth private_key must be PEM encoded")
	}
	if key, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		return providerSigningMethod(key)
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return jwt.SigningMethodRS256, key, nil
	}
	if key, err := x509.ParseECPrivateKey(block.Bytes); err == nil {
		return providerECDSASigningMethod(key)
	}
	return nil, nil, errors.New("provider oauth private_key is unsupported")
}

func providerSigningMethod(key any) (jwt.SigningMethod, any, error) {
	switch typed := key.(type) {
	case *rsa.PrivateKey:
		return jwt.SigningMethodRS256, typed, nil
	case *ecdsa.PrivateKey:
		return providerECDSASigningMethod(typed)
	default:
		return nil, nil, errors.New("provider oauth private_key is unsupported")
	}
}

func providerECDSASigningMethod(key *ecdsa.PrivateKey) (jwt.SigningMethod, any, error) {
	switch key.Curve {
	case elliptic.P256():
		return jwt.SigningMethodES256, key, nil
	case elliptic.P384():
		return jwt.SigningMethodES384, key, nil
	case elliptic.P521():
		return jwt.SigningMethodES512, key, nil
	default:
		return nil, nil, errors.New("provider oauth private_key curve is unsupported")
	}
}

func (s *Server) providerCircuitOpen(ctx context.Context, providerID string) bool {
	if s.redis == nil {
		return false
	}
	open, err := s.redis.Exists(ctx, "provider-refresh-circuit:"+providerID)
	if open && s.metrics != nil {
		s.metrics.ProviderCircuitOpen.Add(1)
	}
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
