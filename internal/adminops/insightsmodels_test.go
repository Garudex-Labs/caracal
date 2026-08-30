// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package adminops

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestInsightsCatalogFilterAndOrder(t *testing.T) {
	models, err := insightsCatalog()
	if err != nil {
		t.Fatal(err)
	}
	if len(models) == 0 {
		t.Fatal("catalog is empty")
	}
	for i, m := range models {
		if !insightsModes[m.Mode] {
			t.Fatalf("model %s has mode %q outside the Insights set", m.ModelID, m.Mode)
		}
		if m.Capabilities == nil {
			t.Fatalf("model %s has nil capabilities", m.ModelID)
		}
		if i > 0 {
			prev := models[i-1]
			if prev.LiteLLMProvider > m.LiteLLMProvider ||
				(prev.LiteLLMProvider == m.LiteLLMProvider && prev.ModelID > m.ModelID) {
				t.Fatalf("catalog out of order at %d: (%s,%s) before (%s,%s)",
					i, prev.LiteLLMProvider, prev.ModelID, m.LiteLLMProvider, m.ModelID)
			}
		}
	}
}

func TestProviderLabel(t *testing.T) {
	cases := map[string]string{
		"openai":       "Openai",
		"vertex_ai":    "Vertex Ai",
		"fireworks_ai": "Fireworks Ai",
		"ai21":         "Ai21",
		"azure":        "Azure",
	}
	for in, want := range cases {
		if got := providerLabel(in); got != want {
			t.Errorf("providerLabel(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCatalogProviders(t *testing.T) {
	models := []liteLLMModel{
		{LiteLLMProvider: "openai"},
		{LiteLLMProvider: "anthropic"},
		{LiteLLMProvider: "openai"},
		{LiteLLMProvider: "vertex_ai"},
	}
	providers := catalogProviders(models)
	if len(providers) != 3 {
		t.Fatalf("providers = %v", providers)
	}
	if providers[0].ID != "anthropic" || providers[1].ID != "openai" || providers[2].ID != "vertex_ai" {
		t.Errorf("provider order = %v", providers)
	}
	if providers[1].ModelCount != 2 || providers[1].Label != "Openai" {
		t.Errorf("openai entry = %+v", providers[1])
	}
}

func TestNumberNormalization(t *testing.T) {
	num := func(s string) *json.Number { n := json.Number(s); return &n }
	if got := normalizeIntNumber(num("2000000.0")); got.String() != "2000000" {
		t.Errorf("integral float token = %s", got.String())
	}
	if got := normalizeIntNumber(num("8192")); got.String() != "8192" {
		t.Errorf("integer token changed: %s", got.String())
	}
	if got := normalizeIntNumber(nil); got != nil {
		t.Error("nil int token changed")
	}
	if got := normalizeFloatNumber(num("0")); got.String() != "0.0" {
		t.Errorf("integer-typed float token = %s", got.String())
	}
	if got := normalizeFloatNumber(num("3e-06")); got.String() != "3e-06" {
		t.Errorf("exponent token changed: %s", got.String())
	}
	if got := normalizeFloatNumber(num("0.00025")); got.String() != "0.00025" {
		t.Errorf("fraction token changed: %s", got.String())
	}
}

func TestModelWireShape(t *testing.T) {
	raw, err := json.Marshal(liteLLMModel{
		ModelID: "m", LiteLLMProvider: "p", LiteLLMModel: "p/m", Mode: "chat",
		Capabilities: []string{},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"model_id":"m","litellm_provider":"p","litellm_model":"p/m","mode":"chat",` +
		`"max_input_tokens":null,"max_output_tokens":null,"input_cost_per_token":null,` +
		`"output_cost_per_token":null,"deprecation_date":null,"deprecated":false,"capabilities":[]}`
	if string(raw) != want {
		t.Errorf("model wire = %s\nwant %s", raw, want)
	}
}

func TestInsightsModelsHandler(t *testing.T) {
	h := &Handler{}

	get := func(target string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		h.insightsModels(w, httptest.NewRequest("GET", target, nil))
		return w
	}

	if w := get("/api/v1/operator/ai-engine/models"); w.Code != 422 ||
		!strings.Contains(w.Body.String(), `"type":"missing"`) {
		t.Errorf("missing provider: %d %s", w.Code, w.Body.String())
	}
	if w := get("/api/v1/operator/ai-engine/models?provider="); w.Code != 422 ||
		!strings.Contains(w.Body.String(), "string_too_short") {
		t.Errorf("empty provider: %d %s", w.Code, w.Body.String())
	}
	if w := get("/api/v1/operator/ai-engine/models?provider=no-such-provider"); w.Code != 404 ||
		!strings.Contains(w.Body.String(), `"detail":"Provider not found"`) {
		t.Errorf("unknown provider: %d %s", w.Code, w.Body.String())
	}

	models, err := insightsCatalog()
	if err != nil {
		t.Fatal(err)
	}
	known := models[0].LiteLLMProvider
	w := get("/api/v1/operator/ai-engine/models?provider=" + known)
	if w.Code != 200 {
		t.Fatalf("known provider: %d %s", w.Code, w.Body.String())
	}
	var resp struct {
		Provider string           `json:"provider"`
		Models   []map[string]any `json:"models"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Provider != known || len(resp.Models) == 0 {
		t.Errorf("response = %s", w.Body.String())
	}

	providersW := httptest.NewRecorder()
	h.insightsModelProviders(providersW, httptest.NewRequest("GET", "/api/v1/operator/ai-engine/models/providers", nil))
	if providersW.Code != 200 || !strings.Contains(providersW.Body.String(), `"providers":[{"id":`) {
		t.Errorf("providers: %d %s", providersW.Code, providersW.Body.String()[:200])
	}
}
