// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package adminmigrate

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/cli/migrate"
	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/settings"
)

// deadDSN points at a unix socket that cannot exist, so every pgx use
// fails immediately without touching the network.
const deadDSN = "host=/nonexistent-caracal-test dbname=x user=x"

func deadPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), deadDSN)
	if err != nil {
		t.Fatalf("pool config: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

var operatorID = uuid.MustParse("22222222-2222-2222-2222-222222222222")

func newTestHandler(t *testing.T) *Handler {
	t.Helper()
	pool := deadPool(t)
	store := &Store{DB: pool}
	st := &settings.Store{DB: pool}
	runner := &Runner{Store: store, Settings: st, PostgresDSN: deadDSN}
	signer := &TokenSigner{Secret: []byte("unit-test-secret")}
	return NewHandler(store, runner, signer, st, nil)
}

func migrateMux(h *Handler) *http.ServeMux {
	pass := func(next http.Handler) http.Handler { return next }
	mux := http.NewServeMux()
	h.Register(mux, pass, pass)
	return mux
}

func asOperator(req *http.Request) *http.Request {
	ctx := httpapi.ContextWithClaims(req.Context(), auth.Claims{
		UserID: operatorID, Role: "operator", Email: "op@caracal.test",
	})
	return req.WithContext(ctx)
}

func serveMigrate(h *Handler, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	migrateMux(h).ServeHTTP(rec, req)
	return rec
}

// -- wiring ------------------------------------------------------------

func TestNewHandlerWiresRunnerEvents(t *testing.T) {
	h := newTestHandler(t)
	if h.Events == nil || h.Runner.Events != h.Events {
		t.Fatal("runner must share the handler's event emitter")
	}
}

func TestConflictErrorText(t *testing.T) {
	err := &ConflictError{Operation: "export", Scope: "both", Existing: "running"}
	if err.Error() != "A export job for scope 'both' is already running" {
		t.Errorf("text = %q", err.Error())
	}
}

// -- scanJob -----------------------------------------------------------

type fakeJobRow struct {
	vals []any
	err  error
}

func (r fakeJobRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	for i, d := range dest {
		v := r.vals[i]
		switch out := d.(type) {
		case *string:
			out2, _ := v.(string)
			*out = out2
		case **string:
			if v == nil {
				*out = nil
			} else {
				s := v.(string)
				*out = &s
			}
		case *int:
			*out = v.(int)
		case *time.Time:
			*out = v.(time.Time)
		case **time.Time:
			if v == nil {
				*out = nil
			} else {
				tv := v.(time.Time)
				*out = &tv
			}
		default:
			return fmt.Errorf("unsupported dest %T", d)
		}
	}
	return nil
}

func TestScanJob(t *testing.T) {
	created := time.Date(2026, 8, 29, 10, 0, 0, 0, time.UTC)
	finished := created.Add(time.Minute)
	id := uuid.NewString()
	job, err := scanJob(fakeJobRow{vals: []any{
		id, "import_", "both", "completed",
		"completed", 100, "Completed", nil,
		created, finished,
		`[{"name":"pg_export.tar.gz"}]`, `{"total_rows":7}`,
		"20260829", "/tmp/artifacts",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if job.ID.String() != id || job.Operation != "import" || job.Scope != "both" {
		t.Errorf("job = %+v", job)
	}
	if string(job.ArtifactsJSON) != `[{"name":"pg_export.tar.gz"}]` || string(job.ResultJSON) != `{"total_rows":7}` {
		t.Errorf("json columns: %q %q", job.ArtifactsJSON, job.ResultJSON)
	}
	if job.FinishedAt == nil || !job.FinishedAt.Equal(finished) {
		t.Errorf("finished_at = %v", job.FinishedAt)
	}

	if _, err := scanJob(fakeJobRow{vals: []any{
		"not-a-uuid", "export", "both", "queued",
		nil, 0, nil, nil, created, nil, nil, nil, nil, nil,
	}}); err == nil {
		t.Error("invalid uuid must error")
	}
	if _, err := scanJob(fakeJobRow{err: errors.New("boom")}); err == nil {
		t.Error("scan failure must propagate")
	}
}

// -- store error surfaces ----------------------------------------------

func TestStoreMethodsSurfaceConnectionErrors(t *testing.T) {
	ctx := context.Background()
	s := &Store{DB: deadPool(t)}

	if _, err := s.CreateJob(ctx, "export", "both", operatorID, ""); err == nil {
		t.Error("CreateJob must fail on a dead pool")
	}
	if _, err := s.Get(ctx, uuid.New()); err == nil {
		t.Error("Get must fail on a dead pool")
	}
	if _, err := s.List(ctx, 10, 0); err == nil {
		t.Error("List must fail on a dead pool")
	}
	if err := s.MarkRunning(ctx, uuid.New()); err == nil {
		t.Error("MarkRunning must fail on a dead pool")
	}
	if err := s.UpdateProgress(ctx, uuid.New(), "phase", 10, "msg"); err == nil {
		t.Error("UpdateProgress must fail on a dead pool")
	}
	msg := "went wrong"
	if err := s.Finish(ctx, uuid.New(), Terminal{
		Status: "completed", ResultJSON: []byte(`{}`), ArtifactsJSON: []byte(`[]`),
	}); err == nil {
		t.Error("Finish must fail on a dead pool")
	}
	if err := s.Finish(ctx, uuid.New(), Terminal{Status: "failed", ErrorMessage: &msg}); err == nil {
		t.Error("failed-status Finish must fail on a dead pool")
	}
}

// -- endpoint behavior -------------------------------------------------

func TestStartExportEndpoint(t *testing.T) {
	h := newTestHandler(t)

	rec := serveMigrate(h, httptest.NewRequest("POST", "/api/v1/operator/migrate/export",
		strings.NewReader(`{"scope":"postgres"}`)))
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("no claims = %d, want 401", rec.Code)
	}

	rec = serveMigrate(h, asOperator(httptest.NewRequest("POST", "/api/v1/operator/migrate/export",
		strings.NewReader("not json"))))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("garbage body = %d, want 422", rec.Code)
	}

	rec = serveMigrate(h, asOperator(httptest.NewRequest("POST", "/api/v1/operator/migrate/export",
		strings.NewReader(`{"scope":"everything"}`))))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("bad scope = %d, want 422", rec.Code)
	}

	rec = serveMigrate(h, asOperator(httptest.NewRequest("POST", "/api/v1/operator/migrate/export",
		strings.NewReader(`{"scope":"clickhouse"}`))))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "Standalone ClickHouse") {
		t.Errorf("clickhouse scope = %d: %s", rec.Code, rec.Body.String())
	}

	// A valid scope reaches the store, which cannot connect.
	rec = serveMigrate(h, asOperator(httptest.NewRequest("POST", "/api/v1/operator/migrate/export",
		strings.NewReader(`{"scope":"postgres"}`))))
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("dead pool = %d, want 500", rec.Code)
	}
}

func multipartBody(t *testing.T, field string, files map[string][]byte) (*bytes.Buffer, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for name, content := range files {
		part, err := writer.CreateFormFile(field, name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(content); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return &body, writer.FormDataContentType()
}

func TestStartUploadEndpoint(t *testing.T) {
	root := t.TempDir()
	t.Setenv("MIGRATION_ARTIFACT_ROOT", root)
	h := newTestHandler(t)
	gz := []byte{0x1f, 0x8b, 0x08, 0x00}

	rec := serveMigrate(h, asOperator(httptest.NewRequest("POST",
		"/api/v1/operator/migrate/import?scope=everything", nil)))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("bad scope = %d, want 422", rec.Code)
	}

	req := httptest.NewRequest("POST", "/api/v1/operator/migrate/import", strings.NewReader("plain"))
	req.Header.Set("Content-Type", "text/plain")
	rec = serveMigrate(h, asOperator(req))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "multipart") {
		t.Errorf("non-multipart = %d: %s", rec.Code, rec.Body.String())
	}

	body, contentType := multipartBody(t, "attachments", map[string][]byte{"a.tar.gz": gz})
	req = httptest.NewRequest("POST", "/api/v1/operator/migrate/import", body)
	req.Header.Set("Content-Type", contentType)
	rec = serveMigrate(h, asOperator(req))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "No files uploaded") {
		t.Errorf("wrong field = %d: %s", rec.Code, rec.Body.String())
	}

	body, contentType = multipartBody(t, "files", map[string][]byte{"evil.bin": []byte("ELFFELFF")})
	req = httptest.NewRequest("POST", "/api/v1/operator/migrate/import", body)
	req.Header.Set("Content-Type", contentType)
	rec = serveMigrate(h, asOperator(req))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "unsupported format") {
		t.Errorf("bad magic = %d: %s", rec.Code, rec.Body.String())
	}

	// Valid files are stored, then the job insert fails on the dead pool
	// and the staged directory is removed again.
	body, contentType = multipartBody(t, "files", map[string][]byte{"a.tar.gz": gz})
	req = httptest.NewRequest("POST", "/api/v1/operator/migrate/import", body)
	req.Header.Set("Content-Type", contentType)
	rec = serveMigrate(h, asOperator(req))
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("dead pool = %d, want 500: %s", rec.Code, rec.Body.String())
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Errorf("staged upload not cleaned up: %v", entries)
	}

	// startValidate shares startUpload.
	rec = serveMigrate(h, asOperator(httptest.NewRequest("POST",
		"/api/v1/operator/migrate/validate?scope=everything", nil)))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("validate bad scope = %d, want 422", rec.Code)
	}
}

func TestJobStatusEndpoints(t *testing.T) {
	h := newTestHandler(t)

	rec := serveMigrate(h, httptest.NewRequest("GET", "/api/v1/operator/migrate/jobs/not-a-uuid", nil))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "Invalid job ID") {
		t.Errorf("bad job id = %d: %s", rec.Code, rec.Body.String())
	}
	rec = serveMigrate(h, httptest.NewRequest("GET", "/api/v1/operator/migrate/jobs/"+uuid.NewString(), nil))
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("dead pool get = %d, want 500", rec.Code)
	}

	rec = serveMigrate(h, httptest.NewRequest("GET", "/api/v1/operator/migrate/jobs?limit=abc", nil))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "Invalid limit") {
		t.Errorf("bad limit = %d: %s", rec.Code, rec.Body.String())
	}
	rec = serveMigrate(h, httptest.NewRequest("GET", "/api/v1/operator/migrate/jobs?offset=-1", nil))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "Invalid offset") {
		t.Errorf("bad offset = %d: %s", rec.Code, rec.Body.String())
	}
	rec = serveMigrate(h, httptest.NewRequest("GET", "/api/v1/operator/migrate/jobs", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("dead pool list = %d, want 500", rec.Code)
	}
}

func TestQueryInt(t *testing.T) {
	req := httptest.NewRequest("GET", "/?limit=42", nil)
	if got, err := queryInt(req, "limit", 20, 1, 100); err != nil || got != 42 {
		t.Errorf("valid: %d, %v", got, err)
	}
	if got, err := queryInt(req, "offset", 7, 0, 100); err != nil || got != 7 {
		t.Errorf("absent uses fallback: %d, %v", got, err)
	}
	for _, target := range []string{"/?limit=abc", "/?limit=0", "/?limit=101"} {
		req := httptest.NewRequest("GET", target, nil)
		if _, err := queryInt(req, "limit", 20, 1, 100); err == nil {
			t.Errorf("%s accepted", target)
		}
	}
}

func TestArtifactTokenEndpoint(t *testing.T) {
	h := newTestHandler(t)
	base := "/api/v1/operator/migrate/jobs/"

	rec := serveMigrate(h, httptest.NewRequest("POST", base+uuid.NewString()+"/artifacts/a.tar.gz/token", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("no claims = %d, want 401", rec.Code)
	}
	rec = serveMigrate(h, asOperator(httptest.NewRequest("POST", base+"nope/artifacts/a.tar.gz/token", nil)))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("bad job id = %d, want 422", rec.Code)
	}
	rec = serveMigrate(h, asOperator(httptest.NewRequest("POST", base+uuid.NewString()+"/artifacts/a.tar.gz/token", nil)))
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("dead pool = %d, want 500", rec.Code)
	}
}

func TestDownloadEndpoint(t *testing.T) {
	h := newTestHandler(t)
	future := time.Now().Add(time.Hour).Unix()
	sign := func(claims map[string]any) string {
		token, err := h.Signer.Sign(claims)
		if err != nil {
			t.Fatal(err)
		}
		return token
	}
	get := func(token string) *httptest.ResponseRecorder {
		target := "/api/v1/operator/migrate/download"
		if token != "" {
			target += "?token=" + token
		}
		return serveMigrate(h, httptest.NewRequest("GET", target, nil))
	}

	if rec := get(""); rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("missing token = %d, want 422", rec.Code)
	}
	if rec := get("garbage"); rec.Code != http.StatusForbidden {
		t.Errorf("garbage token = %d, want 403", rec.Code)
	}
	if rec := get(sign(map[string]any{"typ": "other", "exp": future})); rec.Code != http.StatusForbidden {
		t.Errorf("wrong typ = %d, want 403", rec.Code)
	}
	rec := get(sign(map[string]any{"typ": "migration_artifact"}))
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "expired") {
		t.Errorf("no exp = %d: %s", rec.Code, rec.Body.String())
	}
	rec = get(sign(map[string]any{"typ": "migration_artifact", "exp": future}))
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "Malformed") {
		t.Errorf("missing fields = %d: %s", rec.Code, rec.Body.String())
	}
	rec = get(sign(map[string]any{
		"typ": "migration_artifact", "exp": future, "job_id": "nope", "artifact": "a.tar.gz",
	}))
	if rec.Code != http.StatusForbidden {
		t.Errorf("bad job uuid = %d, want 403", rec.Code)
	}
	rec = get(sign(map[string]any{
		"typ": "migration_artifact", "exp": future,
		"job_id": uuid.NewString(), "artifact": "a.tar.gz", "sub": uuid.NewString(),
	}))
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("dead pool = %d, want 500", rec.Code)
	}
}

// -- security events ---------------------------------------------------

func TestEmit(t *testing.T) {
	// A nil emitter and a nil client are both safe no-ops.
	var nilEmitter *eventEmitter
	nilEmitter.emit(context.Background(), "info", "success", "a", "e", "r", "t", "tt", "d")
	(&eventEmitter{}).emit(context.Background(), "info", "success", "a", "e", "r", "t", "tt", "d")

	requests := 0
	var lastBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		var buf bytes.Buffer
		_, _ = buf.ReadFrom(r.Body)
		lastBody = buf.String()
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	client, err := clickhouse.New(srv.URL, srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	e := &eventEmitter{CH: client}
	e.emit(context.Background(), "warning", "success", "actor", "op@caracal.test", "operator",
		"job-1", "migration_job", "Migration export started")
	if requests != 1 {
		t.Fatalf("requests = %d", requests)
	}
	if !strings.Contains(lastBody, "security_events") || !strings.Contains(lastBody, "Migration export started") {
		t.Errorf("insert body = %q", lastBody)
	}
}

// -- runner pieces -----------------------------------------------------

func TestArtifactRoot(t *testing.T) {
	t.Setenv("MIGRATION_ARTIFACT_ROOT", "/custom/root")
	if got := artifactRoot(context.Background(), nil); got != "/custom/root" {
		t.Errorf("env root = %q", got)
	}
	t.Setenv("MIGRATION_ARTIFACT_ROOT", "")
	if got := artifactRoot(context.Background(), nil); !strings.Contains(got, "migration_artifacts") {
		t.Errorf("fallback root = %q", got)
	}
	st := &settings.Store{DB: deadPool(t)}
	if got := artifactRoot(context.Background(), st); !strings.Contains(got, "migration_artifacts") {
		t.Errorf("settings fallback root = %q", got)
	}
}

func TestRunnerRunMissingJob(t *testing.T) {
	rn := &Runner{Store: &Store{DB: deadPool(t)}}
	// The job row is unreadable, so Run logs and returns without panicking.
	rn.Run(uuid.New())
}

func TestRunnerFinish(t *testing.T) {
	rn := &Runner{Store: &Store{DB: deadPool(t)}}
	job := &Job{ID: uuid.New(), Operation: "export", Scope: "postgres"}
	rn.finish(context.Background(), job, "/tmp/dir",
		map[string]any{"total_rows": int64(5)},
		[]ArtifactMeta{{Name: "pg_export.tar.gz", SizeBytes: 1, Sha256: "x", Kind: "archive"}}, "")
	rn.finish(context.Background(), job, "", nil, nil, "it broke")
}

func TestDBReporterThrottles(t *testing.T) {
	rep := &dbReporter{store: &Store{DB: deadPool(t)}, jobID: uuid.New()}
	rep.update("phase", 10, "first write fails on the dead pool")
	rep.update("phase", 20, "second write is throttled")
	if time.Since(rep.last) > time.Minute {
		t.Error("first update did not stamp the throttle window")
	}
}

func noProgress(string, int, string) {}

func TestRunExportErrors(t *testing.T) {
	rn := &Runner{PostgresDSN: deadDSN}
	if _, _, err := rn.runExport(context.Background(), "postgres", "", t.TempDir(), noProgress); err == nil {
		t.Error("postgres export must fail without a database")
	}
	if _, _, err := rn.runExport(context.Background(), "clickhouse", "", t.TempDir(), noProgress); err == nil {
		t.Error("clickhouse export must fail without a phase 1 manifest")
	}
}

func TestRunImportErrors(t *testing.T) {
	rn := &Runner{PostgresDSN: deadDSN}
	_, _, err := rn.runImport(context.Background(), "postgres", "", t.TempDir(), noProgress)
	if err == nil || !strings.Contains(err.Error(), "No PostgreSQL") {
		t.Errorf("postgres import err = %v", err)
	}
	_, _, err = rn.runImport(context.Background(), "clickhouse", "", t.TempDir(), noProgress)
	if err == nil || !strings.Contains(err.Error(), "manifest") {
		t.Errorf("clickhouse import err = %v", err)
	}
}

func TestRunValidate(t *testing.T) {
	rn := &Runner{PostgresDSN: deadDSN}
	if _, _, err := rn.runValidate(context.Background(), "postgres", "", t.TempDir(), noProgress); err == nil {
		t.Error("postgres validation must fail without an archive")
	}

	// With no ClickHouse URL the telemetry validation runs entirely from
	// the manifest, so an empty manifest validates cleanly.
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "telemetry_manifest.json"), []byte(`{"tables":{}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	result, artifacts, err := rn.runValidate(context.Background(), "clickhouse", "", dir, noProgress)
	if err != nil {
		t.Fatalf("manifest-only validation: %v", err)
	}
	if artifacts != nil {
		t.Errorf("validation produced artifacts: %v", artifacts)
	}
	if result["checksums_valid"] != true {
		t.Errorf("result = %v", result)
	}
	for _, key := range []string{"row_count_comparison", "orphaned_fk_refs", "schema_version_diff"} {
		if v, ok := result[key]; !ok || v != nil {
			t.Errorf("%s = %v (present=%v), want null placeholder", key, v, ok)
		}
	}
}

func TestTelemetryDir(t *testing.T) {
	// An already-extracted telemetry directory wins.
	dir := t.TempDir()
	extracted := filepath.Join(dir, "telemetry")
	if err := os.MkdirAll(extracted, 0o700); err != nil {
		t.Fatal(err)
	}
	if got, err := telemetryDir(dir); err != nil || got != extracted {
		t.Errorf("existing dir: %q, %v", got, err)
	}

	// No archives at all: the artifact dir itself is the answer.
	flat := t.TempDir()
	if got, err := telemetryDir(flat); err != nil || got != flat {
		t.Errorf("flat dir: %q, %v", got, err)
	}

	// A telemetry archive is extracted on demand.
	src := t.TempDir()
	if err := os.WriteFile(filepath.Join(src, "telemetry_manifest.json"), []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	packed := t.TempDir()
	if err := packTarGz(filepath.Join(packed, "telemetry_export.tar.gz"), src,
		[]string{"telemetry_manifest.json"}); err != nil {
		t.Fatal(err)
	}
	got, err := telemetryDir(packed)
	if err != nil {
		t.Fatal(err)
	}
	if got != filepath.Join(packed, "telemetry") {
		t.Errorf("extracted dir = %q", got)
	}
	if _, err := os.Stat(filepath.Join(got, "telemetry_manifest.json")); err != nil {
		t.Errorf("extracted manifest missing: %v", err)
	}

	if _, err := telemetryDir(filepath.Join(dir, "does-not-exist")); err == nil {
		t.Error("missing artifact dir must error")
	}
}

func TestTableCountMapAndSetDefault(t *testing.T) {
	counts := tableCountMap([]migrate.TableCount{{Table: "users", Rows: 3}, {Table: "agents", Rows: 0}})
	if counts["users"] != 3 || counts["agents"] != 0 || len(counts) != 2 {
		t.Errorf("counts = %v", counts)
	}
	m := map[string]any{"present": 1}
	setDefault(m, "present", 2)
	setDefault(m, "absent", 3)
	if m["present"] != 1 || m["absent"] != 3 {
		t.Errorf("m = %v", m)
	}
}

func TestUploadErrorText(t *testing.T) {
	err := unprocessable("File '%s' could not be read", "a.tar.gz")
	if err.Status != 422 || err.Error() != "File 'a.tar.gz' could not be read" {
		t.Errorf("err = %d %q", err.Status, err.Error())
	}
}

func TestExtractTarGzRejectsEscapingEntries(t *testing.T) {
	archive := filepath.Join(t.TempDir(), "evil.tar.gz")
	out, err := os.Create(archive)
	if err != nil {
		t.Fatal(err)
	}
	gz := gzip.NewWriter(out)
	tw := tar.NewWriter(gz)
	content := []byte("pwned")
	if err := tw.WriteHeader(&tar.Header{Name: "../escape.txt", Mode: 0o600, Size: int64(len(content))}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(content); err != nil {
		t.Fatal(err)
	}
	for _, closer := range []func() error{tw.Close, gz.Close, out.Close} {
		if err := closer(); err != nil {
			t.Fatal(err)
		}
	}
	dest := t.TempDir()
	if err := extractTarGz(archive, dest); err == nil || !strings.Contains(err.Error(), "escapes") {
		t.Fatalf("escaping entry err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(dest), "escape.txt")); err == nil {
		t.Fatal("entry escaped the destination")
	}
}

func TestSha256File(t *testing.T) {
	path := filepath.Join(t.TempDir(), "f")
	if err := os.WriteFile(path, []byte("abc"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := sha256File(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" {
		t.Errorf("sha256 = %q", got)
	}
	if _, err := sha256File(path + "-missing"); err == nil {
		t.Error("missing file must error")
	}
}

func TestStoreUploadsRejectsUnusableDir(t *testing.T) {
	blocker := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	files := multipartFiles(t, map[string][]byte{"a.tar.gz": {0x1f, 0x8b}})
	if err := storeUploads(files, filepath.Join(blocker, "sub")); err == nil {
		t.Error("job dir under a regular file must error")
	}
}

// -- artifact purge ----------------------------------------------------

func TestPurgeExpiredArtifactsSurvivesDeadPool(t *testing.T) {
	h := newTestHandler(t)
	h.purgeExpiredArtifacts(context.Background())
}

func TestRunArtifactPurgeStopsOnCancel(t *testing.T) {
	h := newTestHandler(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	done := make(chan struct{})
	go func() {
		h.RunArtifactPurge(ctx)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("RunArtifactPurge did not stop after cancellation")
	}
}
