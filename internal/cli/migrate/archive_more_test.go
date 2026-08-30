// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package migrate

import (
	"archive/tar"
	"compress/gzip"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// tarEntry is a single tar member for the header-level test archives.
type tarEntry struct {
	hdr  *tar.Header
	body string
}

// writeTarGzHeaders packs arbitrary tar members with explicit headers.
func writeTarGzHeaders(t *testing.T, path string, entries []tarEntry) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		if e.hdr.Typeflag == tar.TypeReg {
			e.hdr.Size = int64(len(e.body))
		}
		if err := tw.WriteHeader(e.hdr); err != nil {
			t.Fatal(err)
		}
		if e.body != "" {
			if _, err := tw.Write([]byte(e.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
}

// packTarGz packs regular files (arcname -> content) in a deterministic order.
func packTarGz(t *testing.T, path string, files map[string]string) {
	t.Helper()
	entries := make([]tarEntry, 0, len(files))
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	for _, name := range sortedStrings(names) {
		entries = append(entries, tarEntry{
			hdr:  &tar.Header{Name: name, Mode: 0o644, Typeflag: tar.TypeReg},
			body: files[name],
		})
	}
	writeTarGzHeaders(t, path, entries)
}

func TestSha256FileMissing(t *testing.T) {
	if _, err := sha256File(filepath.Join(t.TempDir(), "nope")); err == nil {
		t.Fatal("sha256File on a missing path must error")
	}
}

func TestIsTarGzMissing(t *testing.T) {
	if IsTarGz(filepath.Join(t.TempDir(), "nope.tar.gz")) {
		t.Fatal("a missing file must not be reported as tar.gz")
	}
}

func TestSidecarPath(t *testing.T) {
	cases := map[string]string{
		filepath.Join("x", "y", "export.tar.gz"): filepath.Join("x", "y", "export.manifest.json"),
		filepath.Join("x", "y", "export.tgz"):    filepath.Join("x", "y", "export.manifest.json"),
		filepath.Join("x", "export"):             filepath.Join("x", "export.manifest.json"),
		"backup.tar.gz":                          "backup.manifest.json",
	}
	for in, want := range cases {
		if got := SidecarPath(in); got != want {
			t.Fatalf("SidecarPath(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestIsEmptyParquetBoundaries(t *testing.T) {
	dir := t.TempDir()
	cases := []struct {
		name  string
		bytes string
		empty bool
	}{
		{"too short", "PAR1", true},
		{"valid 12 bytes", "PAR11234PAR1", false},
		{"head only", "PAR1AAAABBBB", true},
		{"no head magic", "XXXXAAAAPAR1", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := filepath.Join(dir, tc.name+".parquet")
			if err := os.WriteFile(p, []byte(tc.bytes), 0o644); err != nil {
				t.Fatal(err)
			}
			if got := isEmptyParquet(p); got != tc.empty {
				t.Fatalf("isEmptyParquet(%q) = %v, want %v", tc.bytes, got, tc.empty)
			}
		})
	}
	if !isEmptyParquet(filepath.Join(dir, "does-not-exist.parquet")) {
		t.Fatal("a missing file must count as empty")
	}
}

func TestSafeExtractDirNestedAndUnknownType(t *testing.T) {
	dir := t.TempDir()
	archive := filepath.Join(dir, "mixed.tar.gz")
	writeTarGzHeaders(t, archive, []tarEntry{
		{hdr: &tar.Header{Name: "sub", Typeflag: tar.TypeDir, Mode: 0o755}},
		{hdr: &tar.Header{Name: "sub/f.txt", Typeflag: tar.TypeReg, Mode: 0o644}, body: "hi"},
		{hdr: &tar.Header{Name: "fifo", Typeflag: tar.TypeFifo, Mode: 0o644}},
	})
	dest := filepath.Join(dir, "out")
	if err := os.MkdirAll(dest, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := safeExtract(archive, dest); err != nil {
		t.Fatalf("safeExtract: %v", err)
	}
	if info, err := os.Stat(filepath.Join(dest, "sub")); err != nil || !info.IsDir() {
		t.Fatalf("directory member not extracted: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(dest, "sub", "f.txt"))
	if err != nil || string(raw) != "hi" {
		t.Fatalf("nested file not extracted: %q, %v", raw, err)
	}
	if _, err := os.Stat(filepath.Join(dest, "fifo")); err == nil {
		t.Fatal("unknown member type should have been skipped")
	}
}

func TestSafeExtractRejectsHardlink(t *testing.T) {
	dir := t.TempDir()
	archive := filepath.Join(dir, "hard.tar.gz")
	writeTarGzHeaders(t, archive, []tarEntry{
		{hdr: &tar.Header{Name: "hard", Typeflag: tar.TypeLink, Linkname: "sub/f.txt"}},
	})
	dest := filepath.Join(dir, "out")
	if err := os.MkdirAll(dest, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := safeExtract(archive, dest); err == nil {
		t.Fatal("hard link member must be rejected")
	}
}

func TestSafeExtractInputErrors(t *testing.T) {
	dir := t.TempDir()
	// A plain (non-gzip) file cannot be opened as a gzip stream.
	plain := filepath.Join(dir, "plain.bin")
	if err := os.WriteFile(plain, []byte("not gzip"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := safeExtract(plain, dir); err == nil {
		t.Fatal("non-gzip input must error")
	}
	// A missing archive path fails at open.
	if err := safeExtract(filepath.Join(dir, "missing.tar.gz"), dir); err == nil {
		t.Fatal("missing archive must error")
	}
}

func TestReadManifestErrors(t *testing.T) {
	dir := t.TempDir()
	if _, err := readManifest(filepath.Join(dir, "nope.json")); err == nil {
		t.Fatal("missing manifest must error")
	}
	arr := filepath.Join(dir, "array.json")
	if err := os.WriteFile(arr, []byte("[1, 2]"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readManifest(arr); err == nil {
		t.Fatal("a non-object manifest must error")
	}
	broken := filepath.Join(dir, "broken.json")
	if err := os.WriteFile(broken, []byte("{bad"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readManifest(broken); err == nil {
		t.Fatal("invalid JSON manifest must error")
	}
}

func TestWriteManifestCreatesParents(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a", "b", "manifest.json")
	if err := writeManifest(path, NewDoc().Set("k", "v")); err != nil {
		t.Fatalf("writeManifest: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("manifest not written: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("manifest mode = %o, want 0600", info.Mode().Perm())
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != "{\n  \"k\": \"v\"\n}\n" {
		t.Fatalf("manifest content = %q", string(raw))
	}
}

func TestMonthRangeCrossYears(t *testing.T) {
	got := monthRange(
		time.Date(2024, 11, 1, 0, 0, 0, 0, time.UTC),
		time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC),
	)
	if len(got) != 16 {
		t.Fatalf("monthRange spanning years len = %d, want 16", len(got))
	}
	if got[0] != 202411 || got[len(got)-1] != 202602 {
		t.Fatalf("monthRange endpoints = %d..%d", got[0], got[len(got)-1])
	}
}

func TestPackPGArchiveMissingTableFile(t *testing.T) {
	dir := t.TempDir()
	staging := filepath.Join(dir, "staging")
	pgDir := filepath.Join(staging, "pg")
	if err := os.MkdirAll(pgDir, 0o755); err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(staging, "manifest.json")
	migPath := filepath.Join(staging, "migration_manifest.json")
	if err := writeManifest(manifestPath, NewDoc().Set("schema_version", "1.0")); err != nil {
		t.Fatal(err)
	}
	if err := writeManifest(migPath, NewDoc().Set("migration_id", "x")); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(dir, "export.tar.gz")
	// pgDir has no per-table JSONL files, so packing fails at the first one.
	if err := packPGArchive(out, manifestPath, migPath, pgDir); err == nil {
		t.Fatal("packPGArchive must fail when a table file is missing")
	}
	if _, err := os.Stat(out); err == nil {
		t.Fatal("no partial archive should be left behind on failure")
	}
}
