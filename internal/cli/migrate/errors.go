// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package migrate

import (
	"errors"
	"fmt"
)

// Kind classifies a migration failure for the CLI error contract.
type Kind string

const (
	// KindMigration is the generic operation failure.
	KindMigration Kind = "MigrationError"
	// KindChecksumMismatch marks checksum verification failures.
	KindChecksumMismatch Kind = "ChecksumMismatchError"
	// KindConnectionFailed marks database connectivity failures.
	KindConnectionFailed Kind = "ConnectionFailedError"
	// KindPrerequisite marks missing or incomplete prior-phase artifacts.
	KindPrerequisite Kind = "PrerequisiteError"
)

// Error is a categorized migration failure.
type Error struct {
	Kind    Kind
	Message string
}

func (e *Error) Error() string { return e.Message }

func migrationErrorf(format string, args ...any) *Error {
	return &Error{Kind: KindMigration, Message: fmt.Sprintf(format, args...)}
}

func checksumErrorf(format string, args ...any) *Error {
	return &Error{Kind: KindChecksumMismatch, Message: fmt.Sprintf(format, args...)}
}

func connectionErrorf(format string, args ...any) *Error {
	return &Error{Kind: KindConnectionFailed, Message: fmt.Sprintf(format, args...)}
}

func prerequisiteErrorf(format string, args ...any) *Error {
	return &Error{Kind: KindPrerequisite, Message: fmt.Sprintf(format, args...)}
}

// AsError classifies any error as a migration *Error, wrapping unknown
// failures as the generic kind.
func AsError(err error) *Error {
	var merr *Error
	if errors.As(err, &merr) {
		return merr
	}
	return &Error{Kind: KindMigration, Message: err.Error()}
}
