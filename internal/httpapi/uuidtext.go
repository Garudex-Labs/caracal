// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package httpapi

import (
	"fmt"
	"strings"
)

// UUIDErrorText reproduces the uuid error taxonomy used across the API's
// path-parameter validation responses.
func UUIDErrorText(raw string) string {
	body := strings.TrimPrefix(raw, "urn:uuid:")
	offset := len(raw) - len(body)
	for i, c := range body {
		isHex := (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
		if !isHex && c != '-' {
			return fmt.Sprintf(
				"invalid character: expected an optional prefix of `urn:uuid:` followed by [0-9a-fA-F-], found `%c` at %d",
				c, offset+i+1)
		}
	}
	if strings.Contains(body, "-") {
		groups := strings.Split(body, "-")
		if len(groups) != 5 {
			return fmt.Sprintf("invalid group count: expected 5, found %d", len(groups))
		}
		want := []int{8, 4, 4, 4, 12}
		for i, g := range groups {
			if len(g) != want[i] {
				return fmt.Sprintf("invalid group length in group %d: expected %d, found %d", i, want[i], len(g))
			}
		}
	}
	return fmt.Sprintf("invalid length: expected length 32 for simple format, found %d", len(body))
}
