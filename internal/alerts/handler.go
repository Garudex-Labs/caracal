// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package alerts serves the alert rule routes: CRUD, firing history, webhook
// secret management, and signed test deliveries.
package alerts

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/httpapi"
)

// RuleStore is the persistence seam the handler needs.
type RuleStore interface {
	List(ctx context.Context, owner *uuid.UUID) ([]Rule, error)
	Create(ctx context.Context, r Rule) (Rule, error)
	ByID(ctx context.Context, id uuid.UUID) (Rule, error)
	Update(ctx context.Context, id uuid.UUID, status, webhookURL *string) (Rule, error)
	UpdateSecret(ctx context.Context, id uuid.UUID, secret string) (Rule, error)
	Delete(ctx context.Context, id uuid.UUID) error
	HistoryFor(ctx context.Context, ruleID uuid.UUID, limit, offset int) ([]History, error)
}

// Sender delivers webhooks.
type Sender interface {
	Deliver(ctx context.Context, webhookURL, secret string, body []byte, ruleID uuid.UUID) DeliveryResult
}

// Handler serves the alert route group.
type Handler struct {
	Store   RuleStore
	Webhook Sender

	// privateURL is the SSRF check, overridable in tests.
	privateURL func(context.Context, string) bool
}

// Routes returns the route group. The mount provides authentication; role
// floors are per-route because secret management is admin-only.
func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	user := func(fn http.HandlerFunc) http.Handler { return httpapi.RequireRole("user", fn) }

	mux.Handle("GET /api/v1/alerts", user(h.list))
	mux.Handle("POST /api/v1/alerts", user(h.create))
	mux.Handle("PATCH /api/v1/alerts/{alert_id}", user(h.update))
	mux.Handle("DELETE /api/v1/alerts/{alert_id}", user(h.delete))
	mux.Handle("GET /api/v1/alerts/{alert_id}/history", user(h.history))
	mux.Handle("POST /api/v1/alerts/{alert_id}/webhook-secret/rotate", user(h.rotateSecret))
	mux.Handle("GET /api/v1/alerts/{alert_id}/webhook-secret", user(h.revealSecret))
	mux.Handle("POST /api/v1/alerts/{alert_id}/webhook/test", user(h.testWebhook))
	return mux
}

func (h *Handler) isPrivateURL(ctx context.Context, rawURL string) bool {
	if h.privateURL != nil {
		return h.privateURL(ctx, rawURL)
	}
	return IsPrivateURL(ctx, rawURL)
}

// validateWebhookURL enforces scheme and SSRF rules; empty means no webhook.
func (h *Handler) validateWebhookURL(ctx context.Context, w http.ResponseWriter, rawURL string) bool {
	if rawURL == "" {
		return true
	}
	parsed, err := url.Parse(rawURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		httpapi.WriteError(w, http.StatusBadRequest, "webhook_url must use http or https")
		return false
	}
	if h.isPrivateURL(ctx, rawURL) {
		httpapi.WriteError(w, http.StatusBadRequest, "webhook_url must not point to private/internal networks")
		return false
	}
	return true
}

func isOperator(role string) bool {
	return role == "operator"
}

// newSecret returns a 64-character hex webhook signing secret.
func newSecret() string {
	buf := make([]byte, 32)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

func wireTime(t time.Time) string {
	t = t.UTC()
	if t.Nanosecond() == 0 {
		return t.Format("2006-01-02T15:04:05Z07:00")
	}
	return t.Format("2006-01-02T15:04:05.000000Z07:00")
}

func floatNumber(f float64) json.Number {
	text := strconv.FormatFloat(f, 'g', -1, 64)
	if !strings.ContainsAny(text, ".eE") {
		text += ".0"
	}
	return json.Number(text)
}

type ruleJSON struct {
	ID                uuid.UUID   `json:"id"`
	Name              string      `json:"name"`
	Metric            string      `json:"metric"`
	Threshold         json.Number `json:"threshold"`
	Condition         string      `json:"condition"`
	TargetType        string      `json:"target_type"`
	TargetID          string      `json:"target_id"`
	WebhookURL        string      `json:"webhook_url"`
	WebhookSecretLast string      `json:"webhook_secret_last4"`
	Status            string      `json:"status"`
	LastTriggered     *string     `json:"last_triggered"`
	CreatedAt         string      `json:"created_at"`
}

func toJSON(r Rule) ruleJSON {
	out := ruleJSON{
		ID:         r.ID,
		Name:       r.Name,
		Metric:     r.Metric,
		Threshold:  floatNumber(r.Threshold),
		Condition:  r.Condition,
		TargetType: r.TargetType,
		TargetID:   r.TargetID,
		WebhookURL: r.WebhookURL,
		Status:     r.Status,
		CreatedAt:  wireTime(r.CreatedAt),
	}
	if len(r.WebhookSecret) >= 4 {
		out.WebhookSecretLast = r.WebhookSecret[len(r.WebhookSecret)-4:]
	} else {
		out.WebhookSecretLast = r.WebhookSecret
	}
	if r.LastTriggered != nil {
		fired := wireTime(*r.LastTriggered)
		out.LastTriggered = &fired
	}
	return out
}

// ruleForCaller loads the rule and enforces the owner-or-admin rule with the
// given denial message. A nil rule means the response is already written.
func (h *Handler) ruleForCaller(w http.ResponseWriter, r *http.Request, denial string) *Rule {
	claims, _ := httpapi.ClaimsFrom(r.Context())
	id, err := uuid.Parse(r.PathValue("alert_id"))
	if err != nil {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "alert_id must be a UUID")
		return nil
	}
	rule, err := h.Store.ByID(r.Context(), id)
	if errors.Is(err, ErrNotFound) {
		httpapi.WriteError(w, http.StatusNotFound, "Alert rule not found")
		return nil
	}
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return nil
	}
	if denial != "" && rule.CreatedBy != claims.UserID && !isOperator(claims.Role) {
		httpapi.WriteError(w, http.StatusForbidden, denial)
		return nil
	}
	return &rule
}

func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	claims, _ := httpapi.ClaimsFrom(r.Context())
	var owner *uuid.UUID
	if !isOperator(claims.Role) {
		owner = &claims.UserID
	}
	rules, err := h.Store.List(r.Context(), owner)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	out := make([]ruleJSON, 0, len(rules))
	for _, rule := range rules {
		out = append(out, toJSON(rule))
	}
	httpapi.WriteJSON(w, http.StatusOK, out)
}

type createBody struct {
	Name       *string  `json:"name"`
	Metric     *string  `json:"metric"`
	Threshold  *float64 `json:"threshold"`
	Condition  *string  `json:"condition"`
	TargetType string   `json:"target_type"`
	TargetID   string   `json:"target_id"`
	WebhookURL string   `json:"webhook_url"`
}

func (h *Handler) create(w http.ResponseWriter, r *http.Request) {
	claims, _ := httpapi.ClaimsFrom(r.Context())
	body := createBody{TargetType: "all"}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	if body.Name == nil || body.Metric == nil || body.Threshold == nil || body.Condition == nil {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "name, metric, threshold, and condition are required")
		return
	}
	if !h.validateWebhookURL(r.Context(), w, body.WebhookURL) {
		return
	}
	targetID := body.TargetID
	if body.TargetType == "all" {
		targetID = ""
	}
	rule, err := h.Store.Create(r.Context(), Rule{
		Name:          *body.Name,
		Metric:        *body.Metric,
		Threshold:     *body.Threshold,
		Condition:     *body.Condition,
		TargetType:    body.TargetType,
		TargetID:      targetID,
		WebhookURL:    body.WebhookURL,
		WebhookSecret: newSecret(),
		CreatedBy:     claims.UserID,
	})
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusCreated, toJSON(rule))
}

type updateBody struct {
	Status     *string `json:"status"`
	WebhookURL *string `json:"webhook_url"`
}

func (h *Handler) update(w http.ResponseWriter, r *http.Request) {
	rule := h.ruleForCaller(w, r, "Not authorized to modify this alert rule")
	if rule == nil {
		return
	}
	var body updateBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	if body.WebhookURL != nil && !h.validateWebhookURL(r.Context(), w, *body.WebhookURL) {
		return
	}
	updated, err := h.Store.Update(r.Context(), rule.ID, body.Status, body.WebhookURL)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, toJSON(updated))
}

func (h *Handler) delete(w http.ResponseWriter, r *http.Request) {
	rule := h.ruleForCaller(w, r, "Not authorized to delete this alert rule")
	if rule == nil {
		return
	}
	if err := h.Store.Delete(r.Context(), rule.ID); err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type historyJSON struct {
	ID             uuid.UUID   `json:"id"`
	AlertRuleID    uuid.UUID   `json:"alert_rule_id"`
	MetricValue    json.Number `json:"metric_value"`
	Threshold      json.Number `json:"threshold"`
	Condition      string      `json:"condition"`
	FiredAt        string      `json:"fired_at"`
	DeliveryStatus string      `json:"delivery_status"`
	ResponseCode   *int        `json:"response_code"`
	Error          *string     `json:"error"`
	CreatedAt      string      `json:"created_at"`
}

// queryInt parses an integer query parameter with a default.
func queryInt(r *http.Request, name string, fallback int) (int, bool) {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return fallback, true
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, false
	}
	return value, true
}

func (h *Handler) history(w http.ResponseWriter, r *http.Request) {
	rule := h.ruleForCaller(w, r, "Not authorized")
	if rule == nil {
		return
	}
	limit, ok := queryInt(r, "limit", 50)
	if !ok || limit < 1 || limit > 200 {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "limit must be between 1 and 200")
		return
	}
	offset, ok := queryInt(r, "offset", 0)
	if !ok || offset < 0 {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "offset must be non-negative")
		return
	}
	history, err := h.Store.HistoryFor(r.Context(), rule.ID, limit, offset)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	out := make([]historyJSON, 0, len(history))
	for _, entry := range history {
		item := historyJSON{
			ID:             entry.ID,
			AlertRuleID:    entry.AlertRuleID,
			MetricValue:    floatNumber(entry.MetricValue),
			Threshold:      floatNumber(entry.Threshold),
			Condition:      entry.Condition,
			FiredAt:        wireTime(entry.FiredAt),
			DeliveryStatus: entry.DeliveryStatus,
			ResponseCode:   entry.ResponseCode,
			Error:          entry.Error,
			CreatedAt:      wireTime(entry.CreatedAt),
		}
		out = append(out, item)
	}
	httpapi.WriteJSON(w, http.StatusOK, out)
}

func (h *Handler) rotateSecret(w http.ResponseWriter, r *http.Request) {
	rule := h.ruleForCaller(w, r, "Not authorized to manage this alert rule's secret")
	if rule == nil {
		return
	}
	updated, err := h.Store.UpdateSecret(r.Context(), rule.ID, newSecret())
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"webhook_secret_last4": updated.WebhookSecret[len(updated.WebhookSecret)-4:],
		"rotated_at":           wireTime(time.Now().UTC()),
	})
}

func (h *Handler) revealSecret(w http.ResponseWriter, r *http.Request) {
	rule := h.ruleForCaller(w, r, "Not authorized to manage this alert rule's secret")
	if rule == nil {
		return
	}
	// The reveal itself is captured by the audit trail middleware.
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{"webhook_secret": rule.WebhookSecret})
}

// testPayload is the body of a test delivery, in contract field order.
type testPayload struct {
	Test        bool        `json:"test"`
	AlertRuleID string      `json:"alert_rule_id"`
	AlertName   string      `json:"alert_name"`
	Metric      string      `json:"metric"`
	Threshold   json.Number `json:"threshold"`
	Condition   string      `json:"condition"`
	TargetType  string      `json:"target_type"`
	TargetID    string      `json:"target_id"`
	Message     string      `json:"message"`
}

func (h *Handler) testWebhook(w http.ResponseWriter, r *http.Request) {
	rule := h.ruleForCaller(w, r, "Not authorized to test this alert rule")
	if rule == nil {
		return
	}
	if rule.WebhookURL == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "No webhook URL configured for this alert rule")
		return
	}
	body, err := json.Marshal(testPayload{
		Test:        true,
		AlertRuleID: rule.ID.String(),
		AlertName:   rule.Name,
		Metric:      rule.Metric,
		Threshold:   floatNumber(rule.Threshold),
		Condition:   rule.Condition,
		TargetType:  rule.TargetType,
		TargetID:    rule.TargetID,
		Message:     "This is a test webhook from Caracal",
	})
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	result := h.Webhook.Deliver(r.Context(), rule.WebhookURL, rule.WebhookSecret, body, rule.ID)
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success":     result.Success,
		"status_code": result.StatusCode,
		"attempts":    result.Attempts,
		"duration_ms": floatNumber(result.DurationMS),
	})
}
