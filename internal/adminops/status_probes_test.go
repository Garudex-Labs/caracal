// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package adminops

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/garudex-labs/caracal/internal/settings"
)

func TestProbeDatabase(t *testing.T) {
	meta := probeMetas[0]

	t.Run("healthy with user count metric", func(t *testing.T) {
		db := &fakeDB{stubs: []stub{
			{match: "SELECT count(*) FROM users", rows: [][]any{{int64(7)}}},
			{match: "SELECT 1", rows: [][]any{{1}}},
		}}
		h := &Handler{DB: db}
		got, err := h.probeDatabase(context.Background(), meta)
		if err != nil {
			t.Fatal(err)
		}
		if got.Status != "healthy" || got.ID != "database" || got.LatencyMS == nil {
			t.Errorf("component = %+v", got)
		}
		if got.Metrics["users"] != int64(7) {
			t.Errorf("metrics = %v", got.Metrics)
		}
	})

	t.Run("query failure surfaces as error", func(t *testing.T) {
		h := &Handler{DB: &fakeDB{}}
		if _, err := h.probeDatabase(context.Background(), meta); err == nil {
			t.Error("empty result set produced no error")
		}
	})
}

func jwksServer(t *testing.T, status int, body string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if status != http.StatusOK {
			http.Error(w, "boom", status)
			return
		}
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestProbeIdentity(t *testing.T) {
	meta := probeMetas[1]

	t.Run("healthy when keys are published", func(t *testing.T) {
		srv := jwksServer(t, 200, `{"keys":[{"kty":"EC"},{"kty":"EC"}]}`)
		h := &Handler{JWKSURL: srv.URL, HTTP: srv.Client()}
		got, err := h.probeIdentity(context.Background(), meta)
		if err != nil {
			t.Fatal(err)
		}
		if got.Status != "healthy" || got.Metrics["jwks_keys"] != 2 {
			t.Errorf("component = %+v", got)
		}
	})

	t.Run("empty key set is critical, not healthy", func(t *testing.T) {
		srv := jwksServer(t, 200, `{"keys":[]}`)
		h := &Handler{JWKSURL: srv.URL, HTTP: srv.Client()}
		got, err := h.probeIdentity(context.Background(), meta)
		if err != nil {
			t.Fatal(err)
		}
		if got.Status != "critical" || got.Detail == nil ||
			!strings.Contains(*got.Detail, "no signing keys") {
			t.Errorf("component = %+v", got)
		}
	})

	t.Run("http failure reduces to a stable error name", func(t *testing.T) {
		srv := jwksServer(t, 503, "")
		h := &Handler{JWKSURL: srv.URL, HTTP: srv.Client()}
		_, err := h.probeIdentity(context.Background(), meta)
		if err == nil || safeErrorDetail(err) != "HTTPStatusError during health probe" {
			t.Errorf("err = %v", err)
		}
	})
}

func TestProbeClickhouse(t *testing.T) {
	meta := probeMetas[2]

	t.Run("healthy", func(t *testing.T) {
		h := &Handler{CH: newCHClient(t, &chBackend{})}
		got, err := h.probeClickhouse(context.Background(), meta)
		if err != nil {
			t.Fatal(err)
		}
		if got.Status != "healthy" || got.LatencyMS == nil {
			t.Errorf("component = %+v", got)
		}
	})

	t.Run("backend failure degrades instead of erroring", func(t *testing.T) {
		h := &Handler{CH: newCHClient(t, &chBackend{status: 500})}
		got, err := h.probeClickhouse(context.Background(), meta)
		if err != nil {
			t.Fatal(err)
		}
		if got.Status != "degraded" || got.Detail == nil ||
			!strings.Contains(*got.Detail, "Unreachable") {
			t.Errorf("component = %+v", got)
		}
	})

	t.Run("cancelled context escapes as error", func(t *testing.T) {
		h := &Handler{CH: newCHClient(t, &chBackend{status: 500})}
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if _, err := h.probeClickhouse(ctx, meta); err == nil {
			t.Error("cancelled probe produced no error")
		}
	})
}

// deadRedis answers every command with a fast connection failure.
func deadRedis() *redis.Client {
	return redis.NewClient(&redis.Options{
		Addr:        "127.0.0.1:1",
		DialTimeout: 100 * time.Millisecond,
		MaxRetries:  -1,
	})
}

func TestProbeRedisUnreachable(t *testing.T) {
	h := &Handler{Redis: deadRedis()}
	got, err := h.probeRedis(context.Background(), probeMetas[3])
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "critical" || got.Detail == nil ||
		!strings.Contains(*got.Detail, "authentication fails closed") {
		t.Errorf("component = %+v", got)
	}
}

func TestProbeRuntimeConfig(t *testing.T) {
	meta := probeMetas[4]

	t.Run("default deployment reports every issue", func(t *testing.T) {
		db := &fakeDB{}
		h := &Handler{RawSecret: "change-me-to-a-random-string",
			Settings: &settings.Store{DB: db}}
		got, err := h.probeRuntimeConfig(context.Background(), meta)
		if err != nil {
			t.Fatal(err)
		}
		if got.Status != "degraded" || got.Detail == nil ||
			*got.Detail != "3 configuration issue(s) need attention" {
			t.Errorf("component = %+v", got)
		}
		if issues, ok := got.Metrics["issues"].([]string); !ok || len(issues) != 3 {
			t.Errorf("issues = %v", got.Metrics["issues"])
		}
	})

	t.Run("configured deployment is healthy", func(t *testing.T) {
		db := &fakeDB{stubs: []stub{{match: "FROM enterprise_config WHERE key",
			argMatch: "deployment.frontend_url",
			rows:     [][]any{{"https://caracal.example.com"}}}}}
		h := &Handler{RawSecret: strings.Repeat("r", 48),
			AuthInternalSecret: "bridge-secret",
			Settings:           &settings.Store{DB: db}}
		got, err := h.probeRuntimeConfig(context.Background(), meta)
		if err != nil {
			t.Fatal(err)
		}
		if got.Status != "healthy" || got.Detail != nil {
			t.Errorf("component = %+v", got)
		}
	})

	t.Run("explicit development permits localhost", func(t *testing.T) {
		db := &fakeDB{}
		h := &Handler{
			RawSecret:          strings.Repeat("r", 48),
			AuthInternalSecret: "bridge-secret",
			Development:        true,
			Settings:           &settings.Store{DB: db},
		}
		got, err := h.probeRuntimeConfig(context.Background(), meta)
		if err != nil {
			t.Fatal(err)
		}
		if got.Status != "healthy" || got.Detail != nil {
			t.Errorf("component = %+v", got)
		}
	})
}

// statusHandler assembles a Handler whose probes all answer locally:
// healthy database, identity, and clickhouse; unreachable redis.
func statusHandler(t *testing.T) (*Handler, *chBackend) {
	t.Helper()
	db := &fakeDB{stubs: []stub{
		{match: "SELECT count(*) FROM users", rows: [][]any{{int64(3)}}},
		{match: "SELECT 1", rows: [][]any{{1}}},
		{match: "FROM enterprise_config WHERE key", argMatch: "deployment.frontend_url",
			rows: [][]any{{"https://caracal.example.com"}}},
	}}
	backend := &chBackend{}
	srv := jwksServer(t, 200, `{"keys":[{"kty":"EC"}]}`)
	return &Handler{
		DB:                 db,
		CH:                 newCHClient(t, backend),
		Redis:              deadRedis(),
		Settings:           &settings.Store{DB: db},
		RawSecret:          strings.Repeat("r", 48),
		AuthInternalSecret: "bridge-secret",
		Version:            "9.9.9-test",
		JWKSURL:            srv.URL,
		HTTP:               srv.Client(),
	}, backend
}

func TestSystemStatusEndToEnd(t *testing.T) {
	h, backend := statusHandler(t)

	w := httptest.NewRecorder()
	h.systemStatus(w, httptest.NewRequest("GET", "/api/v1/operator/status", nil))
	if w.Code != 200 {
		t.Fatalf("code = %d: %s", w.Code, w.Body.String())
	}
	var doc statusDocument
	if err := json.Unmarshal(w.Body.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Overall != "critical" || doc.Version != "9.9.9-test" {
		t.Errorf("overall/version = %q/%q", doc.Overall, doc.Version)
	}
	if strings.Join(doc.FailingComponents, ",") != "redis" {
		t.Errorf("failing = %v", doc.FailingComponents)
	}
	if len(doc.Components) != len(probeMetas) {
		t.Fatalf("components = %d", len(doc.Components))
	}
	byID := map[string]componentStatus{}
	for _, c := range doc.Components {
		byID[c.ID] = c
		if c.CheckedAt == "" {
			t.Errorf("component %s missing checked_at", c.ID)
		}
	}
	for id, want := range map[string]string{
		"database": "healthy", "identity": "healthy", "clickhouse": "healthy",
		"redis": "critical", "runtime_config": "healthy",
	} {
		if byID[id].Status != want {
			t.Errorf("%s = %q (detail %v), want %q", id, byID[id].Status, byID[id].Detail, want)
		}
	}

	probed := backend.requestCount()
	cached := httptest.NewRecorder()
	h.systemStatus(cached, httptest.NewRequest("GET", "/api/v1/operator/status", nil))
	if cached.Code != 200 || backend.requestCount() != probed {
		t.Errorf("cached read re-probed (requests %d -> %d)", probed, backend.requestCount())
	}

	forced := httptest.NewRecorder()
	h.systemStatus(forced, httptest.NewRequest("GET", "/api/v1/operator/status?force=true", nil))
	if forced.Code != 200 || backend.requestCount() != probed+1 {
		t.Errorf("force did not re-probe (requests %d -> %d)", probed, backend.requestCount())
	}

	garbage := httptest.NewRecorder()
	h.systemStatus(garbage, httptest.NewRequest("GET", "/api/v1/operator/status?force=banana", nil))
	if garbage.Code != 422 || !strings.Contains(garbage.Body.String(), "bool_parsing") {
		t.Errorf("garbage force: %d %s", garbage.Code, garbage.Body.String())
	}
}
