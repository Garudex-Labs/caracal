// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// /v1/control/invoke handler: parses JSON, authenticates the bearer, rate-limits, dispatches, and audits.

package internal

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/rs/zerolog"
)

const maxBodyBytes = 64 * 1024

func InvokeHandler(auth *Authenticator, disp *Dispatcher, sink EventSink, rate *RateLimiter, log zerolog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, Response{Error: "method not allowed"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()

		claims, err := auth.Verify(ctx, r.Header.Get("Authorization"))
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, Response{Error: "unauthorized"})
			return
		}
		if !rate.Allow(claims.Subject) {
			writeJSON(w, http.StatusTooManyRequests, Response{Error: "rate limited"})
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
		var req Request
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, Response{Error: "invalid json"})
			return
		}
		result, err := disp.Dispatch(ctx, req)
		event := AuditEvent{
			At:        time.Now().UTC(),
			Subject:   claims.Subject,
			JTI:       claims.ID,
			Command:   req.Command,
			Sub:       req.Subcommand,
			Decision:  "allow",
			Reason:    "",
			RequestID: r.Header.Get("X-Request-Id"),
		}
		if err != nil {
			event.Decision = "deny"
			event.Reason = err.Error()
			sink.Emit(event)
			switch {
			case errors.Is(err, ErrDenied):
				writeJSON(w, http.StatusBadRequest, Response{Error: err.Error()})
			case errors.Is(err, ErrUnsupported):
				writeJSON(w, http.StatusNotImplemented, Response{Error: err.Error()})
			default:
				log.Err(err).Str("cmd", req.Command).Msg("upstream error")
				writeJSON(w, http.StatusBadGateway, Response{Error: "upstream error"})
			}
			return
		}
		sink.Emit(event)
		writeJSON(w, http.StatusOK, Response{OK: true, Result: result})
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
