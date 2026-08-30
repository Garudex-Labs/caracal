// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package migrate

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

func TestParseClickHouseURL(t *testing.T) {
	cases := []struct {
		name    string
		url     string
		httpURL string
		db      string
		user    string
		pass    string
		wantErr bool
	}{
		{"plain", "clickhouse://localhost/caracal", "http://localhost:8123", "caracal", "default", "", false},
		{"tls default port", "clickhouses://u:p@ch.example.com/db", "https://ch.example.com:8443", "db", "u", "p", false},
		{"explicit port", "clickhouse://user:secret@host:9000/tele", "http://host:9000", "tele", "user", "secret", false},
		{"trailing slash db", "clickhouse://host:9000/", "http://host:9000", "default", "default", "", false},
		{"no path db", "clickhouse://host", "http://host:8123", "default", "default", "", false},
		{"host lowercased", "clickhouse://HOST/db", "http://host:8123", "db", "default", "", false},
		{"tls without port", "clickhouses://host/", "https://host:8443", "default", "default", "", false},
		{"raw https keeps http default port", "https://host/db", "https://host:8123", "db", "default", "", false},
		{"raw http", "http://host:8123", "http://host:8123", "default", "default", "", false},
		{"user without password", "clickhouse://user@host/db", "http://host:8123", "db", "user", "", false},
		{"empty password", "clickhouse://user:@host/db", "http://host:8123", "db", "user", "", false},
		{"query ignored", "clickhouse://host/db?secure=1", "http://host:8123", "db", "default", "", false},
		{"missing host", "clickhouse://", "", "", "", "", true},
		{"no scheme", "localhost:8123", "", "", "", "", true},
		{"bad port", "clickhouse://host:bad/db", "", "", "", "", true},
		{"port zero uses default", "clickhouse://host:0/db", "http://host:8123", "db", "default", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			httpURL, db, user, pass, err := ParseClickHouseURL(tc.url)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got %q", httpURL)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if httpURL != tc.httpURL || db != tc.db || user != tc.user || pass != tc.pass {
				t.Fatalf("got (%q, %q, %q, %q), want (%q, %q, %q, %q)",
					httpURL, db, user, pass, tc.httpURL, tc.db, tc.user, tc.pass)
			}
		})
	}
}

func TestDumpsSeparatorsAndEscapes(t *testing.T) {
	doc := NewDoc().Set("a", 1).Set("b", "x").Set("c", []string{"y"})
	if got := dumps(doc); got != `{"a": 1, "b": "x", "c": ["y"]}` {
		t.Fatalf("compact form mismatch: %s", got)
	}
	if got := pyStr("héllo\n\t🎯"); got != `"h\u00e9llo\n\t\ud83c\udfaf"` {
		t.Fatalf("escape mismatch: %s", got)
	}
	if got := pyStr(`quote " back \ slash`); got != `"quote \" back \\ slash"` {
		t.Fatalf("quote escape mismatch: %s", got)
	}
}

func TestDumpsIndentLayout(t *testing.T) {
	doc := NewDoc().
		Set("a", 1).
		Set("b", NewDoc()).
		Set("c", []any{}).
		Set("d", []string{"x"}).
		Set("e", nil).
		Set("f", 1.5).
		Set("g", "é")
	want := strings.Join([]string{
		`{`,
		`  "a": 1,`,
		`  "b": {},`,
		`  "c": [],`,
		`  "d": [`,
		`    "x"`,
		`  ],`,
		`  "e": null,`,
		`  "f": 1.5,`,
		`  "g": "\u00e9"`,
		`}`,
	}, "\n")
	if got := dumpsIndent(doc); got != want {
		t.Fatalf("indent layout mismatch:\n%s", got)
	}
}

func TestPyFloat(t *testing.T) {
	cases := map[float64]string{
		1.5:     "1.5",
		1000.0:  "1000.0",
		1e15:    "1000000000000000.0",
		1e16:    "1e+16",
		1e-5:    "1e-05",
		0.29:    "0.29",
		-0.0001: "-0.0001",
		0:       "0.0",
	}
	for value, want := range cases {
		if got := pyFloat(value); got != want {
			t.Fatalf("pyFloat(%v) = %s, want %s", value, got, want)
		}
	}
}

func TestEncodePGValue(t *testing.T) {
	uid := [16]byte{0x55, 0x0e, 0x84, 0x00, 0xe2, 0x9b, 0x41, 0xd4, 0xa7, 0x16, 0x44, 0x66, 0x55, 0x44, 0x00, 0x00}
	cases := []struct {
		name string
		v    any
		oid  uint32
		want string
	}{
		{"null", nil, 0, "null"},
		{"uuid", uid, oidUUID, `"550e8400-e29b-41d4-a716-446655440000"`},
		{"timestamptz micro", time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC), oidTimestamptz,
			`"2026-01-02T03:04:05.123456+00:00"`},
		{"timestamptz whole second", time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC), oidTimestamptz,
			`"2026-01-02T03:04:05+00:00"`},
		{"naive timestamp", time.Date(2026, 1, 2, 3, 4, 5, 500000000, time.UTC), oidTimestamp,
			`"2026-01-02T03:04:05.500000"`},
		{"date", time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC), oidDate, `"2026-01-02"`},
		{"interval", pgtype.Interval{Microseconds: 1500000, Valid: true}, oidInterval, "1.5"},
		{"bool", true, 0, "true"},
		{"int", int64(42), 0, "42"},
		{"float", 2.5, 0, "2.5"},
		{"string", "héllo", 0, `"h\u00e9llo"`},
		{"jsonb text", `{"k": 1}`, 25, `"{\"k\": 1}"`},
		{"array", []any{"a", int64(1)}, 0, `["a", 1]`},
		{"numeric", pgtype.Numeric{Int: big.NewInt(125), Exp: -2, Valid: true}, oidNumeric, "1.25"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := encodePGValue(tc.v, tc.oid)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("got %s, want %s", got, tc.want)
			}
		})
	}
	if _, err := encodePGValue([]byte{1, 2}, 17); err == nil {
		t.Fatal("expected error for bytea value")
	}
}

func TestCoerceValue(t *testing.T) {
	if v, _ := coerceValue("550e8400-e29b-41d4-a716-446655440000", "uuid"); v != "550e8400-e29b-41d4-a716-446655440000" {
		t.Fatalf("uuid passthrough failed: %v", v)
	}
	v, err := coerceValue("2026-01-02T03:04:05.123456+00:00", "timestamptz")
	if err != nil {
		t.Fatalf("timestamptz parse: %v", err)
	}
	if ts, ok := v.(time.Time); !ok || !ts.Equal(time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)) {
		t.Fatalf("timestamptz value mismatch: %v", v)
	}
	if v, _ := coerceValue("t", "bool"); v != true {
		t.Fatalf("bool coercion failed: %v", v)
	}
	if v, _ := coerceValue(json.Number("3.7"), "int4"); v != int64(3) {
		t.Fatalf("int truncation failed: %v", v)
	}
	if v, _ := coerceValue(json.Number("2.5"), "float8"); v != 2.5 {
		t.Fatalf("float coercion failed: %v", v)
	}
	doc := NewDoc().Set("b", json.Number("1")).Set("a", "x")
	if v, _ := coerceValue(doc, "jsonb"); v != `{"b": 1, "a": "x"}` {
		t.Fatalf("jsonb serialization failed: %v", v)
	}
	if v, _ := coerceValue(json.Number("1.5"), "interval"); v != (pgtype.Interval{Microseconds: 1500000, Valid: true}) {
		t.Fatalf("interval coercion failed: %v", v)
	}
	if v, _ := coerceValue(nil, "uuid"); v != nil {
		t.Fatalf("nil passthrough failed: %v", v)
	}
}

func TestManifestRoundTrip(t *testing.T) {
	dir := t.TempDir()
	counts := map[string]int64{}
	hashes := map[string]string{}
	for _, table := range insertOrder {
		counts[table] = 0
		hashes[table] = strings.Repeat("0", 64)
	}
	counts["users"] = 3
	hashes["users"] = strings.Repeat("a", 64)
	manifest := buildPGManifest("mig-1", "2026-01-02T03:04:05.123456+00:00", "abc123", counts, hashes)
	path := filepath.Join(dir, "manifest.json")
	if err := writeManifest(path, manifest); err != nil {
		t.Fatalf("writeManifest: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("manifest mode = %o, want 0600", info.Mode().Perm())
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	text := string(raw)
	if !strings.HasPrefix(text, "{\n  \"schema_version\": \"1.0\",\n  \"migration_id\": \"mig-1\",") {
		t.Fatalf("unexpected manifest head:\n%s", text[:120])
	}
	if !strings.HasSuffix(text, "}\n") {
		t.Fatal("manifest must end with a closing brace and newline")
	}
	parsed, err := readManifest(path)
	if err != nil {
		t.Fatalf("readManifest: %v", err)
	}
	if parsed.GetString("source_alembic_version") != "abc123" {
		t.Fatal("alembic version did not round-trip")
	}
	tables := parsed.GetDoc("tables")
	keys := tables.Keys()
	if len(keys) != len(insertOrder) {
		t.Fatalf("tables carry %d entries, want %d", len(keys), len(insertOrder))
	}
	for i, table := range insertOrder {
		if keys[i] != table {
			t.Fatalf("table order mismatch at %d: %s != %s", i, keys[i], table)
		}
	}
	users := tables.GetDoc("users")
	if users.GetString("checksum") != strings.Repeat("a", 64) || users.GetInt("row_count") != 3 {
		t.Fatal("users entry did not round-trip")
	}

	ranges := NewDoc().Set("users", NewDoc().Set("min_id", "0001").Set("max_id", "fffe"))
	migManifest := buildMigrationManifest("mig-1", "2026-01-02T03:04:05+00:00", "hash", counts, ranges)
	wantKeys := []string{"migration_id", "phase1_completed_at", "source_db_url_hash", "table_row_counts", "uuid_ranges"}
	for i, key := range migManifest.Keys() {
		if key != wantKeys[i] {
			t.Fatalf("migration manifest key order mismatch: %v", migManifest.Keys())
		}
	}
}

func writeTestArchive(t *testing.T, dir string) string {
	t.Helper()
	staging := filepath.Join(dir, "staging")
	pgDir := filepath.Join(staging, "pg")
	if err := os.MkdirAll(pgDir, 0o755); err != nil {
		t.Fatal(err)
	}
	counts := map[string]int64{}
	hashes := map[string]string{}
	for _, table := range insertOrder {
		content := ""
		if table == "users" {
			content = "{\"id\": \"550e8400-e29b-41d4-a716-446655440000\", \"email\": \"a@example.com\"}\n"
		}
		path := filepath.Join(pgDir, table+".jsonl")
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		hash, err := sha256File(path)
		if err != nil {
			t.Fatal(err)
		}
		counts[table] = 0
		hashes[table] = hash
	}
	counts["users"] = 1
	manifestPath := filepath.Join(staging, "manifest.json")
	if err := writeManifest(manifestPath,
		buildPGManifest("mig-t", "2026-01-02T03:04:05+00:00", "abc", counts, hashes)); err != nil {
		t.Fatal(err)
	}
	migrationManifestPath := filepath.Join(staging, "migration_manifest.json")
	if err := writeManifest(migrationManifestPath,
		buildMigrationManifest("mig-t", "2026-01-02T03:04:05+00:00", "h", counts, NewDoc())); err != nil {
		t.Fatal(err)
	}
	archivePath := filepath.Join(dir, "export.tar.gz")
	if err := packPGArchive(archivePath, manifestPath, migrationManifestPath, pgDir); err != nil {
		t.Fatalf("packPGArchive: %v", err)
	}
	return archivePath
}

func TestPackExtractChecksums(t *testing.T) {
	dir := t.TempDir()
	archivePath := writeTestArchive(t, dir)

	info, err := os.Stat(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("archive mode = %o, want 0600", info.Mode().Perm())
	}
	if !IsTarGz(archivePath) {
		t.Fatal("archive should be recognized as tar.gz")
	}

	dest := filepath.Join(dir, "out")
	if err := os.MkdirAll(dest, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := safeExtract(archivePath, dest); err != nil {
		t.Fatalf("safeExtract: %v", err)
	}
	manifest, err := readManifest(filepath.Join(dest, "manifest.json"))
	if err != nil {
		t.Fatalf("extracted manifest unreadable: %v", err)
	}
	tables := manifest.GetDoc("tables")
	for _, table := range insertOrder {
		expected := tables.GetDoc(table).GetString("checksum")
		actual, err := sha256File(filepath.Join(dest, "pg", table+".jsonl"))
		if err != nil {
			t.Fatalf("hash %s: %v", table, err)
		}
		if actual != expected {
			t.Fatalf("checksum mismatch for %s after round-trip", table)
		}
	}
	if tables.GetDoc("users").GetInt("row_count") != 1 {
		t.Fatal("users row count did not survive the round-trip")
	}
}

func writeMaliciousArchive(t *testing.T, path string, header *tar.Header, content []byte) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(header); err != nil {
		t.Fatal(err)
	}
	if len(content) > 0 {
		if _, err := tw.Write(content); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestSafeExtractRejectsTraversal(t *testing.T) {
	dir := t.TempDir()
	cases := []struct {
		name   string
		header *tar.Header
	}{
		{"parent traversal", &tar.Header{Name: "../evil.txt", Mode: 0o644, Size: 4, Typeflag: tar.TypeReg}},
		{"absolute path", &tar.Header{Name: "/abs.txt", Mode: 0o644, Size: 4, Typeflag: tar.TypeReg}},
		{"nested traversal", &tar.Header{Name: "pg/../../evil.txt", Mode: 0o644, Size: 4, Typeflag: tar.TypeReg}},
		{"symlink", &tar.Header{Name: "link", Linkname: "/etc/passwd", Typeflag: tar.TypeSymlink}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			archive := filepath.Join(dir, strings.ReplaceAll(tc.name, " ", "-")+".tar.gz")
			content := []byte(nil)
			if tc.header.Typeflag == tar.TypeReg {
				content = []byte("evil")
			}
			writeMaliciousArchive(t, archive, tc.header, content)
			dest := filepath.Join(dir, strings.ReplaceAll(tc.name, " ", "-"))
			if err := os.MkdirAll(dest, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := safeExtract(archive, dest); err == nil {
				t.Fatal("expected traversal rejection")
			}
		})
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(dir), "evil.txt")); err == nil {
		t.Fatal("traversal artifact escaped the destination")
	}
}

func TestIsTarGzRejectsOtherContent(t *testing.T) {
	dir := t.TempDir()
	plain := filepath.Join(dir, "plain.txt")
	if err := os.WriteFile(plain, []byte("not an archive"), 0o644); err != nil {
		t.Fatal(err)
	}
	if IsTarGz(plain) {
		t.Fatal("plain file must not be detected as tar.gz")
	}
}

func TestMonthRange(t *testing.T) {
	minT := time.Date(2025, 11, 15, 10, 0, 0, 0, time.UTC)
	maxT := time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC)
	got := monthRange(minT, maxT)
	want := []int{202511, 202512, 202601, 202602}
	if len(got) != len(want) {
		t.Fatalf("monthRange = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("monthRange = %v, want %v", got, want)
		}
	}
	single := monthRange(minT, minT)
	if len(single) != 1 || single[0] != 202511 {
		t.Fatalf("single month range = %v", single)
	}
}

func TestPartitionFilenameRoundTrip(t *testing.T) {
	name := partitionFilename("session_events", 202501)
	if name != "session_events_2025-01.parquet" {
		t.Fatalf("partitionFilename = %s", name)
	}
	month, err := partitionMonth(name)
	if err != nil || month != 202501 {
		t.Fatalf("partitionMonth = %d, %v", month, err)
	}
}

func TestWriteImportStateLayout(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".import_state.json")
	if err := writeImportState(path, map[string]bool{"b": true, "a": true}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := "{\n  \"completed\": [\n    \"a\",\n    \"b\"\n  ]\n}"
	if string(raw) != want {
		t.Fatalf("state layout mismatch:\n%s", string(raw))
	}
}

func TestIsEmptyParquet(t *testing.T) {
	dir := t.TempDir()
	empty := filepath.Join(dir, "empty.parquet")
	if err := os.WriteFile(empty, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if !isEmptyParquet(empty) {
		t.Fatal("zero-byte file must count as empty")
	}
	invalid := filepath.Join(dir, "invalid.parquet")
	if err := os.WriteFile(invalid, []byte("this is not parquet data"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !isEmptyParquet(invalid) {
		t.Fatal("file without magic markers must count as empty")
	}
	valid := filepath.Join(dir, "valid.parquet")
	if err := os.WriteFile(valid, []byte("PAR1somebodybytesPAR1"), 0o644); err != nil {
		t.Fatal(err)
	}
	if isEmptyParquet(valid) {
		t.Fatal("file with magic markers must not count as empty")
	}
}

func TestBuildQueries(t *testing.T) {
	cfg := clickhouseTables[0] // session_events, replacing, timestamp
	if got := buildCHExportQuery(cfg, 202501, true); got !=
		"SELECT * FROM session_events FINAL WHERE toYYYYMM(timestamp) = 202501 AND timestamp < {cutoff:String} FORMAT Parquet" {
		t.Fatalf("export query mismatch: %s", got)
	}
	audit := clickhouseTables[4] // audit_log, mergetree
	if got := buildCHCountQuery(audit, 202501, false); got !=
		"SELECT count() AS cnt FROM audit_log WHERE toYYYYMM(timestamp) = 202501 FORMAT JSON" {
		t.Fatalf("count query mismatch: %s", got)
	}
	if got := buildCHTimeRangeQuery(cfg); got !=
		"SELECT min(timestamp) AS min_t, max(timestamp) AS max_t FROM session_events FINAL FORMAT JSON" {
		t.Fatalf("time range query mismatch: %s", got)
	}
	sel, err := buildSelect("agents", []string{"id", "model_config_json"}, []uint32{oidUUID, oidJSONB})
	if err != nil {
		t.Fatal(err)
	}
	if sel != `SELECT "id", "model_config_json"::text AS "model_config_json" FROM "agents"` {
		t.Fatalf("select mismatch: %s", sel)
	}
	plain, err := buildSelect("users", []string{"id", "email"}, []uint32{oidUUID, 25})
	if err != nil {
		t.Fatal(err)
	}
	if plain != `SELECT * FROM "users"` {
		t.Fatalf("plain select mismatch: %s", plain)
	}
	if _, err := buildSelect("bogus", nil, nil); err == nil {
		t.Fatal("unknown table must be rejected")
	}
	insert := buildInsert("agents", []string{"id", "model_config_json"},
		map[string]string{"id": "uuid", "model_config_json": "jsonb"})
	if insert != `INSERT INTO "agents" ("id", "model_config_json") VALUES ($1, $2::jsonb) ON CONFLICT ("id") DO NOTHING` {
		t.Fatalf("insert mismatch: %s", insert)
	}
}
