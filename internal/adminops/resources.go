// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package adminops

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/garudex-labs/caracal/internal/httpapi"
)

// resourceSettingsMap maps enterprise_config keys to ClickHouse query
// settings. Only whitelisted settings are accepted to avoid SQL injection.
var resourceSettingsMap = []struct {
	configKey string
	chSetting string
}{
	{"resource.max_query_memory_mb", "max_memory_usage"},
	{"resource.group_by_spill_mb", "max_bytes_before_external_group_by"},
	{"resource.sort_spill_mb", "max_bytes_before_external_sort"},
	{"resource.join_memory_mb", "max_bytes_in_join"},
}

// resourceOverrides converts stored megabyte values into the ClickHouse
// byte-valued settings they govern, skipping invalid or non-positive rows.
func resourceOverrides(values map[string]string) map[string]string {
	overrides := map[string]string{}
	for _, entry := range resourceSettingsMap {
		raw, ok := values[entry.configKey]
		if !ok {
			continue
		}
		mb, err := strconv.Atoi(strings.TrimSpace(raw))
		if err != nil || mb <= 0 {
			continue
		}
		overrides[entry.chSetting] = strconv.Itoa(mb * 1_000_000)
	}
	return overrides
}

func isResourceSetting(key string) bool {
	for _, entry := range resourceSettingsMap {
		if entry.configKey == key {
			return true
		}
	}
	return false
}

// orderedPairs marshals as a JSON object preserving insertion order.
type orderedPairs []struct{ Key, Value string }

func (p orderedPairs) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, pair := range p {
		if i > 0 {
			buf.WriteByte(',')
		}
		k, err := json.Marshal(pair.Key)
		if err != nil {
			return nil, err
		}
		v, err := json.Marshal(pair.Value)
		if err != nil {
			return nil, err
		}
		buf.Write(k)
		buf.WriteByte(':')
		buf.Write(v)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// appliedKeysDetail renders the audit detail as a bracketed, quoted key list.
func appliedKeysDetail(keys []string) string {
	quoted := make([]string, len(keys))
	for i, k := range keys {
		quoted[i] = "'" + k + "'"
	}
	return "Applied resource settings: [" + strings.Join(quoted, ", ") + "]"
}

// applyResources re-applies resource tuning settings to ClickHouse without
// restart.
func (h *Handler) applyResources(w http.ResponseWriter, r *http.Request) {
	a, ok := h.caller(w, r)
	if !ok {
		return
	}
	rows, err := h.DB.Query(r.Context(),
		`SELECT key, value FROM enterprise_config WHERE key LIKE 'resource.%'`)
	if err != nil {
		internalErr(w)
		return
	}
	defer rows.Close()
	var keys []string
	values := map[string]string{}
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			internalErr(w)
			return
		}
		keys = append(keys, key)
		values[key] = value
	}
	if rows.Err() != nil {
		internalErr(w)
		return
	}

	h.CH.SetQueryOverrides(resourceOverrides(values))

	h.emitEvent(r.Context(), a, "admin.setting.changed", "warning",
		"resource_settings", "setting", appliedKeysDetail(keys))

	applied := orderedPairs{}
	for _, key := range keys {
		if isResourceSetting(key) {
			applied = append(applied, struct{ Key, Value string }{key, values[key]})
		}
	}
	httpapi.WriteJSON(w, http.StatusOK, struct {
		Applied orderedPairs `json:"applied"`
		Message string       `json:"message"`
	}{applied, "ClickHouse resource settings applied"})
}
