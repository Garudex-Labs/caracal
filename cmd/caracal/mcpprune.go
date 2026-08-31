// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// pruneMcpEntries removes the named MCP servers from the harness config at
// path, under the servers key, without touching any other entry. The caller
// supplies only names a prior install of this agent wrote and no other install
// still claims, so developer-owned and other agents' servers are never removed.
func pruneMcpEntries(path, serversKey string, stale map[string]bool) error {
	if path == "" || serversKey == "" || len(stale) == 0 {
		return nil
	}
	blob, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	switch {
	case strings.HasSuffix(path, ".yaml"), strings.HasSuffix(path, ".yml"):
		return pruneYAMLMcp(path, blob, serversKey, stale)
	case strings.HasSuffix(path, ".toml"):
		return pruneTOMLMcp(path, blob, serversKey, stale)
	default:
		return pruneJSONMcp(path, blob, serversKey, stale)
	}
}

func pruneJSONMcp(path string, blob []byte, serversKey string, stale map[string]bool) error {
	value, err := decodeOrderedJSON(blob)
	if err != nil {
		return err
	}
	root, ok := value.(*omap)
	if !ok {
		return nil
	}
	section, ok := root.get(serversKey).(*omap)
	if !ok || section == nil {
		return nil
	}
	removed := false
	for name := range stale {
		if section.has(name) {
			section.remove(name)
			removed = true
		}
	}
	if !removed {
		return nil
	}
	out, err := marshalOrdered(root)
	if err != nil {
		return err
	}
	pretty, err := indentJSON(out)
	if err != nil {
		return err
	}
	return atomicWriteBytes(path, append(pretty, '\n'))
}

func pruneYAMLMcp(path string, blob []byte, serversKey string, stale map[string]bool) error {
	var parsed any
	if err := yaml.Unmarshal(blob, &parsed); err != nil {
		return err
	}
	root, ok := parsed.(map[string]any)
	if !ok {
		return nil
	}
	section, ok := root[serversKey].(map[string]any)
	if !ok || section == nil {
		return nil
	}
	removed := false
	for name := range stale {
		if _, present := section[name]; present {
			delete(section, name)
			removed = true
		}
	}
	if !removed {
		return nil
	}
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(root); err != nil {
		return err
	}
	if err := enc.Close(); err != nil {
		return err
	}
	return atomicWriteBytes(path, buf.Bytes())
}

// pruneTOMLMcp removes each `[serversKey.name]` table block, mirroring the
// block boundaries mergeTOMLText writes.
func pruneTOMLMcp(path string, blob []byte, serversKey string, stale map[string]bool) error {
	lines := strings.Split(string(blob), "\n")
	removed := false
	for name := range stale {
		header := fmt.Sprintf("[%s.%s]", serversKey, name)
		start := -1
		for i, line := range lines {
			if strings.TrimSpace(line) == header {
				start = i
				break
			}
		}
		if start == -1 {
			continue
		}
		end := len(lines)
		for i := start + 1; i < len(lines); i++ {
			if strings.HasPrefix(strings.TrimSpace(lines[i]), "[") {
				end = i
				break
			}
		}
		lines = append(lines[:start], lines[end:]...)
		removed = true
	}
	if !removed {
		return nil
	}
	out := strings.TrimRight(strings.Join(lines, "\n"), "\n") + "\n"
	return atomicWriteBytes(path, []byte(out))
}

func atomicWriteBytes(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), path)
}
