// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package ref

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

// isolate points the CLI state directory at a scratch home.
func isolate(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	return home
}

func TestSaveAndLoadLastResultsRoundTrip(t *testing.T) {
	isolate(t)
	items := []map[string]any{
		{"id": "id-1", "name": "Weather"},
		{"id": "id-2", "name": "Mailer"},
		// A duplicate name (case-insensitive) points the name at the later row.
		{"id": "id-3", "name": "WEATHER"},
		{"id": "id-4"},
	}
	if err := SaveLastResults(items, "mcp"); err != nil {
		t.Fatal(err)
	}
	cache, cerr := LoadLastResults()
	if cerr != nil {
		t.Fatal(cerr)
	}
	if cache.ItemType == nil || *cache.ItemType != "mcp" {
		t.Errorf("item type: %v", cache.ItemType)
	}
	if len(cache.IDs) != 4 || cache.IDs[0] != "id-1" || cache.IDs[3] != "id-4" {
		t.Errorf("ids: %v", cache.IDs)
	}
	if cache.Names["weather"] != "id-3" || cache.Names["mailer"] != "id-2" {
		t.Errorf("names: %v", cache.Names)
	}
}

func TestLoadLastResultsToleratesAbsence(t *testing.T) {
	isolate(t)
	cache, cerr := LoadLastResults()
	if cerr != nil || cache == nil || len(cache.IDs) != 0 || cache.Names == nil {
		t.Errorf("absent cache: %+v, %v", cache, cerr)
	}
}

func TestLoadLastResultsRejectsMalformedCache(t *testing.T) {
	home := isolate(t)
	dir := filepath.Join(home, ".caracal")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "last_results.json"), []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, cerr := LoadLastResults()
	if cerr == nil || cerr.Category != clierr.Validation {
		t.Errorf("malformed cache: %v", cerr)
	}
}

func TestResolveAliasExpandsConfiguredAliases(t *testing.T) {
	home := isolate(t)
	dir := filepath.Join(home, ".caracal")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "aliases.json"),
		[]byte(`{"wx": "acme/weather"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	got, cerr := ResolveAlias("@wx", "")
	if cerr != nil || got != "acme/weather" {
		t.Errorf("alias: %q, %v", got, cerr)
	}
	_, cerr = ResolveAlias("@nope", "")
	if cerr == nil || cerr.Category != clierr.NotFound {
		t.Errorf("unknown alias: %v", cerr)
	}
}

func TestResolveAliasPositionalRows(t *testing.T) {
	isolate(t)
	if err := SaveLastResults([]map[string]any{{"id": "id-1"}, {"id": "id-2"}}, "mcp"); err != nil {
		t.Fatal(err)
	}

	got, cerr := ResolveAlias("2", "mcp")
	if cerr != nil || got != "id-2" {
		t.Errorf("row 2: %q, %v", got, cerr)
	}
	// A row from another type's list must not leak across types.
	if _, cerr := ResolveAlias("1", "skill"); cerr == nil || cerr.Category != clierr.NotFound {
		t.Errorf("cross-type row: %v", cerr)
	}
	if _, cerr := ResolveAlias("3", "mcp"); cerr == nil || cerr.Category != clierr.NotFound {
		t.Errorf("out of range: %v", cerr)
	}
	// Plain names pass through untouched.
	got, cerr = ResolveAlias("weather-fetcher", "mcp")
	if cerr != nil || got != "weather-fetcher" {
		t.Errorf("plain name: %q, %v", got, cerr)
	}
}

func TestResolveRegistryReferenceLocalPaths(t *testing.T) {
	isolate(t)
	if err := SaveLastResults([]map[string]any{{"id": "id-9"}}, "mcp"); err != nil {
		t.Fatal(err)
	}
	// Plural route segments map onto the resolver's singular type names, so a
	// row cached by "mcp" satisfies a caller passing "mcps".
	got, cerr := ResolveRegistryReference(nil, "mcps", "1", "", "")
	if cerr != nil || got != "id-9" {
		t.Errorf("plural row: %q, %v", got, cerr)
	}
	// UUIDs and bare names never touch the server.
	got, cerr = ResolveRegistryReference(nil, "mcp", "0656308f-8bba-472e-ab77-f96a7ac69fd2", "", "")
	if cerr != nil || got != "0656308f-8bba-472e-ab77-f96a7ac69fd2" {
		t.Errorf("uuid passthrough: %q, %v", got, cerr)
	}
}
