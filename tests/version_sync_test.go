// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package contracts

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

func jsonVersion(t *testing.T, rel string) (string, bool) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", filepath.FromSlash(rel)))
	if errors.Is(err, os.ErrNotExist) {
		return "", false
	}
	if err != nil {
		t.Fatalf("failed to read %s: %v", rel, err)
	}
	var pkg struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(data, &pkg); err != nil {
		t.Fatalf("failed to parse %s: %v", rel, err)
	}
	if pkg.Version == "" {
		t.Fatalf("no version found in %s", rel)
	}
	return pkg.Version, true
}

// The release tool (tools/release) bumps apps/web/package.json and
// packages/pi-extension/package.json together. This test catches drift if
// someone bumps one without the others.
func TestAllPackageVersionsInSync(t *testing.T) {
	versions := map[string]string{}

	web, ok := jsonVersion(t, "apps/web/package.json")
	if !ok {
		t.Fatalf("web/package.json is required")
	}
	versions["apps/web/package.json"] = web

	if v, ok := jsonVersion(t, "packages/pi-extension/package.json"); ok {
		versions["packages/pi-extension/package.json"] = v
	}

	unique := map[string]struct{}{}
	for _, v := range versions {
		unique[v] = struct{}{}
	}
	if len(unique) != 1 {
		var lines []string
		for k, v := range versions {
			lines = append(lines, fmt.Sprintf("  %s: %s", k, v))
		}
		sort.Strings(lines)
		t.Fatalf("Version mismatch across packages. Run make release to sync.\n%s", strings.Join(lines, "\n"))
	}
}
