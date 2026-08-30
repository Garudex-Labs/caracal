// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package ingest

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/harness"
)

// FuzzBuildRows drives arbitrary transcript lines through every registered
// harness's row builder: the first seed byte selects the harness, matching
// the seed-corpus convention, and the builder must never panic.
func FuzzBuildRows(f *testing.F) {
	reg := harness.MustLoad()
	names := reg.Names()

	root := filepath.Join("..", "..", "contracts", "session-goldens")
	if entries, err := os.ReadDir(root); err == nil {
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			raw, err := os.ReadFile(filepath.Join(root, entry.Name(), "input.jsonl"))
			if err != nil {
				continue
			}
			for i := range names {
				f.Add(append([]byte{byte(i)}, raw...))
			}
		}
	}
	f.Add([]byte{0})
	f.Add([]byte{1, '{', '}', '\n', 'n', 'o', 't', ' ', 'j', 's', 'o', 'n'})

	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) == 0 {
			return
		}
		name := names[int(data[0])%len(names)]
		builder, err := NewBuilder(reg, name)
		if err != nil {
			t.Skip()
		}
		var lines []string
		for _, line := range strings.Split(string(data[1:]), "\n") {
			if strings.TrimSpace(line) != "" {
				lines = append(lines, line)
			}
		}
		rows, _ := builder.BuildRows(lines, 0)
		for _, row := range rows {
			if row.Harness == "" && row.EventType == "" && row.LineHash == "" {
				t.Fatal("builder produced an entirely empty row")
			}
		}
	})
}
