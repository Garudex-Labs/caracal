// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Upstream credential-header safety rules shared by STS and Gateway.

package sts

import "strings"

var reservedUpstreamCredentialHeaders = map[string]struct{}{
	"baggage":             {},
	"connection":          {},
	"content-encoding":    {},
	"content-length":      {},
	"content-type":        {},
	"expect":              {},
	"forwarded":           {},
	"host":                {},
	"keep-alive":          {},
	"proxy-authenticate":  {},
	"proxy-authorization": {},
	"te":                  {},
	"traceparent":         {},
	"tracestate":          {},
	"trailer":             {},
	"transfer-encoding":   {},
	"upgrade":             {},
	"via":                 {},
	"x-real-ip":           {},
	"x-request-id":        {},
}

// ValidUpstreamCredentialHeader reports whether a provider credential may be
// placed in name without overriding transport framing or Caracal-owned metadata.
func ValidUpstreamCredentialHeader(name string) bool {
	name = strings.TrimSpace(name)
	if !validHeaderFieldName(name) {
		return false
	}
	name = strings.ToLower(name)
	if strings.HasPrefix(name, "x-caracal-") || strings.HasPrefix(name, "x-forwarded-") || strings.HasPrefix(name, "proxy-") {
		return false
	}
	_, reserved := reservedUpstreamCredentialHeaders[name]
	return !reserved
}

func validHeaderFieldName(name string) bool {
	if name == "" {
		return false
	}
	for i := 0; i < len(name); i++ {
		char := name[i]
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') {
			continue
		}
		switch char {
		case '!', '#', '$', '%', '&', '\'', '*', '+', '-', '.', '^', '_', '`', '|', '~':
			continue
		default:
			return false
		}
	}
	return true
}
