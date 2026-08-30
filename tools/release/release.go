// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type Contributor struct {
	name      string
	login     string
	firstTime bool
}

func (c Contributor) label() string {
	if c.login != "" {
		return "@" + c.login
	}
	return c.name
}

type Change struct {
	commits        []string
	title          string
	authorName     string
	authorEmail    string
	pr             int
	url            string
	body           string
	labels         []string
	contributor    *Contributor
	category       string
	includeInNotes bool
	highlight      bool
	breaking       bool
}

func (c *Change) reference() string {
	if c.pr != 0 && c.url != "" {
		return fmt.Sprintf("[#%d](%s)", c.pr, c.url)
	}
	sha := c.commits[len(c.commits)-1]
	return fmt.Sprintf("[%s](https://github.com/Garudex-Labs/caracal/commit/%s)", sha[:7], sha)
}

func (c *Change) shortRef() string {
	if c.pr != 0 {
		return "#" + strconv.Itoa(c.pr)
	}
	return c.commits[len(c.commits)-1][:7]
}

type Commit struct {
	sha         string
	authorName  string
	authorEmail string
	title       string
	message     string
}

var semverRe = regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)$`)

func parseVersion(version string) ([3]int, error) {
	match := semverRe.FindStringSubmatch(version)
	if match == nil {
		return [3]int{}, errf("Latest stable tag is not semantic: v%s", version)
	}
	var parts [3]int
	for i := range 3 {
		parts[i], _ = strconv.Atoi(match[i+1])
	}
	return parts, nil
}

func bumpVersion(version, bump string) (string, error) {
	parts, err := parseVersion(version)
	if err != nil {
		return "", err
	}
	switch bump {
	case "major":
		return fmt.Sprintf("%d.0.0", parts[0]+1), nil
	case "feature":
		return fmt.Sprintf("%d.%d.0", parts[0], parts[1]+1), nil
	default:
		return fmt.Sprintf("%d.%d.%d", parts[0], parts[1], parts[2]+1), nil
	}
}

var channelVersionRe = regexp.MustCompile(`^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$`)

func validateVersionChannel(version, channel string) error {
	if !channelVersionRe.MatchString(version) {
		return errf("Invalid cross-registry version: %s", version)
	}
	prerelease := strings.Contains(version, "-")
	if (channel == "stable") == prerelease || (channel != "stable" && !strings.Contains(version, "-"+channel+".")) {
		return errf("Version %s does not match the %s channel", version, channel)
	}
	return nil
}

var commitTypeRe = regexp.MustCompile(`^([a-z]+)(?:\([^)]*\))?!?:`)

func inferCategory(title string, labels []string) string {
	normalized := map[string]bool{}
	for _, label := range labels {
		normalized[strings.ToLower(label)] = true
	}
	for _, security := range []string{"security", "area: security", "type: security"} {
		if normalized[security] {
			return "Security"
		}
	}
	for _, performance := range []string{"performance", "area: performance", "type: performance"} {
		if normalized[performance] {
			return "Performance"
		}
	}
	for _, docs := range []string{"documentation", "docs", "type: docs"} {
		if normalized[docs] {
			return "Documentation"
		}
	}
	kind := ""
	if match := commitTypeRe.FindStringSubmatch(strings.ToLower(title)); match != nil {
		kind = match[1]
	}
	switch kind {
	case "feat":
		return "Features"
	case "fix":
		return "Fixes"
	case "perf":
		return "Performance"
	case "docs":
		return "Documentation"
	default:
		return "Maintenance"
	}
}

var titlePrefixRe = regexp.MustCompile(`(?i)^[a-z]+(?:\([^)]*\))?!?:\s*`)

func cleanTitle(title string) string {
	return strings.TrimRight(strings.TrimSpace(titlePrefixRe.ReplaceAllString(title, "")), ".")
}

var breakingTitleRe = regexp.MustCompile(`(?i)^[a-z]+(?:\([^)]*\))?!:`)

func isBreaking(title string, labels []string, body string) bool {
	if breakingTitleRe.MatchString(title) || strings.Contains(body, "BREAKING CHANGE:") {
		return true
	}
	for _, label := range labels {
		if strings.Contains(strings.ToLower(label), "breaking") {
			return true
		}
	}
	return false
}

var commitLog = func(revisionRange string) ([]Commit, error) {
	raw, err := run("git", "log", "--reverse", "--format=%H%x1f%an%x1f%ae%x1f%s%x1f%B%x1e", revisionRange)
	if err != nil {
		return nil, err
	}
	var commits []Commit
	for _, record := range strings.Split(raw, "\x1e") {
		fields := strings.SplitN(strings.TrimSpace(record), "\x1f", 5)
		if len(fields) == 5 {
			commits = append(commits, Commit{fields[0], fields[1], fields[2], fields[3], fields[4]})
		}
	}
	return commits, nil
}

func latestTag() (string, error) {
	raw, err := run("git", "tag", "--list", "v[0-9]*")
	if err != nil {
		return "", err
	}
	best := ""
	var bestParts [3]int
	for _, tag := range strings.Split(raw, "\n") {
		parts, err := parseVersion(strings.TrimPrefix(tag, "v"))
		if err != nil || !strings.HasPrefix(tag, "v") {
			continue
		}
		if best == "" || parts[0] > bestParts[0] ||
			(parts[0] == bestParts[0] && (parts[1] > bestParts[1] ||
				(parts[1] == bestParts[1] && parts[2] > bestParts[2]))) {
			best, bestParts = tag, parts
		}
	}
	if best == "" {
		return "", errf("No stable release tag exists")
	}
	return best, nil
}

var manifestCutoffRe = regexp.MustCompile(`(?m)^cutoff\s*=\s*"([^"]*)"\s*$`)
var shaRe = regexp.MustCompile(`^[0-9a-f]{40}$`)

func releaseCutoff(tag string) (string, error) {
	manifest, err := run("git", "show", tag+":.release.toml")
	if err != nil {
		// No manifest at this tag (older release): pin the tag to a commit SHA
		// so later git log ranges don't depend on the tag ref surviving.
		return run("git", "rev-parse", tag+"^{commit}")
	}
	match := manifestCutoffRe.FindStringSubmatch(manifest)
	if match == nil || !shaRe.MatchString(match[1]) {
		return "", errf("Invalid release cutoff in %s", tag)
	}
	if _, err := run("git", "cat-file", "-e", match[1]+"^{commit}"); err != nil {
		return "", err
	}
	return match[1], nil
}

func discoverChanges(repo, previousRef, branch string) ([]*Change, error) {
	commits, err := commitLog(previousRef + ".." + branch)
	if err != nil {
		return nil, err
	}
	var changes []*Change
	seenPRs := map[int]bool{}
	for _, commit := range commits {
		pullsAny, err := ghJSON(repo, "commits/"+commit.sha+"/pulls")
		if err != nil {
			return nil, err
		}
		pulls, _ := pullsAny.([]any)
		var pr map[string]any
		for _, item := range pulls {
			candidate := asMap(item)
			if truthy(candidate["merged_at"]) && getStr(asMap(candidate["base"]), "ref") == "main" {
				if pr == nil || getStr(candidate, "merged_at") > getStr(pr, "merged_at") {
					pr = candidate
				}
			}
		}
		prNumber := 0
		if pr != nil {
			prNumber = getInt(pr, "number")
		}
		if len(changes) > 0 && prNumber != 0 && changes[len(changes)-1].pr == prNumber {
			last := changes[len(changes)-1]
			last.commits = append(last.commits, commit.sha)
			continue
		}
		if prNumber != 0 && seenPRs[prNumber] {
			return nil, errf("PR #%d is not contiguous in git history", prNumber)
		}
		if prNumber != 0 {
			seenPRs[prNumber] = true
		}
		var labels []string
		title := commit.title
		body := commit.message
		url := ""
		var contributor *Contributor
		if pr != nil {
			for _, item := range asList(pr["labels"]) {
				labels = append(labels, getStr(asMap(item), "name"))
			}
			title = getStr(pr, "title")
			if prBody := getStr(pr, "body"); prBody != "" {
				body = prBody
			} else {
				body = ""
			}
			url = getStr(pr, "html_url")
			user := asMap(pr["user"])
			name := commit.authorName
			if login := getStr(user, "login"); login != "" {
				name = login
			}
			contributor = &Contributor{
				name:      name,
				login:     getStr(user, "login"),
				firstTime: getStr(pr, "author_association") == "FIRST_TIME_CONTRIBUTOR",
			}
		} else {
			contributor = &Contributor{name: commit.authorName}
		}
		if releaseTitle.MatchString(title) {
			continue
		}
		change := &Change{
			commits:     []string{commit.sha},
			title:       title,
			authorName:  commit.authorName,
			authorEmail: commit.authorEmail,
			pr:          prNumber,
			url:         url,
			body:        body,
			labels:      labels,
			contributor: contributor,
		}
		change.category = inferCategory(title, labels)
		change.includeInNotes = change.category != "Maintenance"
		change.breaking = isBreaking(title, labels, change.body)
		changes = append(changes, change)
	}
	return changes, nil
}

func asList(value any) []any {
	list, _ := value.([]any)
	return list
}

var coauthorRe = regexp.MustCompile(`(?im)^Co-authored-by:\s*(.+?)\s*<([^>]+)>$`)
var noreplyLoginRe = regexp.MustCompile(`(?:\d+\+)?([^@+]+)@users\.noreply\.github\.com$`)

func coauthors(commits []Commit) []Contributor {
	var contributors []Contributor
	for _, commit := range commits {
		for _, match := range coauthorRe.FindAllStringSubmatch(commit.message, -1) {
			login := ""
			if m := noreplyLoginRe.FindStringSubmatch(match[2]); m != nil {
				login = m[1]
			}
			contributors = append(contributors, Contributor{name: strings.TrimSpace(match[1]), login: login})
		}
	}
	return contributors
}

var nonAlnumRe = regexp.MustCompile(`[^a-zA-Z0-9]`)

func allContributors(changes []*Change, commits []Commit) []Contributor {
	var candidates []Contributor
	for _, change := range changes {
		if change.contributor != nil {
			candidates = append(candidates, *change.contributor)
		}
	}
	for _, commit := range commits {
		login := ""
		if m := noreplyLoginRe.FindStringSubmatch(commit.authorEmail); m != nil {
			login = m[1]
		}
		candidates = append(candidates, Contributor{name: commit.authorName, login: login})
	}
	candidates = append(candidates, coauthors(commits)...)

	result := map[string]*Contributor{}
	for _, contributor := range candidates {
		raw := contributor.login
		if raw == "" {
			raw = contributor.name
		}
		key := strings.ToLower(nonAlnumRe.ReplaceAllString(raw, ""))
		if strings.HasSuffix(strings.ToLower(raw), "[bot]") || key == "dependabot" || key == "githubactions" {
			continue
		}
		if existing, ok := result[key]; ok {
			existing.firstTime = existing.firstTime || contributor.firstTime
			if contributor.login != "" {
				existing.login = contributor.login
			}
		} else {
			copied := contributor
			result[key] = &copied
		}
	}
	sorted := make([]Contributor, 0, len(result))
	for _, contributor := range result {
		sorted = append(sorted, *contributor)
	}
	sort.Slice(sorted, func(i, j int) bool {
		return strings.ToLower(sorted[i].label()) < strings.ToLower(sorted[j].label())
	})
	return sorted
}

func migrationChanges(changes []*Change) ([]*Change, error) {
	var result []*Change
	for _, change := range changes {
		found := false
		for _, sha := range change.commits {
			paths, err := run("git", "diff-tree", "--no-commit-id", "--name-only", "-r", sha)
			if err != nil {
				return nil, err
			}
			for _, path := range strings.Split(paths, "\n") {
				if strings.HasPrefix(path, "internal/dbinit/migrations/") {
					found = true
				}
			}
		}
		if found {
			result = append(result, change)
		}
	}
	return result, nil
}

func grouped(changes []*Change) map[string][]*Change {
	result := map[string][]*Change{}
	for _, category := range categories {
		for _, change := range changes {
			if change.includeInNotes && change.category == category {
				result[category] = append(result[category], change)
			}
		}
	}
	return result
}

func renderEntries(changes []*Change) string {
	lines := make([]string, len(changes))
	for i, change := range changes {
		lines[i] = fmt.Sprintf("- %s (%s)", cleanTitle(change.title), change.reference())
	}
	return strings.Join(lines, "\n")
}

func renderChangelogSection(version, date string, changes []*Change) string {
	lines := []string{fmt.Sprintf("## [%s] - %s", version, date)}
	selected := false
	for _, change := range changes {
		if change.includeInNotes {
			selected = true
		}
	}
	if !selected {
		return strings.Join(append(lines, "", "No user-facing changes."), "\n")
	}
	groups := grouped(changes)
	for _, category := range categories {
		if items := groups[category]; len(items) > 0 {
			lines = append(lines, "", "### "+category, "", renderEntries(items))
		}
	}
	return strings.Join(lines, "\n")
}

func renderReleaseNotes(version, previousTag, cutoff string, changes []*Change, contributors []Contributor) string {
	var highlights, breaking []*Change
	for _, change := range changes {
		if !change.includeInNotes {
			continue
		}
		if change.highlight {
			highlights = append(highlights, change)
		}
		if change.breaking {
			breaking = append(breaking, change)
		}
	}
	lines := []string{
		"<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->",
		// REUSE-IgnoreStart
		"<!-- SPDX-License-Identifier: Apache-2.0 -->",
		// REUSE-IgnoreEnd
		"",
		fmt.Sprintf("This release includes %d change groups through `%s`.", len(changes), cutoff[:7]),
	}
	if len(highlights) > 0 {
		lines = append(lines, "", "## Highlights", "", renderEntries(highlights))
	}
	if len(breaking) > 0 {
		lines = append(lines, "", "## Breaking changes", "", renderEntries(breaking))
	}
	special := map[*Change]bool{}
	for _, change := range highlights {
		special[change] = true
	}
	for _, change := range breaking {
		special[change] = true
	}
	groups := grouped(changes)
	for _, category := range categories {
		var regular []*Change
		for _, item := range groups[category] {
			if !special[item] {
				regular = append(regular, item)
			}
		}
		if len(regular) > 0 {
			lines = append(lines, "", "## "+category, "", renderEntries(regular))
		}
	}
	lines = append(lines,
		"",
		"## Verify this release",
		"",
		"Verify checksums, artifact provenance, and the signed release tag using the "+
			"[release verification guide](https://github.com/Garudex-Labs/caracal/blob/main/"+
			"docs/security/release-verification.md).",
		"",
		"## Full comparison",
		"",
		fmt.Sprintf("[%s...v%s](https://github.com/Garudex-Labs/caracal/compare/%s...v%s)", previousTag, version, previousTag, version),
		"",
	)
	return strings.Join(lines, "\n")
}

func prependChangelog(existing, section, version string) (string, error) {
	duplicate := regexp.MustCompile(`(?m)^## \[` + regexp.QuoteMeta(version) + `\]`)
	if duplicate.MatchString(existing) {
		return "", errf("CHANGELOG.md already contains version %s", version)
	}
	position := strings.Index(existing, changelogAnchor)
	if position < 0 {
		return "", errf("CHANGELOG.md introduction was not found")
	}
	position += len(changelogAnchor)
	return existing[:position] + strings.TrimRight(section, " \t\n") + "\n\n" + existing[position:], nil
}

var tomlVersionLineRe = regexp.MustCompile(`(?m)^(version\s*=\s*")[^"]+("\s*)$`)
var jsonVersionLineRe = regexp.MustCompile(`(?m)^(  "version"\s*:\s*")[^"]+("\s*,?)$`)

func setVersion(path, version string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	text := string(raw)
	var updated string
	var count int
	if strings.HasSuffix(path, ".toml") {
		location := findProjectBlock(text)
		if location == nil {
			return errf("Could not find [project] in %s", path)
		}
		block := text[location[0]:location[1]]
		replaced := tomlVersionLineRe.ReplaceAllStringFunc(block, func(match string) string {
			count++
			sub := tomlVersionLineRe.FindStringSubmatch(match)
			return sub[1] + version + sub[2]
		})
		updated = text[:location[0]] + replaced + text[location[1]:]
	} else {
		var data map[string]any
		if err := json.Unmarshal(raw, &data); err != nil || data == nil {
			return errf("Could not find a top-level version in %s", path)
		}
		if _, ok := data["version"]; !ok {
			return errf("Could not find a top-level version in %s", path)
		}
		updated = jsonVersionLineRe.ReplaceAllStringFunc(text, func(match string) string {
			count++
			sub := jsonVersionLineRe.FindStringSubmatch(match)
			return sub[1] + version + sub[2]
		})
	}
	if count != 1 {
		return errf("Could not update exactly one version in %s", path)
	}
	return os.WriteFile(path, []byte(updated), 0o644)
}

// findProjectBlock returns the [project] table's span: header through the
// next table header or end of file.
func findProjectBlock(text string) []int {
	header := regexp.MustCompile(`(?m)^\[project\]\s*$`)
	location := header.FindStringIndex(text)
	if location == nil {
		return nil
	}
	next := regexp.MustCompile(`(?m)^\[`).FindStringIndex(text[location[1]:])
	if next == nil {
		return []int{location[0], len(text)}
	}
	return []int{location[0], location[1] + next[0]}
}

func writeManifest(path, version, channel, previousTag, cutoff string, changes []*Change) error {
	var prs []string
	commitCount := 0
	for _, change := range changes {
		commitCount += len(change.commits)
		if change.pr != 0 {
			prs = append(prs, strconv.Itoa(change.pr))
		}
	}
	content := "# SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>\n" +
		// REUSE-IgnoreStart
		"# SPDX-License-Identifier: Apache-2.0\n\n" +
		// REUSE-IgnoreEnd
		fmt.Sprintf("version = %q\n", version) +
		fmt.Sprintf("channel = %q\n", channel) +
		fmt.Sprintf("previous_tag = %q\n", previousTag) +
		fmt.Sprintf("cutoff = %q\n", cutoff) +
		fmt.Sprintf("created_at = %q\n", time.Now().UTC().Format(time.RFC3339Nano)) +
		fmt.Sprintf("commit_count = %d\n", commitCount) +
		fmt.Sprintf("included_prs = [%s]\n", strings.Join(prs, ", "))
	return os.WriteFile(path, []byte(content), 0o644)
}

func prBody(version, previousTag, cutoff string, changes []*Change, preview string) string {
	return fmt.Sprintf(`## Purpose / Description
Prepare Caracal v%s from the contiguous release range `+"`%s..%s`"+`.

## Fixes
No linked issue. This is a release preparation change.

## Approach
The release contains %d PR or commit groups. This PR updates version metadata, lockfiles, the curated release notes, and prepends one new changelog section without rewriting existing changelog history.

Merge this PR with squash, rebase, or the merge queue. The release workflow publishes this PR's selected-cutoff head rather than the resulting `+"`main`"+` commit.

## How Has This Been Tested?

The release tool validated ancestry, tag state, version consistency, allowed changed files, changelog preservation, and release-note generation. The release workflow will build and verify every artifact before publishing.

## Learning (optional, can help others)
Not applicable. The implementation uses existing Git, GitHub CLI, uv, and repository build tooling.

## Release preview

%s

## Checklist

- [x] You have a descriptive commit message with a short title (first line, max 50 chars).
- [ ] You have commented your code, particularly in hard-to-understand areas. Not applicable, this PR contains generated release metadata.
- [x] You have performed a self-review of your own code.
- [ ] UI changes: include screenshots of all affected screens. Not applicable, this PR has no UI changes.

## AI Assistance

- [ ] Yes (Please Specify the tool): Not applicable to generated release metadata.
- [ ] Was the generated code manually reviewed and tested? Not applicable.
`, version, previousTag, cutoff[:7], len(changes), preview)
}
