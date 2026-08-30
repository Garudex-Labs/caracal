// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package migrate

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// sha256File computes the SHA-256 hex digest of a file.
func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// safeExtract unpacks a tar.gz archive into dest, rejecting members whose
// paths escape the destination and any link members.
func safeExtract(archivePath, dest string) error {
	f, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer func() { _ = gz.Close() }()
	tr := tar.NewReader(gz)
	destAbs, err := filepath.Abs(dest)
	if err != nil {
		return err
	}
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		name := hdr.Name
		if filepath.IsAbs(name) || strings.Contains(name, "..") {
			return fmt.Errorf("tar member %q would escape destination directory", name)
		}
		target := filepath.Join(destAbs, filepath.FromSlash(name))
		if target != destAbs && !strings.HasPrefix(target, destAbs+string(os.PathSeparator)) {
			return fmt.Errorf("tar member %q would escape destination directory", name)
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o700); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
				return err
			}
			out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
			if err != nil {
				return err
			}
			if _, err := io.Copy(out, tr); err != nil {
				_ = out.Close()
				return err
			}
			if err := out.Close(); err != nil {
				return err
			}
		case tar.TypeSymlink, tar.TypeLink:
			return fmt.Errorf("tar member %q is a symlink (rejected for safety)", name)
		default:
			// Skip other member types.
		}
	}
	return nil
}

// IsTarGz reports whether path opens as a gzip-compressed tar archive.
func IsTarGz(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer func() { _ = f.Close() }()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return false
	}
	defer func() { _ = gz.Close() }()
	_, err = tar.NewReader(gz).Next()
	return err == nil
}

// buildPGManifest assembles the manifest.json content for a registry export.
func buildPGManifest(migrationID, exportedAt, alembicVersion string, tableCounts map[string]int64,
	fileHashes map[string]string) *Doc {
	tables := NewDoc()
	for _, table := range insertOrder {
		tables.Set(table, NewDoc().
			Set("checksum", fileHashes[table]).
			Set("row_count", tableCounts[table]))
	}
	return NewDoc().
		Set("schema_version", "1.0").
		Set("migration_id", migrationID).
		Set("exported_at", exportedAt).
		Set("source_alembic_version", alembicVersion).
		Set("tables", tables)
}

// buildMigrationManifest assembles migration_manifest.json for the
// telemetry export phase.
func buildMigrationManifest(migrationID, exportedAt, dbURLHash string, tableCounts map[string]int64,
	uuidRanges *Doc) *Doc {
	counts := NewDoc()
	for _, table := range insertOrder {
		counts.Set(table, tableCounts[table])
	}
	return NewDoc().
		Set("migration_id", migrationID).
		Set("phase1_completed_at", exportedAt).
		Set("source_db_url_hash", dbURLHash).
		Set("table_row_counts", counts).
		Set("uuid_ranges", uuidRanges)
}

// readManifest parses a JSON manifest file preserving key order.
func readManifest(path string) (*Doc, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	value, err := parseOrdered(data)
	if err != nil {
		return nil, err
	}
	doc, ok := value.(*Doc)
	if !ok {
		return nil, fmt.Errorf("manifest %s is not a JSON object", path)
	}
	return doc, nil
}

// writeManifest atomically writes a private indent-2 JSON manifest.
func writeManifest(path string, data *Doc) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.WriteString(dumpsIndent(data) + "\n"); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, 0o600); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

// packPGArchive packs the manifest files and per-table JSONL files into a
// tar.gz written to a temporary sibling and renamed into place with mode 0600.
func packPGArchive(outputPath, manifestPath, migrationManifestPath, pgDir string) error {
	if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(outputPath), "."+filepath.Base(outputPath)+".")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	gz := gzip.NewWriter(tmp)
	tw := tar.NewWriter(gz)
	addFile := func(src, arcname string) error {
		info, err := os.Stat(src)
		if err != nil {
			return err
		}
		hdr := &tar.Header{
			Name:    arcname,
			Mode:    int64(info.Mode().Perm()),
			Size:    info.Size(),
			ModTime: info.ModTime(),
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		f, err := os.Open(src)
		if err != nil {
			return err
		}
		defer func() { _ = f.Close() }()
		_, err = io.Copy(tw, f)
		return err
	}
	pack := func() error {
		if err := addFile(manifestPath, "manifest.json"); err != nil {
			return err
		}
		if err := addFile(migrationManifestPath, "migration_manifest.json"); err != nil {
			return err
		}
		for _, table := range insertOrder {
			if err := addFile(filepath.Join(pgDir, table+".jsonl"), "pg/"+table+".jsonl"); err != nil {
				return err
			}
		}
		return nil
	}
	if err := pack(); err != nil {
		_ = tw.Close()
		_ = gz.Close()
		_ = tmp.Close()
		return err
	}
	if err := tw.Close(); err != nil {
		_ = gz.Close()
		_ = tmp.Close()
		return err
	}
	if err := gz.Close(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, 0o600); err != nil {
		return err
	}
	return os.Rename(tmpName, outputPath)
}

// monthRange lists YYYYMM integers from min to max, inclusive.
func monthRange(minT, maxT time.Time) []int {
	months := []int{}
	year, month := minT.Year(), int(minT.Month())
	endYear, endMonth := maxT.Year(), int(maxT.Month())
	for year < endYear || (year == endYear && month <= endMonth) {
		months = append(months, year*100+month)
		month++
		if month > 12 {
			month = 1
			year++
		}
	}
	return months
}

var parquetMagic = []byte("PAR1")

// isEmptyParquet reports whether the file is empty or lacks the Parquet
// magic markers; unreadable files count as empty so they are discarded.
func isEmptyParquet(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.Size() == 0 {
		return true
	}
	if info.Size() < 12 {
		return true
	}
	f, err := os.Open(path)
	if err != nil {
		return true
	}
	defer func() { _ = f.Close() }()
	head := make([]byte, 4)
	if _, err := io.ReadFull(f, head); err != nil || !bytes.Equal(head, parquetMagic) {
		return true
	}
	tail := make([]byte, 4)
	if _, err := f.ReadAt(tail, info.Size()-4); err != nil || !bytes.Equal(tail, parquetMagic) {
		return true
	}
	return false
}

// SidecarPath derives the migration manifest sidecar path for an archive.
func SidecarPath(archivePath string) string {
	name := filepath.Base(archivePath)
	name = strings.TrimSuffix(name, ".tar.gz")
	name = strings.TrimSuffix(name, ".tgz")
	return filepath.Join(filepath.Dir(archivePath), name+".manifest.json")
}
