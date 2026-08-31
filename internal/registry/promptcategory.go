// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"strings"

	"github.com/garudex-labs/caracal/internal/promptcat"
)

// promptCategory validates and normalizes the request's prompt category and is
// the authoritative server-side gate. An absent or blank value defaults to the
// shared default; a present value that cannot be normalized records a field
// error. The result is always a canonical slug so storage, filtering, and file
// materialization all see one form regardless of how the client spelled it.
func (b *draftBody) promptCategory() string {
	raw := strings.TrimSpace(b.str("category", ""))
	if raw == "" {
		return promptcat.DefaultCategory
	}
	norm, ok := promptcat.Normalize(raw)
	if !ok {
		b.fail("value_error", "category",
			"Value error, category must be lowercase letters, digits, and hyphens (max 32 characters)",
			map[string]any{"error": map[string]any{}})
		return promptcat.DefaultCategory
	}
	return norm
}
