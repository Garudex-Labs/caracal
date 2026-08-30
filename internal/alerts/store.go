// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package alerts

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ErrNotFound reports a missing alert rule.
var ErrNotFound = errors.New("alert rule not found")

// PGQuerier is the subset of a pgx pool the alert store needs.
type PGQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Rule is one alert_rules row.
type Rule struct {
	ID            uuid.UUID
	Name          string
	Metric        string
	Threshold     float64
	Condition     string
	TargetType    string
	TargetID      string
	WebhookURL    string
	WebhookSecret string
	Status        string
	LastTriggered *time.Time
	CreatedBy     uuid.UUID
	CreatedAt     time.Time
}

// History is one alert_history row.
type History struct {
	ID             uuid.UUID
	AlertRuleID    uuid.UUID
	MetricValue    float64
	Threshold      float64
	Condition      string
	FiredAt        time.Time
	DeliveryStatus string
	ResponseCode   *int
	Error          *string
	CreatedAt      time.Time
}

// Store persists alert rules and reads their firing history.
type Store struct {
	DB PGQuerier
}

const ruleColumns = `id, name, metric, threshold, condition, target_type, target_id,
	webhook_url, webhook_secret, status, last_triggered, created_by, created_at`

func scanRule(row pgx.Row) (Rule, error) {
	var r Rule
	err := row.Scan(&r.ID, &r.Name, &r.Metric, &r.Threshold, &r.Condition, &r.TargetType,
		&r.TargetID, &r.WebhookURL, &r.WebhookSecret, &r.Status, &r.LastTriggered,
		&r.CreatedBy, &r.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Rule{}, ErrNotFound
	}
	return r, err
}

// List returns rules newest-first; a non-nil owner restricts to that creator.
func (s *Store) List(ctx context.Context, owner *uuid.UUID) ([]Rule, error) {
	sql := `SELECT ` + ruleColumns + ` FROM alert_rules ORDER BY created_at DESC`
	args := []any{}
	if owner != nil {
		sql = `SELECT ` + ruleColumns + ` FROM alert_rules WHERE created_by = $1 ORDER BY created_at DESC`
		args = append(args, *owner)
	}
	rows, err := s.DB.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	rules := []Rule{}
	for rows.Next() {
		r, err := scanRule(rows)
		if err != nil {
			return nil, err
		}
		rules = append(rules, r)
	}
	return rules, rows.Err()
}

// Create inserts the rule and returns it as stored.
func (s *Store) Create(ctx context.Context, r Rule) (Rule, error) {
	r.ID = uuid.New()
	r.Status = "active"
	r.CreatedAt = time.Now().UTC()
	_, err := s.DB.Exec(ctx, `INSERT INTO alert_rules
		(id, name, metric, threshold, condition, target_type, target_id,
		 webhook_url, webhook_secret, status, created_by, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
		r.ID, r.Name, r.Metric, r.Threshold, r.Condition, r.TargetType, r.TargetID,
		r.WebhookURL, r.WebhookSecret, r.Status, r.CreatedBy, r.CreatedAt)
	return r, err
}

// ByID fetches one rule.
func (s *Store) ByID(ctx context.Context, id uuid.UUID) (Rule, error) {
	return scanRule(s.DB.QueryRow(ctx, `SELECT `+ruleColumns+` FROM alert_rules WHERE id = $1`, id))
}

// Update applies the provided fields and returns the stored rule.
func (s *Store) Update(ctx context.Context, id uuid.UUID, status, webhookURL *string) (Rule, error) {
	return scanRule(s.DB.QueryRow(ctx, `UPDATE alert_rules
		SET status = COALESCE($2, status), webhook_url = COALESCE($3, webhook_url)
		WHERE id = $1 RETURNING `+ruleColumns, id, status, webhookURL))
}

// UpdateSecret replaces the webhook signing secret.
func (s *Store) UpdateSecret(ctx context.Context, id uuid.UUID, secret string) (Rule, error) {
	return scanRule(s.DB.QueryRow(ctx,
		`UPDATE alert_rules SET webhook_secret = $2 WHERE id = $1 RETURNING `+ruleColumns, id, secret))
}

// Delete removes the rule and its firing history.
func (s *Store) Delete(ctx context.Context, id uuid.UUID) error {
	_, err := s.DB.Exec(ctx, `WITH gone AS (
			DELETE FROM alert_history WHERE alert_rule_id = $1 RETURNING 1
		)
		DELETE FROM alert_rules WHERE id = $1`, id)
	return err
}

// HistoryFor returns firing history newest-first.
func (s *Store) HistoryFor(ctx context.Context, ruleID uuid.UUID, limit, offset int) ([]History, error) {
	rows, err := s.DB.Query(ctx, `SELECT id, alert_rule_id, metric_value, threshold, condition,
		fired_at, delivery_status, response_code, error, created_at
		FROM alert_history WHERE alert_rule_id = $1
		ORDER BY fired_at DESC LIMIT $2 OFFSET $3`, ruleID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	history := []History{}
	for rows.Next() {
		var h History
		if err := rows.Scan(&h.ID, &h.AlertRuleID, &h.MetricValue, &h.Threshold, &h.Condition,
			&h.FiredAt, &h.DeliveryStatus, &h.ResponseCode, &h.Error, &h.CreatedAt); err != nil {
			return nil, err
		}
		history = append(history, h)
	}
	return history, rows.Err()
}

// ActiveRules returns every rule currently being evaluated.
func (s *Store) ActiveRules(ctx context.Context) ([]Rule, error) {
	rows, err := s.DB.Query(ctx, `SELECT `+ruleColumns+` FROM alert_rules WHERE status = 'active'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	rules := []Rule{}
	for rows.Next() {
		r, err := scanRule(rows)
		if err != nil {
			return nil, err
		}
		rules = append(rules, r)
	}
	return rules, rows.Err()
}

// RecordFiring stores one firing and stamps the rule's last_triggered in a
// single statement.
func (s *Store) RecordFiring(ctx context.Context, h History) error {
	_, err := s.DB.Exec(ctx, `WITH ins AS (
			INSERT INTO alert_history
				(id, alert_rule_id, metric_value, threshold, condition, fired_at,
				 delivery_status, response_code, error, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			RETURNING 1
		)
		UPDATE alert_rules SET last_triggered = $6 WHERE id = $2`,
		uuid.New(), h.AlertRuleID, h.MetricValue, h.Threshold, h.Condition, h.FiredAt,
		h.DeliveryStatus, h.ResponseCode, h.Error, h.FiredAt)
	return err
}
