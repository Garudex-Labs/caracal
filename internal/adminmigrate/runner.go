// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package adminmigrate

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/cli/migrate"
	"github.com/garudex-labs/caracal/internal/settings"
)

// Runner executes migration jobs in the background against the server's
// own databases.
type Runner struct {
	Store         *Store
	Settings      *settings.Store
	Events        *eventEmitter
	PostgresDSN   string
	ClickHouseURL string
}

// artifactRoot resolves the directory that holds job artifacts.
func artifactRoot(ctx context.Context, st *settings.Store) string {
	if env := os.Getenv("MIGRATION_ARTIFACT_ROOT"); env != "" {
		return env
	}
	home, _ := os.UserHomeDir()
	fallback := filepath.Join(home, ".caracal", "migration_artifacts")
	if st != nil {
		return st.String(ctx, "migration.artifact_root", fallback)
	}
	return fallback
}

// dbReporter throttles engine progress callbacks into job-row updates.
type dbReporter struct {
	store *Store
	jobID uuid.UUID
	mu    sync.Mutex
	last  time.Time
}

func (rep *dbReporter) update(phase string, pct int, message string) {
	rep.mu.Lock()
	defer rep.mu.Unlock()
	if time.Since(rep.last) < time.Second {
		return
	}
	rep.last = time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := rep.store.UpdateProgress(ctx, rep.jobID, phase, pct, message); err != nil {
		slog.Warn("migration progress update failed", "job_id", rep.jobID, "error", err)
	}
}

// Run executes one queued job to completion. It is called in its own
// goroutine after the job row is committed.
func (rn *Runner) Run(jobID uuid.UUID) {
	base := context.Background()
	job, err := rn.Store.Get(base, jobID)
	if err != nil || job == nil {
		slog.Error("migration job not found", "job_id", jobID, "error", err)
		return
	}
	if err := rn.Store.MarkRunning(base, jobID); err != nil {
		slog.Error("migration job start failed", "job_id", jobID, "error", err)
		return
	}

	artifactDir := ""
	if job.ArtifactDir != nil {
		artifactDir = *job.ArtifactDir
	}
	if artifactDir == "" {
		artifactDir = filepath.Join(artifactRoot(base, rn.Settings), jobID.String())
	}
	_, statErr := os.Stat(artifactDir)
	createdByUs := statErr != nil
	if err := os.MkdirAll(artifactDir, 0o700); err != nil {
		rn.finish(base, job, artifactDir, nil, nil, fmt.Sprintf("Unexpected error: %v", err))
		return
	}

	reporter := &dbReporter{store: rn.Store, jobID: jobID}
	timeoutSeconds := rn.Settings.Int(base, "migration.job_timeout_seconds", 3600)
	chURL := rn.Settings.String(base, "migration.clickhouse_url", rn.ClickHouseURL)

	ctx, cancel := context.WithTimeout(base, time.Duration(timeoutSeconds)*time.Second)
	defer cancel()

	var result map[string]any
	var artifacts []ArtifactMeta
	switch job.Operation {
	case "export":
		result, artifacts, err = rn.runExport(ctx, job.Scope, chURL, artifactDir, reporter.update)
	case "import":
		result, artifacts, err = rn.runImport(ctx, job.Scope, chURL, artifactDir, reporter.update)
	case "validate":
		result, artifacts, err = rn.runValidate(ctx, job.Scope, chURL, artifactDir, reporter.update)
	default:
		err = fmt.Errorf("Unknown operation type: %s", job.Operation)
	}

	errorMessage := ""
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			errorMessage = fmt.Sprintf("Job timed out after %d seconds", timeoutSeconds)
		} else {
			errorMessage = migrate.AsError(err).Message
		}
		slog.Error("migration job failed", "job_id", jobID, "error", errorMessage)
		// A failed export leaves no user-uploaded data worth preserving.
		if job.Operation == "export" && createdByUs {
			_ = os.RemoveAll(artifactDir)
			artifactDir = ""
		}
	}

	rn.finish(base, job, artifactDir, result, artifacts, errorMessage)
}

func (rn *Runner) finish(ctx context.Context, job *Job, artifactDir string,
	result map[string]any, artifacts []ArtifactMeta, errorMessage string) {

	status := "completed"
	var errMsg *string
	if errorMessage != "" {
		status = "failed"
		errMsg = &errorMessage
	}
	var resultJSON, artifactsJSON []byte
	if result != nil {
		resultJSON, _ = json.Marshal(result)
	}
	if len(artifacts) > 0 {
		artifactsJSON, _ = json.Marshal(artifacts)
	}
	var dir *string
	if artifactDir != "" {
		dir = &artifactDir
	}
	if err := rn.Store.Finish(ctx, job.ID, Terminal{
		Status:        status,
		ResultJSON:    resultJSON,
		ArtifactsJSON: artifactsJSON,
		ArtifactDir:   dir,
		ErrorMessage:  errMsg,
	}); err != nil {
		slog.Error("migration job finish write failed", "job_id", job.ID, "error", err)
	}

	detail := fmt.Sprintf("Migration %s %s (scope=%s)", job.Operation, status, job.Scope)
	if total, ok := result["total_rows"]; ok {
		detail += fmt.Sprintf(" total_rows=%v", total)
	}
	severity, outcome := "info", "success"
	if status == "failed" {
		severity, outcome = "warning", "failure"
	}
	rn.Events.emit(ctx, severity, outcome, "system", "", "", job.ID.String(), "migration_job", detail)
	slog.Info("migration job finished", "job_id", job.ID, "status", status)
}

// ── Operation dispatchers ─────────────────────────────────────────────

func tableCountMap(counts []migrate.TableCount) map[string]int64 {
	out := map[string]int64{}
	for _, tc := range counts {
		out[tc.Table] = tc.Rows
	}
	return out
}

func (rn *Runner) runExport(ctx context.Context, scope, chURL, artifactDir string,
	report migrate.ProgressFunc) (map[string]any, []ArtifactMeta, error) {

	result := map[string]any{}
	var artifacts []ArtifactMeta

	if scope == "postgres" || scope == "both" {
		outputPath := filepath.Join(artifactDir, "pg_export.tar.gz")
		res, err := migrate.ExportPG(ctx, rn.PostgresDSN, outputPath, report)
		if err != nil {
			return nil, nil, err
		}
		result["table_counts"] = tableCountMap(res.TableCounts)
		result["total_rows"] = res.TotalRows
		var archiveSize any
		if info, statErr := os.Stat(outputPath); statErr == nil {
			archiveSize = info.Size()
			hash, hashErr := sha256File(outputPath)
			if hashErr != nil {
				return nil, nil, hashErr
			}
			artifacts = append(artifacts, ArtifactMeta{
				Name: filepath.Base(outputPath), SizeBytes: info.Size(), Sha256: hash, Kind: "archive",
			})
		}
		result["archive_size_bytes"] = archiveSize
	}

	if scope == "clickhouse" || scope == "both" {
		manifestPath := filepath.Join(artifactDir, "pg_export.manifest.json")
		if _, err := os.Stat(manifestPath); err != nil {
			manifestPath = filepath.Join(artifactDir, "migration_manifest.json")
		}
		chOutputDir := filepath.Join(artifactDir, "telemetry")
		chRes, err := migrate.ExportCH(ctx, chURL, manifestPath, chOutputDir, report)
		if err != nil {
			return nil, nil, err
		}
		result["telemetry_size_bytes"] = chRes.TotalSizeBytes

		// Pack the Parquet partitions and their manifest into one archive.
		members := []string{"telemetry_manifest.json"}
		for _, table := range chRes.Tables {
			for _, file := range table.Files {
				members = append(members, file.Name)
			}
		}
		archivePath := filepath.Join(artifactDir, "telemetry_export.tar.gz")
		if err := packTarGz(archivePath, chOutputDir, members); err != nil {
			return nil, nil, err
		}
		if info, statErr := os.Stat(archivePath); statErr == nil && info.Size() > 0 {
			hash, hashErr := sha256File(archivePath)
			if hashErr != nil {
				return nil, nil, hashErr
			}
			artifacts = append(artifacts, ArtifactMeta{
				Name: filepath.Base(archivePath), SizeBytes: info.Size(), Sha256: hash, Kind: "archive",
			})
		}
	}

	setDefault(result, "telemetry_size_bytes", nil)
	setDefault(result, "archive_size_bytes", nil)
	setDefault(result, "schema_version_diff", nil)
	return result, artifacts, nil
}

func (rn *Runner) runImport(ctx context.Context, scope, chURL, artifactDir string,
	report migrate.ProgressFunc) (map[string]any, []ArtifactMeta, error) {

	rowsInserted := map[string]int64{}
	rowsSkipped := map[string]int64{}
	tablesSkipped := []string{}

	if scope == "postgres" || scope == "both" {
		archive, err := findRegistryArchive(artifactDir, "No PostgreSQL .tar.gz archive found in artifact directory")
		if err != nil {
			return nil, nil, err
		}
		res, err := migrate.ImportPG(ctx, rn.PostgresDSN, archive, report)
		if err != nil {
			return nil, nil, err
		}
		rowsInserted = tableCountMap(res.RowsInserted)
		rowsSkipped = tableCountMap(res.RowsSkipped)
	}

	if scope == "clickhouse" || scope == "both" {
		dir, err := telemetryDir(artifactDir)
		if err != nil {
			return nil, nil, err
		}
		chRes, err := migrate.ImportCH(ctx, chURL, dir, report)
		if err != nil {
			return nil, nil, err
		}
		for _, tc := range chRes.RowsImported {
			rowsInserted[tc.Table] += tc.Rows
		}
		tablesSkipped = append(tablesSkipped, chRes.TablesSkipped...)
	}

	var total int64
	for _, n := range rowsInserted {
		total += n
	}
	for _, n := range rowsSkipped {
		total += n
	}
	result := map[string]any{
		"rows_inserted":       rowsInserted,
		"rows_skipped":        rowsSkipped,
		"tables_skipped":      tablesSkipped,
		"total_rows":          total,
		"schema_version_diff": nil,
	}
	return result, nil, nil
}

func (rn *Runner) runValidate(ctx context.Context, scope, chURL, artifactDir string,
	report migrate.ProgressFunc) (map[string]any, []ArtifactMeta, error) {

	checksumDetails := map[string]bool{}
	checksumsValid := true
	result := map[string]any{
		"row_count_comparison": nil,
		"orphaned_fk_refs":     nil,
		"schema_version_diff":  nil,
	}

	if scope == "postgres" || scope == "both" {
		archive, err := findRegistryArchive(artifactDir,
			"No PostgreSQL .tar.gz archive found in artifact directory for validation")
		if err != nil {
			return nil, nil, err
		}
		res, err := migrate.ValidatePG(ctx, rn.PostgresDSN, archive, report)
		if err != nil {
			return nil, nil, err
		}
		checksumsValid = checksumsValid && res.ArchiveValid
		for _, cr := range res.ChecksumResults {
			checksumDetails[cr.TableName] = cr.Passed
		}
		if res.CrossDBResults != nil {
			comparison := map[string][]int64{}
			for _, pair := range res.CrossDBResults {
				comparison[pair.Table] = []int64{pair.ArchiveRows, pair.DatabaseRows}
			}
			result["row_count_comparison"] = comparison
		}
	}

	if scope == "clickhouse" || scope == "both" {
		dir, err := telemetryDir(artifactDir)
		if err != nil {
			return nil, nil, err
		}
		chVal, err := migrate.ValidateCH(ctx, chURL, rn.PostgresDSN, dir, report)
		if err != nil {
			return nil, nil, err
		}
		checksumsValid = checksumsValid && chVal.ChecksumsValid
		for _, fc := range chVal.ChecksumResults {
			checksumDetails[fc.Name] = fc.Passed
		}
		if chVal.FKResults != nil {
			result["orphaned_fk_refs"] = fkResultsMap(chVal.FKResults)
		}
	}

	result["checksums_valid"] = checksumsValid
	result["checksum_details"] = checksumDetails
	return result, nil, nil
}

func fkResultsMap(fk *migrate.FKResults) map[string]any {
	agentIDs := fk.OrphanedAgentIDs
	if agentIDs == nil {
		agentIDs = []string{}
	}
	userIDs := fk.OrphanedUserIDs
	if userIDs == nil {
		userIDs = []string{}
	}
	return map[string]any{
		"orphaned_agent_ids":           agentIDs,
		"orphaned_agent_ids_truncated": fk.OrphanedAgentIDsTruncated,
		"orphaned_user_ids":            userIDs,
		"orphaned_user_ids_truncated":  fk.OrphanedUserIDsTruncated,
	}
}

func setDefault(m map[string]any, key string, value any) {
	if _, ok := m[key]; !ok {
		m[key] = value
	}
}

// findRegistryArchive locates the registry archive among uploaded or
// exported files, ignoring telemetry archives.
func findRegistryArchive(dir, missing string) (string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", &migrate.Error{Kind: migrate.KindMigration, Message: missing}
	}
	var candidates []string
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || strings.HasPrefix(name, "telemetry") {
			continue
		}
		if strings.HasSuffix(name, ".tar.gz") || strings.HasSuffix(name, ".tgz") {
			candidates = append(candidates, name)
		}
	}
	if len(candidates) == 0 {
		return "", &migrate.Error{Kind: migrate.KindMigration, Message: missing}
	}
	sort.Strings(candidates)
	return filepath.Join(dir, candidates[0]), nil
}

// telemetryDir extracts any uploaded telemetry archive and returns the
// directory holding the Parquet files and telemetry manifest.
func telemetryDir(artifactDir string) (string, error) {
	extracted := filepath.Join(artifactDir, "telemetry")
	if info, err := os.Stat(extracted); err == nil && info.IsDir() {
		return extracted, nil
	}
	entries, err := os.ReadDir(artifactDir)
	if err != nil {
		return "", err
	}
	var archives []string
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() && strings.HasPrefix(name, "telemetry") && strings.HasSuffix(name, ".gz") {
			archives = append(archives, name)
		}
	}
	if len(archives) == 0 {
		return artifactDir, nil
	}
	sort.Strings(archives)
	if err := os.MkdirAll(extracted, 0o700); err != nil {
		return "", err
	}
	if err := extractTarGz(filepath.Join(artifactDir, archives[0]), extracted); err != nil {
		return "", err
	}
	return extracted, nil
}

// ── Archive helpers ───────────────────────────────────────────────────

func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// packTarGz writes the named members of srcDir into a flat tar.gz,
// skipping members that do not exist.
func packTarGz(archivePath, srcDir string, members []string) error {
	out, err := os.OpenFile(archivePath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	gz := gzip.NewWriter(out)
	tw := tar.NewWriter(gz)

	writeAll := func() error {
		for _, name := range members {
			path := filepath.Join(srcDir, name)
			info, err := os.Stat(path)
			if err != nil || !info.Mode().IsRegular() {
				continue
			}
			hdr := &tar.Header{
				Name:    name,
				Mode:    0o600,
				Size:    info.Size(),
				ModTime: info.ModTime(),
			}
			if err := tw.WriteHeader(hdr); err != nil {
				return err
			}
			f, err := os.Open(path)
			if err != nil {
				return err
			}
			_, err = io.Copy(tw, f)
			_ = f.Close()
			if err != nil {
				return err
			}
		}
		return nil
	}

	err = writeAll()
	if closeErr := tw.Close(); err == nil {
		err = closeErr
	}
	if closeErr := gz.Close(); err == nil {
		err = closeErr
	}
	if closeErr := out.Close(); err == nil {
		err = closeErr
	}
	return err
}

// extractTarGz unpacks regular files and directories, rejecting entries
// that would escape the destination.
func extractTarGz(archivePath, destDir string) error {
	f, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer func() { _ = gz.Close() }()
	tr := tar.NewReader(gz)
	cleanDest := filepath.Clean(destDir)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		target := filepath.Join(cleanDest, hdr.Name)
		if target != cleanDest && !strings.HasPrefix(target, cleanDest+string(os.PathSeparator)) {
			return fmt.Errorf("archive entry escapes destination: %s", hdr.Name)
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o700); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
				return err
			}
			out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
			if err != nil {
				return err
			}
			_, err = io.Copy(out, tr)
			if closeErr := out.Close(); err == nil {
				err = closeErr
			}
			if err != nil {
				return err
			}
		default:
			// Symlinks, devices, and other special entries are skipped.
		}
	}
}
