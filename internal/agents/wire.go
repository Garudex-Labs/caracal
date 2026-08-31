// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"time"

	"github.com/garudex-labs/caracal/internal/registry"
)

// agentSummary is the list-item wire shape, in contract field order.
type agentSummary struct {
	ID                         string  `json:"id"`
	Name                       string  `json:"name"`
	Namespace                  string  `json:"namespace"`
	Slug                       string  `json:"slug"`
	QualifiedName              string  `json:"qualified_name"`
	Version                    string  `json:"version"`
	Description                string  `json:"description"`
	Owner                      string  `json:"owner"`
	ProjectID                  *string `json:"project_id"`
	Visibility                 string  `json:"visibility"`
	IsPrivate                  bool    `json:"is_private"`
	ModelName                  string  `json:"model_name"`
	SupportedHarnesses         []any   `json:"supported_harnesses"`
	RequiredCapabilities       []any   `json:"required_capabilities"`
	InferredSupportedHarnesses []any   `json:"inferred_supported_harnesses"`
	Status                     string  `json:"status"`
	RejectionReason            *string `json:"rejection_reason"`
	DownloadCount              int64   `json:"download_count"`
	ComponentCount             int64   `json:"component_count"`
	CreatedBy                  *string `json:"created_by"`
	CreatedByEmail             string  `json:"created_by_email"`
	CreatedByUsername          *string `json:"created_by_username"`
	CreatedAt                  any     `json:"created_at"`
	DeletedAt                  any     `json:"deleted_at"`
	ScheduledPurgeAt           any     `json:"scheduled_purge_at"`
	UpdatedAt                  any     `json:"updated_at"`
	ComponentsReady            bool    `json:"components_ready"`
	BlockingComponents         []any   `json:"blocking_components"`
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

func rowInt(row map[string]any, key string) int64 {
	switch n := row[key].(type) {
	case int64:
		return n
	case int32:
		return int64(n)
	case int16:
		return int64(n)
	}
	return 0
}

func rowBool(row map[string]any, key string) bool {
	b, _ := row[key].(bool)
	return b
}

func rowTime(row map[string]any, key string) (time.Time, bool) {
	t, ok := row[key].(time.Time)
	if !ok || t.IsZero() {
		return time.Time{}, false
	}
	return t.UTC(), true
}

func visibility(row map[string]any) string {
	if rowStr(row, "ownership_scope", "") == "private" {
		return "private"
	}
	return "project"
}

// summarize renders one scanned row as the summary shape. The lifecycle
// defaults mirror the versionless-agent compat values.
func summarize(row map[string]any) agentSummary {
	ns := rowStr(row, "namespace", "")
	slug := rowStr(row, "slug", "")
	return agentSummary{
		ID:                         rowStr(row, "id", ""),
		Name:                       rowStr(row, "name", ""),
		Namespace:                  ns,
		Slug:                       slug,
		QualifiedName:              ns + "/" + slug,
		Version:                    rowStr(row, "version", "0.0.0"),
		Description:                rowStr(row, "description", ""),
		Owner:                      rowStr(row, "owner", ""),
		ProjectID:                  rowNStr(row, "project_id"),
		Visibility:                 visibility(row),
		IsPrivate:                  rowBool(row, "is_private"),
		ModelName:                  rowStr(row, "model_name", ""),
		SupportedHarnesses:         rowList(row, "supported_harnesses"),
		RequiredCapabilities:       []any{},
		InferredSupportedHarnesses: []any{},
		Status:                     rowStr(row, "status", "draft"),
		RejectionReason:            rowNStr(row, "rejection_reason"),
		DownloadCount:              rowInt(row, "download_count"),
		ComponentCount:             rowInt(row, "component_count"),
		CreatedBy:                  rowNStr(row, "created_by"),
		CreatedByEmail:             rowStr(row, "created_by_email", ""),
		CreatedByUsername:          rowNStr(row, "created_by_username"),
		CreatedAt:                  registry.WireTime(row["created_at"]),
		DeletedAt:                  registry.WireTime(row["deleted_at"]),
		ScheduledPurgeAt:           registry.WireTime(row["scheduled_purge_at"]),
		UpdatedAt:                  registry.WireTime(row["updated_at"]),
		ComponentsReady:            true,
		BlockingComponents:         []any{},
	}
}
