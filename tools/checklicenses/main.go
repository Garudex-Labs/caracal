// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Command checklicenses checks ScanCode scan results for prohibited licenses.
package main

import (
	"encoding/json"
	"fmt"
	"os"
)

type entry struct {
	path    string
	license string
}

func getString(m map[string]any, key, fallback string) string {
	if s, ok := m[key].(string); ok {
		return s
	}
	return fallback
}

func main() {
	if len(os.Args) != 2 {
		fmt.Println("Usage: checklicenses <scan-results.json>")
		os.Exit(2)
	}

	raw, err := os.ReadFile(os.Args[1])
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
	var data map[string]any
	if err := json.Unmarshal(raw, &data); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	files, ok := data["files"].([]any)
	if !ok {
		fmt.Println("::error::Unexpected ScanCode output format (no 'files' list)")
		os.Exit(2)
	}

	var violations []entry
	var restricted []entry

	for _, item := range files {
		resource, ok := item.(map[string]any)
		if !ok {
			continue
		}
		policies, _ := resource["license_policy"].([]any)
		for _, p := range policies {
			policy, ok := p.(map[string]any)
			if !ok || len(policy) == 0 {
				continue
			}
			e := entry{
				path:    getString(resource, "path", ""),
				license: getString(policy, "license_key", "unknown"),
			}
			switch getString(policy, "label", "") {
			case "Prohibited License":
				violations = append(violations, e)
			case "Restricted License":
				restricted = append(restricted, e)
			}
		}
	}

	if len(violations) > 0 {
		fmt.Printf("::error::Found %d prohibited license(s):\n", len(violations))
		for _, v := range violations {
			fmt.Printf("  - %s: %s\n", v.path, v.license)
		}
		os.Exit(1)
	}

	if len(restricted) > 0 {
		fmt.Printf("::warning::Found %d restricted license(s) (requires review):\n", len(restricted))
		for _, r := range restricted {
			fmt.Printf("  - %s: %s\n", r.path, r.license)
		}
	}

	fmt.Printf("License policy check passed (%d files scanned)\n", len(files))
}
