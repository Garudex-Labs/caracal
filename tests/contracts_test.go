// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package contracts pins repository-level release and packaging contracts:
// version sync across the monorepo, the Helm OCI publishing pipeline, and
// the signed-tag release workflow.
package contracts

import (
	"os"
	"path/filepath"
	"testing"

	"gopkg.in/yaml.v3"
)

// readRepoFile reads a file relative to the repository root (the parent of
// this package's directory).
func readRepoFile(t *testing.T, rel string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", filepath.FromSlash(rel)))
	if err != nil {
		t.Fatalf("failed to read %s: %v", rel, err)
	}
	return string(data)
}

func loadYAML(t *testing.T, rel string) map[string]any {
	t.Helper()
	var doc map[string]any
	if err := yaml.Unmarshal([]byte(readRepoFile(t, rel)), &doc); err != nil {
		t.Fatalf("failed to parse %s: %v", rel, err)
	}
	return doc
}

func asMap(t *testing.T, v any, what string) map[string]any {
	t.Helper()
	m, ok := v.(map[string]any)
	if !ok {
		t.Fatalf("%s is %T, expected a mapping", what, v)
	}
	return m
}

func asList(t *testing.T, v any, what string) []any {
	t.Helper()
	l, ok := v.([]any)
	if !ok {
		t.Fatalf("%s is %T, expected a sequence", what, v)
	}
	return l
}
