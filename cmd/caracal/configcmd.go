// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
	"github.com/garudex-labs/caracal/internal/cli/config"
)

// visibleConfigKeys are shown by `config show`; credentials never appear.
var visibleConfigKeys = []string{
	"server_url", "timeout", "update_check", "update_check_interval",
	"update_check_repo", "default_org", "default_project", "user_id", "user_name", "username", "web_url",
}

// userConfigKeys are the settings `config set` accepts.
var userConfigKeys = map[string]bool{
	"server_url": true, "timeout": true, "update_check": true,
	"update_check_interval": true, "update_check_repo": true, "default_org": true,
}

// configSetDocument and configPathDocument mirror the config JSON contracts.
type configSetDocument struct {
	Key       string `json:"key"`
	Value     any    `json:"value"`
	Persisted bool   `json:"persisted"`
	Effective any    `json:"effective"`
}

type configPathDocument struct {
	Path   string `json:"path"`
	Exists bool   `json:"exists"`
}

func configCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "config", Short: "CLI configuration"}
	cmd.AddCommand(configShowCommand(), configSetCommand(), configPathCommand(), configAliasCommand(), configAliasesCommand())
	return cmd
}

func configShowCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "show",
		Short: "Show effective CLI configuration without exposing credentials",
	}
	mode := outputFlag(cmd)
	cmd.RunE = func(_ *cobra.Command, _ []string) error {
		cfg, cerr := config.Load()
		if cerr != nil {
			return cerr
		}
		// Absent keys are omitted; credentials appear only as presence flags.
		keys := []string{}
		safe := map[string]any{}
		for _, key := range visibleConfigKeys {
			if value, ok := cfg[key]; ok {
				keys = append(keys, key)
				safe[key] = value
			}
		}
		for _, flag := range []struct {
			name, source string
		}{
			{"access_token_configured", "access_token"},
			{"session_token_configured", "session_token"},
		} {
			keys = append(keys, flag.name)
			value, _ := cfg[flag.source].(string)
			safe[flag.name] = value != ""
		}
		if *mode == "json" {
			// The safe view preserves the visible-key order of the contract.
			var doc bytes.Buffer
			doc.WriteByte('{')
			for i, key := range keys {
				if i > 0 {
					doc.WriteByte(',')
				}
				keyBlob, _ := json.Marshal(key)
				valueBlob, _ := json.Marshal(safe[key])
				doc.Write(keyBlob)
				doc.WriteByte(':')
				doc.Write(valueBlob)
			}
			doc.WriteByte('}')
			outputJSONRaw(doc.Bytes())
			return nil
		}
		for _, key := range keys {
			value := safe[key]
			rendered := ""
			switch v := value.(type) {
			case nil:
			case bool:
				rendered = strconv.FormatBool(v)
			case float64:
				rendered = strconv.FormatFloat(v, 'f', -1, 64)
			default:
				rendered = fmt.Sprint(v)
			}
			fmt.Printf("%-24s %s\n", key, rendered)
		}
		return nil
	}
	return cmd
}

func normalizeConfigValue(key, value string) (any, *clierr.Error) {
	if !userConfigKeys[key] {
		keys := make([]string, 0, len(userConfigKeys))
		for k := range userConfigKeys {
			keys = append(keys, k)
		}
		sortStrings(keys)
		return nil, &clierr.Error{
			Category: clierr.Validation, Message: key + " is not a user-configurable setting.",
			Operation: "Update CLI configuration", Resource: key,
			Remediation: "Choose one of: " + strings.Join(keys, ", ") + ".",
		}
	}
	normalized := strings.TrimSpace(value)
	switch key {
	case "server_url":
		parsed, err := url.Parse(normalized)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") ||
			parsed.Hostname() == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
			return nil, &clierr.Error{
				Category:  clierr.Validation,
				Message:   "server_url must be an HTTP or HTTPS URL without embedded credentials.",
				Operation: "Update CLI configuration", Resource: key,
				Remediation: "Provide a URL such as https://caracal.example.com.",
			}
		}
		return strings.TrimRight(normalized, "/"), nil
	case "timeout", "update_check_interval":
		number, err := strconv.Atoi(normalized)
		if err != nil {
			number = 0
		}
		minimum := 1
		if key == "update_check_interval" {
			minimum = 60
		}
		if number < minimum {
			return nil, &clierr.Error{
				Category:  clierr.Validation,
				Message:   fmt.Sprintf("%s must be an integer of at least %d.", key, minimum),
				Operation: "Update CLI configuration", Resource: key,
				Remediation: fmt.Sprintf("Provide an integer value of %d or higher.", minimum),
			}
		}
		return number, nil
	case "update_check":
		switch strings.ToLower(normalized) {
		case "true", "1", "yes", "on":
			return true, nil
		case "false", "0", "no", "off":
			return false, nil
		}
		return nil, &clierr.Error{
			Category: clierr.Validation, Message: key + " must be a boolean value.",
			Operation: "Update CLI configuration", Resource: key,
			Remediation: "Use true or false.",
		}
	}
	return normalized, nil
}

func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}

func configSetCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "set KEY VALUE",
		Short: "Set a validated user-managed CLI setting",
		Args:  cobra.ExactArgs(2),
	}
	mode := outputFlag(cmd)
	cmd.RunE = func(_ *cobra.Command, args []string) error {
		key, value := args[0], args[1]
		normalized, cerr := normalizeConfigValue(key, value)
		if cerr != nil {
			return cerr
		}
		if cerr := config.Save(map[string]any{key: normalized}); cerr != nil {
			return cerr
		}
		cfg, cerr := config.Load()
		if cerr != nil {
			return cerr
		}
		result := configSetDocument{Key: key, Value: normalized, Persisted: true, Effective: cfg[key]}
		if *mode == "json" {
			outputJSON(result)
			return nil
		}
		fmt.Printf("Set %s.\n", key)
		return nil
	}
	return cmd
}

func configPathCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "path",
		Short: "Show the config file path",
	}
	mode := outputFlag(cmd)
	cmd.RunE = func(_ *cobra.Command, _ []string) error {
		_, err := os.Stat(config.File())
		result := configPathDocument{Path: config.File(), Exists: err == nil}
		if *mode == "json" {
			outputJSON(result)
			return nil
		}
		fmt.Println(config.File())
		return nil
	}
	return cmd
}

// aliasNameRule bounds local alias names to a safe reference charset.
var aliasNameRule = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.-]{0,63}$`)

// aliasResult mirrors the alias mutation JSON contract field order.
type aliasResult struct {
	Action  string  `json:"action"`
	Alias   string  `json:"alias"`
	Target  *string `json:"target"`
	Changed bool    `json:"changed"`
}

func configAliasCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "alias NAME [TARGET]",
		Short: "Set or remove a local registry reference alias",
		Args:  cobra.RangeArgs(1, 2),
	}
	mode := outputFlag(cmd)
	cmd.RunE = func(_ *cobra.Command, args []string) error {
		name := args[0]
		if !aliasNameRule.MatchString(name) {
			return &clierr.Error{
				Category:  clierr.Validation,
				Message:   "Alias names must start with a letter and contain only letters, numbers, dots, underscores, or hyphens.",
				Operation: "Update CLI alias", Resource: name,
				Remediation: "Choose an alias of at most 64 characters without spaces or a leading at sign.",
			}
		}
		aliases, cerr := config.LoadAliases()
		if cerr != nil {
			return cerr
		}
		var result aliasResult
		var message string
		if len(args) == 2 {
			target := strings.TrimSpace(args[1])
			if target == "" {
				return &clierr.Error{
					Category: clierr.Validation, Message: "Alias targets must not be empty.",
					Operation: "Update CLI alias", Resource: name,
					Remediation: "Provide a UUID, namespace/slug, name, or another supported reference.",
				}
			}
			changed := aliases[name] != target
			aliases[name] = target
			if changed {
				if cerr := config.SaveAliases(aliases); cerr != nil {
					return cerr
				}
			}
			result = aliasResult{Action: "set", Alias: name, Target: &target, Changed: changed}
			message = fmt.Sprintf("@%s → %s", name, target)
		} else {
			removed, existed := aliases[name]
			if existed {
				delete(aliases, name)
				if cerr := config.SaveAliases(aliases); cerr != nil {
					return cerr
				}
			}
			result = aliasResult{Action: "removed", Alias: name, Changed: existed}
			if existed {
				result.Target = &removed
				message = fmt.Sprintf("Removed @%s", name)
			} else {
				message = fmt.Sprintf("Alias @%s was already absent", name)
			}
		}
		if *mode == "json" {
			outputJSON(result)
			return nil
		}
		fmt.Println(message)
		return nil
	}
	return cmd
}

// aliasListing mirrors the aliases list JSON contract field order.
type aliasListing struct {
	Items    []aliasItem `json:"items"`
	Total    int         `json:"total"`
	Page     int         `json:"page"`
	PageSize int         `json:"page_size"`
}

type aliasItem struct {
	Alias  string `json:"alias"`
	Target string `json:"target"`
}

func configAliasesCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "aliases",
		Short: "List all local aliases",
	}
	mode := outputFlag(cmd)
	cmd.RunE = func(_ *cobra.Command, _ []string) error {
		aliases, cerr := config.LoadAliases()
		if cerr != nil {
			return cerr
		}
		names := make([]string, 0, len(aliases))
		for name := range aliases {
			names = append(names, name)
		}
		sortStrings(names)
		items := make([]aliasItem, 0, len(names))
		for _, name := range names {
			items = append(items, aliasItem{Alias: name, Target: aliases[name]})
		}
		if *mode == "json" {
			outputJSON(aliasListing{Items: items, Total: len(items), Page: 1, PageSize: len(items)})
			return nil
		}
		if len(items) == 0 {
			fmt.Println("No aliases set. Use: caracal config alias <name> <reference>")
			return nil
		}
		for _, item := range items {
			fmt.Printf("@%-24s %s\n", item.Alias, item.Target)
		}
		return nil
	}
	return cmd
}
