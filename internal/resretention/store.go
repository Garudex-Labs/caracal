// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package resretention

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type DB interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

type Store struct {
	DB DB
}

type PolicyConflict struct {
	ID                       string
	Name                     string
	Namespace                string
	Slug                     string
	Visibility               string
	DeletedAt                time.Time
	ScheduledPurgeAt         *time.Time
	ProposedScheduledPurgeAt time.Time
	EligibleAtApply          bool
}

func (s *Store) ReadPolicy(ctx context.Context, projectID uuid.UUID) (Policy, error) {
	policy := DefaultPolicy()
	err := s.DB.QueryRow(ctx, `SELECT private_retention_days, project_retention_days
		FROM project_resource_retention_policies WHERE project_id = $1`, projectID).
		Scan(&policy.PrivateRetentionDays, &policy.ProjectRetentionDays)
	if err == nil {
		return policy, nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return policy, nil
	}
	return policy, err
}

func (s *Store) PreviewPolicyChange(ctx context.Context, projectID uuid.UUID, policy Policy, now time.Time) ([]PolicyConflict, error) {
	if err := ValidatePolicy(policy.PrivateRetentionDays, policy.ProjectRetentionDays); err != nil {
		return nil, err
	}
	rows, err := s.DB.Query(ctx, `SELECT id::text, name, namespace, slug, ownership_scope,
		is_private, deleted_at, scheduled_purge_at
		FROM agents
		WHERE project_id = $1 AND deleted_at IS NOT NULL
		ORDER BY deleted_at DESC, id ASC`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	conflicts := []PolicyConflict{}
	for rows.Next() {
		var (
			id, name, namespace, slug, ownershipScope string
			isPrivate                                 bool
			deletedAt                                 time.Time
			scheduledPurgeAt                          *time.Time
		)
		if err := rows.Scan(&id, &name, &namespace, &slug, &ownershipScope, &isPrivate, &deletedAt, &scheduledPurgeAt); err != nil {
			return nil, err
		}
		class := ClassForAgent(ownershipScope, isPrivate)
		proposed := ScheduledPurgeAt(deletedAt, class, policy)
		current := scheduledPurgeAt
		if current == nil {
			fallback := ScheduledPurgeAt(deletedAt, class, DefaultPolicy())
			current = &fallback
		}
		if !proposed.Before(*current) {
			continue
		}
		conflicts = append(conflicts, PolicyConflict{
			ID: id, Name: name, Namespace: namespace, Slug: slug,
			Visibility: string(class), DeletedAt: deletedAt.UTC(), ScheduledPurgeAt: scheduledPurgeAt,
			ProposedScheduledPurgeAt: proposed.UTC(), EligibleAtApply: !proposed.After(now.UTC()),
		})
	}
	return conflicts, rows.Err()
}

func (s *Store) WritePolicy(ctx context.Context, projectID uuid.UUID, policy Policy) error {
	if err := ValidatePolicy(policy.PrivateRetentionDays, policy.ProjectRetentionDays); err != nil {
		return err
	}
	_, err := s.DB.Exec(ctx, `INSERT INTO project_resource_retention_policies
		(project_id, private_retention_days, project_retention_days, created_at, updated_at)
		VALUES ($1, $2, $3, now(), now())
		ON CONFLICT (project_id) DO UPDATE SET
		private_retention_days = EXCLUDED.private_retention_days,
		project_retention_days = EXCLUDED.project_retention_days,
		updated_at = now()`, projectID, policy.PrivateRetentionDays, policy.ProjectRetentionDays)
	if err != nil {
		return err
	}
	_, err = s.DB.Exec(ctx, `UPDATE agents
		SET scheduled_purge_at = deleted_at + make_interval(days => CASE WHEN ownership_scope = 'private' THEN $2 ELSE $3 END)
		WHERE project_id = $1 AND deleted_at IS NOT NULL`, projectID, policy.PrivateRetentionDays, policy.ProjectRetentionDays)
	return err
}

func (s *Store) PurgeExpiredAgents(ctx context.Context, now time.Time, limit int) (int, error) {
	if limit <= 0 {
		limit = 100
	}
	_, err := s.DB.Exec(ctx, `WITH expired AS (
		SELECT id FROM agents
		WHERE deleted_at IS NOT NULL AND scheduled_purge_at IS NOT NULL AND scheduled_purge_at <= $1
		ORDER BY scheduled_purge_at ASC, id ASC
		LIMIT $2
	)
	DELETE FROM review_issues r USING expired e
	WHERE r.subject_type = 'agent' AND r.subject_id = e.id`, now.UTC(), limit)
	if err != nil {
		return 0, err
	}
	_, err = s.DB.Exec(ctx, `WITH expired AS (
		SELECT id FROM agents
		WHERE deleted_at IS NOT NULL AND scheduled_purge_at IS NOT NULL AND scheduled_purge_at <= $1
		ORDER BY scheduled_purge_at ASC, id ASC
		LIMIT $2
	)
	DELETE FROM inbox_items i USING expired e
	WHERE i.subject_type = 'agent' AND i.subject_id = e.id`, now.UTC(), limit)
	if err != nil {
		return 0, err
	}
	rows, err := s.DB.Query(ctx, `WITH expired AS (
		SELECT id FROM agents
		WHERE deleted_at IS NOT NULL AND scheduled_purge_at IS NOT NULL AND scheduled_purge_at <= $1
		ORDER BY scheduled_purge_at ASC, id ASC
		LIMIT $2
	)
	DELETE FROM agents a USING expired e
	WHERE a.id = e.id
	RETURNING a.id::text`, now.UTC(), limit)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return count, err
		}
		count++
	}
	return count, rows.Err()
}
