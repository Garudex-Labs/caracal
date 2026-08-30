// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Command refreshmodels refreshes the vendored harness model catalogs under
// packages/harness-data/harness_models/.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf16"
)

const (
	piModelsURL    = "https://raw.githubusercontent.com/earendil-works/pi/main/packages/ai/src/models.generated.ts"
	opencodeZenURL = "https://opencode.ai/zen/v1/models"
)

type model = map[string]any

func fatal(err error) {
	fmt.Fprintf(os.Stderr, "error: %v\n", err)
	os.Exit(1)
}

// findRoot walks up from the working directory to the repository root.
func findRoot() string {
	dir, err := os.Getwd()
	if err != nil {
		return "."
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "."
		}
		dir = parent
	}
}

func fetch(url string) (string, error) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "Caracal model refresher")
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("GET %s: HTTP %d", url, resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	return string(body), nil
}

// ── JSON output (2-space indent, sorted keys, ASCII-escaped) ─────────────────

func encodeString(b *strings.Builder, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		default:
			switch {
			case r < 0x20 || r >= 0x7f && r <= 0xffff:
				fmt.Fprintf(b, `\u%04x`, r)
			case r > 0xffff:
				hi, lo := utf16.EncodeRune(r)
				fmt.Fprintf(b, `\u%04x\u%04x`, hi, lo)
			default:
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
}

func writeValue(b *strings.Builder, v any, indent int) {
	pad := strings.Repeat("  ", indent)
	childPad := strings.Repeat("  ", indent+1)
	switch t := v.(type) {
	case map[string]any:
		if len(t) == 0 {
			b.WriteString("{}")
			return
		}
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		b.WriteString("{\n")
		for i, key := range keys {
			b.WriteString(childPad)
			encodeString(b, key)
			b.WriteString(": ")
			writeValue(b, t[key], indent+1)
			if i < len(keys)-1 {
				b.WriteByte(',')
			}
			b.WriteByte('\n')
		}
		b.WriteString(pad)
		b.WriteByte('}')
	case []any:
		if len(t) == 0 {
			b.WriteString("[]")
			return
		}
		b.WriteString("[\n")
		for i, item := range t {
			b.WriteString(childPad)
			writeValue(b, item, indent+1)
			if i < len(t)-1 {
				b.WriteByte(',')
			}
			b.WriteByte('\n')
		}
		b.WriteString(pad)
		b.WriteByte(']')
	case []string:
		items := make([]any, len(t))
		for i, s := range t {
			items[i] = s
		}
		writeValue(b, items, indent)
	case string:
		encodeString(b, t)
	case int:
		fmt.Fprintf(b, "%d", t)
	case bool:
		if t {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case nil:
		b.WriteString("null")
	default:
		fmt.Fprintf(b, "%v", t)
	}
}

func write(outDir, name string, models []any, extra map[string]any) {
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		fatal(err)
	}
	doc := map[string]any{
		"harness":    name,
		"updated_at": time.Now().Format("2006-01-02"),
		"models":     models,
	}
	for k, v := range extra {
		doc[k] = v
	}
	var b strings.Builder
	writeValue(&b, doc, 0)
	b.WriteByte('\n')
	if err := os.WriteFile(filepath.Join(outDir, name+".json"), []byte(b.String()), 0o644); err != nil {
		fatal(err)
	}
}

// ── Remote catalogs ──────────────────────────────────────────────────────────

var (
	piProviderRe = regexp.MustCompile(`(?m)^\t"([^"]+)": \{`)
	piModelRe    = regexp.MustCompile(`(?s)\n\t\t"([^"]+)": \{(.*?)\n\t\t\}`)
	piNameRe     = regexp.MustCompile(`\n\t\t\tname: "([^"]+)"`)
)

func piModels() ([]any, map[string]any, error) {
	text, err := fetch(piModelsURL)
	if err != nil {
		return nil, nil, err
	}
	var providers []string
	for _, m := range piProviderRe.FindAllStringSubmatch(text, -1) {
		providers = append(providers, m[1])
	}
	var rows []any
	for _, provider := range providers {
		start := strings.Index(text, "\t\""+provider+"\": {")
		if start == -1 {
			continue
		}
		relEnd := strings.Index(text[start:], "\n\t},")
		var block string
		if relEnd == -1 {
			block = text[start : len(text)-1]
		} else {
			block = text[start : start+relEnd]
		}
		for _, m := range piModelRe.FindAllStringSubmatch(block, -1) {
			mid, body := m[1], m[2]
			label := mid
			if lm := piNameRe.FindStringSubmatch(body); lm != nil {
				label = lm[1]
			}
			rows = append(rows, model{
				"id":       provider + "/" + mid,
				"label":    label,
				"provider": provider,
				"kind":     "exact",
			})
		}
	}
	rows = append(rows,
		model{
			"id":       "models-json:<provider>/<model-id>",
			"label":    "Custom provider model from ~/.pi/agent/models.json",
			"provider": "custom",
			"kind":     "provider_source",
		},
		model{
			"id":       "litellm:<model-id>",
			"label":    "LiteLLM-discovered model",
			"provider": "litellm",
			"kind":     "provider_source",
		},
	)
	return rows, map[string]any{"source": piModelsURL, "provider_count": len(providers)}, nil
}

func opencodeModels() ([]any, error) {
	raw, err := fetch(opencodeZenURL)
	if err != nil {
		return nil, err
	}
	idx := strings.Index(raw, "{")
	if idx == -1 {
		return nil, fmt.Errorf("GET %s: no JSON object in response", opencodeZenURL)
	}
	var payload struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal([]byte(raw[idx:]), &payload); err != nil {
		return nil, fmt.Errorf("GET %s: %w", opencodeZenURL, err)
	}
	var rows []any
	for _, m := range payload.Data {
		id, ok := m["id"].(string)
		if !ok {
			return nil, fmt.Errorf("GET %s: model entry without an 'id'", opencodeZenURL)
		}
		rows = append(rows, model{
			"id":       "opencode/" + id,
			"label":    id,
			"provider": "opencode",
			"kind":     "exact",
		})
	}
	rows = append(rows, model{
		"id":       "<provider>/<model-id>",
		"label":    "Configured OpenCode provider model",
		"provider": "custom",
		"kind":     "provider_source",
	})
	return rows, nil
}

// ── Static catalogs ──────────────────────────────────────────────────────────

func exactModels(provider string, ids []string) []any {
	rows := make([]any, 0, len(ids))
	for _, id := range ids {
		rows = append(rows, model{"id": id, "label": id, "provider": provider, "kind": "exact"})
	}
	return rows
}

func staticCatalogs() ([]string, map[string][]any) {
	claudeAliases := map[string]bool{
		"default": true, "best": true, "fable": true, "opus": true, "sonnet": true,
		"haiku": true, "opusplan": true, "inherit": true, "sonnet[1m]": true,
		"opus[1m]": true, "opusplan[1m]": true,
	}
	var claudeModels []any
	for _, id := range []string{
		"default", "best", "fable", "opus", "sonnet", "haiku", "opusplan", "inherit",
		"sonnet[1m]", "opus[1m]", "opusplan[1m]",
		"claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6",
		"claude-sonnet-4-6", "claude-sonnet-4-5", "claude-haiku-4-5",
	} {
		kind := "exact"
		if claudeAliases[id] {
			kind = "alias"
		}
		claudeModels = append(claudeModels, model{"id": id, "label": id, "provider": "anthropic", "kind": kind})
	}

	codexModels := exactModels("openai", []string{
		"gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano",
		"gpt-5.3-codex", "gpt-5.3-codex-spark",
		"gpt-5.2", "gpt-5.2-codex",
		"gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-max", "gpt-5.1-codex-mini",
	})
	codexModels = append(codexModels,
		model{
			"id":       "model_providers.<id>:<model>",
			"label":    "Custom Codex model provider",
			"provider": "custom",
			"kind":     "provider_source",
		},
		model{
			"id":       "amazon-bedrock:<bedrock-model-id>",
			"label":    "Amazon Bedrock model",
			"provider": "amazon-bedrock",
			"kind":     "provider_source",
		},
		model{"id": "ollama:<model>", "label": "Ollama model", "provider": "ollama", "kind": "provider_source"},
		model{"id": "lmstudio:<model>", "label": "LM Studio model", "provider": "lmstudio", "kind": "provider_source"},
	)

	order := []string{"cursor", "kiro", "claude-code", "codex", "copilot", "copilot-cli", "antigravity", "goose"}
	catalogs := map[string][]any{
		"cursor": exactModels("cursor", []string{
			"auto", "composer-2.5", "composer-2",
			"gpt-5.5", "gpt-5.5-fast", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano",
			"gpt-5.3-codex", "gpt-5.3-codex-high",
			"claude-fable-5", "claude-opus-4-8", "claude-opus-4-8-fast", "claude-sonnet-4-6",
			"gemini-3.5-flash", "gemini-3.1-pro", "gemini-3-flash",
			"grok-build-0.1", "inherit",
		}),
		"kiro": exactModels("kiro", []string{
			"auto",
			"claude-sonnet-4", "claude-sonnet-4-5", "claude-sonnet-4-6",
			"claude-haiku-4-5",
			"claude-opus-4-5", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8",
			"minimax-m2.5", "minimax-m2.1", "glm-5", "deepseek-3.2", "qwen3-coder-next",
		}),
		"claude-code": claudeModels,
		"codex":       codexModels,
		"copilot": exactModels("github", []string{
			"auto", "claude-sonnet-4.5", "claude-opus-4.7", "claude-haiku-4.5",
			"gemini-3.1-pro", "gemini-3.5-flash", "gpt-5.4-mini",
		}),
		"copilot-cli": {
			model{"id": "auto", "label": "Auto", "provider": "github", "kind": "exact"},
			model{
				"id":       "COPILOT_PROVIDER_TYPE=openai;COPILOT_MODEL=<model>",
				"label":    "OpenAI-compatible BYOK model",
				"provider": "openai",
				"kind":     "provider_source",
			},
			model{
				"id":       "COPILOT_PROVIDER_TYPE=azure;COPILOT_MODEL=<deployment>",
				"label":    "Azure OpenAI deployment",
				"provider": "azure",
				"kind":     "provider_source",
			},
			model{
				"id":       "COPILOT_PROVIDER_TYPE=anthropic;COPILOT_MODEL=<claude-model>",
				"label":    "Anthropic BYOK model",
				"provider": "anthropic",
				"kind":     "provider_source",
			},
		},
		"antigravity": {
			model{
				"id": "gemini-3.5-flash", "label": "Gemini 3.5 Flash", "provider": "google",
				"kind": "exact", "efforts": []string{"low", "medium", "high"},
			},
			model{
				"id": "gemini-3.1-pro", "label": "Gemini 3.1 Pro", "provider": "google",
				"kind": "exact", "efforts": []string{"low", "high"},
			},
			model{"id": "gemini-3-flash", "label": "Gemini 3 Flash", "provider": "google", "kind": "exact"},
			model{
				"id": "claude-sonnet-4-6", "label": "Claude Sonnet 4.6", "provider": "anthropic",
				"kind": "exact", "efforts": []string{"thinking"},
			},
			model{
				"id": "claude-opus-4-6", "label": "Claude Opus 4.6", "provider": "anthropic",
				"kind": "exact", "efforts": []string{"thinking"},
			},
			model{
				"id": "gpt-oss-120b-maas", "label": "GPT-OSS 120B", "provider": "openai",
				"kind": "exact", "efforts": []string{"medium"},
			},
			model{"id": "antigravity-preview-05-2026", "label": "Antigravity Agent API", "provider": "google", "kind": "exact"},
			model{
				"id":       "gemini-enterprise:<model-id>",
				"label":    "Gemini Enterprise Agent Platform model",
				"provider": "google-cloud",
				"kind":     "provider_source",
			},
		},
		"goose": {
			model{"id": "claude-opus-4-8", "label": "Claude Opus 4.8", "provider": "anthropic", "kind": "exact"},
			model{"id": "claude-sonnet-4-6", "label": "Claude Sonnet 4.6", "provider": "anthropic", "kind": "exact"},
			model{"id": "claude-haiku-4-5", "label": "Claude Haiku 4.5", "provider": "anthropic", "kind": "exact"},
			model{"id": "gpt-5.5", "label": "GPT-5.5", "provider": "openai", "kind": "exact"},
			model{"id": "gpt-5.4", "label": "GPT-5.4", "provider": "openai", "kind": "exact"},
			model{"id": "gemini-3.1-pro", "label": "Gemini 3.1 Pro", "provider": "google", "kind": "exact"},
			model{"id": "gemini-3.5-flash", "label": "Gemini 3.5 Flash", "provider": "google", "kind": "exact"},
			// goose stores the bare provider model name, so BYO models are matched by family prefix.
			model{
				"id":       "claude-<model-id>",
				"label":    "Anthropic model from the configured goose provider",
				"provider": "anthropic",
				"kind":     "provider_source",
			},
			model{
				"id":       "gpt-<model-id>",
				"label":    "OpenAI model from the configured goose provider",
				"provider": "openai",
				"kind":     "provider_source",
			},
			model{
				"id":       "gemini-<model-id>",
				"label":    "Google model from the configured goose provider",
				"provider": "google",
				"kind":     "provider_source",
			},
			model{
				"id":       "grok-<model-id>",
				"label":    "xAI model from the configured goose provider",
				"provider": "xai",
				"kind":     "provider_source",
			},
		},
	}
	return order, catalogs
}

// ── Self-check ───────────────────────────────────────────────────────────────

type storedCatalog struct {
	ProviderCount int `json:"provider_count"`
	Models        []struct {
		ID string `json:"id"`
	} `json:"models"`
}

func readCatalog(outDir, name string) storedCatalog {
	raw, err := os.ReadFile(filepath.Join(outDir, name+".json"))
	if err != nil {
		fatal(err)
	}
	var cat storedCatalog
	if err := json.Unmarshal(raw, &cat); err != nil {
		fatal(err)
	}
	return cat
}

func runChecks(outDir string) {
	pi := readCatalog(outDir, "pi")
	if pi.ProviderCount < 30 || len(pi.Models) < 900 {
		fatal(fmt.Errorf("check failed: pi catalog too small (%d providers, %d models)",
			pi.ProviderCount, len(pi.Models)))
	}
	oc := readCatalog(outDir, "opencode")
	found := false
	for _, m := range oc.Models {
		if strings.HasPrefix(m.ID, "opencode/") {
			found = true
			break
		}
	}
	if !found {
		fatal(fmt.Errorf("check failed: opencode catalog has no opencode/ models"))
	}
	ag := readCatalog(outDir, "antigravity")
	found = false
	for _, m := range ag.Models {
		if m.ID == "gemini-enterprise:<model-id>" {
			found = true
			break
		}
	}
	if !found {
		fatal(fmt.Errorf("check failed: antigravity catalog is missing gemini-enterprise:<model-id>"))
	}
}

func main() {
	check := flag.Bool("check", false, "validate the refreshed catalogs")
	flag.Parse()
	if flag.NArg() > 0 {
		fmt.Fprintf(os.Stderr, "unexpected arguments: %s\n", strings.Join(flag.Args(), " "))
		os.Exit(2)
	}

	outDir := filepath.Join(findRoot(), "packages", "harness-data", "harness_models")

	order, catalogs := staticCatalogs()
	for _, name := range order {
		write(outDir, name, catalogs[name], nil)
	}

	pi, meta, err := piModels()
	if err != nil {
		fatal(err)
	}
	write(outDir, "pi", pi, meta)

	oc, err := opencodeModels()
	if err != nil {
		fatal(err)
	}
	write(outDir, "opencode", oc, map[string]any{"source": opencodeZenURL})

	if *check {
		runChecks(outDir)
	}
}
