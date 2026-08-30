// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package adminmigrate

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
)

var (
	magicTarGz   = []byte{0x1f, 0x8b}
	magicParquet = []byte("PAR1")
)

// uploadError carries the HTTP status and detail for a rejected upload.
type uploadError struct {
	Status int
	Detail string
}

func (e *uploadError) Error() string { return e.Detail }

func unprocessable(format string, args ...any) *uploadError {
	return &uploadError{Status: 422, Detail: fmt.Sprintf(format, args...)}
}

func readMagic(fh *multipart.FileHeader) ([]byte, error) {
	f, err := fh.Open()
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	header := make([]byte, 4)
	n, err := io.ReadFull(f, header)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return nil, err
	}
	return header[:n], nil
}

// validateUploads enforces the size limit, magic bytes, and scope
// consistency for uploaded artifact files.
func validateUploads(files []*multipart.FileHeader, scope string, maxBytes int64) *uploadError {
	hasArchive := false
	hasParquet := false

	for _, fh := range files {
		if fh.Size > maxBytes {
			return unprocessable("File '%s' exceeds maximum upload size", fh.Filename)
		}
		header, err := readMagic(fh)
		if err != nil {
			return unprocessable("File '%s' could not be read", fh.Filename)
		}
		if len(header) < 2 {
			return unprocessable("File '%s' is too small to validate", fh.Filename)
		}
		switch {
		case bytes.Equal(header[:2], magicTarGz):
			hasArchive = true
		case len(header) >= 4 && bytes.Equal(header[:4], magicParquet):
			hasParquet = true
		default:
			return unprocessable("File '%s' has unsupported format (expected .tar.gz or .parquet)", fh.Filename)
		}
	}

	if scope == "postgres" && hasParquet && !hasArchive {
		return unprocessable("Scope is 'postgres' but only Parquet files were uploaded")
	}
	if scope == "clickhouse" && hasArchive && !hasParquet {
		return unprocessable("Scope is 'clickhouse' but only archive files were uploaded")
	}
	return nil
}

// sanitizeUploadName strips directory components and rejects reserved
// names, substituting a random name when the result is unusable.
func sanitizeUploadName(raw string) string {
	name := filepath.Base(strings.ReplaceAll(raw, "\\", "/"))
	if name == "" || name == "." || name == ".." || name == "/" {
		return "upload_" + uuid.NewString()[:8]
	}
	return name
}

// storeUploads writes the uploaded files into the job's artifact directory
// with restrictive permissions.
func storeUploads(files []*multipart.FileHeader, jobDir string) error {
	if err := os.MkdirAll(jobDir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(jobDir, 0o700); err != nil {
		return err
	}
	for _, fh := range files {
		src, err := fh.Open()
		if err != nil {
			return err
		}
		dest := filepath.Join(jobDir, sanitizeUploadName(fh.Filename))
		out, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
		if err != nil {
			_ = src.Close()
			return err
		}
		_, err = io.Copy(out, src)
		_ = src.Close()
		if closeErr := out.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			return err
		}
	}
	return nil
}
