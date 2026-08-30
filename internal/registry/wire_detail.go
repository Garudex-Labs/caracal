// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

// rowNList keeps genuinely NULL list columns null on the wire.
func rowNList(row map[string]any, key string) []any {
	if l, ok := row[key].([]any); ok {
		return l
	}
	return nil
}

func rowInt(row map[string]any, key string, fallback int) int {
	switch v := row[key].(type) {
	case int64:
		return int(v)
	case int32:
		return int(v)
	case int:
		return v
	}
	return fallback
}

// detailCore opens every show shape.
type detailCore struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Namespace     string `json:"namespace"`
	Slug          string `json:"slug"`
	QualifiedName string `json:"qualified_name"`
	Version       string `json:"version"`
}

// detailTrail closes every show shape up to the family-specific tail.
type detailTrail struct {
	Status          string  `json:"status"`
	RejectionReason *string `json:"rejection_reason"`
	SubmittedBy     string  `json:"submitted_by"`
	CreatedAt       any     `json:"created_at"`
	UpdatedAt       any     `json:"updated_at"`
}

func detailCoreOf(row map[string]any) detailCore {
	ns := rowStr(row, "namespace", "")
	slug := rowStr(row, "slug", "")
	return detailCore{
		ID:            rowStr(row, "id", ""),
		Name:          rowStr(row, "name", ""),
		Namespace:     ns,
		Slug:          slug,
		QualifiedName: ns + "/" + slug,
		Version:       rowStr(row, "version", "0.0.0"),
	}
}

func detailTrailOf(row map[string]any) detailTrail {
	return detailTrail{
		Status:          rowStr(row, "status", "draft"),
		RejectionReason: rowNStr(row, "rejection_reason"),
		SubmittedBy:     rowStr(row, "submitted_by", ""),
		CreatedAt:       wireTimeZ(row["created_at"]),
		UpdatedAt:       wireTimeZ(row["updated_at"]),
	}
}

type validationResult struct {
	Stage   string  `json:"stage"`
	Passed  bool    `json:"passed"`
	Details *string `json:"details"`
	RunAt   any     `json:"run_at"`
}

// namedEntry is the normalized env-var and header item shape.
type namedEntry struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Required    bool   `json:"required"`
}

func namedEntries(items []any) []namedEntry {
	if items == nil {
		return nil
	}
	out := make([]namedEntry, 0, len(items))
	for _, item := range items {
		entry := namedEntry{Required: true}
		if d, ok := item.(map[string]any); ok {
			entry.Name, _ = d["name"].(string)
			if desc, ok := d["description"].(string); ok {
				entry.Description = desc
			}
			if req, ok := d["required"].(bool); ok {
				entry.Required = req
			}
		}
		out = append(out, entry)
	}
	return out
}

type mcpDetail struct {
	detailCore
	GitURL      *string `json:"git_url"`
	Description string  `json:"description"`
	Category    string  `json:"category"`
	summaryTail
	SupportedHarnesses   []any        `json:"supported_harnesses"`
	EnvironmentVariables []namedEntry `json:"environment_variables"`
	SetupInstructions    *string      `json:"setup_instructions"`
	Changelog            *string      `json:"changelog"`
	Framework            *string      `json:"framework"`
	DockerImage          *string      `json:"docker_image"`
	Command              *string      `json:"command"`
	Args                 []any        `json:"args"`
	URL                  *string      `json:"url"`
	Headers              []namedEntry `json:"headers"`
	AutoApprove          []any        `json:"auto_approve"`
	McpValidated         bool         `json:"mcp_validated"`
	detailTrail
	CustomFields      []any              `json:"custom_fields"`
	ValidationResults []validationResult `json:"validation_results"`
	DownloadCount     int                `json:"download_count"`
	UserPermission    *string            `json:"user_permission"`
}

type skillDetail struct {
	detailCore
	Description string `json:"description"`
	summaryTail
	TaskType           string  `json:"task_type"`
	TargetAgents       []any   `json:"target_agents"`
	SupportedHarnesses []any   `json:"supported_harnesses"`
	SkillPath          string  `json:"skill_path"`
	GitURL             *string `json:"git_url"`
	GitRef             *string `json:"git_ref"`
	SkillMdContent     *string `json:"skill_md_content"`
	DeliveryMode       string  `json:"delivery_mode"`
	ScriptContent      *string `json:"script_content"`
	ScriptFilename     *string `json:"script_filename"`
	Validated          bool    `json:"validated"`
	SlashCommand       *string `json:"slash_command"`
	detailTrail
	DownloadCount  int     `json:"download_count"`
	UserPermission *string `json:"user_permission"`
}

type hookDetail struct {
	detailCore
	Description string `json:"description"`
	summaryTail
	Event              string         `json:"event"`
	ExecutionMode      string         `json:"execution_mode"`
	Priority           int            `json:"priority"`
	HandlerType        string         `json:"handler_type"`
	HandlerConfig      map[string]any `json:"handler_config"`
	Scope              string         `json:"scope"`
	SupportedHarnesses []any          `json:"supported_harnesses"`
	ScriptContent      *string        `json:"script_content"`
	ScriptFilename     *string        `json:"script_filename"`
	detailTrail
	DownloadCount  int     `json:"download_count"`
	UserPermission *string `json:"user_permission"`
}

type promptDetail struct {
	detailCore
	Description string `json:"description"`
	summaryTail
	Category           string `json:"category"`
	Template           string `json:"template"`
	Variables          []any  `json:"variables"`
	Tags               []any  `json:"tags"`
	SupportedHarnesses []any  `json:"supported_harnesses"`
	detailTrail
	DownloadCount  int     `json:"download_count"`
	UserPermission *string `json:"user_permission"`
}

type sandboxDetail struct {
	detailCore
	Description string `json:"description"`
	summaryTail
	RuntimeType        string         `json:"runtime_type"`
	Image              string         `json:"image"`
	ResourceLimits     map[string]any `json:"resource_limits"`
	NetworkPolicy      string         `json:"network_policy"`
	Entrypoint         *string        `json:"entrypoint"`
	RuntimeConfig      map[string]any `json:"runtime_config"`
	SourceURL          *string        `json:"source_url"`
	SourceRef          *string        `json:"source_ref"`
	ResolvedSha        *string        `json:"resolved_sha"`
	SandboxPath        *string        `json:"sandbox_path"`
	SupportedHarnesses []any          `json:"supported_harnesses"`
	detailTrail
	UserPermission *string `json:"user_permission"`
}

// detail renders one resolved row as its family's show shape; a nil
// permission stays null on the wire (draft creation never computes one).
func detail(f Family, row map[string]any, perm *string, validations []map[string]any) any {
	switch f.Prefix {
	case "mcps":
		results := make([]validationResult, 0, len(validations))
		for _, v := range validations {
			results = append(results, validationResult{
				Stage:   rowStr(v, "stage", ""),
				Passed:  rowBool(v, "passed"),
				Details: rowNStr(v, "details"),
				RunAt:   wireTimeZ(v["run_at"]),
			})
		}
		return mcpDetail{
			detailCore:           detailCoreOf(row),
			GitURL:               rowNStr(row, "source_url"),
			Description:          rowStr(row, "description", ""),
			Category:             rowStr(row, "category", ""),
			summaryTail:          tailOf(row),
			SupportedHarnesses:   rowList(row, "supported_harnesses"),
			EnvironmentVariables: append([]namedEntry{}, namedEntries(rowList(row, "environment_variables"))...),
			SetupInstructions:    rowNStr(row, "setup_instructions"),
			Changelog:            rowNStr(row, "changelog"),
			Framework:            rowNStr(row, "framework"),
			DockerImage:          rowNStr(row, "docker_image"),
			Command:              rowNStr(row, "command"),
			Args:                 rowNList(row, "args"),
			URL:                  rowNStr(row, "url"),
			Headers:              namedEntries(rowNList(row, "headers")),
			AutoApprove:          rowNList(row, "auto_approve"),
			McpValidated:         rowBool(row, "mcp_validated"),
			detailTrail:          detailTrailOf(row),
			CustomFields:         []any{},
			ValidationResults:    results,
			DownloadCount:        rowInt(row, "download_count", 0),
			UserPermission:       perm,
		}
	case "skills":
		return skillDetail{
			detailCore:         detailCoreOf(row),
			Description:        rowStr(row, "description", ""),
			summaryTail:        tailOf(row),
			TaskType:           rowStr(row, "task_type", ""),
			TargetAgents:       rowList(row, "target_agents"),
			SupportedHarnesses: rowList(row, "supported_harnesses"),
			SkillPath:          rowStr(row, "skill_path", "/"),
			GitURL:             rowNStr(row, "git_url"),
			GitRef:             rowNStr(row, "git_ref"),
			SkillMdContent:     rowNStr(row, "skill_md_content"),
			DeliveryMode:       rowStr(row, "delivery_mode", "git_fetch"),
			ScriptContent:      rowNStr(row, "script_content"),
			ScriptFilename:     rowNStr(row, "script_filename"),
			Validated:          rowBool(row, "validated"),
			SlashCommand:       rowNStr(row, "slash_command"),
			detailTrail:        detailTrailOf(row),
			DownloadCount:      rowInt(row, "download_count", 0),
			UserPermission:     perm,
		}
	case "hooks":
		return hookDetail{
			detailCore:         detailCoreOf(row),
			Description:        rowStr(row, "description", ""),
			summaryTail:        tailOf(row),
			Event:              rowStr(row, "event", ""),
			ExecutionMode:      rowStr(row, "execution_mode", "async"),
			Priority:           rowInt(row, "priority", 100),
			HandlerType:        rowStr(row, "handler_type", ""),
			HandlerConfig:      rowDict(row, "handler_config"),
			Scope:              rowStr(row, "scope", "agent"),
			SupportedHarnesses: rowList(row, "supported_harnesses"),
			ScriptContent:      rowNStr(row, "script_content"),
			ScriptFilename:     rowNStr(row, "script_filename"),
			detailTrail:        detailTrailOf(row),
			DownloadCount:      rowInt(row, "download_count", 0),
			UserPermission:     perm,
		}
	case "prompts":
		return promptDetail{
			detailCore:         detailCoreOf(row),
			Description:        rowStr(row, "description", ""),
			summaryTail:        tailOf(row),
			Category:           rowStr(row, "category", ""),
			Template:           rowStr(row, "template", ""),
			Variables:          rowList(row, "variables"),
			Tags:               rowList(row, "tags"),
			SupportedHarnesses: rowList(row, "supported_harnesses"),
			detailTrail:        detailTrailOf(row),
			DownloadCount:      rowInt(row, "download_count", 0),
			UserPermission:     perm,
		}
	default:
		return sandboxDetail{
			detailCore:         detailCoreOf(row),
			Description:        rowStr(row, "description", ""),
			summaryTail:        tailOf(row),
			RuntimeType:        rowStr(row, "runtime_type", ""),
			Image:              rowStr(row, "image", ""),
			ResourceLimits:     rowDict(row, "resource_limits"),
			NetworkPolicy:      rowStr(row, "network_policy", "none"),
			Entrypoint:         rowNStr(row, "entrypoint"),
			RuntimeConfig:      rowDict(row, "runtime_config"),
			SourceURL:          rowNStr(row, "source_url"),
			SourceRef:          rowNStr(row, "source_ref"),
			ResolvedSha:        rowNStr(row, "resolved_sha"),
			SandboxPath:        rowNStr(row, "sandbox_path"),
			SupportedHarnesses: rowList(row, "supported_harnesses"),
			detailTrail:        detailTrailOf(row),
			UserPermission:     perm,
		}
	}
}
