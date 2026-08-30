// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package auth verifies Caracal access tokens.
//
// Tokens are short-lived JWTs issued by the Better Auth identity service
// (ES256 or RS256) and verified here against its published JWKS. The token
// subject is the identity-service user id; the identity package maps it to
// the registry account.
package auth

import (
	"context"
	"crypto/ecdsa"
	"crypto/rsa"
	"errors"
	"fmt"
	"strings"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// ErrInvalidToken covers malformed, expired, mis-signed, and
// wrong-audience tokens.
var ErrInvalidToken = errors.New("auth: invalid token")

// Claims is the validated identity carried by an access token.
type Claims struct {
	// UserID is the identity-service subject (Better Auth user id).
	UserID      uuid.UUID
	Role        string
	Email       string
	Name        string
	AuthContext string
	Groups      []string
}

const (
	AuthContextTenant   = "tenant"
	AuthContextOperator = "operator"
)

// Authenticator validates bearer tokens: signature, expiry, and audience.
type Authenticator struct {
	keys     *KeySet
	audience string
	issuer   string
}

// New assembles an Authenticator from a JWKS key source. The audience must
// match the identity service's JWT audience claim; an empty issuer skips
// issuer validation.
func New(keys *KeySet, audience, issuer string) *Authenticator {
	return &Authenticator{keys: keys, audience: audience, issuer: issuer}
}

// BearerToken extracts the token from an Authorization header value.
func BearerToken(header string) (string, bool) {
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return "", false
	}
	token := strings.TrimSpace(header[len(prefix):])
	return token, token != ""
}

// Authenticate verifies an access token.
func (a *Authenticator) Authenticate(ctx context.Context, token string) (Claims, error) {
	options := []jwt.ParserOption{
		jwt.WithValidMethods([]string{"ES256", "RS256"}),
		// The identity service always issues exp; a token without one is not ours.
		jwt.WithExpirationRequired(),
	}
	if a.audience != "" {
		options = append(options, jwt.WithAudience(a.audience))
	}
	if a.issuer != "" {
		options = append(options, jwt.WithIssuer(a.issuer))
	}
	parsed, err := jwt.NewParser(options...).Parse(token, func(t *jwt.Token) (any, error) {
		kid, _ := t.Header["kid"].(string)
		if kid == "" {
			return nil, errors.New("token is missing a key id")
		}
		key, err := a.keys.Key(ctx, kid)
		if err != nil {
			return nil, err
		}
		// The declared alg must match the resolved key's type, so a token
		// cannot select a weaker scheme than its signing key (alg confusion).
		switch key.(type) {
		case *ecdsa.PublicKey:
			if t.Method.Alg() != "ES256" {
				return nil, errors.New("token algorithm does not match its signing key")
			}
		case *rsa.PublicKey:
			if t.Method.Alg() != "RS256" {
				return nil, errors.New("token algorithm does not match its signing key")
			}
		default:
			return nil, fmt.Errorf("unsupported key type %T", key)
		}
		return key, nil
	})
	if err != nil {
		return Claims{}, fmt.Errorf("%w: %w", ErrInvalidToken, err)
	}

	mc, ok := parsed.Claims.(jwt.MapClaims)
	if !ok {
		return Claims{}, fmt.Errorf("%w: unexpected claims shape", ErrInvalidToken)
	}
	sub, _ := mc["sub"].(string)
	userID, err := uuid.Parse(sub)
	if err != nil {
		return Claims{}, fmt.Errorf("%w: subject is not a user id", ErrInvalidToken)
	}

	claims := Claims{UserID: userID}
	role, _ := mc["role"].(string)
	claims.Role = role
	claims.Email, _ = mc["email"].(string)
	claims.Name, _ = mc["name"].(string)
	claims.AuthContext, _ = mc["auth_context"].(string)
	if groups, ok := mc["groups"].([]any); ok {
		for _, g := range groups {
			if s, ok := g.(string); ok {
				claims.Groups = append(claims.Groups, s)
			}
		}
	}
	return claims, nil
}
