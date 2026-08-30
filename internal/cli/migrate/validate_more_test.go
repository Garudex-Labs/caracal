// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package migrate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// sha256Bytes mirrors sha256File for in-memory content.
func sha256Bytes(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

// buildValidatablePGArchive writes a self-consistent registry archive.
// corruptChecksum poisons the users checksum; omit drops one table's JSONL.
func buildValidatablePGArchive(t *testing.T, dir string, corruptChecksum bool, omit string) string {
	t.Helper()
	counts := map[string]int64{}
	hashes := map[string]string{}
	files := map[string]string{}
	for _, table := range insertOrder {
		content := ""
		if table == "users" {
			content = "{\"id\": \"550e8400-e29b-41d4-a716-446655440000\"}\n"
		}
		counts[table] = 0
		hashes[table] = sha256Bytes(content)
		files["pg/"+table+".jsonl"] = content
	}
	counts["users"] = 1
	if corruptChecksum {
		hashes["users"] = strings.Repeat("f", 64)
	}
	manifest := buildPGManifest("mig", "2026-01-02T03:04:05+00:00", "abc", counts, hashes)
	mig := buildMigrationManifest("mig", "2026-01-02T03:04:05+00:00", "h", counts, NewDoc())
	files["manifest.json"] = dumpsIndent(manifest) + "\n"
	files["migration_manifest.json"] = dumpsIndent(mig) + "\n"
	if omit != "" {
		delete(files, "pg/"+omit+".jsonl")
	}
	archivePath := filepath.Join(dir, "custom.tar.gz")
	packTarGz(t, archivePath, files)
	return archivePath
}

// writeTelemetryExport writes a telemetry manifest plus one Parquet file.
func writeTelemetryExport(t *testing.T, dir string) string {
	t.Helper()
	filename := "session_events_2025-01.parquet"
	content := "PAR1telemetryPAR1"
	if err := os.WriteFile(filepath.Join(dir, filename), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	hash := sha256Bytes(content)
	tables := NewDoc()
	for _, cfg := range clickhouseTables {
		if cfg.Name == "session_events" {
			tables.Set(cfg.Name, NewDoc().
				Set("checksum", NewDoc().Set(filename, hash)).
				Set("row_count", int64(3)))
			continue
		}
		tables.Set(cfg.Name, NewDoc().Set("checksum", NewDoc()).Set("row_count", int64(0)))
	}
	manifest := NewDoc().Set("migration_id", "m").Set("tables", tables)
	if err := writeManifest(filepath.Join(dir, "telemetry_manifest.json"), manifest); err != nil {
		t.Fatal(err)
	}
	return filename
}

func TestValidatePGValidArchive(t *testing.T) {
	dir := t.TempDir()
	archivePath := writeTestArchive(t, dir)
	res, err := ValidatePG(context.Background(), "", archivePath, nil)
	if err != nil {
		t.Fatalf("ValidatePG: %v", err)
	}
	if !res.ArchiveValid {
		t.Fatal("valid archive reported invalid")
	}
	if res.CrossDBResults != nil {
		t.Fatal("no DSN was given, so cross-DB results must be nil")
	}
	if len(res.ChecksumResults) != len(insertOrder) {
		t.Fatalf("checksum results = %d, want %d", len(res.ChecksumResults), len(insertOrder))
	}
	for _, cr := range res.ChecksumResults {
		if !cr.Passed {
			t.Fatalf("checksum for %s should pass", cr.TableName)
		}
	}
}

func TestValidatePGBadArchive(t *testing.T) {
	dir := t.TempDir()
	plain := filepath.Join(dir, "plain.tar.gz")
	if err := os.WriteFile(plain, []byte("not gzip"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := ValidatePG(context.Background(), "", plain, nil); err == nil {
		t.Fatal("a non-archive input must error")
	}
}

func TestValidatePGMissingManifest(t *testing.T) {
	dir := t.TempDir()
	archive := filepath.Join(dir, "nomanifest.tar.gz")
	packTarGz(t, archive, map[string]string{"pg/users.jsonl": "{}\n"})
	_, err := ValidatePG(context.Background(), "", archive, nil)
	if err == nil || !strings.Contains(AsError(err).Message, "manifest.json") {
		t.Fatalf("expected a missing-manifest error, got %v", err)
	}
}

func TestValidatePGCorruptChecksum(t *testing.T) {
	dir := t.TempDir()
	archive := buildValidatablePGArchive(t, dir, true, "")
	res, err := ValidatePG(context.Background(), "", archive, nil)
	if err != nil {
		t.Fatalf("ValidatePG: %v", err)
	}
	if res.ArchiveValid {
		t.Fatal("a poisoned checksum must invalidate the archive")
	}
	found := false
	for _, cr := range res.ChecksumResults {
		if cr.TableName == "users" {
			found = true
			if cr.Passed {
				t.Fatal("users checksum should have failed")
			}
		}
	}
	if !found {
		t.Fatal("users checksum result missing")
	}
}

func TestValidatePGMissingJSONL(t *testing.T) {
	dir := t.TempDir()
	archive := buildValidatablePGArchive(t, dir, false, "users")
	res, err := ValidatePG(context.Background(), "", archive, nil)
	if err != nil {
		t.Fatalf("ValidatePG: %v", err)
	}
	if res.ArchiveValid {
		t.Fatal("a missing JSONL member must invalidate the archive")
	}
	for _, cr := range res.ChecksumResults {
		if cr.TableName == "users" && (cr.Passed || cr.ActualChecksum != "") {
			t.Fatalf("missing users file should yield an empty, failed checksum: %+v", cr)
		}
	}
}

func TestValidateCHValid(t *testing.T) {
	dir := t.TempDir()
	writeTelemetryExport(t, dir)
	res, err := ValidateCH(context.Background(), "", "", dir, nil)
	if err != nil {
		t.Fatalf("ValidateCH: %v", err)
	}
	if !res.ChecksumsValid {
		t.Fatal("telemetry checksums should be valid")
	}
	if len(res.ChecksumResults) != 1 || !res.ChecksumResults[0].Passed {
		t.Fatalf("checksum results = %+v", res.ChecksumResults)
	}
	if res.FKResults != nil || res.RowCountResults != nil || len(res.Warnings) != 0 {
		t.Fatalf("no CH/DSN was provided; FK/rowcount/warnings must be empty: %+v", res)
	}
}

func TestValidateCHMissingManifest(t *testing.T) {
	dir := t.TempDir()
	if _, err := ValidateCH(context.Background(), "", "", dir, nil); err == nil {
		t.Fatal("a missing telemetry manifest must error")
	}
}

func TestValidateCHChecksumMismatch(t *testing.T) {
	dir := t.TempDir()
	filename := writeTelemetryExport(t, dir)
	if err := os.WriteFile(filepath.Join(dir, filename), []byte("PAR1TAMPEREDPAR1"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := ValidateCH(context.Background(), "", "", dir, nil)
	if err != nil {
		t.Fatalf("ValidateCH: %v", err)
	}
	if res.ChecksumsValid {
		t.Fatal("a tampered file must fail checksum validation")
	}
}

func TestValidateCHMissingFile(t *testing.T) {
	dir := t.TempDir()
	filename := writeTelemetryExport(t, dir)
	if err := os.Remove(filepath.Join(dir, filename)); err != nil {
		t.Fatal(err)
	}
	res, err := ValidateCH(context.Background(), "", "", dir, nil)
	if err != nil {
		t.Fatalf("ValidateCH: %v", err)
	}
	if res.ChecksumsValid || res.ChecksumResults[0].Passed {
		t.Fatal("a missing file must fail checksum validation")
	}
}

func TestValidateCHFKSkippedWarning(t *testing.T) {
	dir := t.TempDir()
	writeTelemetryExport(t, dir)
	res, err := ValidateCH(context.Background(), "", "some-dsn", dir, nil)
	if err != nil {
		t.Fatalf("ValidateCH: %v", err)
	}
	if res.FKResults != nil {
		t.Fatal("FK validation must not run without a ClickHouse URL")
	}
	if len(res.Warnings) != 1 || !strings.Contains(res.Warnings[0], "FK validation skipped") {
		t.Fatalf("expected an FK-skipped warning, got %v", res.Warnings)
	}
}
