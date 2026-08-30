// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package audit

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/httpapi"
)

// CLIEvents serves the CLI audit event ingestion route. CLI events carry
// client-supplied identifiers and timestamps, so they are stored outside
// the server's hash chain.
type CLIEvents struct {
	CH *clickhouse.Client
}

// Routes returns the audit ingestion route group.
func (h *CLIEvents) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/audit/cli-event", h.receive)
	return mux
}

type cliEventBody struct {
	EventID      string  `json:"event_id"`
	Timestamp    string  `json:"timestamp"`
	Action       *string `json:"action"`
	ResourceType string  `json:"resource_type"`
	ResourceID   string  `json:"resource_id"`
	ResourceName string  `json:"resource_name"`
	Detail       string  `json:"detail"`
	Sensitivity  string  `json:"sensitivity"`
}

func truncRunes(s string, limit int) string {
	runes := []rune(s)
	if len(runes) > limit {
		return string(runes[:limit])
	}
	return s
}

func (h *CLIEvents) receive(w http.ResponseWriter, r *http.Request) {
	claims, _ := httpapi.ClaimsFrom(r.Context())
	body := cliEventBody{Sensitivity: "standard"}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	if body.Action == nil {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "action is required")
		return
	}
	if body.EventID == "" {
		body.EventID = uuid.NewString()
	}
	if body.Timestamp == "" {
		body.Timestamp = time.Now().UTC().Format("2006-01-02 15:04:05.000")
	}

	record := Record{
		EventID:      body.EventID,
		Timestamp:    body.Timestamp,
		ActorID:      claims.UserID.String(),
		ActorEmail:   claims.Email,
		ActorRole:    claims.Role,
		Action:       *body.Action,
		ResourceType: body.ResourceType,
		ResourceID:   body.ResourceID,
		ResourceName: body.ResourceName,
		HTTPMethod:   http.MethodPost,
		HTTPPath:     "/api/v1/audit/cli-event",
		StatusCode:   http.StatusOK,
		IPAddress:    clientIP(r),
		UserAgent:    truncRunes(r.Header.Get("User-Agent"), 256),
		Detail:       body.Detail,
		Sensitivity:  body.Sensitivity,
		RequestID:    w.Header().Get("X-Request-ID"),
		Outcome:      "success",
		Source:       "cli",
	}
	// Storage is best-effort: a trail gap must never fail the CLI operation.
	if err := h.CH.InsertJSONEachRow(r.Context(), insertSQL, []any{record}); err != nil {
		slog.Error("cli audit event insert failed - audit trail has a gap", "error", err)
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
