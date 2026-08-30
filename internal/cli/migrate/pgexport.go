// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package migrate

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// pgExistingTables lists public-schema tables via information_schema.
func pgExistingTables(ctx context.Context, q interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}) (map[string]bool, error) {
	rows, err := q.Query(ctx,
		"SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")
	if err != nil {
		return nil, migrationErrorf("%s", err)
	}
	defer rows.Close()
	existing := map[string]bool{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, migrationErrorf("%s", err)
		}
		existing[name] = true
	}
	if err := rows.Err(); err != nil {
		return nil, migrationErrorf("%s", err)
	}
	return existing, nil
}

// ExportPG exports every registry table to JSONL inside a checksummed
// tar.gz archive, reading from one REPEATABLE READ snapshot.
func ExportPG(ctx context.Context, dsn, outputPath string, report ProgressFunc) (*ExportResult, error) {
	t0 := time.Now()
	migrationID := uuid.NewString()

	stagingDir, err := os.MkdirTemp("", "caracal-migrate-")
	if err != nil {
		return nil, migrationErrorf("%s", err)
	}
	defer os.RemoveAll(stagingDir)
	if err := os.Chmod(stagingDir, 0o700); err != nil {
		return nil, migrationErrorf("%s", err)
	}
	pgDir := filepath.Join(stagingDir, "pg")
	if err := os.Mkdir(pgDir, 0o755); err != nil {
		return nil, migrationErrorf("%s", err)
	}

	report.update("pg_export", 0, "Connecting to source database")
	conn, err := pgConnect(ctx, dsn)
	if err != nil {
		return nil, err
	}
	defer func() { _ = conn.Close(ctx) }()

	var alembicVersion string
	if err := conn.QueryRow(ctx, "SELECT version_num FROM alembic_version LIMIT 1").Scan(&alembicVersion); err != nil ||
		alembicVersion == "" {
		return nil, migrationErrorf("Could not read alembic version from source database.")
	}

	tableCounts := map[string]int64{}
	fileHashes := map[string]string{}
	uuidRanges := NewDoc()
	totalTables := len(insertOrder)

	tx, err := conn.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, migrationErrorf("%s", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	existing, err := pgExistingTables(ctx, tx)
	if err != nil {
		return nil, err
	}

	for idx, table := range insertOrder {
		pct := int(float64(idx)/float64(totalTables)*90) + 5
		report.update("pg_export", pct, "Exporting "+table)
		dest := filepath.Join(pgDir, table+".jsonl")

		// Tables absent from an older source schema export as empty files.
		if !existing[table] {
			if err := os.WriteFile(dest, nil, 0o644); err != nil {
				return nil, migrationErrorf("%s", err)
			}
			tableCounts[table] = 0
			hash, err := sha256File(dest)
			if err != nil {
				return nil, migrationErrorf("%s", err)
			}
			fileHashes[table] = hash
			continue
		}

		probe, err := tx.Query(ctx, fmt.Sprintf(`SELECT * FROM "%s" LIMIT 0`, table))
		if err != nil {
			return nil, migrationErrorf("%s", err)
		}
		fields := probe.FieldDescriptions()
		columns := make([]string, len(fields))
		oids := make([]uint32, len(fields))
		for i, field := range fields {
			columns[i] = field.Name
			oids[i] = field.DataTypeOID
		}
		probe.Close()
		if err := probe.Err(); err != nil {
			return nil, migrationErrorf("%s", err)
		}

		query, err := buildSelect(table, columns, oids)
		if err != nil {
			return nil, err
		}

		count, minID, maxID, err := exportTable(ctx, tx, query, columns, dest)
		if err != nil {
			return nil, err
		}
		tableCounts[table] = count
		hash, err := sha256File(dest)
		if err != nil {
			return nil, migrationErrorf("%s", err)
		}
		fileHashes[table] = hash
		if minID != "" {
			uuidRanges.Set(table, NewDoc().Set("min_id", minID).Set("max_id", maxID))
		}
	}
	if err := tx.Rollback(ctx); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
		return nil, migrationErrorf("%s", err)
	}

	report.update("pg_export", 95, "Writing manifest and packing archive")

	exportedAt := isoFormat(time.Now().UTC(), true)
	manifest := buildPGManifest(migrationID, exportedAt, alembicVersion, tableCounts, fileHashes)
	manifestPath := filepath.Join(stagingDir, "manifest.json")
	if err := writeManifest(manifestPath, manifest); err != nil {
		return nil, migrationErrorf("%s", err)
	}

	dsnHash := sha256.Sum256([]byte(dsn))
	migrationManifest := buildMigrationManifest(migrationID, exportedAt, hex.EncodeToString(dsnHash[:]),
		tableCounts, uuidRanges)
	migrationManifestPath := filepath.Join(stagingDir, "migration_manifest.json")
	if err := writeManifest(migrationManifestPath, migrationManifest); err != nil {
		return nil, migrationErrorf("%s", err)
	}

	if err := packPGArchive(outputPath, manifestPath, migrationManifestPath, pgDir); err != nil {
		return nil, migrationErrorf("%s", err)
	}

	archiveHash, err := sha256File(outputPath)
	if err != nil {
		return nil, migrationErrorf("%s", err)
	}
	migrationManifest.Set("archive_sha256", archiveHash)
	if err := writeManifest(SidecarPath(outputPath), migrationManifest); err != nil {
		return nil, migrationErrorf("%s", err)
	}

	orderedCounts := make([]TableCount, 0, len(insertOrder))
	totalRows := int64(0)
	for _, table := range insertOrder {
		orderedCounts = append(orderedCounts, TableCount{Table: table, Rows: tableCounts[table]})
		totalRows += tableCounts[table]
	}

	report.update("pg_export", 100, "Export complete")

	return &ExportResult{
		ArchivePath:     outputPath,
		MigrationID:     migrationID,
		TableCounts:     orderedCounts,
		DurationSeconds: round2(time.Since(t0).Seconds()),
		TotalRows:       totalRows,
	}, nil
}

// exportTable streams one table to a JSONL file and tracks the id range.
func exportTable(ctx context.Context, tx pgx.Tx, query string, columns []string,
	dest string) (count int64, minID, maxID string, err error) {
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return 0, "", "", migrationErrorf("%s", err)
	}
	writer := bufio.NewWriterSize(out, 1<<16)
	closeOut := func() error {
		if err := writer.Flush(); err != nil {
			_ = out.Close()
			return err
		}
		return out.Close()
	}

	rows, err := tx.Query(ctx, query)
	if err != nil {
		_ = closeOut()
		return 0, "", "", migrationErrorf("%s", err)
	}
	idIndex := -1
	for i, col := range columns {
		if col == "id" {
			idIndex = i
			break
		}
	}
	fields := rows.FieldDescriptions()
	for rows.Next() {
		values, err := rows.Values()
		if err != nil {
			rows.Close()
			_ = closeOut()
			return 0, "", "", migrationErrorf("%s", err)
		}
		writer.WriteByte('{')
		for i, col := range columns {
			if i > 0 {
				writer.WriteString(", ")
			}
			token, err := encodePGValue(values[i], fields[i].DataTypeOID)
			if err != nil {
				rows.Close()
				_ = closeOut()
				return 0, "", "", err
			}
			writer.WriteString(pyStr(col))
			writer.WriteString(": ")
			writer.WriteString(token)
		}
		writer.WriteString("}\n")
		count++
		if idIndex >= 0 && values[idIndex] != nil {
			idText := ""
			switch t := values[idIndex].(type) {
			case [16]byte:
				idText = uuidText(t)
			case string:
				idText = t
			default:
				idText = fmt.Sprintf("%v", t)
			}
			if minID == "" || idText < minID {
				minID = idText
			}
			if maxID == "" || idText > maxID {
				maxID = idText
			}
		}
	}
	if err := rows.Err(); err != nil {
		_ = closeOut()
		return 0, "", "", migrationErrorf("%s", err)
	}
	if err := closeOut(); err != nil {
		return 0, "", "", migrationErrorf("%s", err)
	}
	return count, minID, maxID, nil
}
