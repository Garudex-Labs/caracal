// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Canonical command catalog mirror for Go services that expose Caracal's allowlisted command surface.

package commands

type Group string

const (
	GroupShell         Group = "shell"
	GroupStack         Group = "stack"
	GroupRuntime       Group = "runtime"
	GroupAdmin         Group = "admin"
	GroupObservability Group = "observability"
	GroupMultiagent    Group = "multiagent"
	GroupControl       Group = "control"
)

type Descriptor struct {
	Name           string
	Group          Group
	Summary        string
	Subcommands    []string
	RequiresConfig bool
	RequiresZone   bool
	Hidden         bool
}

// CLI mirrors apps/cli/src/registry order; parity is enforced by tests/typescript/scripts/catalog-parity.test.ts.
var CLI = []Descriptor{
	{Name: "run", Group: GroupRuntime, Summary: "Run a command with RESOURCE_TOKEN injected into env", RequiresConfig: true},
	{Name: "credential", Group: GroupRuntime, Summary: "Print the resolved credential for a resource", Subcommands: []string{"read"}, RequiresConfig: true},

	{Name: "zone", Group: GroupAdmin, Summary: "list|get|create|patch|delete", Subcommands: []string{"list", "get", "create", "patch", "delete"}},
	{Name: "app", Group: GroupAdmin, Summary: "list|get|create|patch|delete|dcr", Subcommands: []string{"list", "get", "create", "patch", "delete", "dcr"}},
	{Name: "resource", Group: GroupAdmin, Summary: "list|get|create|patch|delete", Subcommands: []string{"list", "get", "create", "patch", "delete"}, RequiresZone: true},
	{Name: "provider", Group: GroupAdmin, Summary: "list|get|create|patch|delete", Subcommands: []string{"list", "get", "create", "patch", "delete"}, RequiresZone: true},
	{Name: "policy", Group: GroupAdmin, Summary: "list|get|create|version|delete", Subcommands: []string{"list", "get", "create", "version", "delete"}, RequiresZone: true},
	{Name: "policy-set", Group: GroupAdmin, Summary: "list|get|create|version|activate|delete", Subcommands: []string{"list", "get", "create", "version", "activate", "delete"}, RequiresZone: true},
	{Name: "grant", Group: GroupAdmin, Summary: "list|get|create|revoke", Subcommands: []string{"list", "get", "create", "revoke", "delete"}, RequiresZone: true},
	{Name: "session", Group: GroupAdmin, Summary: "list", Subcommands: []string{"list"}, RequiresZone: true},

	{Name: "audit", Group: GroupObservability, Summary: "tail [--decision …] [--request-id …] [--since …] [--limit N]", Subcommands: []string{"tail"}, RequiresZone: true},
	{Name: "explain", Group: GroupObservability, Summary: "Show audit row + determining policies + diagnostics", RequiresZone: true},

	{Name: "agent", Group: GroupMultiagent, Summary: "list|get|tree|suspend|resume|terminate", Subcommands: []string{"list", "get", "tree", "children", "suspend", "resume", "terminate"}, RequiresZone: true},
	{Name: "delegation", Group: GroupMultiagent, Summary: "inbound|outbound|traverse|revoke", Subcommands: []string{"inbound", "outbound", "traverse", "revoke"}, RequiresZone: true},

	{Name: "control", Group: GroupControl, Summary: "token|revoke", Subcommands: []string{"token", "revoke"}},
	{Name: "completion", Group: GroupShell, Summary: "Emit shell completion script (bash|zsh|fish|powershell)", Subcommands: []string{"bash", "zsh", "fish", "powershell"}, Hidden: true},
}

// ByName returns the descriptor for name or nil if unknown / hidden.
func ByName(name string) *Descriptor {
	for i := range CLI {
		if CLI[i].Name == name {
			if CLI[i].Hidden {
				return nil
			}
			return &CLI[i]
		}
	}
	return nil
}

// HasSubcommand reports whether sub is allowed for the named command. If the command takes no subcommands, only sub == "" returns true.
func HasSubcommand(name, sub string) bool {
	d := ByName(name)
	if d == nil {
		return false
	}
	if len(d.Subcommands) == 0 {
		return sub == ""
	}
	for _, s := range d.Subcommands {
		if s == sub {
			return true
		}
	}
	return false
}
