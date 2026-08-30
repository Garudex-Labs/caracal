// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package migrate

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

// PostgreSQL type OIDs used to pick textual encodings.
const (
	oidJSON        = 114
	oidTimestamp   = 1114
	oidTimestamptz = 1184
	oidDate        = 1082
	oidInterval    = 1186
	oidNumeric     = 1700
	oidUUID        = 2950
	oidJSONB       = 3802
)

// isoFormat renders a timestamp with second or microsecond precision;
// withOffset appends the +00:00 UTC suffix used for timestamptz values.
func isoFormat(t time.Time, withOffset bool) string {
	if withOffset {
		t = t.UTC()
	}
	out := t.Format("2006-01-02T15:04:05")
	if us := t.Nanosecond() / 1000; us != 0 {
		out += fmt.Sprintf(".%06d", us)
	}
	if withOffset {
		out += "+00:00"
	}
	return out
}

func uuidText(b [16]byte) string {
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// encodePGValue renders one column value as its JSONL token. The OID
// selects timestamp and identifier encodings; other values encode by
// their Go type.
func encodePGValue(v any, oid uint32) (string, error) {
	if v == nil {
		return "null", nil
	}
	switch oid {
	case oidUUID:
		switch t := v.(type) {
		case [16]byte:
			return pyStr(uuidText(t)), nil
		case string:
			return pyStr(strings.ToLower(t)), nil
		}
	case oidTimestamptz:
		if t, ok := v.(time.Time); ok {
			return pyStr(isoFormat(t, true)), nil
		}
	case oidTimestamp:
		if t, ok := v.(time.Time); ok {
			return pyStr(isoFormat(t, false)), nil
		}
	case oidDate:
		if t, ok := v.(time.Time); ok {
			return pyStr(t.Format("2006-01-02")), nil
		}
	case oidInterval:
		switch t := v.(type) {
		case time.Duration:
			return pyFloat(t.Seconds()), nil
		case pgtype.Interval:
			seconds := float64(t.Months)*30*86400 + float64(t.Days)*86400 + float64(t.Microseconds)/1e6
			return pyFloat(seconds), nil
		}
	}
	switch t := v.(type) {
	case bool:
		if t {
			return "true", nil
		}
		return "false", nil
	case string:
		return pyStr(t), nil
	case int16:
		return strconv.FormatInt(int64(t), 10), nil
	case int32:
		return strconv.FormatInt(int64(t), 10), nil
	case int64:
		return strconv.FormatInt(t, 10), nil
	case int:
		return strconv.Itoa(t), nil
	case float32:
		return pyFloat(float64(t)), nil
	case float64:
		return pyFloat(t), nil
	case [16]byte:
		return pyStr(uuidText(t)), nil
	case time.Time:
		return pyStr(isoFormat(t, true)), nil
	case pgtype.Numeric:
		f8, err := t.Float64Value()
		if err != nil || !f8.Valid {
			return "", migrationErrorf("numeric value could not be encoded")
		}
		return pyFloat(f8.Float64), nil
	case []any:
		parts := make([]string, len(t))
		for i, item := range t {
			token, err := encodePGValue(item, 0)
			if err != nil {
				return "", err
			}
			parts[i] = token
		}
		return "[" + strings.Join(parts, ", ") + "]", nil
	case []string:
		parts := make([]string, len(t))
		for i, item := range t {
			parts[i] = pyStr(item)
		}
		return "[" + strings.Join(parts, ", ") + "]", nil
	}
	return "", migrationErrorf("column value of type %T is not serializable", v)
}

// buildSelect builds the export SELECT, casting JSON-typed columns to
// ::text so archive lines carry the serialized form. Table names are
// validated against the export list as a defense-in-depth assertion.
func buildSelect(table string, columns []string, oids []uint32) (string, error) {
	known := false
	for _, t := range insertOrder {
		if t == table {
			known = true
			break
		}
	}
	if !known {
		return "", migrationErrorf("Unknown table: %q", table)
	}
	declared := map[string]bool{}
	for _, col := range jsonbColumns[table] {
		declared[col] = true
	}
	needsCast := false
	parts := make([]string, len(columns))
	for i, col := range columns {
		if declared[col] || oids[i] == oidJSON || oids[i] == oidJSONB {
			parts[i] = fmt.Sprintf(`"%s"::text AS "%s"`, col, col)
			needsCast = true
		} else {
			parts[i] = fmt.Sprintf(`"%s"`, col)
		}
	}
	if !needsCast {
		return fmt.Sprintf(`SELECT * FROM "%s"`, table), nil
	}
	return fmt.Sprintf(`SELECT %s FROM "%s"`, strings.Join(parts, ", "), table), nil
}

// buildInsert builds the idempotent INSERT with ::jsonb casts for JSON
// columns and ON CONFLICT DO NOTHING keyed on id.
func buildInsert(table string, columns []string, colTypes map[string]string) string {
	quoted := make([]string, len(columns))
	placeholders := make([]string, len(columns))
	for i, col := range columns {
		quoted[i] = fmt.Sprintf(`"%s"`, col)
		if t := colTypes[col]; t == "json" || t == "jsonb" {
			placeholders[i] = fmt.Sprintf("$%d::jsonb", i+1)
		} else {
			placeholders[i] = fmt.Sprintf("$%d", i+1)
		}
	}
	return fmt.Sprintf(`INSERT INTO "%s" (%s) VALUES (%s) ON CONFLICT ("id") DO NOTHING`,
		table, strings.Join(quoted, ", "), strings.Join(placeholders, ", "))
}

// parseArchiveTimestamp accepts the timestamp forms written by exports.
func parseArchiveTimestamp(value string) (time.Time, error) {
	layouts := []string{
		"2006-01-02T15:04:05.999999999Z07:00",
		"2006-01-02T15:04:05.999999999",
		"2006-01-02 15:04:05.999999999Z07:00",
		"2006-01-02 15:04:05.999999999",
	}
	for _, layout := range layouts {
		if t, err := time.Parse(layout, value); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("unparseable timestamp %q", value)
}

// coerceValue converts an archive JSON value to the parameter form for
// the target column type.
func coerceValue(v any, pgType string) (any, error) {
	if v == nil {
		return nil, nil
	}
	switch pgType {
	case "uuid":
		if s, ok := v.(string); ok {
			return s, nil
		}
	case "timestamptz", "timestamp":
		if s, ok := v.(string); ok {
			t, err := parseArchiveTimestamp(s)
			if err != nil {
				return nil, err
			}
			return t, nil
		}
	case "interval":
		if n, ok := v.(json.Number); ok {
			seconds, err := n.Float64()
			if err != nil {
				return nil, err
			}
			return pgtype.Interval{Microseconds: int64(seconds * 1e6), Valid: true}, nil
		}
	case "bool":
		switch t := v.(type) {
		case bool:
			return t, nil
		case string:
			lower := strings.ToLower(t)
			return lower == "true" || lower == "t" || lower == "1" || lower == "yes", nil
		}
	case "int4", "int8", "int2":
		if n, ok := v.(json.Number); ok {
			if i, err := n.Int64(); err == nil {
				return i, nil
			}
			f, err := n.Float64()
			if err != nil {
				return nil, err
			}
			return int64(f), nil
		}
	case "float4", "float8", "numeric":
		if n, ok := v.(json.Number); ok {
			f, err := n.Float64()
			if err != nil {
				return nil, err
			}
			return f, nil
		}
	case "json", "jsonb":
		if _, ok := v.(string); !ok {
			return dumps(v), nil
		}
	}
	if n, ok := v.(json.Number); ok {
		if i, err := n.Int64(); err == nil {
			return i, nil
		}
		if f, err := n.Float64(); err == nil {
			return f, nil
		}
	}
	return v, nil
}
