// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package audit

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/httpapi"
)

// PGQuerier is the subset of a pgx pool the trail reads need.
type PGQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// Trail serves the operator audit-log query and export routes.
type Trail struct {
	CH *clickhouse.Client
	PG PGQuerier

	now func() time.Time
	// userFilter overrides actor resolution in tests.
	userFilter func(context.Context, string) (ids, emails []string)
}

// Routes returns the admin audit-log route group.
func (t *Trail) Routes() http.Handler {
	mux := http.NewServeMux()
	operator := func(fn http.HandlerFunc) http.Handler { return httpapi.RequireRole("operator", fn) }
	mux.Handle("GET /api/v1/operator/audit-log", operator(t.list))
	mux.Handle("GET /api/v1/operator/audit-log/export", operator(t.export_))
	return mux
}

const trailColumns = "event_id, timestamp, actor_id, actor_email, actor_role, " +
	"action, resource_type, resource_id, resource_name, http_method, " +
	"http_path, status_code, ip_address, user_agent, detail, " +
	"sensitivity, request_id, outcome, duration_ms, chain_hash, source"

var trailFieldnames = strings.Split(strings.ReplaceAll(trailColumns, " ", ""), ",")

// timeFormats are the accepted date filter shapes, most specific first.
var timeFormats = []string{
	time.RFC3339Nano,
	"2006-01-02T15:04:05",
	"2006-01-02 15:04:05",
	"2006-01-02",
}

func parseFilterTime(raw string) (time.Time, bool) {
	for _, layout := range timeFormats {
		if ts, err := time.Parse(layout, raw); err == nil {
			return ts, true
		}
	}
	return time.Time{}, false
}

func escapeLikeTrail(s string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return replacer.Replace(s)
}

// userFilterValues expands a free-text actor filter into matching user ids
// and emails: a literal uuid, a literal email, and trigram-ranked matches.
func (t *Trail) userFilterValues(ctx context.Context, query string) (ids, emails []string) {
	q := strings.ToLower(strings.Join(strings.Fields(query), " "))
	seenID := map[string]bool{}
	seenEmail := map[string]bool{}
	addID := func(id string) {
		if id != "" && !seenID[id] {
			seenID[id] = true
			ids = append(ids, id)
		}
	}
	addEmail := func(email string) {
		if email != "" && !seenEmail[email] {
			seenEmail[email] = true
			emails = append(emails, email)
		}
	}

	if u, err := uuid.Parse(q); err == nil {
		addID(u.String())
	}
	if strings.Contains(q, "@") && !strings.HasPrefix(q, "@") {
		addEmail(q)
	}

	term := strings.TrimPrefix(q, "@")
	if len(term) < 2 {
		return ids, emails
	}
	escaped := escapeLikeTrail(term)
	rows, err := t.PG.Query(ctx, `
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
		SELECT id, email FROM scored
		WHERE score >= 30 OR sim >= 0.18
		ORDER BY score DESC, name, email
		LIMIT 25`, term, escaped+"%", "%"+escaped+"%")
	if err != nil {
		return ids, emails
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var email string
		if rows.Scan(&id, &email) == nil {
			addID(id.String())
			addEmail(email)
		}
	}
	return ids, emails
}

func inCondition(column string, values []string, prefix string, params clickhouse.Settings) string {
	if len(values) == 0 {
		return ""
	}
	placeholders := make([]string, 0, len(values))
	for idx, value := range values {
		name := fmt.Sprintf("%s_%d", prefix, idx)
		placeholders = append(placeholders, "{"+name+":String}")
		params["param_"+name] = value
	}
	return column + " IN (" + strings.Join(placeholders, ", ") + ")"
}

// trailConditions builds the WHERE clause from the request filters. A non-nil
// error carries the 422 message.
func (t *Trail) trailConditions(r *http.Request, params clickhouse.Settings) (string, error) {
	q := r.URL.Query()
	conditions := []string{}

	if actor := q.Get("actor"); actor != "" {
		resolve := t.userFilterValues
		if t.userFilter != nil {
			resolve = t.userFilter
		}
		ids, emails := resolve(r.Context(), actor)
		actorConditions := []string{}
		if c := inCondition("actor_id", ids, "actor_id", params); c != "" {
			actorConditions = append(actorConditions, c)
		}
		if c := inCondition("actor_email", emails, "actor_email", params); c != "" {
			actorConditions = append(actorConditions, c)
		}
		if len(actorConditions) > 0 {
			conditions = append(conditions, "("+strings.Join(actorConditions, " OR ")+")")
		} else {
			conditions = append(conditions, "actor_email = {actor:String}")
			params["param_actor"] = actor
		}
	}
	equals := []struct{ query, column, name string }{
		{"action", "action", "action"},
		{"resource_type", "resource_type", "rtype"},
		{"sensitivity", "sensitivity", "sens"},
		{"outcome", "outcome", "outc"},
		{"source", "source", "src"},
	}
	for _, filter := range equals {
		if value := q.Get(filter.query); value != "" {
			conditions = append(conditions, filter.column+" = {"+filter.name+":String}")
			params["param_"+filter.name] = value
		}
	}
	dates := []struct{ query, op, name string }{
		{"start_date", ">=", "start"},
		{"end_date", "<=", "end"},
	}
	for _, filter := range dates {
		if raw := q.Get(filter.query); raw != "" {
			ts, ok := parseFilterTime(raw)
			if !ok {
				return "", fmt.Errorf("%s must be a valid datetime", filter.query)
			}
			conditions = append(conditions, "timestamp "+filter.op+" {"+filter.name+":String}")
			params["param_"+filter.name] = ts.Format("2006-01-02 15:04:05")
		}
	}
	if len(conditions) == 0 {
		return "1=1", nil
	}
	return strings.Join(conditions, " AND "), nil
}

// fetchRows runs the trail query; storage errors read as an empty trail,
// matching the query contract.
func (t *Trail) fetchRows(ctx context.Context, where string, params clickhouse.Settings, limitClause string) []map[string]any {
	sql := "SELECT " + trailColumns + " FROM audit_log WHERE " + where +
		" ORDER BY timestamp DESC " + limitClause + " FORMAT JSON"
	rows, err := t.CH.QueryJSON(ctx, sql, params)
	if err != nil {
		return []map[string]any{}
	}
	return rows
}

// trailNumber renders a ClickHouse float the way a JSON reader sees it:
// integral values stay integral.
func trailNumber(v any) json.Number {
	f, ok := v.(float64)
	if !ok {
		if s, ok := v.(string); ok {
			return json.Number(s)
		}
		return json.Number("0")
	}
	return json.Number(strconv.FormatFloat(f, 'g', -1, 64))
}

func trailString(row map[string]any, key string) string {
	s, _ := row[key].(string)
	return s
}

func trailInt(row map[string]any, key string) int {
	if f, ok := row[key].(float64); ok {
		return int(f)
	}
	return 0
}

// entryJSON is the audit trail wire shape, in contract field order.
type entryJSON struct {
	EventID      string      `json:"event_id"`
	Timestamp    string      `json:"timestamp"`
	ActorID      string      `json:"actor_id"`
	ActorEmail   string      `json:"actor_email"`
	ActorRole    string      `json:"actor_role"`
	Action       string      `json:"action"`
	ResourceType string      `json:"resource_type"`
	ResourceID   string      `json:"resource_id"`
	ResourceName string      `json:"resource_name"`
	HTTPMethod   string      `json:"http_method"`
	HTTPPath     string      `json:"http_path"`
	StatusCode   int         `json:"status_code"`
	IPAddress    string      `json:"ip_address"`
	UserAgent    string      `json:"user_agent"`
	Detail       string      `json:"detail"`
	Sensitivity  string      `json:"sensitivity"`
	RequestID    string      `json:"request_id"`
	Outcome      string      `json:"outcome"`
	DurationMS   json.Number `json:"duration_ms"`
	ChainHash    string      `json:"chain_hash"`
	Source       string      `json:"source"`
}

func toEntry(row map[string]any, duration json.Number) entryJSON {
	return entryJSON{
		EventID:      trailString(row, "event_id"),
		Timestamp:    trailString(row, "timestamp"),
		ActorID:      trailString(row, "actor_id"),
		ActorEmail:   trailString(row, "actor_email"),
		ActorRole:    trailString(row, "actor_role"),
		Action:       trailString(row, "action"),
		ResourceType: trailString(row, "resource_type"),
		ResourceID:   trailString(row, "resource_id"),
		ResourceName: trailString(row, "resource_name"),
		HTTPMethod:   trailString(row, "http_method"),
		HTTPPath:     trailString(row, "http_path"),
		StatusCode:   trailInt(row, "status_code"),
		IPAddress:    trailString(row, "ip_address"),
		UserAgent:    trailString(row, "user_agent"),
		Detail:       trailString(row, "detail"),
		Sensitivity:  trailString(row, "sensitivity"),
		RequestID:    trailString(row, "request_id"),
		Outcome:      trailString(row, "outcome"),
		DurationMS:   duration,
		ChainHash:    trailString(row, "chain_hash"),
		Source:       trailString(row, "source"),
	}
}

// asFloatNumber keeps integral values decimal ("0.0"), the float wire form.
func asFloatNumber(n json.Number) json.Number {
	if !strings.ContainsAny(string(n), ".eE") {
		return n + ".0"
	}
	return n
}

func (t *Trail) list(w http.ResponseWriter, r *http.Request) {
	params := clickhouse.Settings{}
	where, err := t.trailConditions(r, params)
	if err != nil {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	limit, ok := queryIntTrail(r, "limit", 50)
	if !ok || limit < 1 || limit > 500 {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "limit must be between 1 and 500")
		return
	}
	offset, ok := queryIntTrail(r, "offset", 0)
	if !ok || offset < 0 {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "offset must be non-negative")
		return
	}
	params["param_lim"] = strconv.Itoa(limit)
	params["param_off"] = strconv.Itoa(offset)

	rows := t.fetchRows(r.Context(), where, params, "LIMIT {lim:UInt32} OFFSET {off:UInt32}")
	entries := make([]entryJSON, 0, len(rows))
	for _, row := range rows {
		entries = append(entries, toEntry(row, asFloatNumber(trailNumber(row["duration_ms"]))))
	}
	httpapi.WriteJSON(w, http.StatusOK, entries)
}

func queryIntTrail(r *http.Request, name string, fallback int) (int, bool) {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return fallback, true
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, false
	}
	return value, true
}

// asciiEscape rewrites non-ASCII runes as \uXXXX escapes so exports read the
// same in any tooling.
func asciiEscape(data []byte) []byte {
	var out bytes.Buffer
	for _, r := range string(data) {
		switch {
		case r < 0x80:
			out.WriteRune(r)
		case r > 0xFFFF:
			r -= 0x10000
			fmt.Fprintf(&out, `\u%04x\u%04x`, 0xD800+(r>>10), 0xDC00+(r&0x3FF))
		default:
			fmt.Fprintf(&out, `\u%04x`, r)
		}
	}
	return out.Bytes()
}

func (t *Trail) export_(w http.ResponseWriter, r *http.Request) {
	params := clickhouse.Settings{}
	where, err := t.trailConditions(r, params)
	if err != nil {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	rows := t.fetchRows(r.Context(), where, params, "LIMIT 10000")

	now := time.Now
	if t.now != nil {
		now = t.now
	}
	stamp := now().UTC()

	if r.URL.Query().Get("format") == "json" {
		entries := make([]entryJSON, 0, len(rows))
		for _, row := range rows {
			entries = append(entries, toEntry(row, trailNumber(row["duration_ms"])))
		}
		exportedAt := stamp.Format("2006-01-02T15:04:05.999999")
		payload := struct {
			AuditTrail  []entryJSON `json:"audit_trail"`
			ExportedAt  string      `json:"exported_at"`
			RecordCount int         `json:"record_count"`
		}{entries, exportedAt, len(entries)}

		var buf bytes.Buffer
		encoder := json.NewEncoder(&buf)
		encoder.SetEscapeHTML(false)
		encoder.SetIndent("", "  ")
		if err := encoder.Encode(payload); err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Disposition",
			"attachment; filename=caracal_audit-log_"+stamp.Format("20060102T150405Z")+".json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(asciiEscape(bytes.TrimSuffix(buf.Bytes(), []byte("\n"))))
		return
	}

	var buf bytes.Buffer
	writer := csv.NewWriter(&buf)
	writer.UseCRLF = true
	_ = writer.Write(trailFieldnames)
	for _, row := range rows {
		record := make([]string, 0, len(trailFieldnames))
		for _, field := range trailFieldnames {
			switch field {
			case "status_code":
				record = append(record, strconv.Itoa(trailInt(row, field)))
			case "duration_ms":
				record = append(record, string(trailNumber(row[field])))
			default:
				record = append(record, trailString(row, field))
			}
		}
		_ = writer.Write(record)
	}
	writer.Flush()

	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition",
		"attachment; filename=caracal_audit-log_"+stamp.Format("20060102T150405Z")+".csv")
	w.WriteHeader(http.StatusOK)
	_, _ = buf.WriteTo(w)
}
