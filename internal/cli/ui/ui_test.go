// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package ui

import (
	"bytes"
	"strings"
	"testing"
)

func env(pairs map[string]string) func(string) string {
	return func(key string) string { return pairs[key] }
}

func TestColorPolicy(t *testing.T) {
	cases := []struct {
		name string
		vtOK bool
		env  map[string]string
		want bool
	}{
		{"tty default", true, nil, true},
		{"pipe default", false, nil, false},
		{"NO_COLOR wins on tty", true, map[string]string{"NO_COLOR": "1"}, false},
		{"CLICOLOR_FORCE wins on pipe", false, map[string]string{"CLICOLOR_FORCE": "1"}, true},
		{"CLICOLOR_FORCE zero is off", false, map[string]string{"CLICOLOR_FORCE": "0"}, false},
		{"dumb terminal never colors", true, map[string]string{"TERM": "dumb", "CLICOLOR_FORCE": "1"}, false},
		{"NO_COLOR beats CLICOLOR_FORCE", true, map[string]string{"NO_COLOR": "x", "CLICOLOR_FORCE": "1"}, false},
	}
	for _, tc := range cases {
		if got := colorEnabled(tc.vtOK, env(tc.env)); got != tc.want {
			t.Errorf("%s: colorEnabled = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestPaintOnAndOff(t *testing.T) {
	var buf bytes.Buffer
	colored := NewConsole(&buf, true, true, 80)
	if got := colored.Success("ok"); got != "\x1b[32mok\x1b[0m" {
		t.Errorf("colored Success = %q", got)
	}
	if got := colored.Danger("gone"); got != "\x1b[1;31mgone\x1b[0m" {
		t.Errorf("colored Danger = %q", got)
	}
	plain := NewConsole(&buf, false, false, 80)
	for name, got := range map[string]string{
		"Success": plain.Success("x"), "Warn": plain.Warn("x"), "Fail": plain.Fail("x"),
		"Info": plain.Info("x"), "Bold": plain.Bold("x"), "Dim": plain.Dim("x"), "Danger": plain.Danger("x"),
	} {
		if got != "x" {
			t.Errorf("plain %s = %q, want bare text", name, got)
		}
	}
	if colored.Success("") != "" {
		t.Error("empty text must never gain escape sequences")
	}
}

func TestVerdictLines(t *testing.T) {
	var buf bytes.Buffer
	c := NewConsole(&buf, false, false, 80)
	c.Successf("pulled %d files", 3)
	c.Warnf("skipped %s", "hook")
	c.Failf("failed")
	c.Notef("details in %s", "log")
	want := "✓ pulled 3 files\n! skipped hook\n✗ failed\ndetails in log\n"
	if buf.String() != want {
		t.Errorf("verdict lines = %q, want %q", buf.String(), want)
	}
}

func TestConfirmAnswers(t *testing.T) {
	cases := []struct {
		answer string
		want   bool
	}{
		{"y\n", true}, {"Y\n", true}, {"yes\n", true}, {"YES\n", true},
		{"n\n", false}, {"no\n", false}, {"\n", false}, {"maybe\n", false},
	}
	for _, tc := range cases {
		var buf bytes.Buffer
		c := NewConsole(&buf, false, false, 80)
		if got := ask(c, strings.NewReader(tc.answer), "Proceed?", false); got != tc.want {
			t.Errorf("answer %q: ask = %v, want %v", tc.answer, got, tc.want)
		}
	}
}

func TestConfirmNormalizesPrompt(t *testing.T) {
	var buf bytes.Buffer
	c := NewConsole(&buf, false, false, 80)
	ask(c, strings.NewReader("y\n"), "\nDelete organization 'acme'? [y/N]", true)
	out := buf.String()
	if !strings.HasPrefix(out, "\n") {
		t.Errorf("leading newline lost: %q", out)
	}
	if strings.Count(out, "[y/N]") != 1 {
		t.Errorf("suffix duplicated or lost: %q", out)
	}
	if !strings.Contains(out, "! Delete organization 'acme'? [y/N] ") {
		t.Errorf("destructive prompt malformed: %q", out)
	}
}

func TestConfirmClosedInputDeclines(t *testing.T) {
	var buf bytes.Buffer
	c := NewConsole(&buf, false, false, 80)
	if ask(c, strings.NewReader(""), "Proceed?", false) {
		t.Error("closed input must decline")
	}
	if !strings.Contains(buf.String(), "pass --yes") {
		t.Errorf("missing non-interactive hint: %q", buf.String())
	}
}

func TestConfirmDoesNotOverread(t *testing.T) {
	var buf bytes.Buffer
	c := NewConsole(&buf, false, false, 80)
	in := strings.NewReader("y\nsecond line\n")
	if !ask(c, in, "First?", false) {
		t.Fatal("first answer should be yes")
	}
	rest, _ := readLine(in)
	if rest != "second line" {
		t.Errorf("confirmation consumed later input: %q", rest)
	}
}

func TestTableAlignment(t *testing.T) {
	var buf bytes.Buffer
	c := NewConsole(&buf, false, false, 80)
	table := NewTable("NAME", "STATUS").
		Row("core/agent", "current").
		Row("x", "missing")
	got := table.Render(c)
	want := "NAME        STATUS\n" +
		"core/agent  current\n" +
		"x           missing\n"
	if got != want {
		t.Errorf("table layout:\n%q\nwant:\n%q", got, want)
	}
}

func TestTableStyledCellWidth(t *testing.T) {
	var buf bytes.Buffer
	c := NewConsole(&buf, true, false, 80)
	styled := c.Warn("outdated")
	got := NewTable("A", "B").Row(styled, "end").Render(c)
	line := strings.Split(got, "\n")[1]
	if !strings.Contains(line, styled+"  end") {
		t.Errorf("styled cell broke gutter alignment: %q", line)
	}
}

func TestTableShrinksToTerminalWidth(t *testing.T) {
	var buf bytes.Buffer
	c := NewConsole(&buf, false, true, 24)
	got := NewTable("NAME", "STATUS").
		Row("a-very-long-component-name-here", "ok").Render(c)
	for _, line := range strings.Split(strings.TrimRight(got, "\n"), "\n") {
		if displayWidth(line) > 24 {
			t.Errorf("line exceeds terminal width: %q", line)
		}
	}
	if !strings.Contains(got, "…") {
		t.Errorf("expected ellipsis truncation: %q", got)
	}
}

func TestDisplayWidthSkipsEscapes(t *testing.T) {
	c := NewConsole(&bytes.Buffer{}, true, false, 80)
	if got := displayWidth(c.Success("abc")); got != 3 {
		t.Errorf("displayWidth = %d, want 3", got)
	}
}
