// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package logring

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/garudex-labs/caracal/internal/httpapi"
)

const (
	backfillLimit     = 50
	pollInterval      = 300 * time.Millisecond
	keepaliveInterval = 15 * time.Second
)

// Handler serves the admin log window and its live stream.
type Handler struct {
	Ring *Ring
}

// Routes mounts the group; run it behind required admin authentication.
func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/operator/logs", h.recent)
	mux.HandleFunc("GET /api/v1/operator/logs/stream", h.stream)
	return mux
}

func (h *Handler) recent(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	minRank := rank(q.Get("level"))
	if q.Get("level") == "" {
		minRank = rank("INFO")
	}
	filter := q.Get("filter")
	limit := 200
	if raw := q.Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 2000 {
			httpapi.WriteJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": []map[string]any{{
				"type": "int_parsing", "loc": []string{"query", "limit"},
				"msg": "Input should be a valid integer between 1 and 2000", "input": raw,
			}}})
			return
		}
		limit = n
	}
	entries := h.Ring.Snapshot()
	matched := []Entry{}
	for i := len(entries) - 1; i >= 0 && len(matched) < limit; i-- {
		if matches(entries[i], minRank, filter) {
			matched = append(matched, entries[i])
		}
	}
	// Reverse back to oldest-first.
	for i, j := 0, len(matched)-1; i < j; i, j = i+1, j-1 {
		matched[i], matched[j] = matched[j], matched[i]
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"entries": matched, "count": len(matched), "buffer_size": len(entries),
	})
}

// stream sends matching entries as Server-Sent Events: a fifty-entry
// backfill, then new records on a short poll, with periodic keepalives.
func (h *Handler) stream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		httpapi.WriteInternalError(w, r, errors.New("response writer does not support flushing"))
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	minRank := rank(r.URL.Query().Get("level"))
	filter := r.URL.Query().Get("filter")

	send := func(e Entry) bool {
		blob, err := json.Marshal(e)
		if err != nil {
			return true
		}
		if _, err := fmt.Fprintf(w, "data: %s\n\n", blob); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}

	entries := h.Ring.Snapshot()
	matched := []Entry{}
	for i := len(entries) - 1; i >= 0 && len(matched) < backfillLimit; i-- {
		if matches(entries[i], minRank, filter) {
			matched = append(matched, entries[i])
		}
	}
	var lastSeq uint64
	if len(entries) > 0 {
		lastSeq = entries[len(entries)-1].Seq
	}
	for i := len(matched) - 1; i >= 0; i-- {
		if !send(matched[i]) {
			return
		}
	}

	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	lastKeepalive := now()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
		}
		if now().Sub(lastKeepalive) > keepaliveInterval {
			if _, err := fmt.Fprint(w, ": keepalive\n\n"); err != nil {
				return
			}
			flusher.Flush()
			lastKeepalive = now()
		}
		for _, e := range h.Ring.Snapshot() {
			if e.Seq <= lastSeq {
				continue
			}
			lastSeq = e.Seq
			if matches(e, minRank, filter) {
				if !send(e) {
					return
				}
			}
		}
	}
}
