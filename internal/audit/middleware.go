// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package audit

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"net"
	"net/http"
	"runtime/debug"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/httpapi"
)

// Actor identifies the authenticated principal behind a request.
type Actor struct {
	ID    string
	Email string
	Role  string
}

type actorKey struct{}

// CaptureActor records the authenticated principal for the surrounding
// Middleware. Mount it between the auth middleware and the handler.
func CaptureActor(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if recorder, ok := r.Context().Value(actorKey{}).(*Actor); ok {
			if claims, ok := httpapi.ClaimsFrom(r.Context()); ok {
				recorder.ID = claims.UserID.String()
				recorder.Email = claims.Email
				recorder.Role = claims.Role
			}
		}
		next.ServeHTTP(w, r)
	})
}

// statusRecorder captures the response status code for the audit record.
type statusRecorder struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.wrote = true
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	s.wrote = true
	return s.ResponseWriter.Write(b)
}

// Middleware audits every request through next at the given sensitivity.
// Mount it outermost so denied and failed requests are recorded too.
// Handler panics are recovered here: the client gets a sanitized JSON 500,
// the panic is logged with its stack, and the audit record keeps the 500 -
// a panic must never produce a connection reset or vanish from the trail.
func Middleware(logger *Logger, sensitivity string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()

		requestID := r.Header.Get("X-Request-ID")
		if _, err := uuid.Parse(requestID); err != nil {
			requestID = uuid.NewString()
		}
		w.Header().Set("X-Request-ID", requestID)

		actor := &Actor{}
		recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		ctx := contextWithActor(r.Context(), actor)

		defer func() {
			if rec := recover(); rec != nil {
				if err, ok := rec.(error); ok && errors.Is(err, http.ErrAbortHandler) {
					panic(rec) // deliberate abort, net/http handles it
				}
				slog.Error("panic recovered",
					"method", r.Method,
					"path", r.URL.Path,
					"request_id", requestID,
					"panic", rec,
					"stack", string(debug.Stack()),
				)
				recorder.status = http.StatusInternalServerError
				if !recorder.wrote {
					httpapi.WriteError(recorder, http.StatusInternalServerError, "Internal server error")
				}
			}

			durationMS := math.Round(float64(time.Since(start).Microseconds())/1000*100) / 100
			record := Record{
				EventID:     uuid.NewString(),
				ActorID:     "anonymous",
				ActorRole:   "anonymous",
				Action:      strings.ToLower(r.Method) + "." + r.URL.Path,
				HTTPMethod:  r.Method,
				HTTPPath:    r.URL.Path,
				StatusCode:  recorder.status,
				IPAddress:   clientIP(r),
				UserAgent:   r.Header.Get("User-Agent"),
				Sensitivity: sensitivity,
				RequestID:   requestID,
				Outcome:     outcomeFor(recorder.status),
				DurationMS:  durationMS,
			}
			if actor.ID != "" {
				record.ActorID = actor.ID
				record.ActorEmail = actor.Email
				record.ActorRole = actor.Role
			}
			logger.Log(record)
		}()

		next.ServeHTTP(recorder, r.WithContext(ctx))
	})
}

func contextWithActor(ctx context.Context, actor *Actor) context.Context {
	return context.WithValue(ctx, actorKey{}, actor)
}

func outcomeFor(status int) string {
	switch {
	case status < 300:
		return "success"
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return "denied"
	case status == http.StatusNotFound:
		return "not_found"
	case status >= 500:
		return "error"
	default:
		return "client_error"
	}
}

// clientIP prefers the real client address resolved by the load balancer.
func clientIP(r *http.Request) string {
	if ip := r.Header.Get("X-Real-IP"); ip != "" {
		return ip
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	if r.RemoteAddr != "" {
		return r.RemoteAddr
	}
	return "127.0.0.1"
}
