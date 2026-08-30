// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package migrate

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// pgColumnTypes maps column name to PostgreSQL type name for a table.
func pgColumnTypes(ctx context.Context, conn *pgx.Conn, table string) (map[string]string, error) {
	rows, err := conn.Query(ctx,
		"SELECT column_name, udt_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position",
		table)
	if err != nil {
		return nil, migrationErrorf("%s", err)
	}
	defer rows.Close()
	types := map[string]string{}
	for rows.Next() {
		var name, udt string
		if err := rows.Scan(&name, &udt); err != nil {
			return nil, migrationErrorf("%s", err)
		}
		types[name] = udt
	}
	if err := rows.Err(); err != nil {
		return nil, migrationErrorf("%s", err)
	}
	return types, nil
}

// pgNotNullDefaults discovers NOT NULL columns with substitutable
// defaults: declared column defaults, empty objects for JSON columns,
// and false for booleans.
func pgNotNullDefaults(ctx context.Context, conn *pgx.Conn, table string) (map[string]string, error) {
	rows, err := conn.Query(ctx, `
        SELECT column_name, column_default, udt_name
        FROM information_schema.columns
        WHERE table_name = $1
            AND table_schema = 'public'
            AND is_nullable = 'NO'
            AND (udt_name IN ('json', 'jsonb', 'bool') OR column_default IS NOT NULL)
        `, table)
	if err != nil {
		return nil, migrationErrorf("%s", err)
	}
	defer rows.Close()
	defaults := map[string]string{}
	for rows.Next() {
		var name, udt string
		var colDefault *string
		if err := rows.Scan(&name, &colDefault, &udt); err != nil {
			return nil, migrationErrorf("%s", err)
		}
		switch {
		case colDefault != nil && *colDefault != "":
			clean := strings.TrimSpace(strings.SplitN(*colDefault, "::", 2)[0])
			defaults[name] = strings.Trim(clean, "'")
		case udt == "json" || udt == "jsonb":
			defaults[name] = "{}"
		case udt == "bool":
			defaults[name] = "false"
		}
	}
	if err := rows.Err(); err != nil {
		return nil, migrationErrorf("%s", err)
	}
	return defaults, nil
}

// insertTable loads one JSONL file, returning inserted and skipped row
// counts and any unique-conflict warnings.
func insertTable(ctx context.Context, conn *pgx.Conn, table, jsonlPath string, colTypes map[string]string,
	notNullDefaults map[string]string) (inserted, skipped int64, warnings []string, err error) {
	columns := make([]string, 0, len(colTypes))
	for col := range colTypes {
		columns = append(columns, col)
	}
	columns = sortedStrings(columns)
	query := buildInsert(table, columns, colTypes)

	f, err := os.Open(jsonlPath)
	if err != nil {
		return 0, 0, nil, migrationErrorf("%s", err)
	}
	defer func() { _ = f.Close() }()
	reader := bufio.NewReaderSize(f, 1<<16)
	for {
		line, readErr := reader.ReadString('\n')
		line = strings.TrimSpace(line)
		if line != "" {
			parsed, err := parseOrdered([]byte(line))
			if err != nil {
				return 0, 0, nil, migrationErrorf("%s", err)
			}
			row, ok := parsed.(*Doc)
			if !ok {
				return 0, 0, nil, migrationErrorf("archive line in %s is not a JSON object", table)
			}
			for col, defaultVal := range notNullDefaults {
				if _, typed := colTypes[col]; !typed {
					continue
				}
				if current, _ := row.Get(col); current == nil {
					row.Set(col, defaultVal)
				}
			}
			args := make([]any, len(columns))
			for i, col := range columns {
				value, _ := row.Get(col)
				coerced, err := coerceValue(value, colTypes[col])
				if err != nil {
					return 0, 0, nil, migrationErrorf("%s: %s", table, err)
				}
				args[i] = coerced
			}
			tag, execErr := conn.Exec(ctx, query, args...)
			if execErr != nil {
				var pgErr *pgconn.PgError
				if errors.As(execErr, &pgErr) {
					rowID := "unknown"
					if id := row.GetString("id"); id != "" {
						rowID = id
					}
					switch pgErr.Code {
					case "23503": // foreign key violation
						skipped++
						continue
					case "23505": // unique violation
						warnings = append(warnings,
							fmt.Sprintf("%s: unique conflict on row %s (%s)", table, rowID, pgErr.ConstraintName))
						skipped++
						continue
					}
				}
				return 0, 0, nil, migrationErrorf("%s", execErr)
			}
			if tag.RowsAffected() > 0 {
				inserted++
			} else {
				skipped++
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return 0, 0, nil, migrationErrorf("%s", readErr)
		}
	}
	return inserted, skipped, warnings, nil
}

// ImportPG imports a registry archive: checksums are verified before any
// insert, and every row uses ON CONFLICT DO NOTHING for idempotency.
func ImportPG(ctx context.Context, dsn, archivePath string, report ProgressFunc) (*ImportResult, error) {
	t0 := time.Now()
	warnings := []string{}

	stagingDir, err := os.MkdirTemp("", "caracal-migrate-")
	if err != nil {
		return nil, migrationErrorf("%s", err)
	}
	defer os.RemoveAll(stagingDir)
	if err := os.Chmod(stagingDir, 0o700); err != nil {
		return nil, migrationErrorf("%s", err)
	}

	report.update("pg_import", 0, "Extracting archive")
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
	migrationID := manifest.GetString("migration_id")
	manifestTables := manifest.GetDoc("tables")

	report.update("pg_import", 5, "Verifying checksums")

	failed := []string{}
	for _, table := range insertOrder {
		jsonlPath := filepath.Join(stagingDir, "pg", table+".jsonl")
		entry, inManifest := manifestTables.Get(table)
		if _, statErr := os.Stat(jsonlPath); statErr != nil {
			if !inManifest {
				continue
			}
			failed = append(failed, table+" (file missing)")
			continue
		}
		if !inManifest {
			continue
		}
		expected := ""
		if entryDoc, ok := entry.(*Doc); ok {
			expected = entryDoc.GetString("checksum")
		}
		actual, hashErr := sha256File(jsonlPath)
		if hashErr != nil {
			return nil, migrationErrorf("%s", hashErr)
		}
		if actual != expected {
			failed = append(failed, table)
		}
	}
	if len(failed) > 0 {
		return nil, checksumErrorf(
			"Checksum verification failed for: %s. Archive may be corrupted or tampered. Re-export from source.",
			strings.Join(failed, ", "))
	}

	report.update("pg_import", 10, "Connecting to target database")

	conn, err := pgConnect(ctx, dsn)
	if err != nil {
		return nil, err
	}
	defer func() { _ = conn.Close(ctx) }()

	var targetVersion string
	_ = conn.QueryRow(ctx, "SELECT version_num FROM alembic_version LIMIT 1").Scan(&targetVersion)
	sourceVersion := manifest.GetString("source_alembic_version")
	if targetVersion != sourceVersion {
		warnings = append(warnings,
			fmt.Sprintf("Schema version mismatch: archive=%s, target=%s", sourceVersion, targetVersion))
	}

	rowsInserted := map[string]int64{}
	rowsSkipped := map[string]int64{}

	existing, err := pgExistingTables(ctx, conn)
	if err != nil {
		return nil, err
	}

	// Trigger-based FK enforcement is disabled for the bulk load so the
	// listing/version FK cycle can be imported in a single pass.
	if _, err := conn.Exec(ctx, "SET session_replication_role = 'replica'"); err != nil {
		return nil, migrationErrorf("%s", err)
	}
	loadErr := func() error {
		totalTables := len(insertOrder)
		for idx, table := range insertOrder {
			pct := int(float64(idx)/float64(totalTables)*80) + 15
			report.update("pg_import", pct, "Importing "+table)

			jsonlPath := filepath.Join(stagingDir, "pg", table+".jsonl")
			if !existing[table] {
				rowsInserted[table] = 0
				rowsSkipped[table] = 0
				continue
			}
			info, statErr := os.Stat(jsonlPath)
			if statErr != nil || info.Size() == 0 {
				rowsInserted[table] = 0
				rowsSkipped[table] = 0
				continue
			}

			colTypes, err := pgColumnTypes(ctx, conn, table)
			if err != nil {
				return err
			}
			notNullDefaults, err := pgNotNullDefaults(ctx, conn, table)
			if err != nil {
				return err
			}
			ins, sk, tableWarnings, err := insertTable(ctx, conn, table, jsonlPath, colTypes, notNullDefaults)
			if err != nil {
				return err
			}
			rowsInserted[table] = ins
			rowsSkipped[table] = sk
			warnings = append(warnings, tableWarnings...)
		}
		return nil
	}()
	if _, err := conn.Exec(ctx, "SET session_replication_role = 'origin'"); err != nil && loadErr == nil {
		loadErr = migrationErrorf("%s", err)
	}
	if loadErr != nil {
		return nil, loadErr
	}

	report.update("pg_import", 96, "Finishing import")

	insertedPairs := make([]TableCount, 0, len(insertOrder))
	skippedPairs := make([]TableCount, 0, len(insertOrder))
	for _, table := range insertOrder {
		insertedPairs = append(insertedPairs, TableCount{Table: table, Rows: rowsInserted[table]})
		skippedPairs = append(skippedPairs, TableCount{Table: table, Rows: rowsSkipped[table]})
	}

	report.update("pg_import", 100, "Import complete")

	return &ImportResult{
		MigrationID:     migrationID,
		TablesImported:  len(insertOrder),
		RowsInserted:    insertedPairs,
		RowsSkipped:     skippedPairs,
		DurationSeconds: round2(time.Since(t0).Seconds()),
		Warnings:        warnings,
	}, nil
}
