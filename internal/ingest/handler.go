// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package ingest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/tenancy"
)

const (
	maxShortString  = 512
	maxLineChars    = 1_048_576
	maxSessionLines = 1000
	maxTotalLines   = 10_000_000
	maxHashLength   = 128
	// maxBodyBytes bounds request size; the strict per-line and line-count
	// limits are enforced by validate after decoding.
	maxBodyBytes = 64 << 20
)

// Publisher notifies live subscribers about session activity.
type Publisher interface {
	Publish(ctx context.Context, channel string, payload map[string]string)
}

// ProjectResolver turns untrusted host/header scope into an authorized project ID.
type ProjectResolver interface {
	ResolveProjectID(ctx context.Context, r *http.Request, userID uuid.UUID) (string, error)
}

// Handler serves the session ingest routes.
type Handler struct {
	Service  *Service
	Publish  Publisher
	Projects ProjectResolver
}

func (h *Handler) projectID(w http.ResponseWriter, r *http.Request, userID uuid.UUID) (string, bool) {
	if h.Projects == nil {
		httpapi.WriteInternalError(w, r, errors.New("project resolver is not configured"))
		return "", false
	}
	projectID, err := h.Projects.ResolveProjectID(r.Context(), r, userID)
	if err == nil {
		return projectID, true
	}
	var scopeErr *tenancy.Error
	if errors.As(err, &scopeErr) {
		httpapi.WriteError(w, scopeErr.Status, scopeErr.Detail)
	} else {
		httpapi.WriteInternalError(w, r, err)
	}
	return "", false
}

// Routes returns the ingest route set, to be mounted behind authentication.
func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/ingest/session", h.ingestSession)
	mux.HandleFunc("GET /api/v1/ingest/session/checkpoint", h.sessionCheckpoint)
	return mux
}

type ingestRequest struct {
	SessionID       string   `json:"session_id"`
	Harness         string   `json:"harness"`
	AgentID         *string  `json:"agent_id"`
	AgentVersion    *string  `json:"agent_version"`
	LayerHash       *string  `json:"layer_hash"`
	Lines           []string `json:"lines"`
	StartOffset     int      `json:"start_offset"`
	EndByteOffsets  []int64  `json:"end_byte_offsets"`
	HookEvent       string   `json:"hook_event"`
	Final           bool     `json:"final"`
	TotalLineCount  *int     `json:"total_line_count"`
	TotalOffset     *int64   `json:"total_offset"`
	SessionHash     *string  `json:"session_hash"`
	HashedLineCount *int     `json:"hashed_line_count"`
	TotalCredits    *float64 `json:"total_credits"`
	ParentSessionID *string  `json:"parent_session_id"`
}

type ingestResponse struct {
	Ingested           int     `json:"ingested"`
	Skipped            int     `json:"skipped"`
	Errors             int     `json:"errors"`
	AcknowledgedLine   int     `json:"acknowledged_line"`
	AcknowledgedOffset int64   `json:"acknowledged_offset"`
	IntegrityOK        *bool   `json:"integrity_ok"`
	ServerHash         *string `json:"server_hash"`
	RepairFromLine     *int    `json:"repair_from_line"`
}

type checkpointResponse struct {
	SessionID          string `json:"session_id"`
	Harness            string `json:"harness"`
	AcknowledgedLine   int    `json:"acknowledged_line"`
	AcknowledgedOffset int64  `json:"acknowledged_offset"`
}

// validate enforces the request constraints; the message becomes a 422 detail.
func (r *ingestRequest) validate() error {
	if r.SessionID == "" {
		return fmt.Errorf("session_id is required")
	}
	for name, value := range map[string]string{
		"session_id": r.SessionID, "harness": r.Harness, "hook_event": r.HookEvent,
	} {
		if utf8.RuneCountInString(value) > maxShortString {
			return fmt.Errorf("%s must be at most %d characters", name, maxShortString)
		}
	}
	for name, value := range map[string]*string{
		"agent_id": r.AgentID, "agent_version": r.AgentVersion, "layer_hash": r.LayerHash,
		"parent_session_id": r.ParentSessionID,
	} {
		if value != nil && utf8.RuneCountInString(*value) > maxShortString {
			return fmt.Errorf("%s must be at most %d characters", name, maxShortString)
		}
	}
	if r.Lines == nil {
		return fmt.Errorf("lines is required")
	}
	if len(r.Lines) > maxSessionLines {
		return fmt.Errorf("lines must contain at most %d items", maxSessionLines)
	}
	for _, line := range r.Lines {
		if utf8.RuneCountInString(line) > maxLineChars {
			return fmt.Errorf("session lines must be at most %d characters", maxLineChars)
		}
	}
	if r.StartOffset < 0 {
		return fmt.Errorf("start_offset cannot be negative")
	}
	if r.EndByteOffsets != nil {
		if len(r.EndByteOffsets) != len(r.Lines) {
			return fmt.Errorf("end_byte_offsets must contain one value per source line")
		}
		for _, offset := range r.EndByteOffsets {
			if offset < 0 {
				return fmt.Errorf("end_byte_offsets cannot contain negative values")
			}
		}
		if !sort.SliceIsSorted(r.EndByteOffsets, func(i, j int) bool {
			return r.EndByteOffsets[i] < r.EndByteOffsets[j]
		}) {
			return fmt.Errorf("end_byte_offsets must be ordered")
		}
	}
	if r.TotalLineCount != nil && (*r.TotalLineCount < 0 || *r.TotalLineCount > maxTotalLines) {
		return fmt.Errorf("total_line_count must be between 0 and %d", maxTotalLines)
	}
	if r.TotalOffset != nil && *r.TotalOffset < 0 {
		return fmt.Errorf("total_offset cannot be negative")
	}
	if r.SessionHash != nil {
		if len(*r.SessionHash) > maxHashLength {
			return fmt.Errorf("session_hash must be at most %d characters", maxHashLength)
		}
		if r.HashedLineCount == nil {
			return fmt.Errorf("hashed_line_count is required with session_hash")
		}
	}
	if r.HashedLineCount != nil {
		if *r.HashedLineCount < 0 || *r.HashedLineCount > maxTotalLines {
			return fmt.Errorf("hashed_line_count must be between 0 and %d", maxTotalLines)
		}
		if r.TotalLineCount != nil && *r.HashedLineCount > *r.TotalLineCount {
			return fmt.Errorf("hashed_line_count cannot exceed total_line_count")
		}
	}
	if r.TotalCredits != nil && *r.TotalCredits < 0 {
		return fmt.Errorf("total_credits cannot be negative")
	}
	return nil
}

func (h *Handler) ingestSession(w http.ResponseWriter, r *http.Request) {
	claims, ok := httpapi.ClaimsFrom(r.Context())
	if !ok {
		httpapi.WriteError(w, http.StatusUnauthorized, "Missing credentials")
		return
	}
	projectID, ok := h.projectID(w, r, claims.UserID)
	if !ok {
		return
	}

	req := ingestRequest{Harness: "claude-code", HookEvent: "UserPromptSubmit"}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes)).Decode(&req); err != nil {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "invalid request body")
		return
	}
	if err := req.validate(); err != nil {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}

	key := SessionKey{
		SessionID: req.SessionID,
		ProjectID: projectID,
		UserID:    claims.UserID.String(),
		Harness:   req.Harness,
	}
	result, err := h.Service.IngestLines(r.Context(), LinesRequest{
		Key:             key,
		AgentID:         req.AgentID,
		AgentVersion:    req.AgentVersion,
		LayerHash:       req.LayerHash,
		ParentSessionID: req.ParentSessionID,
		Lines:           req.Lines,
		StartOffset:     req.StartOffset,
		EndByteOffsets:  req.EndByteOffsets,
		TotalCredits:    req.TotalCredits,
	})
	if err != nil {
		var conflict *RecordConflictError
		if errors.As(err, &conflict) {
			httpapi.WriteJSON(w, http.StatusConflict, map[string]any{
				"detail": map[string]any{
					"message": "session source changed at an acknowledged line",
					"offsets": conflict.Offsets,
				},
			})
			return
		}
		httpapi.WriteError(w, http.StatusServiceUnavailable, "session storage unavailable - please retry")
		return
	}

	ackLine, ackOffset, err := h.Service.AdvanceCheckpoint(r.Context(), key)
	if err != nil {
		httpapi.WriteError(w, http.StatusServiceUnavailable, "session storage unavailable - please retry")
		return
	}

	resp := ingestResponse{
		Ingested:           result.Ingested,
		Skipped:            result.Skipped,
		Errors:             result.Errors,
		AcknowledgedLine:   ackLine,
		AcknowledgedOffset: ackOffset,
	}

	if req.Final && req.TotalLineCount != nil {
		var totalOffset int64
		if req.TotalOffset != nil {
			totalOffset = *req.TotalOffset
		}
		integrity, err := h.Service.CheckIntegrity(r.Context(), key, IntegrityParams{
			ExpectedLineCount:  *req.TotalLineCount,
			ExpectedOffset:     totalOffset,
			AcknowledgedLine:   ackLine,
			AcknowledgedOffset: ackOffset,
			ExpectedHash:       req.SessionHash,
			HashedLineCount:    req.HashedLineCount,
		})
		if err != nil {
			httpapi.WriteError(w, http.StatusServiceUnavailable, "session storage unavailable - please retry")
			return
		}
		resp.IntegrityOK = &integrity.OK
		resp.ServerHash = integrity.ServerHash
		resp.RepairFromLine = integrity.RepairFromLine
		if integrity.RepairFromLine != nil {
			// Rewind the durable checkpoint so the sender replays from the gap.
			resp.AcknowledgedLine = *integrity.RepairFromLine - 1
			resp.AcknowledgedOffset = integrity.RepairOffset
			if err := h.Service.Store.InsertCheckpoint(
				r.Context(), key, resp.AcknowledgedLine, resp.AcknowledgedOffset,
			); err != nil {
				httpapi.WriteError(w, http.StatusServiceUnavailable, "session storage unavailable - please retry")
				return
			}
		}
	}

	// Live viewers get an instant nudge; a slow bus never blocks the sender.
	if result.Ingested > 0 && h.Publish != nil {
		payload := map[string]string{"session_id": req.SessionID, "event_name": "session_push"}
		go h.Publish.Publish(context.WithoutCancel(r.Context()), "sessions:"+projectID+":"+req.SessionID+":updated", payload)
		go h.Publish.Publish(context.WithoutCancel(r.Context()), "sessions:"+projectID+":updated", payload)
	}

	httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) sessionCheckpoint(w http.ResponseWriter, r *http.Request) {
	claims, ok := httpapi.ClaimsFrom(r.Context())
	if !ok {
		httpapi.WriteError(w, http.StatusUnauthorized, "Missing credentials")
		return
	}
	projectID, ok := h.projectID(w, r, claims.UserID)
	if !ok {
		return
	}
	sessionID := r.URL.Query().Get("session_id")
	harnessName := r.URL.Query().Get("harness")
	if sessionID == "" || harnessName == "" {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "session_id and harness are required")
		return
	}
	if utf8.RuneCountInString(sessionID) > maxShortString || utf8.RuneCountInString(harnessName) > maxShortString {
		httpapi.WriteError(w, http.StatusUnprocessableEntity,
			fmt.Sprintf("query parameters must be at most %d characters", maxShortString))
		return
	}

	key := SessionKey{
		SessionID: sessionID,
		ProjectID: projectID,
		UserID:    claims.UserID.String(),
		Harness:   harnessName,
	}
	line, offset, err := h.Service.Store.Checkpoint(r.Context(), key)
	if err != nil {
		httpapi.WriteError(w, http.StatusServiceUnavailable, "session storage unavailable - please retry")
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, checkpointResponse{
		SessionID:          sessionID,
		Harness:            harnessName,
		AcknowledgedLine:   line,
		AcknowledgedOffset: offset,
	})
}
