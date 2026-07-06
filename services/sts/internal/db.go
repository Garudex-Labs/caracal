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

// ErrConcurrentGrantUpdate signals an optimistic-lock conflict on delegated_grants.
// Callers refresh.go retries on this; other errors are returned as-is.
var ErrConcurrentGrantUpdate = errors.New("concurrent grant update")

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
	GetProviderGrant(ctx context.Context, zoneID, userID, resourceID string, providerID *string) (*ProviderGrant, error)
	UpdateProviderGrantTokens(ctx context.Context, id string, expectedVersion int, accessCt, refreshCt []byte, expiresAt time.Time) error
	GetProvider(ctx context.Context, id string) (*ProviderConfig, error)
	GetDelegationEdge(ctx context.Context, id string) (*DelegationEdge, error)
	GetSession(ctx context.Context, sid string) (*Session, error)
	GetAgentSession(ctx context.Context, id string) (*AgentSession, error)
	GetDelegationPath(ctx context.Context, zoneID, sourceID, targetID string, maxHops int) ([]string, error)
	GetDelegationGraphEpoch(ctx context.Context, zoneID string) (int64, error)
	InsertSession(ctx context.Context, s *Session) error
	RevokeSession(ctx context.Context, zoneID, sid, reason string) error
	GetStepUpChallenge(ctx context.Context, id string) (*StepUpChallengePG, error)
	GetOrCreateApprovalChallenge(ctx context.Context, c *StepUpChallengePG) (*StepUpChallengePG, bool, error)
	DecideStepUpChallenge(ctx context.Context, p DecideStepUpParams) error
	ConsumeApprovalChallenge(ctx context.Context, p ConsumeApprovalParams) error
	SessionsRelated(ctx context.Context, zoneID, sessionA, sessionB string) (bool, error)
	DeleteExpiredStepUpChallenges(ctx context.Context, cutoff time.Time) (int64, error)
	EnsureZoneSigningKeySecret(ctx context.Context, zoneID string, ciphertext, nonce []byte) (*SecretRow, error)
	InsertZoneSigningKeySecret(ctx context.Context, zoneID string, ciphertext, nonce []byte) (*SecretRow, error)
	GetZoneSigningKeySecret(ctx context.Context, zoneID string) (*SecretRow, error)
	GetZoneSigningKeySecrets(ctx context.Context, zoneID string) ([]SecretRow, error)
	GetActivePolicySetBinding(ctx context.Context, zoneID string) (*PolicySetBinding, error)
	GetPolicySetVersion(ctx context.Context, id string) (*PolicySetVersion, error)
	GetPolicyVersionsByIDs(ctx context.Context, ids []string) ([]PolicyVersion, error)
	GetApplicationByIDGlobal(ctx context.Context, id string) (*Application, error)
	GetWorkloadByID(ctx context.Context, id string) (*Workload, error)
	ListBoundZoneIDs(ctx context.Context) ([]string, error)
}

// Zone holds the fields STS needs from the zones table.
type Zone struct {
	ID            string
	DEKCiphertext []byte
	KEKArn        *string
}

func (d *DB) GetZone(ctx context.Context, id string) (*Zone, error) {
	var z Zone
	err := d.pool.QueryRow(ctx,
		`SELECT id, dek_ciphertext, kek_arn
		 FROM zones WHERE id = $1`, id,
	).Scan(&z.ID, &z.DEKCiphertext, &z.KEKArn)
	if err != nil {
		return nil, err
	}
	return &z, nil
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
	AllowedApplications  []string
}

func (d *DB) GetResourceByIdentifier(ctx context.Context, zoneID, identifier string) (*Resource, error) {
	var r Resource
	var operations []byte
	err := d.pool.QueryRow(ctx,
		`SELECT id, zone_id, identifier, upstream_url, scopes, credential_provider_id, operations, operation_enforcement, allowed_application_ids FROM resources
		 WHERE zone_id = $1 AND identifier = $2 AND archived_at IS NULL`, zoneID, identifier,
	).Scan(&r.ID, &r.ZoneID, &r.Identifier, &r.UpstreamURL, &r.Scopes, &r.CredentialProviderID, &operations, &r.OperationEnforcement, &r.AllowedApplications)
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

// Session holds the STS session fields.
type Session struct {
	ID              string
	ZoneID          string
	SessionType     string
	SubjectID       *string
	ParentID        *string
	Status          string
	ExpiresAt       time.Time
	AuthenticatedAt time.Time
}

// DelegationEdge holds the active graph authority edge used by STS.
type DelegationEdge struct {
	ID              string
	ZoneID          string
	SourceSessionID string
	TargetSessionID string
	IssuerAppID     string
	ReceiverAppID   string
	ResourceID      *string
	Scopes          []string
	Status          string
	ExpiresAt       time.Time
	EdgeVersion     int
	ConstraintsJSON json.RawMessage
	RevokedAt       *time.Time
}

// AgentSession holds coordinator graph node fields needed by STS.
type AgentSession struct {
	ID                  string
	ZoneID              string
	ApplicationID       string
	SubjectSessionID    string
	Lifecycle           string
	Labels              []string
	Status              string
	SpawnedAt           time.Time
	TTLSeconds          int
	HeartbeatDeadlineAt *time.Time
	ParentID            *string
	Depth               int
}

func (d *DB) GetDelegationEdge(ctx context.Context, id string) (*DelegationEdge, error) {
	var edge DelegationEdge
	err := d.pool.QueryRow(ctx,
		`SELECT id, zone_id, source_session_id, target_session_id, issuer_application_id,
		        receiver_application_id, resource_id, scopes, status, expires_at, edge_version,
		        constraints_json, revoked_at
		 FROM delegation_edges WHERE id = $1`, id,
	).Scan(
		&edge.ID,
		&edge.ZoneID,
		&edge.SourceSessionID,
		&edge.TargetSessionID,
		&edge.IssuerAppID,
		&edge.ReceiverAppID,
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

func (d *DB) GetSession(ctx context.Context, sid string) (*Session, error) {
	var s Session
	err := d.pool.QueryRow(ctx,
		`SELECT id, zone_id, session_type, subject_id, parent_id, status, expires_at, authenticated_at
		 FROM sessions WHERE id = $1`, sid,
	).Scan(&s.ID, &s.ZoneID, &s.SessionType, &s.SubjectID, &s.ParentID, &s.Status, &s.ExpiresAt, &s.AuthenticatedAt)
	if err != nil {
		return nil, err
	}
	return &s, nil
}

func (d *DB) GetAgentSession(ctx context.Context, id string) (*AgentSession, error) {
	var s AgentSession
	err := d.pool.QueryRow(ctx,
		`SELECT id, zone_id, application_id, subject_session_id, lifecycle, labels, status,
		        spawned_at, COALESCE(ttl_seconds, 0), heartbeat_deadline_at, parent_id, depth
		 FROM agent_sessions WHERE id = $1`, id,
	).Scan(&s.ID, &s.ZoneID, &s.ApplicationID, &s.SubjectSessionID, &s.Lifecycle, &s.Labels, &s.Status, &s.SpawnedAt, &s.TTLSeconds, &s.HeartbeatDeadlineAt, &s.ParentID, &s.Depth)
	if err != nil {
		return nil, err
	}
	return &s, nil
}

func (d *DB) GetDelegationPath(ctx context.Context, zoneID, sourceID, targetID string, maxHops int) ([]string, error) {
	var path []string
	err := d.pool.QueryRow(ctx,
		`WITH RECURSIVE graph AS (
		   SELECT id, source_session_id, target_session_id, 1 AS depth, ARRAY[id] AS path
		   FROM delegation_edges
		   WHERE zone_id = $1 AND source_session_id = $2 AND status = 'active' AND expires_at > now()
		   UNION ALL
		   SELECT e.id, e.source_session_id, e.target_session_id, g.depth + 1, g.path || e.id
		   FROM delegation_edges e
		   JOIN graph g ON e.source_session_id = g.target_session_id
		   WHERE e.zone_id = $1
		     AND e.status = 'active'
		     AND e.expires_at > now()
		     AND NOT e.id = ANY(g.path)
		     AND g.depth < $4
		 )
		 SELECT path FROM graph WHERE target_session_id = $3 ORDER BY depth LIMIT 1`,
		zoneID, sourceID, targetID, maxHops,
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

func (d *DB) InsertSession(ctx context.Context, s *Session) error {
	_, err := d.pool.Exec(ctx,
		`INSERT INTO sessions (id, zone_id, session_type, subject_id, parent_id, status, expires_at, authenticated_at)
		 VALUES ($1, $2, $3, $4, $5, 'active', $6, $7)`,
		s.ID, s.ZoneID, s.SessionType, s.SubjectID, s.ParentID, s.ExpiresAt, s.AuthenticatedAt,
	)
	return err
}

func (d *DB) RevokeSession(ctx context.Context, zoneID, sid, reason string) error {
	if reason == "" {
		reason = "session_revoked"
	}
	_, err := d.pool.Exec(ctx,
		`WITH RECURSIVE revoked_tree AS (
		   SELECT id FROM sessions WHERE id = $1 AND zone_id = $2
		   UNION ALL
		   SELECT s.id FROM sessions s
		   JOIN revoked_tree r ON s.parent_id = r.id
		   WHERE s.zone_id = $2
		 )
		 UPDATE sessions SET status = 'revoked',
		   revoked_at = COALESCE(revoked_at, now()),
		   revoked_reason = COALESCE(revoked_reason, $3)
		 WHERE zone_id = $2 AND id IN (SELECT id FROM revoked_tree)`,
		sid, zoneID, reason,
	)
	return err
}

// StepUpChallengePG is the durable approval hold behind a gated mint: one live row per
// exact authority binding, carrying the resolved tier declaration and the approver's
// decision.
type StepUpChallengePG struct {
	ID                string
	ZoneID            string
	SessionID         string
	ChallengeType     string
	PrincipalID       string
	ApplicationID     string
	Tier              string
	ApproverClass     string
	PrivacyMode       string
	ResourceSetHash   []byte
	ExpiresAt         time.Time
	SatisfiedAt       *time.Time
	RejectedAt        *time.Time
	ConsumedAt        *time.Time
	ApproverSubjectID *string
	ApproverSessionID *string
	DecisionReason    *string
	MetadataJSON      []byte
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
// approver's session id, when present, is the forensic and revocation anchor.
type DecideStepUpParams struct {
	ID                string
	ZoneID            string
	Approve           bool
	ApproverSubjectID string
	ApproverSessionID string
	Reason            string
}

const stepUpChallengeColumns = `id, zone_id, session_id, challenge_type, principal_id,
	application_id, tier, approver_class, privacy_mode, resource_set_hash, expires_at,
	satisfied_at, rejected_at, consumed_at, approver_subject_id, approver_session_id,
	decision_reason, metadata_json`

func scanStepUpChallenge(row pgx.Row) (*StepUpChallengePG, error) {
	var c StepUpChallengePG
	var appID *string
	var tier *string
	err := row.Scan(&c.ID, &c.ZoneID, &c.SessionID, &c.ChallengeType, &c.PrincipalID,
		&appID, &tier, &c.ApproverClass, &c.PrivacyMode, &c.ResourceSetHash, &c.ExpiresAt,
		&c.SatisfiedAt, &c.RejectedAt, &c.ConsumedAt, &c.ApproverSubjectID, &c.ApproverSessionID,
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
		c.ZoneID, c.PrincipalID, c.SessionID, c.ResourceSetHash,
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
		c.ID, c.ZoneID, c.SessionID, c.ChallengeType, c.PrincipalID, c.ApplicationID,
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
		c.ZoneID, c.PrincipalID, c.SessionID, c.ResourceSetHash,
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
		p.ID, p.ZoneID, p.Approve, p.ApproverSubjectID, p.ApproverSessionID, p.Reason,
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
		     SELECT 1 FROM sessions s
		     WHERE s.id = c.session_id
		       AND s.zone_id = c.zone_id
		       AND s.status = 'active'
		       AND s.expires_at > now()
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

// SessionsRelated reports whether two sessions in a zone sit on the same delegation
// ancestry line: identical, ancestor, or descendant. Used to stop an approver session
// from deciding a hold raised by its own session chain, closing the loop where an
// agent's work is approved by the very session that spawned or descends from it.
func (d *DB) SessionsRelated(ctx context.Context, zoneID, sessionA, sessionB string) (bool, error) {
	if sessionA == "" || sessionB == "" {
		return sessionA != "" && sessionA == sessionB, nil
	}
	var related bool
	err := d.pool.QueryRow(ctx,
		`WITH RECURSIVE lineage AS (
		   SELECT id, parent_id FROM sessions WHERE id = $2 AND zone_id = $1
		   UNION ALL
		   SELECT s.id, s.parent_id FROM sessions s
		   JOIN lineage l ON s.id = l.parent_id
		   WHERE s.zone_id = $1
		 ), reverse_lineage AS (
		   SELECT id, parent_id FROM sessions WHERE id = $3 AND zone_id = $1
		   UNION ALL
		   SELECT s.id, s.parent_id FROM sessions s
		   JOIN reverse_lineage r ON s.id = r.parent_id
		   WHERE s.zone_id = $1
		 )
		 SELECT EXISTS (SELECT 1 FROM lineage WHERE id = $3)
		     OR EXISTS (SELECT 1 FROM reverse_lineage WHERE id = $2)`,
		zoneID, sessionA, sessionB,
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

// SecretRow holds an encrypted secret blob.
type SecretRow struct {
	ID         string
	Ciphertext []byte
	Nonce      []byte
	DEKID      string
}

func (d *DB) GetZoneSigningKeySecret(ctx context.Context, zoneID string) (*SecretRow, error) {
	var s SecretRow
	err := d.pool.QueryRow(ctx,
		`SELECT id, ciphertext, nonce, dek_id FROM secrets
		 WHERE zone_id = $1 AND name = 'zone_signing_key' ORDER BY version DESC LIMIT 1`, zoneID,
	).Scan(&s.ID, &s.Ciphertext, &s.Nonce, &s.DEKID)
	if err != nil {
		return nil, err
	}
	return &s, nil
}

func (d *DB) EnsureZoneSigningKeySecret(ctx context.Context, zoneID string, ciphertext, nonce []byte) (*SecretRow, error) {
	current, err := d.GetZoneSigningKeySecret(ctx, zoneID)
	if err == nil {
		return current, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return nil, err
	}
	var s SecretRow
	err = d.pool.QueryRow(ctx,
		`WITH next AS (
		   SELECT COALESCE(MAX(version), 0) + 1 AS version
		   FROM secrets WHERE zone_id = $1 AND entity_id = $1 AND name = 'zone_signing_key'
		 )
		 INSERT INTO secrets (id, zone_id, entity_id, name, type, ciphertext, nonce, dek_id, version)
		 SELECT $2, $1, $1, 'zone_signing_key', 'token', $3, $4, 'zoneKek', next.version FROM next
		 RETURNING id, ciphertext, nonce, dek_id`,
		zoneID, id.String(), ciphertext, nonce,
	).Scan(&s.ID, &s.Ciphertext, &s.Nonce, &s.DEKID)
	if err != nil {
		if current, getErr := d.GetZoneSigningKeySecret(ctx, zoneID); getErr == nil {
			return current, nil
		}
		return nil, err
	}
	return &s, nil
}

func (d *DB) InsertZoneSigningKeySecret(ctx context.Context, zoneID string, ciphertext, nonce []byte) (*SecretRow, error) {
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
		 INSERT INTO secrets (id, zone_id, entity_id, name, type, ciphertext, nonce, dek_id, version)
		 SELECT $2, $1, $1, 'zone_signing_key', 'token', $3, $4, 'zoneKek', next.version FROM next
		 RETURNING id, ciphertext, nonce, dek_id`,
		zoneID, id.String(), ciphertext, nonce,
	).Scan(&s.ID, &s.Ciphertext, &s.Nonce, &s.DEKID)
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
		   SELECT id, ciphertext, nonce, dek_id, created_at,
		          row_number() OVER (ORDER BY version DESC, created_at DESC) AS key_rank
		     FROM secrets
		    WHERE zone_id = $1 AND name = 'zone_signing_key'
		 ), active AS (
		   SELECT created_at FROM ranked WHERE key_rank = 1
		 )
		 SELECT ranked.id, ranked.ciphertext, ranked.nonce, ranked.dek_id
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
		if err := rows.Scan(&s.ID, &s.Ciphertext, &s.Nonce, &s.DEKID); err != nil {
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

// ProviderGrant holds provider-native delegated tokens for a user+resource pair.
type ProviderGrant struct {
	ID                  string
	ZoneID              string
	UserID              string
	ResourceID          string
	ProviderID          *string
	AccessTokenCt       []byte
	RefreshTokenCt      []byte
	ExpiresAt           *time.Time
	RefreshTokenVersion int
}

func (d *DB) GetProviderGrant(ctx context.Context, zoneID, userID, resourceID string, providerID *string) (*ProviderGrant, error) {
	var g ProviderGrant
	err := d.pool.QueryRow(ctx,
		`SELECT id, zone_id, user_id, resource_id, provider_id,
		        access_token_ct, refresh_token_ct, expires_at, refresh_token_version
		 FROM provider_grants
		 WHERE zone_id = $1 AND user_id = $2 AND resource_id = $3 AND status = 'active'
		   AND ($4::text IS NULL OR provider_id = $4)
		 ORDER BY created_at DESC LIMIT 1`, zoneID, userID, resourceID, providerID,
	).Scan(&g.ID, &g.ZoneID, &g.UserID, &g.ResourceID, &g.ProviderID,
		&g.AccessTokenCt, &g.RefreshTokenCt, &g.ExpiresAt, &g.RefreshTokenVersion)
	if err != nil {
		return nil, err
	}
	return &g, nil
}

// UpdateProviderGrantTokens updates tokens using optimistic locking on refresh_token_version.
// Returns ErrConcurrentGrantUpdate if the row was concurrently modified since it was read.
func (d *DB) UpdateProviderGrantTokens(ctx context.Context, id string, expectedVersion int, accessCt, refreshCt []byte, expiresAt time.Time) error {
	tag, err := d.pool.Exec(ctx,
		`UPDATE provider_grants
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

// ProviderConfig holds the provider config needed for token refresh.
type ProviderConfig struct {
	ID                string
	ProviderKind      *string
	ConfigJSON        json.RawMessage
	SecretConfigCt    []byte
	SecretConfigNonce []byte
}

func (d *DB) GetProvider(ctx context.Context, id string) (*ProviderConfig, error) {
	var p ProviderConfig
	err := d.pool.QueryRow(ctx,
		`SELECT id, provider_kind, config_json, secret_config_ct, secret_config_nonce
		 FROM providers WHERE id = $1 AND archived_at IS NULL`, id,
	).Scan(&p.ID, &p.ProviderKind, &p.ConfigJSON, &p.SecretConfigCt, &p.SecretConfigNonce)
	if err != nil {
		return nil, err
	}
	return &p, nil
}
