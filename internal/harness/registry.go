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
	"strings"

	harnessdata "github.com/garudex-labs/caracal/packages/harness-data"
)

// Capability is a per-harness feature switch controlling which operations
// adapters may perform.
type Capability string

const (
	CapHooks      Capability = "hooks"
	CapMCPServers Capability = "mcp_servers"
	CapSkills     Capability = "skills"
)

// PromptMaterialization is the single source of truth for how a harness
// consumes a registry Prompt component. It replaces the former split between a
// declarative capability flag and hardcoded adapter behavior.
type PromptMaterialization string

const (
	// PromptNative writes a first-class, independently invocable prompt file in
	// the harness's documented native prompt/command location.
	PromptNative PromptMaterialization = "native"
	// PromptEmbedded folds the prompt text into the agent's instructions/rules;
	// the harness consumes it as agent context, not as a distinct prompt.
	PromptEmbedded PromptMaterialization = "embedded"
	// PromptUnsupported means the harness cannot consume the prompt; the
	// generator reports it rather than silently dropping the content.
	PromptUnsupported PromptMaterialization = "unsupported"
)

// PromptSpec declares a harness's prompt materialization mode and, for native
// harnesses, the per-scope on-disk location ("{name}" is the resource name).
type PromptSpec struct {
	Mode   PromptMaterialization `json:"mode"`
	Path   map[string]string     `json:"path"`
	Format string                `json:"format"`
}

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
	// SkillSupport is the evidence-based support level for materializing a
	// Caracal Skill on this harness: "native" (documented first-class Agent
	// Skill), "compatible" (a valid equivalent native mechanism), or
	// "unsupported".
	SkillSupport string `json:"skill_support"`
	// SkillMechanism names the harness's native concept a Caracal Skill maps to,
	// e.g. "agent_skill" (SKILL.md, agentskills.io), "cursor_rule", or
	// "codex_prompt". Only "agent_skill" harnesses consume a SKILL.md file.
	SkillMechanism string `json:"skill_mechanism"`
	// HookSupport is the evidence-based support level for materializing a
	// Caracal Registry Hook on this harness: "native" (documented first-class
	// hook config), "compatible" (a valid equivalent native mechanism such as a
	// plugin), or "unsupported". It is independent of telemetry/session-push
	// hooks, which every harness receives through doctor patch.
	HookSupport string `json:"hook_support"`
	// HookMechanism names the harness's native representation a Registry Hook
	// maps to, e.g. "command_json", "settings_json", "agent_profile_json", or
	// "plugin". Empty for unsupported harnesses.
	HookMechanism string `json:"hook_mechanism"`
	// AgentSupport is the evidence-based support level for materializing a Caracal
	// Agent as a separately selectable native worker on this harness: "native" (a
	// documented first-class named agent/subagent the harness discovers and
	// selects), "compatible" (a valid but non-primary mechanism such as an
	// instruction/rule file the harness loads without listing it as a distinct
	// selectable agent), or "unsupported".
	AgentSupport string `json:"agent_support"`
	// AgentMechanism names the harness's native concept a Caracal Agent maps to,
	// e.g. "subagent_markdown", "vscode_custom_agent", "agent_json". Empty for
	// unsupported harnesses.
	AgentMechanism string `json:"agent_mechanism"`
	// AgentMulti reports whether the harness natively supports multiple distinct,
	// independently selectable agents in one workspace. When false, only a single
	// agent/instruction set is effectively active.
	AgentMulti     bool              `json:"agent_multi"`
	HookType       string            `json:"hook_type"`
	Hooks          map[string]string `json:"hooks"`
	HookScriptsDir string            `json:"hook_scripts_dir"`
	HookEventsMap  map[string]string `json:"hook_events_map"`
	ConfigDir      string            `json:"config_dir"`
	GuidanceFiles  []string          `json:"guidance_files"`
	Prompts        *PromptSpec       `json:"prompts"`
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

// EmitsSkillMd reports whether a Caracal Skill materializes for this harness as
// a native Agent Skill (SKILL.md, agentskills.io) it discovers and consumes.
// Harnesses whose skill-equivalent is a different native artifact (Cursor
// rules, Codex prompts) are not SKILL.md consumers and return false, so Caracal
// never writes them a file the harness ignores.
func (s *Spec) EmitsSkillMd() bool { return s.SkillMechanism == "agent_skill" }

// SupportsRegistryHooks reports whether a Caracal Registry Hook can be
// materialized for this harness through a documented native or compatible
// mechanism. It is the single gate the UI, CLI, installer, and agent-pull
// generator consult so a hook is never silently dropped or installed into a
// harness that cannot consume it. Harnesses whose only hook use is
// telemetry/session-push return false.
func (s *Spec) SupportsRegistryHooks() bool {
	return s.HookSupport == "native" || s.HookSupport == "compatible"
}

// SupportsAgents reports whether a Caracal Agent can be materialized for this
// harness through a documented native or compatible mechanism. It is the single
// gate the UI, CLI, installer, and agent-pull generator consult so an Agent is
// never installed into a harness that cannot consume it.
func (s *Spec) SupportsAgents() bool {
	return s.AgentSupport == "native" || s.AgentSupport == "compatible"
}

// IsMultiAgent reports whether the harness natively lists multiple distinct
// Caracal Agents as independently selectable workers in one workspace. When
// false, only one agent/instruction set is effectively active, so Caracal must
// not present the harness as coexisting multi-agent.
func (s *Spec) IsMultiAgent() bool { return s.AgentMulti }

// PromptMode reports how the harness materializes registry Prompt components.
// A harness with no declared prompt spec is treated as unsupported so a missing
// declaration can never silently drop prompt content.
func (s *Spec) PromptMode() PromptMaterialization {
	if s.Prompts == nil || s.Prompts.Mode == "" {
		return PromptUnsupported
	}
	return s.Prompts.Mode
}

// PromptSupport is the public support level for a Caracal Prompt on this
// harness: "native" (a documented first-class prompt/command the harness
// discovers and invokes), "compatible" (the prompt is embedded into the
// harness's agent instructions, not a distinct reusable prompt), or
// "unsupported". Embedding is never presented as native.
func (s *Spec) PromptSupport() string {
	switch s.PromptMode() {
	case PromptNative:
		return "native"
	case PromptEmbedded:
		return "compatible"
	default:
		return "unsupported"
	}
}

// PromptMechanism names the harness representation a Prompt maps to: the native
// prompt-file format for native harnesses, "agent_instructions" for compatible
// harnesses that embed the prompt text, and "" for unsupported.
func (s *Spec) PromptMechanism() string {
	switch s.PromptMode() {
	case PromptNative:
		if s.Prompts != nil && s.Prompts.Format != "" {
			return s.Prompts.Format
		}
		return "native_prompt"
	case PromptEmbedded:
		return "agent_instructions"
	default:
		return ""
	}
}

// SupportsRegistryPrompts is the single gate the UI, CLI, installer, and
// agent-pull generator consult so a Prompt is never silently dropped or
// installed into a harness that cannot consume it.
func (s *Spec) SupportsRegistryPrompts() bool {
	m := s.PromptMode()
	return m == PromptNative || m == PromptEmbedded
}

// PromptResolution is the deterministic native prompt location for the CLI's
// project-bound context. A workspace-scoped location is project-isolated; a
// user-level location is shared by every project that installs the prompt.
type PromptResolution struct {
	Path      string
	Scope     string
	Workspace bool
}

// ResolvePrompt returns the native prompt location, preferring a
// workspace-relative project path so switching projects yields separate state,
// and only falling back to a user-level location when the harness has no
// workspace mechanism. The bool is false for non-native harnesses.
func (s *Spec) ResolvePrompt() (PromptResolution, bool) {
	if s.Prompts == nil || s.Prompts.Mode != PromptNative {
		return PromptResolution{}, false
	}
	if p := s.Prompts.Path["project"]; p != "" && !strings.HasPrefix(p, "~/") {
		return PromptResolution{Path: p, Scope: "project", Workspace: true}, true
	}
	if p := s.Prompts.Path["user"]; p != "" {
		return PromptResolution{Path: p, Scope: "user", Workspace: false}, true
	}
	if p := s.Prompts.Path["project"]; p != "" {
		return PromptResolution{Path: p, Scope: "user", Workspace: false}, true
	}
	return PromptResolution{}, false
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
