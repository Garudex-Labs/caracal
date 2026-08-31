// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package harnessgen

import (
	"fmt"
	"strings"

	"github.com/garudex-labs/caracal/internal/harness"
)

// Generate renders the harness configuration for one agent install. The
// request must carry the resolved model and its warnings.
func Generate(req *Request) (*Config, error) {
	adapter, ok := adapters[req.Harness]
	if !ok {
		return nil, fmt.Errorf("no adapter registered for harness: %q", req.Harness)
	}
	if req.Options == nil {
		req.Options = map[string]any{}
	}
	safeName := sanitizeName(strOr(req.Options["local_name"], req.Agent.ItemSlug()))

	mcpConfigs := buildMcpConfigs(req, adapter)

	spec, _ := specOf(req.Harness)
	if spec != nil && !spec.SupportsAgents() {
		return nil, fmt.Errorf("harness %q does not support agents", req.Harness)
	}
	promptMode := harness.PromptUnsupported
	if spec != nil {
		promptMode = spec.PromptMode()
	}
	// Native harnesses receive a first-class prompt file, so the agent body
	// keeps prompts to a name list; every other mode inlines the template.
	promptListings := req.PromptListings
	if promptMode == harness.PromptNative {
		promptListings = nil
	}
	g := &generation{
		req:            req,
		safeName:       safeName,
		mcpConfigs:     mcpConfigs,
		rulesContent:   buildRulesContent(req, promptListings),
		skillConfigs:   buildSkillConfigs(req),
		hookConfigs:    buildHookConfigs(req),
		compatWarnings: compatibilityWarnings(req.Agent, req.Harness),
	}
	cfg := adapter.formatConfig(g)
	materializePrompts(cfg, g, promptMode)
	return cfg, nil
}

// materializePrompts applies the harness's declared prompt mode after the
// adapter renders its config. Native harnesses get dedicated prompt files;
// unsupported harnesses surface a warning instead of silently dropping the
// content; embedded harnesses already inlined the template via rules content.
func materializePrompts(cfg *Config, g *generation, mode harness.PromptMaterialization) {
	switch mode {
	case harness.PromptNative:
		spec, _ := specOf(g.req.Harness)
		if files := generatePromptFiles(g.req, spec); len(files) > 0 {
			cfg.Set("prompt_files", files)
		}
	case harness.PromptUnsupported:
		if n := promptComponentCount(g.req); n > 0 {
			appendConfigWarning(cfg, fmt.Sprintf(
				"%s does not support prompts; %d attached prompt component(s) were not materialized.",
				g.req.Harness, n))
		}
	}
}

// ResolveModel picks the model value a harness config should emit, plus any
// warnings about ignored or unsupported choices.
func ResolveModel(harnessName, modelName string, modelsByHarness map[string]any, override string) (string, []string) {
	warnings := []string{}
	supported, err := harness.SupportedModelIDs(harnessName)
	if err != nil || len(supported) == 0 {
		if override != "" {
			warnings = append(warnings, fmt.Sprintf(
				"%s does not accept a model choice; ignoring --model %s.", harnessName, override))
		}
		return "", warnings
	}
	adapter, ok := adapters[harnessName]
	if !ok {
		return "", warnings
	}
	candidate := override
	if candidate == "" {
		if v, ok := modelsByHarness[harnessName].(string); ok && v != "" {
			candidate = v
		} else {
			candidate = adapter.defaultModelCandidate(modelName)
		}
	}
	if candidate == "" || candidate == "inherit" {
		return "", warnings
	}
	formatted := adapter.formatModel(candidate, providerFor(supported, candidate))
	if !modelSupported(supported, formatted) {
		warnings = append(warnings, fmt.Sprintf(
			"Model '%s' is not in the %s harness registry. Falling back to auto/default.", candidate, harnessName))
		return "", warnings
	}
	return formatted, warnings
}

func providerFor(supported []string, model string) string {
	for _, rowID := range supported {
		if rowID != model {
			continue
		}
		switch {
		case strings.HasPrefix(model, "opencode/"):
			return "opencode"
		case strings.HasPrefix(model, "gemini"):
			return "google"
		case strings.HasPrefix(model, "gpt"):
			return "openai"
		case strings.HasPrefix(model, "claude"),
			model == "sonnet", model == "opus", model == "haiku",
			model == "fable", model == "best", model == "default":
			return "anthropic"
		}
	}
	return "anthropic"
}

func modelSupported(supported []string, candidate string) bool {
	for _, row := range supported {
		if row == candidate {
			return true
		}
		if idx := strings.Index(row, "<"); idx >= 0 && strings.HasPrefix(candidate, row[:idx]) {
			return true
		}
	}
	return false
}

// PreviewModel is the model an unresolved preview should emit for one
// harness: most emit nothing, but the adapter may map the stored name.
func PreviewModel(harnessName, modelName string) string {
	adapter, ok := adapters[harnessName]
	if !ok {
		return ""
	}
	return adapter.previewModelFallback(modelName)
}
