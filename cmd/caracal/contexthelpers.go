// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

var orgSlugRule = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$`)

func validOrgSlug(op, value string) (string, *clierr.Error) {
	slug := strings.ToLower(strings.TrimSpace(value))
	if !orgSlugRule.MatchString(slug) {
		return "", &clierr.Error{
			Category: clierr.Validation, Message: fmt.Sprintf("Invalid organization id: %s.", value),
			Operation: op, Resource: "organization",
			Remediation: "Organization ids must be 3-32 characters using lowercase letters, numbers, and hyphens, and must start and end with a letter or number",
		}
	}
	return slug, nil
}

func validProjectSlug(op, value string) (string, *clierr.Error) {
	slug := strings.ToLower(strings.TrimSpace(value))
	if slug == "" || len(slug) > 64 || strings.Contains(slug, "/") {
		return "", &clierr.Error{
			Category: clierr.Validation, Message: fmt.Sprintf("Invalid project id: %s.", value),
			Operation: op, Resource: "project",
			Remediation: "Use the project slug shown by `caracal use --list`.",
		}
	}
	return slug, nil
}
