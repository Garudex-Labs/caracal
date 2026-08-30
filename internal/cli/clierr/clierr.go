// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package clierr implements the stable CLI failure contract: categorized
// errors with fixed process exit codes, rendered as exactly one JSON
// document or human-readable block on stderr.
package clierr

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/garudex-labs/caracal/internal/cli/ui"
)

// Category classifies a failure and selects its exit code.
type Category string

const (
	Unexpected  Category = "unexpected"
	Usage       Category = "usage"
	Auth        Category = "authentication"
	Permission  Category = "permission"
	NotFound    Category = "not_found"
	Conflict    Category = "conflict"
	Validation  Category = "validation"
	RateLimit   Category = "rate_limit"
	Unavailable Category = "unavailable"
	Version     Category = "version_mismatch"
)

var exitCodes = map[Category]int{
	Unexpected:  1,
	Usage:       2,
	Auth:        3,
	Permission:  4,
	NotFound:    5,
	Conflict:    6,
	Validation:  7,
	RateLimit:   8,
	Unavailable: 9,
	Version:     10,
}

// Error is a safe, actionable failure ready for rendering.
type Error struct {
	Category    Category
	Message     string
	Operation   string
	Resource    string
	Remediation string
	RequestID   string
	HTTPStatus  int
	Detail      string
}

func (e *Error) Error() string { return e.Message }

// ExitCode returns the stable process exit code for the category.
func (e *Error) ExitCode() int {
	if code, ok := exitCodes[e.Category]; ok {
		return code
	}
	return 1
}

// quote renders a JSON string without HTML escaping.
func quote(s string) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	return strings.TrimRight(buf.String(), "\n")
}

// Emit writes one error document or human error block to stderr.
func Emit(e *Error, jsonMode, debug bool) {
	if jsonMode {
		var doc bytes.Buffer
		doc.WriteString(`{"error": {"category": ` + quote(string(e.Category)))
		doc.WriteString(`, "message": ` + quote(e.Message))
		doc.WriteString(`, "operation": ` + quote(e.Operation))
		fmt.Fprintf(&doc, `, "exit_code": %d`, e.ExitCode())
		if e.Resource != "" {
			doc.WriteString(`, "resource": ` + quote(e.Resource))
		}
		if e.Remediation != "" {
			doc.WriteString(`, "remediation": ` + quote(e.Remediation))
		}
		if e.RequestID != "" {
			doc.WriteString(`, "request_id": ` + quote(e.RequestID))
		}
		if e.HTTPStatus != 0 {
			fmt.Fprintf(&doc, `, "http_status": %d`, e.HTTPStatus)
		}
		if debug && e.Detail != "" {
			doc.WriteString(`, "detail": ` + quote(e.Detail))
		}
		doc.WriteString("}}")
		fmt.Fprintln(os.Stderr, doc.String())
		return
	}
	c := ui.Stderr()
	fmt.Fprintf(os.Stderr, "%s %s\n", c.Danger("Error ("+string(e.Category)+"):"), e.Message)
	fmt.Fprintf(os.Stderr, "%s %s\n", c.Dim("Operation:"), e.Operation)
	if e.Resource != "" {
		fmt.Fprintf(os.Stderr, "%s %s\n", c.Dim("Resource:"), e.Resource)
	}
	if e.Remediation != "" {
		fmt.Fprintf(os.Stderr, "%s %s\n", c.Dim("Remediation:"), e.Remediation)
	}
	if e.RequestID != "" {
		fmt.Fprintf(os.Stderr, "%s %s\n", c.Dim("Request ID:"), e.RequestID)
	}
	if debug && e.Detail != "" {
		fmt.Fprintf(os.Stderr, "%s %s\n", c.Dim("Detail:"), e.Detail)
	}
}
