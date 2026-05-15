// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Centralized secret-key redaction shared across all Caracal logging surfaces.

package logging

import "strings"

// SecretKeys are the field names whose values must never appear in dev logs.
// Mirror this list in the TS and Python core packages.
var SecretKeys = []string{
	"password",
	"secret",
	"token",
	"access_token",
	"refresh_token",
	"id_token",
	"api_key",
	"client_secret",
	"private_key",
	"session",
	"assertion",
	"authorization",
	"cookie",
	"set_cookie",
	"hmac",
	"signature",
}

// IsSecretKey reports whether the given field name should be redacted.
// Matching is case-insensitive and substring-based so that variants like
// "ApiKey", "X-Auth-Token", and "user_password" are caught.
func IsSecretKey(name string) bool {
	lower := strings.ToLower(name)
	for _, k := range SecretKeys {
		if strings.Contains(lower, k) {
			return true
		}
	}
	return false
}

// RedactValue returns the canonical replacement for redacted values.
const RedactValue = "***"

// RedactMap returns a copy of m with values for secret keys replaced.
func RedactMap(m map[string]any) map[string]any {
	if m == nil {
		return nil
	}
	out := make(map[string]any, len(m))
	for k, v := range m {
		if IsSecretKey(k) {
			out[k] = RedactValue
			continue
		}
		if nested, ok := v.(map[string]any); ok {
			out[k] = RedactMap(nested)
			continue
		}
		out[k] = v
	}
	return out
}
