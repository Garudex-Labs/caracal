// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package migrate

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// buildPartitionCheckQuery probes one monthly partition for any data.
func buildPartitionCheckQuery(cfg tableCfg, yyyymm int) string {
	final := ""
	if cfg.Engine == "replacing" {
		final = " FINAL"
	}
	return fmt.Sprintf("SELECT 1 AS has_data FROM %s%s WHERE toYYYYMM(%s) = %d LIMIT 1 FORMAT JSON",
		cfg.Name, final, cfg.TimeCol, yyyymm)
}

// partitionMonth extracts the YYYYMM integer from a partition filename.
func partitionMonth(filename string) (int, error) {
	base := strings.TrimSuffix(filename, ".parquet")
	parts := strings.Split(base, "_")
	datePart := parts[len(parts)-1]
	year, month, ok := strings.Cut(datePart, "-")
	if !ok {
		return 0, fmt.Errorf("filename %q does not carry a partition month", filename)
	}
	y, err := strconv.Atoi(year)
	if err != nil {
		return 0, err
	}
	m, err := strconv.Atoi(month)
	if err != nil {
		return 0, err
	}
	return y*100 + m, nil
}

// chImportFile streams a Parquet file body into an INSERT query.
func chImportFile(ctx context.Context, client *http.Client, c chConn, insertQuery, parquetPath string) error {
	f, err := os.Open(parquetPath)
	if err != nil {
		return migrationErrorf("%s", err)
	}
	defer func() { _ = f.Close() }()
	extra := map[string]string{
		"query":            insertQuery,
		"max_memory_usage": "2000000000",
		"input_format_parquet_allow_missing_columns": "1",
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.queryURL(extra), f)
	if err != nil {
		return migrationErrorf("%s", err)
	}
	req.SetBasicAuth(c.user, c.password)
	resp, err := client.Do(req)
	if err != nil {
		return connectionErrorf("ClickHouse unreachable: %s", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 500))
		return migrationErrorf("ClickHouse returned HTTP %d: %s", resp.StatusCode, string(body))
	}
	return nil
}

// chTableSchema lists the target table's columns in position order.
func chTableSchema(ctx context.Context, client *http.Client, c chConn, table string) ([][2]string, error) {
	sql := "SELECT name, type FROM system.columns WHERE database = {db:String} AND table = {tbl:String} " +
		"ORDER BY position FORMAT JSON"
	resp, err := chQueryJSON(ctx, client, c, sql, map[string]string{"param_db": c.db, "param_tbl": table})
	if err != nil {
		return nil, err
	}
	schema := make([][2]string, 0, len(resp.Data))
	for _, row := range resp.Data {
		name, _ := row["name"].(string)
		typeName, _ := row["type"].(string)
		if name != "" && typeName != "" {
			schema = append(schema, [2]string{name, typeName})
		}
	}
	return schema, nil
}

// buildImportQuery stamps project_id with the default project during the
// insert itself, because project_id is a key column and cannot be mutated
// after loading. Rows pass through input() with the target schema so the
// value is replaced before it reaches the table.
func buildImportQuery(table string, schema [][2]string) string {
	hasProjectID := false
	parts := make([]string, 0, len(schema))
	for _, column := range schema {
		if column[0] == "project_id" {
			hasProjectID = true
		}
		escaped := strings.ReplaceAll(column[1], `\`, `\\`)
		escaped = strings.ReplaceAll(escaped, "'", `\'`)
		parts = append(parts, "`"+column[0]+"` "+escaped)
	}
	if !hasProjectID || len(parts) == 0 {
		return fmt.Sprintf("INSERT INTO %s FORMAT Parquet", table)
	}
	return fmt.Sprintf("INSERT INTO %s SELECT * REPLACE ('%s' AS project_id) FROM input('%s') FORMAT Parquet",
		table, defaultProjectID, strings.Join(parts, ", "))
}

// writeImportState persists the resume state listing completed tables.
func writeImportState(path string, completed map[string]bool) error {
	names := make([]string, 0, len(completed))
	for name := range completed {
		names = append(names, name)
	}
	doc := NewDoc().Set("completed", sortedStrings(names))
	return os.WriteFile(path, []byte(dumpsIndent(doc)), 0o644)
}

// ImportCH imports Parquet telemetry files into the target ClickHouse.
// Checksums are verified before any insert; partitions that already carry
// data are skipped and per-table resume state survives interruptions.
func ImportCH(ctx context.Context, chURL, inputDir string, report ProgressFunc) (*TelemetryImportResult, error) {
	t0 := time.Now()
	warnings := []string{}

	manifestPath := filepath.Join(inputDir, "telemetry_manifest.json")
	if _, err := os.Stat(manifestPath); err != nil {
		return nil, migrationErrorf("Telemetry manifest not found in input directory.")
	}
	manifest, err := readManifest(manifestPath)
	if err != nil {
		return nil, migrationErrorf("%s", err)
	}
	migrationID := manifest.GetString("migration_id")
	manifestTables := manifest.GetDoc("tables")

	report.update("ch_import", 0, "Verifying checksums")

	failed := []string{}
	for _, cfg := range clickhouseTables {
		checksums := manifestTables.GetDoc(cfg.Name).GetDoc("checksum")
		for _, filename := range checksums.Keys() {
			expected := checksums.GetString(filename)
			filePath := filepath.Join(inputDir, filename)
			if _, statErr := os.Stat(filePath); statErr != nil {
				failed = append(failed, filename+" (missing)")
				continue
			}
			actual, hashErr := sha256File(filePath)
			if hashErr != nil {
				return nil, migrationErrorf("%s", hashErr)
			}
			if actual != expected {
				failed = append(failed, filename)
			}
		}
	}
	if len(failed) > 0 {
		return nil, checksumErrorf("Checksum verification failed for: %s", strings.Join(failed, ", "))
	}

	conn, err := resolveCH(chURL)
	if err != nil {
		return nil, connectionErrorf("%s", err)
	}
	client := chHTTPClient()
	if err := chHealthCheck(ctx, client, conn); err != nil {
		return nil, connectionErrorf("ClickHouse health check failed: %s", AsError(err).Message)
	}

	report.update("ch_import", 5, "Connected to ClickHouse")

	existing, err := chExistingTables(ctx, client, conn)
	if err != nil {
		return nil, err
	}
	rowsImported := map[string]int64{}
	tablesSkipped := []string{}

	statePath := filepath.Join(inputDir, ".import_state.json")
	completed := map[string]bool{}
	if data, readErr := os.ReadFile(statePath); readErr == nil {
		if parsed, parseErr := parseOrdered(data); parseErr == nil {
			if doc, ok := parsed.(*Doc); ok {
				if items, ok := doc.Get("completed"); ok {
					if list, ok := items.([]any); ok {
						for _, item := range list {
							if name, ok := item.(string); ok {
								completed[name] = true
							}
						}
					}
				}
			}
		}
	}

	// Resume entries whose tables no longer hold data are replayed.
	if len(completed) > 0 {
		invalidated := []string{}
		for _, cfg := range clickhouseTables {
			if !completed[cfg.Name] {
				continue
			}
			if !existing[cfg.Name] {
				invalidated = append(invalidated, cfg.Name)
				continue
			}
			final := ""
			if cfg.Engine == "replacing" {
				final = " FINAL"
			}
			sql := fmt.Sprintf("SELECT 1 FROM %s%s LIMIT 1 FORMAT JSON", cfg.Name, final)
			resp, err := chQueryJSON(ctx, client, conn, sql, nil)
			if err != nil {
				return nil, err
			}
			if len(resp.Data) == 0 {
				invalidated = append(invalidated, cfg.Name)
			}
		}
		if len(invalidated) > 0 {
			for _, name := range invalidated {
				delete(completed, name)
			}
			warnings = append(warnings,
				"Resume state invalidated for: "+strings.Join(sortedStrings(invalidated), ", "))
			if err := writeImportState(statePath, completed); err != nil {
				return nil, migrationErrorf("%s", err)
			}
		}
	}

	totalTables := len(clickhouseTables)
	for idx, cfg := range clickhouseTables {
		tableInfo := manifestTables.GetDoc(cfg.Name)
		files := []string{}
		if raw, ok := tableInfo.Get("files"); ok {
			if list, ok := raw.([]any); ok {
				for _, item := range list {
					if name, ok := item.(string); ok {
						files = append(files, name)
					}
				}
			}
		}
		pct := int(float64(idx)/float64(totalTables)*85) + 10

		if len(files) == 0 {
			rowsImported[cfg.Name] = 0
			continue
		}
		if !existing[cfg.Name] {
			tablesSkipped = append(tablesSkipped, cfg.Name)
			warnings = append(warnings, cfg.Name+": table does not exist on target")
			rowsImported[cfg.Name] = 0
			continue
		}
		if completed[cfg.Name] {
			rowsImported[cfg.Name] = tableInfo.GetInt("row_count")
			continue
		}

		report.update("ch_import", pct, "Importing "+cfg.Name)

		schema, err := chTableSchema(ctx, client, conn, cfg.Name)
		if err != nil {
			return nil, err
		}
		insertQuery := buildImportQuery(cfg.Name, schema)

		for _, filename := range files {
			yyyymm, err := partitionMonth(filename)
			if err != nil {
				return nil, migrationErrorf("%s", err)
			}
			resp, err := chQueryJSON(ctx, client, conn, buildPartitionCheckQuery(cfg, yyyymm), nil)
			if err != nil {
				return nil, err
			}
			if len(resp.Data) > 0 {
				warnings = append(warnings, filename+": partition already has data")
				continue
			}
			if err := chImportFile(ctx, client, conn, insertQuery, filepath.Join(inputDir, filename)); err != nil {
				return nil, err
			}
		}

		rowsImported[cfg.Name] = tableInfo.GetInt("row_count")
		completed[cfg.Name] = true
		if err := writeImportState(statePath, completed); err != nil {
			return nil, migrationErrorf("%s", err)
		}
	}

	report.update("ch_import", 100, "Telemetry import complete")

	imported := 0
	pairs := make([]TableCount, 0, len(clickhouseTables))
	for _, cfg := range clickhouseTables {
		if rowsImported[cfg.Name] > 0 {
			imported++
		}
		pairs = append(pairs, TableCount{Table: cfg.Name, Rows: rowsImported[cfg.Name]})
	}

	return &TelemetryImportResult{
		MigrationID:     migrationID,
		TablesImported:  imported,
		TablesSkipped:   tablesSkipped,
		RowsImported:    pairs,
		DurationSeconds: round2(time.Since(t0).Seconds()),
		Warnings:        warnings,
	}, nil
}
