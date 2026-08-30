// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
	"github.com/garudex-labs/caracal/internal/cli/ref"
)

func agentCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "agent", Short: "Agent registry"}
	cmd.AddCommand(agentList(), agentShow(), agentVersions())
	cmd.AddCommand(agentInitCommand(), agentAddCommand(), agentBuildCommand(), agentPublishCommand(), agentReleaseCommand())
	cmd.AddCommand(pullCommand())
	return cmd
}

func agentList() *cobra.Command {
	cmd := &cobra.Command{Use: "list", Short: "List agents"}
	search := cmd.Flags().StringP("search", "s", "", "Search text")
	namespace := cmd.Flags().String("namespace", "", "Filter by namespace")
	interactive := cmd.Flags().BoolP("interactive", "i", false, "Interactive selection")
	limit := cmd.Flags().IntP("limit", "n", 50, "Page size")
	page := cmd.Flags().IntP("page", "p", 1, "Page number")
	cmd.Flags().Bool("id", false, "Show the ID column")
	cmd.Flags().Bool("full-id", false, "Show complete IDs")
	mode := outputFlag(cmd)
	cmd.RunE = func(_ *cobra.Command, _ []string) error {
		if *limit < 1 || *limit > 200 {
			return usageRangeError("agent list", "--limit", *limit, 1, 200)
		}
		if *page < 1 {
			return usageMinError("agent list", "--page", *page, 1)
		}
		if *interactive && *mode == "json" {
			return &clierr.Error{
				Category: clierr.Validation, Message: "Interactive selection cannot be combined with JSON output.",
				Operation: "List agents", Resource: "agent registry",
				Remediation: "Remove --interactive or use table output.",
			}
		}
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		params := map[string]string{
			"limit":  strconv.Itoa(*limit),
			"offset": strconv.Itoa((*page - 1) * *limit),
		}
		setIf(params, "search", *search)
		if *namespace != "" {
			params["namespace"] = strings.ToLower(strings.TrimPrefix(*namespace, "@"))
		}
		raw, headers, cerr := client.DoWithHeaders("GET", "/api/v1/agents", params, nil, "List agents", "agent registry")
		if cerr != nil {
			return cerr
		}
		items, cerr2 := decodeListItems(raw, "List agents", "agent registry")
		if cerr2 != nil {
			return cerr2
		}
		total := len(items)
		if v := headers.Get("X-Total-Count"); v != "" {
			if parsed, err := strconv.Atoi(v); err == nil {
				total = parsed
			}
		}
		_ = saveListCache(items, "agent")
		if *mode == "json" {
			var doc strings.Builder
			doc.WriteString(`{"items": [`)
			for i, item := range items {
				if i > 0 {
					doc.WriteString(", ")
				}
				doc.Write(item.raw)
			}
			fmt.Fprintf(&doc, `], "total": %d, "page": %d, "page_size": %d}`, total, *page, *limit)
			outputJSONRaw([]byte(doc.String()))
			return nil
		}
		if len(items) == 0 {
			if total > 0 {
				totalPages := (total + *limit - 1) / *limit
				fmt.Printf("Page %d is empty. Total agents: %d (last page: %d)\n", *page, total, totalPages)
			} else {
				fmt.Println("No agents found.")
			}
			return nil
		}
		for i, item := range items {
			fmt.Printf("%3d  %-32v %-10v %-20v %v\n", i+1, item.fields["name"], item.fields["version"], item.fields["model_name"], item.fields["namespace"])
		}
		return nil
	}
	return cmd
}

func agentShow() *cobra.Command {
	cmd := &cobra.Command{Use: "show NAME", Short: "Show one agent", Args: cobra.ExactArgs(1)}
	mode := outputFlag(cmd)
	cmd.RunE = func(_ *cobra.Command, args []string) error {
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		resolved, cerr := ref.ResolveRegistryReference(client, "agent", args[0], "Show agent", "agent registry")
		if cerr != nil {
			return cerr
		}
		raw, cerr := client.Do("GET", "/api/v1/agents/"+resolved, nil, nil, "Show agent", "agent registry")
		if cerr != nil {
			return cerr
		}
		if *mode == "json" {
			outputJSONRaw(raw)
			return nil
		}
		printDocumentSummary(raw)
		return nil
	}
	return cmd
}

func agentVersions() *cobra.Command {
	cmd := &cobra.Command{Use: "versions NAME", Short: "List agent versions", Args: cobra.ExactArgs(1)}
	page := cmd.Flags().IntP("page", "p", 1, "Page number")
	pageSize := cmd.Flags().Int("page-size", 50, "Page size")
	mode := outputFlag(cmd)
	cmd.RunE = func(_ *cobra.Command, args []string) error {
		if *page < 1 {
			return usageMinError("agent versions", "--page", *page, 1)
		}
		if *pageSize < 1 || *pageSize > 100 {
			return usageRangeError("agent versions", "--page-size", *pageSize, 1, 100)
		}
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		resolved, cerr := ref.ResolveRegistryReference(client, "agent", args[0], "List agent versions", "agent registry")
		if cerr != nil {
			return cerr
		}
		raw, cerr := client.Do("GET", "/api/v1/agents/"+resolved+"/versions",
			map[string]string{"page": strconv.Itoa(*page), "page_size": strconv.Itoa(*pageSize)},
			nil, "List agent versions", "agent registry")
		if cerr != nil {
			return cerr
		}
		if *mode == "json" {
			outputJSONRaw(raw)
			return nil
		}
		printDocumentSummary(raw)
		return nil
	}
	return cmd
}

func usageRangeError(command, flag string, value, min, max int) *clierr.Error {
	return &clierr.Error{
		Category:    clierr.Usage,
		Message:     fmt.Sprintf("Invalid value for '%s': %d is not in the range %d<=x<=%d.", flag, value, min, max),
		Operation:   "Run caracal " + command,
		Remediation: "Run caracal " + command + " --help for valid usage.",
	}
}

func usageMinError(command, flag string, value, min int) *clierr.Error {
	return &clierr.Error{
		Category:    clierr.Usage,
		Message:     fmt.Sprintf("Invalid value for '%s': %d is less than %d.", flag, value, min),
		Operation:   "Run caracal " + command,
		Remediation: "Run caracal " + command + " --help for valid usage.",
	}
}
