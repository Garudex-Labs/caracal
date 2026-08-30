// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package adminmigrate

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/cli/migrate"
)

// ── Token signing ─────────────────────────────────────────────────────

func testSigner(now time.Time) *TokenSigner {
	return &TokenSigner{Secret: []byte("unit-test-secret"), Now: func() time.Time { return now }}
}

func TestTokenRoundTrip(t *testing.T) {
	now := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	s := testSigner(now)
	token, err := s.Sign(map[string]any{
		"typ":      "migration_artifact",
		"job_id":   "6f1d3f9e-13a8-4c11-9c1f-000000000001",
		"artifact": "pg_export.tar.gz",
		"sub":      "6f1d3f9e-13a8-4c11-9c1f-000000000002",
		"exp":      now.Add(5 * time.Minute).Unix(),
	})
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	claims, err := s.Verify(token)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if claims["typ"] != "migration_artifact" {
		t.Fatalf("typ = %v", claims["typ"])
	}
	if claims["artifact"] != "pg_export.tar.gz" {
		t.Fatalf("artifact = %v", claims["artifact"])
	}
	if claims["job_id"] != "6f1d3f9e-13a8-4c11-9c1f-000000000001" {
		t.Fatalf("job_id = %v", claims["job_id"])
	}
}

func TestTokenRejectsTampering(t *testing.T) {
	now := time.Now()
	s := testSigner(now)
	token, err := s.Sign(map[string]any{"typ": "migration_artifact", "exp": now.Add(time.Minute).Unix()})
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	parts := strings.Split(token, ".")

	// Payload swap keeps the old signature.
	forged, _ := json.Marshal(map[string]any{"typ": "migration_artifact", "artifact": "../../etc/passwd"})
	tampered := parts[0] + "." + base64URL(forged) + "." + parts[2]
	if _, err := s.Verify(tampered); err == nil {
		t.Fatal("tampered payload verified")
	}

	// A different secret must not verify.
	other := &TokenSigner{Secret: []byte("other-secret")}
	if _, err := other.Verify(token); err == nil {
		t.Fatal("cross-secret token verified")
	}

	// Header alg swap must not verify.
	noneHeader := base64URL([]byte(`{"alg":"none","typ":"JWT"}`))
	if _, err := s.Verify(noneHeader + "." + parts[1] + "." + parts[2]); err == nil {
		t.Fatal("alg=none token verified")
	}

	if _, err := s.Verify("garbage"); err == nil {
		t.Fatal("garbage verified")
	}
	if _, err := s.Verify("a.b"); err == nil {
		t.Fatal("two-part token verified")
	}
}

func TestTokenRejectsExpired(t *testing.T) {
	issued := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	s := testSigner(issued)
	token, err := s.Sign(map[string]any{"typ": "migration_artifact", "exp": issued.Add(5 * time.Minute).Unix()})
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if _, err := s.Verify(token); err != nil {
		t.Fatalf("fresh token rejected: %v", err)
	}
	s.Now = func() time.Time { return issued.Add(6 * time.Minute) }
	if _, err := s.Verify(token); err == nil {
		t.Fatal("expired token verified")
	}
}

func base64URL(b []byte) string {
	return base64.RawURLEncoding.EncodeToString(b)
}

// ── Job wire serialization ────────────────────────────────────────────

func TestOperationLabels(t *testing.T) {
	if opToDB("import") != "import_" || opToDB("export") != "export" {
		t.Fatal("opToDB mapping broken")
	}
	if opToWire("import_") != "import" || opToWire("validate") != "validate" {
		t.Fatal("opToWire mapping broken")
	}
}

func TestWireJobShape(t *testing.T) {
	created := time.Date(2026, 8, 29, 10, 30, 0, 123456000, time.UTC)
	finished := time.Date(2026, 8, 29, 10, 31, 2, 0, time.UTC)
	phase := "completed"
	job := &Job{
		ID:            uuid.MustParse("6f1d3f9e-13a8-4c11-9c1f-000000000001"),
		Operation:     "import",
		Scope:         "both",
		Status:        "completed",
		ProgressPhase: &phase,
		ProgressPct:   100,
		CreatedAt:     created,
		FinishedAt:    &finished,
		ArtifactsJSON: []byte(`[{"name":"pg_export.tar.gz","size_bytes":42,"sha256":"abc","kind":"archive"}]`),
		ResultJSON:    []byte(`{"total_rows":7}`),
	}
	raw, err := json.Marshal(wireJob(job))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got["operation_type"] != "import" || got["data_scope"] != "both" {
		t.Fatalf("operation/scope = %v/%v", got["operation_type"], got["data_scope"])
	}
	if got["created_at"] != "2026-08-29T10:30:00.123456Z" {
		t.Fatalf("created_at = %v", got["created_at"])
	}
	if got["finished_at"] != "2026-08-29T10:31:02Z" {
		t.Fatalf("finished_at = %v", got["finished_at"])
	}
	artifacts, ok := got["artifacts"].([]any)
	if !ok || len(artifacts) != 1 {
		t.Fatalf("artifacts = %v", got["artifacts"])
	}
	artifact := artifacts[0].(map[string]any)
	if artifact["name"] != "pg_export.tar.gz" || artifact["kind"] != "archive" ||
		artifact["size_bytes"] != float64(42) || artifact["sha256"] != "abc" {
		t.Fatalf("artifact = %v", artifact)
	}
	result := got["result"].(map[string]any)
	if result["total_rows"] != float64(7) {
		t.Fatalf("result = %v", got["result"])
	}
	for _, key := range []string{"id", "status", "progress_phase", "progress_pct",
		"progress_message", "error_message", "schema_version"} {
		if _, present := got[key]; !present {
			t.Fatalf("missing key %s", key)
		}
	}
}

func TestWireJobDefaults(t *testing.T) {
	job := &Job{
		ID:        uuid.New(),
		Operation: "export",
		Scope:     "postgres",
		Status:    "queued",
		CreatedAt: time.Date(2026, 8, 29, 10, 30, 0, 0, time.UTC),
	}
	raw, err := json.Marshal(wireJob(job))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got["created_at"] != "2026-08-29T10:30:00Z" {
		t.Fatalf("created_at = %v", got["created_at"])
	}
	if artifacts, ok := got["artifacts"].([]any); !ok || len(artifacts) != 0 {
		t.Fatalf("artifacts should default to [], got %v", got["artifacts"])
	}
	for _, key := range []string{"result", "finished_at", "error_message", "schema_version"} {
		if value, present := got[key]; !present || value != nil {
			t.Fatalf("%s should be null, got %v (present=%v)", key, value, present)
		}
	}
}

// ── Upload validation ─────────────────────────────────────────────────

func multipartFiles(t *testing.T, files map[string][]byte) []*multipart.FileHeader {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for name, content := range files {
		part, err := writer.CreateFormFile("files", name)
		if err != nil {
			t.Fatalf("create part: %v", err)
		}
		if _, err := part.Write(content); err != nil {
			t.Fatalf("write part: %v", err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close writer: %v", err)
	}
	req := httptest.NewRequest("POST", "/", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	if err := req.ParseMultipartForm(1 << 20); err != nil {
		t.Fatalf("parse form: %v", err)
	}
	t.Cleanup(func() { _ = req.MultipartForm.RemoveAll() })
	return req.MultipartForm.File["files"]
}

func TestValidateUploads(t *testing.T) {
	gz := []byte{0x1f, 0x8b, 0x08, 0x00, 0x00}
	parquet := []byte("PAR1xxxx")

	if err := validateUploads(multipartFiles(t, map[string][]byte{"a.tar.gz": gz, "b.parquet": parquet}), "both", 1<<20); err != nil {
		t.Fatalf("valid mix rejected: %v", err)
	}
	if err := validateUploads(multipartFiles(t, map[string][]byte{"a.bin": []byte("ELFF")}), "both", 1<<20); err == nil ||
		!strings.Contains(err.Detail, "unsupported format") {
		t.Fatalf("unsupported format accepted: %v", err)
	}
	if err := validateUploads(multipartFiles(t, map[string][]byte{"a": {0x1f}}), "both", 1<<20); err == nil ||
		!strings.Contains(err.Detail, "too small") {
		t.Fatalf("tiny file accepted: %v", err)
	}
	if err := validateUploads(multipartFiles(t, map[string][]byte{"b.parquet": parquet}), "postgres", 1<<20); err == nil ||
		!strings.Contains(err.Detail, "only Parquet files") {
		t.Fatalf("postgres/parquet mismatch accepted: %v", err)
	}
	if err := validateUploads(multipartFiles(t, map[string][]byte{"a.tar.gz": gz}), "clickhouse", 1<<20); err == nil ||
		!strings.Contains(err.Detail, "only archive files") {
		t.Fatalf("clickhouse/archive mismatch accepted: %v", err)
	}
	if err := validateUploads(multipartFiles(t, map[string][]byte{"a.tar.gz": gz}), "both", 3); err == nil ||
		!strings.Contains(err.Detail, "exceeds maximum upload size") {
		t.Fatalf("oversized file accepted: %v", err)
	}
}

func TestSanitizeUploadName(t *testing.T) {
	if sanitizeUploadName("../../etc/passwd") != "passwd" {
		t.Fatal("directory components kept")
	}
	if sanitizeUploadName("archive.tar.gz") != "archive.tar.gz" {
		t.Fatal("plain name changed")
	}
	for _, bad := range []string{"", ".", "..", "/"} {
		if !strings.HasPrefix(sanitizeUploadName(bad), "upload_") {
			t.Fatalf("reserved name %q not replaced", bad)
		}
	}
}

// ── Result assembly helpers ───────────────────────────────────────────

func TestFKResultsMap(t *testing.T) {
	m := fkResultsMap(&migrate.FKResults{OrphanedAgentIDs: []string{"a"}, OrphanedUserIDsTruncated: true})
	if ids := m["orphaned_agent_ids"].([]string); len(ids) != 1 || ids[0] != "a" {
		t.Fatalf("agent ids = %v", m["orphaned_agent_ids"])
	}
	if ids := m["orphaned_user_ids"].([]string); ids == nil || len(ids) != 0 {
		t.Fatalf("user ids should be empty non-nil, got %v", m["orphaned_user_ids"])
	}
	if m["orphaned_user_ids_truncated"] != true || m["orphaned_agent_ids_truncated"] != false {
		t.Fatalf("truncation flags = %v", m)
	}
}

func TestFindRegistryArchive(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"telemetry_export.tar.gz", "zz.tgz", "aa.tar.gz", "notes.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	got, err := findRegistryArchive(dir, "missing")
	if err != nil {
		t.Fatalf("find: %v", err)
	}
	if filepath.Base(got) != "aa.tar.gz" {
		t.Fatalf("picked %s", got)
	}
	empty := t.TempDir()
	if _, err := findRegistryArchive(empty, "No PostgreSQL .tar.gz archive found in artifact directory"); err == nil ||
		!strings.Contains(err.Error(), "No PostgreSQL") {
		t.Fatalf("empty dir error = %v", err)
	}
}

func TestPackAndExtractTarGz(t *testing.T) {
	src := t.TempDir()
	if err := os.WriteFile(filepath.Join(src, "telemetry_manifest.json"), []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "events.parquet"), []byte("PAR1data"), 0o600); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(t.TempDir(), "telemetry_export.tar.gz")
	if err := packTarGz(archive, src, []string{"telemetry_manifest.json", "events.parquet", "absent.parquet"}); err != nil {
		t.Fatalf("pack: %v", err)
	}
	dest := t.TempDir()
	if err := extractTarGz(archive, dest); err != nil {
		t.Fatalf("extract: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(dest, "events.parquet"))
	if err != nil || string(data) != "PAR1data" {
		t.Fatalf("round trip content = %q err=%v", data, err)
	}
	if _, err := os.Stat(filepath.Join(dest, "absent.parquet")); err == nil {
		t.Fatal("absent member materialized")
	}
}
