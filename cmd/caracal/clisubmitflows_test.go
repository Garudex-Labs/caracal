// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"strings"
	"testing"
)

const editUUID = "0656308f-8bba-472e-ab77-f96a7ac69fd2"

func TestSkillSubmitFlagModeJSON(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"POST /api/v1/skills/submit": {body: `{"id": "sk1", "status": "pending"}`},
	})
	recEnv(t, rec)
	out, err := captureCLI(t, "registry", "skill", "submit", "-o", "json",
		"--name", "Reviewer", "--description", "Reviews code", "--task-type", "code-review",
		"--git-url", "https://example.com/repo", "--harness", "claude-code")
	if err != nil {
		t.Fatalf("submit failed: %v", err)
	}
	if !strings.Contains(out, "sk1") {
		t.Errorf("server response not passed through:\n%s", out)
	}
	req, ok := rec.find("POST", "/api/v1/skills/submit")
	if !ok {
		t.Fatal("skill submit not recorded")
	}
	if !strings.Contains(req.Body, "Reviewer") || !strings.Contains(req.Body, "git_fetch") {
		t.Errorf("payload missing fields: %s", req.Body)
	}
}

func TestSkillSubmitDraft(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"POST /api/v1/skills/draft": {body: `{"id": "d1", "status": "draft"}`},
	})
	recEnv(t, rec)
	out, err := captureCLI(t, "registry", "skill", "submit",
		"--name", "Reviewer", "--description", "Reviews code",
		"--git-url", "https://example.com/repo", "--draft")
	if err != nil {
		t.Fatalf("draft failed: %v", err)
	}
	if !strings.Contains(out, "Draft submitted!") {
		t.Errorf("draft message missing:\n%s", out)
	}
	if _, ok := rec.find("POST", "/api/v1/skills/draft"); !ok {
		t.Error("skill draft not recorded")
	}
}

func TestHookSubmitFlagModeJSON(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"POST /api/v1/hooks/submit": {body: `{"id": "hk1", "status": "pending"}`},
	})
	recEnv(t, rec)
	out, err := captureCLI(t, "registry", "hook", "submit", "-o", "json",
		"--name", "Guard", "--description", "Guards tools", "--event", "PreToolUse",
		"--handler-command", "echo hi", "--harness", "claude-code")
	if err != nil {
		t.Fatalf("submit failed: %v", err)
	}
	if !strings.Contains(out, "hk1") {
		t.Errorf("server response not passed through:\n%s", out)
	}
	req, ok := rec.find("POST", "/api/v1/hooks/submit")
	if !ok {
		t.Fatal("hook submit not recorded")
	}
	if !strings.Contains(req.Body, "PreToolUse") {
		t.Errorf("payload missing event: %s", req.Body)
	}
}

func TestHookSubmitTimeoutExceedsCap(t *testing.T) {
	// blocking hooks cap at 30s; the local validation must reject 45s.
	rec := newRecordingAPI(t, map[string]apiResponse{})
	recEnv(t, rec)
	_, err := captureCLI(t, "registry", "hook", "submit",
		"--name", "Guard", "--description", "d", "--event", "PreToolUse",
		"--handler-command", "echo", "--execution-mode", "blocking", "--timeout", "45")
	cerr := asCLIError(t, err)
	if !strings.Contains(cerr.Message, "30s") {
		t.Errorf("message must mention the cap: %s", cerr.Message)
	}
	if len(rec.lines()) != 0 {
		t.Errorf("no request should be sent: %v", rec.lines())
	}
}

func TestPromptSubmitFlagModeJSON(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"POST /api/v1/prompts/submit": {body: `{"id": "pr1", "status": "pending"}`},
	})
	recEnv(t, rec)
	out, err := captureCLI(t, "registry", "prompt", "submit", "-o", "json",
		"--name", "Summ", "--description", "Summarize", "--template", "Do {{x}}")
	if err != nil {
		t.Fatalf("submit failed: %v", err)
	}
	if !strings.Contains(out, "pr1") {
		t.Errorf("server response not passed through:\n%s", out)
	}
	req, ok := rec.find("POST", "/api/v1/prompts/submit")
	if !ok {
		t.Fatal("prompt submit not recorded")
	}
	if !strings.Contains(req.Body, "Summarize") {
		t.Errorf("payload missing description: %s", req.Body)
	}
}

func TestSandboxSubmitFlagModeJSON(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"POST /api/v1/sandboxes/submit": {body: `{"id": "sb1", "status": "pending"}`},
	})
	recEnv(t, rec)
	out, err := captureCLI(t, "registry", "sandbox", "submit", "-o", "json",
		"--name", "Box", "--description", "A box", "--runtime-type", "docker",
		"--image", "alpine:3", "--harness", "claude-code")
	if err != nil {
		t.Fatalf("submit failed: %v", err)
	}
	if !strings.Contains(out, "sb1") {
		t.Errorf("server response not passed through:\n%s", out)
	}
	req, ok := rec.find("POST", "/api/v1/sandboxes/submit")
	if !ok {
		t.Fatal("sandbox submit not recorded")
	}
	if !strings.Contains(req.Body, "docker") {
		t.Errorf("payload missing runtime type: %s", req.Body)
	}
}

func TestMCPEditDraftFlow(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"GET /api/v1/mcps/" + editUUID:                  {body: `{"name": "Weather", "status": "draft", "version": "1.0.0"}`},
		"POST /api/v1/mcps/" + editUUID + "/start-edit": {body: `{}`},
		"PUT /api/v1/mcps/" + editUUID + "/draft":       {body: `{"name": "Weather", "status": "draft"}`},
	})
	recEnv(t, rec)
	out, err := captureCLI(t, "registry", "mcp", "edit", editUUID, "--name", "WeatherPro", "-o", "json")
	if err != nil {
		t.Fatalf("edit failed: %v", err)
	}
	if !strings.Contains(out, "Weather") {
		t.Errorf("response not passed through:\n%s", out)
	}
	if _, ok := rec.find("POST", "/api/v1/mcps/"+editUUID+"/start-edit"); !ok {
		t.Error("start-edit not recorded")
	}
	req, ok := rec.find("PUT", "/api/v1/mcps/"+editUUID+"/draft")
	if !ok {
		t.Fatal("draft PUT not recorded")
	}
	if !strings.Contains(req.Body, "WeatherPro") {
		t.Errorf("update body missing new name: %s", req.Body)
	}
}

func TestMCPEditApprovedPublishesVersion(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"GET /api/v1/mcps/" + editUUID:                {body: `{"name": "Weather", "status": "approved", "version": "1.2.0", "description": "old"}`},
		"POST /api/v1/mcps/" + editUUID + "/versions": {body: `{"version": "1.3.0"}`},
	})
	recEnv(t, rec)
	out, err := captureCLI(t, "registry", "mcp", "edit", editUUID,
		"--description", "new desc", "--bump", "minor", "-o", "json")
	if err != nil {
		t.Fatalf("edit failed: %v", err)
	}
	if !strings.Contains(out, "1.3.0") {
		t.Errorf("response not passed through:\n%s", out)
	}
	req, ok := rec.find("POST", "/api/v1/mcps/"+editUUID+"/versions")
	if !ok {
		t.Fatal("version POST not recorded")
	}
	if !strings.Contains(req.Body, "1.3.0") {
		t.Errorf("minor bump of 1.2.0 must be 1.3.0: %s", req.Body)
	}
}

func TestMCPSubmitDraftReference(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"POST /api/v1/mcps/" + editUUID + "/submit": {body: `{"id": "` + editUUID + `"}`},
	})
	recEnv(t, rec)
	out, err := captureCLI(t, "registry", "mcp", "submit", "--submit", editUUID, "-o", "json")
	if err != nil {
		t.Fatalf("submit draft failed: %v", err)
	}
	if !strings.Contains(out, editUUID) {
		t.Errorf("response not passed through:\n%s", out)
	}
	if _, ok := rec.find("POST", "/api/v1/mcps/"+editUUID+"/submit"); !ok {
		t.Error("draft submit not recorded")
	}
}

func TestMCPSubmitDraftConflict(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{})
	recEnv(t, rec)
	_, err := captureCLI(t, "registry", "mcp", "submit", "--draft", "--submit", editUUID)
	cerr := asCLIError(t, err)
	if !strings.Contains(cerr.Message, "Draft creation and draft submission") {
		t.Errorf("expected draft/submit conflict: %s", cerr.Message)
	}
}
