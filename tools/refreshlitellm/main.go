// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Command refreshlitellm refreshes the vendored LiteLLM model catalog
// snapshot at packages/harness-data/litellm_model_catalog.json.
package main

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

const sourceURL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"

var capabilityFlags = []string{
	"supports_function_calling",
	"supports_tool_choice",
	"supports_parallel_function_calling",
	"supports_response_schema",
	"supports_native_structured_output",
	"supports_vision",
	"supports_pdf_input",
	"supports_audio_input",
	"supports_audio_output",
	"supports_video_input",
	"supports_prompt_caching",
	"supports_reasoning",
	"supports_web_search",
	"supports_computer_use",
	"supports_system_messages",
}

func fail(err error) {
	fmt.Fprintf(os.Stderr, "failed to refresh LiteLLM model snapshot: %v\n", err)
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

func litellmProvider(provider string) string {
	if provider == "bedrock_converse" {
		return "bedrock"
	}
	return provider
}

func litellmModel(modelID, provider string) string {
	if provider == "bedrock_converse" {
		return "bedrock/converse/" + modelID
	}
	if strings.HasPrefix(modelID, provider+"/") {
		return modelID
	}
	return provider + "/" + modelID
}

// truthy mirrors boolean coercion of JSON values: null, false, 0, "" and
// empty containers are false.
func truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case json.Number:
		f, err := t.Float64()
		return err != nil || f != 0
	case []any:
		return len(t) > 0
	case map[string]any:
		return len(t) > 0
	}
	return true
}

func getString(row map[string]any, key string) string {
	s, _ := row[key].(string)
	return s
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

func encodeNumber(b *strings.Builder, n json.Number) {
	lit := string(n)
	if !strings.ContainsAny(lit, ".eE") {
		b.WriteString(lit)
		return
	}
	f, err := strconv.ParseFloat(lit, 64)
	if err != nil {
		b.WriteString(lit)
		return
	}
	b.WriteString(floatRepr(f))
}

// floatRepr renders a float using the shortest round-trip decimal form:
// fixed notation while the decimal exponent is in [-4, 16), otherwise
// scientific notation with a signed two-digit exponent.
func floatRepr(f float64) string {
	if math.IsInf(f, 1) {
		return "Infinity"
	}
	if math.IsInf(f, -1) {
		return "-Infinity"
	}
	if math.IsNaN(f) {
		return "NaN"
	}
	s := strconv.FormatFloat(f, 'e', -1, 64)
	neg := strings.HasPrefix(s, "-")
	s = strings.TrimPrefix(s, "-")
	mantExp := strings.SplitN(s, "e", 2)
	digits := strings.Replace(mantExp[0], ".", "", 1)
	exp, _ := strconv.Atoi(mantExp[1])
	var out string
	if exp >= -4 && exp < 16 {
		switch {
		case exp >= len(digits)-1:
			out = digits + strings.Repeat("0", exp-(len(digits)-1)) + ".0"
		case exp >= 0:
			out = digits[:exp+1] + "." + digits[exp+1:]
		default:
			out = "0." + strings.Repeat("0", -exp-1) + digits
		}
	} else {
		mant := digits[:1]
		if len(digits) > 1 {
			mant += "." + digits[1:]
		}
		sign := "+"
		e := exp
		if e < 0 {
			sign = "-"
			e = -e
		}
		out = fmt.Sprintf("%se%s%02d", mant, sign, e)
	}
	if neg {
		out = "-" + out
	}
	return out
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
	case json.Number:
		encodeNumber(b, t)
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

// ── Snapshot generation ──────────────────────────────────────────────────────

func isoNow() string {
	now := time.Now().UTC()
	if now.Nanosecond() == 0 {
		return now.Format("2006-01-02T15:04:05") + "+00:00"
	}
	return now.Format("2006-01-02T15:04:05.000000") + "+00:00"
}

func normalize(payload map[string]any) map[string]any {
	var models []map[string]any
	for modelID, rawRow := range payload {
		if modelID == "sample_spec" {
			continue
		}
		row, ok := rawRow.(map[string]any)
		if !ok {
			continue
		}
		sourceProvider := getString(row, "litellm_provider")
		if sourceProvider == "" {
			continue
		}
		maxOutput := row["max_output_tokens"]
		if !truthy(maxOutput) {
			maxOutput = row["max_tokens"]
		}
		mode := getString(row, "mode")
		capabilities := []string{}
		for _, flag := range capabilityFlags {
			if truthy(row[flag]) {
				capabilities = append(capabilities, strings.TrimPrefix(flag, "supports_"))
			}
		}
		models = append(models, map[string]any{
			"model_id":              modelID,
			"litellm_provider":      litellmProvider(sourceProvider),
			"litellm_model":         litellmModel(modelID, sourceProvider),
			"mode":                  mode,
			"max_input_tokens":      row["max_input_tokens"],
			"max_output_tokens":     maxOutput,
			"input_cost_per_token":  row["input_cost_per_token"],
			"output_cost_per_token": row["output_cost_per_token"],
			"deprecation_date":      row["deprecation_date"],
			"deprecated":            truthy(row["deprecation_date"]),
			"capabilities":          capabilities,
		})
	}

	sort.Slice(models, func(i, j int) bool {
		pi, pj := models[i]["litellm_provider"].(string), models[j]["litellm_provider"].(string)
		if pi != pj {
			return pi < pj
		}
		return models[i]["model_id"].(string) < models[j]["model_id"].(string)
	})

	chatCount := 0
	rows := make([]any, 0, len(models))
	for _, m := range models {
		if m["mode"] == "chat" {
			chatCount++
		}
		rows = append(rows, m)
	}
	return map[string]any{
		"source":           sourceURL,
		"fetched_at":       isoNow(),
		"model_count":      len(models),
		"chat_model_count": chatCount,
		"models":           rows,
	}
}

func main() {
	req, err := http.NewRequest(http.MethodGet, sourceURL, nil)
	if err != nil {
		fail(err)
	}
	req.Header.Set("User-Agent", "caracal/1.0")
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		fail(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		fail(fmt.Errorf("GET %s: HTTP %d", sourceURL, resp.StatusCode))
	}

	dec := json.NewDecoder(resp.Body)
	dec.UseNumber()
	var payload map[string]any
	if err := dec.Decode(&payload); err != nil {
		fail(err)
	}

	snapshot := normalize(payload)

	modelCount := snapshot["model_count"].(int)
	chatCount := snapshot["chat_model_count"].(int)
	if modelCount == 0 {
		fail(fmt.Errorf("snapshot has no models"))
	}
	if chatCount == 0 {
		fail(fmt.Errorf("snapshot has no chat models"))
	}
	for _, m := range snapshot["models"].([]any) {
		if !strings.Contains(m.(map[string]any)["litellm_model"].(string), "/") {
			fail(fmt.Errorf("model %v has an unqualified litellm_model", m.(map[string]any)["model_id"]))
		}
	}

	outPath := filepath.Join(findRoot(), "packages", "harness-data", "litellm_model_catalog.json")
	if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
		fail(err)
	}
	var b strings.Builder
	writeValue(&b, snapshot, 0)
	b.WriteByte('\n')
	if err := os.WriteFile(outPath, []byte(b.String()), 0o644); err != nil {
		fail(err)
	}
	fmt.Printf("wrote %d models (%d chat) to %s\n", modelCount, chatCount, outPath)
}
