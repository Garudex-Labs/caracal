// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
	"github.com/garudex-labs/caracal/internal/cli/ref"
)

// readStdinConfig collects pasted JSON until a blank line after content.
func readStdinConfig() string {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	lines := []string{}
	hasContent := false
	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "" {
			if hasContent {
				break
			}
		} else {
			hasContent = true
			lines = append(lines, line)
		}
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

func parseStdinJSON(rawText string, operation string) (*omap, *clierr.Error) {
	if rawText == "" {
		return nil, &clierr.Error{
			Category: clierr.Validation, Message: "No MCP configuration was provided.",
			Operation: operation, Resource: "standard input",
			Remediation: "Pipe or paste an MCP JSON configuration and retry.",
		}
	}
	value, err := decodeOrderedJSON([]byte(rawText))
	if err != nil {
		stripped := strings.Join(strings.Fields(rawText), "")
		value, err = decodeOrderedJSON([]byte(stripped))
		if err != nil {
			return nil, &clierr.Error{
				Category: clierr.Validation, Message: "The MCP configuration is not valid JSON.",
				Operation: operation, Resource: "standard input",
				Remediation: "Correct the JSON and retry.", Detail: err.Error(),
			}
		}
	}
	cfg, ok := value.(*omap)
	if !ok {
		return nil, &clierr.Error{
			Category: clierr.Validation, Message: "The MCP configuration is not valid JSON.",
			Operation: operation, Resource: "standard input",
			Remediation: "Correct the JSON and retry.",
		}
	}
	return cfg, nil
}

func mcpSubmitCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "submit", Short: "Submit an MCP server to the registry", Args: cobra.NoArgs}
	gitURL := cmd.Flags().StringP("git", "g", "", "Git repository URL")
	name := cmd.Flags().StringP("name", "n", "", "Server name")
	category := cmd.Flags().StringP("category", "c", "", "Category")
	yes := cmd.Flags().BoolP("yes", "y", false, "Accept defaults without prompting")
	configFlag := cmd.Flags().String("config", "", "Deprecated")
	_ = cmd.Flags().MarkHidden("config")
	draft := cmd.Flags().Bool("draft", false, "Save as a draft instead of submitting")
	submitDraft := cmd.Flags().String("submit", "", "Submit a draft for review (MCP ID)")
	visibility := cmd.Flags().String("visibility", "", "Visibility: project or private")
	mode := outputFlag(cmd)
	cmd.RunE = func(c *cobra.Command, _ []string) error {
		_ = configFlag
		if *draft && *submitDraft != "" {
			return draftSubmitConflict("Submit MCP server")
		}
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		if *submitDraft != "" {
			return submitDraftReference(client, "mcp", "mcps", *submitDraft, "", "MCP registry", *mode)
		}
		if *mode == "json" && !*yes {
			return &clierr.Error{
				Category: clierr.Validation, Message: "JSON mode requires non-interactive submission.",
				Operation: "Submit MCP server", Resource: "submit options",
				Remediation: "Pass the defaults-acceptance option and provide MCP JSON on standard input.",
			}
		}
		if *mode != "json" {
			fmt.Println("Paste your MCP server JSON config below.")
			fmt.Println("Press Enter on an empty line when done.")
			fmt.Println()
		}
		cfg, cerr := parseStdinJSON(readStdinConfig(), "Submit MCP server")
		if cerr != nil {
			return cerr
		}
		parsed := parseDirectConfig(cfg)
		serverName := *name
		if serverName == "" {
			serverName = parsed.str("_server_name")
		}
		if serverName == "" {
			serverName = "my-mcp-server"
		}
		parsedDesc := parsed.str("_description")
		if !*yes {
			if !confirm("Submit this config?") {
				return abortErr("Submit MCP server")
			}
			if *name == "" {
				serverName = textInput("Server name", serverName)
			}
			desc := textInput("Description (what does this server do?)", parsedDesc)
			for strings.TrimSpace(desc) == "" {
				desc = textInput("Description (what does this server do?)", "")
			}
			parsedDesc = strings.TrimSpace(desc)
		} else if parsedDesc == "" {
			parsedDesc = serverName
		}
		categoryValue := *category
		if categoryValue == "" {
			categoryValue = "general"
		}
		payload := newOmap()
		payload.set("name", serverName)
		payload.set("version", "0.1.0")
		payload.set("category", categoryValue)
		payload.set("description", parsedDesc)
		payload.set("owner", configUsername())
		harnessList := make([]any, len(validHarnesses))
		for i, h := range validHarnesses {
			harnessList[i] = h
		}
		payload.set("supported_harnesses", harnessList)
		envVars, _ := parsed.get("environment_variables").([]any)
		if envVars == nil {
			envVars = []any{}
		}
		payload.set("environment_variables", envVars)
		if *gitURL != "" {
			payload.set("git_url", *gitURL)
		}
		for _, key := range []string{"command", "args", "url", "headers", "auto_approve", "transport", "framework", "docker_image"} {
			value := parsed.get(key)
			if key == "args" {
				if value != nil {
					payload.set("args", value)
				}
				continue
			}
			if truthy(value) {
				payload.set(key, value)
			}
		}
		pmap := map[string]any{}
		if cerr := addPublishTarget(pmap, *visibility, "registry mcp submit"); cerr != nil {
			return cerr
		}
		applyPublishTarget(payload, pmap)
		endpoint := "/api/v1/mcps/submit"
		if *draft {
			endpoint = "/api/v1/mcps/draft"
		}
		raw, cerr := client.Do("POST", endpoint, nil, payload, "Submit MCP server", "MCP registry")
		if cerr != nil {
			return cerr
		}
		if *mode == "json" {
			outputJSONRaw(raw)
			return nil
		}
		var result struct {
			ID     any    `json:"id"`
			Status string `json:"status"`
		}
		_ = json.Unmarshal(raw, &result)
		message := "Submitted!"
		if *draft {
			message = "Draft saved!"
		}
		fmt.Printf("\n%s ID: %v\n", message, result.ID)
		fmt.Printf("  Status: %s\n", orDefault(result.Status, "pending"))
		return nil
	}
	return cmd
}

// applyPublishTarget copies the publish fields into the ordered payload.
func applyPublishTarget(payload *omap, shim map[string]any) {
	if visibility, ok := shim["visibility"]; ok {
		payload.set("visibility", visibility)
	}
}

// ── mcp edit ───────────────────────────────────────────────────────

func mcpEditCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "edit NAME", Short: "Edit a draft, rejected, or pending MCP submission", Args: cobra.ExactArgs(1)}
	fromFile := cmd.Flags().StringP("from-file", "f", "", "Load updates from JSON file")
	name := cmd.Flags().StringP("name", "n", "", "New listing name")
	description := cmd.Flags().StringP("description", "d", "", "New description")
	category := cmd.Flags().StringP("category", "c", "", "New category")
	version := cmd.Flags().StringP("version", "v", "", "New version string")
	gitURL := cmd.Flags().String("git-url", "", "New Git URL")
	command := cmd.Flags().String("command", "", "New command")
	urlFlag := cmd.Flags().String("url", "", "New URL")
	bump := cmd.Flags().String("bump", "", "Version bump: patch, minor, or major")
	changelog := cmd.Flags().String("changelog", "", "Changelog notes")
	mode := outputFlag(cmd)
	cmd.RunE = func(c *cobra.Command, args []string) error {
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		resolved, cerr := ref.ResolveRegistryReference(client, "mcp", args[0], "", "MCP registry")
		if cerr != nil {
			return cerr
		}
		var updates map[string]any
		if *fromFile != "" {
			updates, cerr = loadJSONObjectFile(*fromFile, "Edit MCP server", "MCP update file")
			if cerr != nil {
				return cerr
			}
		} else {
			updates = map[string]any{}
			for key, flag := range map[string]*string{
				"name": name, "description": description, "category": category,
				"version": version, "git_url": gitURL, "command": command, "url": urlFlag,
			} {
				if c.Flags().Changed(flagNameFor(key)) {
					updates[key] = *flag
				}
			}
		}
		if len(updates) == 0 {
			if *mode == "json" {
				return &clierr.Error{
					Category: clierr.Validation, Message: "JSON mode requires explicit MCP updates.",
					Operation: "Edit MCP server", Resource: args[0],
					Remediation: "Provide an update file or one or more field options.",
				}
			}
			fmt.Println("Paste the updated MCP JSON config below.")
			fmt.Println("Press Enter on an empty line when done.")
			fmt.Println()
			rawText := readStdinConfig()
			if rawText == "" {
				return &clierr.Error{
					Category: clierr.Validation, Message: "No MCP updates were provided.",
					Operation: "Edit MCP server", Resource: "standard input",
					Remediation: "Pipe or paste an MCP JSON configuration and retry.",
				}
			}
			value, err := decodeOrderedJSON([]byte(rawText))
			if err != nil {
				return &clierr.Error{
					Category: clierr.Validation, Message: "The MCP update is not valid JSON.",
					Operation: "Edit MCP server", Resource: "standard input",
					Remediation: "Correct the JSON and retry.", Detail: err.Error(),
				}
			}
			cfg, _ := value.(*omap)
			if cfg != nil {
				parsed := parseDirectConfig(cfg)
				for _, key := range []string{"name", "description", "command", "args", "url", "transport", "framework", "environment_variables"} {
					if value := parsed.get(key); truthy(value) {
						updates[key] = plain(value)
					}
				}
			}
			if len(updates) == 0 {
				return &clierr.Error{
					Category: clierr.Validation, Message: "No MCP changes could be parsed.",
					Operation: "Edit MCP server", Resource: args[0],
					Remediation: "Provide at least one supported MCP field.",
				}
			}
			if !confirm("Apply these changes?") {
				return abortErr("Edit MCP server")
			}
		}
		listingRaw, cerr := client.Do("GET", "/api/v1/mcps/"+resolved, nil, nil, "Edit MCP server", "MCP registry")
		if cerr != nil {
			return cerr
		}
		var listing struct {
			Name        string `json:"name"`
			Status      string `json:"status"`
			Version     string `json:"version"`
			Description string `json:"description"`
		}
		_ = json.Unmarshal(listingRaw, &listing)
		if listing.Status == "approved" {
			return mcpPublishFromEdit(client, resolved, args[0], listing.Name, listing.Version, listing.Description,
				updates, *bump, *changelog, *mode)
		}
		return startEditAndPutDraft(client, "mcps", resolved, updates, "Edit MCP server", "MCP registry", *mode)
	}
	return cmd
}

func flagNameFor(key string) string {
	if key == "git_url" {
		return "git-url"
	}
	return key
}

// mcpPublishFromEdit versions an approved listing instead of editing it.
func mcpPublishFromEdit(client apiClientFull, resolved, reference, listingName, currentVersion, listingDescription string,
	updates map[string]any, bump, changelog, mode string) error {
	if bump != "" && bump != "patch" && bump != "minor" && bump != "major" {
		return &clierr.Error{
			Category: clierr.Validation, Message: fmt.Sprintf("Unknown version bump: %s.", bump),
			Operation: "Edit MCP server", Resource: "version bump",
			Remediation: "Choose patch, minor, or major.",
		}
	}
	if mode == "json" && bump == "" {
		return &clierr.Error{
			Category: clierr.Validation, Message: "JSON mode requires an explicit version bump for an approved MCP server.",
			Operation: "Edit MCP server", Resource: reference,
			Remediation: "Provide a patch, minor, or major version bump.",
		}
	}
	release := parseReleaseTriple(currentVersion)
	if release == nil {
		return &clierr.Error{
			Category: clierr.Unavailable, Message: "The registry returned an invalid current MCP version.",
			Operation: "Edit MCP server", Resource: currentVersion,
			Remediation: "Check server health and version compatibility, then retry.",
		}
	}
	if bump == "" {
		bump = "patch"
	}
	var newVersion string
	switch bump {
	case "major":
		newVersion = fmt.Sprintf("%d.0.0", release[0]+1)
	case "minor":
		newVersion = fmt.Sprintf("%d.%d.0", release[0], release[1]+1)
	default:
		newVersion = fmt.Sprintf("%d.%d.%d", release[0], release[1], release[2]+1)
	}
	versionDescription := listingDescription
	if desc, ok := updates["description"].(string); ok && desc != "" {
		versionDescription = desc
	}
	delete(updates, "description")
	delete(updates, "name")
	body := newOmap()
	body.set("version", newVersion)
	body.set("description", versionDescription)
	if len(updates) > 0 {
		body.set("extra", updates)
	}
	if trimmed := strings.TrimSpace(changelog); trimmed != "" {
		body.set("changelog", trimmed)
	}
	raw, cerr := client.Do("POST", "/api/v1/mcps/"+resolved+"/versions", nil, body, "Edit MCP server", "MCP registry")
	if cerr != nil {
		return cerr
	}
	if mode == "json" {
		outputJSONRaw(raw)
		return nil
	}
	fmt.Printf("Published v%s for %s\n", newVersion, listingName)
	return nil
}

// apiClientFull matches the api client used by the edit flows.
type apiClientFull interface {
	Do(method, path string, params map[string]string, body any, operation, resource string) ([]byte, *clierr.Error)
}

// parseReleaseTriple extracts a padded numeric release from a version.
func parseReleaseTriple(version string) []int {
	base := strings.SplitN(strings.TrimSpace(version), "+", 2)[0]
	parts := strings.Split(base, ".")
	release := []int{0, 0, 0}
	if len(parts) == 0 || parts[0] == "" {
		return nil
	}
	for i := 0; i < len(parts) && i < 3; i++ {
		n, err := strconv.Atoi(parts[i])
		if err != nil {
			return nil
		}
		release[i] = n
	}
	return release
}
