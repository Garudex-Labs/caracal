// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"strings"
	"testing"
)

func TestHookAndSandboxListsRender(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /api/v1/hooks":     {body: `[{"id": "h1", "name": "Guard", "version": "1.0.0", "namespace": "acme"}]`},
		"GET /api/v1/sandboxes": {body: `[{"id": "sb1", "name": "Runner", "version": "1.0.0", "namespace": "acme"}]`},
	})
	out, err := runCLI(t, srv, "registry", "hook", "list")
	if err != nil || !strings.Contains(out, "Guard") {
		t.Errorf("hook list: %v\n%s", err, out)
	}
	out, err = runCLI(t, srv, "registry", "sandbox", "list")
	if err != nil || !strings.Contains(out, "Runner") {
		t.Errorf("sandbox list: %v\n%s", err, out)
	}
}

func TestMyComponentsEmptyMessage(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /api/v1/prompts/my": {body: `[]`},
	})
	out, err := runCLI(t, srv, "registry", "prompt", "my")
	if err != nil || !strings.Contains(out, "You have no prompts") {
		t.Errorf("prompt my: %v\n%s", err, out)
	}
}

func TestConfigPathAliasLifecycle(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	out, err := captureCLI(t, "config", "path")
	if err != nil || !strings.HasSuffix(strings.TrimSpace(out), ".caracal/config.json") {
		t.Errorf("config path: %v\n%s", err, out)
	}

	out, err = captureCLI(t, "config", "aliases")
	if err != nil || !strings.Contains(out, "No aliases set") {
		t.Errorf("empty aliases: %v\n%s", err, out)
	}

	out, err = captureCLI(t, "config", "alias", "wx", "acme/weather")
	if err != nil || !strings.Contains(out, "@wx") {
		t.Errorf("set alias: %v\n%s", err, out)
	}

	out, err = captureCLI(t, "config", "aliases")
	if err != nil || !strings.Contains(out, "acme/weather") {
		t.Errorf("aliases after set: %v\n%s", err, out)
	}
}
