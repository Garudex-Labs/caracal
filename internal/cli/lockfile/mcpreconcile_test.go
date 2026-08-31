// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package lockfile

import "testing"

// A re-pull of the same agent that drops one MCP marks only the dropped
// server stale; a still-written server is never touched.
func TestUpsertAgentWithReconcileMcpDrop(t *testing.T) {
	setupHome(t)
	dir := "/tmp/mcp-projx"
	if _, _, _, stale, err := UpsertAgentWithReconcile("cursor", Entry{
		Name: "bot", ID: "agent-1", Scope: "project", Directory: dir,
		ManagedMcps: []string{"foo", "bar"}, ManagedMcpPath: ".cursor/mcp.json", ManagedMcpKey: "mcpServers",
	}); err != nil || len(stale) != 0 {
		t.Fatalf("first install: stale=%v err=%v", stale, err)
	}
	_, absPath, key, stale, err := UpsertAgentWithReconcile("cursor", Entry{
		Name: "bot", ID: "agent-1", Scope: "project", Directory: dir,
		ManagedMcps: []string{"foo"}, ManagedMcpPath: ".cursor/mcp.json", ManagedMcpKey: "mcpServers",
	})
	if err != nil {
		t.Fatal(err)
	}
	if key != "mcpServers" {
		t.Errorf("key = %q, want mcpServers", key)
	}
	if len(stale) != 1 || stale[0] != "bar" {
		t.Errorf("stale = %v, want [bar]", stale)
	}
	if absPath != dir+"/.cursor/mcp.json" {
		t.Errorf("absPath = %q", absPath)
	}
}

// Dropping every MCP still resolves the prior config path and key, so a fully
// stripped agent is cleaned up even though the new install writes no MCP file.
func TestUpsertAgentWithReconcileMcpDropAll(t *testing.T) {
	setupHome(t)
	dir := "/tmp/mcp-projz"
	if _, _, _, _, err := UpsertAgentWithReconcile("kiro", Entry{
		Name: "bot", ID: "agent-1", Scope: "project", Directory: dir,
		ManagedMcps: []string{"only"}, ManagedMcpPath: ".kiro/settings/mcp.json", ManagedMcpKey: "mcpServers",
	}); err != nil {
		t.Fatal(err)
	}
	_, absPath, key, stale, err := UpsertAgentWithReconcile("kiro", Entry{
		Name: "bot", ID: "agent-1", Scope: "project", Directory: dir,
	})
	if err != nil {
		t.Fatal(err)
	}
	if key != "mcpServers" || absPath != dir+"/.kiro/settings/mcp.json" {
		t.Errorf("path/key = %q %q", absPath, key)
	}
	if len(stale) != 1 || stale[0] != "only" {
		t.Errorf("stale = %v, want [only]", stale)
	}
}

// A server another install still claims in the same config file is never
// marked stale, even after this agent drops it.
func TestStaleManagedMcpsRespectsOtherInstalls(t *testing.T) {
	setupHome(t)
	dir := "/tmp/mcp-shared"
	if _, _, _, _, err := UpsertAgentWithReconcile("cursor", Entry{
		Name: "b2", ID: "agent-2", Scope: "project", Directory: dir,
		ManagedMcps: []string{"shared"}, ManagedMcpPath: ".cursor/mcp.json", ManagedMcpKey: "mcpServers",
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, _, err := UpsertAgentWithReconcile("cursor", Entry{
		Name: "b1", ID: "agent-1", Scope: "project", Directory: dir,
		ManagedMcps: []string{"shared", "solo"}, ManagedMcpPath: ".cursor/mcp.json", ManagedMcpKey: "mcpServers",
	}); err != nil {
		t.Fatal(err)
	}
	_, _, _, stale, err := UpsertAgentWithReconcile("cursor", Entry{
		Name: "b1", ID: "agent-1", Scope: "project", Directory: dir,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(stale) != 1 || stale[0] != "solo" {
		t.Errorf("stale = %v, want [solo] (shared is still claimed by agent-2)", stale)
	}
}
