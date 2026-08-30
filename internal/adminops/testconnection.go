// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package adminops

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/llm"
)

// connectionErrorHint maps a provider failure onto operator guidance.
func connectionErrorHint(errStr, model string) string {
	modelLower := strings.ToLower(model)
	has := func(subs ...string) bool {
		for _, s := range subs {
			if strings.Contains(errStr, s) {
				return true
			}
		}
		return false
	}
	switch {
	case has("model identifier is invalid", "model_not_found"):
		if strings.Contains(modelLower, "bedrock") {
			return "Model ID is not available in your region. " +
				"Ensure the Base URL region matches where the model is enabled. " +
				"Cross-region models use prefixes like us./eu./apac. (e.g., bedrock/us.anthropic.claude-sonnet-4-6-v1)."
		}
		return "Model ID not recognized. Verify the format: provider/model-name"
	case has("auth", "401", "invalid api key", "forbidden"):
		switch {
		case strings.Contains(modelLower, "anthropic"):
			return "Invalid API key. Get one at console.anthropic.com"
		case strings.Contains(modelLower, "bedrock"):
			return "Bearer token may be expired. Regenerate in AWS Console."
		case strings.Contains(modelLower, "openai"):
			return "Invalid API key. Get one at platform.openai.com/api-keys"
		case strings.Contains(modelLower, "gemini"):
			return "Invalid API key. Get one at aistudio.google.com/apikey"
		}
		return "Authentication failed. Verify your API key."
	case has("timeout", "timed out", "connect"):
		return "Could not reach endpoint. Check your Base URL and network connectivity."
	case has("not found", "does not exist", "unknown provider"):
		return "Model ID not recognized. Verify the format: provider/model-name"
	case has("rate", "429"):
		return "Rate limited by provider. The key is valid, try again in a moment."
	case has("access") && strings.Contains(modelLower, "bedrock"):
		return "Model access not enabled. Enable the model in your AWS Bedrock console for this region."
	}
	return "Connection test failed. Check your settings and try again."
}

// testInsightsConnection issues one minimal completion with the configured
// insights credentials and reports latency or an actionable failure.
func (h *Handler) testInsightsConnection(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Model *string `json:"model"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	ctx := r.Context()
	model := ""
	if body.Model != nil {
		model = strings.TrimSpace(*body.Model)
	}
	if model == "" {
		model = h.Settings.String(ctx, "insights.model_sections", "")
	}
	if model == "" {
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"success": false, "model": nil, "latency_ms": nil,
			"error": "No model configured",
			"hint":  "Set the Sections Model first, or provide a model in the request.",
		})
		return
	}
	model = llm.NormalizeModelID(model)

	cfg := llm.Config{
		Model:      model,
		APIKey:     h.Settings.String(ctx, "insights.api_key", ""),
		APIBase:    h.Settings.String(ctx, "insights.api_base", ""),
		APIVersion: h.Settings.String(ctx, "insights.api_version", ""),
		AWSRegion:  h.Settings.String(ctx, "insights.aws_region", ""),
		Timeout:    15 * time.Second,
	}
	latency, err := llm.TestCompletion(ctx, cfg)
	if err != nil {
		errStr := err.Error()
		if len(errStr) > 200 {
			errStr = errStr[:200]
		}
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"success": false, "model": model, "latency_ms": nil,
			"error": errStr,
			"hint":  connectionErrorHint(strings.ToLower(err.Error()), model),
		})
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true, "model": model, "latency_ms": latency,
		"error": nil, "hint": nil,
	})
}
