// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package adminops

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/httpapi"
)

// Register mounts the operator routes. registered-agents-only reads are open
// to every signed-in user; everything else is deployment-operator scoped.
func (h *Handler) Register(mux *http.ServeMux, withOperator, withUser func(http.Handler) http.Handler) {
	mux.Handle("GET /api/v1/operator/status", withOperator(http.HandlerFunc(h.systemStatus)))
	mux.Handle("POST /api/v1/operator/resources/apply", withOperator(http.HandlerFunc(h.applyResources)))
	mux.Handle("GET /api/v1/operator/ai-engine/models/providers", withOperator(http.HandlerFunc(h.insightsModelProviders)))
	mux.Handle("GET /api/v1/operator/ai-engine/models", withOperator(http.HandlerFunc(h.insightsModels)))
	mux.Handle("POST /api/v1/operator/ai-engine/test-connection", withOperator(http.HandlerFunc(h.testInsightsConnection)))
	mux.Handle("GET /api/v1/operator/security-events", withOperator(http.HandlerFunc(h.securityEvents)))
	mux.Handle("GET /api/v1/operator/trace-privacy", withOperator(http.HandlerFunc(h.getTracePrivacy)))
	mux.Handle("PUT /api/v1/operator/trace-privacy", withOperator(http.HandlerFunc(h.setTracePrivacy)))
	mux.Handle("GET /api/v1/operator/registered-agents-only", withUser(http.HandlerFunc(h.getRegisteredAgentsOnly)))
	mux.Handle("PUT /api/v1/operator/registered-agents-only", withOperator(http.HandlerFunc(h.setRegisteredAgentsOnly)))
	mux.Handle("POST /api/v1/operator/cache/clear", withOperator(http.HandlerFunc(h.clearCache)))
	mux.Handle("GET /api/v1/operator/restart/status", withOperator(http.HandlerFunc(h.restartStatus)))
	mux.Handle("POST /api/v1/operator/restart", withOperator(http.HandlerFunc(h.restartService)))
	mux.Handle("GET /api/v1/operator/settings", withOperator(http.HandlerFunc(h.listSettings)))
	mux.Handle("GET /api/v1/operator/settings/schema", withOperator(http.HandlerFunc(h.settingsSchema)))
	mux.Handle("GET /api/v1/operator/settings/{key}", withOperator(http.HandlerFunc(h.getSetting)))
	mux.Handle("PUT /api/v1/operator/settings/{key}", withOperator(http.HandlerFunc(h.upsertSetting)))
	mux.Handle("DELETE /api/v1/operator/settings/{key}", withOperator(http.HandlerFunc(h.deleteSetting)))
	mux.Handle("POST /api/v1/operator/settings/{key}/revoke", withOperator(http.HandlerFunc(h.revokeSetting)))
	mux.Handle("POST /api/v1/operator/settings/danger/purge-traces-insights", withOperator(http.HandlerFunc(h.dangerPurge)))
	mux.Handle("GET /api/v1/operator/system-warnings", withOperator(http.HandlerFunc(h.systemWarnings)))
}

// userFilterValues resolves a free-text actor filter into ids and emails
// using the same trigram ranking as the user search endpoint.
func (h *Handler) userFilterValues(r *http.Request, query string) (ids, emails []string, err error) {
	q := strings.ToLower(strings.TrimSpace(query))
	q = strings.Join(strings.Fields(q), " ")
	if parsed, perr := uuid.Parse(q); perr == nil {
		ids = append(ids, parsed.String())
	}
	if strings.Contains(q, "@") && !strings.HasPrefix(q, "@") {
		emails = append(emails, q)
	}
	sq := strings.TrimPrefix(q, "@")
	if len(sq) >= 2 {
		escaped := escapeLike(sq)
		prefix := escaped + "%"
		contains := "%" + escaped + "%"
		rows, qerr := h.DB.Query(r.Context(), `
			WITH scored AS (
			  SELECT id, email, name,
			    (CASE WHEN lower(coalesce(username, '')) = $1 THEN 100 ELSE 0 END
			     + CASE WHEN lower(email) = $1 THEN 98 ELSE 0 END
			     + CASE WHEN lower(name) = $1 THEN 96 ELSE 0 END
			     + CASE WHEN username ILIKE $2 ESCAPE '\' THEN 30 ELSE 0 END
			     + CASE WHEN email ILIKE $2 ESCAPE '\' THEN 28 ELSE 0 END
			     + CASE WHEN name ILIKE $2 ESCAPE '\' THEN 26 ELSE 0 END
			     + CASE WHEN name ILIKE $3 ESCAPE '\' THEN 10 ELSE 0 END
			     + greatest(similarity(lower(name), $1), similarity(lower(email), $1),
			                similarity(lower(coalesce(username, '')), $1)) * 74) AS score
			  FROM users
			  WHERE username ILIKE $2 ESCAPE '\' OR email ILIKE $2 ESCAPE '\'
			     OR name ILIKE $3 ESCAPE '\'
			     OR username % $1 OR email % $1 OR name % $1
			     OR greatest(similarity(lower(name), $1), similarity(lower(email), $1),
			                 similarity(lower(coalesce(username, '')), $1)) >= 0.18
			)
			SELECT id, email FROM scored ORDER BY score DESC, name, email LIMIT 25`,
			sq, prefix, contains)
		if qerr != nil {
			return nil, nil, qerr
		}
		defer rows.Close()
		for rows.Next() {
			var id uuid.UUID
			var email string
			if serr := rows.Scan(&id, &email); serr != nil {
				return nil, nil, serr
			}
			ids = append(ids, id.String())
			emails = append(emails, email)
		}
		if rows.Err() != nil {
			return nil, nil, rows.Err()
		}
	}
	return dedupe(ids), dedupe(emails), nil
}

func escapeLike(v string) string {
	v = strings.ReplaceAll(v, `\`, `\\`)
	v = strings.ReplaceAll(v, "%", `\%`)
	return strings.ReplaceAll(v, "_", `\_`)
}

func dedupe(values []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, v := range values {
		if v != "" && !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

func chInCondition(column string, values []string, prefix string, params clickhouse.Settings) string {
	if len(values) == 0 {
		return ""
	}
	placeholders := make([]string, len(values))
	for i, v := range values {
		name := fmt.Sprintf("%s_%d", prefix, i)
		placeholders[i] = fmt.Sprintf("{%s:String}", name)
		params["param_"+name] = v
	}
	return column + " IN (" + strings.Join(placeholders, ", ") + ")"
}

func intQuery(w http.ResponseWriter, r *http.Request, name string, fallback int) (int, bool) {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return fallback, true
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		httpapi.WriteJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": []map[string]any{{
			"type": "int_parsing", "loc": []string{"query", name},
			"msg":   "Input should be a valid integer, unable to parse string as an integer",
			"input": raw,
		}}})
		return 0, false
	}
	return n, true
}

// securityEvents queries the deployment security event log.
func (h *Handler) securityEvents(w http.ResponseWriter, r *http.Request) {
	limit, ok := intQuery(w, r, "limit", 100)
	if !ok {
		return
	}
	offset, ok := intQuery(w, r, "offset", 0)
	if !ok {
		return
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 1000 {
		limit = 1000
	}
	if offset < 0 {
		offset = 0
	}
	conditions := []string{"1 = 1"}
	params := clickhouse.Settings{}
	if et := r.URL.Query().Get("event_type"); et != "" {
		conditions = append(conditions, "event_type = {et:String}")
		params["param_et"] = et
	}
	if sev := r.URL.Query().Get("severity"); sev != "" {
		conditions = append(conditions, "severity = {sev:String}")
		params["param_sev"] = sev
	}
	if actor := r.URL.Query().Get("actor_email"); actor != "" {
		ids, emails, err := h.userFilterValues(r, actor)
		if err != nil {
			internalErr(w)
			return
		}
		actorConds := []string{}
		if c := chInCondition("actor_id", ids, "actor_id", params); c != "" {
			actorConds = append(actorConds, c)
		}
		if c := chInCondition("actor_email", emails, "actor_email", params); c != "" {
			actorConds = append(actorConds, c)
		}
		if len(actorConds) > 0 {
			conditions = append(conditions, "("+strings.Join(actorConds, " OR ")+")")
		} else {
			conditions = append(conditions, "actor_email = {ae:String}")
			params["param_ae"] = actor
		}
	}
	sql := fmt.Sprintf(
		"SELECT * FROM security_events WHERE %s ORDER BY timestamp DESC LIMIT %d OFFSET %d FORMAT JSON",
		strings.Join(conditions, " AND "), limit, offset)
	rows, err := h.CH.QueryJSON(r.Context(), sql, params)
	if err != nil {
		internalErr(w)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{"events": rows, "total": len(rows)})
}

// boolSetting reads a policy toggle with its registry default.
func (h *Handler) boolSetting(r *http.Request, key string) bool {
	fallback := false
	if def, ok := defaultFor(key); ok {
		if s, isStr := def.(string); isStr {
			fallback = strings.EqualFold(s, "true")
		}
	}
	return h.Settings.Bool(r.Context(), key, fallback)
}

// setBoolSetting persists a policy toggle and invalidates readers.
func (h *Handler) setBoolSetting(r *http.Request, key string, value bool) error {
	stored := "false"
	if value {
		stored = "true"
	}
	if _, err := h.DB.Exec(r.Context(),
		`INSERT INTO enterprise_config (id, key, value, updated_at) VALUES (gen_random_uuid(), $1, $2, now())
		 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, key, stored); err != nil {
		return err
	}
	h.invalidateSetting(r.Context(), key)
	return nil
}

// truthy mirrors dynamic-typed request bodies: any non-empty value enables.
func truthy(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case string:
		return t != ""
	case float64:
		return t != 0
	case nil:
		return false
	case []any:
		return len(t) > 0
	case map[string]any:
		return len(t) > 0
	default:
		return true
	}
}

func decodeAnyBody(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpapi.WriteJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": []map[string]any{{
			"type": "missing", "loc": []string{"body"}, "msg": "Field required", "input": nil,
		}}})
		return nil, false
	}
	return body, true
}

func (h *Handler) getTracePrivacy(w http.ResponseWriter, r *http.Request) {
	httpapi.WriteJSON(w, http.StatusOK, map[string]bool{"trace_privacy": h.boolSetting(r, "security.trace_privacy")})
}

func (h *Handler) setTracePrivacy(w http.ResponseWriter, r *http.Request) {
	a, ok := h.caller(w, r)
	if !ok {
		return
	}
	body, ok := decodeAnyBody(w, r)
	if !ok {
		return
	}
	enabled := truthy(body["trace_privacy"])
	if err := h.setBoolSetting(r, "security.trace_privacy", enabled); err != nil {
		internalErr(w)
		return
	}
	detail := "Trace privacy disabled"
	if enabled {
		detail = "Trace privacy enabled"
	}
	h.emitEvent(r.Context(), a, "admin.setting.changed", "warning", "security.trace_privacy", "setting", detail)
	httpapi.WriteJSON(w, http.StatusOK, map[string]bool{"trace_privacy": enabled})
}

func (h *Handler) getRegisteredAgentsOnly(w http.ResponseWriter, r *http.Request) {
	httpapi.WriteJSON(w, http.StatusOK, map[string]bool{
		"registered_agents_only": h.boolSetting(r, "registry.registered_agents_only")})
}

func (h *Handler) setRegisteredAgentsOnly(w http.ResponseWriter, r *http.Request) {
	a, ok := h.caller(w, r)
	if !ok {
		return
	}
	body, ok := decodeAnyBody(w, r)
	if !ok {
		return
	}
	enabled := truthy(body["registered_agents_only"])
	if err := h.setBoolSetting(r, "registry.registered_agents_only", enabled); err != nil {
		internalErr(w)
		return
	}
	detail := "Registered-agents-only disabled"
	if enabled {
		detail = "Registered-agents-only enabled"
	}
	h.emitEvent(r.Context(), a, "admin.setting.changed", "warning", "registry.registered_agents_only", "setting", detail)
	httpapi.WriteJSON(w, http.StatusOK, map[string]bool{"registered_agents_only": enabled})
}

// clearCache deletes every cached dashboard and OTEL response.
func (h *Handler) clearCache(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.caller(w, r); !ok {
		return
	}
	deleted := 0
	if h.Redis != nil {
		var cursor uint64
		for {
			keys, next, err := h.Redis.Scan(r.Context(), cursor, "caracal-cache:*", 500).Result()
			if err != nil {
				internalErr(w)
				return
			}
			if len(keys) > 0 {
				if err := h.Redis.Del(r.Context(), keys...).Err(); err != nil {
					internalErr(w)
					return
				}
				deleted += len(keys)
			}
			cursor = next
			if cursor == 0 {
				break
			}
		}
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]int{"cleared": deleted})
}
