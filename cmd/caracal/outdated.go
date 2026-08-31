// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
	"github.com/garudex-labs/caracal/internal/cli/config"
	"github.com/garudex-labs/caracal/internal/cli/lockfile"
	"github.com/garudex-labs/caracal/internal/cli/ui"
)

const outdatedOp = "Check installed versions"

type outdatedItem struct {
	ID             string
	QualifiedName  string
	Name           string
	Namespace      string
	Slug           string
	Type           string
	Harness        string
	CurrentVersion string
	LatestVersion  string
	Status         string
	Outdated       bool
	Err            *clierr.Error
	UpgradeCommand string
}

// checkOutdatedItems compares installed items against the registry and
// returns one classified result per item: current, outdated (with the
// upgrade command), or missing from the registry.
func checkOutdatedItems(client apiClient, installed []outdatedItem, progress *ui.Spinner) ([]outdatedItem, *clierr.Error) {
	results := make([]outdatedItem, 0, len(installed))
	for index, item := range installed {
		if progress != nil {
			progress.Update(fmt.Sprintf("Checking %s (%d/%d)", item.QualifiedName, index+1, len(installed)))
		}
		resource := item.Type + " " + item.QualifiedName
		raw, cerr := client.Do("GET", registryItemPath(item.Type, item.ID), nil, nil, outdatedOp, resource)
		if cerr != nil {
			if cerr.Category != clierr.NotFound {
				return nil, cerr
			}
			item.Status = "missing"
			item.Err = cerr
			results = append(results, item)
			continue
		}
		var data struct {
			Version               string `json:"version"`
			LatestApprovedVersion string `json:"latest_approved_version"`
			Namespace             string `json:"namespace"`
			Slug                  string `json:"slug"`
		}
		if err := json.Unmarshal(raw, &data); err != nil {
			return nil, &clierr.Error{
				Category: clierr.Unavailable, Message: "The registry returned an invalid item response.",
				Operation: outdatedOp, Resource: resource,
				Remediation: "Check server health and version compatibility, then retry.",
			}
		}
		latest := data.Version
		if item.Type == "agent" && data.LatestApprovedVersion != "" {
			latest = data.LatestApprovedVersion
		}
		if strings.TrimSpace(latest) == "" {
			return nil, &clierr.Error{
				Category: clierr.Unavailable, Message: "The registry response does not contain a valid latest version.",
				Operation: outdatedOp, Resource: resource,
				Remediation: "Check server health and version compatibility, then retry.",
			}
		}
		newer, err := versionNewer(latest, item.CurrentVersion)
		if err != nil {
			return nil, &clierr.Error{
				Category: clierr.Unavailable, Message: "The registry returned an invalid latest version.",
				Operation: outdatedOp, Resource: resource,
				Remediation: "Correct the registry version and retry.", Detail: err.Error(),
			}
		}
		if ns := strings.TrimSpace(data.Namespace); ns != "" {
			item.Namespace = ns
		}
		if slug := strings.TrimSpace(data.Slug); slug != "" {
			item.Slug = slug
		}
		if item.Namespace != "" && item.Slug != "" {
			item.QualifiedName = item.Namespace + "/" + item.Slug
		}
		item.LatestVersion = latest
		item.Outdated = newer
		item.Status = "current"
		if newer {
			item.Status = "outdated"
			item.UpgradeCommand = upgradeCommand(item)
		}
		results = append(results, item)
	}
	return results, nil
}

// filterToActiveProject keeps only installs bound to the selected Caracal
// Project so sync never updates another Project's resources. Entries with no
// Project binding predate binding and are retained for compatibility.
func filterToActiveProject(entries []lockfile.FlatEntry) []lockfile.FlatEntry {
	cfg, cerr := config.Load()
	if cerr != nil {
		return entries
	}
	org := config.Str(cfg, "default_org")
	project := config.Str(cfg, "default_project")
	if org == "" || project == "" {
		return entries
	}
	kept := make([]lockfile.FlatEntry, 0, len(entries))
	for _, e := range entries {
		if (e.Org == "" && e.Project == "") || (e.Org == org && e.Project == project) {
			kept = append(kept, e)
		}
	}
	return kept
}

func loadOutdatedEntries(harness string) ([]lockfile.FlatEntry, *clierr.Error) {
	entries, err := lockfile.AllEntries(harness)
	if err != nil {
		message := err.Error()
		if strings.Contains(message, "server URL is required") {
			return nil, &clierr.Error{
				Category: clierr.Auth, Message: "No active Caracal registry is configured.",
				Operation: outdatedOp, Resource: config.File(),
				Remediation: "Run caracal auth login and retry.", Detail: message,
			}
		}
		if strings.Contains(message, "permission denied") {
			return nil, &clierr.Error{
				Category: clierr.Permission, Message: "The installed-state lockfile cannot be read.",
				Operation: outdatedOp, Resource: lockfile.Path(),
				Remediation: "Check the lockfile ownership and permissions, then retry.", Detail: message,
			}
		}
		return nil, &clierr.Error{
			Category: clierr.Validation, Message: "The installed-state lockfile is malformed or unsupported.",
			Operation: outdatedOp, Resource: lockfile.Path(),
			Remediation: "Repair or remove the lockfile, then reinstall the affected items.", Detail: message,
		}
	}
	return entries, nil
}

func prepareOutdatedEntry(entry lockfile.FlatEntry) (outdatedItem, *clierr.Error) {
	badEntry := func(message, remediation string) *clierr.Error {
		return &clierr.Error{
			Category: clierr.Validation, Message: message,
			Operation: outdatedOp, Resource: lockfile.Path(), Remediation: remediation,
		}
	}
	itemType := ""
	switch entry.EntryType {
	case "agent":
		itemType = "agent"
	case "standalone":
		itemType = strings.TrimSpace(entry.Type)
	}
	if itemType != "agent" && itemType != "mcp" && itemType != "skill" && itemType != "hook" {
		return outdatedItem{}, badEntry("The installed-state lockfile contains an unsupported item type.",
			"Reinstall the affected item to rebuild its lockfile entry.")
	}
	version := ""
	if entry.Version != nil {
		version = strings.TrimSpace(*entry.Version)
	}
	itemID := strings.TrimSpace(entry.ID)
	if itemID == "" || version == "" || strings.TrimSpace(entry.Harness) == "" {
		return outdatedItem{}, badEntry("An installed-state lockfile entry is missing its ID, version, or harness.",
			"Reinstall the affected item to rebuild its lockfile entry.")
	}
	if !contains(validHarnesses, entry.Harness) {
		return outdatedItem{}, badEntry("An installed-state lockfile entry uses an unsupported harness.",
			"Reinstall the affected item for a currently supported harness.")
	}
	if !pep440Re.MatchString(version) {
		return outdatedItem{}, badEntry("An installed-state lockfile entry has an invalid version.",
			"Reinstall the affected item to rebuild its lockfile entry.")
	}
	name := strings.TrimSpace(entry.Name)
	if name == "" {
		name = itemID[:min(8, len(itemID))]
	}
	qualified := strings.TrimSpace(entry.QualifiedName)
	if qualified == "" {
		if entry.Namespace != "" && entry.Slug != "" {
			qualified = entry.Namespace + "/" + entry.Slug
		} else {
			qualified = itemID
		}
	}
	return outdatedItem{
		ID: itemID, QualifiedName: qualified, Name: name,
		Namespace: strings.TrimSpace(entry.Namespace), Slug: strings.TrimSpace(entry.Slug),
		Type: itemType, Harness: entry.Harness, CurrentVersion: version,
	}, nil
}

func registryItemPath(itemType, itemID string) string {
	if itemType == "agent" {
		return "/api/v1/agents/" + itemID
	}
	return "/api/v1/" + itemType + "s/" + itemID
}

var shSafeRe = regexp.MustCompile(`^[a-zA-Z0-9_@%+=:,./-]+$`)

func shQuote(s string) string {
	if s != "" && shSafeRe.MatchString(s) {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'"'"'`) + "'"
}

func upgradeCommand(item outdatedItem) string {
	target := shQuote(item.QualifiedName)
	harness := shQuote(item.Harness)
	if item.Type == "agent" {
		return fmt.Sprintf("caracal agent pull %s --harness %s --no-prompt", target, harness)
	}
	promptFlag := ""
	if item.Type == "mcp" {
		promptFlag = " --no-prompt"
	}
	return fmt.Sprintf("caracal registry %s install %s --harness %s%s", item.Type, target, harness, promptFlag)
}

func errorPayloadDoc(e *clierr.Error) string {
	var doc bytes.Buffer
	doc.WriteString(`{"category": ` + jsonString(string(e.Category)))
	doc.WriteString(`, "message": ` + jsonString(e.Message))
	doc.WriteString(`, "operation": ` + jsonString(e.Operation))
	doc.WriteString(`, "resource": ` + jsonStringOrNull(e.Resource))
	doc.WriteString(`, "remediation": ` + jsonStringOrNull(e.Remediation))
	doc.WriteString(`, "request_id": ` + jsonStringOrNull(e.RequestID))
	if e.HTTPStatus != 0 {
		fmt.Fprintf(&doc, `, "http_status": %d`, e.HTTPStatus)
	} else {
		doc.WriteString(`, "http_status": null`)
	}
	fmt.Fprintf(&doc, `, "exit_code": %d}`, e.ExitCode())
	return doc.String()
}

func jsonStringOrNull(s string) string {
	if s == "" {
		return "null"
	}
	return jsonString(s)
}

func reportStatusDoc(requested, attempted bool, succeeded string, created, superseded int, errDoc string) string {
	return fmt.Sprintf(`{"requested": %t, "attempted": %t, "succeeded": %s, "created": %d, "superseded": %d, "error": %s}`,
		requested, attempted, succeeded, created, superseded, errDoc)
}

func reportToInbox(client apiClient, items []outdatedItem) string {
	var body bytes.Buffer
	body.WriteString(`{"items": [`)
	for i, item := range items {
		if i > 0 {
			body.WriteString(", ")
		}
		body.WriteString(`{"type": ` + jsonString(item.Type))
		body.WriteString(`, "component_id": ` + jsonString(item.ID))
		body.WriteString(`, "name": ` + jsonString(item.Name))
		body.WriteString(`, "namespace": ` + jsonStringOrNull(item.Namespace))
		body.WriteString(`, "slug": ` + jsonStringOrNull(item.Slug))
		body.WriteString(`, "current_version": ` + jsonString(item.CurrentVersion))
		body.WriteString(`, "latest_version": ` + jsonStringOrNull(item.LatestVersion))
		body.WriteString(`, "harness": ` + jsonStringOrNull(item.Harness))
		body.WriteString("}")
	}
	body.WriteString("]}")
	raw, cerr := client.Do("POST", "/api/v1/inbox/outdated-report", nil,
		json.RawMessage(body.Bytes()), "Report outdated items", "user inbox")
	if cerr != nil {
		return reportStatusDoc(true, true, "false", 0, 0, errorPayloadDoc(cerr))
	}
	var counters struct {
		Created    *int `json:"created"`
		Superseded *int `json:"superseded"`
	}
	created, superseded := 0, 0
	valid := json.Unmarshal(raw, &counters) == nil
	if valid {
		if counters.Created != nil {
			created = *counters.Created
		}
		if counters.Superseded != nil {
			superseded = *counters.Superseded
		}
		valid = created >= 0 && superseded >= 0
	}
	if !valid {
		invalid := &clierr.Error{
			Category: clierr.Unavailable, Message: "The inbox returned an invalid report response.",
			Operation: "Report outdated items", Resource: "user inbox",
			Remediation: "Check server health and version compatibility, then retry.",
		}
		return reportStatusDoc(true, true, "false", 0, 0, errorPayloadDoc(invalid))
	}
	return reportStatusDoc(true, true, "true", created, superseded, "null")
}

// apiClient is the request seam the reporter needs.
type apiClient interface {
	Do(method, path string, params map[string]string, body any, operation, resource string) ([]byte, *clierr.Error)
}

// ── version-scheme comparison ──────────────────────────────────────

type pepVersion struct {
	epoch   int
	release []int
	preRank int // dev < a < b < rc < final < post handled via ranks
	preNum  int
	post    int // -1 when absent
	dev     int // -1 when absent
	hasPre  bool
	hasDev  bool
}

var pepParseRe = regexp.MustCompile(`(?i)^\s*v?(?:(?:(?P<epoch>[0-9]+)!)?(?P<release>[0-9]+(?:\.[0-9]+)*)(?:[-_.]?(?P<preL>a|b|c|rc|alpha|beta|pre|preview)[-_.]?(?P<preN>[0-9]+)?)?(?:(?:-(?P<postN1>[0-9]+))|(?:[-_.]?(?P<postL>post|rev|r)[-_.]?(?P<postN2>[0-9]+)?))?(?:[-_.]?(?P<devL>dev)[-_.]?(?P<devN>[0-9]+)?)?)(?:\+(?P<local>[a-z0-9]+(?:[-_.][a-z0-9]+)*))?\s*$`)

func parsePEP440(value string) (pepVersion, error) {
	match := pepParseRe.FindStringSubmatch(value)
	if match == nil {
		return pepVersion{}, fmt.Errorf("Invalid version: '%s'", value)
	}
	group := func(name string) string {
		for i, groupName := range pepParseRe.SubexpNames() {
			if groupName == name {
				return match[i]
			}
		}
		return ""
	}
	v := pepVersion{post: -1, dev: -1}
	v.epoch = pepInt(group("epoch"))
	for _, part := range strings.Split(group("release"), ".") {
		v.release = append(v.release, pepInt(part))
	}
	if pre := strings.ToLower(group("preL")); pre != "" {
		v.hasPre = true
		switch pre {
		case "a", "alpha":
			v.preRank = 1
		case "b", "beta":
			v.preRank = 2
		default: // c, rc, pre, preview
			v.preRank = 3
		}
		v.preNum = pepInt(group("preN"))
	}
	if n1 := group("postN1"); n1 != "" {
		v.post = pepInt(n1)
	} else if group("postL") != "" {
		v.post = pepInt(group("postN2"))
	}
	if group("devL") != "" {
		v.hasDev = true
		v.dev = pepInt(group("devN"))
	}
	return v, nil
}

// pepInt reads a regex-validated digit group; empty or overflowing runs read 0.
func pepInt(s string) int {
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0
	}
	return n
}

// comparePEP440 orders two parsed versions by the public version scheme.
func comparePEP440(a, b pepVersion) int {
	if a.epoch != b.epoch {
		return sign(a.epoch - b.epoch)
	}
	ra, rb := trimZeros(a.release), trimZeros(b.release)
	for i := 0; i < len(ra) || i < len(rb); i++ {
		va, vb := 0, 0
		if i < len(ra) {
			va = ra[i]
		}
		if i < len(rb) {
			vb = rb[i]
		}
		if va != vb {
			return sign(va - vb)
		}
	}
	// Phase rank: dev-only < pre < final < post.
	pa, pb := phaseKey(a), phaseKey(b)
	if pa != pb {
		return sign(pa - pb)
	}
	if a.hasPre && b.hasPre {
		if a.preRank != b.preRank {
			return sign(a.preRank - b.preRank)
		}
		if a.preNum != b.preNum {
			return sign(a.preNum - b.preNum)
		}
	}
	if a.post != b.post {
		return sign(a.post - b.post)
	}
	da, db := a.dev, b.dev
	if !a.hasDev {
		da = int(^uint(0) >> 1)
	}
	if !b.hasDev {
		db = int(^uint(0) >> 1)
	}
	if da != db {
		return sign(da - db)
	}
	return 0
}

func phaseKey(v pepVersion) int {
	switch {
	case v.hasDev && !v.hasPre && v.post < 0:
		return 0
	case v.hasPre:
		return 1
	case v.post >= 0:
		return 3
	default:
		return 2
	}
}

func trimZeros(release []int) []int {
	end := len(release)
	for end > 1 && release[end-1] == 0 {
		end--
	}
	return release[:end]
}

func sign(n int) int {
	if n < 0 {
		return -1
	}
	if n > 0 {
		return 1
	}
	return 0
}

func versionNewer(latest, current string) (bool, error) {
	a, err := parsePEP440(latest)
	if err != nil {
		return false, err
	}
	b, err := parsePEP440(current)
	if err != nil {
		return false, err
	}
	return comparePEP440(a, b) > 0, nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
