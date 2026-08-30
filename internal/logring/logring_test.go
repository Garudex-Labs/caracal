// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package logring

import (
	"bufio"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRingCapacityAndOrder(t *testing.T) {
	ring := &Ring{}
	for i := 0; i < Capacity+10; i++ {
		ring.Append(Entry{Event: "e", Level: "INFO"})
	}
	snap := ring.Snapshot()
	if len(snap) != Capacity {
		t.Fatalf("len = %d", len(snap))
	}
	if snap[0].Seq != 11 || snap[len(snap)-1].Seq != Capacity+10 {
		t.Fatalf("seq window = %d..%d", snap[0].Seq, snap[len(snap)-1].Seq)
	}
}

func TestTeeHandlerCaptures(t *testing.T) {
	ring := &Ring{}
	var sink strings.Builder
	logger := slog.New(&TeeHandler{Next: slog.NewTextHandler(&sink, nil), Ring: ring})
	logger.Warn("disk pressure", "volume", "a")
	logger.Info("routine")
	snap := ring.Snapshot()
	if len(snap) != 2 || snap[0].Level != "WARNING" || snap[0].Event != "disk pressure" {
		t.Fatalf("snap = %+v", snap)
	}
	if !strings.Contains(sink.String(), "disk pressure") {
		t.Fatal("wrapped handler skipped")
	}
}

func TestRecentFilters(t *testing.T) {
	ring := &Ring{}
	ring.Append(Entry{Level: "DEBUG", Event: "noise"})
	ring.Append(Entry{Level: "ERROR", Event: "clickhouse down"})
	ring.Append(Entry{Level: "INFO", Event: "startup"})
	h := &Handler{Ring: ring}

	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, httptest.NewRequest("GET", "/api/v1/operator/logs?level=INFO&filter=clickhouse", nil))
	var body struct {
		Entries    []Entry `json:"entries"`
		Count      int     `json:"count"`
		BufferSize int     `json:"buffer_size"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body.Count != 1 || body.BufferSize != 3 || body.Entries[0].Event != "clickhouse down" {
		t.Fatalf("body = %s", rec.Body.String())
	}

	rec = httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, httptest.NewRequest("GET", "/api/v1/operator/logs?limit=notanint", nil))
	if rec.Code != 422 {
		t.Fatalf("bad limit = %d", rec.Code)
	}
}

func TestStreamBackfillAndLive(t *testing.T) {
	ring := &Ring{}
	ring.Append(Entry{Level: "INFO", Event: "old-1"})
	ring.Append(Entry{Level: "INFO", Event: "old-2"})
	srv := httptest.NewServer((&Handler{Ring: ring}).Routes())
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/api/v1/operator/logs/stream", nil)
	res, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	if ct := res.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content type = %s", ct)
	}

	go func() {
		time.Sleep(150 * time.Millisecond)
		ring.Append(Entry{Level: "ERROR", Event: "live-1"})
	}()

	scanner := bufio.NewScanner(res.Body)
	got := []string{}
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "data: ") {
			var e Entry
			_ = json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &e)
			got = append(got, e.Event)
			if len(got) == 3 {
				cancel()
				break
			}
		}
	}
	if len(got) != 3 || got[0] != "old-1" || got[2] != "live-1" {
		t.Fatalf("events = %v", got)
	}
}
