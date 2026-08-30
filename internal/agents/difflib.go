// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"fmt"
	"strings"
)

// matchBlock is one common subsequence: a[A:A+Size] == b[B:B+Size].
type matchBlock struct{ A, B, Size int }

type opcode struct {
	Tag            string
	I1, I2, J1, J2 int
}

// sequenceMatcher mirrors the classic longest-contiguous-match algorithm:
// junk-free b-element indexing, popularity-based auto-junk for long
// sequences, and ties broken toward the earliest block.
type sequenceMatcher struct {
	a, b     []string
	b2j      map[string][]int
	bPopular map[string]bool
}

func newSequenceMatcher(a, b []string) *sequenceMatcher {
	m := &sequenceMatcher{a: a, b: b, b2j: map[string][]int{}, bPopular: map[string]bool{}}
	for j, s := range b {
		m.b2j[s] = append(m.b2j[s], j)
	}
	// Auto-junk: in long sequences, elements occurring in more than one
	// percent of positions carry no alignment signal.
	if n := len(b); n >= 200 {
		threshold := n/100 + 1
		for s, idx := range m.b2j {
			if len(idx) > threshold {
				m.bPopular[s] = true
				delete(m.b2j, s)
			}
		}
	}
	return m
}

func (m *sequenceMatcher) findLongestMatch(alo, ahi, blo, bhi int) matchBlock {
	besti, bestj, bestsize := alo, blo, 0
	j2len := map[int]int{}
	for i := alo; i < ahi; i++ {
		newj2len := map[int]int{}
		for _, j := range m.b2j[m.a[i]] {
			if j < blo {
				continue
			}
			if j >= bhi {
				break
			}
			k := j2len[j-1] + 1
			newj2len[j] = k
			if k > bestsize {
				besti, bestj, bestsize = i-k+1, j-k+1, k
			}
		}
		j2len = newj2len
	}
	// Extend over popular elements on both sides.
	for besti > alo && bestj > blo && m.bPopular[m.b[bestj-1]] && m.a[besti-1] == m.b[bestj-1] {
		besti, bestj, bestsize = besti-1, bestj-1, bestsize+1
	}
	for besti+bestsize < ahi && bestj+bestsize < bhi &&
		m.bPopular[m.b[bestj+bestsize]] && m.a[besti+bestsize] == m.b[bestj+bestsize] {
		bestsize++
	}
	return matchBlock{besti, bestj, bestsize}
}

func (m *sequenceMatcher) matchingBlocks() []matchBlock {
	type span struct{ alo, ahi, blo, bhi int }
	queue := []span{{0, len(m.a), 0, len(m.b)}}
	blocks := []matchBlock{}
	for len(queue) > 0 {
		s := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		blk := m.findLongestMatch(s.alo, s.ahi, s.blo, s.bhi)
		if blk.Size == 0 {
			continue
		}
		blocks = append(blocks, blk)
		queue = append(queue,
			span{s.alo, blk.A, s.blo, blk.B},
			span{blk.A + blk.Size, s.ahi, blk.B + blk.Size, s.bhi})
	}
	// Sort by position and coalesce adjacent blocks.
	for i := 1; i < len(blocks); i++ {
		for j := i; j > 0 && (blocks[j].A < blocks[j-1].A ||
			(blocks[j].A == blocks[j-1].A && blocks[j].B < blocks[j-1].B)); j-- {
			blocks[j], blocks[j-1] = blocks[j-1], blocks[j]
		}
	}
	merged := []matchBlock{}
	i1, j1, k1 := 0, 0, 0
	for _, blk := range blocks {
		if i1+k1 == blk.A && j1+k1 == blk.B {
			k1 += blk.Size
			continue
		}
		if k1 > 0 {
			merged = append(merged, matchBlock{i1, j1, k1})
		}
		i1, j1, k1 = blk.A, blk.B, blk.Size
	}
	if k1 > 0 {
		merged = append(merged, matchBlock{i1, j1, k1})
	}
	merged = append(merged, matchBlock{len(m.a), len(m.b), 0})
	return merged
}

func (m *sequenceMatcher) opcodes() []opcode {
	out := []opcode{}
	i, j := 0, 0
	for _, blk := range m.matchingBlocks() {
		tag := ""
		switch {
		case i < blk.A && j < blk.B:
			tag = "replace"
		case i < blk.A:
			tag = "delete"
		case j < blk.B:
			tag = "insert"
		}
		if tag != "" {
			out = append(out, opcode{tag, i, blk.A, j, blk.B})
		}
		i, j = blk.A+blk.Size, blk.B+blk.Size
		if blk.Size > 0 {
			out = append(out, opcode{"equal", blk.A, i, blk.B, j})
		}
	}
	return out
}

// groupedOpcodes clips runs of equal lines to n of context on either side.
func (m *sequenceMatcher) groupedOpcodes(n int) [][]opcode {
	codes := m.opcodes()
	if len(codes) == 0 {
		codes = []opcode{{"equal", 0, 1, 0, 1}}
	}
	if codes[0].Tag == "equal" {
		c := codes[0]
		codes[0] = opcode{"equal", max(c.I1, c.I2-n), c.I2, max(c.J1, c.J2-n), c.J2}
	}
	if last := codes[len(codes)-1]; last.Tag == "equal" {
		codes[len(codes)-1] = opcode{"equal", last.I1, min(last.I2, last.I1+n), last.J1, min(last.J2, last.J1+n)}
	}
	groups := [][]opcode{}
	group := []opcode{}
	for _, c := range codes {
		if c.Tag == "equal" && c.I2-c.I1 > 2*n {
			group = append(group, opcode{"equal", c.I1, min(c.I2, c.I1+n), c.J1, min(c.J2, c.J1+n)})
			groups = append(groups, group)
			group = []opcode{{"equal", max(c.I1, c.I2-n), c.I2, max(c.J1, c.J2-n), c.J2}}
			continue
		}
		group = append(group, c)
	}
	if len(group) > 0 && (len(group) != 1 || group[0].Tag != "equal") {
		groups = append(groups, group)
	}
	return groups
}

func formatRangeUnified(start, stop int) string {
	beginning := start + 1
	length := stop - start
	if length == 1 {
		return fmt.Sprintf("%d", beginning)
	}
	if length == 0 {
		beginning--
	}
	return fmt.Sprintf("%d,%d", beginning, length)
}

// unifiedDiff renders the classic unified format with three context lines,
// one output line per entry with no trailing newlines.
func unifiedDiff(a, b []string, fromfile, tofile string) []string {
	m := newSequenceMatcher(a, b)
	out := []string{}
	started := false
	for _, group := range m.groupedOpcodes(3) {
		if !started {
			started = true
			out = append(out, "--- "+fromfile, "+++ "+tofile)
		}
		first, last := group[0], group[len(group)-1]
		out = append(out, fmt.Sprintf("@@ -%s +%s @@",
			formatRangeUnified(first.I1, last.I2), formatRangeUnified(first.J1, last.J2)))
		for _, c := range group {
			switch c.Tag {
			case "equal":
				for _, line := range a[c.I1:c.I2] {
					out = append(out, " "+strings.TrimRight(line, "\n"))
				}
			case "replace", "delete":
				for _, line := range a[c.I1:c.I2] {
					out = append(out, "-"+strings.TrimRight(line, "\n"))
				}
			}
			if c.Tag == "replace" || c.Tag == "insert" {
				for _, line := range b[c.J1:c.J2] {
					out = append(out, "+"+strings.TrimRight(line, "\n"))
				}
			}
		}
	}
	return out
}

// snapshotLines splits with line endings kept, so a missing terminal
// newline stays a real difference during comparison.
func snapshotLines(text string) []string {
	if text == "" {
		return nil
	}
	out := []string{}
	start := 0
	for i := 0; i < len(text); i++ {
		if text[i] == '\n' {
			out = append(out, text[start:i+1])
			start = i + 1
		}
	}
	if start < len(text) {
		out = append(out, text[start:])
	}
	return out
}
