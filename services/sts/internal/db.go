// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// PostgreSQL client and all query functions used by the STS.

package internal

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type DB struct{ pool *pgxpool.Pool }

// ErrConcurrentGrantUpdate signals an optimistic-lock conflict on delegated_grants.
// Callers refresh.go retries on this; other errors are returned as-is.
var ErrConcurrentGrantUpdate = errors.New("concurrent grant update")

func newDB(ctx context.Context, dsn string) (*DB, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	return &DB{pool: pool}, nil
}

func (d *DB) Ping(ctx context.Context) error {
	return d.pool.Ping(ctx)
}

// DBQuerier is the interface that Server and KeyCache use to access the database.
// Concrete implementations are DB (production) and test doubles.
type DBQuerier interface {
	Ping(ctx context.Context) error
	GetApplicationByID(ctx context.Context, id, zoneID string) (*Application, error)
	GetResourceByIdentifier(ctx context.Context, zoneID, identifier string) (*Resource, error)
	GetDelegatedGrant(ctx context.Context, zoneID, userID, resourceID string) (*DelegatedGrant, error)
	UpdateGrantTokens(ctx context.Context, id string, expectedVersion int, accessCt, refreshCt []byte, expiresAt time.Time) error
	GetProvider(ctx context.Context, id string) (*ProviderConfig, error)
	GetDelegationEdge(ctx context.Context, id string) (*DelegationEdge, error)
	GetResourceRateLimit(ctx context.Context, zoneID, resourceID string) (*ResourceRateLimit, error)
	GetSession(ctx context.Context, sid string) (*Session, error)
	GetAgentSession(ctx context.Context, id string) (*AgentSession, error)
	GetDelegationPath(ctx context.Context, zoneID, sourceID, targetID string, maxHops int) ([]string, error)
	GetDelegationGraphEpoch(ctx context.Context, zoneID string) (int64, error)
	InsertSession(ctx context.Context, s *Session) error
	RevokeSession(ctx context.Context, zoneID, sid string) error
	GetStepUpChallenge(ctx context.Context, id string) (*StepUpChallengePG, error)
	InsertStepUpChallenge(ctx context.Context, c *StepUpChallengePG) error
	SatisfyStepUpChallenge(ctx context.Context, id string) error
	ConsumeStepUpChallenge(ctx context.Context, p ConsumeStepUpParams) error
	GetZoneSigningKeySecret(ctx context.Context, zoneID string) (*SecretRow, error)
	GetZoneSigningKeySecrets(ctx context.Context, zoneID string) ([]SecretRow, error)
	GetActivePolicySetBinding(ctx context.Context, zoneID string) (*PolicySetBinding, error)
	GetPolicySetVersion(ctx context.Context, id string) (*PolicySetVersion, error)
	GetPolicyVersionsByIDs(ctx context.Context, ids []string) ([]PolicyVersion, error)
	ListBoundZoneIDs(ctx context.Context) ([]string, error)
	UpdateApplicationSecretHash(ctx context.Context, id, zoneID, hash string) error
}

// Zone holds the fields STS needs from the zones table.
type Zone struct {
	ID            string
	OrgID         string
	DEKCiphertext []byte
	KEKArn        *string
}

func (d *DB) GetZone(ctx context.Context, id string) (*Zone, error) {
	var z Zone
	err := d.pool.QueryRow(ctx,
		`SELECT id, org_id, dek_ciphertext, kek_arn
		 FROM zones WHERE id = $1`, id,
	).Scan(&z.ID, &z.OrgID, &z.DEKCiphertext, &z.KEKArn)
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
	CredentialType     *string
	ClientSecretHash   *string
}

func (d *DB) GetApplicationByID(ctx context.Context, id, zoneID string) (*Application, error) {
	var a Application
	err := d.pool.QueryRow(ctx,
		`SELECT id, zone_id, name, registration_method, credential_type, client_secret_hash
		 FROM applications WHERE id = $1 AND zone_id = $2`, id, zoneID,
	).Scan(&a.ID, &a.ZoneID, &a.Name, &a.RegistrationMethod, &a.CredentialType, &a.ClientSecretHash)
	if err != nil {
		return nil, err
	}
	return &a, nil
}

// Resource holds the fields STS needs from the resources table.
type Resource struct {
	ID                   string
	ZoneID               string
	Identifier           string
	UpstreamURL          *string
	Scopes               []string
	CredentialProviderID *string
}

func (d *DB) GetResourceByIdentifier(ctx context.Context, zoneID, identifier string) (*Resource, error) {
	var r Resource
	err := d.pool.QueryRow(ctx,
		`SELECT id, zone_id, identifier, upstream_url, scopes, credential_provider_id FROM resources
		 WHERE zone_id = $1 AND identifier = $2`, zoneID, identifier,
	).Scan(&r.ID, &r.ZoneID, &r.Identifier, &r.UpstreamURL, &r.Scopes, &r.CredentialProviderID)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// ResourceRateLimit holds the fixed-window limit for a resource.
type ResourceRateLimit struct {
	Window time.Duration
	Max    int64
}

func (d *DB) GetResourceRateLimit(ctx context.Context, zoneID, resourceID string) (*ResourceRateLimit, error) {
	var windowSeconds int
	var maxRequests int64
	err := d.pool.QueryRow(ctx,
		`SELECT window_seconds, max_requests FROM resource_rate_limits
		 WHERE zone_id = $1 AND resource_id = $2`, zoneID, resourceID,
	).Scan(&windowSeconds, &maxRequests)
	if err != nil {
		return nil, err
	}
	return &ResourceRateLimit{Window: time.Duration(windowSeconds) * time.Second, Max: maxRequests}, nil
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
	ID            string
	ZoneID        string
	ApplicationID string
	SessionSID    string
	Status        string
	SpawnedAt     time.Time
	TTLSeconds    int
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
		`SELECT id, zone_id, session_type, subject_id, status, expires_at, authenticated_at
		 FROM sessions WHERE id = $1`, sid,
	).Scan(&s.ID, &s.ZoneID, &s.SessionType, &s.SubjectID, &s.Status, &s.ExpiresAt, &s.AuthenticatedAt)
	if err != nil {
		return nil, err
	}
	return &s, nil
}

func (d *DB) GetAgentSession(ctx context.Context, id string) (*AgentSession, error) {
	var s AgentSession
	err := d.pool.QueryRow(ctx,
		`SELECT id, zone_id, application_id, session_sid, status, spawned_at, ttl_seconds
		 FROM agent_sessions WHERE id = $1`, id,
	).Scan(&s.ID, &s.ZoneID, &s.ApplicationID, &s.SessionSID, &s.Status, &s.SpawnedAt, &s.TTLSeconds)
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
		 VALUES ($1, $2, $3, $4, NULL, 'active', $5, $6)`,
		s.ID, s.ZoneID, s.SessionType, s.SubjectID, s.ExpiresAt, s.AuthenticatedAt,
	)
	return err
}

func (d *DB) RevokeSession(ctx context.Context, zoneID, sid string) error {
	_, err := d.pool.Exec(ctx,
		`UPDATE sessions SET status = 'revoked' WHERE id = $1 AND zone_id = $2`, sid, zoneID,
	)
	return err
}

// StepUpChallengePG is stored in the database as the proof-bound, single-use record
// behind every step-up challenge.
type StepUpChallengePG struct {
	ID                  string
	ZoneID              string
	SessionID           string
	ChallengeType       string
	ChallengeSecretHash []byte
	PrincipalID         string
	ResourceSetHash     []byte
	ExpiresAt           time.Time
	SatisfiedAt         *time.Time
	ConsumedAt          *time.Time
}

// ConsumeStepUpParams holds the bindings the caller must present to consume a challenge.
type ConsumeStepUpParams struct {
	ID                  string
	ZoneID              string
	PrincipalID         string
	ChallengeSecretHash []byte
	ResourceSetHash     []byte
	Now                 time.Time
}

func (d *DB) InsertStepUpChallenge(ctx context.Context, c *StepUpChallengePG) error {
	_, err := d.pool.Exec(ctx,
		`INSERT INTO step_up_challenges
		   (id, zone_id, session_id, challenge_type, challenge_secret_hash,
		    principal_id, resource_set_hash, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		c.ID, c.ZoneID, c.SessionID, c.ChallengeType,
		c.ChallengeSecretHash, c.PrincipalID, c.ResourceSetHash, c.ExpiresAt,
	)
	return err
}

func (d *DB) SatisfyStepUpChallenge(ctx context.Context, id string) error {
	_, err := d.pool.Exec(ctx,
		`UPDATE step_up_challenges SET satisfied_at = now() WHERE id = $1`, id,
	)
	return err
}

// ConsumeStepUpChallenge atomically transitions a challenge to consumed state, but only
// when every binding matches: zone, principal, secret hash, resource set, satisfied,
// not yet expired, not yet consumed, and the originating session is still active.
// Returns ErrChallengeInvalid otherwise.
func (d *DB) ConsumeStepUpChallenge(ctx context.Context, p ConsumeStepUpParams) error {
	tag, err := d.pool.Exec(ctx,
		`UPDATE step_up_challenges c
		 SET consumed_at = $6
		 WHERE c.id = $1
		   AND c.zone_id = $2
		   AND c.principal_id = $3
		   AND c.challenge_secret_hash = $4
		   AND c.resource_set_hash = $5
		   AND c.satisfied_at IS NOT NULL
		   AND c.consumed_at IS NULL
		   AND c.expires_at > $6
		   AND EXISTS (
		     SELECT 1 FROM sessions s
		     WHERE s.id = c.session_id
		       AND s.zone_id = c.zone_id
		       AND s.status = 'active'
		       AND s.expires_at > $6
		   )`,
		p.ID, p.ZoneID, p.PrincipalID, p.ChallengeSecretHash, p.ResourceSetHash, p.Now,
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
	var c StepUpChallengePG
	err := d.pool.QueryRow(ctx,
		`SELECT id, zone_id, session_id, challenge_type, challenge_secret_hash,
		        principal_id, resource_set_hash, expires_at, satisfied_at, consumed_at
		 FROM step_up_challenges WHERE id = $1`, id,
	).Scan(&c.ID, &c.ZoneID, &c.SessionID, &c.ChallengeType, &c.ChallengeSecretHash,
		&c.PrincipalID, &c.ResourceSetHash, &c.ExpiresAt, &c.SatisfiedAt, &c.ConsumedAt)
	if err != nil {
		return nil, err
	}
	return &c, nil
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

// GetZoneSigningKeySecrets returns the two most recent signing key secrets for a zone.
// The first entry is the active signing key; the second (if present) is the previous key
// still served in JWKS during the 24h key-rotation grace period.
func (d *DB) GetZoneSigningKeySecrets(ctx context.Context, zoneID string) ([]SecretRow, error) {
	rows, err := d.pool.Query(ctx,
		`SELECT id, ciphertext, nonce, dek_id FROM secrets
		 WHERE zone_id = $1 AND name = 'zone_signing_key'
		 ORDER BY version DESC LIMIT 2`, zoneID,
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

// UpdateApplicationSecretHash rewrites the stored client_secret_hash for an application
// once a legacy SHA-256 verification succeeds, so subsequent verifications use Argon2id.
func (d *DB) UpdateApplicationSecretHash(ctx context.Context, id, zoneID, hash string) error {
	_, err := d.pool.Exec(ctx,
		`UPDATE applications SET client_secret_hash = $3, updated_at = now()
		 WHERE id = $1 AND zone_id = $2`,
		id, zoneID, hash,
	)
	return err
}

// DelegatedGrant holds the provider OAuth tokens for a user+resource pair.
type DelegatedGrant struct {
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

func (d *DB) GetDelegatedGrant(ctx context.Context, zoneID, userID, resourceID string) (*DelegatedGrant, error) {
	var g DelegatedGrant
	err := d.pool.QueryRow(ctx,
		`SELECT id, zone_id, user_id, resource_id, provider_id,
		        access_token_ct, refresh_token_ct, expires_at, refresh_token_version
		 FROM delegated_grants
		 WHERE zone_id = $1 AND user_id = $2 AND resource_id = $3 AND status = 'active'
		 ORDER BY created_at DESC LIMIT 1`, zoneID, userID, resourceID,
	).Scan(&g.ID, &g.ZoneID, &g.UserID, &g.ResourceID, &g.ProviderID,
		&g.AccessTokenCt, &g.RefreshTokenCt, &g.ExpiresAt, &g.RefreshTokenVersion)
	if err != nil {
		return nil, err
	}
	return &g, nil
}

// UpdateGrantTokens updates tokens using optimistic locking on refresh_token_version.
// Returns ErrConcurrentGrantUpdate if the row was concurrently modified since it was read.
func (d *DB) UpdateGrantTokens(ctx context.Context, id string, expectedVersion int, accessCt, refreshCt []byte, expiresAt time.Time) error {
	tag, err := d.pool.Exec(ctx,
		`UPDATE delegated_grants
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
	ID         string
	ConfigJSON json.RawMessage
}

func (d *DB) GetProvider(ctx context.Context, id string) (*ProviderConfig, error) {
	var p ProviderConfig
	err := d.pool.QueryRow(ctx,
		`SELECT id, config_json FROM providers WHERE id = $1`, id,
	).Scan(&p.ID, &p.ConfigJSON)
	if err != nil {
		return nil, err
	}
	return &p, nil
}
