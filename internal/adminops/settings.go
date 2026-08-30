// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package adminops

import (
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/garudex-labs/caracal/internal/fernet"
	"github.com/garudex-labs/caracal/internal/httpapi"
)

const encPrefix = "enc:"

var errNotFound = errors.New("not found")

type settingResponse struct {
	Key                 string `json:"key"`
	Value               string `json:"value"`
	IsSensitive         bool   `json:"is_sensitive"`
	IsSet               bool   `json:"is_set"`
	IsExternallyManaged bool   `json:"is_externally_managed"`
}

func (h *Handler) settingsSchema(w http.ResponseWriter, r *http.Request) {
	httpapi.WriteJSON(w, http.StatusOK, h.schema())
}

// effectiveValue resolves what a read should show for an externally managed key.
func (h *Handler) externalValue(key string) string {
	if v, ok := h.external[key]; ok {
		return v
	}
	if def, ok := defaultFor(key); ok {
		if s, ok := def.(string); ok {
			return s
		}
	}
	return ""
}

func wireSetting(key, storedValue, externalValue string, sensitive, hasValue, external bool) settingResponse {
	value := storedValue
	if external {
		value = externalValue
	}
	display := value
	if sensitive {
		display = ""
		if hasValue {
			display = Redacted
		}
	}
	return settingResponse{Key: key, Value: display, IsSensitive: sensitive,
		IsSet: hasValue, IsExternallyManaged: external}
}

func (h *Handler) listSettings(w http.ResponseWriter, r *http.Request) {
	rows, err := h.DB.Query(r.Context(), `SELECT key, value FROM enterprise_config ORDER BY key`)
	if err != nil {
		internalErr(w)
		return
	}
	defer rows.Close()
	out := []settingResponse{}
	seen := map[string]bool{}
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			internalErr(w)
			return
		}
		if key == restartPendingKey {
			continue
		}
		seen[key] = true
		sensitive := sensitiveKeys[key]
		external := h.isExternallyManaged(key)
		hasValue := external || value != ""
		out = append(out, wireSetting(key, value, h.externalValue(key), sensitive, hasValue, external))
	}
	if rows.Err() != nil {
		internalErr(w)
		return
	}
	extras := []string{}
	for key := range h.external {
		if !seen[key] {
			extras = append(extras, key)
		}
	}
	sort.Strings(extras)
	for _, key := range extras {
		if _, ok := defaultFor(key); !ok {
			continue
		}
		sensitive := sensitiveKeys[key]
		out = append(out, wireSetting(key, "", h.externalValue(key), sensitive, true, true))
	}
	httpapi.WriteJSON(w, http.StatusOK, out)
}

// loadSetting reads one enterprise_config row; errNotFound when absent.
func (h *Handler) loadSetting(r *http.Request, key string) (string, error) {
	var value string
	err := h.DB.QueryRow(r.Context(), `SELECT value FROM enterprise_config WHERE key = $1`, key).Scan(&value)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", errNotFound
	}
	return value, err
}

func (h *Handler) getSetting(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")
	external := h.isExternallyManaged(key)
	value, err := h.loadSetting(r, key)
	missing := errors.Is(err, errNotFound)
	if err != nil && !missing {
		internalErr(w)
		return
	}
	if missing && !external {
		httpapi.WriteError(w, http.StatusNotFound, "Setting not found")
		return
	}
	sensitive := sensitiveKeys[key]
	hasValue := external || (!missing && value != "")
	httpapi.WriteJSON(w, http.StatusOK, wireSetting(key, value, h.externalValue(key), sensitive, hasValue, external))
}

func (h *Handler) upsertSetting(w http.ResponseWriter, r *http.Request) {
	a, ok := h.caller(w, r)
	if !ok {
		return
	}
	key := r.PathValue("key")
	if h.isExternallyManaged(key) {
		httpapi.WriteError(w, http.StatusConflict, "Setting is externally managed by a secret file")
		return
	}
	var req struct {
		Value *string `json:"value"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Value == nil {
		httpapi.WriteJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": []map[string]any{{
			"type": "missing", "loc": []string{"body", "value"}, "msg": "Field required", "input": map[string]any{},
		}}})
		return
	}
	// Wrapping whitespace from copy-paste silently breaks downstream
	// consumers, so values are normalized on write.
	value := strings.TrimSpace(*req.Value)

	switch key {
	case "branding.logo", "branding.wordmark":
		if detail, bad := validateBrandingLogo(value); bad {
			httpapi.WriteError(w, http.StatusUnprocessableEntity, detail)
			return
		}
	case "branding.app_name":
		if detail, bad := validateBrandingAppName(value); bad {
			httpapi.WriteError(w, http.StatusUnprocessableEntity, detail)
			return
		}
	}

	sensitive := sensitiveKeys[key]
	storeValue := value
	if sensitive {
		encrypted, err := fernet.Encrypt(h.SecretKey, []byte(value))
		if err != nil {
			internalErr(w)
			return
		}
		storeValue = encPrefix + encrypted
	}
	current, err := h.loadSetting(r, key)
	missing := errors.Is(err, errNotFound)
	if err != nil && !missing {
		internalErr(w)
		return
	}
	changed := missing || current != storeValue
	if _, err := h.DB.Exec(r.Context(),
		`INSERT INTO enterprise_config (id, key, value, updated_at) VALUES (gen_random_uuid(), $1, $2, now())
		 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, key, storeValue); err != nil {
		internalErr(w)
		return
	}
	if changed && restartRequiredKeys[key] {
		if err := h.markRestartPending(r, key); err != nil {
			internalErr(w)
			return
		}
	}
	h.invalidateSetting(r.Context(), key)

	// A configured direct API key retires the deprecated provider settings.
	if key == "insights.api_key" && value != "" {
		deprecated := []string{"insights.aws_region", "insights.aws_access_key_id",
			"insights.aws_secret_access_key", "insights.aws_session_token",
			"insights.model_url", "insights.model_api_key"}
		if _, err := h.DB.Exec(r.Context(),
			`DELETE FROM enterprise_config WHERE key = ANY($1)`, deprecated); err != nil {
			internalErr(w)
			return
		}
		for _, dk := range deprecated {
			h.invalidateSetting(r.Context(), dk)
		}
	}

	h.emitEvent(r.Context(), a, "admin.setting.changed", "warning", key, "setting", nil)
	display := storeValue
	if sensitive {
		display = Redacted
	}
	httpapi.WriteJSON(w, http.StatusOK, settingResponse{Key: key, Value: display,
		IsSensitive: sensitive, IsSet: true, IsExternallyManaged: false})
}

// markRestartPending records which restart-required keys changed.
func (h *Handler) markRestartPending(r *http.Request, key string) error {
	current, err := h.loadSetting(r, restartPendingKey)
	keys := map[string]bool{}
	if err == nil {
		var state struct {
			Keys []string `json:"keys"`
		}
		if json.Unmarshal([]byte(current), &state) == nil {
			for _, k := range state.Keys {
				keys[k] = true
			}
		}
	} else if !errors.Is(err, errNotFound) {
		return err
	}
	keys[key] = true
	sorted := make([]string, 0, len(keys))
	for k := range keys {
		sorted = append(sorted, k)
	}
	sort.Strings(sorted)
	payload, _ := json.Marshal(map[string]any{
		"changed_at": nowISO(), "keys": sorted,
	})
	_, err = h.DB.Exec(r.Context(),
		`INSERT INTO enterprise_config (id, key, value, updated_at) VALUES (gen_random_uuid(), $1, $2, now())
		 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
		restartPendingKey, string(payload))
	return err
}

func (h *Handler) deleteSetting(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.caller(w, r); !ok {
		return
	}
	key := r.PathValue("key")
	if h.isExternallyManaged(key) {
		httpapi.WriteError(w, http.StatusConflict, "Setting is externally managed by a secret file")
		return
	}
	tag, err := h.DB.Exec(r.Context(), `DELETE FROM enterprise_config WHERE key = $1`, key)
	if err != nil {
		internalErr(w)
		return
	}
	if tag.RowsAffected() == 0 {
		httpapi.WriteError(w, http.StatusNotFound, "Setting not found")
		return
	}
	if restartRequiredKeys[key] {
		if err := h.markRestartPending(r, key); err != nil {
			internalErr(w)
			return
		}
	}
	h.invalidateSetting(r.Context(), key)
	httpapi.WriteJSON(w, http.StatusOK, map[string]string{"deleted": key})
}

func (h *Handler) revokeSetting(w http.ResponseWriter, r *http.Request) {
	a, ok := h.caller(w, r)
	if !ok {
		return
	}
	key := r.PathValue("key")
	if !sensitiveKeys[key] {
		httpapi.WriteError(w, http.StatusBadRequest, "Only sensitive keys can be revoked")
		return
	}
	if h.isExternallyManaged(key) {
		httpapi.WriteError(w, http.StatusConflict, "Setting is externally managed by a secret file")
		return
	}
	tag, err := h.DB.Exec(r.Context(), `DELETE FROM enterprise_config WHERE key = $1`, key)
	if err != nil {
		internalErr(w)
		return
	}
	if tag.RowsAffected() == 0 {
		httpapi.WriteError(w, http.StatusNotFound, "Setting not found or already revoked")
		return
	}
	if restartRequiredKeys[key] {
		if err := h.markRestartPending(r, key); err != nil {
			internalErr(w)
			return
		}
	}
	h.invalidateSetting(r.Context(), key)
	h.emitEvent(r.Context(), a, "admin.setting.changed", "critical", key, "sensitive_setting",
		"Sensitive setting revoked: "+key)
	httpapi.WriteJSON(w, http.StatusOK, map[string]string{
		"revoked": key, "message": "Secret has been permanently deleted"})
}

// systemWarnings surfaces actionable security posture problems.
func (h *Handler) systemWarnings(w http.ResponseWriter, r *http.Request) {
	warnings := []map[string]any{}
	weak := map[string]bool{"change-me-to-a-random-string": true, "changeme": true, "secret": true, "dev": true, "": true}
	if weak[h.RawSecret] || len(h.RawSecret) < 32 {
		warnings = append(warnings, map[string]any{
			"level": "critical", "code": "weak_secret_key",
			"message": "SECRET_KEY is insecure. Set a random string of at least 32 characters.",
		})
	}
	httpapi.WriteJSON(w, http.StatusOK, warnings)
}
