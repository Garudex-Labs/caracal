// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package migrate

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ValidatePG verifies archive checksums and optionally compares row
// counts against a live database. An empty dsn skips the comparison.
func ValidatePG(ctx context.Context, dsn, archivePath string, report ProgressFunc) (*ValidationResult, error) {
	stagingDir, err := os.MkdirTemp("", "caracal-migrate-")
	if err != nil {
		return nil, migrationErrorf("%s", err)
	}
	defer os.RemoveAll(stagingDir)
	if err := os.Chmod(stagingDir, 0o700); err != nil {
		return nil, migrationErrorf("%s", err)
	}

	report.update("validate", 0, "Extracting archive")
	if err := safeExtract(archivePath, stagingDir); err != nil {
		return nil, migrationErrorf("%s", err)
	}

	manifestPath := filepath.Join(stagingDir, "manifest.json")
	if _, err := os.Stat(manifestPath); err != nil {
		return nil, migrationErrorf("Archive does not contain manifest.json")
	}
	manifest, err := readManifest(manifestPath)
	if err != nil {
		return nil, migrationErrorf("%s", err)
	}
	manifestTables := manifest.GetDoc("tables")

	report.update("validate", 20, "Verifying checksums")

	checksumResults := []ChecksumResult{}
	allOK := true
	for _, table := range insertOrder {
		entry, inManifest := manifestTables.Get(table)
		if !inManifest {
			continue
		}
		expected := ""
		if entryDoc, ok := entry.(*Doc); ok {
			expected = entryDoc.GetString("checksum")
		}
		jsonlPath := filepath.Join(stagingDir, "pg", table+".jsonl")
		if _, statErr := os.Stat(jsonlPath); statErr != nil {
			checksumResults = append(checksumResults, ChecksumResult{table, expected, "", false})
			allOK = false
			continue
		}
		actual, hashErr := sha256File(jsonlPath)
		if hashErr != nil {
			return nil, migrationErrorf("%s", hashErr)
		}
		passed := actual == expected
		if !passed {
			allOK = false
		}
		checksumResults = append(checksumResults, ChecksumResult{table, expected, actual, passed})
	}

	var crossDB []RowCountPair
	if dsn != "" {
		report.update("validate", 50, "Comparing row counts against database")
		conn, err := pgConnect(ctx, dsn)
		if err != nil {
			return nil, err
		}
		defer func() { _ = conn.Close(ctx) }()
		existing, err := pgExistingTables(ctx, conn)
		if err != nil {
			return nil, err
		}
		crossDB = []RowCountPair{}
		for _, table := range insertOrder {
			entry, inManifest := manifestTables.Get(table)
			if !inManifest {
				continue
			}
			archiveCount := int64(0)
			if entryDoc, ok := entry.(*Doc); ok {
				archiveCount = entryDoc.GetInt("row_count")
			}
			if !existing[table] {
				crossDB = append(crossDB, RowCountPair{table, archiveCount, -1})
				continue
			}
			var dbCount int64
			if err := conn.QueryRow(ctx, fmt.Sprintf(`SELECT count(*) FROM "%s"`, table)).Scan(&dbCount); err != nil {
				return nil, migrationErrorf("%s", err)
			}
			crossDB = append(crossDB, RowCountPair{table, archiveCount, dbCount})
		}
	}

	report.update("validate", 100, "Validation complete")

	return &ValidationResult{
		ArchiveValid:    allOK,
		ChecksumResults: checksumResults,
		CrossDBResults:  crossDB,
	}, nil
}

// collectCHFKValues gathers distinct foreign-key reference values from the
// target ClickHouse. Reference values are enumerated with DISTINCT queries
// against the imported tables, which hold the same rows as the Parquet
// files after a completed import; tables absent from the target contribute
// no values.
func collectCHFKValues(ctx context.Context, client *http.Client, conn chConn, manifestTables *Doc,
	existing map[string]bool) (map[string]map[string]bool, error) {
	values := map[string]map[string]bool{
		"agent_id": {},
		"user_id":  {},
		"actor_id": {},
	}
	for _, cfg := range clickhouseTables {
		if len(cfg.FKCols) == 0 {
			continue
		}
		info := manifestTables.GetDoc(cfg.Name)
		if raw, ok := info.Get("files"); ok {
			if list, ok := raw.([]any); !ok || len(list) == 0 {
				continue
			}
		} else {
			continue
		}
		if !existing[cfg.Name] {
			continue
		}
		final := ""
		if cfg.Engine == "replacing" {
			final = " FINAL"
		}
		for _, col := range cfg.FKCols {
			if _, tracked := values[col]; !tracked {
				continue
			}
			sql := fmt.Sprintf("SELECT DISTINCT toString(%s) AS v FROM %s%s FORMAT JSON", col, cfg.Name, final)
			resp, err := chQueryJSON(ctx, client, conn, sql, nil)
			if err != nil {
				return nil, err
			}
			for _, row := range resp.Data {
				if v, ok := row["v"].(string); ok && v != "" {
					values[col][v] = true
				}
			}
		}
	}
	// Audit events identify users through actor_id.
	for v := range values["actor_id"] {
		values["user_id"][v] = true
	}
	delete(values, "actor_id")
	for key, set := range values {
		filtered := map[string]bool{}
		for v := range set {
			if uuidRe.MatchString(v) {
				filtered[strings.ToLower(v)] = true
			}
		}
		values[key] = filtered
	}
	return values, nil
}

// validateFKReferences checks collected reference values against
// PostgreSQL and reports orphans, capped at 10,000 per group.
func validateFKReferences(ctx context.Context, dsn string, fkValues map[string]map[string]bool) (*FKResults, error) {
	conn, err := pgConnect(ctx, dsn)
	if err != nil {
		return nil, err
	}
	defer func() { _ = conn.Close(ctx) }()

	results := &FKResults{OrphanedAgentIDs: []string{}, OrphanedUserIDs: []string{}}
	for _, group := range []struct {
		fkCol   string
		pgTable string
	}{{"agent_id", "agents"}, {"user_id", "users"}} {
		ids := fkValues[group.fkCol]
		if len(ids) == 0 {
			continue
		}
		idList := make([]string, 0, len(ids))
		for id := range ids {
			idList = append(idList, id)
		}
		existing := map[string]bool{}
		for start := 0; start < len(idList); start += 1000 {
			end := start + 1000
			if end > len(idList) {
				end = len(idList)
			}
			rows, err := conn.Query(ctx,
				fmt.Sprintf(`SELECT id::text FROM "%s" WHERE id = ANY($1::uuid[])`, group.pgTable),
				idList[start:end])
			if err != nil {
				return nil, migrationErrorf("%s", err)
			}
			for rows.Next() {
				var id string
				if err := rows.Scan(&id); err != nil {
					rows.Close()
					return nil, migrationErrorf("%s", err)
				}
				existing[id] = true
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return nil, migrationErrorf("%s", err)
			}
		}
		missing := []string{}
		for _, id := range sortedStrings(idList) {
			if !existing[id] {
				missing = append(missing, id)
			}
		}
		truncated := len(missing) > 10000
		if truncated {
			missing = missing[:10000]
		}
		if group.fkCol == "agent_id" {
			results.OrphanedAgentIDs = missing
			results.OrphanedAgentIDsTruncated = truncated
		} else {
			results.OrphanedUserIDs = missing
			results.OrphanedUserIDsTruncated = truncated
		}
	}
	return results, nil
}

// ValidateCH verifies telemetry Parquet checksums and optionally compares
// row counts against ClickHouse and foreign-key references against
// PostgreSQL. FK validation requires both chURL and pgDSN: reference
// values are read from the target ClickHouse instead of the Parquet
// files, so with pgDSN alone the FK check is skipped with a warning.
func ValidateCH(ctx context.Context, chURL, pgDSN, inputDir string,
	report ProgressFunc) (*TelemetryValidationResult, error) {
	manifestPath := filepath.Join(inputDir, "telemetry_manifest.json")
	if _, err := os.Stat(manifestPath); err != nil {
		return nil, migrationErrorf("Telemetry manifest not found.")
	}
	manifest, err := readManifest(manifestPath)
	if err != nil {
		return nil, migrationErrorf("%s", err)
	}
	manifestTables := manifest.GetDoc("tables")

	report.update("validate", 0, "Verifying telemetry checksums")

	checksumResults := []FileCheck{}
	checksumsValid := true
	for _, cfg := range clickhouseTables {
		checksums := manifestTables.GetDoc(cfg.Name).GetDoc("checksum")
		for _, filename := range checksums.Keys() {
			expected := checksums.GetString(filename)
			filePath := filepath.Join(inputDir, filename)
			if _, statErr := os.Stat(filePath); statErr != nil {
				checksumResults = append(checksumResults, FileCheck{filename, false})
				checksumsValid = false
				continue
			}
			actual, hashErr := sha256File(filePath)
			if hashErr != nil {
				return nil, migrationErrorf("%s", hashErr)
			}
			passed := actual == expected
			if !passed {
				checksumsValid = false
			}
			checksumResults = append(checksumResults, FileCheck{filename, passed})
		}
	}

	warnings := []string{}
	var rowCounts []RowCountPair
	var conn chConn
	var client *http.Client
	var existing map[string]bool
	if chURL != "" {
		report.update("validate", 40, "Comparing telemetry row counts")
		conn, err = resolveCH(chURL)
		if err != nil {
			return nil, connectionErrorf("%s", err)
		}
		client = chHTTPClient()
		if err := chHealthCheck(ctx, client, conn); err != nil {
			return nil, migrationErrorf("ClickHouse health check failed: %s", AsError(err).Message)
		}
		existing, err = chExistingTables(ctx, client, conn)
		if err != nil {
			return nil, err
		}
		rowCounts = []RowCountPair{}
		for _, cfg := range clickhouseTables {
			manifestCount := manifestTables.GetDoc(cfg.Name).GetInt("row_count")
			if !existing[cfg.Name] {
				rowCounts = append(rowCounts, RowCountPair{cfg.Name, manifestCount, -1})
				continue
			}
			final := ""
			if cfg.Engine == "replacing" {
				final = " FINAL"
			}
			sql := fmt.Sprintf("SELECT count() AS cnt FROM %s%s FORMAT JSON", cfg.Name, final)
			resp, err := chQueryJSON(ctx, client, conn, sql, nil)
			if err != nil {
				return nil, err
			}
			rowCounts = append(rowCounts, RowCountPair{cfg.Name, manifestCount, readCount(resp)})
		}
	}

	var fkResults *FKResults
	if pgDSN != "" {
		if chURL == "" {
			warnings = append(warnings,
				"FK validation skipped: provide --clickhouse-url so reference values can be read from the target ClickHouse.")
		} else {
			report.update("validate", 70, "Validating FK references")
			fkValues, err := collectCHFKValues(ctx, client, conn, manifestTables, existing)
			if err != nil {
				return nil, err
			}
			fkResults, err = validateFKReferences(ctx, pgDSN, fkValues)
			if err != nil {
				return nil, err
			}
			manifest.Set("fk_validation", NewDoc().
				Set("orphaned_agent_ids", fkResults.OrphanedAgentIDs).
				Set("orphaned_agent_ids_truncated", fkResults.OrphanedAgentIDsTruncated).
				Set("orphaned_user_ids", fkResults.OrphanedUserIDs).
				Set("orphaned_user_ids_truncated", fkResults.OrphanedUserIDsTruncated).
				Set("validated_at", isoFormat(time.Now().UTC(), true)))
			if err := os.WriteFile(manifestPath, []byte(dumpsIndent(manifest)+"\n"), 0o644); err != nil {
				return nil, migrationErrorf("%s", err)
			}
		}
	}

	report.update("validate", 100, "Telemetry validation complete")

	return &TelemetryValidationResult{
		ChecksumsValid:  checksumsValid,
		ChecksumResults: checksumResults,
		FKResults:       fkResults,
		RowCountResults: rowCounts,
		Warnings:        warnings,
	}, nil
}
