// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

// pullableTypes is the probing order for untyped references: agents are
// the primary workflow, then standalone component families.
var pullableTypes = []string{"agent", "mcp", "skill", "hook", "prompt"}

// resolvePullType finds which registry family knows the reference.
func resolvePullType(target string) (string, *clierr.Error) {
	client, cerr := newClient()
	if cerr != nil {
		return "", cerr
	}
	for _, itemType := range pullableTypes {
		params := map[string]string{"type": itemType, "identifier": target}
		if _, cerr := client.Do("GET", "/api/v1/registry/resolve", params, nil,
			"Resolve pull target", itemType+" "+target); cerr == nil {
			return itemType, nil
		} else if cerr.Category != clierr.NotFound {
			return "", cerr
		}
	}
	return "", &clierr.Error{
		Category: clierr.NotFound, Message: "No agent or component matches: " + target + ".",
		Operation: "Resolve pull target", Resource: target,
		Remediation: "Check the name with caracal agent list or caracal registry <type> list, or pass --type.",
	}
}

// runPassthrough executes one CLI invocation in-process with the caller's
// terminal attached, so interactive prompts and progress remain visible.
func runPassthrough(args []string) error {
	root := newRootCommand()
	root.SetArgs(args)
	root.SetOut(os.Stdout)
	root.SetErr(os.Stderr)
	return root.Execute()
}

// pullTopCommand is the uniform materialization verb: one reference, any
// resource type, dispatched onto the same machinery as the typed commands.
func pullTopCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "pull TARGET",
		Short: "Materialize an agent or component into your harness",
		Long: "Resolves TARGET across agents and component families, then installs\n" +
			"it through the same path as the dedicated commands: an agent pulls its\n" +
			"whole dependency tree; a single component installs alone. Pass --type\n" +
			"to skip detection.",
		Args: cobra.ExactArgs(1),
	}
	itemType := cmd.Flags().String("type", "", "agent, mcp, skill, hook, or prompt (detected when omitted)")
	harness := cmd.Flags().String("harness", "", "Target harness")
	noPrompt := cmd.Flags().Bool("no-prompt", false, "Never prompt; skip optional inputs")
	mode := outputFlag(cmd)
	cmd.RunE = func(_ *cobra.Command, args []string) error {
		target := strings.TrimSpace(args[0])
		selected := strings.ToLower(strings.TrimSpace(*itemType))
		if selected == "" {
			resolved, cerr := resolvePullType(target)
			if cerr != nil {
				return cerr
			}
			selected = resolved
		} else if !contains(pullableTypes, selected) {
			return &clierr.Error{
				Category: clierr.Validation, Message: "Unknown pull type: " + selected + ".",
				Operation: "Materialize resource", Resource: "pull type",
				Remediation: "Choose from: " + strings.Join(pullableTypes, ", ") + ".",
			}
		}
		var dispatch []string
		if selected == "agent" {
			dispatch = []string{"agent", "pull", target}
		} else {
			dispatch = []string{"registry", selected, "install", target}
		}
		if *harness != "" {
			dispatch = append(dispatch, "--harness", *harness)
		}
		if *noPrompt {
			dispatch = append(dispatch, "--no-prompt")
		}
		if *mode == "json" {
			dispatch = append(dispatch, "--output", "json")
		}
		return runPassthrough(dispatch)
	}
	return cmd
}
