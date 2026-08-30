// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package adminops

import (
	"encoding/json"
	"net/http"
	"os"
	"sync"
	"syscall"
	"time"

	"github.com/garudex-labs/caracal/internal/httpapi"
)

// restartDelay lets the 202 response flush before the process goes down.
const restartDelay = time.Second

var restartOnce sync.Once

// restartStatus reports whether saved settings require a service restart.
func (h *Handler) restartStatus(w http.ResponseWriter, r *http.Request) {
	var raw *string
	err := h.DB.QueryRow(r.Context(),
		`SELECT value FROM enterprise_config WHERE key = $1`, restartPendingKey).Scan(&raw)
	if err != nil || raw == nil || *raw == "" {
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"required": false, "changed_at": nil, "keys": []any{},
		})
		return
	}
	var state map[string]any
	if json.Unmarshal([]byte(*raw), &state) != nil {
		state = map[string]any{}
	}
	keys, ok := state["keys"].([]any)
	if !ok {
		keys = []any{}
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"required": true, "changed_at": state["changed_at"], "keys": keys,
	})
}

// restartService schedules a graceful self-restart: the container restart
// policy revives the process, which rebuilds startup-bound clients and
// clears the pending flag.
func (h *Handler) restartService(w http.ResponseWriter, r *http.Request) {
	a, ok := h.caller(w, r)
	if !ok {
		return
	}
	h.emitEvent(r.Context(), a, "admin.setting.changed", "critical",
		"api_process", "system", "API restart initiated from admin UI")
	_, _ = h.DB.Exec(r.Context(),
		`DELETE FROM enterprise_config WHERE key = $1`, restartPendingKey)
	restartOnce.Do(func() {
		time.AfterFunc(restartDelay, func() {
			pid := os.Getpid()
			if os.Getppid() == 1 || pid == 1 {
				pid = 1
			}
			_ = syscall.Kill(pid, syscall.SIGTERM)
		})
	})
	httpapi.WriteJSON(w, http.StatusAccepted, map[string]any{
		"detail":        "API restart scheduled",
		"delay_seconds": restartDelay.Seconds(),
	})
}
