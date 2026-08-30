// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package ui

import (
	"fmt"
	"io"
	"os"
	"strings"

	"golang.org/x/term"
)

// Input is the confirmation input stream; tests may replace it.
var Input io.Reader = os.Stdin

// Confirm asks one yes/no question, defaulting to no. The prompt goes to
// standard error so redirected standard output never captures it.
func Confirm(prompt string) bool { return ask(Stderr(), Input, prompt, false) }

// ConfirmDestructive renders the destructive-action form of Confirm.
func ConfirmDestructive(prompt string) bool { return ask(Stderr(), Input, prompt, true) }

// ask normalizes the prompt to one shared "[y/N]" form, reads one answer
// line, and treats anything but an explicit yes as a refusal.
func ask(c *Console, in io.Reader, prompt string, destructive bool) bool {
	for strings.HasPrefix(prompt, "\n") {
		_, _ = fmt.Fprintln(c.w)
		prompt = strings.TrimPrefix(prompt, "\n")
	}
	prompt = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(prompt), "[y/N]"))
	marker := c.Info("?")
	if destructive {
		marker = c.Danger(SymbolWarn)
	}
	_, _ = fmt.Fprintf(c.w, "%s %s %s ", marker, prompt, c.Dim("[y/N]"))
	line, err := readLine(in)
	answer := strings.ToLower(strings.TrimSpace(line))
	if err != nil && line == "" {
		// The input stream closed before any answer arrived.
		_, _ = fmt.Fprintln(c.w)
		if !stdinInteractive() {
			c.Notef("No confirmation received on standard input; pass --yes where supported for non-interactive use.")
		}
		return false
	}
	return answer == "y" || answer == "yes"
}

// readLine consumes exactly one line, never buffering past the newline so
// later prompts in the same process still see their piped answers.
func readLine(in io.Reader) (string, error) {
	var line strings.Builder
	buf := make([]byte, 1)
	for {
		n, err := in.Read(buf)
		if n > 0 {
			if buf[0] == '\n' {
				return line.String(), nil
			}
			line.WriteByte(buf[0])
		}
		if err != nil {
			return line.String(), err
		}
	}
}

// stdinInteractive reports whether standard input is a terminal.
func stdinInteractive() bool { return term.IsTerminal(int(os.Stdin.Fd())) }
