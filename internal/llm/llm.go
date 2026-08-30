// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package llm is the outbound boundary to hosted language-model providers.
// It speaks each provider's native HTTP API directly; application code
// passes provider-qualified model identifiers ("provider/model") and never
// deals with provider SDKs.
package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
)

// Config carries the connection settings for one completion call.
type Config struct {
	Model      string
	APIKey     string
	APIBase    string
	APIVersion string
	AWSRegion  string
	Timeout    time.Duration
}

var bedrockAnthropicRE = regexp.MustCompile(`^(us|eu|apac)\.anthropic\.`)

// NormalizeModelID maps legacy model identifiers onto the provider-qualified
// form. Identifiers that already carry a provider pass through.
func NormalizeModelID(model string) string {
	if strings.Contains(model, "/") {
		return model
	}
	if bedrockAnthropicRE.MatchString(model) {
		return "bedrock/" + model
	}
	if strings.HasPrefix(model, "kimi") || strings.HasPrefix(model, "moonshot") {
		return "openai/" + model
	}
	return model
}

// splitProvider returns (provider, bare model). Unqualified ids default to
// the OpenAI-compatible protocol.
func splitProvider(model string) (string, string) {
	if provider, bare, ok := strings.Cut(model, "/"); ok {
		return provider, bare
	}
	return "openai", model
}

const testPrompt = "Say hello in exactly one word."

// TestCompletion issues one minimal completion against the configured
// provider and reports round-trip latency.
func TestCompletion(ctx context.Context, cfg Config) (int, error) {
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	provider, bare := splitProvider(cfg.Model)
	start := time.Now()
	var err error
	switch provider {
	case "anthropic":
		err = anthropicTest(ctx, cfg, bare)
	case "gemini":
		err = geminiTest(ctx, cfg, bare)
	case "azure":
		err = azureTest(ctx, cfg, bare)
	case "bedrock":
		err = bedrockTest(ctx, cfg, bare)
	default:
		err = openAITest(ctx, cfg, bare)
	}
	if err != nil {
		return 0, err
	}
	return int(time.Since(start).Milliseconds()), nil
}

func postJSON(ctx context.Context, url string, headers map[string]string, body map[string]any) error {
	blob, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(blob))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 300 {
		payload, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("%d %s: %s", resp.StatusCode, http.StatusText(resp.StatusCode), strings.TrimSpace(string(payload)))
	}
	return nil
}

func baseOr(cfg Config, fallback string) string {
	if cfg.APIBase != "" {
		return strings.TrimRight(cfg.APIBase, "/")
	}
	return fallback
}

func openAITest(ctx context.Context, cfg Config, model string) error {
	url := baseOr(cfg, "https://api.openai.com") + "/v1/chat/completions"
	// Custom bases often expose the bare path without the /v1 segment.
	if cfg.APIBase != "" && strings.HasSuffix(baseOr(cfg, ""), "/v1") {
		url = baseOr(cfg, "") + "/chat/completions"
	}
	return postJSON(ctx, url,
		map[string]string{"Authorization": "Bearer " + cfg.APIKey},
		map[string]any{
			"model":                 model,
			"messages":              []any{map[string]any{"role": "user", "content": testPrompt}},
			"max_completion_tokens": 2048,
		})
}

func anthropicTest(ctx context.Context, cfg Config, model string) error {
	return postJSON(ctx, baseOr(cfg, "https://api.anthropic.com")+"/v1/messages",
		map[string]string{"x-api-key": cfg.APIKey, "anthropic-version": "2023-06-01"},
		map[string]any{
			"model":      model,
			"max_tokens": 2048,
			"messages":   []any{map[string]any{"role": "user", "content": testPrompt}},
		})
}

func geminiTest(ctx context.Context, cfg Config, model string) error {
	url := fmt.Sprintf("%s/v1beta/models/%s:generateContent",
		baseOr(cfg, "https://generativelanguage.googleapis.com"), model)
	return postJSON(ctx, url,
		map[string]string{"x-goog-api-key": cfg.APIKey},
		map[string]any{
			"contents": []any{map[string]any{"parts": []any{map[string]any{"text": testPrompt}}}},
		})
}

func azureTest(ctx context.Context, cfg Config, deployment string) error {
	if cfg.APIBase == "" {
		return fmt.Errorf("azure models require a Base URL (your resource endpoint)")
	}
	version := cfg.APIVersion
	if version == "" {
		version = "2024-02-15-preview"
	}
	url := fmt.Sprintf("%s/openai/deployments/%s/chat/completions?api-version=%s",
		baseOr(cfg, ""), deployment, version)
	return postJSON(ctx, url,
		map[string]string{"api-key": cfg.APIKey},
		map[string]any{
			"messages":              []any{map[string]any{"role": "user", "content": testPrompt}},
			"max_completion_tokens": 2048,
		})
}

// bedrockTest uses the Bedrock API-key bearer scheme; SigV4 credential
// chains are out of scope for this boundary.
func bedrockTest(ctx context.Context, cfg Config, model string) error {
	token := os.Getenv("AWS_BEARER_TOKEN_BEDROCK")
	if token == "" {
		token = cfg.APIKey
	}
	if token == "" {
		return fmt.Errorf("bedrock requires an API key (Bedrock API keys use the bearer scheme)")
	}
	region := cfg.AWSRegion
	if region == "" {
		region = "us-east-1"
	}
	url := fmt.Sprintf("https://bedrock-runtime.%s.amazonaws.com/model/%s/converse", region, model)
	if cfg.APIBase != "" {
		url = baseOr(cfg, "") + "/model/" + model + "/converse"
	}
	return postJSON(ctx, url,
		map[string]string{"Authorization": "Bearer " + token},
		map[string]any{
			"messages": []any{map[string]any{
				"role":    "user",
				"content": []any{map[string]any{"text": testPrompt}},
			}},
			"inferenceConfig": map[string]any{"maxTokens": 2048},
		})
}
