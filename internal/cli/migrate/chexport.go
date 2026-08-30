// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package migrate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// buildCHTimeRangeQuery discovers the partition month span of a table.
func buildCHTimeRangeQuery(cfg tableCfg) string {
	final := ""
	if cfg.Engine == "replacing" {
		final = " FINAL"
	}
	return fmt.Sprintf("SELECT min(%s) AS min_t, max(%s) AS max_t FROM %s%s FORMAT JSON",
		cfg.TimeCol, cfg.TimeCol, cfg.Name, final)
}

// buildCHExportQuery selects one monthly partition as Parquet.
func buildCHExportQuery(cfg tableCfg, yyyymm int, cutoff bool) string {
	final := ""
	if cfg.Engine == "replacing" {
		final = " FINAL"
	}
	where := fmt.Sprintf("toYYYYMM(%s) = %d", cfg.TimeCol, yyyymm)
	if cutoff {
		where += fmt.Sprintf(" AND %s < {cutoff:String}", cfg.TimeCol)
	}
	return fmt.Sprintf("SELECT * FROM %s%s WHERE %s FORMAT Parquet", cfg.Name, final, where)
}

// buildCHCountQuery counts one monthly partition.
func buildCHCountQuery(cfg tableCfg, yyyymm int, cutoff bool) string {
	final := ""
	if cfg.Engine == "replacing" {
		final = " FINAL"
	}
	where := fmt.Sprintf("toYYYYMM(%s) = %d", cfg.TimeCol, yyyymm)
	if cutoff {
		where += fmt.Sprintf(" AND %s < {cutoff:String}", cfg.TimeCol)
	}
	return fmt.Sprintf("SELECT count() AS cnt FROM %s%s WHERE %s FORMAT JSON", cfg.Name, final, where)
}

// parseCHTimestamp parses a ClickHouse DateTime/DateTime64 text value.
func parseCHTimestamp(value string) (time.Time, error) {
	value = strings.Replace(value, " ", "T", 1)
	for _, layout := range []string{"2006-01-02T15:04:05.999999999", "2006-01-02T15:04:05"} {
		if t, err := time.Parse(layout, value); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("unparseable timestamp %q", value)
}

// partitionFilename names the Parquet file for one table month.
func partitionFilename(table string, yyyymm int) string {
	return fmt.Sprintf("%s_%d-%02d.parquet", table, yyyymm/100, yyyymm%100)
}

// ExportCH exports telemetry tables as monthly Parquet partitions written
// directly from the ClickHouse HTTP response stream. Requires the
// migration manifest produced by the registry export phase.
func ExportCH(ctx context.Context, chURL, manifestPath, outputDir string,
	report ProgressFunc) (*TelemetryExportResult, error) {
	t0 := time.Now()

	if _, err := os.Stat(manifestPath); err != nil {
		return nil, prerequisiteErrorf("Phase 1 manifest not found: %s", manifestPath)
	}
	p1Manifest, err := readManifest(manifestPath)
	if err != nil {
		return nil, migrationErrorf("%s", err)
	}
	if p1Manifest.GetString("phase1_completed_at") == "" {
		return nil, prerequisiteErrorf("Phase 1 has not completed. Run PG export first.")
	}
	migrationID := p1Manifest.GetString("migration_id")

	// The cutoff recorded before any query bounds every partition read.
	cutoff := time.Now().UTC().Format("2006-01-02 15:04:05.000")

	conn, err := resolveCH(chURL)
	if err != nil {
		return nil, connectionErrorf("%s", err)
	}
	client := chHTTPClient()

	if err := chHealthCheck(ctx, client, conn); err != nil {
		return nil, connectionErrorf("ClickHouse health check failed: %s", AsError(err).Message)
	}
	report.update("ch_export", 0, "Connected to ClickHouse")

	dirExisted := false
	if info, statErr := os.Stat(outputDir); statErr == nil && info.IsDir() {
		dirExisted = true
		entries, _ := os.ReadDir(outputDir)
		if len(entries) > 0 {
			return nil, migrationErrorf("Output directory is not empty: %s", outputDir)
		}
	}
	if err := os.MkdirAll(outputDir, 0o700); err != nil {
		return nil, migrationErrorf("%s", err)
	}
	if err := os.Chmod(outputDir, 0o700); err != nil {
		return nil, migrationErrorf("%s", err)
	}

	result, err := exportCHTables(ctx, client, conn, cutoff, outputDir, migrationID, chURL, report)
	if err != nil {
		if !dirExisted {
			os.RemoveAll(outputDir)
		}
		return nil, err
	}
	result.DurationSeconds = round2(time.Since(t0).Seconds())
	return result, nil
}

// exportCHTables walks every telemetry table, streams its monthly
// partitions to Parquet files, and writes the telemetry manifest.
func exportCHTables(ctx context.Context, client *http.Client, conn chConn, cutoff, outputDir, migrationID,
	chURL string, report ProgressFunc) (*TelemetryExportResult, error) {
	tableMeta := NewDoc()
	tables := []TelemetryTable{}
	totalRows := int64(0)
	totalSize := int64(0)
	totalTables := len(clickhouseTables)

	sourceTables, err := chExistingTables(ctx, client, conn)
	if err != nil {
		return nil, err
	}
	cutoffParams := map[string]string{"param_cutoff": cutoff}

	for idx, cfg := range clickhouseTables {
		pct := int(float64(idx)/float64(totalTables)*90) + 5
		emptyMeta := func() {
			tableMeta.Set(cfg.Name, NewDoc().
				Set("files", []string{}).
				Set("row_count", int64(0)).
				Set("checksum", NewDoc()).
				Set("time_range", nil))
			tables = append(tables, TelemetryTable{Name: cfg.Name, Files: []TelemetryFile{}})
		}

		if !sourceTables[cfg.Name] {
			emptyMeta()
			report.update("ch_export", pct, fmt.Sprintf("Skipping %s (not found)", cfg.Name))
			continue
		}

		report.update("ch_export", pct, "Discovering time range for "+cfg.Name)
		trResp, err := chQueryJSON(ctx, client, conn, buildCHTimeRangeQuery(cfg), nil)
		if err != nil {
			return nil, err
		}
		minText, maxText := "", ""
		if len(trResp.Data) > 0 {
			minText, _ = trResp.Data[0]["min_t"].(string)
			maxText, _ = trResp.Data[0]["max_t"].(string)
		}
		if epochSentinels[minText] || epochSentinels[maxText] {
			emptyMeta()
			continue
		}
		minT, err := parseCHTimestamp(minText)
		if err != nil {
			return nil, migrationErrorf("%s", err)
		}
		maxT, err := parseCHTimestamp(maxText)
		if err != nil {
			return nil, migrationErrorf("%s", err)
		}

		files := []string{}
		fileEntries := []TelemetryFile{}
		checksums := NewDoc()
		tableRowCount := int64(0)

		for _, yyyymm := range monthRange(minT, maxT) {
			filename := partitionFilename(cfg.Name, yyyymm)
			filePath := filepath.Join(outputDir, filename)

			countResp, err := chQueryJSON(ctx, client, conn, buildCHCountQuery(cfg, yyyymm, true), cutoffParams)
			if err != nil {
				return nil, err
			}
			partitionCount := readCount(countResp)
			if partitionCount == 0 {
				continue
			}

			report.update("ch_export", pct,
				fmt.Sprintf("Exporting %s (%s rows)", filename, Comma(partitionCount)))
			if err := chStream(ctx, client, conn, buildCHExportQuery(cfg, yyyymm, true), cutoffParams,
				filePath); err != nil {
				return nil, err
			}
			// Files without valid Parquet content are discarded.
			if isEmptyParquet(filePath) {
				os.Remove(filePath)
				continue
			}

			checksum, err := sha256File(filePath)
			if err != nil {
				return nil, migrationErrorf("%s", err)
			}
			files = append(files, filename)
			fileEntries = append(fileEntries, TelemetryFile{Name: filename, Checksum: checksum})
			checksums.Set(filename, checksum)
			tableRowCount += partitionCount
			info, err := os.Stat(filePath)
			if err != nil {
				return nil, migrationErrorf("%s", err)
			}
			totalSize += info.Size()
		}

		totalRows += tableRowCount
		var timeRange any
		var resultRange *[2]string
		if len(files) > 0 {
			timeRange = NewDoc().Set("min", minText).Set("max", maxText)
			resultRange = &[2]string{minText, maxText}
		}
		tableMeta.Set(cfg.Name, NewDoc().
			Set("files", files).
			Set("row_count", tableRowCount).
			Set("checksum", checksums).
			Set("time_range", timeRange))
		tables = append(tables, TelemetryTable{
			Name: cfg.Name, Files: fileEntries, RowCount: tableRowCount, TimeRange: resultRange,
		})
	}

	report.update("ch_export", 95, "Writing telemetry manifest")

	urlHash := sha256.Sum256([]byte(chURL))
	telemetryManifest := NewDoc().
		Set("migration_id", migrationID).
		Set("phase", "deep_copy").
		Set("phase_status", "export_complete").
		Set("export_completed_at", isoFormat(time.Now().UTC(), true)).
		Set("export_time_cutoff", cutoff).
		Set("source_clickhouse_url_hash", hex.EncodeToString(urlHash[:])).
		Set("tables", tableMeta).
		Set("fk_validation", NewDoc().
			Set("orphaned_agent_ids", []string{}).
			Set("orphaned_agent_ids_truncated", false).
			Set("orphaned_user_ids", []string{}).
			Set("orphaned_user_ids_truncated", false).
			Set("validated_at", nil))
	if err := writeManifest(filepath.Join(outputDir, "telemetry_manifest.json"), telemetryManifest); err != nil {
		return nil, migrationErrorf("%s", err)
	}

	report.update("ch_export", 100, "Telemetry export complete")

	return &TelemetryExportResult{
		OutputDir:      outputDir,
		MigrationID:    migrationID,
		Tables:         tables,
		TotalRows:      totalRows,
		TotalSizeBytes: totalSize,
	}, nil
}

// Comma renders an integer with thousands separators.
func Comma(n int64) string {
	text := fmt.Sprintf("%d", n)
	negative := strings.HasPrefix(text, "-")
	if negative {
		text = text[1:]
	}
	var b strings.Builder
	lead := len(text) % 3
	if lead > 0 {
		b.WriteString(text[:lead])
	}
	for i := lead; i < len(text); i += 3 {
		if b.Len() > 0 {
			b.WriteByte(',')
		}
		b.WriteString(text[i : i+3])
	}
	if negative {
		return "-" + b.String()
	}
	return b.String()
}
