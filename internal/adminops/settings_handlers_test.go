// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package adminops

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var testSecretKey = []byte("0123456789abcdef0123456789abcdef")

func TestWireSetting(t *testing.T) {
	cases := []struct {
		name                          string
		stored, external              string
		sensitive, hasValue, isExt    bool
		wantValue                     string
		wantSet, wantSensitive, wantX bool
	}{
		{"plain stored", "v", "", false, true, false, "v", true, false, false},
		{"sensitive set redacts", "enc:x", "", true, true, false, Redacted, true, true, false},
		{"sensitive unset shows empty", "", "", true, false, false, "", false, true, false},
		{"external wins over stored", "db", "file", false, true, true, "file", true, false, true},
		{"external sensitive redacts", "", "file", true, true, true, Redacted, true, true, true},
	}
	for _, tc := range cases {
		got := wireSetting("k", tc.stored, tc.external, tc.sensitive, tc.hasValue, tc.isExt)
		if got.Value != tc.wantValue || got.IsSet != tc.wantSet ||
			got.IsSensitive != tc.wantSensitive || got.IsExternallyManaged != tc.wantX {
			t.Errorf("%s: wireSetting = %+v", tc.name, got)
		}
	}
}

func TestExternalValueFallsBackToDefault(t *testing.T) {
	h := &Handler{external: map[string]string{"insights.api_base": "https://llm.example.com"}}
	if got := h.externalValue("insights.api_base"); got != "https://llm.example.com" {
		t.Errorf("file-backed value = %q", got)
	}
	if got := h.externalValue("deployment.frontend_url"); got != "http://localhost:8000" {
		t.Errorf("string default = %q", got)
	}
	if got := h.externalValue("orgs.no_such_setting"); got != "" {
		t.Errorf("unknown key must be empty, got %q", got)
	}
}

func TestSettingsSchemaEndpoint(t *testing.T) {
	h := &Handler{}
	w := httptest.NewRecorder()
	h.settingsSchema(w, httptest.NewRequest("GET", "/api/v1/operator/settings/schema", nil))
	if w.Code != 200 {
		t.Fatalf("code = %d", w.Code)
	}
	var secs []map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &secs); err != nil {
		t.Fatal(err)
	}
	if len(secs) != len(sections) || secs[0]["id"] != "insights" {
		t.Fatalf("sections = %d, first = %v", len(secs), secs[0]["id"])
	}
	for _, sec := range secs {
		if sec["id"] == "danger" && sec["danger"] != true {
			t.Error("danger section missing its flag")
		}
	}
}

func TestListSettingsProjection(t *testing.T) {
	db := &fakeDB{stubs: []stub{{match: "FROM enterprise_config ORDER BY key", rows: [][]any{
		{"_system.restart_required", `{"keys":["x"]}`},
		{"deployment.public_url", "https://caracal.example.com"},
		{"insights.api_key", "enc:abc"},
		{"misc.default_harness", ""},
	}}}}
	h := &Handler{DB: db, external: map[string]string{
		"insights.api_base": "https://llm.example.com",
		"bogus.key":         "ignored",
	}}
	w := httptest.NewRecorder()
	h.listSettings(w, httptest.NewRequest("GET", "/api/v1/operator/settings", nil))
	if w.Code != 200 {
		t.Fatalf("code = %d: %s", w.Code, w.Body.String())
	}
	var out []settingResponse
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	want := []settingResponse{
		{Key: "deployment.public_url", Value: "https://caracal.example.com", IsSet: true},
		{Key: "insights.api_key", Value: Redacted, IsSensitive: true, IsSet: true},
		{Key: "misc.default_harness"},
		{Key: "insights.api_base", Value: "https://llm.example.com", IsSet: true, IsExternallyManaged: true},
	}
	if len(out) != len(want) {
		t.Fatalf("rows = %+v", out)
	}
	for i, w := range want {
		if out[i] != w {
			t.Errorf("row %d = %+v, want %+v", i, out[i], w)
		}
	}
}

func TestGetSetting(t *testing.T) {
	get := func(h *Handler, key string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		r := httptest.NewRequest("GET", "/api/v1/operator/settings/"+key, nil)
		r.SetPathValue("key", key)
		h.getSetting(w, r)
		return w
	}

	t.Run("missing setting answers 404", func(t *testing.T) {
		h := &Handler{DB: &fakeDB{}}
		if w := get(h, "misc.default_harness"); w.Code != 404 ||
			!strings.Contains(w.Body.String(), "Setting not found") {
			t.Errorf("missing: %d %s", w.Code, w.Body.String())
		}
	})

	t.Run("plain value round-trips", func(t *testing.T) {
		h := &Handler{DB: &fakeDB{stubs: []stub{{match: "FROM enterprise_config WHERE key",
			argMatch: "deployment.public_url", rows: [][]any{{"https://x"}}}}}}
		w := get(h, "deployment.public_url")
		var got settingResponse
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if got.Value != "https://x" || !got.IsSet || got.IsSensitive {
			t.Errorf("plain = %+v", got)
		}
	})

	t.Run("sensitive value is redacted on read", func(t *testing.T) {
		h := &Handler{DB: &fakeDB{stubs: []stub{{match: "FROM enterprise_config WHERE key",
			argMatch: "insights.api_key", rows: [][]any{{"enc:abc"}}}}}}
		w := get(h, "insights.api_key")
		if !strings.Contains(w.Body.String(), Redacted) ||
			strings.Contains(w.Body.String(), "enc:abc") {
			t.Errorf("sensitive read leaked: %s", w.Body.String())
		}
	})

	t.Run("external setting reads without a row", func(t *testing.T) {
		h := &Handler{DB: &fakeDB{},
			external: map[string]string{"insights.api_base": "https://llm.example.com"}}
		w := get(h, "insights.api_base")
		var got settingResponse
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if w.Code != 200 || got.Value != "https://llm.example.com" ||
			!got.IsSet || !got.IsExternallyManaged {
			t.Errorf("external = %d %+v", w.Code, got)
		}
	})
}

func upsertReq(key, body string) (*httptest.ResponseRecorder, func(h *Handler)) {
	w := httptest.NewRecorder()
	r := asAdmin(httptest.NewRequest("PUT", "/api/v1/operator/settings/"+key, strings.NewReader(body)))
	r.SetPathValue("key", key)
	return w, func(h *Handler) { h.upsertSetting(w, r) }
}

func TestUpsertSettingValidation(t *testing.T) {
	t.Run("missing value field fails before storage", func(t *testing.T) {
		db := &fakeDB{stubs: []stub{callerStub()}}
		w, run := upsertReq("misc.default_harness", `{}`)
		run(&Handler{DB: db})
		if w.Code != 422 || !strings.Contains(w.Body.String(), `"loc":["body","value"]`) {
			t.Errorf("missing value: %d %s", w.Code, w.Body.String())
		}
		if db.countStatements("INSERT") != 0 {
			t.Error("invalid body reached storage")
		}
	})

	t.Run("branding validation fails before storage", func(t *testing.T) {
		db := &fakeDB{stubs: []stub{callerStub()}}
		w, run := upsertReq("branding.app_name",
			fmt.Sprintf(`{"value":%q}`, strings.Repeat("x", 31)))
		run(&Handler{DB: db})
		if w.Code != 422 || !strings.Contains(w.Body.String(), "App name too long") {
			t.Errorf("branding: %d %s", w.Code, w.Body.String())
		}
		if db.countStatements("INSERT") != 0 {
			t.Error("rejected branding value reached storage")
		}
	})

	t.Run("externally managed key conflicts", func(t *testing.T) {
		db := &fakeDB{stubs: []stub{callerStub()}}
		w, run := upsertReq("insights.api_key", `{"value":"sk-x"}`)
		run(&Handler{DB: db, external: map[string]string{"insights.api_key": "file"}})
		if w.Code != 409 || !strings.Contains(w.Body.String(), "externally managed") {
			t.Errorf("external: %d %s", w.Code, w.Body.String())
		}
		if db.countStatements("INSERT") != 0 {
			t.Error("external conflict reached storage")
		}
	})

	t.Run("anonymous write is denied", func(t *testing.T) {
		db := &fakeDB{}
		w := httptest.NewRecorder()
		r := httptest.NewRequest("PUT", "/api/v1/operator/settings/misc.default_harness",
			strings.NewReader(`{"value":"x"}`))
		r.SetPathValue("key", "misc.default_harness")
		(&Handler{DB: db}).upsertSetting(w, r)
		if w.Code != 401 {
			t.Errorf("anonymous: %d", w.Code)
		}
	})
}

func TestUpsertSettingStoresTrimmedValue(t *testing.T) {
	db := &fakeDB{stubs: []stub{callerStub()}}
	w, run := upsertReq("misc.default_harness", `{"value":"  claude-code  "}`)
	run(&Handler{DB: db})
	if w.Code != 200 {
		t.Fatalf("code = %d: %s", w.Code, w.Body.String())
	}
	var got settingResponse
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Value != "claude-code" || !got.IsSet || got.IsSensitive {
		t.Errorf("response = %+v", got)
	}
	_, args, ok := db.statement("INSERT INTO enterprise_config")
	if !ok || args[0] != "misc.default_harness" || args[1] != "claude-code" {
		t.Errorf("stored args = %v (found %v)", args, ok)
	}
	if db.countStatements("_system.restart_required") != 0 {
		t.Error("non-restart key marked a restart")
	}
}

func TestUpsertSettingEncryptsSensitiveValue(t *testing.T) {
	db := &fakeDB{stubs: []stub{callerStub()}}
	w, run := upsertReq("insights.api_key", `{"value":"sk-live-abc"}`)
	run(&Handler{DB: db, SecretKey: testSecretKey})
	if w.Code != 200 {
		t.Fatalf("code = %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), Redacted) ||
		strings.Contains(w.Body.String(), "sk-live-abc") {
		t.Errorf("sensitive response leaked: %s", w.Body.String())
	}
	_, args, ok := db.statement("INSERT INTO enterprise_config")
	if !ok {
		t.Fatalf("no upsert issued: %v", db.log)
	}
	stored := fmt.Sprint(args[1])
	if !strings.HasPrefix(stored, encPrefix) || strings.Contains(stored, "sk-live-abc") {
		t.Errorf("stored value not encrypted: %q", stored)
	}
	if _, _, ok := db.statement("DELETE FROM enterprise_config WHERE key = ANY"); !ok {
		t.Error("deprecated provider settings were not retired")
	}
}

// pendingPayload finds the restart-pending upsert and returns its payload.
func pendingPayload(db *fakeDB) (string, bool) {
	for i, sql := range db.log {
		if !strings.Contains(sql, "INSERT INTO enterprise_config") {
			continue
		}
		if len(db.args[i]) > 1 && db.args[i][0] == restartPendingKey {
			return fmt.Sprint(db.args[i][1]), true
		}
	}
	return "", false
}

func TestUpsertSettingMarksRestartPending(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		callerStub(),
		{match: "FROM enterprise_config WHERE key", argMatch: restartPendingKey,
			rows: [][]any{{`{"changed_at":"2026-01-01T00:00:00.000000+00:00","keys":["data.cache_ttl_default"]}`}}},
	}}
	w, run := upsertReq("observability.log_format", `{"value":"console"}`)
	run(&Handler{DB: db})
	if w.Code != 200 {
		t.Fatalf("code = %d: %s", w.Code, w.Body.String())
	}
	payload, ok := pendingPayload(db)
	if !ok {
		t.Fatalf("restart-required change did not mark pending: %v", db.log)
	}
	var state struct {
		ChangedAt string   `json:"changed_at"`
		Keys      []string `json:"keys"`
	}
	if err := json.Unmarshal([]byte(payload), &state); err != nil {
		t.Fatal(err)
	}
	if strings.Join(state.Keys, ",") != "data.cache_ttl_default,observability.log_format" {
		t.Errorf("pending keys = %v, want merged sorted set", state.Keys)
	}
	if state.ChangedAt == "" {
		t.Error("pending payload missing changed_at")
	}
}

func TestUpsertSettingSkipsRestartWhenUnchanged(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		callerStub(),
		{match: "FROM enterprise_config WHERE key", argMatch: "observability.log_format",
			rows: [][]any{{"console"}}},
	}}
	w, run := upsertReq("observability.log_format", `{"value":"console"}`)
	run(&Handler{DB: db})
	if w.Code != 200 {
		t.Fatalf("code = %d: %s", w.Code, w.Body.String())
	}
	if _, ok := pendingPayload(db); ok {
		t.Error("unchanged value still marked a restart")
	}
}

func TestDeleteSetting(t *testing.T) {
	del := func(h *Handler, key string, authed bool) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		r := httptest.NewRequest("DELETE", "/api/v1/operator/settings/"+key, nil)
		if authed {
			r = asAdmin(r)
		}
		r.SetPathValue("key", key)
		h.deleteSetting(w, r)
		return w
	}

	t.Run("requires credentials", func(t *testing.T) {
		if w := del(&Handler{DB: &fakeDB{}}, "misc.default_harness", false); w.Code != 401 {
			t.Errorf("anonymous: %d", w.Code)
		}
	})

	t.Run("externally managed key conflicts", func(t *testing.T) {
		h := &Handler{DB: &fakeDB{stubs: []stub{callerStub()}},
			external: map[string]string{"insights.api_key": "file"}}
		if w := del(h, "insights.api_key", true); w.Code != 409 {
			t.Errorf("external: %d %s", w.Code, w.Body.String())
		}
	})

	t.Run("absent row answers 404", func(t *testing.T) {
		db := &fakeDB{stubs: []stub{callerStub()},
			execs: []execStub{{match: "DELETE FROM enterprise_config", affected: 0}}}
		if w := del(&Handler{DB: db}, "misc.default_harness", true); w.Code != 404 {
			t.Errorf("absent: %d %s", w.Code, w.Body.String())
		}
	})

	t.Run("delete of a restart-required key marks pending", func(t *testing.T) {
		db := &fakeDB{stubs: []stub{callerStub()}}
		w := del(&Handler{DB: db}, "misc.git_mirror_base_path", true)
		if w.Code != 200 ||
			strings.TrimSpace(w.Body.String()) != `{"deleted":"misc.git_mirror_base_path"}` {
			t.Fatalf("delete: %d %s", w.Code, w.Body.String())
		}
		if _, ok := pendingPayload(db); !ok {
			t.Error("restart-required delete did not mark pending")
		}
	})
}

func TestRevokeSetting(t *testing.T) {
	revoke := func(h *Handler, key string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		r := asAdmin(httptest.NewRequest("POST", "/api/v1/operator/settings/"+key+"/revoke", nil))
		r.SetPathValue("key", key)
		h.revokeSetting(w, r)
		return w
	}

	t.Run("non-sensitive keys cannot be revoked", func(t *testing.T) {
		db := &fakeDB{stubs: []stub{callerStub()}}
		w := revoke(&Handler{DB: db}, "deployment.public_url")
		if w.Code != 400 || !strings.Contains(w.Body.String(), "Only sensitive keys can be revoked") {
			t.Errorf("non-sensitive: %d %s", w.Code, w.Body.String())
		}
		if db.countStatements("DELETE") != 0 {
			t.Error("rejected revoke reached storage")
		}
	})

	t.Run("externally managed key conflicts", func(t *testing.T) {
		h := &Handler{DB: &fakeDB{stubs: []stub{callerStub()}},
			external: map[string]string{"insights.api_key": "file"}}
		if w := revoke(h, "insights.api_key"); w.Code != 409 {
			t.Errorf("external: %d %s", w.Code, w.Body.String())
		}
	})

	t.Run("unset secret answers 404", func(t *testing.T) {
		db := &fakeDB{stubs: []stub{callerStub()},
			execs: []execStub{{match: "DELETE FROM enterprise_config", affected: 0}}}
		w := revoke(&Handler{DB: db}, "insights.api_key")
		if w.Code != 404 || !strings.Contains(w.Body.String(), "already revoked") {
			t.Errorf("unset: %d %s", w.Code, w.Body.String())
		}
	})

	t.Run("revocation deletes and emits a critical event", func(t *testing.T) {
		backend := &chBackend{}
		db := &fakeDB{stubs: []stub{callerStub()}}
		h := &Handler{DB: db, CH: newCHClient(t, backend)}
		w := revoke(h, "insights.api_key")
		if w.Code != 200 || !strings.Contains(w.Body.String(), "permanently deleted") {
			t.Fatalf("revoke: %d %s", w.Code, w.Body.String())
		}
		if _, _, ok := db.statement("DELETE FROM enterprise_config"); !ok {
			t.Fatalf("no delete issued: %v", db.log)
		}
		if backend.requestCount() != 1 {
			t.Fatalf("security event inserts = %d", backend.requestCount())
		}
		insert := backend.body(0)
		lines := strings.SplitN(insert, "\n", 2)
		if !strings.Contains(lines[0], "INSERT INTO security_events") {
			t.Fatalf("insert statement = %q", lines[0])
		}
		var event map[string]any
		if err := json.Unmarshal([]byte(strings.TrimSpace(lines[1])), &event); err != nil {
			t.Fatal(err)
		}
		if event["event_type"] != "admin.setting.changed" || event["severity"] != "critical" ||
			event["target_id"] != "insights.api_key" ||
			event["actor_email"] != "admin@example.com" ||
			event["detail"] != "Sensitive setting revoked: insights.api_key" {
			t.Errorf("event = %v", event)
		}
	})
}

func TestSystemWarnings(t *testing.T) {
	warn := func(secret string) string {
		h := &Handler{RawSecret: secret}
		w := httptest.NewRecorder()
		h.systemWarnings(w, httptest.NewRequest("GET", "/api/v1/operator/system-warnings", nil))
		return strings.TrimSpace(w.Body.String())
	}
	for _, weak := range []string{"", "dev", "secret", "changeme",
		"change-me-to-a-random-string", "under-32-chars-but-random"} {
		if !strings.Contains(warn(weak), "weak_secret_key") {
			t.Errorf("secret %q raised no warning", weak)
		}
	}
	if got := warn(strings.Repeat("r", 48)); got != "[]" {
		t.Errorf("strong secret warnings = %s", got)
	}
}

func TestLoadExternal(t *testing.T) {
	write := func(t *testing.T, content string) string {
		t.Helper()
		path := filepath.Join(t.TempDir(), "secret")
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}

	t.Run("trailing newline is trimmed", func(t *testing.T) {
		for _, suffix := range []string{"\n", "\r\n", "\r", ""} {
			t.Setenv("INSIGHTS_API_KEY_FILE", write(t, "s3cret"+suffix))
			h := &Handler{}
			h.LoadExternal()
			if h.external["insights.api_key"] != "s3cret" {
				t.Errorf("suffix %q: value = %q", suffix, h.external["insights.api_key"])
			}
			if !h.isExternallyManaged("insights.api_key") {
				t.Error("loaded key not reported as externally managed")
			}
		}
	})

	t.Run("unset env leaves no external keys", func(t *testing.T) {
		t.Setenv("INSIGHTS_API_KEY_FILE", "")
		h := &Handler{}
		h.LoadExternal()
		if len(h.external) != 0 {
			t.Errorf("external = %v", h.external)
		}
	})

	t.Run("missing file is skipped", func(t *testing.T) {
		t.Setenv("INSIGHTS_API_KEY_FILE", filepath.Join(t.TempDir(), "absent"))
		h := &Handler{}
		h.LoadExternal()
		if len(h.external) != 0 {
			t.Errorf("external = %v", h.external)
		}
	})

	t.Run("oversized file is skipped", func(t *testing.T) {
		t.Setenv("INSIGHTS_API_KEY_FILE", write(t, strings.Repeat("x", 64*1024+1)))
		h := &Handler{}
		h.LoadExternal()
		if len(h.external) != 0 {
			t.Errorf("external = %v", h.external)
		}
	})
}
