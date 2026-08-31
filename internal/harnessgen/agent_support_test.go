// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package harnessgen

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestSupportsAgentGate confirms every registered harness supports agents today
// and that an unknown harness is rejected rather than silently accepted.
func TestSupportsAgentGate(t *testing.T) {
	for _, h := range HarnessNames() {
		if !SupportsAgent(h) {
			t.Errorf("SupportsAgent(%q) = false, want true", h)
		}
	}
	if SupportsAgent("does-not-exist") {
		t.Error("SupportsAgent(unknown) = true, want false")
	}
}

// TestCompatibleHarnessWarnsAtGeneration verifies a compatibility-only harness
// surfaces a warning at agent generation, so the limitation reaches the user
// before they synchronize.
func TestCompatibleHarnessWarnsAtGeneration(t *testing.T) {
	cfg, err := Generate(testRequest("cursor"))
	if err != nil {
		t.Fatal(err)
	}
	raw, ok := cfg.Get("_warnings")
	if !ok {
		t.Fatal("cursor generation produced no _warnings")
	}
	blob, _ := json.Marshal(raw)
	if !strings.Contains(string(blob), "compatibility mechanism") {
		t.Errorf("cursor warnings missing compatibility note: %s", blob)
	}
}

// TestSingleAgentHarnessWarns verifies the single-agent (instruction-only)
// harness surfaces that multiple agents cannot coexist as selectable agents.
func TestSingleAgentHarnessWarns(t *testing.T) {
	cfg, err := Generate(testRequest("pi"))
	if err != nil {
		t.Fatal(err)
	}
	raw, ok := cfg.Get("_warnings")
	if !ok {
		t.Fatal("pi generation produced no _warnings")
	}
	blob, _ := json.Marshal(raw)
	if !strings.Contains(string(blob), "single agent/instruction set") {
		t.Errorf("pi warnings missing single-agent note: %s", blob)
	}
}

// TestNativeHarnessNoCompatibilityWarning confirms a native multi-agent harness
// does not emit the compatibility or single-agent notes.
func TestNativeHarnessNoCompatibilityWarning(t *testing.T) {
	cfg, err := Generate(testRequest("claude-code"))
	if err != nil {
		t.Fatal(err)
	}
	if raw, ok := cfg.Get("_warnings"); ok {
		blob, _ := json.Marshal(raw)
		if strings.Contains(string(blob), "compatibility mechanism") ||
			strings.Contains(string(blob), "single agent/instruction set") {
			t.Errorf("native harness emitted a compatibility/single-agent warning: %s", blob)
		}
	}
}
