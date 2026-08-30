// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package adminops

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode"

	harnessdata "github.com/garudex-labs/caracal/packages/harness-data"

	"github.com/garudex-labs/caracal/internal/httpapi"
)

// The Insights model picker is backed by the vendored LiteLLM catalog
// snapshot embedded from packages/harness-data. Only conversational modes
// power insight generation.

type liteLLMModel struct {
	ModelID            string       `json:"model_id"`
	LiteLLMProvider    string       `json:"litellm_provider"`
	LiteLLMModel       string       `json:"litellm_model"`
	Mode               string       `json:"mode"`
	MaxInputTokens     *json.Number `json:"max_input_tokens"`
	MaxOutputTokens    *json.Number `json:"max_output_tokens"`
	InputCostPerToken  *json.Number `json:"input_cost_per_token"`
	OutputCostPerToken *json.Number `json:"output_cost_per_token"`
	DeprecationDate    *string      `json:"deprecation_date"`
	Deprecated         bool         `json:"deprecated"`
	Capabilities       []string     `json:"capabilities"`
}

type liteLLMProvider struct {
	ID         string `json:"id"`
	Label      string `json:"label"`
	ModelCount int    `json:"model_count"`
}

var insightsModes = map[string]bool{"chat": true, "responses": true}

// normalizeIntNumber renders integral tokens without a fraction so an
// integer-typed field always carries an integer literal.
func normalizeIntNumber(n *json.Number) *json.Number {
	if n == nil || !strings.ContainsAny(n.String(), ".eE") {
		return n
	}
	f, err := n.Float64()
	if err != nil || f != float64(int64(f)) {
		return n
	}
	out := json.Number(strconv.FormatInt(int64(f), 10))
	return &out
}

// normalizeFloatNumber renders integral tokens with a fraction so a
// float-typed field always carries a float literal.
func normalizeFloatNumber(n *json.Number) *json.Number {
	if n == nil || strings.ContainsAny(n.String(), ".eE") {
		return n
	}
	out := json.Number(n.String() + ".0")
	return &out
}

// insightsCatalog parses the snapshot once, keeping models with an
// Insights-compatible mode sorted by (litellm_provider, model_id).
var insightsCatalog = sync.OnceValues(func() ([]liteLLMModel, error) {
	var payload struct {
		Models []liteLLMModel `json:"models"`
	}
	if err := json.Unmarshal(harnessdata.LiteLLMCatalogJSON, &payload); err != nil {
		return nil, err
	}
	models := make([]liteLLMModel, 0, len(payload.Models))
	for _, m := range payload.Models {
		if !insightsModes[m.Mode] {
			continue
		}
		m.MaxInputTokens = normalizeIntNumber(m.MaxInputTokens)
		m.MaxOutputTokens = normalizeIntNumber(m.MaxOutputTokens)
		m.InputCostPerToken = normalizeFloatNumber(m.InputCostPerToken)
		m.OutputCostPerToken = normalizeFloatNumber(m.OutputCostPerToken)
		if m.Capabilities == nil {
			m.Capabilities = []string{}
		}
		models = append(models, m)
	}
	sort.SliceStable(models, func(i, j int) bool {
		if models[i].LiteLLMProvider != models[j].LiteLLMProvider {
			return models[i].LiteLLMProvider < models[j].LiteLLMProvider
		}
		return models[i].ModelID < models[j].ModelID
	})
	return models, nil
})

// providerLabel renders a provider id for display: underscores become
// spaces and each letter run is title-cased.
func providerLabel(provider string) string {
	var b strings.Builder
	prevLetter := false
	for _, r := range strings.ReplaceAll(provider, "_", " ") {
		if unicode.IsLetter(r) {
			if prevLetter {
				b.WriteRune(unicode.ToLower(r))
			} else {
				b.WriteRune(unicode.ToTitle(r))
			}
			prevLetter = true
		} else {
			b.WriteRune(r)
			prevLetter = false
		}
	}
	return b.String()
}

func catalogProviders(models []liteLLMModel) []liteLLMProvider {
	counts := map[string]int{}
	for _, m := range models {
		counts[m.LiteLLMProvider]++
	}
	ids := make([]string, 0, len(counts))
	for id := range counts {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	providers := make([]liteLLMProvider, 0, len(ids))
	for _, id := range ids {
		providers = append(providers, liteLLMProvider{ID: id, Label: providerLabel(id), ModelCount: counts[id]})
	}
	return providers
}

func catalogModelsFor(models []liteLLMModel, provider string) []liteLLMModel {
	rows := []liteLLMModel{}
	for _, m := range models {
		if m.LiteLLMProvider == provider {
			rows = append(rows, m)
		}
	}
	return rows
}

// insightsModelProviders lists LiteLLM providers with Insights-compatible
// models in the vendored snapshot.
func (h *Handler) insightsModelProviders(w http.ResponseWriter, r *http.Request) {
	models, err := insightsCatalog()
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, struct {
		Providers []liteLLMProvider `json:"providers"`
	}{catalogProviders(models)})
}

// insightsModels lists Insights-compatible models for one LiteLLM provider.
func (h *Handler) insightsModels(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	if !query.Has("provider") {
		httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []map[string]any{{
			"type": "missing", "loc": []string{"query", "provider"},
			"msg": "Field required", "input": nil,
		}})
		return
	}
	provider := query.Get("provider")
	if provider == "" {
		httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []map[string]any{{
			"type": "string_too_short", "loc": []string{"query", "provider"},
			"msg": "String should have at least 1 character", "input": "",
			"ctx": map[string]any{"min_length": 1},
		}})
		return
	}
	models, err := insightsCatalog()
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	rows := catalogModelsFor(models, provider)
	if len(rows) == 0 {
		httpapi.WriteError(w, http.StatusNotFound, "Provider not found")
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, struct {
		Provider string         `json:"provider"`
		Models   []liteLLMModel `json:"models"`
	}{provider, rows})
}
