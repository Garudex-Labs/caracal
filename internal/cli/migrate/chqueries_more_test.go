// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package migrate

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCHQueryBuildersEngineVariants(t *testing.T) {
	replacing := clickhouseTables[0] // session_events, replacing, timestamp
	merge := clickhouseTables[4]     // audit_log, mergetree, timestamp

	if got := buildCHTimeRangeQuery(merge); got !=
		"SELECT min(timestamp) AS min_t, max(timestamp) AS max_t FROM audit_log FORMAT JSON" {
		t.Fatalf("mergetree time range: %s", got)
	}
	if got := buildCHExportQuery(replacing, 202501, false); got !=
		"SELECT * FROM session_events FINAL WHERE toYYYYMM(timestamp) = 202501 FORMAT Parquet" {
		t.Fatalf("replacing export no cutoff: %s", got)
	}
	if got := buildCHExportQuery(merge, 202501, false); got !=
		"SELECT * FROM audit_log WHERE toYYYYMM(timestamp) = 202501 FORMAT Parquet" {
		t.Fatalf("mergetree export: %s", got)
	}
	if got := buildCHCountQuery(replacing, 202501, true); got !=
		"SELECT count() AS cnt FROM session_events FINAL WHERE toYYYYMM(timestamp) = 202501 "+
			"AND timestamp < {cutoff:String} FORMAT JSON" {
		t.Fatalf("replacing count with cutoff: %s", got)
	}
	if got := buildPartitionCheckQuery(replacing, 202501); got !=
		"SELECT 1 AS has_data FROM session_events FINAL WHERE toYYYYMM(timestamp) = 202501 LIMIT 1 FORMAT JSON" {
		t.Fatalf("replacing partition check: %s", got)
	}
	if got := buildPartitionCheckQuery(merge, 202501); got !=
		"SELECT 1 AS has_data FROM audit_log WHERE toYYYYMM(timestamp) = 202501 LIMIT 1 FORMAT JSON" {
		t.Fatalf("mergetree partition check: %s", got)
	}
}

func TestParseCHTimestamp(t *testing.T) {
	cases := map[string]time.Time{
		"2025-01-15 10:30:00":        time.Date(2025, 1, 15, 10, 30, 0, 0, time.UTC),
		"2025-01-15 10:30:00.123456": time.Date(2025, 1, 15, 10, 30, 0, 123456000, time.UTC),
	}
	for in, want := range cases {
		got, err := parseCHTimestamp(in)
		if err != nil {
			t.Fatalf("parseCHTimestamp(%q): %v", in, err)
		}
		if !got.Equal(want) {
			t.Fatalf("parseCHTimestamp(%q) = %v, want %v", in, got, want)
		}
	}
	if _, err := parseCHTimestamp("notatime"); err == nil {
		t.Fatal("unparseable ClickHouse timestamp must error")
	}
}

func TestPartitionFilenameAndMonth(t *testing.T) {
	cases := []struct {
		table string
		month int
		file  string
	}{
		{"audit_log", 202512, "audit_log_2025-12.parquet"},
		{"session_stats_agg", 202503, "session_stats_agg_2025-03.parquet"},
	}
	for _, tc := range cases {
		if got := partitionFilename(tc.table, tc.month); got != tc.file {
			t.Fatalf("partitionFilename = %s, want %s", got, tc.file)
		}
		month, err := partitionMonth(tc.file)
		if err != nil || month != tc.month {
			t.Fatalf("partitionMonth(%s) = %d, %v", tc.file, month, err)
		}
	}
	for _, bad := range []string{
		"session_events_202501.parquet", // no dash between year and month
		"t_2025-ab.parquet",             // non-numeric month
		"t_20a5-01.parquet",             // non-numeric year
	} {
		if _, err := partitionMonth(bad); err == nil {
			t.Fatalf("partitionMonth(%q) should error", bad)
		}
	}
}

func TestBuildImportQuery(t *testing.T) {
	withProject := buildImportQuery("session_events", [][2]string{
		{"project_id", "String"},
		{"flag", "Enum8('a'=1)"},
	})
	want := "INSERT INTO session_events SELECT * REPLACE ('default' AS project_id) " +
		"FROM input('`project_id` String, `flag` Enum8(\\'a\\'=1)') FORMAT Parquet"
	if withProject != want {
		t.Fatalf("buildImportQuery with project_id:\n got %s\nwant %s", withProject, want)
	}
	if got := buildImportQuery("audit_log", [][2]string{{"id", "UUID"}}); got !=
		"INSERT INTO audit_log FORMAT Parquet" {
		t.Fatalf("buildImportQuery without project_id: %s", got)
	}
	if got := buildImportQuery("empty_tbl", nil); got != "INSERT INTO empty_tbl FORMAT Parquet" {
		t.Fatalf("buildImportQuery empty schema: %s", got)
	}
}

func TestComma(t *testing.T) {
	cases := map[int64]string{
		0: "0", 5: "5", 100: "100", 999: "999",
		1000: "1,000", 12345: "12,345", 1000000: "1,000,000",
		-999: "-999", -12345: "-12,345",
	}
	for in, want := range cases {
		if got := Comma(in); got != want {
			t.Fatalf("Comma(%d) = %s, want %s", in, got, want)
		}
	}
}

func TestWriteImportStateEmpty(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".import_state.json")
	if err := writeImportState(path, map[string]bool{}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != "{\n  \"completed\": []\n}" {
		t.Fatalf("empty import state layout:\n%s", string(raw))
	}
}
