// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package adminmigrate

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Job is one row of the migration_jobs table.
type Job struct {
	ID              uuid.UUID
	Operation       string // wire form: export | import | validate
	Scope           string // postgres | clickhouse | both
	Status          string // queued | running | completed | failed
	ProgressPhase   *string
	ProgressPct     int
	ProgressMessage *string
	ErrorMessage    *string
	CreatedAt       time.Time
	FinishedAt      *time.Time
	ArtifactsJSON   []byte
	ResultJSON      []byte
	SchemaVersion   *string
	ArtifactDir     *string
}

// ConflictError reports a queued or running job for the same operation
// and scope.
type ConflictError struct {
	Operation string
	Scope     string
	Existing  string
}

func (e *ConflictError) Error() string {
	return fmt.Sprintf("A %s job for scope '%s' is already %s", e.Operation, e.Scope, e.Existing)
}

// The migration_operation enum labels the import member "import_"; the
// wire value is "import".
func opToDB(op string) string {
	if op == "import" {
		return "import_"
	}
	return op
}

func opToWire(label string) string {
	if label == "import_" {
		return "import"
	}
	return label
}

// Store persists migration jobs in PostgreSQL.
type Store struct {
	DB *pgxpool.Pool
}

const jobColumns = `id::text, operation_type::text, data_scope::text, status::text,
	progress_phase, progress_pct, progress_message, error_message,
	created_at, finished_at, artifacts_json::text, result_json::text,
	schema_version, artifact_dir`

func scanJob(row pgx.Row) (*Job, error) {
	var j Job
	var id string
	var artifacts, result *string
	err := row.Scan(&id, &j.Operation, &j.Scope, &j.Status,
		&j.ProgressPhase, &j.ProgressPct, &j.ProgressMessage, &j.ErrorMessage,
		&j.CreatedAt, &j.FinishedAt, &artifacts, &result,
		&j.SchemaVersion, &j.ArtifactDir)
	if err != nil {
		return nil, err
	}
	j.ID, err = uuid.Parse(id)
	if err != nil {
		return nil, err
	}
	j.Operation = opToWire(j.Operation)
	if artifacts != nil {
		j.ArtifactsJSON = []byte(*artifacts)
	}
	if result != nil {
		j.ResultJSON = []byte(*result)
	}
	return &j, nil
}

// CreateJob inserts a queued job after verifying no job with the same
// operation and scope is already queued or running.
func (s *Store) CreateJob(ctx context.Context, op, scope string, createdBy uuid.UUID, artifactDir string) (uuid.UUID, error) {
	return s.createJobWithID(ctx, uuid.New(), op, scope, createdBy, artifactDir)
}

// createJobWithID is CreateJob for a caller-supplied id (upload jobs key
// their artifact directory by it). The concurrency check and insert share
// one transaction with a row lock to close the race between them.
func (s *Store) createJobWithID(ctx context.Context, id uuid.UUID, op, scope string, createdBy uuid.UUID, artifactDir string) (uuid.UUID, error) {
	message := map[string]string{
		"export":   "Export queued",
		"import":   "Import queued",
		"validate": "Validation queued",
	}[op]
	var dir *string
	if artifactDir != "" {
		dir = &artifactDir
	}

	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return uuid.Nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var existing string
	err = tx.QueryRow(ctx,
		`SELECT status::text FROM migration_jobs
		 WHERE operation_type = $1::migration_operation
		   AND data_scope = $2::migration_scope
		   AND status IN ('queued', 'running')
		 FOR UPDATE SKIP LOCKED
		 LIMIT 1`,
		opToDB(op), scope).Scan(&existing)
	if err == nil {
		return uuid.Nil, &ConflictError{Operation: op, Scope: scope, Existing: existing}
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, err
	}

	_, err = tx.Exec(ctx,
		`INSERT INTO migration_jobs
		   (id, operation_type, data_scope, status, progress_phase, progress_pct,
		    progress_message, created_by, created_at, artifact_dir)
		 VALUES ($1::uuid, $2::migration_operation, $3::migration_scope, 'queued', 'queued', 0,
		    $4, $5::uuid, now(), $6)`,
		id.String(), opToDB(op), scope, message, createdBy.String(), dir)
	if err != nil {
		return uuid.Nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return uuid.Nil, err
	}
	return id, nil
}

// Get returns a job by id, or (nil, nil) when it does not exist.
func (s *Store) Get(ctx context.Context, id uuid.UUID) (*Job, error) {
	row := s.DB.QueryRow(ctx,
		`SELECT `+jobColumns+` FROM migration_jobs WHERE id = $1::uuid`, id.String())
	j, err := scanJob(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return j, nil
}

// List returns jobs newest-first.
func (s *Store) List(ctx context.Context, limit, offset int) ([]*Job, error) {
	rows, err := s.DB.Query(ctx,
		`SELECT `+jobColumns+` FROM migration_jobs
		 ORDER BY created_at DESC LIMIT $1 OFFSET $2`, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	jobs := []*Job{}
	for rows.Next() {
		j, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		jobs = append(jobs, j)
	}
	return jobs, rows.Err()
}

// MarkRunning stamps the running state at job start.
func (s *Store) MarkRunning(ctx context.Context, id uuid.UUID) error {
	_, err := s.DB.Exec(ctx,
		`UPDATE migration_jobs
		 SET status = 'running', started_at = now(),
		     progress_phase = 'initializing', progress_message = 'Job started'
		 WHERE id = $1::uuid`, id.String())
	return err
}

// UpdateProgress writes one progress snapshot.
func (s *Store) UpdateProgress(ctx context.Context, id uuid.UUID, phase string, pct int, message string) error {
	_, err := s.DB.Exec(ctx,
		`UPDATE migration_jobs
		 SET progress_phase = $2, progress_pct = $3, progress_message = $4,
		     progress_updated_at = now()
		 WHERE id = $1::uuid`, id.String(), phase, pct, message)
	return err
}

// Terminal is the final state written when a job ends.
type Terminal struct {
	Status        string
	ResultJSON    []byte
	ArtifactsJSON []byte
	ArtifactDir   *string
	SchemaVersion *string
	ErrorMessage  *string
}

// Finish writes the terminal state for a job.
func (s *Store) Finish(ctx context.Context, id uuid.UUID, t Terminal) error {
	phase := "completed"
	pct := 100
	message := "Completed"
	progressMessage := &message
	if t.Status != "completed" {
		phase = "failed"
		pct = 0
		progressMessage = t.ErrorMessage
	}
	var result, artifacts *string
	if len(t.ResultJSON) > 0 {
		s := string(t.ResultJSON)
		result = &s
	}
	if len(t.ArtifactsJSON) > 0 {
		s := string(t.ArtifactsJSON)
		artifacts = &s
	}
	_, err := s.DB.Exec(ctx,
		`UPDATE migration_jobs
		 SET status = $2::migration_status, finished_at = now(),
		     result_json = $3::json, artifacts_json = $4::json,
		     artifact_dir = $5, schema_version = $6, error_message = $7,
		     progress_phase = $8, progress_pct = $9, progress_message = $10
		 WHERE id = $1::uuid`,
		id.String(), t.Status, result, artifacts,
		t.ArtifactDir, t.SchemaVersion, t.ErrorMessage,
		phase, pct, progressMessage)
	return err
}
