// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package config

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

// AliasesFile returns the local registry alias store path.
func AliasesFile() string { return filepath.Join(Dir(), "aliases.json") }

// LoadAliases reads the local alias map, rejecting non-string entries.
func LoadAliases() (map[string]string, *clierr.Error) {
	blob, err := os.ReadFile(AliasesFile())
	if err != nil {
		return map[string]string{}, nil
	}
	var raw map[string]any
	if json.Unmarshal(blob, &raw) != nil {
		return nil, &clierr.Error{
			Category: clierr.Validation, Message: "The JSON file is malformed.",
			Operation: "Load CLI aliases", Resource: AliasesFile(),
			Remediation: "Repair or remove the file, then retry.",
		}
	}
	aliases := make(map[string]string, len(raw))
	for name, target := range raw {
		value, ok := target.(string)
		if !ok {
			return nil, &clierr.Error{
				Category: clierr.Validation, Message: "Every alias and target must be a string.",
				Operation: "Load CLI aliases", Resource: AliasesFile(),
				Remediation: "Repair or remove the aliases file, then retry.",
			}
		}
		aliases[name] = value
	}
	return aliases, nil
}

// SaveAliases writes the alias map atomically with owner-only permissions.
func SaveAliases(aliases map[string]string) *clierr.Error {
	data := make(map[string]any, len(aliases))
	for name, target := range aliases {
		data[name] = target
	}
	return writeJSON(AliasesFile(), data)
}
