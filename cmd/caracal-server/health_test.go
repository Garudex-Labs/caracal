// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

type fakeReadyRow struct {
	err   error
	count int64
}

func (r fakeReadyRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	if len(dest) > 0 {
		if p, ok := dest[0].(*int64); ok {
			*p = r.count
		}
	}
	return nil
}

type fakeReadyPG struct {
	err   error
	count int64
}

func (f fakeReadyPG) QueryRow(_ context.Context, _ string, _ ...any) pgx.Row {
	return fakeReadyRow(f)
}

type fakeReadyCH struct{ err error }

func (f fakeReadyCH) Exec(_ context.Context, _ string, _ clickhouse.Settings) error {
	return f.err
}

type fakeReadyRedis struct{ err error }

func (f fakeReadyRedis) Ping(ctx context.Context) *redis.StatusCmd {
	cmd := redis.NewStatusCmd(ctx)
	if f.err != nil {
		cmd.SetErr(f.err)
	}
	return cmd
}

func callReadiness(pg fakeReadyPG, ch fakeReadyCH, rd fakeReadyRedis) (*httptest.ResponseRecorder, map[string]any) {
	h := readiness(pg, ch, rd)
	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	rec := httptest.NewRecorder()
	h(rec, req)
	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	return rec, body
}

func TestReadinessAllHealthy(t *testing.T) {
	rec, body := callReadiness(fakeReadyPG{count: 5}, fakeReadyCH{}, fakeReadyRedis{})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if body["status"] != "ok" || body["postgres"] != "ok" ||
		body["clickhouse"] != "ok" || body["redis"] != "ok" {
		t.Errorf("checks = %v", body)
	}
	if body["initialized"] != true {
		t.Errorf("initialized = %v, want true for a populated users table", body["initialized"])
	}
}

func TestReadinessUninitializedWhenNoUsers(t *testing.T) {
	_, body := callReadiness(fakeReadyPG{count: 0}, fakeReadyCH{}, fakeReadyRedis{})
	if body["initialized"] != false {
		t.Errorf("initialized = %v, want false for an empty users table", body["initialized"])
	}
	if body["status"] != "ok" {
		t.Errorf("empty-but-reachable postgres must stay ok: %v", body["status"])
	}
}

func TestReadinessPostgresDownIs503(t *testing.T) {
	rec, body := callReadiness(
		fakeReadyPG{err: errors.New("connection refused")},
		fakeReadyCH{}, fakeReadyRedis{})
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	if body["status"] != "unhealthy" || body["postgres"] != "unreachable" {
		t.Errorf("checks = %v", body)
	}
	// A relational outage short-circuits: the other stores are never probed.
	if _, ok := body["clickhouse"]; ok {
		t.Errorf("clickhouse should not be probed once postgres is down: %v", body)
	}
}

func TestReadinessClickhouseDownDegrades(t *testing.T) {
	rec, body := callReadiness(
		fakeReadyPG{count: 1},
		fakeReadyCH{err: errors.New("ch down")},
		fakeReadyRedis{})
	// Analytics outage degrades but stays 200: the app is still usable.
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if body["status"] != "degraded" || body["clickhouse"] != "unreachable" {
		t.Errorf("checks = %v", body)
	}
	if body["postgres"] != "ok" {
		t.Errorf("postgres should still read ok: %v", body)
	}
}

func TestReadinessRedisDownDegrades(t *testing.T) {
	rec, body := callReadiness(
		fakeReadyPG{count: 1},
		fakeReadyCH{},
		fakeReadyRedis{err: errors.New("redis down")})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if body["status"] != "degraded" || body["redis"] != "unreachable" {
		t.Errorf("checks = %v", body)
	}
}
