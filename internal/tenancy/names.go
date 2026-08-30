// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package tenancy

import (
	"fmt"
	"regexp"
	"strings"
)

// Namespace charset shared with the CLI and the web UI's registry-name rules.
var namespaceRe = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,30}[a-z0-9]$`)

// NamespaceRuleText is the human-readable rule, reused verbatim in errors.
const NamespaceRuleText = "Namespaces must be 3-32 characters using lowercase letters, numbers, " +
	"hyphens, and dots, and must start and end with a letter or number"

var slugRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

// ReservedNamespaces are registry handles that collide with API path segments.
var ReservedNamespaces = map[string]bool{
	"admin": true, "api": true, "auth": true, "registry": true,
	"root": true, "system": true, "teams": true, "users": true,
}

// ReservedSlugs collide with the action sub-routes under a listing prefix.
var ReservedSlugs = map[string]bool{
	"archive": true, "draft": true, "install": true, "resolve": true,
	"restore": true, "submit": true, "unarchive": true, "versions": true,
}

// IsValidNamespace reports whether handle can be used verbatim.
func IsValidNamespace(handle string) bool {
	value := strings.ToLower(strings.TrimSpace(handle))
	if value == "" || strings.Contains(value, "..") {
		return false
	}
	return namespaceRe.MatchString(value)
}

// ValidateNamespace normalizes and validates a namespace handle.
func ValidateNamespace(handle string, allowReserved bool) (string, error) {
	value := strings.ToLower(strings.TrimSpace(handle))
	if !IsValidNamespace(value) {
		return "", fmt.Errorf("%s", NamespaceRuleText)
	}
	if !allowReserved && ReservedNamespaces[value] {
		return "", fmt.Errorf("Namespace '%s' is reserved", value)
	}
	return value, nil
}

var slugStrip = regexp.MustCompile(`[^a-z0-9_-]+`)

// Slugify reduces a display name to a valid listing slug.
func Slugify(value string) (string, error) {
	slug := strings.Trim(slugStrip.ReplaceAllString(strings.ToLower(strings.TrimSpace(value)), "-"), "-_")
	if slug == "" {
		return "", fmt.Errorf("Name must contain at least one letter or number")
	}
	if c := slug[0]; (c < 'a' || c > 'z') && (c < '0' || c > '9') {
		slug = "item-" + slug
	}
	if len(slug) > 64 {
		slug = slug[:64]
	}
	slug = strings.TrimRight(slug, "-_")
	return ValidateSlug(slug, false)
}

// ValidateSlug normalizes and validates a listing slug.
func ValidateSlug(slug string, allowReserved bool) (string, error) {
	value := strings.ToLower(strings.TrimSpace(slug))
	if !slugRe.MatchString(value) {
		return "", fmt.Errorf("Slug must be at most 64 characters, start with a letter or number, " +
			"and contain only lowercase letters, numbers, hyphens, and underscores")
	}
	if !allowReserved && ReservedSlugs[value] {
		return "", fmt.Errorf("Slug '%s' is reserved", value)
	}
	return value, nil
}

var handleStrip = regexp.MustCompile(`[^a-z0-9-]+`)

// SlugifyHandle reduces raw text to a namespace-valid handle (3-32 chars).
func SlugifyHandle(raw, fallback string) (string, error) {
	if fallback == "" {
		fallback = "user"
	}
	base := strings.Trim(handleStrip.ReplaceAllString(strings.ToLower(strings.TrimSpace(raw)), "-"), "-")
	if base == "" {
		base = fallback
	}
	// Namespaces require 3-32 chars; keep short names recognizable.
	if len(base) > 32 {
		base = strings.TrimRight(base[:32], "-")
	}
	if len(base) < 3 {
		base += "-team"
	}
	return ValidateNamespace(base, true)
}

// NamespaceForUser derives the personal publish namespace from the username.
func NamespaceForUser(u User) (string, error) {
	if u.Username == "" {
		return "", fmt.Errorf("A username is required before publishing registry items")
	}
	if !IsValidNamespace(u.Username) {
		return "", fmt.Errorf(
			"Your username '%s' cannot be used as a registry namespace. %s. "+
				"Pick a valid username first: `caracal auth set-username <name>`, or Account "+
				"settings in the web UI", u.Username, NamespaceRuleText)
	}
	// Now-reserved usernames on existing deployments stay usable.
	return ValidateNamespace(u.Username, true)
}

// QualifiedName joins the two halves of a registry identity.
func QualifiedName(namespace, slug string) string { return namespace + "/" + slug }
