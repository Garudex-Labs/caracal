// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package config manages the CLI configuration at ~/.caracal/config.json:
// on-disk values, environment overrides, and atomic owner-only writes.
package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

// Defaults are the effective values when neither disk nor environment set a key.
var Defaults = map[string]any{
	"server_url":            "",
	"access_token":          "",
	"refresh_token":         "",
	"timeout":               30,
	"update_check":          true,
	"update_check_interval": 86400,
	"update_check_repo":     "",
}

// Dir returns the CLI state directory.
func Dir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return filepath.Join(home, ".caracal")
}

// File returns the config file path.
func File() string { return filepath.Join(Dir(), "config.json") }

func readObject(path, operation string) (map[string]any, *clierr.Error) {
	blob, err := os.ReadFile(path)
	if err != nil {
		return nil, &clierr.Error{
			Category: clierr.Unexpected, Message: "The configuration file cannot be read.",
			Operation: operation, Resource: path,
			Remediation: "Check file permissions and retry.", Detail: err.Error(),
		}
	}
	var data map[string]any
	if err := json.Unmarshal(blob, &data); err != nil {
		return nil, &clierr.Error{
			Category: clierr.Validation, Message: "The JSON file is malformed.",
			Operation: operation, Resource: path,
			Remediation: "Repair or remove the file, then retry.", Detail: err.Error(),
		}
	}
	return data, nil
}

// LoadPersisted returns only on-disk values, without environment overrides.
func LoadPersisted() (map[string]any, *clierr.Error) {
	if _, err := os.Stat(File()); err != nil {
		return map[string]any{}, nil
	}
	stored, cerr := readObject(File(), "Load CLI configuration")
	if cerr != nil {
		return nil, cerr
	}
	delete(stored, "output")
	delete(stored, "color")
	return stored, nil
}

// resolveSecret reads NAME or NAME_FILE, rejecting conflicting definitions.
func resolveSecret(name string) (string, error) {
	direct, hasDirect := os.LookupEnv(name)
	filePath, hasFile := os.LookupEnv(name + "_FILE")
	if hasDirect && hasFile && direct != "" && filePath != "" {
		return "", fmt.Errorf("both %s and %s_FILE are set", name, name)
	}
	if direct != "" {
		return direct, nil
	}
	if filePath != "" {
		blob, err := os.ReadFile(filePath)
		if err != nil {
			return "", fmt.Errorf("cannot read %s_FILE: %w", name, err)
		}
		return strings.TrimSpace(string(blob)), nil
	}
	return "", nil
}

// Load returns disk values merged over defaults with environment overrides.
func Load() (map[string]any, *clierr.Error) {
	persisted, cerr := LoadPersisted()
	if cerr != nil {
		return nil, cerr
	}
	cfg := make(map[string]any, len(Defaults)+len(persisted))
	for key, value := range Defaults {
		cfg[key] = value
	}
	for key, value := range persisted {
		cfg[key] = value
	}
	if url := os.Getenv("CARACAL_SERVER_URL"); url != "" {
		cfg["server_url"] = url
	}
	for _, name := range []string{"CARACAL_ACCESS_TOKEN", "CARACAL_TOKEN"} {
		token, err := resolveSecret(name)
		if err != nil {
			return nil, &clierr.Error{
				Category: clierr.Validation, Message: name + " is configured incorrectly.",
				Operation: "Load CLI configuration", Resource: name,
				Remediation: fmt.Sprintf("Set only %s or %s_FILE, then retry.", name, name),
				Detail:      err.Error(),
			}
		}
		if token != "" {
			cfg["access_token"] = token
		}
	}
	return cfg, nil
}

// writeJSON writes atomically with owner-only permissions.
func writeJSON(path string, data map[string]any) *clierr.Error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return writeError(path, err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".")
	if err != nil {
		return writeError(path, err)
	}
	defer os.Remove(tmp.Name())
	// No trailing newline, matching the file format shared across installs.
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(data); err != nil {
		_ = tmp.Close()
		return writeError(path, err)
	}
	if _, err := tmp.Write(bytes.TrimRight(buf.Bytes(), "\n")); err != nil {
		_ = tmp.Close()
		return writeError(path, err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return writeError(path, err)
	}
	_ = tmp.Close()
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return writeError(path, err)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return writeError(path, err)
	}
	return nil
}

func writeError(path string, err error) *clierr.Error {
	category := clierr.Unexpected
	remediation := "Check file permissions and retry."
	if os.IsPermission(err) {
		category = clierr.Permission
		remediation = fmt.Sprintf(`If %s is owned by root, run: sudo chown -R "$USER" "%s"`, Dir(), Dir())
	}
	return &clierr.Error{
		Category: category, Message: fmt.Sprintf("Cannot write %s: %v.", path, err),
		Operation: "Save CLI configuration", Resource: path,
		Remediation: remediation, Detail: err.Error(),
	}
}

// Save merges the given values into the persisted config.
func Save(values map[string]any) *clierr.Error {
	persisted, cerr := LoadPersisted()
	if cerr != nil {
		return cerr
	}
	for key, value := range values {
		persisted[key] = value
	}
	return writeJSON(File(), persisted)
}

// Remove deletes keys from the persisted config.
func Remove(keys ...string) *clierr.Error {
	persisted, cerr := LoadPersisted()
	if cerr != nil {
		return cerr
	}
	for _, key := range keys {
		delete(persisted, key)
	}
	return writeJSON(File(), persisted)
}

// Timeout returns the effective request timeout in seconds.
func Timeout(cfg map[string]any) int {
	switch v := cfg["timeout"].(type) {
	case int:
		if v > 0 {
			return v
		}
	case float64:
		if v > 0 {
			return int(v)
		}
	}
	return 30
}

// Str reads a string value with an empty-string fallback.
func Str(cfg map[string]any, key string) string {
	s, _ := cfg[key].(string)
	return s
}
