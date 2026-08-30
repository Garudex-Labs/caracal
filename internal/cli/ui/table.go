// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package ui

import (
	"strings"
	"unicode/utf8"
)

const tableGutter = "  "

// minColumnWidth is the floor below which shrinking stops; narrower cells
// lose too much meaning to be worth fitting.
const minColumnWidth = 8

// Table renders rows in aligned columns, shrinking oversized columns with
// ellipsis truncation when the output is an interactive terminal.
type Table struct {
	headers []string
	rows    [][]string
}

// NewTable creates a table with the given column headers.
func NewTable(headers ...string) *Table {
	return &Table{headers: headers}
}

// Row appends one row, padding or truncating to the column count.
func (t *Table) Row(cells ...string) *Table {
	row := make([]string, len(t.headers))
	for i := range row {
		if i < len(cells) {
			row[i] = cells[i]
		}
	}
	t.rows = append(t.rows, row)
	return t
}

// Render lays out the table for the console, coloring headers and fitting
// the terminal width. Non-interactive output keeps natural column widths.
func (t *Table) Render(c *Console) string {
	if len(t.headers) == 0 {
		return ""
	}
	widths := make([]int, len(t.headers))
	for i, h := range t.headers {
		widths[i] = displayWidth(h)
	}
	for _, row := range t.rows {
		for i, cell := range row {
			if w := displayWidth(cell); w > widths[i] {
				widths[i] = w
			}
		}
	}
	if c.tty {
		shrinkToFit(widths, c.width)
	}
	var out strings.Builder
	writeRow := func(cells []string, style func(string) string) {
		for i, cell := range cells {
			if i > 0 {
				out.WriteString(tableGutter)
			}
			trimmed := truncateCell(cell, widths[i])
			out.WriteString(style(trimmed))
			if i < len(cells)-1 {
				out.WriteString(strings.Repeat(" ", widths[i]-displayWidth(trimmed)))
			}
		}
		out.WriteString("\n")
	}
	writeRow(t.headers, c.Bold)
	for _, row := range t.rows {
		writeRow(row, func(s string) string { return s })
	}
	return out.String()
}

// shrinkToFit narrows the widest columns until the row fits the terminal.
func shrinkToFit(widths []int, limit int) {
	total := func() int {
		sum := (len(widths) - 1) * len(tableGutter)
		for _, w := range widths {
			sum += w
		}
		return sum
	}
	for total() > limit {
		widest := 0
		for i, w := range widths {
			if w > widths[widest] {
				widest = i
			}
		}
		if widths[widest] <= minColumnWidth {
			return
		}
		widths[widest]--
	}
}

// displayWidth counts visible runes, skipping SGR escape sequences.
func displayWidth(s string) int {
	width := 0
	inEscape := false
	for _, r := range s {
		switch {
		case inEscape:
			if r == 'm' {
				inEscape = false
			}
		case r == '\x1b':
			inEscape = true
		default:
			width++
		}
	}
	return width
}

// truncateCell shortens plain cells with an ellipsis; styled cells are
// never cut so escape sequences stay balanced.
func truncateCell(cell string, width int) string {
	if displayWidth(cell) <= width || strings.Contains(cell, "\x1b") {
		return cell
	}
	runes := []rune(cell)
	if width < 1 {
		width = 1
	}
	if utf8.RuneCountInString(cell) <= width {
		return cell
	}
	return string(runes[:width-1]) + "…"
}
