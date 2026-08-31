// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package harnessgen

import "testing"

func TestValidateMcpCommand(t *testing.T) {
	// A remote MCP carries no command and is always accepted.
	if err := ValidateMcpCommand("", nil); err != nil {
		t.Fatalf("empty command: %v", err)
	}

	// Legitimate launchers pass, including interpreter-based registry MCPs and
	// bare $VAR placeholders used for env substitution.
	for _, tc := range []struct {
		cmd  string
		args []string
	}{
		{"npx", []string{"-y", "@modelcontextprotocol/server-github"}},
		{"uvx", []string{"mcp-server-fetch"}},
		{"python", []string{"-m", "my_server"}},
		{"docker", []string{"run", "-i", "--rm", "img"}},
		{"node", []string{"server.js", "$API_KEY"}},
	} {
		if err := ValidateMcpCommand(tc.cmd, tc.args); err != nil {
			t.Errorf("ValidateMcpCommand(%q, %v) rejected a legit command: %v", tc.cmd, tc.args, err)
		}
	}

	// Shell metacharacters and command/parameter expansion are refused whether
	// they appear in the command or any argument.
	for _, tc := range []struct {
		name string
		cmd  string
		args []string
	}{
		{"pipe", "sh", []string{"-c", "a|b"}},
		{"semicolon", "npx", []string{"x; rm -rf ~"}},
		{"ampersand", "npx", []string{"x", "&"}},
		{"command substitution", "node", []string{"$(whoami)"}},
		{"brace expansion", "node", []string{"${SECRET}"}},
		{"redirect", "npx", []string{"x", ">", "/etc/passwd"}},
		{"backtick", "npx", []string{"`id`"}},
	} {
		if err := ValidateMcpCommand(tc.cmd, tc.args); err == nil {
			t.Errorf("%s: expected rejection for %q %v", tc.name, tc.cmd, tc.args)
		}
	}
}
