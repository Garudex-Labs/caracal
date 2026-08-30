// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package adminmigrate serves the data migration administration API:
// export, import, and validation jobs over the registry database and
// telemetry store, plus tokenized artifact downloads.
package adminmigrate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/settings"
)

const (
	defaultMaxUploadBytes = int64(5) << 30 // 5 GB
	downloadTokenTTL      = 5 * time.Minute
	securityEventType     = "admin.setting.changed"
)

// eventEmitter records security events in ClickHouse, best-effort.
type eventEmitter struct {
	CH *clickhouse.Client
}

func (e *eventEmitter) emit(ctx context.Context, severity, outcome, actorID, actorEmail, actorRole, targetID, targetType, detail string) {
	if e == nil || e.CH == nil {
		return
	}
	_ = e.CH.InsertJSONEachRow(ctx, "INSERT INTO security_events FORMAT JSONEachRow", []any{
		map[string]any{
			"event_id": uuid.NewString(), "timestamp": time.Now().UTC().Format("2006-01-02 15:04:05.000000"),
			"event_type": securityEventType, "severity": severity, "actor_id": actorID,
			"actor_email": actorEmail, "actor_role": actorRole, "target_id": targetID,
			"target_type": targetType, "outcome": outcome,
			"source_ip": nil, "user_agent": nil, "detail": detail,
		},
	})
}

// Handler serves the migration administration routes.
type Handler struct {
	Store    *Store
	Runner   *Runner
	Signer   *TokenSigner
	Settings *settings.Store
	Events   *eventEmitter
}

// NewHandler wires the handler and its background runner.
func NewHandler(store *Store, runner *Runner, signer *TokenSigner, st *settings.Store, ch *clickhouse.Client) *Handler {
	events := &eventEmitter{CH: ch}
	runner.Events = events
	return &Handler{Store: store, Runner: runner, Signer: signer, Settings: st, Events: events}
}

// Register mounts the routes. Job management requires the operator
// floor; downloads are authorized by the signed token alone.
func (h *Handler) Register(mux *http.ServeMux, withSuperAdmin, withPublic func(http.Handler) http.Handler) {
	mux.Handle("POST /api/v1/operator/migrate/export", withSuperAdmin(http.HandlerFunc(h.startExport)))
	mux.Handle("POST /api/v1/operator/migrate/import", withSuperAdmin(http.HandlerFunc(h.startImport)))
	mux.Handle("POST /api/v1/operator/migrate/validate", withSuperAdmin(http.HandlerFunc(h.startValidate)))
	mux.Handle("GET /api/v1/operator/migrate/jobs", withSuperAdmin(http.HandlerFunc(h.listJobs)))
	mux.Handle("GET /api/v1/operator/migrate/jobs/{job_id}", withSuperAdmin(http.HandlerFunc(h.getJob)))
	mux.Handle("POST /api/v1/operator/migrate/jobs/{job_id}/artifacts/{name}/token", withSuperAdmin(http.HandlerFunc(h.artifactToken)))
	mux.Handle("GET /api/v1/operator/migrate/download", withPublic(http.HandlerFunc(h.download)))
}

// actor is the authenticated administrator resolved from the request.
type actor struct {
	ID    uuid.UUID
	Email string
	Role  string
}

func (h *Handler) caller(w http.ResponseWriter, r *http.Request) (*actor, bool) {
	claims, ok := httpapi.ClaimsFrom(r.Context())
	if !ok {
		httpapi.WriteError(w, http.StatusUnauthorized, "Missing credentials")
		return nil, false
	}
	a := actor{ID: claims.UserID, Email: claims.Email, Role: claims.Role}
	_ = h.Store.DB.QueryRow(r.Context(),
		`SELECT email, role FROM users WHERE id = $1`, claims.UserID).Scan(&a.Email, &a.Role)
	return &a, true
}

func validScope(scope string) bool {
	return scope == "postgres" || scope == "clickhouse" || scope == "both"
}

func (h *Handler) createAndLaunch(w http.ResponseWriter, r *http.Request, a *actor, op, scope, artifactDir string) (uuid.UUID, bool) {
	jobID, err := h.Store.CreateJob(r.Context(), op, scope, a.ID, artifactDir)
	if err != nil {
		var conflict *ConflictError
		if errors.As(err, &conflict) {
			httpapi.WriteError(w, http.StatusConflict, conflict.Error())
		} else {
			httpapi.WriteInternalError(w, r, err)
		}
		return uuid.Nil, false
	}
	return jobID, true
}

// ── Start endpoints ───────────────────────────────────────────────────

func (h *Handler) startExport(w http.ResponseWriter, r *http.Request) {
	a, ok := h.caller(w, r)
	if !ok {
		return
	}
	var body struct {
		Scope string `json:"scope"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || !validScope(body.Scope) {
		httpapi.WriteError(w, http.StatusUnprocessableEntity,
			"Input should be 'postgres', 'clickhouse' or 'both'")
		return
	}
	if body.Scope == "clickhouse" {
		httpapi.WriteError(w, http.StatusUnprocessableEntity,
			"Standalone ClickHouse export is not supported; use 'both' or 'postgres'")
		return
	}

	jobID, ok := h.createAndLaunch(w, r, a, "export", body.Scope, "")
	if !ok {
		return
	}
	h.Events.emit(r.Context(), "warning", "success", a.ID.String(), a.Email, a.Role,
		jobID.String(), "migration_job", fmt.Sprintf("Migration export started (scope=%s)", body.Scope))
	go h.Runner.Run(jobID)
	httpapi.WriteJSON(w, http.StatusAccepted, map[string]string{"job_id": jobID.String()})
}

func (h *Handler) startImport(w http.ResponseWriter, r *http.Request) {
	h.startUpload(w, r, "import")
}

func (h *Handler) startValidate(w http.ResponseWriter, r *http.Request) {
	h.startUpload(w, r, "validate")
}

func (h *Handler) startUpload(w http.ResponseWriter, r *http.Request, op string) {
	a, ok := h.caller(w, r)
	if !ok {
		return
	}
	scope := r.URL.Query().Get("scope")
	if scope == "" {
		scope = "both"
	}
	if !validScope(scope) {
		httpapi.WriteError(w, http.StatusUnprocessableEntity,
			"Input should be 'postgres', 'clickhouse' or 'both'")
		return
	}
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "Invalid multipart form data")
		return
	}
	defer func() { _ = r.MultipartForm.RemoveAll() }()
	files := r.MultipartForm.File["files"]
	if len(files) == 0 {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "No files uploaded")
		return
	}

	maxBytes := int64(h.Settings.Int(r.Context(), "migration.max_upload_bytes", int(defaultMaxUploadBytes)))
	if uploadErr := validateUploads(files, scope, maxBytes); uploadErr != nil {
		httpapi.WriteError(w, uploadErr.Status, uploadErr.Detail)
		return
	}

	jobID := uuid.New()
	jobDir := filepath.Join(artifactRoot(r.Context(), h.Settings), jobID.String())
	if err := storeUploads(files, jobDir); err != nil {
		_ = os.RemoveAll(jobDir)
		httpapi.WriteInternalError(w, r, err)
		return
	}
	if _, err := h.Store.createJobWithID(r.Context(), jobID, op, scope, a.ID, jobDir); err != nil {
		_ = os.RemoveAll(jobDir)
		var conflict *ConflictError
		if errors.As(err, &conflict) {
			httpapi.WriteError(w, http.StatusConflict, conflict.Error())
		} else {
			httpapi.WriteInternalError(w, r, err)
		}
		return
	}

	h.Events.emit(r.Context(), "warning", "success", a.ID.String(), a.Email, a.Role,
		jobID.String(), "migration_job",
		fmt.Sprintf("Migration %s started (scope=%s, files=%d)", op, scope, len(files)))
	go h.Runner.Run(jobID)
	httpapi.WriteJSON(w, http.StatusAccepted, map[string]string{"job_id": jobID.String()})
}

// ── Status endpoints ──────────────────────────────────────────────────

func (h *Handler) getJob(w http.ResponseWriter, r *http.Request) {
	jobID, err := uuid.Parse(r.PathValue("job_id"))
	if err != nil {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "Invalid job ID format")
		return
	}
	job, err := h.Store.Get(r.Context(), jobID)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	if job == nil {
		httpapi.WriteError(w, http.StatusNotFound, "Migration job not found")
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, wireJob(job))
}

func (h *Handler) listJobs(w http.ResponseWriter, r *http.Request) {
	limit, err := queryInt(r, "limit", 20, 1, 100)
	if err != nil {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	offset, err := queryInt(r, "offset", 0, 0, 1<<31-1)
	if err != nil {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	jobs, err := h.Store.List(r.Context(), limit, offset)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	out := make([]jobResponse, 0, len(jobs))
	for _, j := range jobs {
		out = append(out, wireJob(j))
	}
	httpapi.WriteJSON(w, http.StatusOK, out)
}

func queryInt(r *http.Request, name string, fallback, min, max int) (int, error) {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < min || value > max {
		return 0, fmt.Errorf("Invalid %s", name)
	}
	return value, nil
}

// ── Artifact token + download ─────────────────────────────────────────

func (h *Handler) artifactToken(w http.ResponseWriter, r *http.Request) {
	a, ok := h.caller(w, r)
	if !ok {
		return
	}
	jobID, err := uuid.Parse(r.PathValue("job_id"))
	if err != nil {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "Invalid job ID format")
		return
	}
	name := r.PathValue("name")

	job, err := h.Store.Get(r.Context(), jobID)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	if job == nil {
		httpapi.WriteError(w, http.StatusNotFound, "Migration job not found")
		return
	}
	artifacts := wireJob(job).Artifacts
	if len(artifacts) == 0 {
		httpapi.WriteError(w, http.StatusNotFound, "No artifacts available for this job")
		return
	}
	found := false
	for _, artifact := range artifacts {
		if artifact.Name == name {
			found = true
			break
		}
	}
	if !found {
		httpapi.WriteError(w, http.StatusNotFound, fmt.Sprintf("Artifact '%s' not found", name))
		return
	}

	expiresAt := time.Now().UTC().Add(downloadTokenTTL)
	token, err := h.Signer.Sign(map[string]any{
		"typ":      "migration_artifact",
		"job_id":   jobID.String(),
		"artifact": name,
		"sub":      a.ID.String(),
		"exp":      expiresAt.Unix(),
	})
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"token":      token,
		"expires_at": wireTimeZ(expiresAt),
	})
}

func (h *Handler) download(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if token == "" {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "Field required: token")
		return
	}
	claims, err := h.Signer.Verify(token)
	if err != nil {
		httpapi.WriteError(w, http.StatusForbidden, "Invalid or expired download token")
		return
	}
	if typ, _ := claims["typ"].(string); typ != "migration_artifact" {
		httpapi.WriteError(w, http.StatusForbidden, "Invalid token type")
		return
	}
	exp, hasExp := claims["exp"].(float64)
	if !hasExp || float64(time.Now().Unix()) > exp {
		httpapi.WriteError(w, http.StatusForbidden, "Download token has expired")
		return
	}
	jobIDRaw, _ := claims["job_id"].(string)
	artifactName, _ := claims["artifact"].(string)
	subject, _ := claims["sub"].(string)
	if jobIDRaw == "" || artifactName == "" {
		httpapi.WriteError(w, http.StatusForbidden, "Malformed token")
		return
	}
	jobID, err := uuid.Parse(jobIDRaw)
	if err != nil {
		httpapi.WriteError(w, http.StatusForbidden, "Invalid token")
		return
	}

	job, err := h.Store.Get(r.Context(), jobID)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	if job == nil || job.ArtifactDir == nil || *job.ArtifactDir == "" {
		httpapi.WriteError(w, http.StatusNotFound, "Artifact not found or purged")
		return
	}

	// Resolve and pin the artifact under its directory before touching
	// the filesystem, so crafted names cannot traverse out of it.
	baseDir, err := filepath.EvalSymlinks(*job.ArtifactDir)
	if err != nil {
		httpapi.WriteError(w, http.StatusNotFound, "Artifact not found or purged")
		return
	}
	sep := string(os.PathSeparator)
	candidate := filepath.Join(baseDir, artifactName)
	if candidate == baseDir || !strings.HasPrefix(candidate, baseDir+sep) {
		httpapi.WriteError(w, http.StatusForbidden, "Invalid artifact name")
		return
	}
	resolved, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		httpapi.WriteError(w, http.StatusNotFound, "Artifact file not found (may have been purged)")
		return
	}
	if resolved != baseDir && !strings.HasPrefix(resolved, baseDir+sep) {
		httpapi.WriteError(w, http.StatusForbidden, "Invalid artifact name")
		return
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.Mode().IsRegular() {
		httpapi.WriteError(w, http.StatusNotFound, "Artifact file not found (may have been purged)")
		return
	}

	h.Events.emit(r.Context(), "info", "success", subject, "", "",
		jobID.String(), "migration_artifact", fmt.Sprintf("Artifact downloaded: %s", artifactName))

	f, err := os.Open(resolved)
	if err != nil {
		httpapi.WriteError(w, http.StatusNotFound, "Artifact file not found (may have been purged)")
		return
	}
	defer func() { _ = f.Close() }()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filepath.Base(resolved)))
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, f)
}
