// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package events publishes service notifications to Redis pub/sub channels.
package events

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/redis/go-redis/v9"
)

// RedisPublisher fans notifications out over Redis pub/sub. Publishing is
// best-effort: subscribers refresh on their own cadence anyway, so a lost
// nudge only delays a UI update.
type RedisPublisher struct {
	Client redis.UniversalClient
}

// Publish sends the payload as JSON to the channel.
func (p *RedisPublisher) Publish(ctx context.Context, channel string, payload map[string]string) {
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	if err := p.Client.Publish(ctx, channel, data).Err(); err != nil {
		slog.Debug("publish failed", "channel", channel, "error", err)
	}
}
