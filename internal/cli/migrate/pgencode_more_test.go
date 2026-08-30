// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package migrate

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

func TestIsoFormatVariants(t *testing.T) {
	base := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	micro := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	cases := []struct {
		name       string
		t          time.Time
		withOffset bool
		want       string
	}{
		{"naive whole second", base, false, "2026-01-02T03:04:05"},
		{"naive micros", micro, false, "2026-01-02T03:04:05.123456"},
		{"offset whole second", base, true, "2026-01-02T03:04:05+00:00"},
		{"offset micros", micro, true, "2026-01-02T03:04:05.123456+00:00"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isoFormat(tc.t, tc.withOffset); got != tc.want {
				t.Fatalf("isoFormat = %s, want %s", got, tc.want)
			}
		})
	}
	// A non-UTC instant is normalized to UTC when the offset is requested.
	loc := time.FixedZone("plus5", 5*3600)
	shifted := time.Date(2026, 1, 2, 8, 4, 5, 0, loc)
	if got := isoFormat(shifted, true); got != "2026-01-02T03:04:05+00:00" {
		t.Fatalf("isoFormat non-UTC = %s, want UTC-normalized", got)
	}
}

func TestUUIDText(t *testing.T) {
	uid := [16]byte{0x55, 0x0e, 0x84, 0x00, 0xe2, 0x9b, 0x41, 0xd4,
		0xa7, 0x16, 0x44, 0x66, 0x55, 0x44, 0x00, 0x00}
	if got := uuidText(uid); got != "550e8400-e29b-41d4-a716-446655440000" {
		t.Fatalf("uuidText = %s", got)
	}
}

func TestEncodePGValueMoreTypes(t *testing.T) {
	uid := [16]byte{0x55, 0x0e, 0x84, 0x00, 0xe2, 0x9b, 0x41, 0xd4,
		0xa7, 0x16, 0x44, 0x66, 0x55, 0x44, 0x00, 0x00}
	cases := []struct {
		name string
		v    any
		oid  uint32
		want string
	}{
		{"int", int(5), 0, "5"},
		{"int16", int16(7), 0, "7"},
		{"int32", int32(-3), 0, "-3"},
		{"float32", float32(1.5), 0, "1.5"},
		{"duration interval", 1500 * time.Millisecond, oidInterval, "1.5"},
		{"interval months days", pgtype.Interval{Months: 1, Days: 2, Microseconds: 1500000, Valid: true},
			oidInterval, "2764801.5"},
		{"nested any array", []any{"a", int64(1), nil}, 0, `["a", 1, null]`},
		{"string array generic", []string{"a", "b"}, 0, `["a", "b"]`},
		{"uuid via generic type", uid, 0, `"550e8400-e29b-41d4-a716-446655440000"`},
		{"time via generic type", time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC), 0,
			`"2026-01-02T03:04:05+00:00"`},
		{"uuid oid from upper string", "550E8400-E29B-41D4-A716-446655440000", oidUUID,
			`"550e8400-e29b-41d4-a716-446655440000"`},
		{"uuid oid falls through to int", int64(42), oidUUID, "42"},
		{"timestamptz oid falls through to string", "raw", oidTimestamptz, `"raw"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := encodePGValue(tc.v, tc.oid)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("encodePGValue = %s, want %s", got, tc.want)
			}
		})
	}

	if _, err := encodePGValue(pgtype.Numeric{Valid: false}, oidNumeric); err == nil {
		t.Fatal("invalid numeric must error")
	}
	if _, err := encodePGValue(map[string]int{}, 0); err == nil {
		t.Fatal("unserializable type must error")
	}
}

func TestBuildSelectCastBranches(t *testing.T) {
	// A plain column carrying the json OID is cast even without a declared entry.
	got, err := buildSelect("users", []string{"id"}, []uint32{oidJSON})
	if err != nil {
		t.Fatal(err)
	}
	if got != `SELECT "id"::text AS "id" FROM "users"` {
		t.Fatalf("json oid cast mismatch: %s", got)
	}
	// A declared JSONB column is cast even when its OID is not a JSON OID.
	got, err = buildSelect("agents", []string{"model_config_json"}, []uint32{oidUUID})
	if err != nil {
		t.Fatal(err)
	}
	if got != `SELECT "model_config_json"::text AS "model_config_json" FROM "agents"` {
		t.Fatalf("declared jsonb cast mismatch: %s", got)
	}
	// No JSON columns => bare wildcard select.
	got, err = buildSelect("users", []string{"id", "email"}, []uint32{oidUUID, 25})
	if err != nil {
		t.Fatal(err)
	}
	if got != `SELECT * FROM "users"` {
		t.Fatalf("plain select mismatch: %s", got)
	}
}

func TestBuildInsertJSONTypeCast(t *testing.T) {
	got := buildInsert("prompt_listings", []string{"id", "variables"},
		map[string]string{"id": "uuid", "variables": "json"})
	want := `INSERT INTO "prompt_listings" ("id", "variables") VALUES ($1, $2::jsonb) ON CONFLICT ("id") DO NOTHING`
	if got != want {
		t.Fatalf("insert json cast mismatch: %s", got)
	}
}

func TestParseArchiveTimestampLayouts(t *testing.T) {
	utc := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	naive := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	cases := []struct {
		in   string
		want time.Time
	}{
		{"2026-01-02T03:04:05.123456+00:00", utc},
		{"2026-01-02T03:04:05.123456", utc},
		{"2026-01-02 03:04:05.123456+00:00", utc},
		{"2026-01-02 03:04:05", naive},
	}
	for _, tc := range cases {
		got, err := parseArchiveTimestamp(tc.in)
		if err != nil {
			t.Fatalf("parseArchiveTimestamp(%q): %v", tc.in, err)
		}
		if !got.Equal(tc.want) {
			t.Fatalf("parseArchiveTimestamp(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
	if _, err := parseArchiveTimestamp("not a timestamp"); err == nil {
		t.Fatal("unparseable timestamp must error")
	}
}

func TestCoerceValueBranches(t *testing.T) {
	// bool coercion table
	boolCases := map[any]bool{
		"t": true, "true": true, "1": true, "yes": true, "TRUE": true,
		"f": false, "no": false, "": false, true: true, false: false,
	}
	for in, want := range boolCases {
		v, err := coerceValue(in, "bool")
		if err != nil {
			t.Fatalf("coerceValue(%v, bool): %v", in, err)
		}
		if v != want {
			t.Fatalf("coerceValue(%v, bool) = %v, want %v", in, v, want)
		}
	}

	if v, _ := coerceValue(json.Number("5"), "int4"); v != int64(5) {
		t.Fatalf("integer int coercion = %v, want 5", v)
	}
	if v, _ := coerceValue(json.Number("2.9"), "int8"); v != int64(2) {
		t.Fatalf("int truncation = %v, want 2", v)
	}
	if v, _ := coerceValue("7", "int4"); v != "7" {
		t.Fatalf("non-number int passthrough = %v, want string 7", v)
	}
	if v, _ := coerceValue(json.Number("2.5"), "numeric"); v != 2.5 {
		t.Fatalf("numeric float = %v", v)
	}
	if v, _ := coerceValue("x", "interval"); v != "x" {
		t.Fatalf("interval non-number passthrough = %v", v)
	}
	if v, _ := coerceValue(json.Number("5"), "timestamptz"); v != int64(5) {
		t.Fatalf("timestamptz non-string falls through = %v", v)
	}
	if _, err := coerceValue("notdate", "timestamptz"); err == nil {
		t.Fatal("bad timestamptz string must error")
	}
	if v, _ := coerceValue(`{"k":1}`, "jsonb"); v != `{"k":1}` {
		t.Fatalf("jsonb string passthrough = %v", v)
	}
	if v, _ := coerceValue(NewDoc().Set("a", json.Number("1")), "json"); v != `{"a": 1}` {
		t.Fatalf("json from Doc = %v", v)
	}
	if v, _ := coerceValue(json.Number("8"), "text"); v != int64(8) {
		t.Fatalf("generic json.Number int = %v", v)
	}
	if v, _ := coerceValue(json.Number("8.5"), "text"); v != 8.5 {
		t.Fatalf("generic json.Number float = %v", v)
	}
	if v, _ := coerceValue("hello", "text"); v != "hello" {
		t.Fatalf("generic passthrough = %v", v)
	}
	if v, err := coerceValue(nil, "text"); err != nil || v != nil {
		t.Fatalf("nil generic = %v, %v", v, err)
	}
}
