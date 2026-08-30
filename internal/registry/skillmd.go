// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

var (
	slashCommandRE = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
	frontmatterRE  = regexp.MustCompile(`(?s)^---\r?\n(.*?)\r?\n---(?:\r?\n|$)`)
	leadingFenceRE = regexp.MustCompile(`^---\r?\n`)
)

// normalizeSlashCommand canonicalizes a slash command name; empty means none.
func normalizeSlashCommand(value string) (string, *apiError) {
	if value == "" {
		return "", nil
	}
	command := strings.TrimPrefix(value, "/")
	if !slashCommandRE.MatchString(command) {
		return "", &apiError{Status: 422,
			Detail: "Invalid slash command: slash_command must match ^[a-z0-9][a-z0-9_-]{0,63}$"}
	}
	return command, nil
}

// skillFrontmatterMap parses a SKILL.md frontmatter block into a mapping.
// Missing frontmatter yields an empty map; malformed frontmatter is an error.
func skillFrontmatterMap(content string) (map[string]any, *apiError) {
	if content == "" || !leadingFenceRE.MatchString(content) {
		return map[string]any{}, nil
	}
	match := frontmatterRE.FindStringSubmatch(content)
	if match == nil {
		return nil, &apiError{Status: 422, Detail: "Malformed SKILL.md frontmatter"}
	}
	var parsed map[string]any
	if err := yaml.Unmarshal([]byte(match[1]), &parsed); err != nil {
		var scalar any
		if yaml.Unmarshal([]byte(match[1]), &scalar) == nil && scalar != nil {
			return nil, &apiError{Status: 422, Detail: "SKILL.md frontmatter must be a YAML mapping"}
		}
		return nil, &apiError{Status: 422, Detail: "Malformed SKILL.md frontmatter"}
	}
	if parsed == nil {
		parsed = map[string]any{}
	}
	return parsed, nil
}

// analyzeSkillMD validates stored SKILL.md frontmatter without rewriting the
// content: absent frontmatter is accepted, present frontmatter must be a YAML
// mapping, and a frontmatter command must agree with the request's.
func analyzeSkillMD(content, requestCommand string) (string, *apiError) {
	normalized, err := normalizeSlashCommand(requestCommand)
	if err != nil {
		return "", err
	}
	if content == "" || !leadingFenceRE.MatchString(content) {
		return normalized, nil
	}
	match := frontmatterRE.FindStringSubmatch(content)
	if match == nil {
		return "", &apiError{Status: 422, Detail: "Malformed SKILL.md frontmatter"}
	}
	var parsed map[string]any
	if err := yaml.Unmarshal([]byte(match[1]), &parsed); err != nil {
		// Non-mapping YAML lands here too; distinguish scalars from bad syntax.
		var scalar any
		if yaml.Unmarshal([]byte(match[1]), &scalar) == nil && scalar != nil {
			return "", &apiError{Status: 422, Detail: "SKILL.md frontmatter must be a YAML mapping"}
		}
		return "", &apiError{Status: 422, Detail: "Malformed SKILL.md frontmatter"}
	}

	frontmatterCommand := ""
	if raw, present := parsed["command"]; present {
		s, ok := raw.(string)
		if !ok || s == "" {
			return "", &apiError{Status: 422,
				Detail: "Invalid slash command: command must match ^[a-z0-9][a-z0-9_-]{0,63}$"}
		}
		frontmatterCommand, err = normalizeSlashCommand(s)
		if err != nil {
			return "", err
		}
	}
	if normalized != "" && frontmatterCommand != "" && normalized != frontmatterCommand {
		return "", &apiError{Status: 422, Detail: "slash_command does not match SKILL.md frontmatter command"}
	}
	if frontmatterCommand != "" {
		return frontmatterCommand, nil
	}
	return normalized, nil
}
