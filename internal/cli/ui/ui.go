// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package ui implements the CLI presentation layer: terminal capability
// detection, restrained semantic color, progress indication, confirmation
// prompts, and aligned tables. Every helper degrades to plain text on
// non-interactive streams so pipes, CI logs, and redirected output stay
// stable without terminal interaction.
package ui

import (
	"fmt"
	"io"
	"os"
	"sync"

	"golang.org/x/term"
)

// ANSI SGR codes for the semantic palette. Success, warning, error, info,
// emphasis, and destructive are the only states that receive color.
const (
	sgrReset  = "\x1b[0m"
	sgrBold   = "\x1b[1m"
	sgrDim    = "\x1b[2m"
	sgrRed    = "\x1b[31m"
	sgrGreen  = "\x1b[32m"
	sgrYellow = "\x1b[33m"
	sgrCyan   = "\x1b[36m"
	sgrDanger = "\x1b[1;31m"
)

// Status symbols shared by every command family.
const (
	SymbolOK   = "✓"
	SymbolFail = "✗"
	SymbolWarn = "!"
)

// Console binds semantic styling to one output stream.
type Console struct {
	w     io.Writer
	color bool
	tty   bool
	width int
}

// NewConsole builds a console with explicit capabilities, primarily for tests.
func NewConsole(w io.Writer, color, interactive bool, width int) *Console {
	if width <= 0 {
		width = 80
	}
	return &Console{w: w, color: color, tty: interactive, width: width}
}

var (
	stdoutOnce sync.Once
	stdoutCon  *Console
	stderrOnce sync.Once
	stderrCon  *Console
)

// stdoutSink and stderrSink resolve the process stream at write time so
// tests and callers that swap os.Stdout or os.Stderr capture styled output.
type stdoutSink struct{}

func (stdoutSink) Write(p []byte) (int, error) { return os.Stdout.Write(p) }

type stderrSink struct{}

func (stderrSink) Write(p []byte) (int, error) { return os.Stderr.Write(p) }

// Stdout returns the console bound to standard output.
func Stdout() *Console {
	stdoutOnce.Do(func() {
		stdoutCon = detect(os.Stdout)
		stdoutCon.w = stdoutSink{}
	})
	return stdoutCon
}

// Stderr returns the console bound to standard error.
func Stderr() *Console {
	stderrOnce.Do(func() {
		stderrCon = detect(os.Stderr)
		stderrCon.w = stderrSink{}
	})
	return stderrCon
}

// detect probes one stream for interactivity, color support, and width.
func detect(f *os.File) *Console {
	fd := int(f.Fd())
	tty := term.IsTerminal(fd)
	width := 0
	if tty {
		if w, _, err := term.GetSize(fd); err == nil && w > 0 {
			width = w
		}
	}
	if width <= 0 {
		width = 80
	}
	vtOK := tty && enableVirtualTerminal(f)
	return &Console{w: f, color: colorEnabled(vtOK, os.Getenv), tty: tty, width: width}
}

// colorEnabled applies the color policy: TTY with VT support by default,
// NO_COLOR always wins over the default, CLICOLOR_FORCE wins over pipes,
// and TERM=dumb never receives escape sequences.
func colorEnabled(vtOK bool, getenv func(string) string) bool {
	if getenv("TERM") == "dumb" {
		return false
	}
	if getenv("NO_COLOR") != "" {
		return false
	}
	if force := getenv("CLICOLOR_FORCE"); force != "" && force != "0" {
		return true
	}
	return vtOK
}

// Interactive reports whether the stream is a terminal.
func (c *Console) Interactive() bool { return c.tty }

// Width returns the usable terminal width in columns.
func (c *Console) Width() int { return c.width }

// ColorEnabled reports whether escape sequences are emitted on this stream.
func (c *Console) ColorEnabled() bool { return c.color }

func (c *Console) paint(code, text string) string {
	if !c.color || text == "" {
		return text
	}
	return code + text + sgrReset
}

// Success renders text in the success state.
func (c *Console) Success(text string) string { return c.paint(sgrGreen, text) }

// Warn renders text in the warning state.
func (c *Console) Warn(text string) string { return c.paint(sgrYellow, text) }

// Fail renders text in the error state.
func (c *Console) Fail(text string) string { return c.paint(sgrRed, text) }

// Info renders text in the informational state.
func (c *Console) Info(text string) string { return c.paint(sgrCyan, text) }

// Bold renders emphasized text.
func (c *Console) Bold(text string) string { return c.paint(sgrBold, text) }

// Dim renders de-emphasized text.
func (c *Console) Dim(text string) string { return c.paint(sgrDim, text) }

// Danger renders text in the destructive-action state.
func (c *Console) Danger(text string) string { return c.paint(sgrDanger, text) }

// Successf prints one success line: a green check followed by the message.
func (c *Console) Successf(format string, args ...any) {
	_, _ = fmt.Fprintf(c.w, "%s %s\n", c.Success(SymbolOK), fmt.Sprintf(format, args...))
}

// Warnf prints one warning line: a yellow marker followed by the message.
func (c *Console) Warnf(format string, args ...any) {
	_, _ = fmt.Fprintf(c.w, "%s %s\n", c.Warn(SymbolWarn), fmt.Sprintf(format, args...))
}

// Failf prints one failure line: a red cross followed by the message.
func (c *Console) Failf(format string, args ...any) {
	_, _ = fmt.Fprintf(c.w, "%s %s\n", c.Fail(SymbolFail), fmt.Sprintf(format, args...))
}

// Notef prints one de-emphasized informational line.
func (c *Console) Notef(format string, args ...any) {
	_, _ = fmt.Fprintln(c.w, c.Dim(fmt.Sprintf(format, args...)))
}
