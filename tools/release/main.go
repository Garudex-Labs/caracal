// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Command release prepares a curated Caracal release from a safe, contiguous
// main-branch cutoff.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const changelogAnchor = "All notable changes to this project will be documented in this file.\n\n"

var categories = []string{
	"Security",
	"Features",
	"Fixes",
	"Performance",
	"Documentation",
	"Maintenance",
}

var versionFiles = []string{
	"apps/web/package.json",
	"packages/pi-extension/package.json",
}

var releaseFiles = append(append([]string{}, versionFiles...),
	"CHANGELOG.md",
	".release.toml",
	".github/release-notes.md",
)

var releaseTitle = regexp.MustCompile(`^chore\(release\): v\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$`)

// rootDir is the repository root; every captured command runs there.
var rootDir = "."

type releaseError struct{ msg string }

func (e releaseError) Error() string { return e.msg }

func errf(format string, args ...any) error {
	return releaseError{msg: fmt.Sprintf(format, args...)}
}

func runIn(dir string, capture bool, args ...string) (string, error) {
	cmd := exec.Command(args[0], args[1:]...)
	cmd.Dir = dir
	if !capture {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			detail := err.Error()
			var exit *exec.ExitError
			if errors.As(err, &exit) {
				detail = fmt.Sprintf("exit code %d", exit.ExitCode())
			}
			return "", errf("%s failed: %s", strings.Join(args, " "), detail)
		}
		return "", nil
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = strings.TrimSpace(stdout.String())
		}
		if detail == "" {
			var exit *exec.ExitError
			if errors.As(err, &exit) {
				detail = fmt.Sprintf("exit code %d", exit.ExitCode())
			} else {
				detail = err.Error()
			}
		}
		return "", errf("%s failed: %s", strings.Join(args, " "), detail)
	}
	return strings.TrimSpace(stdout.String()), nil
}

var run = func(args ...string) (string, error) {
	return runIn(rootDir, true, args...)
}

func require(command string) error {
	if _, err := run(command, "--version"); err != nil {
		return errf("Required command not available: %s", command)
	}
	return nil
}

var repositoryRe = regexp.MustCompile(`github\.com(?::|/)([^/]+)/([^/]+?)(?:\.git)?$`)

func repository(remote string) (string, string, error) {
	url, err := run("git", "remote", "get-url", remote)
	if err != nil {
		return "", "", err
	}
	match := repositoryRe.FindStringSubmatch(url)
	if match == nil {
		return "", "", errf("Cannot determine GitHub repository from remote %s: %s", remote, url)
	}
	return match[1], match[2], nil
}

var ghJSON = func(repo, endpoint string) (any, error) {
	output, err := run("gh", "api", "repos/"+repo+"/"+endpoint)
	if err != nil {
		return nil, err
	}
	var value any
	if err := json.Unmarshal([]byte(output), &value); err != nil {
		return nil, err
	}
	return value, nil
}

func ensurePreflight(upstream string) error {
	for _, command := range []string{"git", "gh"} {
		if err := require(command); err != nil {
			return err
		}
	}
	status, err := run("git", "status", "--porcelain")
	if err != nil {
		return err
	}
	if status != "" {
		return errf("Working tree is dirty. Commit or stash changes first.")
	}
	branch, err := run("git", "branch", "--show-current")
	if err != nil {
		return err
	}
	if branch != "main" {
		return errf("Releases must be prepared from main")
	}
	if _, err := run("gh", "auth", "status"); err != nil {
		return err
	}
	if _, err := run("git", "fetch", upstream, "main", "--tags", "--force", "--no-prune-tags"); err != nil {
		return err
	}
	head, err := run("git", "rev-parse", "HEAD")
	if err != nil {
		return err
	}
	upstreamHead, err := run("git", "rev-parse", upstream+"/main")
	if err != nil {
		return err
	}
	if head != upstreamHead {
		return errf("Local main must exactly match %s/main", upstream)
	}
	return nil
}

func resolveReleasePush(before, after, repo string) (string, int, bool, error) {
	revisionRange := before + ".." + after
	commits, err := commitLog(revisionRange)
	if err != nil {
		return "", 0, false, err
	}
	var releaseCommits []Commit
	for _, commit := range commits {
		if releaseTitle.MatchString(commit.title) {
			releaseCommits = append(releaseCommits, commit)
		}
	}
	manifestOut, err := run("git", "log", "--format=%H", revisionRange, "--", ".release.toml")
	if err != nil {
		return "", 0, false, err
	}
	manifestCommits := map[string]bool{}
	for _, line := range strings.Split(manifestOut, "\n") {
		if line != "" {
			manifestCommits[line] = true
		}
	}
	if len(releaseCommits) == 0 && len(manifestCommits) == 0 {
		return "", 0, false, nil
	}
	if len(releaseCommits) != 1 || len(manifestCommits) != 1 || !manifestCommits[releaseCommits[0].sha] {
		return "", 0, false, errf("push contains an ambiguous or malformed release change")
	}
	releaseSHA := releaseCommits[0].sha

	pullsAny, err := ghJSON(repo, "commits/"+releaseSHA+"/pulls")
	if err != nil {
		return "", 0, false, err
	}
	pulls, _ := pullsAny.([]any)
	var merged []map[string]any
	for _, item := range pulls {
		pull := asMap(item)
		if truthy(pull["merged_at"]) &&
			getStr(asMap(pull["base"]), "ref") == "main" &&
			releaseTitle.MatchString(getStr(pull, "title")) {
			merged = append(merged, pull)
		}
	}
	if len(merged) != 1 {
		return "", 0, false, errf("release commit must belong to exactly one merged release PR")
	}

	number := getInt(merged[0], "number")
	pullAny, err := ghJSON(repo, fmt.Sprintf("pulls/%d", number))
	if err != nil {
		return "", 0, false, err
	}
	pull := asMap(pullAny)
	head := getStr(asMap(pull["head"]), "sha")
	if !regexp.MustCompile(`^[0-9a-f]{40}$`).MatchString(head) ||
		!truthy(pull["merged_at"]) ||
		getStr(asMap(pull["base"]), "ref") != "main" ||
		getStr(pull, "merge_commit_sha") != releaseSHA ||
		!releaseTitle.MatchString(getStr(pull, "title")) {
		return "", 0, false, errf("merged release PR #%d has invalid head metadata", number)
	}

	if _, err := run("git", "fetch", "--no-tags", "origin", fmt.Sprintf("refs/pull/%d/head", number)); err != nil {
		return "", 0, false, err
	}
	fetched, err := run("git", "rev-parse", "FETCH_HEAD^{commit}")
	if err != nil {
		return "", 0, false, err
	}
	if fetched != head {
		return "", 0, false, errf("release PR #%d head changed while resolving it", number)
	}
	return head, number, true, nil
}

func prepare(previewOnly bool, upstream, fork string) error {
	if err := ensurePreflight(upstream); err != nil {
		return err
	}
	owner, name, err := repository(upstream)
	if err != nil {
		return err
	}
	repo := owner + "/" + name
	forkOwner, _, err := repository(fork)
	if err != nil {
		return err
	}
	branch := upstream + "/main"
	// Re-fetch tags in case a background process (e.g. lazygit with
	// fetch.pruneTags) pruned them between ensurePreflight and here.
	if _, err := run("git", "fetch", upstream, "--tags", "--force", "--no-prune-tags"); err != nil {
		return err
	}
	previousTag, err := latestTag()
	if err != nil {
		return err
	}
	previousCutoff, err := releaseCutoff(previousTag)
	if err != nil {
		return err
	}
	changes, err := discoverChanges(repo, previousCutoff, branch)
	if err != nil {
		return err
	}
	if len(changes) == 0 {
		return errf("No commits exist after %s", previousTag)
	}
	tagsOut, err := run("git", "tag", "--list")
	if err != nil {
		return err
	}
	tags := map[string]bool{}
	for _, tag := range strings.Split(tagsOut, "\n") {
		tags[tag] = true
	}
	included, version, channel, err := chooseRelease(newStdPrompter(), changes, previousTag[1:], tags)
	if err != nil {
		return err
	}
	migrations, err := migrationChanges(included)
	if err != nil {
		return err
	}
	var undocumented []string
	for _, change := range migrations {
		if !change.includeInNotes {
			undocumented = append(undocumented, change.shortRef())
		}
	}
	if len(undocumented) > 0 {
		return errf("Database migrations must be included in release notes: %s", strings.Join(undocumented, ", "))
	}
	cutoff := included[len(included)-1].commits[len(included[len(included)-1].commits)-1]
	logged, err := commitLog(previousCutoff + ".." + cutoff)
	if err != nil {
		return err
	}
	var commits []Commit
	for _, commit := range logged {
		if !releaseTitle.MatchString(commit.title) {
			commits = append(commits, commit)
		}
	}
	contributors := allContributors(included, commits)
	date := time.Now().UTC().Format("2006-01-02")
	changelogSection := renderChangelogSection(version, date, included)
	notes := renderReleaseNotes(version, previousTag, cutoff, included, contributors)
	fmt.Println("\nIncluded:")
	fmt.Printf("  %d change groups, %d commits, %d contributors\n", len(included), len(commits), len(contributors))
	fmt.Printf("Deferred: %d change groups\n", len(changes)-len(included))
	fmt.Printf("Version:  %s (%s)\n", version, channel)
	fmt.Println("\nRelease notes preview:")
	fmt.Println()
	fmt.Println(notes)
	if previewOnly {
		return nil
	}
	confirmed, err := newStdPrompter().confirm("Create and push this release PR?", false)
	if err != nil {
		return err
	}
	if !confirmed {
		return errf("Release cancelled")
	}

	releaseBranch := "release/v" + version
	worktree := filepath.Join(rootDir, ".worktrees", "release-v"+version)
	branchList, err := run("git", "branch", "--list", releaseBranch)
	if err != nil {
		return err
	}
	if _, statErr := os.Stat(worktree); statErr == nil || branchList != "" {
		return errf("Release branch or worktree already exists: %s", releaseBranch)
	}
	if _, err := runIn(rootDir, false, "git", "worktree", "add", "-b", releaseBranch, worktree, cutoff); err != nil {
		return err
	}
	if err := populateRelease(worktree, repo, forkOwner, releaseBranch, version, previousTag, cutoff, channel, included, changelogSection, notes); err != nil {
		fmt.Fprintf(os.Stderr, "Release worktree preserved for recovery: %s\n", worktree)
		return err
	}
	_, err = runIn(rootDir, false, "git", "worktree", "remove", worktree)
	return err
}

func populateRelease(
	worktree, repo, forkOwner, releaseBranch, version, previousTag, cutoff, channel string,
	included []*Change,
	changelogSection, notes string,
) error {
	for _, relative := range versionFiles {
		if err := setVersion(filepath.Join(worktree, relative), version); err != nil {
			return err
		}
	}
	changelogPath := filepath.Join(worktree, "CHANGELOG.md")
	existing, err := os.ReadFile(changelogPath)
	if err != nil {
		return err
	}
	updated, err := prependChangelog(string(existing), changelogSection, version)
	if err != nil {
		return err
	}
	if err := os.WriteFile(changelogPath, []byte(updated), 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(worktree, ".github", "release-notes.md"), []byte(notes), 0o644); err != nil {
		return err
	}
	if err := writeManifest(filepath.Join(worktree, ".release.toml"), version, channel, previousTag, cutoff, included); err != nil {
		return err
	}
	if _, err := runIn(worktree, true, append([]string{"git", "add"}, releaseFiles...)...); err != nil {
		return err
	}
	staged, err := runIn(worktree, true, "git", "diff", "--cached", "--name-only")
	if err != nil {
		return err
	}
	allowed := map[string]bool{}
	for _, file := range releaseFiles {
		allowed[file] = true
	}
	unexpected := map[string]bool{}
	for _, file := range strings.Split(staged, "\n") {
		if file != "" && !allowed[file] {
			unexpected[file] = true
		}
	}
	unstaged, err := runIn(worktree, true, "git", "diff", "--name-only")
	if err != nil {
		return err
	}
	untracked, err := runIn(worktree, true, "git", "ls-files", "--others", "--exclude-standard")
	if err != nil {
		return err
	}
	for _, extra := range []string{unstaged, untracked} {
		for _, file := range strings.Split(extra, "\n") {
			if file != "" {
				unexpected[file] = true
			}
		}
	}
	if len(unexpected) > 0 {
		files := make([]string, 0, len(unexpected))
		for file := range unexpected {
			files = append(files, file)
		}
		return errf("Release preparation changed unexpected files: %s", pyStrList(files))
	}
	if _, err := runIn(worktree, true, "git", "diff", "--cached", "--check"); err != nil {
		return err
	}
	if _, err := runIn(worktree, false, "git", "commit", "-s", "-m", "chore(release): v"+version); err != nil {
		return err
	}
	if _, err := runIn(worktree, false, "git", "push", forkRemoteName, releaseBranch); err != nil {
		return err
	}
	body := prBody(version, previousTag, cutoff, included, changelogSection)
	tmpdir, err := os.MkdirTemp("", "release-pr-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmpdir)
	bodyPath := filepath.Join(tmpdir, "release-pr-body.md")
	if err := os.WriteFile(bodyPath, []byte(body), 0o644); err != nil {
		return err
	}
	url, err := runIn(worktree, true,
		"gh", "pr", "create",
		"--repo", repo,
		"--head", forkOwner+":"+releaseBranch,
		"--base", "main",
		"--title", "chore(release): v"+version,
		"--body-file", bodyPath,
	)
	if err != nil {
		return err
	}
	fmt.Printf("\nRelease PR created: %s\n", url)
	fmt.Println("Merge with squash, rebase, or the merge queue; the selected cutoff remains the release target.")
	return nil
}

// forkRemoteName carries the --fork flag value into the push step.
var forkRemoteName string

func pyStrList(items []string) string {
	sort.Strings(items)
	quoted := make([]string, len(items))
	for i, item := range items {
		quoted[i] = "'" + item + "'"
	}
	return "[" + strings.Join(quoted, ", ") + "]"
}

func asMap(value any) map[string]any {
	m, _ := value.(map[string]any)
	return m
}

func getStr(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

func getInt(m map[string]any, key string) int {
	f, _ := m[key].(float64)
	return int(f)
}

func truthy(value any) bool {
	switch v := value.(type) {
	case nil:
		return false
	case bool:
		return v
	case string:
		return v != ""
	case float64:
		return v != 0
	default:
		return true
	}
}

func main() {
	preview := flag.Bool("preview", false, "render the release without creating a branch or PR")
	upstream := flag.String("upstream", "upstream", "remote for the canonical repository")
	fork := flag.String("fork", "origin", "remote that receives the release branch")
	resolvePush := flag.Bool("resolve-push", false, "resolve a pushed release commit to its exact PR head")
	before := flag.String("before", "", "first commit of the pushed range")
	after := flag.String("after", "", "last commit of the pushed range")
	repoFlag := flag.String("repo", "", "owner/name of the GitHub repository")
	flag.Parse()

	if top, err := runIn(".", true, "git", "rev-parse", "--show-toplevel"); err == nil {
		rootDir = top
	}
	forkRemoteName = *fork

	err := func() error {
		if *resolvePush {
			if *before == "" || *after == "" || *repoFlag == "" {
				return errf("--resolve-push requires --before, --after, and --repo")
			}
			head, _, ok, err := resolveReleasePush(*before, *after, *repoFlag)
			if err != nil {
				return err
			}
			if ok {
				fmt.Println(head)
			}
			return nil
		}
		return prepare(*preview, *upstream, *fork)
	}()
	if err != nil {
		fmt.Fprintf(os.Stderr, "ERROR: %s\n", err)
		os.Exit(1)
	}
}
