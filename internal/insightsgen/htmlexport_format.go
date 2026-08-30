// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

var hxEscaper = strings.NewReplacer(
	"&", "&amp;",
	"<", "&lt;",
	">", "&gt;",
	`"`, "&quot;",
	"'", "&#x27;",
)

func hxEscape(s string) string { return hxEscaper.Replace(s) }

// hxEsc renders the escaped display form of a value; falsy values render empty.
func hxEsc(v any) string {
	if !hxTruthy(v) {
		return ""
	}
	return hxEscape(hxText(v))
}

// hxText is the plain display form of a scalar value.
func hxText(v any) string {
	switch t := v.(type) {
	case nil:
		return "None"
	case string:
		return t
	case []byte:
		return string(t)
	case bool:
		if t {
			return "True"
		}
		return "False"
	case float64:
		return hxNumText(t)
	case float32:
		return hxNumText(float64(t))
	case int:
		return strconv.Itoa(t)
	case int32:
		return strconv.FormatInt(int64(t), 10)
	case int64:
		return strconv.FormatInt(t, 10)
	case json.Number:
		return t.String()
	case time.Time:
		return t.Format("2006-01-02 15:04:05")
	default:
		return fmt.Sprint(v)
	}
}

// hxNumText renders whole values without a decimal part.
func hxNumText(f float64) string {
	if f == math.Trunc(f) && math.Abs(f) < 1e15 {
		return strconv.FormatInt(int64(f), 10)
	}
	return strconv.FormatFloat(f, 'g', -1, 64)
}

// hxFloatText always keeps a decimal marker on whole values.
func hxFloatText(f float64) string {
	s := strconv.FormatFloat(f, 'g', -1, 64)
	if !strings.ContainsAny(s, ".eE") {
		s += ".0"
	}
	return s
}

func hxTruthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case string:
		return t != ""
	case []byte:
		return len(t) > 0
	case bool:
		return t
	case float64:
		return t != 0
	case float32:
		return t != 0
	case int:
		return t != 0
	case int32:
		return t != 0
	case int64:
		return t != 0
	case json.Number:
		f, _ := t.Float64()
		return f != 0
	case map[string]any:
		return len(t) > 0
	case []any:
		return len(t) > 0
	case time.Time:
		return true
	default:
		return true
	}
}

// hxMapOf accepts a decoded object or its raw JSON bytes.
func hxMapOf(v any) map[string]any {
	switch t := v.(type) {
	case map[string]any:
		return t
	case []byte:
		var m map[string]any
		if json.Unmarshal(t, &m) == nil {
			return m
		}
	case json.RawMessage:
		var m map[string]any
		if json.Unmarshal(t, &m) == nil {
			return m
		}
	case string:
		var m map[string]any
		if json.Unmarshal([]byte(t), &m) == nil {
			return m
		}
	}
	return nil
}

// hxListOf accepts a decoded array or its raw JSON bytes.
func hxListOf(v any) []any {
	switch t := v.(type) {
	case []any:
		return t
	case []byte:
		var l []any
		if json.Unmarshal(t, &l) == nil {
			return l
		}
	case json.RawMessage:
		var l []any
		if json.Unmarshal(t, &l) == nil {
			return l
		}
	case string:
		var l []any
		if json.Unmarshal([]byte(t), &l) == nil {
			return l
		}
	}
	return nil
}

func hxNumeric(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case float32:
		return float64(t), true
	case int:
		return float64(t), true
	case int32:
		return float64(t), true
	case int64:
		return float64(t), true
	case json.Number:
		f, err := t.Float64()
		return f, err == nil
	}
	return 0, false
}

func hxNumOf(m map[string]any, key string) float64 {
	f, _ := hxNumeric(m[key])
	return f
}

func hxFloatCoerce(v any) float64 {
	if f, ok := hxNumeric(v); ok {
		return f
	}
	if s, ok := v.(string); ok {
		if f, err := strconv.ParseFloat(strings.TrimSpace(s), 64); err == nil {
			return f
		}
	}
	return 0
}

// hxGet returns the stored value when the key exists, even when it is null.
func hxGet(m map[string]any, key string, def any) any {
	if v, ok := m[key]; ok {
		return v
	}
	return def
}

// hxOrValue picks the first truthy value.
func hxOrValue(a, b any) any {
	if hxTruthy(a) {
		return a
	}
	return b
}

func hxIDText(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case []byte:
		if u, err := uuid.FromBytes(t); err == nil {
			return u.String()
		}
		return string(t)
	case [16]byte:
		return uuid.UUID(t).String()
	case fmt.Stringer:
		return t.String()
	}
	return hxText(v)
}

// hxPeriodDisplay reduces timestamps to their calendar date.
func hxPeriodDisplay(v any) any {
	switch t := v.(type) {
	case time.Time:
		return t.Format("2006-01-02")
	case string:
		if i := strings.IndexByte(t, 'T'); i >= 0 {
			return t[:i]
		}
		return t
	case []byte:
		s := string(t)
		if i := strings.IndexByte(s, 'T'); i >= 0 {
			return s[:i]
		}
		return s
	}
	return v
}

func hxF(f float64, prec int) string {
	return strconv.FormatFloat(f, 'f', prec, 64)
}

func hxRound1(v float64) float64 {
	return math.RoundToEven(v*10) / 10
}

// hxGroup inserts thousands separators into a plain decimal string.
func hxGroup(s string) string {
	neg := strings.HasPrefix(s, "-")
	if neg {
		s = s[1:]
	}
	intPart, frac := s, ""
	if i := strings.IndexByte(s, '.'); i >= 0 {
		intPart, frac = s[:i], s[i:]
	}
	if len(intPart) > 3 {
		var b strings.Builder
		pre := len(intPart) % 3
		if pre > 0 {
			b.WriteString(intPart[:pre])
		}
		for i := pre; i < len(intPart); i += 3 {
			if b.Len() > 0 {
				b.WriteByte(',')
			}
			b.WriteString(intPart[i : i+3])
		}
		intPart = b.String()
	}
	out := intPart + frac
	if neg {
		out = "-" + out
	}
	return out
}

func hxCost(v any) string {
	f, ok := hxNumeric(v)
	if !ok {
		return "$0.00"
	}
	return hxCostF(f)
}

func hxCostF(f float64) string {
	if f < 0.01 {
		return "$" + hxF(f, 4)
	}
	return "$" + hxF(f, 2)
}

func hxFormatNumber(v any) string {
	if f, ok := hxNumeric(v); ok {
		return hxFormatNumberF(f)
	}
	if v == nil {
		return "0"
	}
	return hxText(v)
}

func hxFormatNumberF(f float64) string {
	if f == math.Trunc(f) && math.Abs(f) < 1e15 {
		return hxGroup(strconv.FormatInt(int64(f), 10))
	}
	return hxGroup(hxF(f, 1))
}

func hxTokensF(f float64) string {
	if f >= 1_000_000 {
		return hxF(f/1_000_000, 1) + "M"
	}
	if f >= 1_000 {
		return hxF(f/1_000, 0) + "k"
	}
	return hxFormatNumberF(f)
}

func hxSeverityColor(v any) string {
	if s, ok := v.(string); ok {
		switch s {
		case "high":
			return "#dc2626"
		case "medium":
			return "#d97706"
		case "low":
			return "#2563eb"
		}
	}
	return "#6b7280"
}

func hxPriorityColor(v any) string {
	if s, ok := v.(string); ok {
		switch s {
		case "high":
			return "#dc2626"
		case "medium":
			return "#d97706"
		case "low":
			return "#16a34a"
		}
	}
	return "#6b7280"
}

func hxHealthBadge(v any) string {
	fg, bg := "#6b7280", "#f1f5f9"
	if s, ok := v.(string); ok {
		switch s {
		case "healthy":
			fg, bg = "#16a34a", "#f0fdf4"
		case "mixed":
			fg, bg = "#d97706", "#fffbeb"
		case "concerning":
			fg, bg = "#dc2626", "#fef2f2"
		}
	}
	return `<span class="health-badge" style="background:` + bg + `;color:` + fg +
		`;border:1px solid ` + fg + `30;">` + strings.ToUpper(hxEsc(v)) + `</span>`
}

type hxItem struct {
	label any
	value float64
}

type hxKV struct {
	key string
	raw any
}

// hxSortedKVDesc orders entries by descending numeric value; ties follow the
// jsonb object key normalization (shorter keys first, then bytewise).
func hxSortedKVDesc(m map[string]any) []hxKV {
	kvs := make([]hxKV, 0, len(m))
	for k, v := range m {
		kvs = append(kvs, hxKV{key: k, raw: v})
	}
	sort.Slice(kvs, func(i, j int) bool {
		vi, _ := hxNumeric(kvs[i].raw)
		vj, _ := hxNumeric(kvs[j].raw)
		if vi != vj {
			return vi > vj
		}
		if len(kvs[i].key) != len(kvs[j].key) {
			return len(kvs[i].key) < len(kvs[j].key)
		}
		return kvs[i].key < kvs[j].key
	})
	return kvs
}

func hxKVItems(kvs []hxKV, limit int) []hxItem {
	if len(kvs) > limit {
		kvs = kvs[:limit]
	}
	out := make([]hxItem, 0, len(kvs))
	for _, kv := range kvs {
		n, _ := hxNumeric(kv.raw)
		out = append(out, hxItem{label: kv.key, value: n})
	}
	return out
}

// hxPairItems reads [label, value] entries from the first limit rows.
func hxPairItems(list []any, limit int) []hxItem {
	if len(list) > limit {
		list = list[:limit]
	}
	out := make([]hxItem, 0, len(list))
	for _, raw := range list {
		pair := asList(raw)
		if len(pair) < 2 {
			continue
		}
		n, _ := hxNumeric(pair[1])
		out = append(out, hxItem{label: pair[0], value: n})
	}
	return out
}

func hxCountBarChart(items []hxItem, color string) string {
	if len(items) == 0 {
		return ""
	}
	maxVal := items[0].value
	for _, it := range items[1:] {
		if it.value > maxVal {
			maxVal = it.value
		}
	}
	if maxVal == 0 {
		maxVal = 1
	}
	var b strings.Builder
	for _, it := range items {
		pct := it.value / maxVal * 100
		b.WriteString(`<div class="chart-bar-row">
  <span class="chart-label">` + hxEsc(it.label) + `</span>
  <div class="chart-bar-container">
    <div class="chart-bar" style="width:` + hxF(pct, 1) + `%;background:` + color + `"></div>
  </div>
  <span class="chart-value">` + hxFormatNumberF(it.value) + `</span>
</div>`)
	}
	return b.String()
}

func hxPctBarChart(items []hxItem, color string) string {
	if len(items) == 0 {
		return ""
	}
	var b strings.Builder
	for _, it := range items {
		b.WriteString(`<div class="chart-bar-row">
  <span class="chart-label">` + hxEsc(it.label) + `</span>
  <div class="chart-bar-container">
    <div class="chart-bar" style="width:` + hxF(it.value, 1) + `%;background:` + color + `"></div>
  </div>
  <span class="chart-value">` + hxF(it.value, 0) + `%</span>
</div>`)
	}
	return b.String()
}

const hxDocHead = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <title>`

const hxDocStyle = `</title>
  <style>
    :root {
      --bg: #fafaf9;
      --bg-alt: #f5f5f4;
      --card-bg: #ffffff;
      --text: #1c1917;
      --text-secondary: #44403c;
      --text-muted: #78716c;
      --border: #e7e5e4;
      --border-light: #f5f5f4;
      --green: #15803d;
      --green-bg: #f0fdf4;
      --green-border: #bbf7d0;
      --red: #b91c1c;
      --red-bg: #fef2f2;
      --red-border: #fecaca;
      --amber: #b45309;
      --amber-bg: #fffbeb;
      --amber-border: #fde68a;
      --blue: #1d4ed8;
      --blue-bg: #eff6ff;
      --blue-border: #bfdbfe;
      --accent: #2563eb;
      --accent-bg: #eff6ff;
      --accent-border: #bfdbfe;
      --accent-light: #3b82f6;
      --shadow-sm: 0 1px 2px rgba(28,25,23,0.03);
      --shadow: 0 1px 3px rgba(28,25,23,0.04), 0 1px 2px rgba(28,25,23,0.03);
      --shadow-md: 0 4px 6px -1px rgba(28,25,23,0.05), 0 2px 4px -2px rgba(28,25,23,0.03);
      --radius: 16px;
      --radius-sm: 10px;
      --radius-xs: 6px;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #1c1917;
        --bg-alt: #292524;
        --card-bg: #292524;
        --text: #fafaf9;
        --text-secondary: #d6d3d1;
        --text-muted: #a8a29e;
        --border: #44403c;
        --border-light: #292524;
        --green-bg: #052e16;
        --green-border: #166534;
        --red-bg: #450a0a;
        --red-border: #991b1b;
        --amber-bg: #451a03;
        --amber-border: #92400e;
        --blue-bg: #1e3a5f;
        --blue-border: #1d4ed8;
        --accent: #3b82f6;
        --accent-bg: #172554;
        --accent-border: #1d4ed8;
        --accent-light: #60a5fa;
        --shadow-sm: 0 1px 2px rgba(0,0,0,0.3);
        --shadow: 0 1px 3px rgba(0,0,0,0.4);
        --shadow-md: 0 4px 6px rgba(0,0,0,0.4);
      }
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      padding: 56px 24px;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      font-size: 15px;
    }

    .container {
      max-width: 960px;
      margin: 0 auto;
    }

    /* ─── Header ─── */
    header {
      text-align: center;
      margin-bottom: 48px;
      padding: 32px;
      background: var(--card-bg);
      border-radius: var(--radius);
      border: 1px solid var(--border);
      box-shadow: var(--shadow-md);
    }

    .brand {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 2.5px;
      text-transform: uppercase;
      color: var(--accent);
      margin-bottom: 16px;
    }

    header h1 {
      font-size: 24px;
      font-weight: 600;
      margin-bottom: 8px;
      color: var(--text);
      letter-spacing: -0.02em;
    }

    header .subtitle {
      color: var(--text-muted);
      font-size: 14px;
      line-height: 1.5;
    }

    /* ─── Sections ─── */
    section {
      background: var(--card-bg);
      border-radius: var(--radius);
      padding: 32px;
      margin-bottom: 20px;
      border: 1px solid var(--border);
      box-shadow: var(--shadow);
    }

    section h2 {
      font-size: 17px;
      font-weight: 600;
      margin-bottom: 20px;
      color: var(--text);
      letter-spacing: -0.01em;
    }

    .narrative {
      color: var(--text-secondary);
      margin-bottom: 20px;
      white-space: pre-wrap;
      font-size: 14px;
      line-height: 1.7;
    }

    .section-intro {
      color: var(--text-muted);
      margin-bottom: 20px;
      font-size: 14px;
    }

    /* ─── At a Glance ─── */
    .at-a-glance-section {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-top: 3px solid var(--accent);
    }

    .glance-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
    }

    .glance-header h2 { margin-bottom: 0; }

    .health-badge {
      font-size: 11px;
      font-weight: 700;
      padding: 5px 14px;
      border-radius: 20px;
      letter-spacing: 0.5px;
    }

    .glance-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 16px;
    }

    .glance-item {
      display: flex;
      gap: 12px;
      padding: 16px;
      border-radius: var(--radius-sm);
      align-items: flex-start;
    }

    .glance-icon {
      font-size: 20px;
      flex-shrink: 0;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
    }

    .glance-item h4 {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }

    .glance-item p {
      font-size: 13px;
      color: var(--text-secondary);
      line-height: 1.5;
    }

    .glance-good { background: var(--green-bg); border: 1px solid var(--green-border); }
    .glance-good h4 { color: var(--green); }
    .glance-good .glance-icon { background: var(--green-border); color: var(--green); }

    .glance-bad { background: var(--red-bg); border: 1px solid var(--red-border); }
    .glance-bad h4 { color: var(--red); }
    .glance-bad .glance-icon { background: var(--red-border); color: var(--red); }

    .glance-action { background: var(--blue-bg); border: 1px solid var(--blue-border); }
    .glance-action h4 { color: var(--blue); }
    .glance-action .glance-icon { background: var(--blue-border); color: var(--blue); }

    .glance-ambitious { background: var(--accent-bg); border: 1px solid var(--accent-border); }
    .glance-ambitious h4 { color: var(--accent); }
    .glance-ambitious .glance-icon { background: var(--accent-border); color: var(--accent); }

    /* ─── Stats Row ─── */
    .stats-row-section {
      background: var(--card-bg);
      padding: 20px 28px;
    }

    .stats-row {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 8px;
    }

    .stat-item {
      text-align: center;
      padding: 16px 8px;
      border-radius: var(--radius-sm);
      background: var(--bg-alt);
      border: 1px solid var(--border);
    }

    .stat-value {
      display: block;
      font-size: 22px;
      font-weight: 700;
      color: var(--text);
      line-height: 1.2;
    }

    .stat-value.stat-positive { font-size: 14px; color: var(--green); }
    .stat-value.stat-negative { font-size: 14px; color: var(--red); }

    .stat-label {
      display: block;
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 4px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-weight: 600;
    }

    .stat-sub {
      display: block;
      font-size: 10px;
      color: var(--text-muted);
      margin-top: 2px;
    }

    /* ─── Areas ─── */
    .areas-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 12px;
    }

    .area-card {
      padding: 16px;
      border-radius: var(--radius-sm);
      background: var(--bg-alt);
      border: 1px solid var(--border);
    }

    .area-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }

    .area-header h4 {
      font-size: 14px;
      font-weight: 600;
    }

    .area-count {
      font-size: 12px;
      color: var(--text-muted);
      background: var(--card-bg);
      padding: 2px 8px;
      border-radius: 10px;
      border: 1px solid var(--border);
    }

    .area-card p {
      font-size: 13px;
      color: var(--text-muted);
    }

    /* ─── Charts ─── */
    .charts-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 20px;
    }

    .chart-panel {
      background: var(--bg-alt);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 20px;
    }

    .chart-panel h3 {
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
      margin-bottom: 16px;
    }

    .chart-bar-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
    }

    .chart-label {
      font-size: 12px;
      min-width: 90px;
      max-width: 90px;
      color: var(--text-secondary);
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .chart-bar-container {
      flex: 1;
      height: 22px;
      background: var(--border-light);
      border-radius: 4px;
      overflow: hidden;
    }

    .chart-bar {
      height: 100%;
      border-radius: 4px;
      transition: width 0.3s ease;
      min-width: 2px;
    }

    .chart-value {
      font-size: 12px;
      font-weight: 700;
      min-width: 45px;
      text-align: right;
      color: var(--text);
    }

    /* ─── Usage Patterns ─── */
    .top-tasks { margin: 16px 0; }
    .top-tasks h4 { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
    .top-tasks ul { padding-left: 20px; }
    .top-tasks li { font-size: 13px; color: var(--text-secondary); margin-bottom: 4px; }

    .session-profile-card {
      background: var(--bg-alt);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 16px;
      margin-top: 16px;
    }

    .session-profile-card h4 {
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
      margin-bottom: 12px;
    }

    .profile-stats {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
    }

    .profile-stat {
      text-align: center;
    }

    .profile-val {
      display: block;
      font-size: 20px;
      font-weight: 700;
      color: var(--accent);
    }

    .profile-lbl {
      display: block;
      font-size: 11px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.3px;
      margin-top: 2px;
    }

    /* ─── Heatmap ─── */
    .heatmap-section { margin-top: 20px; }
    .heatmap-section h4 { font-size: 14px; font-weight: 600; margin-bottom: 10px; }

    .heatmap-row {
      display: grid;
      grid-template-columns: repeat(24, 1fr);
      gap: 3px;
    }

    .heatmap-cell {
      aspect-ratio: 1;
      background: var(--accent);
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 9px;
      color: white;
      font-weight: 600;
    }

    .heatmap-legend {
      display: flex;
      justify-content: space-between;
      font-size: 10px;
      color: var(--text-muted);
      margin-top: 6px;
      padding: 0 2px;
    }

    /* ─── Strengths ─── */
    .strengths-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 12px;
    }

    .strength-card {
      background: var(--green-bg);
      border: 1px solid var(--green-border);
      padding: 16px;
      border-radius: var(--radius-sm);
    }

    .strength-card h4 {
      color: var(--green);
      font-size: 14px;
      margin-bottom: 6px;
    }

    .strength-card p {
      font-size: 13px;
      color: var(--text-secondary);
    }

    /* ─── Friction ─── */
    .friction-list {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .friction-card {
      padding: 18px;
      border-radius: var(--radius-sm);
      background: var(--bg-alt);
      border: 1px solid var(--border);
    }

    .friction-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 10px;
    }

    .friction-header h4 { flex: 1; font-size: 15px; }

    .severity-badge, .priority-badge {
      font-size: 10px;
      padding: 3px 10px;
      border-radius: 12px;
      font-weight: 700;
      letter-spacing: 0.5px;
    }

    .friction-card p {
      font-size: 13px;
      color: var(--text-secondary);
      margin-bottom: 6px;
    }

    .evidence {
      display: block;
      background: var(--bg-alt);
      color: var(--text-secondary);
      padding: 10px 14px;
      border-radius: var(--radius-xs);
      border: 1px solid var(--border);
      font-size: 12px;
      margin: 10px 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: 'SF Mono', 'Fira Code', 'Menlo', monospace;
    }

    .impact {
      color: var(--text-muted);
      font-size: 12px;
      margin-top: 8px;
    }

    /* ─── Suggestions ─── */
    .suggestions-list {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .suggestion-card {
      padding: 18px;
      border-radius: var(--radius-sm);
      background: var(--bg-alt);
      border: 1px solid var(--border);
    }

    .suggestion-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
    }

    .suggestion-num {
      font-size: 18px;
      font-weight: 700;
      color: var(--accent);
      min-width: 36px;
    }

    .suggestion-header h4 { flex: 1; font-size: 15px; }

    .suggestion-action {
      background: var(--card-bg);
      padding: 12px 14px;
      border-radius: var(--radius-xs);
      border: 1px solid var(--border);
      margin-bottom: 10px;
    }

    .action-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .action-text {
      font-size: 13px;
      color: var(--text-secondary);
      flex: 1;
    }

    .copy-btn {
      background: var(--accent);
      color: white;
      border: none;
      padding: 5px 12px;
      border-radius: var(--radius-xs);
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      flex-shrink: 0;
      transition: background 0.2s;
    }

    .copy-btn:hover { background: #1d4ed8; }
    .copy-btn:active { background: #1e40af; }

    .suggestion-why {
      font-size: 13px;
      color: var(--text-muted);
    }

    .suggestion-meta {
      display: flex;
      gap: 8px;
      margin-top: 10px;
      flex-wrap: wrap;
    }

    .meta-badge {
      font-size: 10px;
      padding: 3px 8px;
      border-radius: 10px;
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text-muted);
      font-weight: 600;
    }

    /* ─── Repeated Instructions Table ─── */
    .repeated-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }

    .repeated-table thead {
      background: var(--bg-alt);
    }

    .repeated-table th {
      padding: 10px 14px;
      text-align: left;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
      border-bottom: 2px solid var(--border);
    }

    .repeated-table td {
      padding: 12px 14px;
      border-bottom: 1px solid var(--border);
    }

    .instruction-cell {
      color: var(--text-secondary);
    }

    .freq-cell {
      font-weight: 700;
      color: var(--purple);
      width: 100px;
      text-align: center;
    }

    /* ─── Cost Analysis ─── */
    .cost-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 20px;
    }

    .cost-card {
      text-align: center;
      padding: 16px;
      border-radius: var(--radius-sm);
      background: var(--bg-alt);
      border: 1px solid var(--border);
    }

    .cost-val {
      display: block;
      font-size: 22px;
      font-weight: 700;
      color: var(--text);
    }

    .cost-lbl {
      display: block;
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 4px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      font-weight: 600;
    }

    .model-breakdown {
      margin-top: 16px;
    }

    .model-breakdown h4 {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 8px;
    }

    .cost-opportunities {
      margin-top: 16px;
      background: var(--amber-bg);
      border: 1px solid var(--amber-border);
      border-radius: var(--radius-sm);
      padding: 16px;
    }

    .cost-opportunities h4 {
      font-size: 13px;
      font-weight: 700;
      color: var(--amber);
      margin-bottom: 8px;
    }

    .cost-opportunities ul {
      padding-left: 18px;
    }

    .cost-opportunities li {
      font-size: 13px;
      color: var(--text-secondary);
      margin-bottom: 4px;
    }

    /* ─── Tables (generic) ─── */
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }

    thead { background: var(--bg-alt); }

    th, td {
      padding: 10px 14px;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }

    th {
      font-weight: 700;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
    }

    code {
      background: var(--bg-alt);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 12px;
      font-family: 'SF Mono', 'Fira Code', monospace;
    }

    /* ─── Regression ─── */
    .regression-section {
      border-left: 4px solid var(--amber);
    }

    .regression-table th, .regression-table td {
      font-size: 12px;
      padding: 8px 10px;
    }

    /* ─── Fun Ending ─── */
    .fun-ending-section {
      background: var(--accent-bg);
      border: 1px solid var(--accent-border);
    }

    .fun-card {
      text-align: center;
      padding: 28px;
    }

    .fun-card h3 {
      font-size: 18px;
      font-weight: 600;
      color: var(--accent);
      margin-bottom: 10px;
    }

    .fun-card p {
      font-size: 14px;
      color: var(--text-secondary);
      max-width: 600px;
      margin: 0 auto;
    }

    /* ─── Footer ─── */
    footer {
      text-align: center;
      color: var(--text-muted);
      font-size: 12px;
      margin-top: 56px;
      padding: 24px 0;
      border-top: 1px solid var(--border);
    }

    footer .footer-brand {
      font-weight: 600;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: var(--accent);
      font-size: 10px;
      margin-bottom: 4px;
    }

    /* ─── Responsive ─── */
    @media (max-width: 768px) {
      body { padding: 24px 12px; }
      section { padding: 20px 16px; }

      .stats-row { grid-template-columns: repeat(3, 1fr); }
      .glance-grid { grid-template-columns: 1fr; }
      .charts-grid { grid-template-columns: 1fr; }
      .strengths-grid { grid-template-columns: 1fr; }
      .areas-grid { grid-template-columns: 1fr; }
      .cost-grid { grid-template-columns: repeat(2, 1fr); }
      .profile-stats { grid-template-columns: repeat(2, 1fr); }
      .heatmap-row { grid-template-columns: repeat(12, 1fr); }
      .heatmap-cell:nth-child(n+13) { display: none; }
    }

    @media (max-width: 480px) {
      .stats-row { grid-template-columns: repeat(2, 1fr); }
      .stat-value { font-size: 18px; }
      header h1 { font-size: 20px; }
    }

    /* ─── Print ─── */
    @media print {
      body { padding: 20px; background: white; }
      section { box-shadow: none; break-inside: avoid; border: 1px solid #ddd; }
      .copy-btn { display: none; }
      header { box-shadow: none; }
      .at-a-glance-section { background: white; }
      .fun-ending-section { background: white; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">CARACAL AGENT INSIGHTS</div>
      <h1>`
