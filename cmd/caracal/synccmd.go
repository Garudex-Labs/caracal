// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
	"github.com/garudex-labs/caracal/internal/cli/config"
)

// syncPlanItem is one action the sync engine decided on.
type syncPlanItem struct {
	item outdatedItem
	args []string
}

// syncArgs maps an outdated item onto the command that updates it, the
// same invocation `caracal outdated` prints for humans.
func syncArgs(item outdatedItem) []string {
	if item.Type == "agent" {
		return []string{"agent", "pull", item.QualifiedName, "--harness", item.Harness, "--no-prompt"}
	}
	args := []string{"registry", item.Type, "install", item.QualifiedName, "--harness", item.Harness}
	if item.Type == "mcp" {
		args = append(args, "--no-prompt")
	}
	return args
}

// runInternal executes one CLI invocation in-process, capturing its
// stdout so machine output of the parent command stays parseable.
func runInternal(args []string) (string, error) {
	previous := os.Stdout
	read, write, err := os.Pipe()
	if err != nil {
		return "", err
	}
	os.Stdout = write
	done := make(chan string, 1)
	go func() {
		blob, _ := io.ReadAll(read)
		done <- string(blob)
	}()
	root := newRootCommand()
	root.SetArgs(args)
	execErr := root.Execute()
	_ = write.Close()
	os.Stdout = previous
	captured := <-done
	_ = read.Close()
	return captured, execErr
}

// verifySyncContext validates the stored organization/project selection
// against the server so a revoked or stale context fails before anything
// is materialized locally.
func verifySyncContext(op string) (string, *clierr.Error) {
	cfg, cerr := config.Load()
	if cerr != nil {
		return "", cerr
	}
	org := config.Str(cfg, "default_org")
	project := config.Str(cfg, "default_project")
	if org == "" {
		return "", nil
	}
	client, cerr := newClient()
	if cerr != nil {
		return "", cerr
	}
	if _, cerr := client.Do("GET", "/api/v1/orgs/"+org, nil, nil, op, "organization "+org); cerr != nil {
		cerr.Remediation = "The stored organization is no longer accessible. Run caracal use to select a valid one, then retry."
		return "", cerr
	}
	scope := org
	if project != "" {
		if _, cerr := client.Do("GET", "/api/v1/orgs/"+org+"/projects/"+project, nil, nil, op, "project "+org+"/"+project); cerr != nil {
			cerr.Remediation = "The stored project is no longer accessible. Run caracal use to select a valid one, then retry."
			return "", cerr
		}
		scope = org + "/" + project
	}
	return scope, nil
}

func syncCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "sync",
		Short: "Bring local harness installs up to date with the registry",
		Long: "Verifies the selected organization/project context, compares every\n" +
			"installed agent and component against the registry, and applies the\n" +
			"pending updates through the same pull/install paths used manually.\n" +
			"Use --dry-run to see the plan without changing anything.",
		Args: cobra.NoArgs,
	}
	harness := cmd.Flags().String("harness", "", "Limit to one harness")
	dryRun := cmd.Flags().Bool("dry-run", false, "Show the plan without applying it")
	report := cmd.Flags().Bool("report", false, "File pending updates to your web inbox so they persist between runs")
	mode := outputFlag(cmd)
	cmd.RunE = func(_ *cobra.Command, _ []string) error {
		const op = "Sync local installs"
		jsonMode := *mode == "json"

		scope, cerr := verifySyncContext(op)
		if cerr != nil {
			return cerr
		}

		entries, cerr := loadOutdatedEntries(*harness)
		if cerr != nil {
			return cerr
		}
		entries = filterToActiveProject(entries)
		installed := make([]outdatedItem, 0, len(entries))
		for _, entry := range entries {
			item, cerr := prepareOutdatedEntry(entry)
			if cerr != nil {
				return cerr
			}
			installed = append(installed, item)
		}
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		results, cerr := checkOutdatedItems(client, installed, nil)
		if cerr != nil {
			return cerr
		}
		plan := make([]syncPlanItem, 0, len(results))
		outdatedOnly := make([]outdatedItem, 0, len(results))
		current := 0
		for _, item := range results {
			if item.Outdated {
				plan = append(plan, syncPlanItem{item: item, args: syncArgs(item)})
				outdatedOnly = append(outdatedOnly, item)
			} else {
				current++
			}
		}
		if *report && len(outdatedOnly) > 0 {
			_ = reportToInbox(client, outdatedOnly)
		}

		if *dryRun {
			return emitSyncResult(scope, plan, nil, current, true, jsonMode)
		}
		failures := map[string]string{}
		for _, planned := range plan {
			output, err := runInternal(planned.args)
			if err != nil {
				failures[planned.item.QualifiedName+"@"+planned.item.Harness] = err.Error()
				continue
			}
			if !jsonMode {
				fmt.Print(output)
			}
		}
		if err := emitSyncResult(scope, plan, failures, current, false, jsonMode); err != nil {
			return err
		}
		if len(failures) > 0 {
			return &clierr.Error{
				Category: clierr.Unavailable, Message: fmt.Sprintf("%d update(s) failed to apply.", len(failures)),
				Operation: op, Resource: "local installs",
				Remediation: "Re-run caracal sync; failed items are retried until they apply.",
			}
		}
		return nil
	}
	return cmd
}

// emitSyncResult reports the plan and outcome in the selected mode.
func emitSyncResult(scope string, plan []syncPlanItem, failures map[string]string, current int, dryRun, jsonMode bool) error {
	applied := make([]string, 0, len(plan))
	failed := make([]string, 0, len(failures))
	for _, planned := range plan {
		key := planned.item.QualifiedName + "@" + planned.item.Harness
		if reason, ok := failures[key]; ok {
			failed = append(failed, fmt.Sprintf(`{"target": %s, "error": %s}`, jsonString(key), jsonString(reason)))
			continue
		}
		applied = append(applied, fmt.Sprintf(`{"target": %s, "command": %s}`,
			jsonString(key), jsonString("caracal "+strings.Join(planned.args, " "))))
	}
	if jsonMode {
		doc := fmt.Sprintf(`{"context": %s, "dry_run": %t, "up_to_date": %d, "planned": %d, "applied": [%s], "failed": [%s]}`,
			jsonStringOrNull(scope), dryRun, current, len(plan), strings.Join(applied, ", "), strings.Join(failed, ", "))
		outputJSONRaw([]byte(doc))
		return nil
	}
	if scope != "" {
		fmt.Printf("Context: %s\n", scope)
	}
	if len(plan) == 0 {
		fmt.Printf("Everything is up to date (%d item(s) checked).\n", current)
		return nil
	}
	verb := "Applied"
	if dryRun {
		verb = "Would apply"
	}
	fmt.Printf("%s %d update(s); %d item(s) already current.\n", verb, len(plan)-len(failures), current)
	for _, planned := range plan {
		key := planned.item.QualifiedName + "@" + planned.item.Harness
		marker := "✓"
		if _, ok := failures[key]; ok {
			marker = "✗"
		} else if dryRun {
			marker = "→"
		}
		fmt.Printf("  %s %s %s -> %s\n", marker, key, planned.item.CurrentVersion, planned.item.LatestVersion)
	}
	return nil
}
