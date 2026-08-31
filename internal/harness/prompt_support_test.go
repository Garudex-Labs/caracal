// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package harness

import "testing"

// TestPromptSupportMapping locks the public support level and support gate for
// every harness: native for the four documented prompt/command harnesses,
// compatible (embedded) for the rest. Embedding is never reported as native.
func TestPromptSupportMapping(t *testing.T) {
	reg := MustLoad()
	want := map[string]string{
		"claude-code": "native",
		"copilot":     "native",
		"codex":       "native",
		"cursor":      "native",
		"kiro":        "compatible",
		"copilot-cli": "compatible",
		"opencode":    "compatible",
		"antigravity": "compatible",
		"goose":       "compatible",
		"pi":          "compatible",
	}
	for name, support := range want {
		spec, ok := reg.Spec(name)
		if !ok {
			t.Fatalf("no spec for %s", name)
		}
		if got := spec.PromptSupport(); got != support {
			t.Errorf("%s PromptSupport = %q, want %q", name, got, support)
		}
		if !spec.SupportsRegistryPrompts() {
			t.Errorf("%s SupportsRegistryPrompts = false, want true", name)
		}
		if spec.PromptMechanism() == "" {
			t.Errorf("%s PromptMechanism empty for a supported harness", name)
		}
	}
}

// TestPromptMechanismNativeVsCompatible confirms native harnesses expose their
// concrete prompt-file format and compatible harnesses expose the embedded
// mechanism, keeping the two visibly distinct.
func TestPromptMechanismNativeVsCompatible(t *testing.T) {
	reg := MustLoad()
	claude, _ := reg.Spec("claude-code")
	if got := claude.PromptMechanism(); got != "claude_command" {
		t.Errorf("claude-code PromptMechanism = %q, want claude_command", got)
	}
	kiro, _ := reg.Spec("kiro")
	if got := kiro.PromptMechanism(); got != "agent_instructions" {
		t.Errorf("kiro PromptMechanism = %q, want agent_instructions", got)
	}
}

// TestUnsupportedPromptGate guards the enforcement contract: a spec with no
// prompt declaration is unsupported and the gate refuses it, so a future
// harness can never silently drop prompt content.
func TestUnsupportedPromptGate(t *testing.T) {
	var s Spec
	if s.PromptSupport() != "unsupported" {
		t.Errorf("empty spec PromptSupport = %q, want unsupported", s.PromptSupport())
	}
	if s.SupportsRegistryPrompts() {
		t.Error("empty spec must not support registry prompts")
	}
	if s.PromptMechanism() != "" {
		t.Errorf("unsupported PromptMechanism = %q, want empty", s.PromptMechanism())
	}
}
