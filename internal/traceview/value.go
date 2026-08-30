// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package traceview

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
)

// loadLine decodes one stored JSONL line, or returns nil when it is not a
// JSON object. session_events keeps raw_line verbatim even for rejected
// lines, so the read path also sees malformed text and bare scalars.
func loadLine(raw string) *Obj {
	value, err := DecodeValue([]byte(raw))
	if err != nil {
		return nil
	}
	obj, ok := value.(*Obj)
	if !ok {
		return nil
	}
	return obj
}

// strField returns a discriminator field as a string, or "" for any other
// type, so hostile transcripts never reach a tag comparison with a non-string.
func strField(obj *Obj, key string) string {
	s, _ := obj.Get(key).(string)
	return s
}

// dictField returns a nested field as an object, or an empty one.
func dictField(obj *Obj, key string) *Obj {
	if nested, ok := obj.Get(key).(*Obj); ok {
		return nested
	}
	return &Obj{}
}

// listField returns a content field as a list, or nil for any other type.
func listField(obj *Obj, key string) []any {
	l, _ := obj.Get(key).([]any)
	return l
}

// getOr returns the value for key, or fallback when the key is absent.
func getOr(obj *Obj, key string, fallback any) any {
	if obj.Has(key) {
		return obj.Get(key)
	}
	return fallback
}

// truthy mirrors JSON-value truthiness: null, false, zero, "", empty
// containers are false; everything else is true.
func truthy(value any) bool {
	switch v := value.(type) {
	case nil:
		return false
	case bool:
		return v
	case string:
		return v != ""
	case json.Number:
		f, err := v.Float64()
		return err == nil && f != 0
	case []any:
		return len(v) > 0
	case *Obj:
		return v.Len() > 0
	default:
		return true
	}
}

// scalarString renders a JSON scalar the way the stored contract expects:
// numbers keep their literal, booleans title-case, null renders as "None",
// and containers use single-quoted display form.
func scalarString(value any) string {
	switch v := value.(type) {
	case nil:
		return "None"
	case bool:
		if v {
			return "True"
		}
		return "False"
	case string:
		return v
	case json.Number:
		return numberString(v)
	case []any:
		var b strings.Builder
		b.WriteByte('[')
		for i, item := range v {
			if i > 0 {
				b.WriteString(", ")
			}
			writeDisplay(&b, item)
		}
		b.WriteByte(']')
		return b.String()
	case *Obj:
		var b strings.Builder
		writeDisplay(&b, v)
		return b.String()
	default:
		return ""
	}
}

// writeDisplay renders nested container members in display form, where
// strings are single-quoted.
func writeDisplay(b *strings.Builder, value any) {
	switch v := value.(type) {
	case string:
		b.WriteByte('\'')
		b.WriteString(strings.ReplaceAll(strings.ReplaceAll(v, `\`, `\\`), `'`, `\'`))
		b.WriteByte('\'')
	case *Obj:
		b.WriteByte('{')
		for i, key := range v.Keys() {
			if i > 0 {
				b.WriteString(", ")
			}
			writeDisplay(b, key)
			b.WriteString(": ")
			writeDisplay(b, v.Get(key))
		}
		b.WriteByte('}')
	case []any:
		b.WriteString(scalarString(v))
	default:
		b.WriteString(scalarString(v))
	}
}

// numberString renders a JSON number, keeping integer literals intact and
// giving floats a trailing ".0" when they carry no fraction marker.
func numberString(n json.Number) string {
	return n.String()
}

// floatString renders a float the way the stored contract shows credits:
// integral values keep a ".0" suffix.
func floatString(f float64) string {
	s := strconv.FormatFloat(f, 'g', -1, 64)
	if !strings.ContainsAny(s, ".eE") {
		s += ".0"
	}
	return s
}

// truncChars truncates by character count, matching stored previews.
func truncChars(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n])
}

// ansiRE matches CSI sequences, OSC sequences, and simple escapes.
var ansiRE = regexp.MustCompile(`\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[^\[]`)

// stripANSI removes terminal escape codes for clean web display.
func stripANSI(text string) string {
	if !strings.Contains(text, "\x1b") {
		return text
	}
	return ansiRE.ReplaceAllString(text, "")
}

var (
	cursorTimestampRE = regexp.MustCompile(`(?s)<timestamp>.*?</timestamp>\s*`)
	cursorQueryRE     = regexp.MustCompile(`</?user_query>\s*`)
	cursorReminderRE  = regexp.MustCompile(`</?system_reminder>\s*`)
	cursorAttachedRE  = regexp.MustCompile(`</?attached_files>\s*`)
)

// stripCursorXMLTags removes Cursor's XML wrapper tags from user prompts.
func stripCursorXMLTags(text string) string {
	text = cursorTimestampRE.ReplaceAllString(text, "")
	text = cursorQueryRE.ReplaceAllString(text, "")
	text = cursorReminderRE.ReplaceAllString(text, "")
	text = cursorAttachedRE.ReplaceAllString(text, "")
	return strings.TrimSpace(text)
}

const epochSentinel = "1970-01-01"

// pickTimestamp returns the best available timestamp string: the line's own
// ISO-8601 timestamp, then the row timestamp unless it is the epoch
// sentinel, then the ingestion time.
func pickTimestamp(jsonlTS any, rowTS, ingestedAt string) string {
	if s, ok := jsonlTS.(string); ok && s != "" {
		ts := strings.ReplaceAll(strings.ReplaceAll(s, "T", " "), "Z", "")
		ts = strings.TrimSuffix(ts, "+00:00")
		if !strings.Contains(ts, epochSentinel) {
			return ts
		}
	}
	if !strings.Contains(rowTS, epochSentinel) {
		return rowTS
	}
	return ingestedAt
}
