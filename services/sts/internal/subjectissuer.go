// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// External subject federation: trusted-issuer lookup, JWKS retrieval, and id_token validation.

package internal

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	sharederr "github.com/garudex-labs/caracal/packages/core/go/errors"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// SubjectTokenTypeIDToken selects the subject federation exchange: the application
// presents its end user's identity token from a zone-trusted external issuer, and
// the STS mints a user subject session for that identity.
const SubjectTokenTypeIDToken = "urn:ietf:params:oauth:token-type:id_token"

const (
	subjectJWKSCacheTTL   = 10 * time.Minute
	subjectJWKSTimeout    = 5 * time.Second
	subjectJWKSMaxBytes   = 256 * 1024
	subjectTokenMaxLeeway = 60 * time.Second
	subjectIDMaxBytes     = 512
)

// subjectSigningMethods are the external token algorithms accepted for federation.
// Symmetric algorithms are excluded categorically: a shared-secret token proves
// nothing about issuer identity.
var subjectSigningMethods = []string{"RS256", "RS384", "RS512", "ES256", "ES384", "ES512"}

// SubjectIssuer is a zone-scoped trust declaration for one external identity
// system: tokens whose iss matches are verified against the issuer's JWKS and
// must carry the configured audience.
type SubjectIssuer struct {
	ID       string
	ZoneID   string
	Issuer   string
	JWKSURL  string
	Audience string
}

// GetSubjectIssuerByIssuer resolves the active trust declaration for an exact
// issuer string inside one zone.
func (d *DB) GetSubjectIssuerByIssuer(ctx context.Context, zoneID, issuer string) (*SubjectIssuer, error) {
	var si SubjectIssuer
	err := d.pool.QueryRow(ctx,
		`SELECT id, zone_id, issuer, jwks_url, audience
		 FROM subject_issuers
		 WHERE zone_id = $1 AND issuer = $2 AND archived_at IS NULL`, zoneID, issuer,
	).Scan(&si.ID, &si.ZoneID, &si.Issuer, &si.JWKSURL, &si.Audience)
	if err != nil {
		return nil, err
	}
	return &si, nil
}

type subjectKeySet struct {
	keys      map[string]any
	fetchedAt time.Time
}

// subjectKeyCache caches one parsed JWKS per issuer row. Entries expire on a hard
// TTL so a rotated upstream key is picked up promptly and a stale document is
// never trusted indefinitely; fetch is injectable for tests.
type subjectKeyCache struct {
	mu    sync.Mutex
	byID  map[string]subjectKeySet
	fetch func(ctx context.Context, jwksURL string) ([]byte, error)
}

func newSubjectKeyCache() *subjectKeyCache {
	return &subjectKeyCache{byID: map[string]subjectKeySet{}, fetch: fetchSubjectJWKS}
}

// fetchSubjectJWKS retrieves a JWKS document through the SSRF-guarded client:
// HTTPS only, private and loopback address classes blocked at resolve and at
// connect, redirects disabled, and the response size capped.
func fetchSubjectJWKS(ctx context.Context, jwksURL string) ([]byte, error) {
	u, err := url.Parse(jwksURL)
	if err != nil {
		return nil, err
	}
	if u.Scheme != "https" || u.Hostname() == "" {
		return nil, errors.New("subject issuer jwks_url must be https")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := safeHTTPClient(subjectJWKSTimeout).Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("subject issuer jwks fetch returned status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, subjectJWKSMaxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > subjectJWKSMaxBytes {
		return nil, errors.New("subject issuer jwks document too large")
	}
	return body, nil
}

func (c *subjectKeyCache) keysFor(ctx context.Context, issuer *SubjectIssuer) (map[string]any, error) {
	c.mu.Lock()
	cached, ok := c.byID[issuer.ID]
	c.mu.Unlock()
	if ok && time.Since(cached.fetchedAt) < subjectJWKSCacheTTL {
		return cached.keys, nil
	}
	body, err := c.fetch(ctx, issuer.JWKSURL)
	if err != nil {
		// A stale-but-parsed key set is never served past its TTL: signature trust
		// fails closed with the fetch error instead of degrading silently.
		return nil, err
	}
	keys, err := parseSubjectJWKS(body)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	c.byID[issuer.ID] = subjectKeySet{keys: keys, fetchedAt: time.Now()}
	c.mu.Unlock()
	return keys, nil
}

type subjectJWK struct {
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	Use string `json:"use"`
	N   string `json:"n"`
	E   string `json:"e"`
	Crv string `json:"crv"`
	X   string `json:"x"`
	Y   string `json:"y"`
}

// parseSubjectJWKS decodes the RSA and EC public keys of an RFC 7517 document,
// keyed by kid. Keys marked for non-signature use and unsupported key types are
// skipped; a document yielding no usable key is an error.
func parseSubjectJWKS(body []byte) (map[string]any, error) {
	var doc struct {
		Keys []subjectJWK `json:"keys"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, fmt.Errorf("parse subject issuer jwks: %w", err)
	}
	keys := map[string]any{}
	for _, k := range doc.Keys {
		if k.Kid == "" || (k.Use != "" && k.Use != "sig") {
			continue
		}
		switch k.Kty {
		case "RSA":
			pub, err := rsaPublicKeyFromJWK(k)
			if err != nil {
				continue
			}
			keys[k.Kid] = pub
		case "EC":
			pub, err := ecPublicKeyFromJWK(k)
			if err != nil {
				continue
			}
			keys[k.Kid] = pub
		}
	}
	if len(keys) == 0 {
		return nil, errors.New("subject issuer jwks contains no usable signing keys")
	}
	return keys, nil
}

func rsaPublicKeyFromJWK(k subjectJWK) (*rsa.PublicKey, error) {
	nBytes, err := base64.RawURLEncoding.DecodeString(k.N)
	if err != nil {
		return nil, err
	}
	eBytes, err := base64.RawURLEncoding.DecodeString(k.E)
	if err != nil {
		return nil, err
	}
	if len(nBytes) == 0 || len(eBytes) == 0 {
		return nil, errors.New("empty rsa jwk component")
	}
	e := new(big.Int).SetBytes(eBytes)
	if !e.IsInt64() || e.Int64() < 3 || e.Int64() > 1<<31-1 {
		return nil, errors.New("rsa jwk exponent out of range")
	}
	return &rsa.PublicKey{N: new(big.Int).SetBytes(nBytes), E: int(e.Int64())}, nil
}

func ecPublicKeyFromJWK(k subjectJWK) (*ecdsa.PublicKey, error) {
	var curve elliptic.Curve
	switch k.Crv {
	case "P-256":
		curve = elliptic.P256()
	case "P-384":
		curve = elliptic.P384()
	case "P-521":
		curve = elliptic.P521()
	default:
		return nil, errors.New("unsupported ec curve")
	}
	xBytes, err := base64.RawURLEncoding.DecodeString(k.X)
	if err != nil {
		return nil, err
	}
	yBytes, err := base64.RawURLEncoding.DecodeString(k.Y)
	if err != nil {
		return nil, err
	}
	x := new(big.Int).SetBytes(xBytes)
	y := new(big.Int).SetBytes(yBytes)
	if !curve.IsOnCurve(x, y) {
		return nil, errors.New("ec jwk point not on curve")
	}
	return &ecdsa.PublicKey{Curve: curve, X: x, Y: y}, nil
}

// validateSubjectIdentifier admits any stable identifier format an issuer may
// use - UUIDs, emails, numeric ids, prefixed ids like auth0|..., URIs, unicode
// names - while rejecting only values that are unsafe to store, index, log, or
// display. The identifier is never parsed, normalized, or case-folded: Caracal
// compares it byte-for-byte everywhere, so two byte-distinct values are two
// subjects. The rejections are exactly:
//   - empty, or longer than 512 bytes (well under the btree index row bound);
//   - invalid UTF-8, or containing U+FFFD (a replacement char would let two
//     byte-distinct upstream values collapse into one stored identity);
//   - control characters, including NUL (Postgres text rejects it), newlines,
//     and escape sequences that enable log forging;
//   - explicit bidirectional-override characters that can visually reorder
//     surrounding UI text (U+202A-U+202E, U+2066-U+2069);
//   - leading or trailing whitespace, rejected rather than trimmed so the
//     recorded value is always byte-identical to what the issuer signed.
func validateSubjectIdentifier(sub string) error {
	if sub == "" {
		return errors.New("subject token carries no sub")
	}
	if len(sub) > subjectIDMaxBytes {
		return fmt.Errorf("sub exceeds %d bytes", subjectIDMaxBytes)
	}
	if !utf8.ValidString(sub) {
		return errors.New("sub is not valid UTF-8")
	}
	if strings.TrimSpace(sub) != sub {
		return errors.New("sub carries leading or trailing whitespace")
	}
	for _, r := range sub {
		switch {
		case unicode.IsControl(r):
			return errors.New("sub contains control characters")
		case r == utf8.RuneError:
			return errors.New("sub contains the unicode replacement character")
		case r >= 0x202A && r <= 0x202E, r >= 0x2066 && r <= 0x2069:
			return errors.New("sub contains bidirectional control characters")
		}
	}
	return nil
}

// validateExternalSubjectToken verifies an end user's identity token against the
// zone's registered issuer trust: exact issuer match, issuer JWKS signature with
// an allowlisted asymmetric algorithm, configured audience, required expiry, and
// a safe opaque subject. The returned sub is the federated subject identity,
// recorded verbatim - the STS never rewrites, trims, or generates it.
func (s *Server) validateExternalSubjectToken(ctx context.Context, zoneID, tokenStr string) (string, *SubjectIssuer, error) {
	unverified := jwt.MapClaims{}
	if _, _, err := jwt.NewParser().ParseUnverified(tokenStr, unverified); err != nil {
		return "", nil, fmt.Errorf("malformed subject token: %w", err)
	}
	iss := claimString(unverified, "iss")
	if iss == "" {
		return "", nil, errors.New("subject token carries no issuer")
	}
	issuer, err := s.db.GetSubjectIssuerByIssuer(ctx, zoneID, iss)
	if err != nil {
		return "", nil, fmt.Errorf("issuer %q is not trusted by this zone", iss)
	}
	keys, err := s.subjectKeys.keysFor(ctx, issuer)
	if err != nil {
		return "", nil, err
	}
	mc := jwt.MapClaims{}
	_, err = jwt.NewParser(
		jwt.WithValidMethods(subjectSigningMethods),
		jwt.WithIssuer(issuer.Issuer),
		jwt.WithAudience(issuer.Audience),
		jwt.WithExpirationRequired(),
		jwt.WithIssuedAt(),
		jwt.WithLeeway(subjectTokenMaxLeeway),
	).ParseWithClaims(tokenStr, mc, func(token *jwt.Token) (any, error) {
		kid, ok := token.Header["kid"].(string)
		if !ok || kid == "" {
			return nil, errors.New("subject token missing kid header")
		}
		pub, found := keys[kid]
		if !found {
			return nil, fmt.Errorf("unknown signing key kid %q for issuer %s", kid, issuer.Issuer)
		}
		return pub, nil
	})
	if err != nil {
		return "", nil, err
	}
	sub := claimString(mc, "sub")
	if err := validateSubjectIdentifier(sub); err != nil {
		return "", nil, err
	}
	return sub, issuer, nil
}

// federateSubject mints a user subject session from an end user's external
// identity token. The authenticated application vouches for nothing beyond
// relaying the token: the zone's issuer registration is the trust decision, the
// issuer's signature is the identity proof, and the recorded sub is copied
// verbatim. The minted session carries no scopes and no resource authority - it
// is the identity anchor for attribution, approvals, provider connections, and
// revocation, never an authorization input.
func (s *Server) federateSubject(ctx context.Context, req TokenExchangeRequest, app *Application, zoneID, requestID string) (*TokenResponse, *challengeState, int, *sharederr.CaracalError) {
	appMeta := applicationAuditMeta(app)
	if len(req.Resources) > 0 || req.Scope != "" || req.ActorToken != "" ||
		req.SessionID != "" || req.AgentSessionID != "" || req.DelegationEdgeID != "" || req.ChallengeID != "" {
		if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "subject_federation_invalid", &OPAResult{}, appMeta); auditErr != nil {
			return nil, nil, http.StatusInternalServerError, auditErr
		}
		return nil, nil, http.StatusBadRequest, sharederr.New(sharederr.InvalidToken,
			"a subject federation exchange carries only the identity token: no resources, scopes, actor, session, delegation, or challenge parameters")
	}
	if req.SubjectToken == "" {
		return nil, nil, http.StatusBadRequest, sharederr.New(sharederr.InvalidToken, "subject_token is required")
	}
	now, timeErr := s.db.CurrentTime(ctx)
	if timeErr != nil {
		return nil, nil, http.StatusServiceUnavailable, sharederr.New(sharederr.STSUnavailable, "trusted time unavailable")
	}
	sub, issuer, err := s.validateExternalSubjectToken(ctx, zoneID, req.SubjectToken)
	if err != nil {
		if auditErr := s.emitAuditEvent(requestID, zoneID, "deny", "subject_federation_rejected", &OPAResult{},
			mergeAuditMeta(appMeta, map[string]any{"reason": err.Error()})); auditErr != nil {
			return nil, nil, http.StatusInternalServerError, auditErr
		}
		return nil, nil, http.StatusUnauthorized, sharederr.New(sharederr.InvalidToken, "invalid subject_token: "+err.Error())
	}
	ttl, ttlErr := tokenTTL(req.TTLSeconds, true)
	if ttlErr != nil {
		return nil, nil, http.StatusBadRequest, sharederr.New(sharederr.InvalidToken, ttlErr.Error())
	}
	sid, err := uuid.NewV7()
	if err != nil {
		return nil, nil, http.StatusInternalServerError, sharederr.New(sharederr.Internal, "generate session id")
	}
	sessID := sid.String()
	// The issuer rides on the session record so operators can answer "where did
	// this subject come from" without correlating audit events.
	provenance, err := json.Marshal(map[string]string{"iss": issuer.Issuer})
	if err != nil {
		return nil, nil, http.StatusInternalServerError, sharederr.New(sharederr.Internal, "session creation failed")
	}
	if err := s.db.InsertSession(ctx, &Session{
		ID:              sessID,
		ZoneID:          zoneID,
		SessionType:     "user",
		SubjectID:       &sub,
		Status:          "active",
		ExpiresAt:       now.Add(ttl),
		AuthenticatedAt: now,
		ClaimsJSON:      provenance,
	}); err != nil {
		return nil, nil, http.StatusInternalServerError, sharederr.New(sharederr.Internal, "session creation failed")
	}
	result := &OPAResult{
		Decision:            "allow",
		DeterminingPolicies: []map[string]any{{"policy": "caracal-subject-federation"}},
		EvaluationStatus:    "complete",
		Diagnostics:         []map[string]any{},
	}
	if auditErr := s.emitAuditEvent(requestID, zoneID, result.Decision, result.EvaluationStatus, result,
		mergeAuditMeta(appMeta, map[string]any{"issuer": issuer.Issuer, "session_id": sessID, "sub_type": SubTypeUser})); auditErr != nil {
		return nil, nil, http.StatusInternalServerError, auditErr
	}
	token, jti, err := issueToken(ctx, IssueParams{
		ZoneID:    zoneID,
		AppID:     app.ID,
		SubjectID: sub,
		SubType:   SubTypeUser,
		Use:       UseSession,
		SID:       sessID,
		RootSID:   sessID,
		TTL:       ttl,
		IssuedAt:  now,
	}, s.keys, s.cfg.IssuerURL)
	if err != nil {
		s.log.Error().Err(err).Str("zone_id", zoneID).Str("request_id", requestID).Msg("subject federation token issuance failed")
		return nil, nil, http.StatusInternalServerError, sharederr.New(sharederr.Internal, "token issuance failed")
	}
	if err := s.recordIssuedJTI(ctx, jti, app.ID, zoneID, requestID, ttl); err != nil {
		return nil, nil, http.StatusInternalServerError, sharederr.New(sharederr.Internal, "token issuance failed")
	}
	return &TokenResponse{
		AccessToken:     token,
		TokenType:       "Bearer",
		ExpiresIn:       int(ttl.Seconds()),
		IssuedTokenType: "urn:ietf:params:oauth:token-type:access_token",
	}, nil, http.StatusOK, nil
}
