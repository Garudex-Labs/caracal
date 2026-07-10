// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// PostgreSQL client and all query functions used by the STS.

package internal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/garudex-labs/caracal/packages/core/go/config"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type DB struct{ pool *pgxpool.Pool }

const (
	dbDefaultMaxConns        = 20
	dbDefaultMinConns        = 2
	dbDefaultConnectTimeout  = 10 * time.Second
	dbDefaultMaxConnLifetime = 30 * time.Minute
	dbDefaultMaxConnIdle     = 5 * time.Minute
	dbDefaultHealthCheck     = 30 * time.Second
)

// ErrConcurrentGrantUpdate signals an optimistic-lock conflict on provider_connections.
// Callers refresh.go retries on this; other errors are returned as-is.
var ErrConcurrentGrantUpdate = errors.New("concurrent grant update")

var ErrDelegationChanged = errors.New("delegation changed during issuance")

func newDB(ctx context.Context, dsn string) (*DB, error) {
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
	// The data plane reads across zones by design, so every session carries the
	// RLS sentinel; row-level security stays a backstop for the per-request zone
	// scoping in the control plane.
	cfg.ConnConfig.RuntimeParams["caracal.zone_id"] = "*"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect postgres: %w", err)
	}
	return &DB{pool: pool}, nil
}

func (d *DB) Ping(ctx context.Context) error {
	return d.pool.Ping(ctx)
}

func (d *DB) CurrentTime(ctx context.Context) (time.Time, error) {
	var now time.Time
	err := d.pool.QueryRow(ctx, `SELECT now()`).Scan(&now)
	return now, err
}

// DBQuerier is the interface that Server and KeyCache use to access the database.
// Concrete implementations are DB (production) and test doubles.
type DBQuerier interface {
	Ping(ctx context.Context) error
	CurrentTime(ctx context.Context) (time.Time, error)
	GetApplicationByID(ctx context.Context, id, zoneID string) (*Application, error)
	GetResourceByIdentifier(ctx context.Context, zoneID, identifier string) (*Resource, error)
	GetProviderConnection(ctx context.Context, zoneID, subjectID string, providerID *string) (*ProviderConnection, error)
	UpdateProviderConnectionTokens(ctx context.Context, id string, expectedVersion int, accessCt, refreshCt []byte, expiresAt time.Time) error
	MarkProviderConnectionExpired(ctx context.Context, id string) error
	GetProvider(ctx context.Context, id string) (*ProviderConfig, error)
	GetSubjectIssuerByIssuer(ctx context.Context, zoneID, issuer string) (*SubjectIssuer, error)
	GetDelegationEdge(ctx context.Context, id string) (*DelegationEdge, error)
	GetAuthorityRecord(ctx context.Context, sid string) (*AuthorityRecord, error)
	GetSession(ctx context.Context, id string) (*Session, error)
	GetDelegationLineage(ctx context.Context, zoneID, edgeID string, maxHops int) ([]string, error)
	GetDelegationGraphEpoch(ctx context.Context, zoneID string) (int64, error)
	InsertAuthorityRecord(ctx context.Context, s *AuthorityRecord) error
	InsertAuthorityRecordWithApproval(ctx context.Context, s *AuthorityRecord, p ConsumeApprovalParams) error
	InsertDelegatedAuthorityRecord(ctx context.Context, s *AuthorityRecord, proof DelegationIssuanceProof, approval *ConsumeApprovalParams) error
	RevokeAuthorityRecord(ctx context.Context, zoneID, sid, reason string) error
	GetStepUpChallenge(ctx context.Context, id string) (*StepUpChallengePG, error)
	GetOrCreateApprovalChallenge(ctx context.Context, c *StepUpChallengePG) (*StepUpChallengePG, bool, error)
	DecideStepUpChallenge(ctx context.Context, p DecideStepUpParams) error
	ConsumeApprovalChallenge(ctx context.Context, p ConsumeApprovalParams) error
	AuthorityRecordsRelated(ctx context.Context, zoneID, sessionA, sessionB string) (bool, error)
	DeleteExpiredStepUpChallenges(ctx context.Context, cutoff time.Time) (int64, error)
	EnsureZoneSigningKeySecret(ctx context.Context, zoneID string, envelope []byte) (*SecretRow, error)
	InsertZoneSigningKeySecret(ctx context.Context, zoneID string, envelope []byte) (*SecretRow, error)
	GetZoneSigningKeySecret(ctx context.Context, zoneID string) (*SecretRow, error)
	GetZoneSigningKeySecrets(ctx context.Context, zoneID string) ([]SecretRow, error)
	GetSecretStoreEnvelope(ctx context.Context, ref string) ([]byte, error)
	GetActivePolicySetBinding(ctx context.Context, zoneID string) (*PolicySetBinding, error)
	GetPolicySetVersion(ctx context.Context, id string) (*PolicySetVersion, error)
	GetPolicyVersionsByIDs(ctx context.Context, ids []string) ([]PolicyVersion, error)
	GetApplicationByIDGlobal(ctx context.Context, id string) (*Application, error)
	GetWorkloadByID(ctx context.Context, id string) (*Workload, error)
	ListBoundZoneIDs(ctx context.Context) ([]string, error)
}

// Application holds the fields STS needs from the applications table.
type Application struct {
	ID                 string
	ZoneID             string
	Name               string
	RegistrationMethod string
	ClientSecretHash   *string
	Traits             []string
}

func (d *DB) GetApplicationByID(ctx context.Context, id, zoneID string) (*Application, error) {
	var a Application
	err := d.pool.QueryRow(ctx,
		`SELECT id, zone_id, name, registration_method, client_secret_hash, traits
		 FROM applications
		 WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL
		   AND (expires_at IS NULL OR expires_at > now())`, id, zoneID,
	).Scan(&a.ID, &a.ZoneID, &a.Name, &a.RegistrationMethod, &a.ClientSecretHash, &a.Traits)
	if err != nil {
		return nil, err
	}
	return &a, nil
}

func (d *DB) GetApplicationByIDGlobal(ctx context.Context, id string) (*Application, error) {
	var a Application
	err := d.pool.QueryRow(ctx,
		`SELECT id, zone_id, name, registration_method, client_secret_hash, traits
		 FROM applications
		 WHERE id = $1 AND archived_at IS NULL
		   AND (expires_at IS NULL OR expires_at > now())`, id,
	).Scan(&a.ID, &a.ZoneID, &a.Name, &a.RegistrationMethod, &a.ClientSecretHash, &a.Traits)
	if err != nil {
		return nil, err
	}
	return &a, nil
}

// Workload holds the fields STS needs from the workloads table.
type Workload struct {
	ID         string
	ZoneID     string
	Name       string
	SecretHash string
	Bindings   []byte
}

func (d *DB) GetWorkloadByID(ctx context.Context, id string) (*Workload, error) {
	var w Workload
	err := d.pool.QueryRow(ctx,
		`SELECT id, zone_id, name, secret_hash, bindings
		 FROM workloads WHERE id = $1`, id,
	).Scan(&w.ID, &w.ZoneID, &w.Name, &w.SecretHash, &w.Bindings)
	if err != nil {
		return nil, err
	}
	return &w, nil
}

// Resource holds the fields STS needs from the resources table.
type Resource struct {
	ID                   string
	ZoneID               string
	Identifier           string
	UpstreamURL          *string
	Scopes               []string
	CredentialProviderID *string
	Operations           []ResourceOperation
	OperationEnforcement string
}

func (d *DB) GetResourceByIdentifier(ctx context.Context, zoneID, identifier string) (*Resource, error) {
	var r Resource
	var operations []byte
	err := d.pool.QueryRow(ctx,
		`SELECT id, zone_id, identifier, upstream_url, scopes, credential_provider_id, operations, operation_enforcement FROM resources
		 WHERE zone_id = $1 AND (identifier = $2 OR id = $2) AND archived_at IS NULL`, zoneID, identifier,
	).Scan(&r.ID, &r.ZoneID, &r.Identifier, &r.UpstreamURL, &r.Scopes, &r.CredentialProviderID, &operations, &r.OperationEnforcement)
	if err != nil {
		return nil, err
	}
	if len(operations) > 0 {
		if err := json.Unmarshal(operations, &r.Operations); err != nil {
			return nil, err
		}
	}
	return &r, nil
}

// PolicySetBinding holds the active version for a zone's policy set.
type PolicySetBinding struct {
	ZoneID          string
	PolicySetID     string
	ActiveVersionID *string
}

func (d *DB) GetActivePolicySetBinding(ctx context.Context, zoneID string) (*PolicySetBinding, error) {
	var b PolicySetBinding
	err := d.pool.QueryRow(ctx,
		`SELECT zone_id, policy_set_id, active_version_id
		 FROM policy_set_bindings
		 WHERE zone_id = $1 AND active_version_id IS NOT NULL
		 LIMIT 1`, zoneID,
	).Scan(&b.ZoneID, &b.PolicySetID, &b.ActiveVersionID)
	if err != nil {
		return nil, err
	}
	return &b, nil
}

// PolicySetVersion holds the manifest for a policy set version.
type PolicySetVersion struct {
	ID             string
	ManifestJSON   json.RawMessage
	ManifestSHA256 string
	SchemaVersion  string
}

func (d *DB) GetPolicySetVersion(ctx context.Context, id string) (*PolicySetVersion, error) {
	var v PolicySetVersion
	err := d.pool.QueryRow(ctx,
		`SELECT id, manifest_json, manifest_sha256, schema_version
		 FROM policy_set_versions WHERE id = $1`, id,
	).Scan(&v.ID, &v.ManifestJSON, &v.ManifestSHA256, &v.SchemaVersion)
	if err != nil {
		return nil, err
	}
	return &v, nil
}

// PolicyVersion holds the Rego source for a policy.
type PolicyVersion struct {
	ID      string
	Content string
}

func (d *DB) GetPolicyVersionsByIDs(ctx context.Context, ids []string) ([]PolicyVersion, error) {
	rows, err := d.pool.Query(ctx,
		`SELECT id, content FROM policy_versions WHERE id = ANY($1)`, ids,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var versions []PolicyVersion
	for rows.Next() {
		var v PolicyVersion
		if err := rows.Scan(&v.ID, &v.Content); err != nil {
			return nil, err
		}
		versions = append(versions, v)
	}
	return versions, rows.Err()
}

// AuthorityRecord holds the STS token-lineage and revocation fields.
type AuthorityRecord struct {
	ID              string
	ZoneID          string
	SessionType     string
	SubjectID       *string
	ParentID        *string
	Status          string
	ExpiresAt       time.Time
	AuthenticatedAt time.Time
	ClaimsJSON      []byte
}

// DelegationEdge holds the active graph authority edge used by STS.
type DelegationEdge struct {
	ID              string
	ZoneID          string
	SourceSessionID string
	TargetSessionID string
	IssuerAppID     string
	ReceiverAppID   string
	ParentEdgeID    *string
	ResourceID      *string
	Scopes          []string
	Status          string
	ExpiresAt       time.Time
	EdgeVersion     int
	ConstraintsJSON json.RawMessage
	RevokedAt       *time.Time
}

// DelegationIssuanceEdge is one validated lineage edge rechecked under the Coordinator mutation lock.
type DelegationIssuanceEdge struct {
	ID                    string    `json:"id"`
	ParentEdgeID          *string   `json:"parent_edge_id"`
	EdgeVersion           int       `json:"edge_version"`
	SourceSessionID       string    `json:"source_session_id"`
	TargetSessionID       string    `json:"target_session_id"`
	IssuerApplicationID   string    `json:"issuer_application_id"`
	ReceiverApplicationID string    `json:"receiver_application_id"`
	ExpiresAt             time.Time `json:"expires_at"`
}

// DelegationIssuanceProof is the complete graph state rechecked under the Coordinator mutation lock.
type DelegationIssuanceProof struct {
	Lineage               []DelegationIssuanceEdge
	SourceSessionID       string
	TargetSessionID       string
	SourceApplicationID   string
	TargetApplicationID   string
	TargetAuthorityRecord string
	GraphEpoch            int64
}

// Session holds coordinator graph node fields needed by STS.
type Session struct {
	ID                       string
	ZoneID                   string
	ApplicationID            string
	SubjectAuthorityRecordID string
	Lifecycle                string
	Labels                   []string
	Status                   string
	StartedAt                time.Time
	TTLSeconds               int
	HeartbeatDeadlineAt      *time.Time
	ParentID                 *string
	Depth                    int
}

func (d *DB) GetDelegationEdge(ctx context.Context, id string) (*DelegationEdge, error) {
	var edge DelegationEdge
	err := d.pool.QueryRow(ctx,
		`SELECT id, zone_id, source_session_id, target_session_id, issuer_application_id,
		        receiver_application_id, parent_edge_id, resource_id, scopes, status, expires_at, edge_version,
		        constraints_json, revoked_at
		 FROM delegation_edges WHERE id = $1`, id,
	).Scan(
		&edge.ID,
		&edge.ZoneID,
		&edge.SourceSessionID,
		&edge.TargetSessionID,
		&edge.IssuerAppID,
		&edge.ReceiverAppID,
		&edge.ParentEdgeID,
		&edge.ResourceID,
		&edge.Scopes,
		&edge.Status,
		&edge.ExpiresAt,
		&edge.EdgeVersion,
		&edge.ConstraintsJSON,
		&edge.RevokedAt,
	)
	if err != nil {
		return nil, err
	}
	return &edge, nil
}

func (d *DB) GetAuthorityRecord(ctx context.Context, sid string) (*AuthorityRecord, error) {
	var s AuthorityRecord
	err := d.pool.QueryRow(ctx,
		`SELECT id, zone_id, session_type, subject_id, parent_id, status, expires_at, authenticated_at
		 FROM authority_records WHERE id = $1`, sid,
	).Scan(&s.ID, &s.ZoneID, &s.SessionType, &s.SubjectID, &s.ParentID, &s.Status, &s.ExpiresAt, &s.AuthenticatedAt)
	if err != nil {
		return nil, err
	}
	return &s, nil
}

func (d *DB) GetSession(ctx context.Context, id string) (*Session, error) {
	var s Session
	err := d.pool.QueryRow(ctx,
		`SELECT id, zone_id, application_id, subject_authority_record_id, lifecycle, labels, status,
		        started_at, COALESCE(ttl_seconds, 0), heartbeat_deadline_at, parent_id, depth
		 FROM sessions WHERE id = $1`, id,
	).Scan(&s.ID, &s.ZoneID, &s.ApplicationID, &s.SubjectAuthorityRecordID, &s.Lifecycle, &s.Labels, &s.Status, &s.StartedAt, &s.TTLSeconds, &s.HeartbeatDeadlineAt, &s.ParentID, &s.Depth)
	if err != nil {
		return nil, err
	}
	return &s, nil
}

func (d *DB) GetDelegationLineage(ctx context.Context, zoneID, edgeID string, maxHops int) ([]string, error) {
	var path []string
	err := d.pool.QueryRow(ctx,
		`WITH RECURSIVE lineage AS (
		   SELECT id, parent_edge_id, 1 AS depth, ARRAY[id] AS path
		   FROM delegation_edges
		   WHERE zone_id = $1 AND id = $2 AND status = 'active' AND expires_at > now()
		   UNION ALL
		   SELECT e.id, e.parent_edge_id, l.depth + 1, l.path || e.id
		   FROM delegation_edges e
		   JOIN lineage l ON e.id = l.parent_edge_id
		   WHERE e.zone_id = $1
		     AND e.status = 'active'
		     AND e.expires_at > now()
		     AND NOT e.id = ANY(l.path)
		     AND l.depth < $3
		 )
		 SELECT array_agg(id ORDER BY depth DESC) FROM lineage
		 HAVING bool_or(parent_edge_id IS NULL)`,
		zoneID, edgeID, maxHops,
	).Scan(&path)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return path, err
}

func (d *DB) GetDelegationGraphEpoch(ctx context.Context, zoneID string) (int64, error) {
	var epoch int64
	err := d.pool.QueryRow(ctx,
		`SELECT epoch FROM delegation_graph_epochs WHERE zone_id = $1`, zoneID,
	).Scan(&epoch)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	return epoch, err
}

func (d *DB) InsertAuthorityRecord(ctx context.Context, s *AuthorityRecord) error {
	claims := s.ClaimsJSON
	if len(claims) == 0 {
		claims = nil
	}
	_, err := d.pool.Exec(ctx,
		`INSERT INTO authority_records (id, zone_id, session_type, subject_id, parent_id, status, expires_at, authenticated_at, claims_json)
		 VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8)`,
		s.ID, s.ZoneID, s.SessionType, s.SubjectID, s.ParentID, s.ExpiresAt, s.AuthenticatedAt, claims,
	)
	return err
}

// InsertAuthorityRecordWithApproval atomically consumes an approved hold and creates
// its authority record. A failed insert leaves the hold spendable, while concurrent
// consumers can create at most one record.
func (d *DB) InsertAuthorityRecordWithApproval(ctx context.Context, s *AuthorityRecord, p ConsumeApprovalParams) error {
	claims := s.ClaimsJSON
	if len(claims) == 0 {
		claims = nil
	}
	tag, err := d.pool.Exec(ctx,
		`WITH consumed AS (
		   UPDATE step_up_challenges c
		      SET consumed_at = now()
		    WHERE c.id = $9
		      AND c.zone_id = $2
		      AND c.principal_id = $10
		      AND c.resource_set_hash = $11
		      AND c.challenge_type = 'human_approval'
		      AND c.satisfied_at IS NOT NULL
		      AND c.rejected_at IS NULL
		      AND c.approver_subject_id IS NOT NULL
		      AND c.consumed_at IS NULL
		      AND c.expires_at > now()
		      AND (c.session_id = '' OR EXISTS (
		        SELECT 1 FROM authority_records a
		         WHERE a.id = c.session_id
		           AND a.zone_id = c.zone_id
		           AND a.status = 'active'
		           AND a.expires_at > now()
		      ))
		    RETURNING 1
		 )
		 INSERT INTO authority_records
		   (id, zone_id, session_type, subject_id, parent_id, status, expires_at, authenticated_at, claims_json)
		 SELECT $1, $2, $3, $4, $5, 'active', $6, $7, $8
		   FROM consumed`,
		s.ID, s.ZoneID, s.SessionType, s.SubjectID, s.ParentID, s.ExpiresAt, s.AuthenticatedAt, claims,
		p.ID, p.PrincipalID, p.ResourceSetHash,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrChallengeInvalid
	}
	return nil
}

func (d *DB) InsertDelegatedAuthorityRecord(ctx context.Context, s *AuthorityRecord, proof DelegationIssuanceProof, approval *ConsumeApprovalParams) error {
	claims := s.ClaimsJSON
	if len(claims) == 0 {
		claims = nil
	}
	lineage, err := json.Marshal(proof.Lineage)
	if err != nil || len(proof.Lineage) == 0 {
		return ErrDelegationChanged
	}
	tx, err := d.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "delegation:"+s.ZoneID); err != nil {
		return err
	}
	var currentEpoch int64
	if err := tx.QueryRow(ctx, `SELECT epoch FROM delegation_graph_epochs WHERE zone_id = $1`, s.ZoneID).Scan(&currentEpoch); err != nil || currentEpoch != proof.GraphEpoch {
		return ErrDelegationChanged
	}
	var live bool
	err = tx.QueryRow(ctx,
		`WITH expected AS (
		   SELECT id, parent_edge_id, edge_version, source_session_id, target_session_id,
		          issuer_application_id, receiver_application_id, expires_at
		   FROM jsonb_to_recordset($1::jsonb) AS x(
		     id text, parent_edge_id text, edge_version int, source_session_id text, target_session_id text,
		     issuer_application_id text, receiver_application_id text, expires_at timestamptz
		   )
		 ), matched AS (
		   SELECT e.id
		   FROM expected x
		   JOIN delegation_edges e ON e.id = x.id AND e.zone_id = $2
		   WHERE e.parent_edge_id IS NOT DISTINCT FROM x.parent_edge_id
		     AND e.edge_version = x.edge_version
		     AND e.source_session_id = x.source_session_id
		     AND e.target_session_id = x.target_session_id
		     AND e.issuer_application_id = x.issuer_application_id
		     AND e.receiver_application_id = x.receiver_application_id
		     AND e.expires_at = x.expires_at
		     AND e.status = 'active' AND e.revoked_at IS NULL AND e.expires_at > now()
		 ), expected_sessions AS (
		   SELECT source_session_id AS id, issuer_application_id AS application_id FROM expected
		   UNION
		   SELECT target_session_id, receiver_application_id FROM expected
		 ), matched_sessions AS (
		   SELECT session.id
		   FROM sessions session
		   JOIN expected_sessions x ON x.id = session.id AND x.application_id = session.application_id
		   JOIN authority_records authority ON authority.id = session.subject_authority_record_id AND authority.zone_id = session.zone_id
		   WHERE session.zone_id = $2
		     AND session.status = 'active'
		     AND authority.status = 'active' AND authority.expires_at > now()
		     AND ((session.lifecycle = 'service' AND session.heartbeat_deadline_at > now())
		       OR (session.lifecycle = 'task' AND session.ttl_seconds > 0
		         AND session.started_at + (session.ttl_seconds * interval '1 second') > now()))
		 )
		 SELECT (SELECT COUNT(*) FROM expected) = $8
		    AND (SELECT COUNT(*) FROM matched) = $8
		    AND (SELECT COUNT(*) FROM matched_sessions) = (SELECT COUNT(*) FROM expected_sessions)
		    AND EXISTS (
		      SELECT 1 FROM sessions target
		      WHERE target.id = $4 AND target.zone_id = $2 AND target.application_id = $6
		        AND target.subject_authority_record_id = $7
		    )
		    AND EXISTS (
		      SELECT 1 FROM sessions source
		      WHERE source.id = $3 AND source.zone_id = $2 AND source.application_id = $5
		    )`,
		lineage, s.ZoneID, proof.SourceSessionID, proof.TargetSessionID,
		proof.SourceApplicationID, proof.TargetApplicationID, proof.TargetAuthorityRecord, len(proof.Lineage),
	).Scan(&live)
	if err != nil || !live {
		return ErrDelegationChanged
	}
	if approval != nil {
		var consumed bool
		err = tx.QueryRow(ctx,
			`UPDATE step_up_challenges c SET consumed_at = now()
			 WHERE c.id = $1 AND c.zone_id = $2 AND c.principal_id = $3 AND c.resource_set_hash = $4
			   AND c.challenge_type = 'human_approval' AND c.satisfied_at IS NOT NULL
			   AND c.rejected_at IS NULL AND c.approver_subject_id IS NOT NULL
			   AND c.consumed_at IS NULL AND c.expires_at > now()
			 RETURNING true`, approval.ID, approval.ZoneID, approval.PrincipalID, approval.ResourceSetHash,
		).Scan(&consumed)
		if errors.Is(err, pgx.ErrNoRows) || !consumed {
			return ErrChallengeInvalid
		}
		if err != nil {
			return err
		}
	}
	_, err = tx.Exec(ctx,
		`INSERT INTO authority_records (id, zone_id, session_type, subject_id, parent_id, status, expires_at, authenticated_at, claims_json)
		 VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8)`,
		s.ID, s.ZoneID, s.SessionType, s.SubjectID, s.ParentID, s.ExpiresAt, s.AuthenticatedAt, claims,
	)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (d *DB) RevokeAuthorityRecord(ctx context.Context, zoneID, sid, reason string) error {
	if reason == "" {
		reason = "session_revoked"
	}
	tx, err := d.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "delegation:"+zoneID); err != nil {
		return err
	}
	_, err = tx.Exec(ctx,
		`WITH RECURSIVE revoked_tree AS (
		   SELECT id FROM authority_records WHERE id = $1 AND zone_id = $2
		   UNION ALL
		   SELECT a.id FROM authority_records a
		   JOIN revoked_tree r ON a.parent_id = r.id
		   WHERE a.zone_id = $2
		 )
		 UPDATE authority_records SET status = 'revoked',
		   revoked_at = COALESCE(revoked_at, now()),
		   revoked_reason = COALESCE(revoked_reason, $3)
		 WHERE zone_id = $2 AND id IN (SELECT id FROM revoked_tree)`,
		sid, zoneID, reason,
	)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// StepUpChallengePG is the durable approval hold behind a gated mint: one live row per
// exact authority binding, carrying the resolved tier declaration and the approver's
// decision.
type StepUpChallengePG struct {
	ID                        string
	ZoneID                    string
	AuthorityRecordID         string
	ChallengeType             string
	PrincipalID               string
	ApplicationID             string
	Tier                      string
	ApproverClass             string
	PrivacyMode               string
	ResourceSetHash           []byte
	ExpiresAt                 time.Time
	SatisfiedAt               *time.Time
	RejectedAt                *time.Time
	ConsumedAt                *time.Time
	ApproverSubjectID         *string
	ApproverAuthorityRecordID *string
	DecisionReason            *string
	MetadataJSON              []byte
}

// ConsumeApprovalParams holds the bindings the caller must present to consume a
// human-approval challenge. A human approval carries no client secret: its proof is an
// authenticated approver having satisfied it, so consumption binds on zone, principal,
// and the request hash rather than a returned secret.
type ConsumeApprovalParams struct {
	ID              string
	ZoneID          string
	PrincipalID     string
	ResourceSetHash []byte
	Now             time.Time
}

// DecideStepUpParams records an authenticated approver's decision on a pending hold.
// ApproverSubjectID arrives with the challenge's privacy mode already applied; the
// approver's authority record id, when present, is the forensic and revocation anchor.
type DecideStepUpParams struct {
	ID                        string
	ZoneID                    string
	Approve                   bool
	ApproverSubjectID         string
	ApproverAuthorityRecordID string
	Reason                    string
}

const stepUpChallengeColumns = `id, zone_id, session_id, challenge_type, principal_id,
	application_id, tier, approver_class, privacy_mode, resource_set_hash, expires_at,
	satisfied_at, rejected_at, consumed_at, approver_subject_id, approver_session_id,
	decision_reason, metadata_json`

func scanStepUpChallenge(row pgx.Row) (*StepUpChallengePG, error) {
	var c StepUpChallengePG
	var appID *string
	var tier *string
	err := row.Scan(&c.ID, &c.ZoneID, &c.AuthorityRecordID, &c.ChallengeType, &c.PrincipalID,
		&appID, &tier, &c.ApproverClass, &c.PrivacyMode, &c.ResourceSetHash, &c.ExpiresAt,
		&c.SatisfiedAt, &c.RejectedAt, &c.ConsumedAt, &c.ApproverSubjectID, &c.ApproverAuthorityRecordID,
		&c.DecisionReason, &c.MetadataJSON)
	if err != nil {
		return nil, err
	}
	if appID != nil {
		c.ApplicationID = *appID
	}
	if tier != nil {
		c.Tier = *tier
	}
	return &c, nil
}

// GetOrCreateApprovalChallenge converges every gated mint for one exact authority
// binding onto a single live hold. Expired unconsumed holds for the binding are purged
// to free the uniqueness slot, then the insert either lands or yields to the live row
// under the partial unique index, so concurrent duplicate mints, retries after a
// decision, and re-mints inside a rejection window all observe the same challenge.
// Returns the live row and whether this call created it.
func (d *DB) GetOrCreateApprovalChallenge(ctx context.Context, c *StepUpChallengePG) (*StepUpChallengePG, bool, error) {
	metadata := c.MetadataJSON
	if len(metadata) == 0 {
		metadata = []byte("{}")
	}
	tx, err := d.pool.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx,
		`DELETE FROM step_up_challenges
		 WHERE zone_id = $1 AND principal_id = $2 AND session_id = $3 AND resource_set_hash = $4
		   AND consumed_at IS NULL AND expires_at <= now()`,
		c.ZoneID, c.PrincipalID, c.AuthorityRecordID, c.ResourceSetHash,
	); err != nil {
		return nil, false, err
	}
	row := tx.QueryRow(ctx,
		`INSERT INTO step_up_challenges
		   (id, zone_id, session_id, challenge_type, principal_id, application_id,
		    tier, approver_class, privacy_mode, resource_set_hash, expires_at, metadata_json)
		 VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), NULLIF($7, ''), $8, $9, $10, $11, $12)
		 ON CONFLICT (zone_id, principal_id, session_id, resource_set_hash)
		   WHERE consumed_at IS NULL DO NOTHING
		 RETURNING `+stepUpChallengeColumns,
		c.ID, c.ZoneID, c.AuthorityRecordID, c.ChallengeType, c.PrincipalID, c.ApplicationID,
		c.Tier, c.ApproverClass, c.PrivacyMode, c.ResourceSetHash, c.ExpiresAt, metadata,
	)
	created, err := scanStepUpChallenge(row)
	if err == nil {
		return created, true, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, false, err
	}
	existing, err := scanStepUpChallenge(tx.QueryRow(ctx,
		`SELECT `+stepUpChallengeColumns+`
		 FROM step_up_challenges
		 WHERE zone_id = $1 AND principal_id = $2 AND session_id = $3 AND resource_set_hash = $4
		   AND consumed_at IS NULL`,
		c.ZoneID, c.PrincipalID, c.AuthorityRecordID, c.ResourceSetHash,
	))
	if err != nil {
		return nil, false, err
	}
	return existing, false, tx.Commit(ctx)
}

// DecideStepUpChallenge atomically records an approver's decision on a pending hold.
// The update only lands on a live, undecided, unconsumed human-approval challenge in
// the named zone, so an expired hold, a decided one, or a replay cannot be re-decided.
// Returns ErrChallengeInvalid when no such challenge exists.
func (d *DB) DecideStepUpChallenge(ctx context.Context, p DecideStepUpParams) error {
	tag, err := d.pool.Exec(ctx,
		`UPDATE step_up_challenges
		 SET satisfied_at = CASE WHEN $3 THEN now() END,
		     rejected_at = CASE WHEN NOT $3 THEN now() END,
		     approver_subject_id = $4,
		     approver_session_id = NULLIF($5, ''),
		     decision_reason = NULLIF($6, '')
		 WHERE id = $1
		   AND zone_id = $2
		   AND challenge_type = 'human_approval'
		   AND satisfied_at IS NULL
		   AND rejected_at IS NULL
		   AND consumed_at IS NULL
		   AND expires_at > now()`,
		p.ID, p.ZoneID, p.Approve, p.ApproverSubjectID, p.ApproverAuthorityRecordID, p.Reason,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrChallengeInvalid
	}
	return nil
}

// ConsumeApprovalChallenge atomically transitions an approved challenge to consumed,
// but only when every binding matches: zone, principal, request hash, an approver
// having approved it, no rejection, not yet expired, not yet consumed, and the
// originating session, when the hold is bound to one, still active. A human approval
// carries no client secret, so consumption proves an authenticated approver approved
// this exact request rather than a returned proof. Returns ErrChallengeInvalid
// otherwise.
func (d *DB) ConsumeApprovalChallenge(ctx context.Context, p ConsumeApprovalParams) error {
	tag, err := d.pool.Exec(ctx,
		`UPDATE step_up_challenges c
		 SET consumed_at = now()
		 WHERE c.id = $1
		   AND c.zone_id = $2
		   AND c.principal_id = $3
		   AND c.resource_set_hash = $4
		   AND c.challenge_type = 'human_approval'
		   AND c.satisfied_at IS NOT NULL
		   AND c.rejected_at IS NULL
		   AND c.approver_subject_id IS NOT NULL
		   AND c.consumed_at IS NULL
		   AND c.expires_at > now()
		   AND (c.session_id = '' OR EXISTS (
		     SELECT 1 FROM authority_records a
		     WHERE a.id = c.session_id
		       AND a.zone_id = c.zone_id
		       AND a.status = 'active'
		       AND a.expires_at > now()
		   ))`,
		p.ID, p.ZoneID, p.PrincipalID, p.ResourceSetHash,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrChallengeInvalid
	}
	return nil
}

func (d *DB) GetStepUpChallenge(ctx context.Context, id string) (*StepUpChallengePG, error) {
	return scanStepUpChallenge(d.pool.QueryRow(ctx,
		`SELECT `+stepUpChallengeColumns+`
		 FROM step_up_challenges WHERE id = $1`, id,
	))
}

// AuthorityRecordsRelated reports whether two authority records in a zone sit on
// the same ancestry line: identical, ancestor, or descendant. It prevents an
// approver from deciding a hold raised by its own token lineage.
func (d *DB) AuthorityRecordsRelated(ctx context.Context, zoneID, recordA, recordB string) (bool, error) {
	if recordA == "" || recordB == "" {
		return recordA != "" && recordA == recordB, nil
	}
	var related bool
	err := d.pool.QueryRow(ctx,
		`WITH RECURSIVE lineage AS (
		   SELECT id, parent_id FROM authority_records WHERE id = $2 AND zone_id = $1
		   UNION ALL
		   SELECT a.id, a.parent_id FROM authority_records a
		   JOIN lineage l ON a.id = l.parent_id
		   WHERE a.zone_id = $1
		 ), reverse_lineage AS (
		   SELECT id, parent_id FROM authority_records WHERE id = $3 AND zone_id = $1
		   UNION ALL
		   SELECT a.id, a.parent_id FROM authority_records a
		   JOIN reverse_lineage r ON a.id = r.parent_id
		   WHERE a.zone_id = $1
		 )
		 SELECT EXISTS (SELECT 1 FROM lineage WHERE id = $3)
		     OR EXISTS (SELECT 1 FROM reverse_lineage WHERE id = $2)`,
		zoneID, recordA, recordB,
	).Scan(&related)
	return related, err
}

// DeleteExpiredStepUpChallenges purges challenge rows whose lifecycle ended before the
// cutoff: consumed, rejected, or expired. Terminal rows stay queryable inside the
// retention window for observability, then leave the store entirely, because the audit
// stream, not this table, is the durable record.
func (d *DB) DeleteExpiredStepUpChallenges(ctx context.Context, cutoff time.Time) (int64, error) {
	tag, err := d.pool.Exec(ctx,
		`DELETE FROM step_up_challenges
		 WHERE GREATEST(COALESCE(consumed_at, '-infinity'), COALESCE(rejected_at, '-infinity'), expires_at) < $1`,
		cutoff,
	)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// SecretRow holds a sealed secret envelope.
type SecretRow struct {
	ID       string
	Envelope []byte
}

func (d *DB) GetZoneSigningKeySecret(ctx context.Context, zoneID string) (*SecretRow, error) {
	var s SecretRow
	err := d.pool.QueryRow(ctx,
		`SELECT id, envelope FROM secrets
		 WHERE zone_id = $1 AND name = 'zone_signing_key' ORDER BY version DESC LIMIT 1`, zoneID,
	).Scan(&s.ID, &s.Envelope)
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// GetSecretStoreEnvelope reads one builtin Secret Store envelope by ref.
func (d *DB) GetSecretStoreEnvelope(ctx context.Context, ref string) ([]byte, error) {
	var envelope []byte
	err := d.pool.QueryRow(ctx,
		`SELECT envelope FROM secret_store WHERE ref = $1`, ref,
	).Scan(&envelope)
	if err != nil {
		return nil, err
	}
	return envelope, nil
}

func (d *DB) EnsureZoneSigningKeySecret(ctx context.Context, zoneID string, envelope []byte) (*SecretRow, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return nil, err
	}
	tx, err := d.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "zone_signing_key:"+zoneID); err != nil {
		return nil, err
	}
	var current SecretRow
	err = tx.QueryRow(ctx,
		`SELECT id, envelope FROM secrets
		 WHERE zone_id = $1 AND name = 'zone_signing_key' ORDER BY version DESC LIMIT 1`, zoneID,
	).Scan(&current.ID, &current.Envelope)
	if err == nil {
		return &current, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	var s SecretRow
	err = tx.QueryRow(ctx,
		`WITH next AS (
		   SELECT COALESCE(MAX(version), 0) + 1 AS version
		   FROM secrets WHERE zone_id = $1 AND entity_id = $1 AND name = 'zone_signing_key'
		 )
		 INSERT INTO secrets (id, zone_id, entity_id, name, type, envelope, version)
		 SELECT $2, $1, $1, 'zone_signing_key', 'token', $3, next.version FROM next
		 RETURNING id, envelope`,
		zoneID, id.String(), envelope,
	).Scan(&s.ID, &s.Envelope)
	if err != nil {
		return nil, err
	}
	return &s, tx.Commit(ctx)
}

func (d *DB) InsertZoneSigningKeySecret(ctx context.Context, zoneID string, envelope []byte) (*SecretRow, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return nil, err
	}
	tx, err := d.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "zone_signing_key:"+zoneID); err != nil {
		return nil, err
	}
	var s SecretRow
	err = tx.QueryRow(ctx,
		`WITH next AS (
		   SELECT COALESCE(MAX(version), 0) + 1 AS version
		   FROM secrets WHERE zone_id = $1 AND entity_id = $1 AND name = 'zone_signing_key'
		 )
		 INSERT INTO secrets (id, zone_id, entity_id, name, type, envelope, version)
		 SELECT $2, $1, $1, 'zone_signing_key', 'token', $3, next.version FROM next
		 RETURNING id, envelope`,
		zoneID, id.String(), envelope,
	).Scan(&s.ID, &s.Envelope)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &s, nil
}

// GetZoneSigningKeySecrets returns the active signing key and the previous key
// while it remains inside the 24h rotation grace period.
func (d *DB) GetZoneSigningKeySecrets(ctx context.Context, zoneID string) ([]SecretRow, error) {
	rows, err := d.pool.Query(ctx,
		`WITH ranked AS (
		   SELECT id, envelope, created_at,
		          row_number() OVER (ORDER BY version DESC, created_at DESC) AS key_rank
		     FROM secrets
		    WHERE zone_id = $1 AND name = 'zone_signing_key'
		 ), active AS (
		   SELECT created_at FROM ranked WHERE key_rank = 1
		 )
		 SELECT ranked.id, ranked.envelope
		   FROM ranked CROSS JOIN active
		  WHERE key_rank = 1 OR (key_rank = 2 AND active.created_at >= now() - interval '24 hours')
		  ORDER BY key_rank`, zoneID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var secrets []SecretRow
	for rows.Next() {
		var s SecretRow
		if err := rows.Scan(&s.ID, &s.Envelope); err != nil {
			return nil, err
		}
		secrets = append(secrets, s)
	}
	return secrets, rows.Err()
}

// ListBoundZoneIDs returns every zone with an active policy_set_binding. Used by the
// OPA engine to seed compiled bundles at startup so that fresh zones do not depend on
// hot-path Evaluate to bootstrap.
func (d *DB) ListBoundZoneIDs(ctx context.Context) ([]string, error) {
	rows, err := d.pool.Query(ctx,
		`SELECT DISTINCT zone_id FROM policy_set_bindings WHERE active_version_id IS NOT NULL`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var zones []string
	for rows.Next() {
		var z string
		if err := rows.Scan(&z); err != nil {
			return nil, err
		}
		zones = append(zones, z)
	}
	return zones, rows.Err()
}

// ProviderConnection holds the brokered upstream tokens for one subject's
// authenticated account on a provider, shared by every resource bound to it.
type ProviderConnection struct {
	ID                  string
	ZoneID              string
	SubjectID           string
	ProviderID          *string
	AccessTokenCt       []byte
	RefreshTokenCt      []byte
	ExpiresAt           *time.Time
	RefreshTokenVersion int
}

func (d *DB) GetProviderConnection(ctx context.Context, zoneID, subjectID string, providerID *string) (*ProviderConnection, error) {
	var c ProviderConnection
	err := d.pool.QueryRow(ctx,
		`SELECT id, zone_id, subject_id, provider_id,
		        access_token_ct, refresh_token_ct, expires_at, refresh_token_version
		 FROM provider_connections
		 WHERE zone_id = $1 AND subject_id = $2 AND status = 'active'
		   AND ($3::text IS NULL OR provider_id = $3)
		 ORDER BY created_at DESC LIMIT 1`, zoneID, subjectID, providerID,
	).Scan(&c.ID, &c.ZoneID, &c.SubjectID, &c.ProviderID,
		&c.AccessTokenCt, &c.RefreshTokenCt, &c.ExpiresAt, &c.RefreshTokenVersion)
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// UpdateProviderConnectionTokens updates tokens using optimistic locking on refresh_token_version.
// Returns ErrConcurrentGrantUpdate if the row was concurrently modified since it was read.
func (d *DB) UpdateProviderConnectionTokens(ctx context.Context, id string, expectedVersion int, accessCt, refreshCt []byte, expiresAt time.Time) error {
	tag, err := d.pool.Exec(ctx,
		`UPDATE provider_connections
		 SET access_token_ct = $3, refresh_token_ct = $4, expires_at = $5,
		     refreshed_at = now(), refresh_token_version = refresh_token_version + 1
		 WHERE id = $1 AND refresh_token_version = $2`,
		id, expectedVersion, accessCt, refreshCt, expiresAt,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrConcurrentGrantUpdate
	}
	return nil
}

// MarkProviderConnectionExpired transitions a dead connection out of 'active' so the
// console shows it needs reconsent and the active-connection unique index frees up
// for the replacement created by the next authorization.
func (d *DB) MarkProviderConnectionExpired(ctx context.Context, id string) error {
	_, err := d.pool.Exec(ctx,
		`UPDATE provider_connections SET status = 'expired', updated_at = now() WHERE id = $1 AND status = 'active'`, id)
	return err
}

// ProviderConfig holds the provider config needed for token refresh.
type ProviderConfig struct {
	ID           string
	ZoneID       string
	ProviderKind *string
	ConfigJSON   json.RawMessage
}

func (d *DB) GetProvider(ctx context.Context, id string) (*ProviderConfig, error) {
	var p ProviderConfig
	err := d.pool.QueryRow(ctx,
		`SELECT id, zone_id, provider_kind, config_json
		 FROM providers WHERE id = $1 AND archived_at IS NULL`, id,
	).Scan(&p.ID, &p.ZoneID, &p.ProviderKind, &p.ConfigJSON)
	if err != nil {
		return nil, err
	}
	return &p, nil
}
