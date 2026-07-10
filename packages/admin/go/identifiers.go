// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Identifier helpers for provider and resource audience strings.

package admin

import (
	"net/url"
	"regexp"
	"strings"
)

const (
	providerIdentifierPrefix = "provider://"
	resourceIdentifierPrefix = "resource://"
)

var providerIdentifierPattern = regexp.MustCompile(`^provider://[a-z0-9]+(?:-[a-z0-9]+)*$`)

func slugValue(value, fallback string) string {
	var slug strings.Builder
	separator := false
	for _, character := range strings.ToLower(strings.TrimSpace(value)) {
		if (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') {
			if separator && slug.Len() > 0 {
				slug.WriteByte('-')
			}
			slug.WriteRune(character)
			separator = false
		} else {
			separator = true
		}
	}
	if slug.Len() == 0 {
		return fallback
	}
	return slug.String()
}

// ProviderIdentifier normalizes a value into a provider:// audience slug.
func ProviderIdentifier(value string) string {
	base := strings.TrimPrefix(strings.TrimSpace(value), providerIdentifierPrefix)
	return providerIdentifierPrefix + slugValue(base, "provider")
}

// IsProviderIdentifier reports whether the value is a canonical provider://
// audience.
func IsProviderIdentifier(value string) bool {
	return providerIdentifierPattern.MatchString(value)
}

// ResourceIdentifier normalizes a value into a resource audience, preserving
// absolute URIs.
func ResourceIdentifier(value string) string {
	text := strings.TrimSpace(value)
	if IsResourceIdentifier(text, "") {
		return text
	}
	base := strings.TrimPrefix(text, resourceIdentifierPrefix)
	return resourceIdentifierPrefix + slugValue(base, "resource")
}

// IsResourceIdentifier reports whether the value is a resource audience: the
// control audience or an absolute URI that is not provider-scoped and
// carries no credentials.
func IsResourceIdentifier(value, controlAudience string) bool {
	if controlAudience != "" && value == controlAudience {
		return true
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return false
	}
	return parsed.Scheme != "" && parsed.Scheme != "provider" && parsed.User == nil
}
