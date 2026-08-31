// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"

	"github.com/garudex-labs/caracal/internal/cli/api"
	"github.com/garudex-labs/caracal/internal/cli/clierr"
	"github.com/garudex-labs/caracal/internal/cli/ref"
	"github.com/garudex-labs/caracal/internal/promptcat"
)

func validationErr(message, operation, resource, remediation string) *clierr.Error {
	return &clierr.Error{
		Category: clierr.Validation, Message: message,
		Operation: operation, Resource: resource, Remediation: remediation,
	}
}

func requireChoice(value string, allowed []string, message, operation, resource string) *clierr.Error {
	if value == "" || contains(allowed, value) {
		return nil
	}
	return validationErr(message, operation, resource, "Choose one of: "+strings.Join(allowed, ", ")+".")
}

func requireVersion(version, message, operation string) *clierr.Error {
	if version == "" || pep440Re.MatchString(version) {
		return nil
	}
	return &clierr.Error{
		Category: clierr.Validation, Message: message,
		Operation: operation, Resource: version,
		Remediation: "Provide a valid version and retry.",
	}
}

func requireHarnesses(harnesses []string, operation string) *clierr.Error {
	for _, name := range harnesses {
		if !contains(validHarnesses, name) {
			return &clierr.Error{
				Category: clierr.Validation, Message: fmt.Sprintf("Unknown harness: %s.", name),
				Operation: operation, Resource: "supported harnesses",
				Remediation: "Choose from: " + strings.Join(validHarnesses, ", ") + ".",
			}
		}
	}
	return nil
}

// requireRegistryHookHarnesses rejects a hook submission that targets a harness
// which cannot materialize a Registry Hook, matching the server-side gate so an
// unsupported harness is refused before the submission is sent.
func requireRegistryHookHarnesses(harnesses []string, operation string) *clierr.Error {
	for _, name := range harnesses {
		if !harnessSupportsRegistryHooks(name) {
			return &clierr.Error{
				Category:  clierr.Validation,
				Message:   fmt.Sprintf("%s does not support hooks and cannot be a target for this resource.", name),
				Operation: operation, Resource: "supported harnesses",
				Remediation: "Remove unsupported harnesses. Run caracal doctor to see per-harness capabilities.",
			}
		}
	}
	return nil
}

func anyList(values []string) []any {
	out := make([]any, len(values))
	for i, v := range values {
		out[i] = v
	}
	return out
}

func readTextFile(path, missingMessage, operation, remediation string) (string, *clierr.Error) {
	blob, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", &clierr.Error{
				Category: clierr.NotFound, Message: missingMessage,
				Operation: operation, Resource: path,
				Remediation: remediation, Detail: err.Error(),
			}
		}
		return "", &clierr.Error{Category: clierr.Unexpected, Message: err.Error(), Operation: operation, Resource: path}
	}
	return string(blob), nil
}

func postSubmission(client *api.Client, plural string, payload any, draft bool, op, resource, mode, successMsg, draftMsg string) error {
	endpoint := "/api/v1/" + plural + "/submit"
	if draft {
		endpoint = "/api/v1/" + plural + "/draft"
	}
	raw, cerr := client.Do("POST", endpoint, nil, payload, op, resource)
	if cerr != nil {
		return cerr
	}
	if mode == "json" {
		outputJSONRaw(raw)
		return nil
	}
	var result struct {
		ID     any    `json:"id"`
		Status string `json:"status"`
	}
	_ = json.Unmarshal(raw, &result)
	message := successMsg
	if draft {
		message = draftMsg
	}
	fmt.Printf("%s ID: %v\n", message, result.ID)
	fmt.Printf("  Status: %s\n", orDefault(result.Status, "pending"))
	return nil
}

// ── skill submit / edit ────────────────────────────────────────────

var frontmatterRe = regexp.MustCompile(`(?s)^---\r?\n(.*?)\r?\n---`)

func skillSubmitCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "submit", Short: "Submit a skill to the registry", Args: cobra.NoArgs}
	fromFile := cmd.Flags().StringP("from-file", "f", "", "Load submission from JSON file")
	skillMd := cmd.Flags().String("skill-md", "", "Path to a SKILL.md file")
	gitURL := cmd.Flags().String("git-url", "", "Git repository URL")
	gitRef := cmd.Flags().String("git-ref", "", "Git reference")
	script := cmd.Flags().String("script", "", "Path to a script file")
	deliveryMode := cmd.Flags().String("delivery-mode", "", "Delivery mode: git_fetch or registry_direct")
	name := cmd.Flags().StringP("name", "n", "", "Skill name")
	version := cmd.Flags().StringP("version", "v", "", "Version")
	description := cmd.Flags().StringP("description", "d", "", "Description")
	taskType := cmd.Flags().StringP("task-type", "t", "", "Task type")
	targetAgent := cmd.Flags().StringArray("target-agent", nil, "Target agent (repeat for multiple)")
	skillPath := cmd.Flags().String("skill-path", "", "Path within the repository")
	slashCommand := cmd.Flags().String("slash-command", "", "Slash command")
	harnesses := cmd.Flags().StringArray("harness", nil, "Supported harnesses (repeat for multiple)")
	draft := cmd.Flags().Bool("draft", false, "Save as a draft instead of submitting")
	submitDraft := cmd.Flags().String("submit", "", "Submit a draft for review (skill ID)")
	visibility := cmd.Flags().String("visibility", "", "Visibility: project or private")
	mode := outputFlag(cmd)
	cmd.RunE = func(c *cobra.Command, _ []string) error {
		const op = "Submit skill"
		if *draft && *submitDraft != "" {
			return draftSubmitConflict(op)
		}
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		if *submitDraft != "" {
			return submitDraftReference(client, "skill", "skills", *submitDraft, op, "skill registry", *mode)
		}
		var payload map[string]any
		if *fromFile != "" {
			payload, cerr = loadJSONObjectFile(*fromFile, op, "skill submission file")
			if cerr != nil {
				return cerr
			}
		} else {
			skillMdContent := ""
			prefillName, prefillDesc, prefillSlash := "", "", ""
			if *skillMd != "" {
				skillMdContent, cerr = readTextFile(*skillMd, "The SKILL.md file was not found.", op,
					"Provide an existing SKILL.md file and retry.")
				if cerr != nil {
					return cerr
				}
				if match := frontmatterRe.FindStringSubmatch(skillMdContent); match != nil {
					var meta map[string]any
					if yaml.Unmarshal([]byte(match[1]), &meta) == nil {
						if v, ok := meta["name"].(string); ok {
							prefillName = v
						}
						if v, ok := meta["description"].(string); ok {
							prefillDesc = v
						}
						if v, ok := meta["command"].(string); ok {
							prefillSlash = strings.TrimLeft(v, "/")
						}
					}
				}
			}
			scriptContent, scriptFilename := "", ""
			if *script != "" {
				scriptContent, cerr = readTextFile(*script, "The skill script file was not found.", op,
					"Provide an existing script file and retry.")
				if cerr != nil {
					return cerr
				}
				parts := strings.Split(*script, "/")
				scriptFilename = parts[len(parts)-1]
			}
			effectiveDelivery := *deliveryMode
			if effectiveDelivery == "" {
				if skillMdContent != "" && *gitURL == "" {
					effectiveDelivery = "registry_direct"
				} else {
					effectiveDelivery = "git_fetch"
				}
			}
			flagMode := *name != "" || *version != "" || *description != "" || *taskType != "" ||
				*skillPath != "" || *slashCommand != "" || len(*harnesses) > 0 || len(*targetAgent) > 0
			if *mode == "json" && !flagMode {
				return validationErr("JSON mode requires explicit skill fields.", op, "submit options",
					"Provide name, description, task type, and the selected delivery source.")
			}
			finalName := orDefault(*name, prefillName)
			finalDesc := orDefault(*description, prefillDesc)
			if flagMode && (finalName == "" || finalDesc == "") {
				return validationErr("Skill name and description are required without prompts.", op, "skill payload",
					"Provide both name and description and retry.")
			}
			if !flagMode {
				finalName = textInput("Skill name", prefillName)
				finalDesc = textInput("Description", prefillDesc)
			}
			taskTypeValue := orDefault(*taskType, "general")
			payload = map[string]any{
				"name":          finalName,
				"version":       orDefault(*version, "1.0.0"),
				"description":   finalDesc,
				"owner":         configUsername(),
				"task_type":     taskTypeValue,
				"target_agents": anyList(*targetAgent),
				"delivery_mode": effectiveDelivery,
			}
			if flagMode {
				payload["supported_harnesses"] = anyList(*harnesses)
			}
			if cerr := validateSkillFields(payload, op); cerr != nil {
				return cerr
			}
			if effectiveDelivery == "git_fetch" {
				if flagMode && *gitURL == "" {
					return validationErr("A Git URL is required for git-fetch skills.", op, "Git URL",
						"Provide a Git URL or choose registry-direct delivery.")
				}
				payload["git_url"] = *gitURL
				payload["skill_path"] = orDefault(*skillPath, "/")
				payload["git_ref"] = orDefault(*gitRef, "main")
			}
			finalSlash := orDefault(*slashCommand, prefillSlash)
			if finalSlash != "" {
				payload["slash_command"] = finalSlash
			}
			if skillMdContent != "" {
				payload["skill_md_content"] = skillMdContent
			}
			if scriptContent != "" {
				payload["script_content"] = scriptContent
				payload["script_filename"] = scriptFilename
			}
		}
		if *fromFile != "" {
			if cerr := validateSkillFields(payload, op); cerr != nil {
				return cerr
			}
		}
		if cerr := addPublishTarget(payload, *visibility, "registry skill submit"); cerr != nil {
			return cerr
		}
		return postSubmission(client, "skills", payload, *draft, op, "skill registry", *mode,
			"Skill submitted!", "Draft submitted!")
	}
	return cmd
}

func validateSkillFields(payload map[string]any, operation string) *clierr.Error {
	if taskType, ok := payload["task_type"].(string); ok && taskType != "" {
		if cerr := requireChoice(taskType, validSkillTaskTypes,
			fmt.Sprintf("Unknown skill task type: %s.", taskType), operation, "task type"); cerr != nil {
			return cerr
		}
	}
	if harnesses, ok := payload["supported_harnesses"].([]any); ok {
		names := make([]string, 0, len(harnesses))
		for _, raw := range harnesses {
			if name, ok := raw.(string); ok {
				names = append(names, name)
			}
		}
		if cerr := requireHarnesses(names, operation); cerr != nil {
			return cerr
		}
	}
	if version, ok := payload["version"].(string); ok {
		if cerr := requireVersion(version, "The skill version is invalid.", operation); cerr != nil {
			return cerr
		}
	}
	return nil
}

func skillEditCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "edit NAME", Short: "Edit a draft, rejected, or pending skill submission", Args: cobra.ExactArgs(1)}
	fromFile := cmd.Flags().StringP("from-file", "f", "", "Load updates from JSON file")
	name := cmd.Flags().StringP("name", "n", "", "New listing name")
	description := cmd.Flags().StringP("description", "d", "", "New description")
	version := cmd.Flags().StringP("version", "v", "", "New version string")
	taskType := cmd.Flags().StringP("task-type", "t", "", "New task type")
	gitURL := cmd.Flags().String("git-url", "", "New Git URL")
	gitRef := cmd.Flags().String("git-ref", "", "New Git reference")
	mode := outputFlag(cmd)
	cmd.RunE = func(c *cobra.Command, args []string) error {
		const op = "Edit skill"
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		resolved, cerr := ref.ResolveRegistryReference(client, "skill", args[0], op, "skill registry")
		if cerr != nil {
			return cerr
		}
		var updates map[string]any
		if *fromFile != "" {
			updates, cerr = loadJSONObjectFile(*fromFile, op, "skill update file")
			if cerr != nil {
				return cerr
			}
		} else {
			updates = map[string]any{}
			for key, pair := range map[string]struct {
				flag  *string
				fname string
			}{
				"name": {name, "name"}, "description": {description, "description"},
				"version": {version, "version"}, "task_type": {taskType, "task-type"},
				"git_url": {gitURL, "git-url"}, "git_ref": {gitRef, "git-ref"},
			} {
				if c.Flags().Changed(pair.fname) {
					updates[key] = *pair.flag
				}
			}
		}
		if len(updates) == 0 {
			return validationErr("No skill changes were provided.", op, args[0],
				"Provide an update file or one or more field options.")
		}
		if cerr := validateSkillFields(updates, op); cerr != nil {
			return cerr
		}
		return startEditAndPutDraft(client, "skills", resolved, updates, op, "skill registry", *mode)
	}
	return cmd
}

// ── hook submit / edit ─────────────────────────────────────────────

var hookTimeoutCaps = map[string]int{"blocking": 30, "sync": 10, "async": 60}

func validateHookTimeout(seconds int, executionMode string) *clierr.Error {
	cap, ok := hookTimeoutCaps[executionMode]
	if !ok {
		return nil
	}
	if seconds > cap {
		return &clierr.Error{
			Category:  clierr.Validation,
			Message:   fmt.Sprintf("Timeout %ds exceeds the %ds maximum for %s hooks.", seconds, cap, executionMode),
			Operation: "Validate hook", Resource: "timeout",
			Remediation: "Reduce the timeout or choose a compatible execution mode.",
		}
	}
	return nil
}

func hookSubmitCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "submit", Short: "Submit a hook to the registry", Args: cobra.NoArgs}
	fromFile := cmd.Flags().StringP("from-file", "f", "", "Load submission from JSON file")
	draft := cmd.Flags().Bool("draft", false, "Save as a draft instead of submitting")
	submitDraft := cmd.Flags().String("submit", "", "Submit a draft for review (hook ID)")
	script := cmd.Flags().String("script", "", "Path to a script file")
	sourceURL := cmd.Flags().String("source-url", "", "Source repository URL")
	sourceRef := cmd.Flags().String("source-ref", "", "Source reference")
	sourcePath := cmd.Flags().String("source-path", "", "Path within the source repository")
	requires := cmd.Flags().StringArray("requires", nil, "Requirement (repeat for multiple)")
	name := cmd.Flags().StringP("name", "n", "", "Hook name")
	version := cmd.Flags().StringP("version", "v", "", "Version")
	description := cmd.Flags().StringP("description", "d", "", "Description")
	event := cmd.Flags().StringP("event", "e", "", "Hook event")
	handlerType := cmd.Flags().String("handler-type", "", "Handler type: command or http")
	handlerCommand := cmd.Flags().String("handler-command", "", "Handler command")
	handlerURL := cmd.Flags().String("handler-url", "", "Handler URL")
	timeout := cmd.Flags().Int("timeout", 0, "Timeout in seconds")
	executionMode := cmd.Flags().String("execution-mode", "", "Execution mode: async, sync, or blocking")
	scope := cmd.Flags().String("scope", "", "Scope: agent, session, or global")
	harnesses := cmd.Flags().StringArray("harness", nil, "Supported harnesses (repeat for multiple)")
	visibility := cmd.Flags().String("visibility", "", "Visibility: project or private")
	mode := outputFlag(cmd)
	cmd.RunE = func(c *cobra.Command, _ []string) error {
		const op = "Submit hook"
		if *draft && *submitDraft != "" {
			return draftSubmitConflict(op)
		}
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		if *submitDraft != "" {
			return submitDraftReference(client, "hook", "hooks", *submitDraft, op, "hook registry", *mode)
		}
		var payload map[string]any
		if *fromFile != "" {
			payload, cerr = loadJSONObjectFile(*fromFile, op, "hook submission file")
			if cerr != nil {
				return cerr
			}
			if _, has := payload["owner"]; !has {
				payload["owner"] = configUsername()
			}
		} else {
			scriptContent, scriptFilename := "", ""
			if *script != "" {
				scriptContent, cerr = readTextFile(*script, "The hook script file was not found.", op,
					"Provide an existing script file and retry.")
				if cerr != nil {
					return cerr
				}
				parts := strings.Split(*script, "/")
				scriptFilename = parts[len(parts)-1]
			}
			flagMode := *name != "" || *version != "" || *description != "" || *event != "" ||
				*handlerType != "" || *handlerCommand != "" || *handlerURL != "" ||
				c.Flags().Changed("timeout") || *executionMode != "" || *scope != "" || len(*harnesses) > 0
			if *mode == "json" && !flagMode {
				return validationErr("JSON mode requires explicit hook fields.", op, "submit options",
					"Provide the hook name, description, event, handler, and execution settings.")
			}
			if !flagMode {
				return validationErr("JSON mode requires explicit hook fields.", op, "submit options",
					"Provide the hook name, description, event, handler, and execution settings.")
			}
			effHandlerType := *handlerType
			if effHandlerType == "" {
				if *handlerURL != "" {
					effHandlerType = "http"
				} else {
					effHandlerType = "command"
				}
			}
			effExecution := orDefault(*executionMode, "async")
			effScope := orDefault(*scope, "agent")
			for _, check := range []struct {
				value, label, resource string
				allowed                []string
			}{
				{*event, "event", "event", validHookEvents},
				{effHandlerType, "handler type", "handler type", []string{"command", "http"}},
				{effExecution, "execution mode", "execution mode", []string{"async", "sync", "blocking"}},
				{effScope, "scope", "scope", []string{"agent", "session", "global"}},
			} {
				if check.value != "" && !contains(check.allowed, check.value) {
					return validationErr(fmt.Sprintf("Unknown hook %s: %s.", check.label, check.value), op,
						check.resource, "Choose one of: "+strings.Join(check.allowed, ", ")+".")
				}
			}
			if cerr := requireHarnesses(*harnesses, op); cerr != nil {
				return cerr
			}
			if cerr := requireRegistryHookHarnesses(*harnesses, op); cerr != nil {
				return cerr
			}
			if *name == "" || *description == "" || *event == "" {
				return validationErr("Hook name, description, and event are required without prompts.", op,
					"hook payload", "Provide the required fields and retry.")
			}
			timeoutValue := *timeout
			if timeoutValue == 0 {
				timeoutValue = 10
			}
			if cerr := validateHookTimeout(timeoutValue, effExecution); cerr != nil {
				return cerr
			}
			var handlerConfig map[string]any
			if effHandlerType == "http" {
				if *handlerURL == "" {
					return validationErr("An HTTP handler URL is required for an HTTP hook.", op,
						"handler URL", "Provide a handler URL and retry.")
				}
				handlerConfig = map[string]any{"url": *handlerURL, "timeout": timeoutValue}
			} else {
				command := orDefault(*handlerCommand, scriptFilename)
				if command == "" {
					return validationErr("A handler command or script is required for a command hook.", op,
						"handler command", "Provide a handler command or script and retry.")
				}
				handlerConfig = map[string]any{"command": command, "timeout": timeoutValue}
			}
			payload = map[string]any{
				"name":                *name,
				"version":             orDefault(*version, "1.0.0"),
				"description":         *description,
				"owner":               configUsername(),
				"event":               *event,
				"handler_type":        effHandlerType,
				"handler_config":      handlerConfig,
				"execution_mode":      effExecution,
				"scope":               effScope,
				"supported_harnesses": anyList(*harnesses),
			}
			if scriptContent != "" {
				payload["script_content"] = scriptContent
				payload["script_filename"] = scriptFilename
			}
			if *sourceURL != "" {
				payload["source_url"] = *sourceURL
				payload["source_ref"] = orDefault(*sourceRef, "main")
			}
			if *sourcePath != "" {
				payload["source_path"] = *sourcePath
			}
			if len(*requires) > 0 {
				payload["requirements"] = anyList(*requires)
			}
		}
		if version, ok := payload["version"].(string); ok {
			if cerr := requireVersion(version, "The hook version is invalid.", op); cerr != nil {
				return cerr
			}
		}
		if cerr := addPublishTarget(payload, *visibility, "registry hook submit"); cerr != nil {
			return cerr
		}
		return postSubmission(client, "hooks", payload, *draft, op, "hook registry", *mode,
			"Hook submitted!", "Draft saved!")
	}
	return cmd
}

func hookEditCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "edit NAME", Short: "Edit a draft, rejected, or pending hook submission", Args: cobra.ExactArgs(1)}
	fromFile := cmd.Flags().StringP("from-file", "f", "", "Load updates from JSON file")
	name := cmd.Flags().StringP("name", "n", "", "New listing name")
	description := cmd.Flags().StringP("description", "d", "", "New description")
	version := cmd.Flags().StringP("version", "v", "", "New version string")
	event := cmd.Flags().StringP("event", "e", "", "New event")
	mode := outputFlag(cmd)
	cmd.RunE = func(c *cobra.Command, args []string) error {
		const op = "Edit hook"
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		resolved, cerr := ref.ResolveRegistryReference(client, "hook", args[0], op, "hook registry")
		if cerr != nil {
			return cerr
		}
		var updates map[string]any
		if *fromFile != "" {
			updates, cerr = loadJSONObjectFile(*fromFile, op, "hook update file")
			if cerr != nil {
				return cerr
			}
		} else {
			updates = map[string]any{}
			for key, pair := range map[string]struct {
				flag  *string
				fname string
			}{
				"name": {name, "name"}, "description": {description, "description"},
				"version": {version, "version"}, "event": {event, "event"},
			} {
				if c.Flags().Changed(pair.fname) {
					updates[key] = *pair.flag
				}
			}
		}
		if len(updates) == 0 {
			return validationErr("No hook changes were provided.", op, args[0],
				"Provide an update file or one or more field options.")
		}
		if eventValue, ok := updates["event"].(string); ok && eventValue != "" {
			if !contains(validHookEvents, eventValue) {
				return validationErr(fmt.Sprintf("Unknown hook event: %s.", eventValue), op, "event",
					"Choose one of: "+strings.Join(validHookEvents, ", ")+".")
			}
		}
		if versionValue, ok := updates["version"].(string); ok {
			if cerr := requireVersion(versionValue, "The hook version is invalid.", op); cerr != nil {
				return cerr
			}
		}
		return startEditAndPutDraft(client, "hooks", resolved, updates, op, "hook registry", *mode)
	}
	return cmd
}

// ── prompt submit / edit ───────────────────────────────────────────

func promptSubmitCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "submit", Short: "Submit a prompt to the registry", Args: cobra.NoArgs}
	fromFile := cmd.Flags().StringP("from-file", "f", "", "JSON payload or raw template file")
	name := cmd.Flags().StringP("name", "n", "", "Prompt name")
	version := cmd.Flags().StringP("version", "v", "", "Version")
	description := cmd.Flags().StringP("description", "d", "", "Description")
	category := cmd.Flags().StringP("category", "c", "", "Category")
	template := cmd.Flags().StringP("template", "t", "", "Template text")
	draft := cmd.Flags().Bool("draft", false, "Save as a draft instead of submitting")
	submitDraft := cmd.Flags().String("submit", "", "Submit a draft for review (prompt ID)")
	visibility := cmd.Flags().String("visibility", "", "Visibility: project or private")
	mode := outputFlag(cmd)
	cmd.RunE = func(c *cobra.Command, _ []string) error {
		const op = "Submit prompt"
		if *draft && *submitDraft != "" {
			return draftSubmitConflict(op)
		}
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		if *submitDraft != "" {
			return submitDraftReference(client, "prompt", "prompts", *submitDraft, op, "prompt registry", *mode)
		}
		flagMode := *name != "" || *version != "" || *description != "" || *category != "" || *template != ""
		var payload map[string]any
		switch {
		case *fromFile != "":
			content, cerr := readTextFile(*fromFile, "The prompt submission file was not found.", op,
				"Provide an existing file and retry.")
			if cerr != nil {
				return cerr
			}
			var parsed any
			if json.Unmarshal([]byte(content), &parsed) == nil {
				if object, ok := parsed.(map[string]any); ok {
					payload = object
					if _, has := payload["owner"]; !has {
						payload["owner"] = configUsername()
					}
				}
			}
			if payload == nil {
				// The file is a raw template.
				if !flagMode {
					return validationErr("JSON mode requires prompt metadata for a template file.", op, *fromFile,
						"Provide name, description, and template metadata options.")
				}
				templateValue := orDefault(*template, content)
				payload = map[string]any{
					"name":        *name,
					"version":     orDefault(*version, "1.0.0"),
					"description": *description,
					"owner":       configUsername(),
					"category":    orDefault(*category, "general"),
					"template":    templateValue,
				}
			}
		case flagMode:
			payload = map[string]any{
				"name":        *name,
				"version":     orDefault(*version, "1.0.0"),
				"description": *description,
				"owner":       configUsername(),
				"category":    orDefault(*category, "general"),
				"template":    *template,
			}
		default:
			return validationErr("JSON mode requires explicit prompt fields.", op, "submit options",
				"Provide name, description, category, and template options.")
		}
		if flagMode || *fromFile == "" {
			nameValue, _ := payload["name"].(string)
			descValue, _ := payload["description"].(string)
			templateValue, _ := payload["template"].(string)
			if *fromFile == "" || !jsonPayloadFile(payload) {
				if nameValue == "" || descValue == "" || templateValue == "" {
					return validationErr("Prompt name, description, and template are required without prompts.", op,
						"prompt payload", "Provide the required fields and retry.")
				}
			}
		}
		if categoryValue, ok := payload["category"].(string); ok && categoryValue != "" {
			norm, valid := promptcat.Normalize(categoryValue)
			if !valid {
				return validationErr(fmt.Sprintf("Invalid prompt category: %s.", categoryValue), op, "category",
					"Use lowercase letters, digits, and hyphens (max 32 characters), or one of: "+strings.Join(validPromptCategories, ", ")+".")
			}
			payload["category"] = norm
		}
		if versionValue, ok := payload["version"].(string); ok {
			if cerr := requireVersion(versionValue, "The prompt version is invalid.", op); cerr != nil {
				return cerr
			}
		}
		if cerr := addPublishTarget(payload, *visibility, "registry prompt submit"); cerr != nil {
			return cerr
		}
		return postSubmission(client, "prompts", payload, *draft, op, "prompt registry", *mode,
			"Prompt submitted!", "Draft saved!")
	}
	return cmd
}

// jsonPayloadFile reports whether the payload came from a JSON object file.
func jsonPayloadFile(payload map[string]any) bool {
	_, hasOwner := payload["owner"]
	return hasOwner
}

func promptEditCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "edit NAME", Short: "Edit a draft, rejected, or pending prompt submission", Args: cobra.ExactArgs(1)}
	fromFile := cmd.Flags().StringP("from-file", "f", "", "Load updates from JSON file")
	name := cmd.Flags().StringP("name", "n", "", "New listing name")
	description := cmd.Flags().StringP("description", "d", "", "New description")
	version := cmd.Flags().StringP("version", "v", "", "New version string")
	category := cmd.Flags().StringP("category", "c", "", "New category")
	template := cmd.Flags().StringP("template", "t", "", "New template text")
	mode := outputFlag(cmd)
	cmd.RunE = func(c *cobra.Command, args []string) error {
		const op = "Edit prompt"
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		resolved, cerr := ref.ResolveRegistryReference(client, "prompt", args[0], op, "prompt registry")
		if cerr != nil {
			return cerr
		}
		var updates map[string]any
		if *fromFile != "" {
			updates, cerr = loadJSONObjectFile(*fromFile, op, "prompt update file")
			if cerr != nil {
				return cerr
			}
		} else {
			updates = map[string]any{}
			for key, pair := range map[string]struct {
				flag  *string
				fname string
			}{
				"name": {name, "name"}, "description": {description, "description"},
				"version": {version, "version"}, "category": {category, "category"},
				"template": {template, "template"},
			} {
				if c.Flags().Changed(pair.fname) {
					updates[key] = *pair.flag
				}
			}
		}
		if len(updates) == 0 {
			return validationErr("No prompt changes were provided.", op, args[0],
				"Provide an update file or one or more field options.")
		}
		if categoryValue, ok := updates["category"].(string); ok && categoryValue != "" {
			norm, valid := promptcat.Normalize(categoryValue)
			if !valid {
				return validationErr(fmt.Sprintf("Invalid prompt category: %s.", categoryValue), op, "category",
					"Use lowercase letters, digits, and hyphens (max 32 characters), or one of: "+strings.Join(validPromptCategories, ", ")+".")
			}
			updates["category"] = norm
		}
		if versionValue, ok := updates["version"].(string); ok {
			if cerr := requireVersion(versionValue, "The prompt version is invalid.", op); cerr != nil {
				return cerr
			}
		}
		return startEditAndPutDraft(client, "prompts", resolved, updates, op, "prompt registry", *mode)
	}
	return cmd
}
