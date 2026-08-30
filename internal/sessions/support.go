// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"context"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"
)

// PGQuerier is the subset of a pgx pool the sessions routes need.
type PGQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Directory resolves display names and search filters against Postgres.
type Directory struct {
	DB PGQuerier
}

// UserNames maps user ids to display names; unknown ids are omitted.
func (d *Directory) UserNames(ctx context.Context, ids []string) map[string]string {
	return d.namesByID(ctx, `SELECT id, name FROM users WHERE id = ANY($1)`, ids)
}

// AgentNames maps agent ids to names; unknown ids are omitted.
func (d *Directory) AgentNames(ctx context.Context, ids []string) map[string]string {
	return d.namesByID(ctx, `SELECT id, name FROM agents WHERE id = ANY($1)`, ids)
}

func (d *Directory) namesByID(ctx context.Context, sql string, ids []string) map[string]string {
	names := map[string]string{}
	var parsed []uuid.UUID
	for _, id := range ids {
		if u, err := uuid.Parse(id); err == nil {
			parsed = append(parsed, u)
		}
	}
	if len(parsed) == 0 {
		return names
	}
	rows, err := d.DB.Query(ctx, sql, parsed)
	if err != nil {
		return names
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var name string
		if rows.Scan(&id, &name) == nil {
			names[id.String()] = name
		}
	}
	return names
}

// UserName returns one user's display name, or "".
func (d *Directory) UserName(ctx context.Context, id uuid.UUID) string {
	var name string
	if err := d.DB.QueryRow(ctx, `SELECT name FROM users WHERE id = $1`, id).Scan(&name); err != nil {
		return ""
	}
	return name
}

// escapeLike treats user input as a literal inside LIKE patterns.
func escapeLike(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `%`, `\%`)
	return strings.ReplaceAll(value, `_`, `\_`)
}

// RedisBinder stores session-to-agent bindings with a one-day expiry.
type RedisBinder struct {
	Client interface {
		Set(ctx context.Context, key string, value any, expiration time.Duration) *redis.StatusCmd
	}
}

// BindAgent records the binding for the attribution window.
func (b RedisBinder) BindAgent(ctx context.Context, sessionID, agentName string) error {
	return b.Client.Set(ctx, "session_agent:"+sessionID, agentName, 24*time.Hour).Err()
}

// normQuery collapses whitespace and lowercases a search query.
func normQuery(value string) string {
	return strings.ToLower(strings.Join(strings.Fields(value), " "))
}

// ResolveUserFilter expands a free-text user filter into matching user ids:
// a literal uuid, plus trigram-ranked matches on username, email, and name.
func (d *Directory) ResolveUserFilter(ctx context.Context, query string) []string {
	q := normQuery(query)
	var ids []string
	seen := map[string]bool{}
	add := func(id string) {
		if id != "" && !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}

	if u, err := uuid.Parse(q); err == nil {
		add(u.String())
	}

	q = strings.TrimPrefix(q, "@")
	if len(q) < 2 {
		return ids
	}
	escaped := escapeLike(q)

	rows, err := d.DB.Query(ctx, `
		WITH scored AS (
			SELECT id, name, email,
				(CASE WHEN lower(coalesce(username, '')) = $1 THEN 100 ELSE 0 END
				+ CASE WHEN lower(email) = $1 THEN 98 ELSE 0 END
				+ CASE WHEN lower(name) = $1 THEN 96 ELSE 0 END
				+ CASE WHEN username ILIKE $2 ESCAPE '\' THEN 30 ELSE 0 END
				+ CASE WHEN email ILIKE $2 ESCAPE '\' THEN 28 ELSE 0 END
				+ CASE WHEN name ILIKE $2 ESCAPE '\' THEN 26 ELSE 0 END
				+ CASE WHEN name ILIKE $3 ESCAPE '\' THEN 10 ELSE 0 END
				+ greatest(
					similarity(lower(name), $1),
					similarity(lower(email), $1),
					similarity(lower(coalesce(username, '')), $1)
				) * 74) AS score,
				greatest(
					similarity(lower(name), $1),
					similarity(lower(email), $1),
					similarity(lower(coalesce(username, '')), $1)
				) AS sim
			FROM users
		)
		SELECT id FROM scored
		WHERE score >= 30 OR sim >= 0.18
		ORDER BY score DESC, name, email
		LIMIT 25`, q, escaped+"%", "%"+escaped+"%")
	if err != nil {
		return ids
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		if rows.Scan(&id) == nil {
			add(id.String())
		}
	}
	return ids
}

var _ NameDirectory = (*Directory)(nil)
