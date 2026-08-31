// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
	"github.com/garudex-labs/caracal/internal/cli/ref"
)

const agentYAMLFile = "caracal-agent.yaml"

var agentNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)
var slugifyDropRe = regexp.MustCompile(`[^a-z0-9_-]+`)

func slugifyAgentName(name string) string {
	name = strings.TrimSpace(strings.ToLower(name))
	name = slugifyDropRe.ReplaceAllString(name, "-")
	return strings.Trim(multiDashRe.ReplaceAllString(name, "-"), "-")
}

// ── caracal-agent.yaml emitter (matches the incumbent dump style) ──

func yamlScalar(value any) string {
	switch v := value.(type) {
	case nil:
		return "null"
	case bool:
		if v {
			return "true"
		}
		return "false"
	case string:
		return yamlString(v)
	case int:
		return fmt.Sprint(v)
	case json.Number:
		return v.String()
	case float64:
		return fmt.Sprint(v)
	default:
		blob, _ := json.Marshal(v)
		return string(blob)
	}
}

var yamlPlainRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 ._/@()+-]*$`)
var yamlAmbiguous = map[string]bool{
	"null": true, "Null": true, "NULL": true, "~": true,
	"true": true, "True": true, "false": true, "False": true,
	"yes": true, "no": true, "on": true, "off": true,
}

var yamlNumberRe = regexp.MustCompile(`^-?([0-9]+|[0-9]*\.[0-9]+([eE][-+]?[0-9]+)?)$`)

func yamlString(s string) string {
	if s == "" {
		return "''"
	}
	if strings.ContainsAny(s, "\n\t") {
		blob, _ := json.Marshal(s)
		return string(blob)
	}
	if !yamlAmbiguous[s] && yamlPlainRe.MatchString(s) && !strings.HasSuffix(s, " ") &&
		!strings.Contains(s, ": ") && !strings.Contains(s, " #") && !yamlNumberRe.MatchString(s) {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

// dumpAgentYAML renders the definition with block lists at column zero.
func dumpAgentYAML(doc *omap) string {
	var out strings.Builder
	for _, key := range doc.keys {
		value := doc.get(key)
		switch v := value.(type) {
		case []any:
			if len(v) == 0 {
				fmt.Fprintf(&out, "%s: []\n", key)
				continue
			}
			fmt.Fprintf(&out, "%s:\n", key)
			for _, item := range v {
				switch entry := item.(type) {
				case *omap:
					prefix := "- "
					for _, entryKey := range entry.keys {
						fmt.Fprintf(&out, "%s%s: %s\n", prefix, entryKey, yamlScalar(entry.get(entryKey)))
						prefix = "  "
					}
				default:
					fmt.Fprintf(&out, "- %s\n", yamlScalar(item))
				}
			}
		case *omap:
			if v.len() == 0 {
				fmt.Fprintf(&out, "%s: {}\n", key)
				continue
			}
			fmt.Fprintf(&out, "%s:\n", key)
			for _, subKey := range v.keys {
				fmt.Fprintf(&out, "  %s: %s\n", subKey, yamlScalar(v.get(subKey)))
			}
		case map[string]any:
			if len(v) == 0 {
				fmt.Fprintf(&out, "%s: {}\n", key)
				continue
			}
			blob, _ := json.Marshal(v)
			fmt.Fprintf(&out, "%s: %s\n", key, string(blob))
		default:
			fmt.Fprintf(&out, "%s: %s\n", key, yamlScalar(value))
		}
	}
	return out.String()
}

func saveAgentYAML(dirPath string, doc *omap, operation string) (string, *clierr.Error) {
	path := filepath.Join(dirPath, agentYAMLFile)
	if err := os.MkdirAll(dirPath, 0o755); err != nil {
		return "", &clierr.Error{
			Category: clierr.Unavailable, Message: fmt.Sprintf("Could not write agent definition: %s.", path),
			Operation: operation, Resource: path,
			Remediation: "Check directory permissions and available disk space.", Detail: err.Error(),
		}
	}
	tmp, err := os.CreateTemp(dirPath, "."+agentYAMLFile+".")
	if err == nil {
		_, err = tmp.WriteString(dumpAgentYAML(doc))
		if closeErr := tmp.Close(); err == nil {
			err = closeErr
		}
		if err == nil {
			err = os.Rename(tmp.Name(), path)
		}
	}
	if err != nil {
		return "", &clierr.Error{
			Category: clierr.Unavailable, Message: fmt.Sprintf("Could not write agent definition: %s.", path),
			Operation: operation, Resource: path,
			Remediation: "Check directory permissions and available disk space.", Detail: err.Error(),
		}
	}
	return path, nil
}

// loadAgentYAML reads caracal-agent.yaml preserving key order.
func loadAgentYAML(dirPath, operation string) (*omap, string, *clierr.Error) {
	path := filepath.Join(dirPath, agentYAMLFile)
	blob, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, path, &clierr.Error{
				Category: clierr.NotFound, Message: fmt.Sprintf("Agent definition not found: %s.", path),
				Operation: operation, Resource: path,
				Remediation: "Run `caracal agent init` or pass the directory containing caracal-agent.yaml.",
			}
		}
		return nil, path, &clierr.Error{
			Category: clierr.Unavailable, Message: fmt.Sprintf("Could not read agent definition: %s.", path),
			Operation: operation, Resource: path,
			Remediation: "Check file permissions and retry.", Detail: err.Error(),
		}
	}
	var node yaml.Node
	if err := yaml.Unmarshal(blob, &node); err != nil {
		return nil, path, &clierr.Error{
			Category: clierr.Validation, Message: fmt.Sprintf("Could not read agent definition: %s.", path),
			Operation: operation, Resource: path,
			Remediation: "Fix the YAML file and retry.", Detail: err.Error(),
		}
	}
	doc := yamlNodeToOmap(&node)
	object, ok := doc.(*omap)
	if !ok {
		return nil, path, &clierr.Error{
			Category: clierr.Validation, Message: "Agent definition must be a YAML mapping.",
			Operation: operation, Resource: path,
			Remediation: "Replace the file with a valid caracal-agent.yaml mapping.",
		}
	}
	return object, path, nil
}

func yamlNodeToOmap(node *yaml.Node) any {
	switch node.Kind {
	case yaml.DocumentNode:
		if len(node.Content) > 0 {
			return yamlNodeToOmap(node.Content[0])
		}
		return nil
	case yaml.MappingNode:
		object := newOmap()
		for i := 0; i+1 < len(node.Content); i += 2 {
			object.set(node.Content[i].Value, yamlNodeToOmap(node.Content[i+1]))
		}
		return object
	case yaml.SequenceNode:
		items := make([]any, 0, len(node.Content))
		for _, child := range node.Content {
			items = append(items, yamlNodeToOmap(child))
		}
		return items
	default:
		var value any
		_ = node.Decode(&value)
		return value
	}
}

// validateAgentDefinition normalizes and checks the authoring document.
func validateAgentDefinition(doc *omap, operation string) *clierr.Error {
	nameFail := func(message string) *clierr.Error {
		return &clierr.Error{
			Category: clierr.Validation, Message: message,
			Operation: operation, Resource: "agent name",
			Remediation: "Use lowercase letters, digits, hyphens, or underscores.",
		}
	}
	name, ok := doc.get("name").(string)
	if !ok || name == "" {
		return nameFail("Agent name is required.")
	}
	if len(name) > 64 {
		return nameFail("Agent name must be at most 64 characters.")
	}
	if !agentNameRe.MatchString(name) {
		return nameFail("Must start with a letter/digit and contain only lowercase letters, digits, hyphens, underscores.")
	}
	version := "1.0.0"
	if v := doc.get("version"); truthy(v) {
		version = fmt.Sprint(v)
	}
	if !pep440Re.MatchString(version) {
		return &clierr.Error{
			Category: clierr.Validation, Message: fmt.Sprintf("Invalid semantic version: %s.", version),
			Operation: operation, Resource: "agent version",
			Remediation: "Use a semantic version such as 1.2.3.",
		}
	}
	doc.set("version", version)
	if raw := doc.get("supported_harnesses"); raw != nil {
		items, ok := raw.([]any)
		if !ok {
			return &clierr.Error{
				Category: clierr.Validation, Message: "Agent supported_harnesses must be a list of names.",
				Operation: operation, Resource: "agent harnesses",
				Remediation: "Use a YAML list of registered harness names.",
			}
		}
		for _, item := range items {
			harness, ok := item.(string)
			if !ok {
				return &clierr.Error{
					Category: clierr.Validation, Message: "Agent supported_harnesses must be a list of names.",
					Operation: operation, Resource: "agent harnesses",
					Remediation: "Use a YAML list of registered harness names.",
				}
			}
			if !contains(validHarnesses, harness) {
				return &clierr.Error{
					Category: clierr.Validation, Message: fmt.Sprintf("Unknown harness: %s.", harness),
					Operation: operation, Resource: "agent harnesses",
					Remediation: "Choose from: " + strings.Join(validHarnesses, ", ") + ".",
				}
			}
		}
	}
	if raw := doc.get("components"); raw != nil {
		if _, ok := raw.([]any); !ok {
			return &clierr.Error{
				Category: clierr.Validation, Message: "Agent components must be a list.",
				Operation: operation, Resource: "agent components",
				Remediation: "Use a YAML list of component reference objects.",
			}
		}
	}
	return nil
}

// ── agent init ─────────────────────────────────────────────────────

func agentInitCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "init", Short: "Initialize an agent definition", Args: cobra.NoArgs}
	dirFlag := cmd.Flags().StringP("dir", "d", ".", "Target directory")
	beta := cmd.Flags().Bool("beta", false, "Start at version 0.1.0 (beta)")
	name := cmd.Flags().StringP("name", "n", "", "Agent name")
	version := cmd.Flags().StringP("version", "v", "", "Version")
	description := cmd.Flags().String("description", "", "Description")
	modelName := cmd.Flags().StringP("model", "m", "", "Model name")
	prompt := cmd.Flags().StringP("prompt", "p", "", "System prompt")
	promptFile := cmd.Flags().String("prompt-file", "", "Prompt file path")
	harnesses := cmd.Flags().StringArray("harness", nil, "Supported harness (repeat for multiple)")
	mode := outputFlag(cmd)
	cmd.RunE = func(c *cobra.Command, _ []string) error {
		const op = "Initialize agent definition"
		yamlPath := filepath.Join(*dirFlag, agentYAMLFile)
		flagMode := *name != "" || *version != "" || *description != "" || *modelName != "" ||
			*prompt != "" || *promptFile != "" || len(*harnesses) > 0 || *beta
		if *mode == "json" && !flagMode {
			return &clierr.Error{
				Category: clierr.Validation, Message: "JSON mode cannot run the interactive agent initializer.",
				Operation: op, Resource: yamlPath,
				Remediation: "Provide --name, --description, and --prompt or --prompt-file.",
			}
		}
		if _, err := os.Stat(yamlPath); err == nil {
			if *mode == "json" {
				return &clierr.Error{
					Category: clierr.Conflict, Message: fmt.Sprintf("Agent definition already exists: %s.", yamlPath),
					Operation: op, Resource: yamlPath,
					Remediation: "Choose an empty directory or remove the existing file deliberately.",
				}
			}
			if !confirmDanger(fmt.Sprintf("%s already exists in %s. Overwrite?", agentYAMLFile, *dirFlag)) {
				return abortErr(op)
			}
		}
		promptText := *prompt
		if *promptFile != "" {
			blob, err := os.ReadFile(*promptFile)
			if err != nil {
				if os.IsNotExist(err) {
					return &clierr.Error{
						Category: clierr.NotFound, Message: fmt.Sprintf("Prompt file not found: %s.", *promptFile),
						Operation: op, Resource: *promptFile,
						Remediation: "Check --prompt-file or provide --prompt directly.",
					}
				}
				return &clierr.Error{
					Category: clierr.Unavailable, Message: fmt.Sprintf("Could not read prompt file: %s.", *promptFile),
					Operation: op, Resource: *promptFile,
					Remediation: "Provide a readable UTF-8 prompt file.", Detail: err.Error(),
				}
			}
			promptText = string(blob)
		}
		defaultVersion := "1.0.0"
		if *beta {
			defaultVersion = "0.1.0"
		}
		finalName, finalVersion, finalDesc, finalModel := *name, *version, *description, *modelName
		if !flagMode {
			finalName = textInput("Agent name", "")
			finalVersion = textInput("Version", defaultVersion)
			finalDesc = textInput("Description", "")
			finalModel = textInput("Model name", "claude-sonnet-4")
			promptText = textInput("System prompt", "")
		} else if finalName == "" || finalDesc == "" || promptText == "" {
			return &clierr.Error{
				Category: clierr.Validation, Message: "--name, --description, and --prompt or --prompt-file are required.",
				Operation: op, Resource: "agent definition",
				Remediation: "Provide every required non-interactive field.",
			}
		}
		originalName := finalName
		finalName = slugifyAgentName(finalName)
		if finalName != originalName {
			fmt.Printf("  → Slugified to: %s\n", finalName)
		}
		if finalVersion == "" {
			finalVersion = defaultVersion
		}
		harnessList := *harnesses
		if len(harnessList) == 0 {
			harnessList = validHarnesses
		}
		doc := newOmap()
		doc.set("name", finalName)
		doc.set("version", finalVersion)
		doc.set("description", finalDesc)
		doc.set("owner", orDefault(configUsername(), "unknown"))
		doc.set("model_name", orDefault(finalModel, "claude-sonnet-4"))
		doc.set("model_config_json", newOmap())
		doc.set("models_by_harness", newOmap())
		doc.set("prompt", promptText)
		doc.set("supported_harnesses", anyList(harnessList))
		doc.set("components", []any{})
		doc.set("external_mcps", []any{})
		doc.set("success_criteria", nil)
		if cerr := validateAgentDefinition(doc, op); cerr != nil {
			return cerr
		}
		savedPath, cerr := saveAgentYAML(*dirFlag, doc, op)
		if cerr != nil {
			return cerr
		}
		if *mode == "json" {
			agentBlob, _ := marshalOrdered(doc)
			outputJSONRaw([]byte(fmt.Sprintf(`{"path": %s, "agent": %s}`, jsonString(savedPath), string(agentBlob))))
			return nil
		}
		fmt.Printf("Created %s\n", yamlPath)
		return nil
	}
	return cmd
}

// ── agent add ──────────────────────────────────────────────────────

func agentAddCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "add TYPE UUID", Short: "Add a component reference to the agent definition", Args: cobra.ExactArgs(2)}
	dirFlag := cmd.Flags().StringP("dir", "d", ".", "Target directory")
	mode := outputFlag(cmd)
	cmd.RunE = func(_ *cobra.Command, args []string) error {
		const op = "Add agent component"
		componentType := strings.ToLower(strings.TrimSpace(args[0]))
		if !contains([]string{"mcp", "skill", "hook", "prompt"}, componentType) {
			return &clierr.Error{
				Category: clierr.Validation, Message: fmt.Sprintf("Unknown agent component type: %s.", args[0]),
				Operation: op, Resource: "agent component type",
				Remediation: "Choose from: hook, mcp, prompt, skill.",
			}
		}
		parsed, err := uuid.Parse(args[1])
		if err != nil {
			return &clierr.Error{
				Category: clierr.Validation, Message: "Component ID must be a UUID.",
				Operation: op, Resource: "agent component",
				Remediation: "Copy the component ID from a Registry list JSON result.",
			}
		}
		componentID := parsed.String()
		doc, path, cerr := loadAgentYAML(*dirFlag, op)
		if cerr != nil {
			return cerr
		}
		components, ok := doc.get("components").([]any)
		if doc.get("components") != nil && !ok {
			return &clierr.Error{
				Category: clierr.Validation, Message: "Agent components must be a list.",
				Operation: op, Resource: path,
				Remediation: "Fix the components field and retry.",
			}
		}
		for _, rawEntry := range components {
			entry, _ := rawEntry.(*omap)
			if entry != nil && entry.str("component_type") == componentType && entry.str("component_id") == componentID {
				return &clierr.Error{
					Category: clierr.Conflict, Message: fmt.Sprintf("Component already exists: %s:%s.", componentType, componentID),
					Operation: op, Resource: path,
					Remediation: "Choose a different component or leave the definition unchanged.",
				}
			}
		}
		entry := newOmap()
		entry.set("component_type", componentType)
		entry.set("component_id", componentID)
		components = append(components, entry)
		doc.set("components", components)
		if _, cerr := saveAgentYAML(*dirFlag, doc, op); cerr != nil {
			return cerr
		}
		if *mode == "json" {
			entryBlob, _ := marshalOrdered(entry)
			outputJSONRaw([]byte(fmt.Sprintf(`{"path": %s, "component": %s}`, jsonString(path), string(entryBlob))))
			return nil
		}
		fmt.Printf("Added %s:%s\n", componentType, componentID)
		return nil
	}
	return cmd
}

// ── agent build ────────────────────────────────────────────────────

func agentBuildCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "build", Short: "Validate the agent definition against the registry", Args: cobra.NoArgs}
	dirFlag := cmd.Flags().StringP("dir", "d", ".", "Target directory")
	visibility := cmd.Flags().String("visibility", "", "Agent visibility: project or private")
	mode := outputFlag(cmd)
	cmd.RunE = func(_ *cobra.Command, _ []string) error {
		const op = "Validate agent"
		doc, path, cerr := loadAgentYAML(*dirFlag, op)
		if cerr != nil {
			return cerr
		}
		if cerr := validateAgentDefinition(doc, op); cerr != nil {
			return cerr
		}
		components, ok := doc.get("components").([]any)
		if doc.get("components") != nil && !ok {
			return &clierr.Error{
				Category: clierr.Validation, Message: "Agent components must be a list.",
				Operation: op, Resource: path,
				Remediation: "Fix the components field and retry.",
			}
		}
		agentName, _ := doc.get("name").(string)
		if len(components) == 0 {
			out := fmt.Sprintf(`{"valid": true, "agent": %s, "components": [], "issues": []}`, jsonString(agentName))
			if *mode == "json" {
				outputJSONRaw([]byte(out))
			} else {
				fmt.Println("No components to validate.")
			}
			return nil
		}
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		errorsList := []string{}
		componentResults := []string{}
		for _, rawEntry := range components {
			entry, _ := rawEntry.(*omap)
			if entry == nil {
				continue
			}
			ctype := entry.str("component_type")
			cid := entry.str("component_id")
			plural, known := recommendTypePlural[ctype]
			if !known {
				errorsList = append(errorsList, fmt.Sprintf("invalid component type: %s", ctype))
				componentResults = append(componentResults, fmt.Sprintf(`{"type": %s, "id": %s, "valid": false, "error": "invalid type"}`,
					jsonString(ctype), jsonString(cid)))
				continue
			}
			_, cerr := client.Do("GET", "/api/v1/"+plural+"/"+cid, nil, nil, op, "agent registry")
			if cerr != nil {
				if cerr.Category != clierr.NotFound {
					return cerr
				}
				errorsList = append(errorsList, fmt.Sprintf("%s:%s", ctype, cid))
				componentResults = append(componentResults, fmt.Sprintf(`{"type": %s, "id": %s, "valid": false, "error": "not found"}`,
					jsonString(ctype), jsonString(cid)))
				continue
			}
			componentResults = append(componentResults, fmt.Sprintf(`{"type": %s, "id": %s, "valid": true, "error": null}`,
				jsonString(ctype), jsonString(cid)))
		}
		scopePayload := map[string]any{"components": plainList(components)}
		if cerr := addPublishTarget(scopePayload, *visibility, "agent build"); cerr != nil {
			return cerr
		}
		validateRaw, cerr := client.Do("POST", "/api/v1/agents/validate", nil, scopePayload, op, "agent registry")
		if cerr != nil {
			return cerr
		}
		var validation struct {
			Issues []map[string]any `json:"issues"`
		}
		_ = json.Unmarshal(validateRaw, &validation)
		issues := []string{}
		for _, issue := range validation.Issues {
			message := "Component is not valid for this agent target"
			if text, ok := issue["message"].(string); ok && text != "" {
				message = text
			}
			issues = append(issues, message)
			errorsList = append(errorsList, message)
		}
		issueParts := make([]string, len(issues))
		for i, issue := range issues {
			issueParts[i] = jsonString(issue)
		}
		resultDoc := fmt.Sprintf(`{"valid": %t, "agent": %s, "components": [%s], "issues": [%s]}`,
			len(errorsList) == 0, jsonString(agentName), strings.Join(componentResults, ", "), strings.Join(issueParts, ", "))
		if len(errorsList) > 0 {
			return &clierr.Error{
				Category: clierr.Validation, Message: fmt.Sprintf("Agent validation failed with %d issue(s).", len(errorsList)),
				Operation: op, Resource: path,
				Remediation: "Fix the reported component references or target scope and retry.", Detail: resultDoc,
			}
		}
		if *mode == "json" {
			outputJSONRaw([]byte(resultDoc))
			return nil
		}
		fmt.Println("\nAll components valid.")
		return nil
	}
	return cmd
}

func plainList(items []any) []any {
	out := make([]any, len(items))
	for i, item := range items {
		out[i] = plain(item)
	}
	return out
}

// ── agent publish ──────────────────────────────────────────────────

func agentPublishPayload(doc *omap) *omap {
	payload := newOmap()
	getStr := func(key, fallback string) string {
		if value, ok := doc.get(key).(string); ok && value != "" {
			return value
		}
		return fallback
	}
	payload.set("name", doc.get("name"))
	payload.set("version", getStr("version", "1.0.0"))
	payload.set("description", getStr("description", ""))
	payload.set("owner", getStr("owner", ""))
	payload.set("model_name", getStr("model_name", "claude-sonnet-4"))
	if v := doc.get("models_by_harness"); truthy(v) {
		payload.set("models_by_harness", v)
	} else {
		payload.set("models_by_harness", newOmap())
	}
	payload.set("prompt", getStr("prompt", ""))
	if v, ok := doc.get("supported_harnesses").([]any); ok {
		payload.set("supported_harnesses", v)
	} else {
		payload.set("supported_harnesses", []any{})
	}
	if v, ok := doc.get("components").([]any); ok {
		payload.set("components", v)
	} else {
		payload.set("components", []any{})
	}
	payload.set("success_criteria", doc.get("success_criteria"))
	return payload
}

func agentPublishCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "publish", Short: "Publish the agent definition to the registry", Args: cobra.NoArgs}
	dirFlag := cmd.Flags().StringP("dir", "d", ".", "Target directory")
	update := cmd.Flags().BoolP("update", "u", false, "Update the existing agent with this name")
	draft := cmd.Flags().Bool("draft", false, "Save as a draft instead of submitting")
	submitDraft := cmd.Flags().String("submit", "", "Submit a draft agent for review (agent ID)")
	bump := cmd.Flags().String("bump", "", "Version bump type: patch, minor, or major (skips prompt)")
	visibility := cmd.Flags().String("visibility", "", "Visibility: project or private")
	mode := outputFlag(cmd)
	cmd.RunE = func(c *cobra.Command, _ []string) error {
		const op = "Publish agent"
		if *draft && *submitDraft != "" {
			return &clierr.Error{
				Category: clierr.Validation, Message: "--draft and --submit cannot be used together.",
				Operation: op, Resource: "agent publication mode",
				Remediation: "Use --draft to save a new draft or --submit to submit an existing draft.",
			}
		}
		if *bump != "" && *bump != "patch" && *bump != "minor" && *bump != "major" {
			return &clierr.Error{
				Category: clierr.Validation, Message: fmt.Sprintf("Unknown version bump: %s.", *bump),
				Operation: op, Resource: "agent version bump",
				Remediation: "Choose patch, minor, or major.",
			}
		}
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		if *submitDraft != "" {
			resolved, cerr := ref.ResolveRegistryReference(client, "agent", *submitDraft, op, "agent registry")
			if cerr != nil {
				return cerr
			}
			raw, cerr := client.Do("POST", "/api/v1/agents/"+resolved+"/submit", nil, nil, op, "agent registry")
			if cerr != nil {
				return cerr
			}
			if *mode == "json" {
				outputJSONRaw(raw)
				return nil
			}
			var result struct {
				ID any `json:"id"`
			}
			_ = json.Unmarshal(raw, &result)
			fmt.Printf("Draft submitted for review! ID: %v\n", result.ID)
			return nil
		}
		doc, _, cerr := loadAgentYAML(*dirFlag, op)
		if cerr != nil {
			return cerr
		}
		if cerr := validateAgentDefinition(doc, op); cerr != nil {
			return cerr
		}
		payload := agentPublishPayload(doc)
		if *update {
			if *visibility != "" {
				return &clierr.Error{
					Category: clierr.Validation, Message: "--visibility cannot be combined with --update.",
					Operation: op, Resource: "agent visibility",
					Remediation: "Run the update first, then change visibility separately.",
				}
			}
		} else {
			pmap := map[string]any{}
			if cerr := addPublishTarget(pmap, *visibility, "agent publish"); cerr != nil {
				return cerr
			}
			applyPublishTarget(payload, pmap)
		}
		if *draft {
			raw, cerr := client.Do("POST", "/api/v1/agents/draft", nil, payload, op, "agent registry")
			if cerr != nil {
				return cerr
			}
			if *mode == "json" {
				outputJSONRaw(raw)
				return nil
			}
			var result struct {
				ID any `json:"id"`
			}
			_ = json.Unmarshal(raw, &result)
			fmt.Printf("Draft saved! ID: %v\n", result.ID)
			return nil
		}
		if *update {
			name, _ := doc.get("name").(string)
			searchRaw, cerr := client.Do("GET", "/api/v1/agents", map[string]string{"search": name}, nil, op, "agent registry")
			if cerr != nil {
				return cerr
			}
			var candidates []struct {
				ID   any    `json:"id"`
				Name string `json:"name"`
			}
			_ = json.Unmarshal(searchRaw, &candidates)
			agentID := ""
			for _, candidate := range candidates {
				if candidate.Name == name {
					agentID = fmt.Sprint(candidate.ID)
					break
				}
			}
			if agentID == "" {
				return &clierr.Error{
					Category: clierr.NotFound, Message: fmt.Sprintf("No existing agent has the name %s.", name),
					Operation: op, Resource: "agent registry",
					Remediation: "Check the name or publish without --update.",
				}
			}
			if *bump != "" {
				payload.set("version_bump_type", *bump)
				payload.remove("version")
			}
			raw, cerr := client.Do("PUT", "/api/v1/agents/"+agentID, nil, payload, op, "agent registry")
			if cerr != nil {
				return cerr
			}
			if *mode == "json" {
				outputJSONRaw(raw)
				return nil
			}
			var result struct {
				ID      any    `json:"id"`
				Version string `json:"version"`
			}
			_ = json.Unmarshal(raw, &result)
			fmt.Printf("Agent updated! ID: %v  v%s\n", result.ID, orDefault(result.Version, "?"))
			return nil
		}
		raw, cerr := client.Do("POST", "/api/v1/agents", nil, payload, op, "agent registry")
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
		fmt.Printf("Agent submitted! ID: %v\n", result.ID)
		if orDefault(result.Status, "pending") != "approved" {
			fmt.Printf("Status: %s - an admin must approve it before it becomes visible.\n", orDefault(result.Status, "pending"))
		}
		return nil
	}
	return cmd
}

// ── agent release ──────────────────────────────────────────────────

func agentReleaseCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "release NAME", Short: "Release a new agent version from the local definition", Args: cobra.ExactArgs(1)}
	bump := cmd.Flags().String("bump", "", "Version bump: patch, minor, or major")
	dirFlag := cmd.Flags().StringP("dir", "d", ".", "Target directory")
	mode := outputFlag(cmd)
	cmd.RunE = func(c *cobra.Command, args []string) error {
		const op = "Release agent version"
		if !c.Flags().Changed("bump") {
			return usageError("agent release", "Missing option '--bump'.")
		}
		if *bump != "patch" && *bump != "minor" && *bump != "major" {
			return &clierr.Error{
				Category: clierr.Validation, Message: fmt.Sprintf("Unknown version bump: %s.", *bump),
				Operation: op, Resource: "agent version bump",
				Remediation: "Choose patch, minor, or major.",
			}
		}
		doc, _, cerr := loadAgentYAML(*dirFlag, op)
		if cerr != nil {
			return cerr
		}
		if cerr := validateAgentDefinition(doc, op); cerr != nil {
			return cerr
		}
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		resolved, cerr := ref.ResolveRegistryReference(client, "agent", args[0], op, "agent registry")
		if cerr != nil {
			return cerr
		}
		agentRaw, cerr := client.Do("GET", "/api/v1/agents/"+resolved, nil, nil, op, "agent registry")
		if cerr != nil {
			return cerr
		}
		var agent struct {
			ID any `json:"id"`
		}
		_ = json.Unmarshal(agentRaw, &agent)
		agentID := fmt.Sprint(agent.ID)
		suggestionsRaw, cerr := client.Do("GET", "/api/v1/agents/"+agentID+"/version-suggestions", nil, nil, op, "agent registry")
		if cerr != nil {
			return cerr
		}
		var suggestions struct {
			Suggestions map[string]string `json:"suggestions"`
		}
		_ = json.Unmarshal(suggestionsRaw, &suggestions)
		newVersion := suggestions.Suggestions[*bump]
		if newVersion == "" {
			return &clierr.Error{
				Category: clierr.Validation, Message: fmt.Sprintf("The server did not provide a %s version suggestion.", *bump),
				Operation: op, Resource: "agent version suggestions",
				Remediation: "Check the current version and retry.",
			}
		}
		if !pep440Re.MatchString(newVersion) {
			return &clierr.Error{
				Category: clierr.Validation, Message: fmt.Sprintf("Invalid semantic version: %s.", newVersion),
				Operation: op, Resource: "agent version",
				Remediation: "Use a semantic version such as 1.2.3.",
			}
		}
		doc.set("version", newVersion)
		rawYAML := dumpAgentYAML(doc)
		getStr := func(key, fallback string) string {
			if value, ok := doc.get(key).(string); ok && value != "" {
				return value
			}
			return fallback
		}
		payload := newOmap()
		payload.set("version", newVersion)
		payload.set("description", getStr("description", ""))
		payload.set("prompt", getStr("prompt", ""))
		payload.set("model_name", getStr("model_name", "claude-sonnet-4"))
		for _, pair := range []struct {
			key      string
			fallback any
		}{
			{"model_config_json", newOmap()}, {"models_by_harness", newOmap()},
			{"external_mcps", []any{}}, {"supported_harnesses", []any{}}, {"components", []any{}},
		} {
			if v := doc.get(pair.key); truthy(v) {
				payload.set(pair.key, v)
			} else {
				payload.set(pair.key, pair.fallback)
			}
		}
		payload.set("yaml_snapshot", rawYAML)
		payload.set("success_criteria", doc.get("success_criteria"))
		raw, cerr := client.Do("POST", "/api/v1/agents/"+agentID+"/versions", nil, payload, op, "agent registry")
		if cerr != nil {
			return cerr
		}
		if _, cerr := saveAgentYAML(*dirFlag, doc, "Record released agent version"); cerr != nil {
			return cerr
		}
		if *mode == "json" {
			return emitLocalDoc(raw, func(result *omap) {
				if !result.has("version") {
					result.set("version", newVersion)
				}
			})
		}
		fmt.Printf("Version %s submitted for review\n", newVersion)
		return nil
	}
	return cmd
}
