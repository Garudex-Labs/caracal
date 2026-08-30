// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package operatorops serves the deployment control plane: platform-wide
// statistics and tenant (organization) lifecycle for the team hosting the
// Caracal installation. Every read here is deliberately metadata-only:
// tenant content stays inside the organization boundary. Activity numbers
// come from real telemetry aggregates and are reported as unavailable,
// never fabricated, when ClickHouse cannot answer.
package operatorops

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/orgs"
)

// PGQuerier is the subset of a pgx pool these handlers need.
type PGQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// CHQuerier runs ClickHouse FORMAT JSON statements with bound parameters.
type CHQuerier interface {
	QueryJSON(ctx context.Context, sql string, settings clickhouse.Settings) ([]map[string]any, error)
}

// OrgLifecycle is the tenant write surface reused from the orgs package so
// operator deletion keeps the exact same emptiness guarantees as tenant
// self-deletion: Caracal never bulk-destroys tenant content.
type OrgLifecycle interface {
	DeleteSuspendedOrg(ctx context.Context, tx orgs.TxBeginner, org *orgs.Org) error
}

// Handler answers the operator control-plane reads and lifecycle writes.
type Handler struct {
	DB   PGQuerier
	CH   CHQuerier
	Tx   orgs.TxBeginner
	Orgs OrgLifecycle
}

// Register mounts the routes behind the operator floor supplied by the caller.
func (h *Handler) Register(mux *http.ServeMux, withOperator func(http.Handler) http.Handler) {
	mux.Handle("GET /api/v1/operator/overview", withOperator(http.HandlerFunc(h.overview)))
	mux.Handle("GET /api/v1/operator/orgs", withOperator(http.HandlerFunc(h.organizations)))
	mux.Handle("POST /api/v1/operator/orgs/{id}/suspend", withOperator(http.HandlerFunc(h.suspendOrg)))
	mux.Handle("POST /api/v1/operator/orgs/{id}/reinstate", withOperator(http.HandlerFunc(h.reinstateOrg)))
	mux.Handle("DELETE /api/v1/operator/orgs/{id}", withOperator(http.HandlerFunc(h.deleteOrg)))
}

// overview reports deployment-wide counters, 12 weeks of creation growth,
// and 30-day telemetry activity. Growth comes from creation timestamps in
// PostgreSQL; activity from ClickHouse session aggregates. When ClickHouse
// cannot answer, activity is reported unavailable rather than as zeros.
func (h *Handler) overview(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var orgsTotal, orgsSuspended, projects, users, operators, reviewers, agents int64
	err := h.DB.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM organizations),
		(SELECT count(*) FROM organizations WHERE suspended_at IS NOT NULL),
		(SELECT count(*) FROM projects),
		(SELECT count(*) FROM users),
		(SELECT count(*) FROM users WHERE role = 'operator'),
		(SELECT count(*) FROM users WHERE role = 'reviewer'),
		(SELECT count(*) FROM agents WHERE deleted_at IS NULL)`).
		Scan(&orgsTotal, &orgsSuspended, &projects, &users, &operators, &reviewers, &agents)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}

	growth, err := h.growthWeeks(ctx)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}

	activity := map[string]any{"available": false}
	if act, err := h.activityByOrg(ctx); err == nil {
		var sessions30d int64
		for _, n := range act.orgSessions {
			sessions30d += n
		}
		topOrgs, err := h.topOrgs(ctx, act.orgSessions, 5)
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		activity = map[string]any{
			"available":       true,
			"sessions_30d":    sessions30d,
			"events_30d":      act.events30d,
			"orgs_active_30d": int64(len(act.orgSessions)),
			"top_orgs":        topOrgs,
		}
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"totals": map[string]any{
			"organizations":           orgsTotal,
			"organizations_suspended": orgsSuspended,
			"projects":                projects,
			"agents":                  agents,
			"users": map[string]any{
				"total":     users,
				"operators": operators,
				"reviewers": reviewers,
				"members":   users - operators - reviewers,
			},
		},
		"growth":   map[string]any{"weeks": growth},
		"activity": activity,
	})
}

// growthWeeks counts organization, user, and project creations per ISO week
// for the last 12 weeks, zero-filling weeks with no creations.
func (h *Handler) growthWeeks(ctx context.Context) ([]map[string]any, error) {
	rows, err := h.DB.Query(ctx, `SELECT kind,
		to_char(date_trunc('week', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS week_start,
		count(*)::bigint
		FROM (
			SELECT 'organizations' AS kind, created_at FROM organizations
			UNION ALL SELECT 'users', created_at FROM users
			UNION ALL SELECT 'projects', created_at FROM projects
		) t
		WHERE created_at >= now() - INTERVAL '12 weeks'
		GROUP BY kind, week_start`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	counts := map[string]map[string]int64{}
	for rows.Next() {
		var kind, week string
		var n int64
		if err := rows.Scan(&kind, &week, &n); err != nil {
			return nil, err
		}
		if counts[week] == nil {
			counts[week] = map[string]int64{}
		}
		counts[week][kind] = n
	}
	if rows.Err() != nil {
		return nil, rows.Err()
	}

	// ISO weeks start on Monday; walk back 12 weeks from this week's Monday.
	now := time.Now().UTC()
	monday := now.AddDate(0, 0, -((int(now.Weekday()) + 6) % 7))
	out := make([]map[string]any, 0, 12)
	for i := 11; i >= 0; i-- {
		week := monday.AddDate(0, 0, -7*i).Format("2006-01-02")
		c := counts[week]
		out = append(out, map[string]any{
			"week_start":    week,
			"organizations": c["organizations"],
			"users":         c["users"],
			"projects":      c["projects"],
		})
	}
	return out, nil
}

// orgActivity carries the 30-day telemetry rollup keyed by organization id.
type orgActivity struct {
	orgSessions map[string]int64
	events30d   int64
}

const maxActivityScope = 100000

var errActivityScopeTooLarge = errors.New("30-day activity scope exceeds the operator query limit")

// activityByOrg aggregates 30-day session counts per project in ClickHouse
// and maps them onto organizations through the projects table. The result
// is bounded by the number of projects with recent activity.
func (h *Handler) activityByOrg(ctx context.Context) (*orgActivity, error) {
	if h.CH == nil {
		return nil, context.Canceled
	}
	rows, err := h.CH.QueryJSON(ctx,
		`SELECT project_id, uniqExact(session_id) AS sessions, sum(event_count) AS events
		 FROM session_stats_agg FINAL
		 WHERE last_event_time >= now() - INTERVAL 30 DAY
		 GROUP BY project_id
		 LIMIT 100001 FORMAT JSON`,
		clickhouse.Settings{})
	if err != nil {
		return nil, err
	}
	if len(rows) > maxActivityScope {
		return nil, errActivityScopeTooLarge
	}
	act := &orgActivity{orgSessions: map[string]int64{}}
	projSessions := map[string]int64{}
	projectIDs := make([]string, 0, len(rows))
	for _, row := range rows {
		pid, _ := row["project_id"].(string)
		if pid == "" {
			continue
		}
		projSessions[pid] = int64(jsonNumber(row["sessions"]))
		act.events30d += int64(jsonNumber(row["events"]))
		projectIDs = append(projectIDs, pid)
	}
	if len(projectIDs) == 0 {
		return act, nil
	}
	pgRows, err := h.DB.Query(ctx,
		`SELECT p.id::text, p.organization_id::text FROM projects p WHERE p.id::text = ANY($1)`,
		projectIDs)
	if err != nil {
		return nil, err
	}
	defer pgRows.Close()
	for pgRows.Next() {
		var projectID, orgID string
		if err := pgRows.Scan(&projectID, &orgID); err != nil {
			return nil, err
		}
		act.orgSessions[orgID] += projSessions[projectID]
	}
	if pgRows.Err() != nil {
		return nil, pgRows.Err()
	}
	return act, nil
}

// topOrgs resolves the n most active organizations to slug and name.
func (h *Handler) topOrgs(ctx context.Context, orgSessions map[string]int64, n int) ([]map[string]any, error) {
	ids := make([]string, 0, len(orgSessions))
	for id := range orgSessions {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		if orgSessions[ids[i]] != orgSessions[ids[j]] {
			return orgSessions[ids[i]] > orgSessions[ids[j]]
		}
		return ids[i] < ids[j]
	})
	if len(ids) > n {
		ids = ids[:n]
	}
	out := []map[string]any{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := h.DB.Query(ctx,
		`SELECT o.id::text, o.slug, o.name FROM organizations o WHERE o.id::text = ANY($1)`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	names := map[string][2]string{}
	for rows.Next() {
		var id, slug, name string
		if err := rows.Scan(&id, &slug, &name); err != nil {
			return nil, err
		}
		names[id] = [2]string{slug, name}
	}
	if rows.Err() != nil {
		return nil, rows.Err()
	}
	for _, id := range ids {
		meta, ok := names[id]
		if !ok {
			continue // organization deleted since the telemetry was written
		}
		out = append(out, map[string]any{
			"id": id, "slug": meta[0], "name": meta[1],
			"sessions_30d": orgSessions[id],
		})
	}
	return out, nil
}

func jsonNumber(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case string:
		var f float64
		for _, c := range n {
			if c < '0' || c > '9' {
				return f
			}
			f = f*10 + float64(c-'0')
		}
		return f
	default:
		return 0
	}
}
