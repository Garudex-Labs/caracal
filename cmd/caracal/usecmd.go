// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/spf13/cobra"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
	"github.com/garudex-labs/caracal/internal/cli/config"
)

// useCommand selects or shows the organization/project this machine syncs
// against: `use` shows the context, `use ORG` or `use ORG/PROJECT` selects
// it after validating access, `--list` enumerates the choices.
func useCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "use [ORG[/PROJECT]]",
		Short: "Show or select the organization/project this machine syncs against",
		Long: "With no argument, shows the current context. With ORG or ORG/PROJECT,\n" +
			"validates access and persists the selection for later sync operations.\n" +
			"Switching organizations clears a project selected in another one.\n" +
			"Organization and project management (create, members, roles) lives in\n" +
			"the web UI.",
		Args: cobra.MaximumNArgs(1),
	}
	list := cmd.Flags().Bool("list", false, "List organizations and accessible projects")
	mode := outputFlag(cmd)
	cmd.RunE = func(_ *cobra.Command, args []string) error {
		switch {
		case *list:
			return useList(*mode)
		case len(args) == 0:
			return useShow(*mode)
		default:
			return useSelect(args[0], *mode)
		}
	}
	return cmd
}

// useShow reports the persisted context without touching the network.
func useShow(mode string) error {
	cfg, cerr := config.Load()
	if cerr != nil {
		return cerr
	}
	org := config.Str(cfg, "default_org")
	project := config.Str(cfg, "default_project")
	if mode == "json" {
		outputJSONRaw([]byte(fmt.Sprintf(`{"default_org": %s, "default_project": %s}`,
			jsonStringOrNull(org), jsonStringOrNull(project))))
		return nil
	}
	if org == "" {
		fmt.Println("No context selected. Run caracal use --list to see your organizations.")
		return nil
	}
	if project == "" {
		fmt.Printf("Context: %s (no project selected)\n", org)
		return nil
	}
	fmt.Printf("Context: %s/%s\n", org, project)
	return nil
}

// useList enumerates organizations and, per organization, the projects the
// caller can access.
func useList(mode string) error {
	client, cerr := newClient()
	if cerr != nil {
		return cerr
	}
	raw, cerr := client.Do("GET", "/api/v1/orgs", nil, nil, "List organizations", "organizations")
	if cerr != nil {
		return cerr
	}
	var orgItems []struct {
		Slug string `json:"slug"`
		Name string `json:"name"`
		Role string `json:"role"`
	}
	if err := json.Unmarshal(raw, &orgItems); err != nil {
		return &clierr.Error{
			Category: clierr.Unavailable, Message: "The server returned an invalid organization list.",
			Operation: "List organizations", Resource: "organizations",
			Remediation: "Check server health and retry.",
		}
	}
	type orgRow struct {
		slug, name, role string
		projects         []string
	}
	rows := make([]orgRow, 0, len(orgItems))
	for _, org := range orgItems {
		row := orgRow{slug: org.Slug, name: org.Name, role: org.Role}
		if projRaw, cerr := client.Do("GET", "/api/v1/orgs/"+org.Slug+"/projects", nil, nil,
			"List projects", "organizations"); cerr == nil {
			var projPage struct {
				Projects []struct {
					Slug string `json:"slug"`
				} `json:"projects"`
			}
			if json.Unmarshal(projRaw, &projPage) == nil {
				for _, project := range projPage.Projects {
					row.projects = append(row.projects, project.Slug)
				}
			}
		}
		rows = append(rows, row)
	}
	if mode == "json" {
		docs := make([]string, 0, len(rows))
		for _, row := range rows {
			projects := make([]string, 0, len(row.projects))
			for _, project := range row.projects {
				projects = append(projects, jsonString(project))
			}
			docs = append(docs, fmt.Sprintf(`{"slug": %s, "name": %s, "role": %s, "projects": [%s]}`,
				jsonString(row.slug), jsonString(row.name), jsonString(row.role), strings.Join(projects, ", ")))
		}
		outputJSONRaw([]byte(fmt.Sprintf(`{"organizations": [%s]}`, strings.Join(docs, ", "))))
		return nil
	}
	if len(rows) == 0 {
		fmt.Println("You do not belong to any organization yet.")
		return nil
	}
	for _, row := range rows {
		fmt.Printf("%s (%s)\n", row.slug, row.role)
		for _, project := range row.projects {
			fmt.Printf("  %s/%s\n", row.slug, project)
		}
	}
	return nil
}

// useSelect validates and persists an ORG or ORG/PROJECT selection.
func useSelect(target, mode string) error {
	const op = "Select sync context"
	orgPart, projectPart, hasProject := strings.Cut(strings.TrimSpace(target), "/")
	org, cerr := validOrgSlug(op, orgPart)
	if cerr != nil {
		return cerr
	}
	project := ""
	if hasProject {
		if project, cerr = validProjectSlug(op, projectPart); cerr != nil {
			return cerr
		}
	}
	client, cerr := newClient()
	if cerr != nil {
		return cerr
	}
	if _, cerr := client.Do("GET", "/api/v1/orgs/"+org, nil, nil, op, "organization "+org); cerr != nil {
		return cerr
	}
	values := map[string]any{"default_org": org}
	if hasProject {
		// Selecting an inaccessible project must fail here, not during sync.
		if _, cerr := client.Do("GET", "/api/v1/orgs/"+org+"/projects/"+project, nil, nil,
			op, "project "+org+"/"+project); cerr != nil {
			return cerr
		}
		values["default_project"] = project
	}
	cfg, cerr := config.Load()
	if cerr != nil {
		return cerr
	}
	// A project belongs to exactly one organization; switching tenants must
	// never leave the previous project selected.
	projectCleared := false
	if !hasProject && config.Str(cfg, "default_org") != org && config.Str(cfg, "default_project") != "" {
		values["default_project"] = ""
		projectCleared = true
	}
	if cerr := config.Save(values); cerr != nil {
		return cerr
	}
	if mode == "json" {
		outputJSONRaw([]byte(fmt.Sprintf(`{"default_org": %s, "default_project": %s, "default_project_cleared": %t}`,
			jsonString(org), jsonStringOrNull(project), projectCleared)))
		return nil
	}
	if project != "" {
		fmt.Printf("Context set to %s/%s.\n", org, project)
		return nil
	}
	fmt.Printf("Context set to %s.\n", org)
	if projectCleared {
		fmt.Println("Project selection cleared; run caracal use " + org + "/PROJECT to pick one.")
	}
	return nil
}
