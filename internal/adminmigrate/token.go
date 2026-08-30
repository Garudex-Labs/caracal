// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package adminmigrate

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// TokenSigner mints and verifies the short-lived download tokens that gate
// artifact downloads. Tokens are HS256 JWTs signed with the server secret;
// the same service both issues and consumes them.
type TokenSigner struct {
	Secret []byte
	Now    func() time.Time // test seam; defaults to time.Now
}

func (s *TokenSigner) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

var tokenHeader = base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))

func (s *TokenSigner) mac(signingInput string) []byte {
	h := hmac.New(sha256.New, s.Secret)
	h.Write([]byte(signingInput))
	return h.Sum(nil)
}

// Sign encodes the claims as a signed token.
func (s *TokenSigner) Sign(claims map[string]any) (string, error) {
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	signingInput := tokenHeader + "." + base64.RawURLEncoding.EncodeToString(payload)
	sig := base64.RawURLEncoding.EncodeToString(s.mac(signingInput))
	return signingInput + "." + sig, nil
}

var errInvalidToken = errors.New("invalid token")

// Verify checks the signature and expiry and returns the claims.
func (s *TokenSigner) Verify(token string) (map[string]any, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errInvalidToken
	}
	headerRaw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, errInvalidToken
	}
	var header struct {
		Alg string `json:"alg"`
	}
	if err := json.Unmarshal(headerRaw, &header); err != nil || header.Alg != "HS256" {
		return nil, errInvalidToken
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, errInvalidToken
	}
	if !hmac.Equal(sig, s.mac(parts[0]+"."+parts[1])) {
		return nil, errInvalidToken
	}
	payloadRaw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, errInvalidToken
	}
	var claims map[string]any
	if err := json.Unmarshal(payloadRaw, &claims); err != nil {
		return nil, errInvalidToken
	}
	if exp, ok := claims["exp"]; ok {
		expF, ok := exp.(float64)
		if !ok || float64(s.now().Unix()) > expF {
			return nil, fmt.Errorf("token expired")
		}
	}
	return claims, nil
}
