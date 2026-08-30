// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package alerts

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"math"
	"math/rand/v2"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

// Signing headers follow the GitHub/Stripe/Svix convention: the signature is
// HMAC-SHA256(secret, "{timestamp}.{body}").
const (
	headerSignature = "X-Caracal-Signature"
	headerTimestamp = "X-Caracal-Timestamp"
	headerEventID   = "X-Caracal-Event-Id"
)

const (
	deliveryMaxAttempts = 3
	deliveryTimeout     = 10 * time.Second
)

const insertDeliveriesSQL = "INSERT INTO webhook_deliveries (delivery_id, event_id, alert_rule_id, " +
	"attempt_number, timestamp, webhook_url, status_code, delivery_status, " +
	"error, duration_ms, payload_size) FORMAT JSONEachRow"

// DeliveryResult is the outcome of a webhook delivery.
type DeliveryResult struct {
	Success    bool
	StatusCode *int
	Attempts   int
	Error      *string
	DurationMS float64
}

type deliveryRecord struct {
	DeliveryID     string  `json:"delivery_id"`
	EventID        string  `json:"event_id"`
	AlertRuleID    string  `json:"alert_rule_id"`
	AttemptNumber  int     `json:"attempt_number"`
	Timestamp      string  `json:"timestamp"`
	WebhookURL     string  `json:"webhook_url"`
	StatusCode     *int    `json:"status_code"`
	DeliveryStatus string  `json:"delivery_status"`
	Error          *string `json:"error"`
	DurationMS     float64 `json:"duration_ms"`
	PayloadSize    int     `json:"payload_size"`
}

// Deliverer sends signed webhooks with retry and records each attempt to
// the delivery trail.
type Deliverer struct {
	CH   *clickhouse.Client
	HTTP *http.Client

	sleep func(time.Duration)
	now   func() time.Time
	// private is the SSRF check, overridable in tests.
	private func(context.Context, string) bool
}

func (d *Deliverer) client() *http.Client {
	if d.HTTP != nil {
		return d.HTTP
	}
	return &http.Client{Timeout: deliveryTimeout}
}

func signPayload(secret string, timestamp int64, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = fmt.Fprintf(mac, "%d.", timestamp) // hash writers cannot fail
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// Deliver posts the payload with exponential backoff: up to three attempts,
// no retry on 4xx responses. Recording is best-effort.
func (d *Deliverer) Deliver(ctx context.Context, webhookURL, secret string, body []byte, ruleID uuid.UUID) DeliveryResult {
	private := d.private
	if private == nil {
		private = IsPrivateURL
	}
	if private(ctx, webhookURL) {
		errText := "SSRF: webhook URL resolves to private network"
		return DeliveryResult{Error: &errText}
	}
	sleep := d.sleep
	if sleep == nil {
		sleep = time.Sleep
	}
	now := d.now
	if now == nil {
		now = time.Now
	}

	eventID := uuid.New()
	headers := map[string]string{
		"Content-Type": "application/json",
		headerEventID:  eventID.String(),
	}
	if secret != "" {
		timestamp := now().Unix()
		headers[headerSignature] = "sha256=" + signPayload(secret, timestamp, body)
		headers[headerTimestamp] = strconv.FormatInt(timestamp, 10)
	}

	records := []any{}
	record := func(attempt int, statusCode *int, status string, errText *string, durationMS float64) {
		records = append(records, deliveryRecord{
			DeliveryID:     uuid.NewString(),
			EventID:        eventID.String(),
			AlertRuleID:    ruleID.String(),
			AttemptNumber:  attempt,
			Timestamp:      now().UTC().Format("2006-01-02 15:04:05.000"),
			WebhookURL:     webhookURL,
			StatusCode:     statusCode,
			DeliveryStatus: status,
			Error:          errText,
			DurationMS:     math.RoundToEven(durationMS*100) / 100,
			PayloadSize:    len(body),
		})
	}
	flush := func() {
		if d.CH == nil || len(records) == 0 {
			return
		}
		if err := d.CH.InsertJSONEachRow(ctx, insertDeliveriesSQL, records); err != nil {
			slog.Error("webhook delivery trail insert failed", "error", err)
		}
	}

	start := now()
	var lastError *string
	for attempt := 1; attempt <= deliveryMaxAttempts; attempt++ {
		if attempt > 1 {
			// Jitter desynchronizes simultaneous rule firings; the timer
			// honors cancellation so shutdown never waits out a backoff.
			base := time.Duration(1<<(attempt-2)) * time.Second // 1s, 2s backoff
			delay := base/2 + time.Duration(rand.Int64N(int64(base)))
			if d.sleep != nil {
				sleep(delay)
			} else {
				select {
				case <-time.After(delay):
				case <-ctx.Done():
					errText := ctx.Err().Error()
					lastError = &errText
					flush()
					return DeliveryResult{
						Attempts:   attempt - 1,
						Error:      lastError,
						DurationMS: float64(now().Sub(start)) / float64(time.Millisecond),
					}
				}
			}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, webhookURL, bytes.NewReader(body))
		if err != nil {
			errText := err.Error()
			lastError = &errText
			record(attempt, nil, "failed", lastError, float64(now().Sub(start))/float64(time.Millisecond))
			continue
		}
		for name, value := range headers {
			req.Header.Set(name, value)
		}
		resp, err := d.client().Do(req)
		durationMS := float64(now().Sub(start)) / float64(time.Millisecond)
		if err != nil {
			errText := err.Error()
			lastError = &errText
			record(attempt, nil, "failed", lastError, durationMS)
			continue
		}
		_ = resp.Body.Close()
		status := "delivered"
		if resp.StatusCode >= 400 {
			status = "failed"
		}
		code := resp.StatusCode
		record(attempt, &code, status, nil, durationMS)
		if resp.StatusCode < 400 {
			flush()
			return DeliveryResult{Success: true, StatusCode: &code, Attempts: attempt, DurationMS: durationMS}
		}
		errText := fmt.Sprintf("HTTP %d", resp.StatusCode)
		lastError = &errText
		if resp.StatusCode < 500 {
			break // client error - retrying won't help
		}
	}
	flush()
	return DeliveryResult{
		Attempts:   deliveryMaxAttempts,
		Error:      lastError,
		DurationMS: float64(now().Sub(start)) / float64(time.Millisecond),
	}
}
