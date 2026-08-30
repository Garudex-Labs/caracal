// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

// ── config path ────────────────────────────────────────────────────

func TestConfigPathJSONReportsExistence(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	// Before any write the file is absent.
	out, err := captureCLI(t, "config", "path", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	var doc configPathDocument
	if json.Unmarshal([]byte(out), &doc) != nil {
		t.Fatalf("path output is not JSON:\n%s", out)
	}
	if doc.Exists || !strings.HasSuffix(doc.Path, ".caracal/config.json") {
		t.Errorf("fresh home must report a non-existent config: %+v", doc)
	}
	// A write materializes the file.
	if _, err := captureCLI(t, "config", "set", "timeout", "45"); err != nil {
		t.Fatal(err)
	}
	out, err = captureCLI(t, "config", "path", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	if json.Unmarshal([]byte(out), &doc) != nil || !doc.Exists {
		t.Errorf("config must exist after a set: %+v", doc)
	}
}

// ── config alias ───────────────────────────────────────────────────

func TestConfigAliasRejectsInvalidNameLocally(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	_, err := captureCLI(t, "config", "alias", "1bad", "acme/weather")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation || !strings.Contains(cerr.Message, "start with a letter") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
}

func TestConfigAliasRejectsEmptyTarget(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	_, err := captureCLI(t, "config", "alias", "wx", "   ")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation || !strings.Contains(cerr.Message, "must not be empty") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
}

func TestConfigAliasSetIsIdempotentInJSON(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	out, err := captureCLI(t, "config", "alias", "wx", "acme/weather", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	var doc aliasResult
	if json.Unmarshal([]byte(out), &doc) != nil {
		t.Fatalf("alias output is not JSON:\n%s", out)
	}
	if doc.Action != "set" || doc.Alias != "wx" || doc.Target == nil || *doc.Target != "acme/weather" || !doc.Changed {
		t.Errorf("first set must report a change: %+v", doc)
	}
	// Re-setting the same target is a no-op change.
	out, err = captureCLI(t, "config", "alias", "wx", "acme/weather", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	if json.Unmarshal([]byte(out), &doc) != nil || doc.Changed {
		t.Errorf("unchanged re-set must report changed=false: %+v", doc)
	}
}

func TestConfigAliasRemoveReportsPriorTarget(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if _, err := captureCLI(t, "config", "alias", "wx", "acme/weather"); err != nil {
		t.Fatal(err)
	}
	out, err := captureCLI(t, "config", "alias", "wx", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	var doc aliasResult
	if json.Unmarshal([]byte(out), &doc) != nil {
		t.Fatalf("remove output is not JSON:\n%s", out)
	}
	if doc.Action != "removed" || !doc.Changed || doc.Target == nil || *doc.Target != "acme/weather" {
		t.Errorf("removal must echo the prior target: %+v", doc)
	}
	// Removing an absent alias is reported as an unchanged removal.
	out, err = captureCLI(t, "config", "alias", "wx", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	if json.Unmarshal([]byte(out), &doc) != nil || doc.Changed {
		t.Errorf("removing an absent alias must report changed=false: %+v", doc)
	}
}

// ── config aliases ─────────────────────────────────────────────────

func TestConfigAliasesJSONEnvelopeIsSorted(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	for _, pair := range [][2]string{{"wx", "acme/weather"}, {"ml", "acme/mailer"}} {
		if _, err := captureCLI(t, "config", "alias", pair[0], pair[1]); err != nil {
			t.Fatal(err)
		}
	}
	out, err := captureCLI(t, "config", "aliases", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	var doc aliasListing
	if json.Unmarshal([]byte(out), &doc) != nil {
		t.Fatalf("aliases output is not JSON:\n%s", out)
	}
	if doc.Total != 2 || doc.PageSize != 2 || len(doc.Items) != 2 {
		t.Fatalf("envelope counts: %+v", doc)
	}
	// Items are name-sorted: ml before wx.
	if doc.Items[0].Alias != "ml" || doc.Items[1].Alias != "wx" {
		t.Errorf("aliases must be sorted: %+v", doc.Items)
	}
}
