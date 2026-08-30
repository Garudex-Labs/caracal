// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package alerts

import (
	"context"
	"encoding/json"
	"log/slog"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

const (
	evalInterval     = time.Minute
	evalCycleTimeout = 55 * time.Second
	lookbackMinutes  = 5
	evalLockKey      = "alerts:evaluate:lock"
)

// EvalStore is the persistence seam the evaluator needs.
type EvalStore interface {
	ActiveRules(ctx context.Context) ([]Rule, error)
	RecordFiring(ctx context.Context, h History) error
}

// Locker guards against concurrent evaluation across replicas.
type Locker interface {
	TryLock(ctx context.Context, key string, ttl time.Duration) bool
}

// RedisLock implements Locker on Redis; unavailable Redis reads as locked so
// evaluation pauses rather than double-fires.
type RedisLock struct {
	Client *redis.Client
}

// TryLock acquires the key for the ttl window.
func (l RedisLock) TryLock(ctx context.Context, key string, ttl time.Duration) bool {
	ok, err := l.Client.SetNX(ctx, key, "1", ttl).Result()
	return err == nil && ok
}

// Evaluator periodically checks every active alert rule against its metric
// and fires signed webhooks when a threshold is crossed.
type Evaluator struct {
	Store   EvalStore
	CH      *clickhouse.Client
	Webhook Sender
	Lock    Locker

	now func() time.Time
}

// Run evaluates once per interval until the context ends.
func (e *Evaluator) Run(ctx context.Context) {
	ticker := time.NewTicker(evalInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cycleCtx, cancel := context.WithTimeout(ctx, evalCycleTimeout)
			e.Cycle(cycleCtx)
			cancel()
		}
	}
}

// Cycle evaluates every active rule once.
func (e *Evaluator) Cycle(ctx context.Context) {
	if e.Lock != nil && !e.Lock.TryLock(ctx, evalLockKey, evalCycleTimeout) {
		return
	}
	rules, err := e.Store.ActiveRules(ctx)
	if err != nil {
		slog.Error("alert evaluation cannot list rules", "error", err)
		return
	}
	for _, rule := range rules {
		if err := e.evaluate(ctx, rule); err != nil {
			slog.Error("alert rule evaluation failed", "rule_id", rule.ID, "error", err)
		}
	}
}

// metricValue resolves the rule's metric over the lookback window. The
// second return is false when the metric cannot be evaluated this cycle.
func (e *Evaluator) metricValue(ctx context.Context, metric, targetType, targetID string) (float64, bool) {
	switch metric {
	case "error_rate", "latency_p99":
		// Placeholder metrics: session data does not carry a normalized
		// error counter or span latency yet, so these evaluate to zero.
		return 0, true
	case "token_usage":
		sql := "SELECT sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS token_usage " +
			"FROM session_stats_agg FINAL " +
			"WHERE last_event_time > now() - INTERVAL {lookback:UInt32} MINUTE"
		params := clickhouse.Settings{"param_lookback": strconv.Itoa(lookbackMinutes)}
		if targetType == "agent" {
			sql += " AND agent_id = {target_id:String}"
			params["param_target_id"] = targetID
		}
		rows, err := e.CH.QueryJSON(ctx, sql+" FORMAT JSON", params)
		if err != nil || len(rows) == 0 {
			if err != nil {
				slog.Error("token_usage query failed", "error", err)
			}
			return 0, false
		}
		switch v := rows[0]["token_usage"].(type) {
		case float64:
			return v, true
		case string:
			parsed, err := strconv.ParseFloat(v, 64)
			return parsed, err == nil
		default:
			return 0, false
		}
	default:
		slog.Warn("unknown alert metric", "metric", metric)
		return 0, false
	}
}

func conditionMet(condition string, value, threshold float64) bool {
	switch condition {
	case "above":
		return value > threshold
	case "below":
		return value < threshold
	default:
		return false
	}
}

// firedAt renders the firing timestamp for webhook receivers.
func firedAt(t time.Time) string {
	t = t.UTC()
	if t.Nanosecond() == 0 {
		return t.Format("2006-01-02T15:04:05") + "+00:00"
	}
	return t.Format("2006-01-02T15:04:05.000000") + "+00:00"
}

// firingPayload is the webhook body, in contract field order.
type firingPayload struct {
	AlertRuleID string      `json:"alert_rule_id"`
	AlertName   string      `json:"alert_name"`
	Metric      string      `json:"metric"`
	MetricValue json.Number `json:"metric_value"`
	Threshold   json.Number `json:"threshold"`
	Condition   string      `json:"condition"`
	TargetType  string      `json:"target_type"`
	TargetID    string      `json:"target_id"`
	FiredAt     string      `json:"fired_at"`
}

func (e *Evaluator) evaluate(ctx context.Context, rule Rule) error {
	value, ok := e.metricValue(ctx, rule.Metric, rule.TargetType, rule.TargetID)
	if !ok {
		return nil
	}
	if !conditionMet(rule.Condition, value, rule.Threshold) {
		return nil
	}

	now := time.Now
	if e.now != nil {
		now = e.now
	}
	fired := now().UTC()

	history := History{
		AlertRuleID:    rule.ID,
		MetricValue:    value,
		Threshold:      rule.Threshold,
		Condition:      rule.Condition,
		FiredAt:        fired,
		DeliveryStatus: "delivered",
	}
	if rule.WebhookURL != "" {
		body, err := json.Marshal(firingPayload{
			AlertRuleID: rule.ID.String(),
			AlertName:   rule.Name,
			Metric:      rule.Metric,
			MetricValue: floatNumber(value),
			Threshold:   floatNumber(rule.Threshold),
			Condition:   rule.Condition,
			TargetType:  rule.TargetType,
			TargetID:    rule.TargetID,
			FiredAt:     firedAt(fired),
		})
		if err != nil {
			return err
		}
		result := e.Webhook.Deliver(ctx, rule.WebhookURL, rule.WebhookSecret, body, rule.ID)
		history.ResponseCode = result.StatusCode
		history.Error = result.Error
		if !result.Success {
			history.DeliveryStatus = "failed"
		}
	}
	if err := e.Store.RecordFiring(ctx, history); err != nil {
		return err
	}
	slog.Info("alert fired", "rule", rule.Name, "metric", rule.Metric, "value", value,
		"threshold", rule.Threshold, "condition", rule.Condition, "delivery", history.DeliveryStatus)
	return nil
}
