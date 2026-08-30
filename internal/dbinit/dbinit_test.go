// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package dbinit

import (
	"reflect"
	"testing"
)

func TestSplitSQL(t *testing.T) {
	cases := []struct {
		name string
		sql  string
		want []string
	}{
		{"single", "CREATE TABLE t (a String)", []string{"CREATE TABLE t (a String)"}},
		{"two statements", "CREATE TABLE a (x Int8);\nCREATE TABLE b (y Int8);", []string{"CREATE TABLE a (x Int8)", "CREATE TABLE b (y Int8)"}},
		{"semicolon in string", "INSERT INTO t VALUES ('a;b');\nSELECT 1", []string{"INSERT INTO t VALUES ('a;b')", "SELECT 1"}},
		{"escaped quote", `INSERT INTO t VALUES ('it\'s;fine');`, []string{`INSERT INTO t VALUES ('it\'s;fine')`}},
		{"comments dropped", "-- header\n# note\nSELECT 1;", []string{"SELECT 1"}},
		{"double quoted", "SELECT \"a;b\" FROM t;", []string{"SELECT \"a;b\" FROM t"}},
		{"trailing no semicolon", "SELECT 1;\nSELECT 2", []string{"SELECT 1", "SELECT 2"}},
		{"blank only", "  \n\t\n", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := splitSQL(tc.sql)
			if len(got) == 0 && len(tc.want) == 0 {
				return
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("splitSQL(%q) = %#v, want %#v", tc.sql, got, tc.want)
			}
		})
	}
}

func TestLoadMigrationsOrdered(t *testing.T) {
	for _, engine := range []string{"postgres", "clickhouse"} {
		files, err := loadMigrations(engine)
		if err != nil {
			t.Fatalf("loadMigrations(%s): %v", engine, err)
		}
		if len(files) == 0 {
			t.Fatalf("no embedded %s migrations", engine)
		}
		if files[0].Version != "001_baseline" {
			t.Fatalf("%s first migration = %q, want 001_baseline", engine, files[0].Version)
		}
		for i := 1; i < len(files); i++ {
			if files[i-1].Version >= files[i].Version {
				t.Fatalf("%s migrations out of order: %q >= %q", engine, files[i-1].Version, files[i].Version)
			}
		}
		if files[0].SQL == "" {
			t.Fatalf("%s baseline is empty", engine)
		}
	}
}

func TestSplitSQLOnEmbeddedBaseline(t *testing.T) {
	files, err := loadMigrations("clickhouse")
	if err != nil {
		t.Fatal(err)
	}
	statements := splitSQL(files[0].SQL)
	if len(statements) < 5 {
		t.Fatalf("expected several baseline statements, got %d", len(statements))
	}
	for _, stmt := range statements {
		if stmt == "" {
			t.Fatal("empty statement produced")
		}
	}
}
