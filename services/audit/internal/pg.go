// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Append-only PostgreSQL writer with per-zone hash chain, HMAC, and forensic helpers.

package internal

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/garudex-labs/caracal/packages/core/go/config"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	dbDefaultMaxConns        = 20
	dbDefaultMinConns        = 2
	dbDefaultConnectTimeout  = 10 * time.Second
	dbDefaultMaxConnLifetime = 30 * time.Minute
	dbDefaultMaxConnIdle     = 5 * time.Minute
	dbDefaultHealthCheck     = 30 * time.Second
)

// ErrConflictMismatch indicates a duplicate (id, occurred_at) row whose stored
// content hash differs from the incoming event. Caller routes to the DLQ.
var ErrConflictMismatch = errors.New("audit: duplicate event with mismatched content hash")

// newPool returns a pgxpool.Pool with bounded connection counts and timeouts so
// the audit worker cannot exhaust the shared Postgres and recovers from blips.
func newPool(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse postgres config: %w", err)
	}
	cfg.MaxConns = config.Int32Env("DB_MAX_CONNS", dbDefaultMaxConns)
	cfg.MinConns = config.Int32Env("DB_MIN_CONNS", dbDefaultMinConns)
	cfg.MaxConnLifetime = config.DurationEnv("DB_MAX_CONN_LIFETIME", dbDefaultMaxConnLifetime)
	cfg.MaxConnIdleTime = config.DurationEnv("DB_MAX_CONN_IDLE", dbDefaultMaxConnIdle)
	cfg.HealthCheckPeriod = config.DurationEnv("DB_HEALTH_CHECK_PERIOD", dbDefaultHealthCheck)
	cfg.ConnConfig.ConnectTimeout = config.DurationEnv("DB_CONNECT_TIMEOUT", dbDefaultConnectTimeout)
	// The audit writer records events for every zone, so each session carries the
	// RLS sentinel; row-level security stays a backstop for the per-request zone
	// scoping in the control plane.
	cfg.ConnConfig.RuntimeParams["caracal.zone_id"] = "*"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect postgres: %w", err)
	}
	return pool, nil
}

// auditPool is the pool surface PGWriter uses; *pgxpool.Pool satisfies it.
type auditPool interface {
	BeginTx(ctx context.Context, txOptions pgx.TxOptions) (pgx.Tx, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
	Acquire(ctx context.Context) (*pgxpool.Conn, error)
	Ping(ctx context.Context) error
}

type PGWriter struct {
	db           auditPool
	auditHMACKey []byte
	onInsert     func()
}

// InsertResult reports the chain coordinates assigned to a successful insert.
type InsertResult struct {
	ContentSHA256 string
	ChainHMAC     string
	ChainSeq      int64
	Inserted      bool
}

// Insert appends ev to audit_events with chained hash + HMAC. On duplicate
// (id, occurred_at) the stored content hash is compared; mismatch returns
// ErrConflictMismatch and records an audit_ingest_alerts row.
func (w *PGWriter) Insert(ctx context.Context, ev AuditEvent, ingestSig string) (InsertResult, error) {
	tx, err := w.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return InsertResult{}, err
	}
	defer tx.Rollback(ctx)

	// Per-zone advisory lock serialises chain head reads/writes.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, ev.ZoneID); err != nil {
		return InsertResult{}, err
	}

	// Canonicalise the event to its stored representation before hashing:
	// timestamptz keeps microseconds and jsonb normalises JSON text, so the
	// tamper sweep recomputes the hash over exactly these bytes when it reads
	// the row back. Hashing the raw wire bytes would mismatch on every row.
	ev.OccurredAt = ev.OccurredAt.UTC().Truncate(time.Microsecond)
	if err := tx.QueryRow(ctx,
		`SELECT $1::jsonb::text, $2::jsonb::text, $3::jsonb::text`,
		nullableJSON(ev.DeterminingPoliciesJSON),
		nullableJSON(ev.DiagnosticsJSON),
		nullableJSON(ev.MetadataJSON),
	).Scan(
		jsonText(&ev.DeterminingPoliciesJSON),
		jsonText(&ev.DiagnosticsJSON),
		jsonText(&ev.MetadataJSON),
	); err != nil {
		return InsertResult{}, err
	}

	var prevHash string
	var prevSeq int64
	err = tx.QueryRow(ctx,
		`SELECT COALESCE(content_sha256,''), COALESCE(chain_seq,0)
		 FROM audit_events
		 WHERE zone_id = $1
		 ORDER BY chain_seq DESC NULLS LAST
		 LIMIT 1`, ev.ZoneID).Scan(&prevHash, &prevSeq)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return InsertResult{}, err
	}

	contentSHA := contentHash(ev)
	chainHMAC := w.computeHMAC(contentSHA, prevHash)
	nextSeq := prevSeq + 1

	tag, err := tx.Exec(ctx,
		`INSERT INTO audit_events
		 (id, zone_id, event_type, request_id, decision, policy_set_id,
		  policy_set_version_id, manifest_sha, evaluation_status,
		  determining_policies_json, diagnostics_json, metadata_json,
		  occurred_at, content_sha256, prev_content_sha256, chain_hmac,
		  chain_seq, ingest_signature)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,
		         $13,$14,$15,$16,$17,$18)
		 ON CONFLICT (id, occurred_at) DO NOTHING`,
		ev.ID, ev.ZoneID, ev.EventType, ev.RequestID, ev.Decision,
		ev.PolicySetID, ev.PolicySetVersionID, ev.ManifestSHA,
		ev.EvaluationStatus,
		nullableJSON(ev.DeterminingPoliciesJSON),
		nullableJSON(ev.DiagnosticsJSON),
		nullableJSON(ev.MetadataJSON),
		ev.OccurredAt, contentSHA, nullEmpty(prevHash), chainHMAC,
		nextSeq, nullEmpty(ingestSig),
	)
	if err != nil {
		return InsertResult{}, err
	}

	if tag.RowsAffected() == 0 {
		// Conflict: compare stored hash for tamper-on-replay detection.
		var existing string
		if qerr := tx.QueryRow(ctx,
			`SELECT COALESCE(content_sha256,'') FROM audit_events
			 WHERE id = $1 AND occurred_at = $2`,
			ev.ID, ev.OccurredAt).Scan(&existing); qerr == nil && existing != "" && existing != contentSHA {
			_, _ = tx.Exec(ctx,
				`INSERT INTO audit_ingest_alerts (event_id, zone_id, kind, detail)
				 VALUES ($1,$2,'content_mismatch_on_replay',$3)`,
				ev.ID, ev.ZoneID,
				fmt.Sprintf("stored=%s incoming=%s", existing, contentSHA))
			if cerr := tx.Commit(ctx); cerr != nil {
				return InsertResult{}, cerr
			}
			return InsertResult{ContentSHA256: contentSHA}, ErrConflictMismatch
		}
		if cerr := tx.Commit(ctx); cerr != nil {
			return InsertResult{}, cerr
		}
		return InsertResult{ContentSHA256: contentSHA}, nil // benign duplicate
	}

	if err := tx.Commit(ctx); err != nil {
		return InsertResult{}, err
	}
	if w.onInsert != nil {
		w.onInsert()
	}
	return InsertResult{
		ContentSHA256: contentSHA,
		ChainHMAC:     chainHMAC,
		ChainSeq:      nextSeq,
		Inserted:      true,
	}, nil
}

// QuerySinceFn streams events in [since, until) by ingested_at to f, avoiding
// loading the whole window into memory. since/until are partition-friendly.
func (w *PGWriter) QuerySinceFn(ctx context.Context, since, until time.Time, byIngest bool, f func(EventRow) error) error {
	col := "occurred_at"
	if byIngest {
		col = "ingested_at"
	}
	rows, err := w.db.Query(ctx,
		fmt.Sprintf(
			`SELECT id, zone_id, event_type,
			        COALESCE(request_id,''), COALESCE(decision,''),
			        COALESCE(policy_set_id,''), COALESCE(policy_set_version_id,''),
			        COALESCE(manifest_sha,''), COALESCE(evaluation_status,''),
			        COALESCE(determining_policies_json::text,'null'),
			        COALESCE(diagnostics_json::text,'null'),
			        COALESCE(metadata_json::text,'null'),
			        occurred_at, ingested_at,
			        COALESCE(content_sha256,''), COALESCE(prev_content_sha256,''),
			        COALESCE(chain_hmac,''), COALESCE(chain_seq,0)
			 FROM audit_events WHERE %s >= $1 AND %s < $2
			 ORDER BY zone_id, chain_seq`, col, col),
		since, until,
	)
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var r EventRow
		var detJSON, diagJSON, metaJSON string
		if err := rows.Scan(
			&r.Event.ID, &r.Event.ZoneID, &r.Event.EventType,
			&r.Event.RequestID, &r.Event.Decision,
			&r.Event.PolicySetID, &r.Event.PolicySetVersionID, &r.Event.ManifestSHA,
			&r.Event.EvaluationStatus, &detJSON, &diagJSON, &metaJSON,
			&r.Event.OccurredAt, &r.IngestedAt,
			&r.ContentSHA256, &r.PrevContentSHA256, &r.ChainHMAC, &r.ChainSeq,
		); err != nil {
			return err
		}
		if detJSON != "null" {
			r.Event.DeterminingPoliciesJSON = []byte(detJSON)
		}
		if diagJSON != "null" {
			r.Event.DiagnosticsJSON = []byte(diagJSON)
		}
		if metaJSON != "null" {
			r.Event.MetadataJSON = []byte(metaJSON)
		}
		if err := f(r); err != nil {
			return err
		}
	}
	return rows.Err()
}

// EventRow is an event plus its ingestion-time chain coordinates.
type EventRow struct {
	Event             AuditEvent
	IngestedAt        time.Time
	ContentSHA256     string
	PrevContentSHA256 string
	ChainHMAC         string
	ChainSeq          int64
}

// SearchParams filters for Search queries. ZoneID is required; all other
// fields are optional and a zero value means "no filter".
type SearchParams struct {
	ZoneID    string
	Decision  string
	RequestID string
	Since     time.Time
	Until     time.Time
	Limit     int
	Cursor    int64
}

// Search returns audit events matching p. Results are ordered by chain_seq
// ascending within the zone. Cursor resumes after the given chain_seq.
func (w *PGWriter) Search(ctx context.Context, p SearchParams) ([]EventRow, error) {
	rows, err := w.db.Query(ctx,
		`SELECT id, zone_id, event_type,
		        COALESCE(request_id,''), COALESCE(decision,''),
		        COALESCE(policy_set_id,''), COALESCE(policy_set_version_id,''),
		        COALESCE(manifest_sha,''), COALESCE(evaluation_status,''),
		        COALESCE(determining_policies_json::text,'null'),
		        COALESCE(diagnostics_json::text,'null'),
		        COALESCE(metadata_json::text,'null'),
		        occurred_at, ingested_at,
		        COALESCE(content_sha256,''), COALESCE(prev_content_sha256,''),
		        COALESCE(chain_hmac,''), COALESCE(chain_seq,0)
		 FROM audit_events
		 WHERE zone_id = $1
		   AND occurred_at >= $2
		   AND occurred_at < $3
		   AND ($4 = '' OR decision = $4)
		   AND ($5 = '' OR request_id = $5)
		   AND ($6 = 0 OR chain_seq > $6)
		 ORDER BY chain_seq ASC
		 LIMIT $7`,
		p.ZoneID, p.Since, p.Until, p.Decision, p.RequestID, p.Cursor, p.Limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []EventRow
	for rows.Next() {
		var r EventRow
		var detJSON, diagJSON, metaJSON string
		if err := rows.Scan(
			&r.Event.ID, &r.Event.ZoneID, &r.Event.EventType,
			&r.Event.RequestID, &r.Event.Decision,
			&r.Event.PolicySetID, &r.Event.PolicySetVersionID, &r.Event.ManifestSHA,
			&r.Event.EvaluationStatus, &detJSON, &diagJSON, &metaJSON,
			&r.Event.OccurredAt, &r.IngestedAt,
			&r.ContentSHA256, &r.PrevContentSHA256, &r.ChainHMAC, &r.ChainSeq,
		); err != nil {
			return nil, err
		}
		if detJSON != "null" {
			r.Event.DeterminingPoliciesJSON = []byte(detJSON)
		}
		if diagJSON != "null" {
			r.Event.DiagnosticsJSON = []byte(diagJSON)
		}
		if metaJSON != "null" {
			r.Event.MetadataJSON = []byte(metaJSON)
		}
		results = append(results, r)
	}
	return results, rows.Err()
}

// LoadWatermark returns the named export watermark or zero time if absent.
func (w *PGWriter) LoadWatermark(ctx context.Context, name string) (time.Time, error) {
	var t time.Time
	err := w.db.QueryRow(ctx,
		`SELECT last_exported_hour FROM audit_export_watermark WHERE name = $1`, name,
	).Scan(&t)
	if errors.Is(err, pgx.ErrNoRows) {
		return time.Time{}, nil
	}
	return t, err
}

// SaveWatermark records that everything up to and including hour has been exported.
func (w *PGWriter) SaveWatermark(ctx context.Context, name string, hour time.Time) error {
	_, err := w.db.Exec(ctx,
		`INSERT INTO audit_export_watermark (name, last_exported_hour, updated_at)
		 VALUES ($1, $2, now())
		 ON CONFLICT (name) DO UPDATE
		   SET last_exported_hour = EXCLUDED.last_exported_hour, updated_at = now()`,
		name, hour)
	return err
}

func (w *PGWriter) RecordIngestAlert(ctx context.Context, eventID, zoneID, kind, detail string) error {
	_, err := w.db.Exec(ctx,
		`INSERT INTO audit_ingest_alerts (event_id, zone_id, kind, detail)
		 VALUES ($1,$2,$3,$4)`,
		eventID, zoneID, kind, detail)
	return err
}

// pgAdvisoryLease is a held session-level advisory lock pinned to a dedicated
// pooled connection. The lock lives for the lifetime of that session, so the
// lease owns both the liveness probe and the unlock-and-return-to-pool release.
type pgAdvisoryLease struct {
	conn *pgxpool.Conn
	key  int64
}

// Ping reports whether the lease connection is still alive. Because the advisory
// lock is bound to this session and is never unlocked out of band, a live
// connection proves the lock is still held.
func (l *pgAdvisoryLease) Ping(ctx context.Context) error {
	return l.conn.Ping(ctx)
}

// Release unlocks the advisory lock and returns the connection to the pool.
// Returning a still-locked connection to the pool would leak the lock onto a
// reused session, so the unlock runs before the connection is handed back.
func (l *pgAdvisoryLease) Release(ctx context.Context) error {
	defer l.conn.Release()
	_, err := l.conn.Exec(ctx, `SELECT pg_advisory_unlock($1)`, l.key)
	return err
}

// AcquireAdvisoryLock attempts a session-level advisory lock on a dedicated pool
// connection. On success it returns a lease the caller must Release.
func (w *PGWriter) AcquireAdvisoryLock(ctx context.Context, key int64) (advisoryLease, bool, error) {
	conn, err := w.db.Acquire(ctx)
	if err != nil {
		return nil, false, err
	}
	var ok bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, key).Scan(&ok); err != nil {
		conn.Release()
		return nil, false, err
	}
	if !ok {
		conn.Release()
		return nil, false, nil
	}
	return &pgAdvisoryLease{conn: conn, key: key}, true, nil
}

// ConfiguredRetentionDays returns the console-managed retention window, or ok=false
// when no override row exists.
func (w *PGWriter) ConfiguredRetentionDays(ctx context.Context) (int, bool, error) {
	var days int
	err := w.db.QueryRow(ctx, `SELECT retention_days FROM audit_retention WHERE singleton`).Scan(&days)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return days, true, nil
}

// EnsurePartition creates a monthly partition for the month containing t if absent.
func (w *PGWriter) EnsurePartition(ctx context.Context, t time.Time) error {
	t = t.UTC()
	start := time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC)
	end := start.AddDate(0, 1, 0)
	name := fmt.Sprintf("audit_events_y%04dm%02d", start.Year(), int(start.Month()))
	_, err := w.db.Exec(ctx,
		fmt.Sprintf(
			`CREATE TABLE IF NOT EXISTS %s PARTITION OF audit_events
			 FOR VALUES FROM ('%s') TO ('%s')`,
			name, start.Format("2006-01-02"), end.Format("2006-01-02")))
	return err
}

// DropPartitionsBefore drops monthly partitions whose end is <= cutoff.
func (w *PGWriter) DropPartitionsBefore(ctx context.Context, cutoff time.Time) ([]string, error) {
	rows, err := w.db.Query(ctx,
		`SELECT child.relname
		 FROM pg_inherits
		 JOIN pg_class child  ON child.oid  = inhrelid
		 JOIN pg_class parent ON parent.oid = inhparent
		 WHERE parent.relname = 'audit_events'
		   AND child.relname  ~ '^audit_events_y[0-9]{4}m[0-9]{2}$'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		names = append(names, n)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	var dropped []string
	cutoff = cutoff.UTC()
	for _, n := range names {
		var y, m int
		if _, err := fmt.Sscanf(n, "audit_events_y%04dm%02d", &y, &m); err != nil {
			continue
		}
		end := time.Date(y, time.Month(m)+1, 1, 0, 0, 0, 0, time.UTC)
		if !end.After(cutoff) {
			if _, err := w.db.Exec(ctx, fmt.Sprintf(`DROP TABLE IF EXISTS %s`, n)); err != nil {
				return dropped, err
			}
			dropped = append(dropped, n)
		}
	}
	return dropped, nil
}

func (w *PGWriter) Ping(ctx context.Context) error {
	return w.db.Ping(ctx)
}

func (w *PGWriter) computeHMAC(contentSHA, prevSHA string) string {
	if len(w.auditHMACKey) == 0 {
		return ""
	}
	mac := hmac.New(sha256.New, w.auditHMACKey)
	mac.Write([]byte(contentSHA))
	mac.Write([]byte{'|'})
	mac.Write([]byte(prevSHA))
	return hex.EncodeToString(mac.Sum(nil))
}

func nullableJSON(v []byte) *string {
	if len(v) == 0 || string(v) == "null" {
		return nil
	}
	s := string(v)
	return &s
}

// jsonText returns a scan target that writes a nullable jsonb::text column back
// into the event's raw JSON field, preserving SQL NULL as an empty value.
func jsonText(dst *json.RawMessage) any {
	return &jsonTextScanner{dst: dst}
}

type jsonTextScanner struct {
	dst *json.RawMessage
}

func (s *jsonTextScanner) ScanText(v pgtype.Text) error {
	if !v.Valid {
		*s.dst = nil
		return nil
	}
	*s.dst = json.RawMessage(v.String)
	return nil
}

func nullEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// IsTransientPGError classifies pg failures that should be retried (left in PEL)
// vs permanent failures that belong in the DLQ.
func IsTransientPGError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return true
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "40001", "40P01": // serialization, deadlock
			return true
		case "57P01", "57P02", "57P03": // admin shutdown / crash shutdown / cannot connect now
			return true
		case "08000", "08003", "08006", "08001", "08004": // connection family
			return true
		case "53300", "53400": // too many connections / config limit
			return true
		}
		return false
	}
	// Network/connection-pool errors that don't surface as PgError.
	return true
}

func contentHash(ev AuditEvent) string {
	// Canonical hash covers every forensically meaningful field.
	h := sha256.New()
	write := func(s string) { h.Write([]byte(s)); h.Write([]byte{0x1f}) }
	write(ev.ID)
	write(ev.ZoneID)
	write(ev.EventType)
	write(ev.RequestID)
	write(ev.Decision)
	write(ev.PolicySetID)
	write(ev.PolicySetVersionID)
	write(ev.ManifestSHA)
	write(ev.EvaluationStatus)
	write(string(canonicalJSON(ev.DeterminingPoliciesJSON)))
	write(string(canonicalJSON(ev.DiagnosticsJSON)))
	write(string(canonicalJSON(ev.MetadataJSON)))
	h.Write([]byte(fmt.Sprintf("%d", ev.OccurredAt.UTC().UnixNano())))
	return hex.EncodeToString(h.Sum(nil))
}

// canonicalJSON normalises null/empty raw JSON so empty and "null" hash identically.
func canonicalJSON(r []byte) []byte {
	if len(r) == 0 {
		return []byte("null")
	}
	return r
}
