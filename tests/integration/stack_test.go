// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package integration exercises the full request → DB → response cycle
// against a running Docker stack without mocking. The suite skips itself
// when the stack is not reachable (make up).
package integration

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
	"testing"
	"time"
)

var (
	baseURL       = envOr("INTEGRATION_BASE_URL", "http://localhost")
	adminEmail    = os.Getenv("INTEGRATION_ADMIN_EMAIL")
	adminPassword = os.Getenv("INTEGRATION_ADMIN_PASSWORD")

	httpClient = &http.Client{Timeout: 30 * time.Second}

	tokenOnce  sync.Once
	tokenValue string
	tokenSkip  string
	tokenErr   error
)

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

var (
	stackOnce sync.Once
	stackUp   bool
)

func requireStack(t *testing.T) {
	t.Helper()
	stackOnce.Do(func() {
		client := &http.Client{Timeout: 2 * time.Second}
		resp, err := client.Get(baseURL + "/health")
		if err != nil {
			return
		}
		_ = resp.Body.Close()
		stackUp = resp.StatusCode == 200
	})
	if !stackUp {
		t.Skip("Docker stack not running (make up)")
	}
}

type response struct {
	Status  int
	Body    []byte
	Headers http.Header
}

func (r response) json(t *testing.T) map[string]any {
	t.Helper()
	var doc map[string]any
	if err := json.Unmarshal(r.Body, &doc); err != nil {
		t.Fatalf("parse response %q: %v", truncated(r.Body), err)
	}
	return doc
}

func (r response) jsonList(t *testing.T) []map[string]any {
	t.Helper()
	var docs []map[string]any
	if err := json.Unmarshal(r.Body, &docs); err != nil {
		t.Fatalf("parse response list %q: %v", truncated(r.Body), err)
	}
	return docs
}

func truncated(body []byte) string {
	if len(body) > 300 {
		return string(body[:300]) + "..."
	}
	return string(body)
}

func request(t *testing.T, method, path string, payload any, headers map[string]string) response {
	t.Helper()
	var body io.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			t.Fatalf("marshal payload: %v", err)
		}
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, baseURL+path, body)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	return response{Status: resp.StatusCode, Body: data, Headers: resp.Header}
}

// identityLogin signs in through the identity service; the CSRF guard
// rejects requests without a real Origin.
func identityLogin(t *testing.T, email, password string) response {
	t.Helper()
	return request(t, http.MethodPost, "/api/auth/sign-in/email",
		map[string]string{"email": email, "password": password},
		map[string]string{"Origin": baseURL})
}

// adminToken logs in once per run to avoid rate limiting and exchanges the
// session for an API JWT.
func adminToken(t *testing.T) string {
	t.Helper()
	tokenOnce.Do(func() {
		if adminEmail == "" || adminPassword == "" {
			tokenSkip = "set INTEGRATION_ADMIN_EMAIL and INTEGRATION_ADMIN_PASSWORD to a provisioned admin account"
			return
		}
		for attempt := 0; attempt < 3; attempt++ {
			login := identityLogin(t, adminEmail, adminPassword)
			session := login.Headers.Get("set-auth-token")
			if login.Status == 200 && session != "" {
				exchange := request(t, http.MethodGet, "/api/auth/token", nil,
					map[string]string{"Authorization": "Bearer " + session})
				if exchange.Status != 200 {
					tokenErr = fmt.Errorf("token exchange failed: %s", truncated(exchange.Body))
					return
				}
				tokenValue, _ = exchange.json(t)["token"].(string)
				if tokenValue == "" {
					tokenErr = fmt.Errorf("token exchange returned no token")
				}
				return
			}
			if login.Status == 429 {
				time.Sleep(15 * time.Second)
				continue
			}
			tokenErr = fmt.Errorf("login failed: %d %s", login.Status, truncated(login.Body))
			return
		}
		tokenSkip = "identity service rate limited"
	})
	if tokenSkip != "" {
		t.Skip(tokenSkip)
	}
	if tokenErr != nil {
		t.Fatal(tokenErr)
	}
	return tokenValue
}

func adminHeaders(t *testing.T) map[string]string {
	t.Helper()
	return map[string]string{"Authorization": "Bearer " + adminToken(t)}
}

func submitMCP(t *testing.T, name, description string, headers map[string]string) response {
	t.Helper()
	return request(t, http.MethodPost, "/api/v1/mcps/submit", map[string]any{
		"name": name, "version": "1.0.0", "description": description,
		"owner": "admin", "category": "developer-tools",
		"git_url": "https://github.com/example/repo.git",
		"command": "node", "args": []string{"index.js"},
	}, headers)
}

func createAgent(t *testing.T, name, description string, headers map[string]string) response {
	t.Helper()
	return request(t, http.MethodPost, "/api/v1/agents", map[string]any{
		"name": name, "description": description, "version": "1.0.0",
		"owner": "admin", "model_name": "claude-sonnet-4-20250514",
		"prompt": "You are a test agent.",
	}, headers)
}

func randHex() string {
	buf := make([]byte, 4)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	return hex.EncodeToString(buf)
}

func uniqueName(prefix string) string {
	return fmt.Sprintf("%s-%s", prefix, randHex())
}

func randUUID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", buf[0:4], buf[4:6], buf[6:8], buf[8:10], buf[10:16])
}

// ── Auth round-trip ─────────────────────────────────────────────────────────

func TestLoginReturnsToken(t *testing.T) {
	requireStack(t)
	adminToken(t) // skips when the environment has no provisioned admin
	login := identityLogin(t, adminEmail, adminPassword)
	if login.Status == 429 {
		t.Skip("identity service rate limited")
	}
	if login.Status != 200 {
		t.Fatalf("login status = %d", login.Status)
	}
	session := login.Headers.Get("set-auth-token")
	if session == "" {
		t.Fatal("no session token header")
	}
	exchange := request(t, http.MethodGet, "/api/auth/token", nil,
		map[string]string{"Authorization": "Bearer " + session})
	if exchange.Status != 200 {
		t.Fatalf("exchange status = %d", exchange.Status)
	}
	if token, _ := exchange.json(t)["token"].(string); token == "" {
		t.Fatal("no token in exchange response")
	}
}

func TestWhoami(t *testing.T) {
	requireStack(t)
	resp := request(t, http.MethodGet, "/api/v1/auth/whoami", nil, adminHeaders(t))
	if resp.Status != 200 {
		t.Fatalf("whoami status = %d: %s", resp.Status, truncated(resp.Body))
	}
	doc := resp.json(t)
	if doc["email"] != adminEmail {
		t.Errorf("whoami email = %v", doc["email"])
	}
	if _, ok := doc["role"]; !ok {
		t.Error("whoami missing role")
	}
}

func TestLoginWrongPassword(t *testing.T) {
	requireStack(t)
	resp := identityLogin(t, adminEmail, "wrong-password-1")
	switch resp.Status {
	case 400, 401, 403, 429:
	default:
		t.Errorf("wrong-password status = %d", resp.Status)
	}
}

func TestWhoamiNoToken(t *testing.T) {
	requireStack(t)
	resp := request(t, http.MethodGet, "/api/v1/auth/whoami", nil, nil)
	if resp.Status != 401 && resp.Status != 403 {
		t.Errorf("unauthenticated whoami status = %d", resp.Status)
	}
}

// TestSessionReexchange verifies a session token can be exchanged repeatedly
// for fresh API JWTs.
func TestSessionReexchange(t *testing.T) {
	requireStack(t)
	adminToken(t)
	login := identityLogin(t, adminEmail, adminPassword)
	session := login.Headers.Get("set-auth-token")
	if login.Status == 429 || session == "" {
		t.Skip("identity service rate limited")
	}
	auth := map[string]string{"Authorization": "Bearer " + session}
	first := request(t, http.MethodGet, "/api/auth/token", nil, auth)
	second := request(t, http.MethodGet, "/api/auth/token", nil, auth)
	if first.Status != 200 || second.Status != 200 {
		t.Fatalf("re-exchange statuses = %d, %d", first.Status, second.Status)
	}
	if token, _ := second.json(t)["token"].(string); token == "" {
		t.Fatal("second exchange returned no token")
	}
}

// ── MCP CRUD lifecycle ──────────────────────────────────────────────────────

func TestMcpSubmit(t *testing.T) {
	requireStack(t)
	headers := adminHeaders(t)
	name := uniqueName("integ-mcp")
	resp := request(t, http.MethodPost, "/api/v1/mcps/submit", map[string]any{
		"name": name, "version": "1.0.0", "description": "Integration test MCP",
		"owner": "admin", "category": "developer-tools",
		"git_url": "https://github.com/example/repo.git",
		"command": "node", "args": []string{"index.js"},
		"environment_variables": []map[string]any{
			{"name": "API_KEY", "description": "Key", "required": true},
		},
	}, headers)
	if resp.Status != 200 {
		t.Fatalf("submit failed: %d %s", resp.Status, truncated(resp.Body))
	}
	doc := resp.json(t)
	if doc["name"] != name || doc["status"] != "pending" {
		t.Errorf("submit response = %v", doc)
	}
}

func TestMcpGetByName(t *testing.T) {
	requireStack(t)
	headers := adminHeaders(t)
	name := uniqueName("integ-mcp")
	submitMCP(t, name, "Test", headers)
	resp := request(t, http.MethodGet, "/api/v1/mcps/"+name, nil, headers)
	if resp.Status != 200 {
		t.Fatalf("get status = %d", resp.Status)
	}
	if resp.json(t)["name"] != name {
		t.Errorf("get returned %v", resp.json(t)["name"])
	}
}

func TestMcpApprove(t *testing.T) {
	requireStack(t)
	headers := adminHeaders(t)
	name := uniqueName("integ-mcp")
	submitMCP(t, name, "Test approve", headers)
	approve := request(t, http.MethodPost, "/api/v1/review/"+name+"/approve", nil, headers)
	if approve.Status != 200 {
		t.Fatalf("approve failed: %d %s", approve.Status, truncated(approve.Body))
	}
	if approve.json(t)["status"] != "approved" {
		t.Errorf("approve response = %v", approve.json(t))
	}
	verify := request(t, http.MethodGet, "/api/v1/mcps/"+name, nil, headers)
	if verify.json(t)["status"] != "approved" {
		t.Errorf("status after approve = %v", verify.json(t)["status"])
	}
}

func TestMcpSubmitInvalidCategory(t *testing.T) {
	requireStack(t)
	headers := adminHeaders(t)
	resp := request(t, http.MethodPost, "/api/v1/mcps/submit", map[string]any{
		"name": uniqueName("integ-mcp"), "version": "1.0.0", "description": "Bad category",
		"owner": "admin", "category": "not-a-real-category",
		"git_url": "https://github.com/example/repo.git",
		"command": "node", "args": []string{"index.js"},
	}, headers)
	if resp.Status != 422 {
		t.Errorf("invalid category status = %d", resp.Status)
	}
}

// ── Agent lifecycle ─────────────────────────────────────────────────────────

func TestAgentCreateApproveList(t *testing.T) {
	requireStack(t)
	headers := adminHeaders(t)
	name := uniqueName("integ-agent")
	created := createAgent(t, name, "Integration test agent", headers)
	if created.Status != 200 {
		t.Fatalf("create failed: %d %s", created.Status, truncated(created.Body))
	}
	agentID, _ := created.json(t)["id"].(string)

	approve := request(t, http.MethodPost, "/api/v1/review/agents/"+agentID+"/approve", nil, headers)
	if approve.Status != 200 {
		t.Fatalf("approve failed: %d %s", approve.Status, truncated(approve.Body))
	}

	list := request(t, http.MethodGet, "/api/v1/agents", nil, headers)
	found := false
	for _, agent := range list.jsonList(t) {
		if agent["name"] == name {
			found = true
		}
	}
	if !found {
		t.Errorf("agent %s missing from list", name)
	}
}

func TestAgentDeleteRestoreConflict(t *testing.T) {
	requireStack(t)
	headers := adminHeaders(t)
	name := uniqueName("integ-agent")
	created := createAgent(t, name, "To delete", headers)
	agentID, _ := created.json(t)["id"].(string)

	deleted := request(t, http.MethodDelete, "/api/v1/agents/"+name, nil, headers)
	if deleted.Status != 200 {
		t.Fatalf("delete status = %d", deleted.Status)
	}
	missing := request(t, http.MethodGet, "/api/v1/agents/"+name, nil, headers)
	if missing.Status != 404 {
		t.Errorf("get after delete = %d", missing.Status)
	}

	deletedList := request(t, http.MethodGet, "/api/v1/agents/deleted", nil, headers)
	if deletedList.Status != 200 {
		t.Fatalf("deleted list status = %d", deletedList.Status)
	}
	found := false
	for _, agent := range deletedList.jsonList(t) {
		if agent["name"] == name {
			found = true
		}
	}
	if !found {
		t.Errorf("deleted list missing %s", name)
	}

	recreated := createAgent(t, name, "Reused name", headers)
	if recreated.Status != 200 {
		t.Fatalf("recreate status = %d %s", recreated.Status, truncated(recreated.Body))
	}
	restore := request(t, http.MethodPatch, "/api/v1/agents/"+agentID+"/restore", map[string]any{}, headers)
	if restore.Status != 409 {
		t.Errorf("restore over reused name = %d, want 409", restore.Status)
	}
}

// ── Prompt CRUD ─────────────────────────────────────────────────────────────

func TestPromptSubmitAndGet(t *testing.T) {
	requireStack(t)
	headers := adminHeaders(t)
	name := uniqueName("integ-prompt")
	resp := request(t, http.MethodPost, "/api/v1/prompts/submit", map[string]any{
		"name": name, "version": "1.0.0", "description": "Integration test prompt",
		"owner": "admin", "category": "general",
		"template": "You are a helpful assistant. Summarize: {{input}}",
	}, headers)
	if resp.Status != 200 {
		t.Fatalf("submit failed: %d %s", resp.Status, truncated(resp.Body))
	}
	get := request(t, http.MethodGet, "/api/v1/prompts/"+name, nil, headers)
	if get.Status != 200 || get.json(t)["name"] != name {
		t.Errorf("get prompt = %d %v", get.Status, get.json(t)["name"])
	}
}

// ── List / sort / pagination ────────────────────────────────────────────────

func TestListMcpsWithLimit(t *testing.T) {
	requireStack(t)
	resp := request(t, http.MethodGet, "/api/v1/mcps?limit=2", nil, adminHeaders(t))
	if resp.Status != 200 {
		t.Fatalf("list status = %d", resp.Status)
	}
	resp.jsonList(t)
}

func TestListMcpsWithSearch(t *testing.T) {
	requireStack(t)
	headers := adminHeaders(t)
	name := uniqueName("searchable")
	submitMCP(t, name, "Searchable", headers)
	request(t, http.MethodPost, "/api/v1/review/"+name+"/approve", nil, headers)

	resp := request(t, http.MethodGet, "/api/v1/mcps?search="+name, nil, headers)
	if resp.Status != 200 {
		t.Fatalf("search status = %d", resp.Status)
	}
	found := false
	for _, mcp := range resp.jsonList(t) {
		if mcp["name"] == name {
			found = true
		}
	}
	if !found {
		t.Errorf("search results missing %s", name)
	}
}

// ── RBAC ────────────────────────────────────────────────────────────────────

func TestUnauthenticatedCannotSubmit(t *testing.T) {
	requireStack(t)
	resp := submitMCP(t, "should-fail", "No auth", nil)
	if resp.Status != 401 && resp.Status != 403 {
		t.Errorf("unauthenticated submit = %d", resp.Status)
	}
}

func TestUnauthenticatedCannotApprove(t *testing.T) {
	requireStack(t)
	resp := request(t, http.MethodPost, "/api/v1/review/anything/approve", nil, nil)
	if resp.Status != 401 && resp.Status != 403 {
		t.Errorf("unauthenticated approve = %d", resp.Status)
	}
}

// ── Error cases ─────────────────────────────────────────────────────────────

func TestMissingRequiredFields(t *testing.T) {
	requireStack(t)
	resp := request(t, http.MethodPost, "/api/v1/mcps/submit", map[string]any{"name": "x"}, adminHeaders(t))
	if resp.Status != 422 {
		t.Errorf("missing fields status = %d", resp.Status)
	}
}

func TestGetNonexistentMcp(t *testing.T) {
	requireStack(t)
	resp := request(t, http.MethodGet, "/api/v1/mcps/"+randUUID(), nil, adminHeaders(t))
	if resp.Status != 404 {
		t.Errorf("nonexistent mcp status = %d: %s", resp.Status, truncated(resp.Body))
	}
}

func TestApproveNonexistent(t *testing.T) {
	requireStack(t)
	resp := request(t, http.MethodPost, "/api/v1/review/"+randUUID()+"/approve", nil, adminHeaders(t))
	if resp.Status != 404 {
		t.Errorf("nonexistent approve status = %d: %s", resp.Status, truncated(resp.Body))
	}
}
