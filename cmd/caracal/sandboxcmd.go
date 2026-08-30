// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/garudex-labs/caracal/internal/cli/sandbox"
)

// sandboxCommand hosts the runtime entrypoints that generated agent
// configs invoke: the MCP server and the one-shot runner.
func sandboxCommand() *cobra.Command {
	group := &cobra.Command{Use: "sandbox", Hidden: true, Short: "Sandbox runtime entrypoints"}

	mcp := &cobra.Command{Use: "mcp", Short: "Serve registered sandboxes as MCP tools over stdio", Args: cobra.NoArgs}
	sandboxesJSON := mcp.Flags().String("sandboxes", "", "JSON array of sandbox specs")
	_ = mcp.MarkFlagRequired("sandboxes")
	mcp.RunE = func(_ *cobra.Command, _ []string) error {
		var specs []sandbox.Spec
		if err := json.Unmarshal([]byte(*sandboxesJSON), &specs); err != nil {
			return fmt.Errorf("invalid --sandboxes JSON: %w", err)
		}
		return sandbox.ServeMCP(specs, os.Stdin, os.Stdout)
	}
	group.AddCommand(mcp)

	run := &cobra.Command{Use: "run", Short: "Run one command in a registered sandbox", Args: cobra.ArbitraryArgs}
	sandboxID := run.Flags().String("sandbox-id", "", "Sandbox listing id")
	image := run.Flags().String("image", "", "Container image or module")
	runtimeType := run.Flags().String("runtime-type", "docker", "docker|lxc|firecracker|wasm")
	command := run.Flags().String("command", "", "Command to run inside the sandbox")
	timeout := run.Flags().Int("timeout", 300, "Timeout in seconds")
	networkPolicy := run.Flags().String("network-policy", "none", "none|restricted|bridge|host")
	resourceLimits := run.Flags().String("resource-limits", "", "JSON resource limits")
	runtimeConfig := run.Flags().String("runtime-config", "", "JSON runtime config")
	envPairs := run.Flags().StringArray("env", nil, "KEY=VALUE environment entries")
	run.RunE = func(cmd *cobra.Command, args []string) error {
		spec := sandbox.RunSpec{
			SandboxID: *sandboxID, Image: *image, Command: *command,
			RuntimeType: *runtimeType, NetworkPolicy: *networkPolicy, Timeout: *timeout,
		}
		if len(args) > 0 {
			// Everything after `--` is the sandbox command.
			joined := ""
			for i, a := range args {
				if i > 0 {
					joined += " "
				}
				joined += a
			}
			spec.Command = joined
		}
		if *resourceLimits != "" {
			if err := json.Unmarshal([]byte(*resourceLimits), &spec.ResourceLimits); err != nil {
				return fmt.Errorf("invalid --resource-limits JSON: %w", err)
			}
		}
		if *runtimeConfig != "" {
			if err := json.Unmarshal([]byte(*runtimeConfig), &spec.RuntimeConfig); err != nil {
				return fmt.Errorf("invalid --runtime-config JSON: %w", err)
			}
		}
		if len(*envPairs) > 0 {
			spec.Env = map[string]string{}
			for _, pair := range *envPairs {
				key, value, _ := cutEnvPair(pair)
				spec.Env[key] = value
			}
		}
		needsImage := spec.RuntimeType == "docker" || spec.RuntimeType == "lxc" || spec.RuntimeType == "wasm"
		module, _ := spec.RuntimeConfig["module"].(string)
		if spec.Image == "" && needsImage && module == "" {
			fmt.Fprintln(os.Stderr,
				"Usage: caracal sandbox run --sandbox-id <id> --image <image> [--runtime-type docker|lxc|firecracker|wasm] [--command <cmd>] [--timeout <s>]")
			os.Exit(1)
		}
		result := sandbox.Run(spec)
		if result.ExitCode == 127 || result.ExitCode == 2 {
			fmt.Fprintln(os.Stderr, result.Output)
		} else {
			fmt.Print(result.Output)
		}
		os.Exit(result.ExitCode)
		return nil
	}
	group.AddCommand(run)
	return group
}

func cutEnvPair(pair string) (string, string, bool) {
	for i := 0; i < len(pair); i++ {
		if pair[i] == '=' {
			value := pair[i+1:]
			// Match the incumbent's tolerance for quoted values.
			value = trimQuotes(value)
			return pair[:i], value, true
		}
	}
	return pair, "", false
}

func trimQuotes(s string) string {
	for len(s) > 0 && (s[0] == '"' || s[0] == '\'') {
		s = s[1:]
	}
	for len(s) > 0 && (s[len(s)-1] == '"' || s[len(s)-1] == '\'') {
		s = s[:len(s)-1]
	}
	return s
}
