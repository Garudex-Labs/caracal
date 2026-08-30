// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
	brtypes "github.com/aws/aws-sdk-go-v2/service/bedrockruntime/types"

	"github.com/garudex-labs/caracal/internal/llm"
)

// Completer is the provider-agnostic model boundary: one prompt in, one
// parsed JSON object out.
type Completer interface {
	Complete(ctx context.Context, prompt, model string, maxTokens int) (map[string]any, error)
}

const (
	completionTemperature = 0.1
	completionTimeout     = 120 * time.Second
	completionRetries     = 2
)

// Client dispatches completions to the provider named by the model-id
// prefix, reading credentials from runtime configuration on every call.
type Client struct {
	Config *Config
	HTTP   *http.Client
	// converse is the Bedrock call, replaceable in tests.
	converse func(ctx context.Context, region, model, prompt string, maxTokens int) (string, error)
	// retryWait returns the backoff before retry n (1-based); test seam.
	retryWait func(attempt int) time.Duration
}

// providerConfig is the resolved connection material for one call.
type providerConfig struct {
	apiKey     string
	apiBase    string
	apiVersion string
	awsRegion  string
}

func (c *Client) httpClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return http.DefaultClient
}

// splitProvider returns (provider, bare model); unqualified identifiers
// speak the OpenAI-compatible protocol.
func splitProvider(model string) (string, string) {
	if provider, bare, ok := strings.Cut(model, "/"); ok {
		return provider, bare
	}
	return "openai", model
}

// StripJSONFences removes markdown code fences around a JSON payload.
func StripJSONFences(text string) string {
	if strings.Contains(text, "```json") {
		text = strings.SplitN(text, "```json", 2)[1]
		text = strings.SplitN(text, "```", 2)[0]
	} else if strings.Contains(text, "```") {
		parts := strings.SplitN(text, "```", 3)
		if len(parts) >= 2 {
			text = parts[1]
		}
	}
	return strings.TrimSpace(text)
}

// Complete resolves the provider from the model id and returns the parsed
// JSON object of the response. Unparseable payloads return an empty object
// with a warning rather than an error, so one bad response degrades a
// single section instead of the report.
func (c *Client) Complete(ctx context.Context, prompt, model string, maxTokens int) (map[string]any, error) {
	cfg := providerConfig{
		apiKey:     c.Config.Secret(ctx, "insights.api_key"),
		apiBase:    c.Config.String(ctx, "insights.api_base", ""),
		apiVersion: c.Config.String(ctx, "insights.api_version", ""),
		awsRegion:  c.Config.String(ctx, "insights.aws_region", ""),
	}

	var content string
	var err error
	for attempt := 0; attempt <= completionRetries; attempt++ {
		if attempt > 0 {
			wait := c.backoff(attempt)
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(wait):
			}
		}
		content, err = c.completeOnce(ctx, cfg, prompt, model, maxTokens)
		if err == nil {
			break
		}
		if !retryableCallError(err) {
			return nil, err
		}
	}
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(content) == "" {
		slog.Warn("model returned empty response", "model", model)
		return map[string]any{}, nil
	}
	var parsed map[string]any
	if jsonErr := json.Unmarshal([]byte(StripJSONFences(content)), &parsed); jsonErr != nil {
		slog.Warn("model response was not a JSON object", "model", model, "error", jsonErr)
		return map[string]any{}, nil
	}
	return parsed, nil
}

func (c *Client) backoff(attempt int) time.Duration {
	if c.retryWait != nil {
		return c.retryWait(attempt)
	}
	return time.Duration(attempt) * time.Second
}

func (c *Client) completeOnce(ctx context.Context, cfg providerConfig, prompt, model string, maxTokens int) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, completionTimeout)
	defer cancel()
	provider, bare := splitProvider(model)
	switch provider {
	case "anthropic":
		return c.anthropicComplete(ctx, cfg, bare, prompt, maxTokens)
	case "gemini":
		return c.geminiComplete(ctx, cfg, bare, prompt, maxTokens)
	case "azure":
		return c.azureComplete(ctx, cfg, bare, prompt, maxTokens)
	case "bedrock":
		return c.bedrockComplete(ctx, cfg, bare, prompt, maxTokens)
	default:
		return c.openAIComplete(ctx, cfg, provider, bare, prompt, maxTokens)
	}
}

// httpStatusError distinguishes provider rejections from transport faults.
type httpStatusError struct {
	status int
	body   string
}

func (e *httpStatusError) Error() string {
	return fmt.Sprintf("%d %s: %s", e.status, http.StatusText(e.status), e.body)
}

// retryableCallError bounds retries to timeouts, transport faults, and the
// provider statuses that invite another attempt.
func retryableCallError(err error) bool {
	var statusErr *httpStatusError
	if errors.As(err, &statusErr) {
		return statusErr.status == http.StatusRequestTimeout ||
			statusErr.status == http.StatusTooManyRequests ||
			statusErr.status >= 500
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		return true
	}
	return errors.Is(err, context.DeadlineExceeded)
}

func (c *Client) postJSON(ctx context.Context, url string, headers map[string]string, body map[string]any) ([]byte, error) {
	blob, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(blob))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	payload, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		detail := strings.TrimSpace(string(payload))
		if len(detail) > 500 {
			detail = detail[:500]
		}
		return nil, &httpStatusError{status: resp.StatusCode, body: detail}
	}
	return payload, nil
}

// openAIDefaultBases are the endpoints for providers that speak the
// OpenAI-compatible chat protocol when no base URL is configured.
var openAIDefaultBases = map[string]string{
	"openai":     "https://api.openai.com",
	"openrouter": "https://openrouter.ai/api",
	"ollama":     "http://localhost:11434",
	"moonshot":   "https://api.moonshot.ai",
}

func chatCompletionsURL(base string) string {
	base = strings.TrimRight(base, "/")
	if strings.HasSuffix(base, "/v1") {
		return base + "/chat/completions"
	}
	return base + "/v1/chat/completions"
}

func (c *Client) openAIComplete(ctx context.Context, cfg providerConfig, provider, model, prompt string, maxTokens int) (string, error) {
	base := cfg.apiBase
	if base == "" {
		base = openAIDefaultBases[provider]
		if base == "" {
			base = openAIDefaultBases["openai"]
		}
	}
	body := map[string]any{
		"model":           model,
		"messages":        []any{map[string]any{"role": "user", "content": prompt}},
		"temperature":     completionTemperature,
		"response_format": map[string]any{"type": "json_object"},
	}
	// The first-party endpoint retired max_tokens; compatible servers
	// still expect it.
	if provider == "openai" && cfg.apiBase == "" {
		body["max_completion_tokens"] = maxTokens
	} else {
		body["max_tokens"] = maxTokens
	}
	headers := map[string]string{}
	if cfg.apiKey != "" {
		headers["Authorization"] = "Bearer " + cfg.apiKey
	}
	payload, err := c.postJSON(ctx, chatCompletionsURL(base), headers, body)
	if err != nil {
		return "", err
	}
	return parseChatCompletion(payload)
}

func parseChatCompletion(payload []byte) (string, error) {
	var doc struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(payload, &doc); err != nil {
		return "", fmt.Errorf("parse completion response: %w", err)
	}
	if len(doc.Choices) == 0 {
		return "", nil
	}
	return doc.Choices[0].Message.Content, nil
}

func (c *Client) azureComplete(ctx context.Context, cfg providerConfig, deployment, prompt string, maxTokens int) (string, error) {
	if cfg.apiBase == "" {
		return "", fmt.Errorf("azure models require insights.api_base (the resource endpoint)")
	}
	version := cfg.apiVersion
	if version == "" {
		version = "2024-02-15-preview"
	}
	url := fmt.Sprintf("%s/openai/deployments/%s/chat/completions?api-version=%s",
		strings.TrimRight(cfg.apiBase, "/"), deployment, version)
	payload, err := c.postJSON(ctx, url,
		map[string]string{"api-key": cfg.apiKey},
		map[string]any{
			"messages":        []any{map[string]any{"role": "user", "content": prompt}},
			"temperature":     completionTemperature,
			"max_tokens":      maxTokens,
			"response_format": map[string]any{"type": "json_object"},
		})
	if err != nil {
		return "", err
	}
	return parseChatCompletion(payload)
}

func (c *Client) anthropicComplete(ctx context.Context, cfg providerConfig, model, prompt string, maxTokens int) (string, error) {
	base := cfg.apiBase
	if base == "" {
		base = "https://api.anthropic.com"
	}
	payload, err := c.postJSON(ctx, strings.TrimRight(base, "/")+"/v1/messages",
		map[string]string{"x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01"},
		map[string]any{
			"model":       model,
			"max_tokens":  maxTokens,
			"temperature": completionTemperature,
			"messages":    []any{map[string]any{"role": "user", "content": prompt}},
		})
	if err != nil {
		return "", err
	}
	var doc struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(payload, &doc); err != nil {
		return "", fmt.Errorf("parse messages response: %w", err)
	}
	var out strings.Builder
	for _, block := range doc.Content {
		if block.Type == "text" {
			out.WriteString(block.Text)
		}
	}
	return out.String(), nil
}

func (c *Client) geminiComplete(ctx context.Context, cfg providerConfig, model, prompt string, maxTokens int) (string, error) {
	base := cfg.apiBase
	if base == "" {
		base = "https://generativelanguage.googleapis.com"
	}
	url := fmt.Sprintf("%s/v1beta/models/%s:generateContent", strings.TrimRight(base, "/"), model)
	payload, err := c.postJSON(ctx, url,
		map[string]string{"x-goog-api-key": cfg.apiKey},
		map[string]any{
			"contents": []any{map[string]any{"parts": []any{map[string]any{"text": prompt}}}},
			"generationConfig": map[string]any{
				"temperature":      completionTemperature,
				"maxOutputTokens":  maxTokens,
				"responseMimeType": "application/json",
			},
		})
	if err != nil {
		return "", err
	}
	var doc struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}
	if err := json.Unmarshal(payload, &doc); err != nil {
		return "", fmt.Errorf("parse generateContent response: %w", err)
	}
	if len(doc.Candidates) == 0 {
		return "", nil
	}
	var out strings.Builder
	for _, part := range doc.Candidates[0].Content.Parts {
		out.WriteString(part.Text)
	}
	return out.String(), nil
}

// bedrockComplete speaks the Converse API through the default AWS
// credential chain; the region comes from insights.aws_region.
func (c *Client) bedrockComplete(ctx context.Context, cfg providerConfig, model, prompt string, maxTokens int) (string, error) {
	region := cfg.awsRegion
	if region == "" {
		region = "us-east-1"
	}
	if c.converse != nil {
		return c.converse(ctx, region, model, prompt, maxTokens)
	}
	return bedrockConverse(ctx, region, model, prompt, maxTokens)
}

func bedrockConverse(ctx context.Context, region, model, prompt string, maxTokens int) (string, error) {
	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region))
	if err != nil {
		return "", fmt.Errorf("load aws configuration: %w", err)
	}
	client := bedrockruntime.NewFromConfig(awsCfg)
	temperature := float32(completionTemperature)
	out, err := client.Converse(ctx, &bedrockruntime.ConverseInput{
		ModelId: aws.String(model),
		Messages: []brtypes.Message{{
			Role:    brtypes.ConversationRoleUser,
			Content: []brtypes.ContentBlock{&brtypes.ContentBlockMemberText{Value: prompt}},
		}},
		InferenceConfig: &brtypes.InferenceConfiguration{
			MaxTokens:   aws.Int32(int32(maxTokens)), //nolint:gosec // bounded prompt budgets
			Temperature: &temperature,
		},
	})
	if err != nil {
		return "", err
	}
	message, ok := out.Output.(*brtypes.ConverseOutputMemberMessage)
	if !ok {
		return "", nil
	}
	var text strings.Builder
	for _, block := range message.Value.Content {
		if t, ok := block.(*brtypes.ContentBlockMemberText); ok {
			text.WriteString(t.Value)
		}
	}
	return text.String(), nil
}

// callModel resolves the model (override or the configured sections model),
// normalizes its identifier, and returns the parsed response. Every failure
// degrades to an empty object with a log line, never an error: a lost
// section must not lose the report.
func (e *Engine) callModel(ctx context.Context, prompt, modelOverride string, maxTokens int) map[string]any {
	model := modelOverride
	if model == "" {
		model = e.Config.String(ctx, "insights.model_sections", "")
	}
	if model == "" {
		return map[string]any{}
	}
	model = llm.NormalizeModelID(model)
	result, err := e.LLM.Complete(ctx, prompt, model, maxTokens)
	if err != nil {
		slog.Error("model call failed", "model", model, "error", err)
		return map[string]any{}
	}
	if result == nil {
		return map[string]any{}
	}
	return result
}
