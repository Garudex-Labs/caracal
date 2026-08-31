// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"github.com/garudex-labs/caracal/internal/registry"
)

type mcpLink struct {
	McpListingID string `json:"mcp_listing_id"`
	McpName      string `json:"mcp_name"`
	Order        int64  `json:"order"`
}

type componentLink struct {
	ComponentType  string         `json:"component_type"`
	ComponentID    string         `json:"component_id"`
	ComponentName  string         `json:"component_name"`
	Namespace      string         `json:"namespace"`
	Slug           string         `json:"slug"`
	QualifiedName  string         `json:"qualified_name"`
	VersionRef     string         `json:"version_ref"`
	Order          int64          `json:"order"`
	ConfigOverride map[string]any `json:"config_override"`
	Status         *string        `json:"status"`
}

// agentDetail is the show wire shape, in contract field order.
type agentDetail struct {
	ID                         string          `json:"id"`
	Name                       string          `json:"name"`
	Namespace                  string          `json:"namespace"`
	Slug                       string          `json:"slug"`
	QualifiedName              string          `json:"qualified_name"`
	Version                    string          `json:"version"`
	Description                string          `json:"description"`
	Owner                      string          `json:"owner"`
	ProjectID                  *string         `json:"project_id"`
	Visibility                 string          `json:"visibility"`
	IsPrivate                  bool            `json:"is_private"`
	Prompt                     string          `json:"prompt"`
	ModelName                  string          `json:"model_name"`
	ModelConfigJSON            map[string]any  `json:"model_config_json"`
	ModelsByHarness            map[string]any  `json:"models_by_harness"`
	ExternalMcps               []any           `json:"external_mcps"`
	SupportedHarnesses         []any           `json:"supported_harnesses"`
	RequiredCapabilities       []any           `json:"required_capabilities"`
	InferredSupportedHarnesses []any           `json:"inferred_supported_harnesses"`
	SuccessCriteria            map[string]any  `json:"success_criteria"`
	Status                     string          `json:"status"`
	RejectionReason            *string         `json:"rejection_reason"`
	CreatedBy                  string          `json:"created_by"`
	CreatedByEmail             string          `json:"created_by_email"`
	CreatedByUsername          *string         `json:"created_by_username"`
	CreatedAt                  any             `json:"created_at"`
	DeletedAt                  any             `json:"deleted_at"`
	UpdatedAt                  any             `json:"updated_at"`
	McpLinks                   []mcpLink       `json:"mcp_links"`
	ComponentLinks             []componentLink `json:"component_links"`
	UserPermission             *string         `json:"user_permission"`
	LatestApprovedVersion      *string         `json:"latest_approved_version"`
	LatestVersion              *string         `json:"latest_version"`
}

func rowDict(row map[string]any, key string) map[string]any {
	if d, ok := row[key].(map[string]any); ok {
		return d
	}
	return map[string]any{}
}

func rowNDict(row map[string]any, key string) map[string]any {
	if d, ok := row[key].(map[string]any); ok {
		return d
	}
	return nil
}

// detail renders the loaded agent row plus its resolved component links.
func detail(row map[string]any, links []map[string]any, viewer *registry.Viewer) agentDetail {
	ns := rowStr(row, "namespace", "")
	slug := rowStr(row, "slug", "")

	mcpLinks := []mcpLink{}
	componentLinks := []componentLink{}
	for _, link := range links {
		id := rowStr(link, "component_id", "")
		refNS, hasIdentity := link["ref_namespace"].(string)
		refSlug := rowStr(link, "ref_slug", "")
		qualified := ""
		if hasIdentity {
			qualified = refNS + "/" + refSlug
		}
		if rowStr(link, "component_type", "") == "mcp" {
			mcpLinks = append(mcpLinks, mcpLink{
				McpListingID: id,
				McpName:      rowStr(link, "ref_name", "(component)"),
				Order:        rowInt(link, "order_index"),
			})
		}
		componentLinks = append(componentLinks, componentLink{
			ComponentType:  rowStr(link, "component_type", ""),
			ComponentID:    id,
			ComponentName:  rowStr(link, "ref_name", ""),
			Namespace:      refNS,
			Slug:           refSlug,
			QualifiedName:  qualified,
			VersionRef:     rowStr(link, "resolved_version", ""),
			Order:          rowInt(link, "order_index"),
			ConfigOverride: rowNDict(link, "config_override"),
			Status:         rowNStr(link, "ref_status"),
		})
	}

	// Project or private; there is no public scope.
	vis := visibility(row)

	perm := permission(row, viewer)
	version := rowStr(row, "version", "0.0.0")
	var latestVersion *string
	if version != "0.0.0" {
		latestVersion = &version
	}

	return agentDetail{
		ID:                         rowStr(row, "id", ""),
		Name:                       rowStr(row, "name", ""),
		Namespace:                  ns,
		Slug:                       slug,
		QualifiedName:              ns + "/" + slug,
		Version:                    version,
		Description:                rowStr(row, "description", ""),
		Owner:                      rowStr(row, "owner", ""),
		ProjectID:                  rowNStr(row, "project_id"),
		Visibility:                 vis,
		IsPrivate:                  rowBool(row, "is_private"),
		Prompt:                     rowStr(row, "prompt", ""),
		ModelName:                  rowStr(row, "model_name", ""),
		ModelConfigJSON:            rowDict(row, "model_config_json"),
		ModelsByHarness:            rowDict(row, "models_by_harness"),
		ExternalMcps:               rowList(row, "external_mcps"),
		SupportedHarnesses:         rowList(row, "supported_harnesses"),
		RequiredCapabilities:       rowList(row, "required_capabilities"),
		InferredSupportedHarnesses: rowList(row, "inferred_supported_harnesses"),
		SuccessCriteria:            rowNDict(row, "success_criteria"),
		Status:                     rowStr(row, "status", "draft"),
		RejectionReason:            rowNStr(row, "rejection_reason"),
		CreatedBy:                  rowStr(row, "created_by", ""),
		CreatedByEmail:             rowStr(row, "created_by_email", ""),
		CreatedByUsername:          rowNStr(row, "created_by_username"),
		CreatedAt:                  registry.WireTime(row["created_at"]),
		DeletedAt:                  registry.WireTime(row["deleted_at"]),
		UpdatedAt:                  registry.WireTime(row["updated_at"]),
		McpLinks:                   mcpLinks,
		ComponentLinks:             componentLinks,
		UserPermission:             &perm,
		LatestApprovedVersion:      rowNStr(row, "latest_approved_version"),
		LatestVersion:              latestVersion,
	}
}
