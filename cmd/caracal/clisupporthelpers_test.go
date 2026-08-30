// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

func TestShannonEntropyRangesWithDiversity(t *testing.T) {
	if e := shannonEntropy(""); e != 0 {
		t.Errorf("empty string entropy = %v, want 0", e)
	}
	if e := shannonEntropy("aaaaaaaa"); e != 0 {
		t.Errorf("uniform string entropy = %v, want 0", e)
	}
	low := shannonEntropy("aabb")
	high := shannonEntropy("abcd")
	if high <= low {
		t.Errorf("diverse string must have higher entropy: %v vs %v", high, low)
	}
}

func TestRedactStringRedactsJWTAndAWSAndURLUser(t *testing.T) {
	count := 0
	jwt := "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123_-"
	if got := redactString(jwt, &count); got != "<REDACTED>" {
		t.Errorf("JWT not redacted: %q", got)
	}
	count = 0
	// Split so the source carries no contiguous AWS-key literal; the runtime
	// value still matches the redaction pattern.
	aws := "AKIA" + "IOSFODNN7EXAMPLE"
	if got := redactString(aws, &count); !strings.Contains(got, "<REDACTED>") {
		t.Errorf("AWS key not redacted: %q", got)
	}
	count = 0
	url := "postgres://admin:hunter2@db.internal:5432/app"
	got := redactString(url, &count)
	// A long high-entropy connection string is masked wholesale, so the
	// embedded credentials must not survive in any form.
	if strings.Contains(got, "admin:hunter2") || !strings.Contains(got, "<REDACTED>") {
		t.Errorf("URL userinfo not redacted: %q", got)
	}
}

func TestRedactStringRedactsHighEntropyToken(t *testing.T) {
	// A long, high-entropy word with no separators must be masked.
	secret := "Zk9Wq2Xp7Lr4Mv8Nc3Bd6Fg1Hj5Ty0UsAe" // 35 diverse chars
	if len(secret) < 32 || shannonEntropy(secret) <= 4.5 {
		t.Fatalf("test fixture invariant broken: len=%d entropy=%v", len(secret), shannonEntropy(secret))
	}
	count := 0
	if got := redactString(secret, &count); got != "<REDACTED>" {
		t.Errorf("high-entropy token not redacted: %q", got)
	}
	if count == 0 {
		t.Error("redaction count must advance")
	}
}

func TestRedactStringLeavesPlainTextAlone(t *testing.T) {
	count := 0
	plain := "the quick brown fox jumps"
	if got := redactString(plain, &count); got != plain {
		t.Errorf("plain text altered: %q", got)
	}
	if count != 0 {
		t.Errorf("plain text should not increment count: %d", count)
	}
}

func TestRedactValueMasksSensitiveKeysAndRecurses(t *testing.T) {
	count := 0
	input := map[string]any{
		"api_key":  "whatever",
		"nested":   map[string]any{"password": "x", "name": "keep"},
		"list":     []any{"AKIA" + "IOSFODNN7EXAMPLE", "safe"},
		"harmless": "value",
	}
	out, ok := redactValue(input, &count).(map[string]any)
	if !ok {
		t.Fatalf("redactValue must return a map, got %T", out)
	}
	if out["api_key"] != "<REDACTED>" {
		t.Errorf("sensitive key not masked: %v", out["api_key"])
	}
	nested := out["nested"].(map[string]any)
	if nested["password"] != "<REDACTED>" || nested["name"] != "keep" {
		t.Errorf("nested masking wrong: %v", nested)
	}
	list := out["list"].([]any)
	if !strings.Contains(list[0].(string), "<REDACTED>") || list[1] != "safe" {
		t.Errorf("list masking wrong: %v", list)
	}
	if out["harmless"] != "value" {
		t.Errorf("harmless value changed: %v", out["harmless"])
	}
	if count == 0 {
		t.Error("count must reflect redactions")
	}
}

func TestDurationSecondsParsesUnits(t *testing.T) {
	cases := []struct {
		in    string
		want  int64
		valid bool
	}{
		{"1h", 3600, true},
		{"30m", 1800, true},
		{"2d", 172800, true},
		{"1d12h", 129600, true},
		{"90s", 90, true},
		{"0h", 0, false},
		{"", 0, false},
		{"1x", 0, false},
		{"h", 0, false},
	}
	for _, tc := range cases {
		got, ok := durationSeconds(tc.in)
		if ok != tc.valid || (tc.valid && got != tc.want) {
			t.Errorf("durationSeconds(%q) = %d,%v want %d,%v", tc.in, got, ok, tc.want, tc.valid)
		}
	}
}

func TestSafeArchivePathRejectsEscapes(t *testing.T) {
	safe := []string{"logs/app.log", "a/b/c", "file.json"}
	for _, p := range safe {
		if !safeArchivePath(p) {
			t.Errorf("safeArchivePath(%q) = false, want true", p)
		}
	}
	unsafe := []string{"", "/etc/passwd", `a\b`, "C:/x", "a/../b", "../escape"}
	for _, p := range unsafe {
		if safeArchivePath(p) {
			t.Errorf("safeArchivePath(%q) = true, want false", p)
		}
	}
}

func TestRedactedJSONMasksAndIndents(t *testing.T) {
	count := 0
	blob := redactedJSON(map[string]any{"token": "abc", "keep": 1}, &count)
	// MarshalIndent escapes HTML, so the marker appears as \u003cREDACTED\u003e.
	if !strings.Contains(string(blob), "REDACTED") {
		t.Errorf("redactedJSON must mask secrets: %s", blob)
	}
	if !strings.Contains(string(blob), "\n") {
		t.Errorf("redactedJSON must be indented: %s", blob)
	}
	var doc map[string]any
	if err := json.Unmarshal(blob, &doc); err != nil {
		t.Fatalf("redactedJSON not valid JSON: %v", err)
	}
}

func TestHumanSizeScalesUnits(t *testing.T) {
	cases := map[int64]string{
		500:     "500 B",
		1024:    "1.0 KB",
		1536:    "1.5 KB",
		1048576: "1.0 MB",
	}
	for n, want := range cases {
		if got := humanSize(n); got != want {
			t.Errorf("humanSize(%d) = %q, want %q", n, got, want)
		}
	}
}

func TestWriteSupportArchiveRoundTrips(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bundle.tar.gz")
	manifest := []byte(`{"version":"1"}`)
	files := []bundleFile{
		{Path: "logs/app.log", Content: []byte("hello")},
		{Path: "config.json", Content: []byte("{}")},
	}
	if cerr := writeSupportArchive(path, manifest, files, "Generate support bundle"); cerr != nil {
		t.Fatalf("writeSupportArchive: %v", cerr)
	}
	fh, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer fh.Close()
	gz, err := gzip.NewReader(fh)
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	seen := map[string]string{}
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(tr)
		seen[hdr.Name] = string(body)
	}
	if seen["bundle_manifest.json"] != `{"version":"1"}` {
		t.Errorf("manifest entry wrong: %q", seen["bundle_manifest.json"])
	}
	if seen["logs/app.log"] != "hello" || seen["config.json"] != "{}" {
		t.Errorf("file entries wrong: %v", seen)
	}
}

func TestSupportBundleRejectsBadDuration(t *testing.T) {
	_, err := runCLI(t, nil, "doctor", "support", "bundle", "--logs-since", "bogus")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation {
		t.Errorf("bad duration category = %s", cerr.Category)
	}
	if !strings.Contains(cerr.Message, "bogus") {
		t.Errorf("message must name the bad duration: %s", cerr.Message)
	}
}

func TestSupportBundleExistingFileJSONIsConflict(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	existing := filepath.Join(home, "out.tar.gz")
	if err := os.WriteFile(existing, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := captureCLI(t, "doctor", "support", "bundle", "--file", existing, "-o", "json")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Conflict {
		t.Errorf("existing-file JSON category = %s, want conflict", cerr.Category)
	}
}
