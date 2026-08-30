// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package accounts

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/tenancy"
)

// SecurityEvents records security-relevant actions in the analytics store.
type SecurityEvents interface {
	InsertJSONEachRow(ctx context.Context, sql string, rows []any) error
}

// IntSetting reads a dynamic integer setting with a fallback.
type IntSetting interface {
	Int(ctx context.Context, key string, fallback int) int
}

// Handler serves the /api/v1/auth profile routes.
type Handler struct {
	Store    *Store
	Events   SecurityEvents
	Settings IntSetting

	avatarLimit rateLimiter
}

// Routes returns the route set; callers wrap it in the required-auth chain.
func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/auth/whoami", h.whoami)
	mux.HandleFunc("PUT /api/v1/auth/profile/username", h.setUsername)
	mux.HandleFunc("PUT /api/v1/auth/profile/avatar", h.uploadAvatar)
	mux.HandleFunc("DELETE /api/v1/auth/profile/avatar", h.deleteAvatar)
	mux.HandleFunc("GET /api/v1/users/search", h.searchUsers)
	return mux
}

// userResponse is the profile wire shape.
type userResponse struct {
	ID          string  `json:"id"`
	Email       string  `json:"email"`
	Username    string  `json:"username"`
	Name        string  `json:"name"`
	Role        string  `json:"role"`
	AuthContext string  `json:"auth_context,omitempty"`
	AvatarURL   *string `json:"avatar_url"`
	CreatedAt   string  `json:"created_at"`
}

func wireProfile(p *Profile, authContext string) userResponse {
	t := p.CreatedAt.UTC()
	created := t.Format("2006-01-02T15:04:05Z")
	if t.Nanosecond() != 0 {
		created = t.Format("2006-01-02T15:04:05.000000Z")
	}
	return userResponse{
		ID: p.ID, Email: p.Email, Username: p.Username, Name: p.Name,
		Role: p.Role, AuthContext: authContext, AvatarURL: p.AvatarURL, CreatedAt: created,
	}
}

func requestAuthContext(r *http.Request) string {
	claims, _ := httpapi.ClaimsFrom(r.Context())
	return claims.AuthContext
}

func (h *Handler) currentProfile(w http.ResponseWriter, r *http.Request) *Profile {
	claims, ok := httpapi.ClaimsFrom(r.Context())
	if !ok {
		httpapi.WriteError(w, http.StatusUnauthorized, "Missing credentials")
		return nil
	}
	p, err := h.Store.Load(r.Context(), claims.UserID)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return nil
	}
	return p
}

func writeTenancyErr(w http.ResponseWriter, r *http.Request, err error) {
	var te *tenancy.Error
	if errors.As(err, &te) {
		httpapi.WriteError(w, te.Status, te.Detail)
		return
	}
	httpapi.WriteInternalError(w, r, err)
}

func (h *Handler) whoami(w http.ResponseWriter, r *http.Request) {
	if p := h.currentProfile(w, r); p != nil {
		claims, _ := httpapi.ClaimsFrom(r.Context())
		httpapi.WriteJSON(w, http.StatusOK, wireProfile(p, claims.AuthContext))
	}
}

// fieldError mirrors the request-validation error body.
type fieldError struct {
	Type  string         `json:"type"`
	Loc   []string       `json:"loc"`
	Msg   string         `json:"msg"`
	Input any            `json:"input"`
	Ctx   map[string]any `json:"ctx,omitempty"`
}

func writeValueError(w http.ResponseWriter, loc []string, input any, reason string) {
	httpapi.WriteJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": []fieldError{{
		Type: "value_error", Loc: loc, Msg: "Value error, " + reason, Input: input,
		// The upstream layer serializes the raised error object itself, which
		// renders as an empty object; the reason lives in msg.
		Ctx: map[string]any{"error": map[string]any{}},
	}}})
}

func writeMissingField(w http.ResponseWriter, loc []string, input any) {
	httpapi.WriteJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": []fieldError{{
		Type: "missing", Loc: loc, Msg: "Field required", Input: input,
	}}})
}

func (h *Handler) setUsername(w http.ResponseWriter, r *http.Request) {
	p := h.currentProfile(w, r)
	if p == nil {
		return
	}
	var req map[string]any
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeMissingField(w, []string{"body", "username"}, map[string]any{})
		return
	}
	raw, present := req["username"]
	if !present {
		writeMissingField(w, []string{"body", "username"}, req)
		return
	}
	value, isString := raw.(string)
	if !isString {
		if raw == nil {
			writeValueError(w, []string{"body", "username"}, nil, "Username is required")
			return
		}
		writeValueError(w, []string{"body", "username"}, raw, "Username is required")
		return
	}
	username, err := tenancy.ValidateNamespace(value, false)
	if err != nil {
		writeValueError(w, []string{"body", "username"}, value, err.Error())
		return
	}
	if username == p.Username {
		httpapi.WriteJSON(w, http.StatusOK, wireProfile(p, requestAuthContext(r)))
		return
	}
	fresh, err := h.Store.SetUsername(r.Context(), p, username)
	if err != nil {
		writeTenancyErr(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, wireProfile(fresh, requestAuthContext(r)))
}

// Avatar limits: binary 2MB; the data-URL form carries ~33% overhead.
const (
	maxAvatarBytes      = 2 * 1024 * 1024
	maxAvatarDataURLLen = 2936012
)

var avatarDataURLRe = regexp.MustCompile(`(?s)^data:(image/[a-zA-Z0-9.+-]+);base64,(.+)$`)

var avatarMagic = map[string][][]byte{
	"image/png":  {[]byte("\x89PNG\r\n\x1a\n")},
	"image/jpeg": {[]byte("\xff\xd8\xff")},
	"image/webp": {[]byte("RIFF")},
}

// validateAvatarDataURL enforces the upload contract; the reason strings are
// part of the API surface.
func validateAvatarDataURL(value string) string {
	if len(value) > maxAvatarDataURLLen {
		return "Image data too large"
	}
	m := avatarDataURLRe.FindStringSubmatch(value)
	if m == nil {
		return "Avatar must be a base64 data URL"
	}
	mime, payload := m[1], m[2]
	sigs, allowed := avatarMagic[mime]
	if !allowed {
		return "Only PNG, JPEG, and WebP images are allowed"
	}
	raw, err := lenientBase64(payload)
	if err != nil {
		return "Invalid base64 data"
	}
	if len(raw) > maxAvatarBytes {
		return "Image too large (max 2MB)"
	}
	ok := false
	for _, sig := range sigs {
		if bytes.HasPrefix(raw, sig) {
			ok = true
			break
		}
	}
	if !ok || (mime == "image/webp" && (len(raw) < 12 || string(raw[8:12]) != "WEBP")) {
		return "File content does not match declared type"
	}
	return ""
}

// lenientBase64 ignores characters outside the alphabet, failing only on
// truncated padding, matching the upstream decoder's discard behavior.
func lenientBase64(payload string) ([]byte, error) {
	cleaned := strings.Map(func(r rune) rune {
		if (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') ||
			r == '+' || r == '/' || r == '=' {
			return r
		}
		return -1
	}, payload)
	return base64.StdEncoding.DecodeString(cleaned)
}

func (h *Handler) uploadAvatar(w http.ResponseWriter, r *http.Request) {
	if !h.avatarLimit.allow(rateKey(r), time.Minute) {
		w.Header().Set("Retry-After", "60")
		httpapi.WriteJSON(w, http.StatusTooManyRequests, map[string]string{"error": "Rate limit exceeded: 1 per 1 minute"})
		return
	}
	p := h.currentProfile(w, r)
	if p == nil {
		return
	}
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "avatar_url is required")
		return
	}
	avatarURL, _ := body["avatar_url"].(string)
	if avatarURL == "" {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "avatar_url is required")
		return
	}
	if reason := validateAvatarDataURL(avatarURL); reason != "" {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, reason)
		return
	}
	fresh, err := h.Store.SetAvatar(r.Context(), uuid.MustParse(p.ID), &avatarURL)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, wireProfile(fresh, requestAuthContext(r)))
}

func (h *Handler) deleteAvatar(w http.ResponseWriter, r *http.Request) {
	p := h.currentProfile(w, r)
	if p == nil {
		return
	}
	fresh, err := h.Store.SetAvatar(r.Context(), uuid.MustParse(p.ID), nil)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, wireProfile(fresh, requestAuthContext(r)))
}

// rateKey buckets by bearer-token digest, falling back to the client address.
func rateKey(r *http.Request) string {
	auth := r.Header.Get("Authorization")
	scheme, token, ok := strings.Cut(auth, " ")
	if ok && strings.EqualFold(scheme, "bearer") && strings.TrimSpace(token) != "" {
		sum := sha256.Sum256([]byte(strings.TrimSpace(token)))
		return "token:" + hex.EncodeToString(sum[:])
	}
	if ip := r.Header.Get("X-Real-IP"); ip != "" {
		return "ip:" + ip
	}
	return "ip:" + r.RemoteAddr
}

// rateLimiter is a fixed-window once-per-window gate.
type rateLimiter struct {
	mu   sync.Mutex
	seen map[string]time.Time
}

func (l *rateLimiter) allow(key string, window time.Duration) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if l.seen == nil {
		l.seen = map[string]time.Time{}
	}
	if at, ok := l.seen[key]; ok && now.Sub(at) < window {
		return false
	}
	// Opportunistic sweep keeps the map from growing unbounded.
	if len(l.seen) > 4096 {
		for k, at := range l.seen {
			if now.Sub(at) >= window {
				delete(l.seen, k)
			}
		}
	}
	l.seen[key] = now
	return true
}

// Minter is the server-to-server bridge client for identity-service
// mutations (role changes, session revocation) issued by the admin handler.
type Minter struct {
	BaseURL        string
	InternalSecret string
	Client         *http.Client
}
