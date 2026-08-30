// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package migrate

// ProgressFunc receives phase, percentage, and message updates.
type ProgressFunc func(phase string, pct int, message string)

func (p ProgressFunc) update(phase string, pct int, message string) {
	if p != nil {
		p(phase, pct, message)
	}
}

// TableCount pairs a table with a row count.
type TableCount struct {
	Table string
	Rows  int64
}

// ExportResult reports a completed registry export.
type ExportResult struct {
	ArchivePath     string
	MigrationID     string
	TableCounts     []TableCount
	DurationSeconds float64
	TotalRows       int64
}

// ImportResult reports a completed registry import.
type ImportResult struct {
	MigrationID     string
	TablesImported  int
	RowsInserted    []TableCount
	RowsSkipped     []TableCount
	DurationSeconds float64
	Warnings        []string
}

// ChecksumResult reports one table checksum verification.
type ChecksumResult struct {
	TableName        string
	ExpectedChecksum string
	ActualChecksum   string
	Passed           bool
}

// RowCountPair compares archive/manifest rows against a live database.
type RowCountPair struct {
	Table        string
	ArchiveRows  int64
	DatabaseRows int64
}

// ValidationResult reports archive validation.
type ValidationResult struct {
	ArchiveValid    bool
	ChecksumResults []ChecksumResult
	CrossDBResults  []RowCountPair // nil when no database was provided
}

// TelemetryFile pairs an exported Parquet file with its checksum.
type TelemetryFile struct {
	Name     string
	Checksum string
}

// TelemetryTable reports one exported telemetry table.
type TelemetryTable struct {
	Name      string
	Files     []TelemetryFile
	RowCount  int64
	TimeRange *[2]string // min, max; nil when no files were produced
}

// TelemetryExportResult reports a completed telemetry export.
type TelemetryExportResult struct {
	OutputDir       string
	MigrationID     string
	Tables          []TelemetryTable
	TotalRows       int64
	TotalSizeBytes  int64
	DurationSeconds float64
}

// TelemetryImportResult reports a completed telemetry import.
type TelemetryImportResult struct {
	MigrationID     string
	TablesImported  int
	TablesSkipped   []string
	RowsImported    []TableCount
	DurationSeconds float64
	Warnings        []string
}

// FileCheck reports one Parquet file checksum verification.
type FileCheck struct {
	Name   string
	Passed bool
}

// FKResults reports orphaned foreign-key references.
type FKResults struct {
	OrphanedAgentIDs          []string
	OrphanedAgentIDsTruncated bool
	OrphanedUserIDs           []string
	OrphanedUserIDsTruncated  bool
}

// TelemetryValidationResult reports telemetry validation.
type TelemetryValidationResult struct {
	ChecksumsValid  bool
	ChecksumResults []FileCheck
	FKResults       *FKResults     // nil when FK validation did not run
	RowCountResults []RowCountPair // nil when no ClickHouse was provided
	Warnings        []string
}
