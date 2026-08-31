// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/spf13/cobra"

	"github.com/garudex-labs/caracal/internal/cli/api"
	"github.com/garudex-labs/caracal/internal/cli/clierr"
	"github.com/garudex-labs/caracal/internal/cli/ref"
	"github.com/garudex-labs/caracal/internal/harness"
	"github.com/garudex-labs/caracal/internal/promptcat"
)

var validHarnesses = []string{"cursor", "kiro", "claude-code", "codex", "copilot", "copilot-cli", "opencode", "antigravity", "goose", "pi"}

var validMcpCategories = []string{"browser-automation", "cloud-platforms", "code-execution", "communication", "databases", "developer-tools", "devops", "file-systems", "finance", "knowledge-memory", "monitoring", "multimedia", "productivity", "search", "security", "version-control", "ai-ml", "data-analytics", "general"}

var validSkillTaskTypes = []string{"code-review", "code-generation", "testing", "documentation", "debugging", "refactoring", "deployment", "security-audit", "performance", "general"}

var validHookEvents = []string{"PreToolUse", "PostToolUse", "Notification", "Stop", "SubagentStop", "SessionStart", "UserPromptSubmit"}

// validPromptCategories is the curated set suggested in help text. Prompt
// categories are not restricted to this list: any value normalized by
// promptcat.Normalize is accepted, with the server remaining authoritative.
var validPromptCategories = promptcat.Recommended

func contains(values []string, v string) bool {
	for _, value := range values {
		if value == v {
			return true
		}
	}
	return false
}

// componentSpec parameterizes one registry component command group.
type componentSpec struct {
	Singular string
	Plural   string
	Label    string // e.g. "MCP server"
	Resource string // e.g. "MCP registry"
	HasMy    bool
	EmptyMsg string
	MyEmpty  string
	ListOp   string
	MyOp     string
	ShowOp   string
}

var componentSpecs = []componentSpec{
	{"mcp", "mcps", "MCP server", "MCP registry", true, "No MCP servers found.", "You have no MCP servers.", "List MCP servers", "List owned MCP servers", "Show MCP server"},
	{"skill", "skills", "skill", "skill registry", true, "No skills found.", "You have no skills.", "List skills", "List owned skills", "Show skill"},
	{"hook", "hooks", "hook", "hook registry", false, "No hooks found.", "", "List hooks", "", "Show hook"},
	{"prompt", "prompts", "prompt", "prompt registry", true, "No prompts found.", "You have no prompts.", "List prompts", "You have no prompts.", "Show prompt"},
}

func registryCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "registry", Short: "Component registry"}
	for _, spec := range componentSpecs {
		cmd.AddCommand(componentGroup(spec))
	}
	cmd.AddCommand(versionGroup())
	cmd.AddCommand(modelsGroup())
	cmd.AddCommand(recommendGroup())
	cmd.AddCommand(bulkGroup())
	return cmd
}

func componentGroup(spec componentSpec) *cobra.Command {
	title := strings.ToUpper(spec.Singular[:1]) + spec.Singular[1:]
	group := &cobra.Command{Use: spec.Singular, Short: title + " components"}
	group.AddCommand(componentList(spec))
	if spec.HasMy {
		group.AddCommand(componentMy(spec))
	}
	group.AddCommand(componentShow(spec))
	group.AddCommand(archiveCommand(spec, false), archiveCommand(spec, true))
	group.AddCommand(coAuthorsGroup(spec.Plural, spec.Resource))
	group.AddCommand(transferOwnerCommand(spec.Plural, spec.Label))
	switch spec.Singular {
	case "mcp":
		group.AddCommand(mcpSubmitCommand(), mcpEditCommand(), mcpInstallCommand())
	case "skill":
		group.AddCommand(skillSubmitCommand(), skillEditCommand(), skillInstallCommand())
	case "hook":
		group.AddCommand(hookSubmitCommand(), hookEditCommand(), hookInstallCommand())
	case "prompt":
		group.AddCommand(promptSubmitCommand(), promptEditCommand(), promptRenderCommand())
	}
	return group
}

// listFilters builds per-type list flags and their query mapping.
func componentList(spec componentSpec) *cobra.Command {
	cmd := &cobra.Command{Use: "list", Short: "List " + spec.Plural}
	mode := outputFlag(cmd)
	var category, search, namespace, sortKey, taskType, targetAgent, harness, event string
	var limit int
	switch spec.Singular {
	case "mcp":
		cmd.Flags().StringVarP(&category, "category", "c", "", "Filter by category")
		cmd.Flags().StringVarP(&search, "search", "s", "", "Search text")
		cmd.Flags().StringVar(&namespace, "namespace", "", "Filter by namespace")
		cmd.Flags().IntVarP(&limit, "limit", "n", 50, "Result limit")
		cmd.Flags().StringVar(&sortKey, "sort", "name", "Sort key")
	case "skill":
		cmd.Flags().StringVarP(&taskType, "task-type", "t", "", "Filter by task type")
		cmd.Flags().StringVar(&targetAgent, "target-agent", "", "Filter by target agent")
		cmd.Flags().StringVar(&harness, "harness", "", "Filter by harness")
		cmd.Flags().StringVarP(&search, "search", "s", "", "Search text")
		cmd.Flags().StringVar(&namespace, "namespace", "", "Filter by namespace")
	case "hook":
		cmd.Flags().StringVarP(&event, "event", "e", "", "Filter by event")
		cmd.Flags().StringVarP(&search, "search", "s", "", "Search text")
		cmd.Flags().StringVar(&namespace, "namespace", "", "Filter by namespace")
	case "prompt":
		cmd.Flags().StringVarP(&category, "category", "c", "", "Filter by category")
		cmd.Flags().StringVarP(&search, "search", "s", "", "Search text")
		cmd.Flags().StringVar(&namespace, "namespace", "", "Filter by namespace")
	}
	cmd.RunE = func(_ *cobra.Command, _ []string) error {
		params := map[string]string{}
		switch spec.Singular {
		case "mcp":
			if category != "" && !contains(validMcpCategories, category) {
				return listValidationError(spec.ListOp, "category filter",
					fmt.Sprintf("Unknown MCP category: %s.", category), validMcpCategories)
			}
			if sortKey != "name" && sortKey != "category" && sortKey != "version" {
				return &clierr.Error{
					Category: clierr.Validation, Message: fmt.Sprintf("Unknown MCP sort field: %s.", sortKey),
					Operation: spec.ListOp, Resource: "sort option",
					Remediation: "Choose name, category, or version.",
				}
			}
			if limit < 1 || limit > 200 {
				return &clierr.Error{
					Category:    clierr.Usage,
					Message:     fmt.Sprintf("Invalid value for '--limit': %d is not in the range 1<=x<=200.", limit),
					Operation:   "Run caracal registry mcp list",
					Remediation: "Run caracal registry mcp list --help for valid usage.",
				}
			}
			setIf(params, "category", category)
		case "skill":
			if taskType != "" && !contains(validSkillTaskTypes, taskType) {
				return listValidationError(spec.ListOp, "task type filter",
					fmt.Sprintf("Unknown skill task type: %s.", taskType), validSkillTaskTypes)
			}
			if harness != "" {
				if !contains(validHarnesses, harness) {
					return listValidationError(spec.ListOp, "harness filter",
						fmt.Sprintf("Unknown harness: %s.", harness), validHarnesses)
				}
				if !harnessSupportsSkills(harness) {
					return &clierr.Error{
						Category: clierr.Validation, Message: fmt.Sprintf("Skills are not supported for the %s harness.", harness),
						Operation: spec.ListOp, Resource: "harness filter",
						Remediation: "Skills are not supported for this resource on that harness; choose a skill-capable harness.",
					}
				}
			}
			setIf(params, "task_type", taskType)
			setIf(params, "target_agent", targetAgent)
			setIf(params, "harness", harness)
		case "hook":
			if event != "" && !contains(validHookEvents, event) {
				return listValidationError(spec.ListOp, "event filter",
					fmt.Sprintf("Unknown hook event: %s.", event), validHookEvents)
			}
			setIf(params, "event", event)
		case "prompt":
			if category != "" {
				norm, ok := promptcat.Normalize(category)
				if !ok {
					return listValidationError(spec.ListOp, "category filter",
						fmt.Sprintf("Invalid prompt category: %s.", category), validPromptCategories)
				}
				category = norm
			}
			setIf(params, "category", category)
		}
		setIf(params, "search", search)
		if namespace != "" {
			params["namespace"] = strings.ToLower(strings.TrimPrefix(namespace, "@"))
		}
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		raw, cerr := client.Do("GET", "/api/v1/"+spec.Plural, params, nil, spec.ListOp, spec.Resource)
		if cerr != nil {
			return cerr
		}
		items, cerr2 := decodeListItems(raw, spec.ListOp, spec.Resource)
		if cerr2 != nil {
			return cerr2
		}
		if spec.Singular == "mcp" {
			key := sortKey
			sort.SliceStable(items, func(i, j int) bool {
				return strOrEmpty(items[i].fields[key]) < strOrEmpty(items[j].fields[key])
			})
			if len(items) > limit {
				items = items[:limit]
			}
		}
		_ = saveListCache(items, spec.Singular)
		return renderComponentList(items, *mode, spec.EmptyMsg)
	}
	return cmd
}

func componentMy(spec componentSpec) *cobra.Command {
	cmd := &cobra.Command{Use: "my", Short: "List your " + spec.Plural}
	mode := outputFlag(cmd)
	cmd.RunE = func(_ *cobra.Command, _ []string) error {
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		raw, cerr := client.Do("GET", "/api/v1/"+spec.Plural+"/my", nil, nil, spec.MyOp, spec.Resource)
		if cerr != nil {
			return cerr
		}
		items, cerr2 := decodeListItems(raw, spec.MyOp, spec.Resource)
		if cerr2 != nil {
			return cerr2
		}
		_ = saveListCache(items, spec.Singular)
		return renderComponentList(items, *mode, spec.MyEmpty)
	}
	return cmd
}

func componentShow(spec componentSpec) *cobra.Command {
	cmd := &cobra.Command{Use: "show NAME", Short: "Show one " + spec.Label, Args: cobra.ExactArgs(1)}
	mode := outputFlag(cmd)
	cmd.RunE = func(_ *cobra.Command, args []string) error {
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		resolved, cerr := ref.ResolveRegistryReference(client, spec.Singular, args[0], spec.ShowOp, spec.Resource)
		if cerr != nil {
			return cerr
		}
		raw, cerr := client.Do("GET", "/api/v1/"+spec.Plural+"/"+resolved, nil, nil, spec.ShowOp, spec.Resource)
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

var archiveLabels = map[string]string{"mcps": "MCP server", "skills": "skill", "hooks": "hook", "prompts": "prompt"}

func archiveCommand(spec componentSpec, restore bool) *cobra.Command {
	use, verb, op := "archive NAME", "Archive", "Archive registry component"
	archiveResolveOp := "Archive component"
	if restore {
		use, verb, op = "unarchive NAME", "Restore", "Restore registry component"
		archiveResolveOp = "Restore component"
	}
	cmd := &cobra.Command{Use: use, Short: verb + " a " + spec.Label, Args: cobra.ExactArgs(1)}
	yes := cmd.Flags().BoolP("yes", "y", false, "Skip confirmation")
	mode := outputFlag(cmd)
	cmd.RunE = func(_ *cobra.Command, args []string) error {
		if *mode == "json" && !*yes {
			return &clierr.Error{
				Category: clierr.Validation, Message: "JSON mode cannot open a confirmation prompt.",
				Operation: op, Resource: "confirmation",
				Remediation: "Pass the confirmation bypass option and retry.",
			}
		}
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		resolved, cerr := ref.ResolveRegistryReference(client, spec.Singular, args[0], archiveResolveOp, "registry component")
		if cerr != nil {
			return cerr
		}
		if !*yes {
			raw, cerr := client.Do("GET", "/api/v1/"+spec.Plural+"/"+resolved, nil, nil, op, "registry component")
			if cerr != nil {
				return cerr
			}
			var doc map[string]any
			_ = json.Unmarshal(raw, &doc)
			prompt := fmt.Sprintf("%s %s %v (%v)?", verb, archiveLabels[spec.Plural], doc["name"], doc["id"])
			if !confirm(prompt) {
				return abortErr(op)
			}
		}
		suffix := "/archive"
		if restore {
			suffix = "/unarchive"
		}
		raw, cerr := client.Do("PATCH", "/api/v1/"+spec.Plural+"/"+resolved+suffix, nil, nil, op, "registry component")
		if cerr != nil {
			return cerr
		}
		if *mode == "json" {
			outputJSONRaw(raw)
			return nil
		}
		fmt.Printf("%sd.\n", verb)
		return nil
	}
	return cmd
}

func coAuthorsGroup(plural, resource string) *cobra.Command {
	group := &cobra.Command{Use: "co-authors", Short: "Manage co-authors"}

	list := &cobra.Command{Use: "list ENTITY", Short: "List co-authors", Args: cobra.ExactArgs(1)}
	listMode := outputFlag(list)
	list.RunE = func(_ *cobra.Command, args []string) error {
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		resolved, cerr := ref.ResolveRegistryReference(client, plural, args[0], "", "registry co-authors")
		if cerr != nil {
			return cerr
		}
		raw, cerr := client.Do("GET", "/api/v1/"+plural+"/"+resolved+"/co-authors", nil, nil, "List co-authors", "registry co-authors")
		if cerr != nil {
			return cerr
		}
		if *listMode == "json" {
			outputJSONRaw(raw)
			return nil
		}
		printDocumentSummary(raw)
		return nil
	}

	add := &cobra.Command{Use: "add ENTITY USER", Short: "Add a co-author", Args: cobra.ExactArgs(2)}
	addMode := outputFlag(add)
	add.RunE = func(_ *cobra.Command, args []string) error {
		user := strings.TrimSpace(args[1])
		if user == "" {
			return &clierr.Error{
				Category: clierr.Validation, Message: "Co-author email or username is required.",
				Operation: "Add co-author", Resource: plural + " co-authors",
				Remediation: "Provide an email address or username.",
			}
		}
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		resolved, cerr := ref.ResolveRegistryReference(client, plural, args[0], "", "registry co-authors")
		if cerr != nil {
			return cerr
		}
		body := map[string]string{}
		if strings.Contains(user, "@") && !strings.HasPrefix(user, "@") {
			body["email"] = strings.ToLower(user)
		} else {
			body["username"] = strings.TrimPrefix(user, "@")
		}
		raw, cerr := client.Do("POST", "/api/v1/"+plural+"/"+resolved+"/co-authors", nil, body, "Add co-author", "registry co-authors")
		if cerr != nil {
			return cerr
		}
		if *addMode == "json" {
			outputJSONRaw(raw)
			return nil
		}
		fmt.Println("Co-author added.")
		return nil
	}

	remove := &cobra.Command{Use: "remove ENTITY USER_ID", Short: "Remove a co-author", Args: cobra.ExactArgs(2)}
	removeMode := outputFlag(remove)
	remove.RunE = func(_ *cobra.Command, args []string) error {
		parsed, err := uuid.Parse(args[1])
		if err != nil {
			return &clierr.Error{
				Category: clierr.Validation, Message: "Co-author user ID must be a UUID.",
				Operation: "Remove co-author", Resource: plural + " co-authors",
				Remediation: "Copy the user ID from the co-author list JSON result.",
			}
		}
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		resolved, cerr := ref.ResolveRegistryReference(client, plural, args[0], "", "registry co-authors")
		if cerr != nil {
			return cerr
		}
		raw, cerr := client.Do("DELETE", "/api/v1/"+plural+"/"+resolved+"/co-authors/"+parsed.String(), nil, nil, "Remove co-author", "registry co-authors")
		if cerr != nil {
			return cerr
		}
		if *removeMode == "json" {
			outputJSONRaw(raw)
			return nil
		}
		fmt.Println("Co-author removed.")
		return nil
	}
	group.AddCommand(list, add, remove)
	return group
}

func transferOwnerCommand(plural, label string) *cobra.Command {
	cmd := &cobra.Command{Use: "transfer-owner ENTITY USERNAME", Short: "Transfer ownership", Args: cobra.ExactArgs(2)}
	yes := cmd.Flags().BoolP("yes", "y", false, "Skip confirmation")
	mode := outputFlag(cmd)
	cmd.RunE = func(_ *cobra.Command, args []string) error {
		target := strings.TrimPrefix(strings.TrimSpace(args[1]), "@")
		if target == "" {
			return &clierr.Error{
				Category: clierr.Validation, Message: "The new owner's username is required.",
				Operation: "Transfer registry ownership", Resource: "registry ownership",
				Remediation: "Provide a username and retry.",
			}
		}
		if *mode == "json" && !*yes {
			return &clierr.Error{
				Category: clierr.Validation, Message: "JSON mode cannot open a confirmation prompt.",
				Operation: "Transfer registry ownership", Resource: "confirmation",
				Remediation: "Pass the confirmation bypass option and retry.",
			}
		}
		if !*yes && !confirmDanger(fmt.Sprintf("Transfer %s '%s' to @%s? You will no longer be the owner.", label, args[0], target)) {
			return abortErr("Transfer registry ownership")
		}
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		resolved, cerr := ref.ResolveRegistryReference(client, plural, args[0], "Transfer registry ownership", "registry ownership")
		if cerr != nil {
			return cerr
		}
		raw, cerr := client.Do("POST", "/api/v1/"+plural+"/"+resolved+"/transfer-ownership", nil,
			map[string]string{"username": target}, "Transfer registry ownership", "registry ownership")
		if cerr != nil {
			return cerr
		}
		if *mode == "json" {
			outputJSONRaw(raw)
			return nil
		}
		fmt.Printf("Ownership transferred to: @%s\n", target)
		return nil
	}
	return cmd
}

func versionGroup() *cobra.Command {
	group := &cobra.Command{Use: "version", Short: "Component versions"}
	list := &cobra.Command{Use: "list TYPE LISTING", Short: "List component versions", Args: cobra.ExactArgs(2)}
	page := list.Flags().Int("page", 1, "Page number")
	pageSize := list.Flags().Int("page-size", 50, "Page size")
	mode := outputFlag(list)
	list.RunE = func(_ *cobra.Command, args []string) error {
		componentType := strings.ToLower(strings.TrimSpace(args[0]))
		if !contains([]string{"mcp", "skill", "hook", "prompt"}, componentType) {
			return &clierr.Error{
				Category: clierr.Validation, Message: fmt.Sprintf("Unknown component type: %s.", componentType),
				Operation: "Manage component version", Resource: "component type",
				Remediation: "Choose one of: hook, mcp, prompt, skill.",
			}
		}
		plural := componentType + "s"
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		resolved, cerr := ref.ResolveRegistryReference(client, componentType, args[1], "List component versions", "component versions")
		if cerr != nil {
			return cerr
		}
		raw, cerr := client.Do("GET", "/api/v1/"+plural+"/"+resolved+"/versions",
			map[string]string{"page": fmt.Sprint(*page), "page_size": fmt.Sprint(*pageSize)},
			nil, "List component versions", "component versions")
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
	group.AddCommand(list)
	group.AddCommand(versionPublishCommand())
	return group
}

// ── shared helpers ─────────────────────────────────────────────────

func newClient() (*api.Client, *clierr.Error) {
	client, cerr := api.New(cliVersion)
	if cerr != nil {
		return nil, cerr
	}
	if cerr := client.EnforceVersion("registry"); cerr != nil {
		return nil, cerr
	}
	return client, nil
}

func setIf(params map[string]string, key, value string) {
	if value != "" {
		params[key] = value
	}
}

func listValidationError(op, resource, message string, choices []string) *clierr.Error {
	return &clierr.Error{
		Category: clierr.Validation, Message: message,
		Operation: op, Resource: resource,
		Remediation: "Choose one of: " + strings.Join(choices, ", ") + ".",
	}
}

func invalidServerList(op, resource string, err error) *clierr.Error {
	return &clierr.Error{
		Category: clierr.Unavailable, Message: "The server returned an invalid list response.",
		Operation: op, Resource: resource,
		Remediation: "Check server health and retry.", Detail: err.Error(),
	}
}

func strOrEmpty(v any) string {
	s, _ := v.(string)
	return s
}

// harnessSupportsSkills reports whether a Caracal Skill materializes for the
// harness through a native (SKILL.md) or compatible (e.g. Cursor rule)
// mechanism. Driven by the canonical harness registry so it never drifts from
// the materialization layer, the UI, or the backend.
func harnessSupportsSkills(name string) bool {
	spec, ok := harness.MustLoad().Spec(strings.ReplaceAll(name, "_", "-"))
	return ok && spec.SupportsSkill()
}

// harnessSupportsRegistryHooks reports whether a harness can materialize a
// Caracal Registry Hook, per the canonical registry's hook_support level. It is
// the CLI half of the same gate the server and UI apply; telemetry-only or
// unsupported harnesses return false so a hook is never installed where it
// would be silently dropped.
func harnessSupportsRegistryHooks(name string) bool {
	spec, ok := harness.MustLoad().Spec(strings.ReplaceAll(name, "_", "-"))
	return ok && spec.SupportsRegistryHooks()
}

// listItem pairs one raw item with its decoded lookup fields, preserving
// the server's document key order for output.
type listItem struct {
	raw    json.RawMessage
	fields map[string]any
}

func decodeListItems(raw []byte, op, resource string) ([]listItem, *clierr.Error) {
	var rawItems []json.RawMessage
	if err := json.Unmarshal(raw, &rawItems); err != nil {
		return nil, invalidServerList(op, resource, err)
	}
	items := make([]listItem, 0, len(rawItems))
	for _, blob := range rawItems {
		fields := map[string]any{}
		_ = json.Unmarshal(blob, &fields)
		items = append(items, listItem{raw: blob, fields: fields})
	}
	return items, nil
}

func saveListCache(items []listItem, itemType string) error {
	docs := make([]map[string]any, len(items))
	for i, item := range items {
		docs[i] = item.fields
	}
	return ref.SaveLastResults(docs, itemType)
}

// renderComponentList prints the list envelope or a plain table.
func renderComponentList(items []listItem, mode, emptyMsg string) error {
	if mode == "json" {
		var doc strings.Builder
		doc.WriteString("[")
		for i, item := range items {
			if i > 0 {
				doc.WriteString(",")
			}
			doc.Write(item.raw)
		}
		doc.WriteString("]")
		outputJSONRaw([]byte(doc.String()))
		return nil
	}
	if len(items) == 0 {
		fmt.Println(emptyMsg)
		return nil
	}
	for i, item := range items {
		id := fmt.Sprint(item.fields["id"])
		if len(id) > 8 {
			id = id[:8] + "…"
		}
		fmt.Printf("%3d  %-32v %-10v %-16v %s\n", i+1, item.fields["name"], item.fields["version"], item.fields["namespace"], id)
	}
	return nil
}

// printDocumentSummary prints a readable key: value view of a document.
func printDocumentSummary(raw []byte) {
	var doc any
	if json.Unmarshal(raw, &doc) != nil {
		fmt.Println(string(raw))
		return
	}
	switch v := doc.(type) {
	case map[string]any:
		keys := make([]string, 0, len(v))
		for key := range v {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			value := v[key]
			switch value.(type) {
			case map[string]any, []any:
				blob, _ := json.Marshal(value)
				fmt.Printf("%-24s %s\n", key, string(blob))
			default:
				fmt.Printf("%-24s %v\n", key, value)
			}
		}
	case []any:
		for i, item := range v {
			blob, _ := json.Marshal(item)
			fmt.Printf("%4d  %s\n", i+1, string(blob))
		}
	default:
		fmt.Println(string(raw))
	}
}
