// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package harness provides typed access to the canonical harness registry.
//
// The registry data lives in packages/harness-data/registry.json, the single
// source of truth for harness metadata across all Caracal components; this
// package is its Go loader.
package harness

import (
	"encoding/json"
	"fmt"

	harnessdata "github.com/garudex-labs/caracal/packages/harness-data"
)

// Capability is a per-harness feature switch controlling which operations
// adapters may perform.
type Capability string

const (
	CapHooks      Capability = "hooks"
	CapMCPServers Capability = "mcp_servers"
	CapSkills     Capability = "skills"
	CapPrompts    Capability = "prompts"
)

// Spec describes one harness. Paths use "~/" for the user home directory and
// "{name}" as the component-name placeholder, exactly as in registry.json.
type Spec struct {
	Name               string            `json:"-"`
	DisplayName        string            `json:"display_name"`
	Capabilities       []Capability      `json:"capabilities"`
	SessionParser      string            `json:"session_parser"`
	Scopes             []string          `json:"scopes"`
	DefaultScope       string            `json:"default_scope"`
	ScopeLabels        []string          `json:"scope_labels"`
	AgentProfile       map[string]string `json:"agent_profile"`
	AgentProfileFormat string            `json:"agent_profile_format"`
	MCPConfig          map[string]string `json:"mcp_config"`
	MCPServersKey      string            `json:"mcp_servers_key"`
	HomeMCPConfig      string            `json:"home_mcp_config"`
	Skills             map[string]string `json:"skills"`
	SkillFormat        string            `json:"skill_format"`
	HookType           string            `json:"hook_type"`
	Hooks              map[string]string `json:"hooks"`
	HookScriptsDir     string            `json:"hook_scripts_dir"`
	HookEventsMap      map[string]string `json:"hook_events_map"`
	ConfigDir          string            `json:"config_dir"`
	GuidanceFiles      []string          `json:"guidance_files"`
}

// HasCapability reports whether the harness supports the given capability.
func (s *Spec) HasCapability(c Capability) bool {
	for _, have := range s.Capabilities {
		if have == c {
			return true
		}
	}
	return false
}

// Registry holds all known harnesses in their canonical declaration order.
type Registry struct {
	names []string
	specs map[string]*Spec
}

// Load parses the embedded registry data. It is intended to be called once at
// startup; the result is immutable by convention.
func Load() (*Registry, error) {
	var file struct {
		Harnesses map[string]json.RawMessage `json:"harnesses"`
	}
	if err := json.Unmarshal(harnessdata.RegistryJSON, &file); err != nil {
		return nil, fmt.Errorf("parse harness registry: %w", err)
	}
	// A second ordered pass keeps canonical declaration order, which the CLI
	// uses for display and the API for stable output.
	names, err := orderedKeys(harnessdata.RegistryJSON)
	if err != nil {
		return nil, err
	}
	specs := make(map[string]*Spec, len(file.Harnesses))
	for name, raw := range file.Harnesses {
		spec := &Spec{Name: name}
		if err := json.Unmarshal(raw, spec); err != nil {
			return nil, fmt.Errorf("parse harness %q: %w", name, err)
		}
		specs[name] = spec
	}
	if len(names) != len(specs) {
		return nil, fmt.Errorf("harness registry key mismatch: %d ordered vs %d parsed", len(names), len(specs))
	}
	return &Registry{names: names, specs: specs}, nil
}

// MustLoad is Load for program initialization paths where the embedded data
// being unparsable is a build defect, not a runtime condition.
func MustLoad() *Registry {
	r, err := Load()
	if err != nil {
		panic(err)
	}
	return r
}

// Names returns harness names in canonical declaration order.
func (r *Registry) Names() []string {
	out := make([]string, len(r.names))
	copy(out, r.names)
	return out
}

// Spec returns the spec for name, or false when the harness is unknown.
func (r *Registry) Spec(name string) (*Spec, bool) {
	s, ok := r.specs[name]
	return s, ok
}

// SessionParserID returns the parser identifier for a harness. Unknown
// harnesses are an error: ingest must never guess a parser.
func (r *Registry) SessionParserID(name string) (string, error) {
	s, ok := r.specs[name]
	if !ok {
		return "", fmt.Errorf("unknown harness %q", name)
	}
	if s.SessionParser == "" {
		return "", fmt.Errorf("harness %q has no session parser", name)
	}
	return s.SessionParser, nil
}

// orderedKeys extracts top-level "harnesses" object keys in document order,
// which encoding/json maps do not preserve.
func orderedKeys(data []byte) ([]string, error) {
	dec := json.NewDecoder(newReader(data))
	// Walk: { "harnesses" : { <keys...> } }
	if err := expectDelim(dec, '{'); err != nil {
		return nil, err
	}
	var names []string
	for dec.More() {
		key, err := stringToken(dec)
		if err != nil {
			return nil, err
		}
		if key != "harnesses" {
			if err := skipValue(dec); err != nil {
				return nil, err
			}
			continue
		}
		if err := expectDelim(dec, '{'); err != nil {
			return nil, err
		}
		for dec.More() {
			name, err := stringToken(dec)
			if err != nil {
				return nil, err
			}
			names = append(names, name)
			if err := skipValue(dec); err != nil {
				return nil, err
			}
		}
	}
	return names, nil
}
