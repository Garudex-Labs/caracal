// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

func TestAliasesRoundTrip(t *testing.T) {
	home := withTempHome(t)
	if got, want := AliasesFile(), filepath.Join(home, ".caracal", "aliases.json"); got != want {
		t.Fatalf("AliasesFile() = %q, want %q", got, want)
	}
	if cerr := SaveAliases(map[string]string{"rev": "acme/reviewer", "fmt": "acme/formatter"}); cerr != nil {
		t.Fatal(cerr)
	}
	info, err := os.Stat(AliasesFile())
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v, want 0600", info.Mode().Perm())
	}
	aliases, cerr := LoadAliases()
	if cerr != nil {
		t.Fatal(cerr)
	}
	if len(aliases) != 2 || aliases["rev"] != "acme/reviewer" || aliases["fmt"] != "acme/formatter" {
		t.Fatalf("aliases = %v", aliases)
	}
}

func TestSaveAliasesReplacesTheWholeMap(t *testing.T) {
	withTempHome(t)
	if cerr := SaveAliases(map[string]string{"rev": "acme/reviewer", "old": "acme/legacy"}); cerr != nil {
		t.Fatal(cerr)
	}
	// Deleting an alias means persisting the map without it.
	if cerr := SaveAliases(map[string]string{"rev": "acme/reviewer-v2"}); cerr != nil {
		t.Fatal(cerr)
	}
	aliases, cerr := LoadAliases()
	if cerr != nil {
		t.Fatal(cerr)
	}
	if len(aliases) != 1 || aliases["rev"] != "acme/reviewer-v2" {
		t.Fatalf("aliases after replace = %v", aliases)
	}
}

func TestLoadAliasesMissingFileReturnsEmpty(t *testing.T) {
	withTempHome(t)
	aliases, cerr := LoadAliases()
	if cerr != nil {
		t.Fatal(cerr)
	}
	if len(aliases) != 0 {
		t.Fatalf("aliases = %v, want empty", aliases)
	}
}

func TestLoadAliasesMalformedJSONFails(t *testing.T) {
	home := withTempHome(t)
	dir := filepath.Join(home, ".caracal")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "aliases.json"), []byte("{nope"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, cerr := LoadAliases()
	if cerr == nil || cerr.Category != clierr.Validation || cerr.ExitCode() != 7 {
		t.Fatalf("want validation exit 7, got %v", cerr)
	}
}

func TestLoadAliasesNonStringTargetFails(t *testing.T) {
	home := withTempHome(t)
	dir := filepath.Join(home, ".caracal")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "aliases.json"), []byte(`{"rev": 7}`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, cerr := LoadAliases()
	if cerr == nil || cerr.Category != clierr.Validation || cerr.ExitCode() != 7 {
		t.Fatalf("want validation exit 7, got %v", cerr)
	}
}
