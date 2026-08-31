// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import "time"

// wireTimeZ renders UTC datetimes RFC 3339 with a Z suffix, microseconds
// only when nonzero. Non-time values (NULL columns) pass through as nil.
func wireTimeZ(v any) any {
	t, ok := v.(time.Time)
	if !ok {
		return nil
	}
	t = t.UTC()
	if t.Nanosecond() == 0 {
		return t.Format("2006-01-02T15:04:05Z")
	}
	return t.Format("2006-01-02T15:04:05.000000Z")
}

func rowStr(row map[string]any, key, fallback string) string {
	if s, ok := row[key].(string); ok {
		return s
	}
	return fallback
}

func rowNStr(row map[string]any, key string) *string {
	if s, ok := row[key].(string); ok {
		return &s
	}
	return nil
}

func rowList(row map[string]any, key string) []any {
	if l, ok := row[key].([]any); ok {
		return l
	}
	return []any{}
}

func rowDict(row map[string]any, key string) map[string]any {
	if d, ok := row[key].(map[string]any); ok {
		return d
	}
	return map[string]any{}
}

func rowBool(row map[string]any, key string) bool {
	b, _ := row[key].(bool)
	return b
}

// rowVisibility derives the two-state visibility label from the ownership
// scope: 'private' is owner-only, everything else is shared with the project.
func rowVisibility(row map[string]any) string {
	if rowStr(row, "ownership_scope", "") == "private" {
		return "private"
	}
	return "project"
}

type summaryCore struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Namespace     string `json:"namespace"`
	Slug          string `json:"slug"`
	QualifiedName string `json:"qualified_name"`
	Version       string `json:"version"`
	Description   string `json:"description"`
}

type summaryTail struct {
	Owner      string  `json:"owner"`
	ProjectID  *string `json:"project_id"`
	Visibility string  `json:"visibility"`
	IsPrivate  bool    `json:"is_private"`
}

type summaryStatus struct {
	Status          string  `json:"status"`
	RejectionReason *string `json:"rejection_reason"`
	UpdatedAt       any     `json:"updated_at"`
}

func coreOf(row map[string]any) summaryCore {
	ns := rowStr(row, "namespace", "")
	slug := rowStr(row, "slug", "")
	return summaryCore{
		ID:            rowStr(row, "id", ""),
		Name:          rowStr(row, "name", ""),
		Namespace:     ns,
		Slug:          slug,
		QualifiedName: ns + "/" + slug,
		Version:       rowStr(row, "version", "0.0.0"),
		Description:   rowStr(row, "description", ""),
	}
}

func tailOf(row map[string]any) summaryTail {
	return summaryTail{
		Owner:      rowStr(row, "owner", ""),
		ProjectID:  rowNStr(row, "project_id"),
		Visibility: rowVisibility(row),
		IsPrivate:  rowBool(row, "is_private"),
	}
}

func statusOf(row map[string]any) summaryStatus {
	return summaryStatus{
		Status:          rowStr(row, "status", "draft"),
		RejectionReason: rowNStr(row, "rejection_reason"),
		UpdatedAt:       wireTimeZ(row["updated_at"]),
	}
}

type mcpSummary struct {
	summaryCore
	Category string `json:"category"`
	summaryTail
	SupportedHarnesses []any `json:"supported_harnesses"`
	summaryStatus
}

type skillSummary struct {
	summaryCore
	TaskType string `json:"task_type"`
	summaryTail
	TargetAgents []any `json:"target_agents"`
	summaryStatus
}

type hookSummary struct {
	summaryCore
	Event string `json:"event"`
	Scope string `json:"scope"`
	summaryTail
	summaryStatus
}

type promptSummary struct {
	summaryCore
	Category string `json:"category"`
	summaryTail
	summaryStatus
}

// summarize renders one scanned row as its family's list-item shape.
func summarize(f Family, row map[string]any) any {
	switch f.Prefix {
	case "mcps":
		return mcpSummary{
			summaryCore:        coreOf(row),
			Category:           rowStr(row, "category", ""),
			summaryTail:        tailOf(row),
			SupportedHarnesses: rowList(row, "supported_harnesses"),
			summaryStatus:      statusOf(row),
		}
	case "skills":
		return skillSummary{
			summaryCore:   coreOf(row),
			TaskType:      rowStr(row, "task_type", ""),
			summaryTail:   tailOf(row),
			TargetAgents:  rowList(row, "target_agents"),
			summaryStatus: statusOf(row),
		}
	case "hooks":
		return hookSummary{
			summaryCore:   coreOf(row),
			Event:         rowStr(row, "event", ""),
			Scope:         rowStr(row, "scope", "agent"),
			summaryTail:   tailOf(row),
			summaryStatus: statusOf(row),
		}
	case "prompts":
		return promptSummary{
			summaryCore:   coreOf(row),
			Category:      rowStr(row, "category", ""),
			summaryTail:   tailOf(row),
			summaryStatus: statusOf(row),
		}
	default:
		return nil
	}
}
