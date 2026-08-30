// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testChange(overrides ...func(*Change)) *Change {
	change := &Change{
		commits:        []string{strings.Repeat("a", 40)},
		title:          "feat(cli): add safe releases",
		authorName:     "Ryan",
		authorEmail:    "ryan@example.com",
		pr:             42,
		url:            "https://github.com/Garudex-Labs/caracal/pull/42",
		category:       "Features",
		includeInNotes: true,
	}
	for _, override := range overrides {
		override(change)
	}
	return change
}

func stubRun(t *testing.T, fake func(args ...string) (string, error)) {
	t.Helper()
	original := run
	run = fake
	t.Cleanup(func() { run = original })
}

func stubGHJSON(t *testing.T, fake func(repo, endpoint string) (any, error)) {
	t.Helper()
	original := ghJSON
	ghJSON = fake
	t.Cleanup(func() { ghJSON = original })
}

func stubCommitLog(t *testing.T, fake func(revisionRange string) ([]Commit, error)) {
	t.Helper()
	original := commitLog
	commitLog = fake
	t.Cleanup(func() { commitLog = original })
}

func TestBumpVersion(t *testing.T) {
	cases := []struct {
		bump string
		want string
	}{
		{"patch", "1.10.8"},
		{"feature", "1.11.0"},
		{"major", "2.0.0"},
	}
	for _, c := range cases {
		got, err := bumpVersion("1.10.7", c.bump)
		if err != nil {
			t.Fatalf("bumpVersion(1.10.7, %s): %v", c.bump, err)
		}
		if got != c.want {
			t.Errorf("bumpVersion(1.10.7, %s) = %s, want %s", c.bump, got, c.want)
		}
	}
}

// scriptedPrompter answers chooseRelease's questions the way the interactive
// flow would when accepting every default except the explicit choices below.
type scriptedPrompter struct {
	t *testing.T
}

func (p *scriptedPrompter) selectOne(question string, options []string, defaultIndex int) (int, error) {
	switch {
	case strings.HasPrefix(question, "Release through"):
		if defaultIndex != len(options)-1 {
			p.t.Errorf("cutoff default = %d, want last option %d", defaultIndex, len(options)-1)
		}
		return 0, nil
	case question == "Version bump:":
		for i, option := range options {
			if option == "patch" {
				return i, nil
			}
		}
	case question == "Release channel:":
		for i, option := range options {
			if option == "stable" {
				return i, nil
			}
		}
	}
	p.t.Fatalf("unexpected selectOne question: %q", question)
	return 0, nil
}

func (p *scriptedPrompter) checkbox(question string, options []string, checked []bool) ([]int, error) {
	return []int{0}, nil
}

func (p *scriptedPrompter) confirm(question string, defaultAnswer bool) (bool, error) {
	if !strings.HasPrefix(question, "Edit selected") {
		p.t.Errorf("unexpected confirm question: %q", question)
	}
	return false, nil
}

func (p *scriptedPrompter) text(question, defaultAnswer string) (string, error) {
	p.t.Fatalf("unexpected text question: %q", question)
	return "", nil
}

func TestChooseReleaseDefaultsToLastChoice(t *testing.T) {
	change := testChange()

	included, version, channel, err := chooseRelease(&scriptedPrompter{t: t}, []*Change{change}, "1.10.7", map[string]bool{})
	if err != nil {
		t.Fatalf("chooseRelease: %v", err)
	}
	if len(included) != 1 || included[0] != change {
		t.Fatalf("included = %v, want the single input change", included)
	}
	if !included[0].includeInNotes {
		t.Errorf("includeInNotes = false, want true")
	}
	if included[0].title != "feat(cli): add safe releases" || included[0].category != "Features" {
		t.Errorf("change mutated: title=%q category=%q", included[0].title, included[0].category)
	}
	if version != "1.10.8" || channel != "stable" {
		t.Errorf("(version, channel) = (%s, %s), want (1.10.8, stable)", version, channel)
	}
}

func TestChangelogPrependsWithoutRewritingHistory(t *testing.T) {
	history := "<!-- custom header -->\n\n# Changelog\n\n" +
		"All notable changes to this project will be documented in this file.\n\n" +
		"## [1.10.7] - hand-edited history\n\nKeep this text exactly.\n"
	section := "## [1.10.8] - 2026-07-28\n\n### Fixes\n\n- Fixed it"

	updated, err := prependChangelog(history, section, "1.10.8")
	if err != nil {
		t.Fatalf("prependChangelog: %v", err)
	}
	if !strings.HasSuffix(updated, "## [1.10.7] - hand-edited history\n\nKeep this text exactly.\n") {
		t.Errorf("existing history tail was rewritten:\n%s", updated)
	}
	if !strings.Contains(updated, section) {
		t.Errorf("new section missing from changelog:\n%s", updated)
	}
}

func TestChangelogRejectsDuplicateVersion(t *testing.T) {
	history := "# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n## [1.0.0]\n"

	_, err := prependChangelog(history, "## [1.0.0]", "1.0.0")
	if err == nil || !strings.Contains(err.Error(), "already contains") {
		t.Fatalf("err = %v, want 'already contains'", err)
	}
}

func TestChangelogRequiresIntroduction(t *testing.T) {
	_, err := prependChangelog("# Changelog\n", "## [1.0.0]", "1.0.0")
	if err == nil || !strings.Contains(err.Error(), "introduction was not found") {
		t.Fatalf("err = %v, want 'introduction was not found'", err)
	}
}

func TestSetVersionUpdatesProjectTomlAndTopLevelJSON(t *testing.T) {
	dir := t.TempDir()
	tomlPath := filepath.Join(dir, "pyproject.toml")
	if err := os.WriteFile(tomlPath, []byte("[tool.example]\nversion = \"keep\"\n\n[project]\nname = \"demo\"\nversion = \"1.0.0\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	jsonPath := filepath.Join(dir, "package.json")
	if err := os.WriteFile(jsonPath, []byte("{\n  \"name\": \"demo\",\n  \"version\": \"1.0.0\",\n  \"nested\": {\n    \"version\": \"keep\"\n  }\n}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := setVersion(tomlPath, "1.1.0"); err != nil {
		t.Fatalf("setVersion(toml): %v", err)
	}
	if err := setVersion(jsonPath, "1.1.0"); err != nil {
		t.Fatalf("setVersion(json): %v", err)
	}

	tomlText, err := os.ReadFile(tomlPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(tomlText), "[tool.example]\nversion = \"keep\"") {
		t.Errorf("[tool.example] version was rewritten:\n%s", tomlText)
	}
	if !strings.Contains(string(tomlText), "[project]\nname = \"demo\"\nversion = \"1.1.0\"") {
		t.Errorf("[project] version was not updated:\n%s", tomlText)
	}
	jsonText, err := os.ReadFile(jsonPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(jsonText), "  \"version\": \"1.1.0\"") {
		t.Errorf("top-level json version was not updated:\n%s", jsonText)
	}
	if !strings.Contains(string(jsonText), "    \"version\": \"keep\"") {
		t.Errorf("nested json version was rewritten:\n%s", jsonText)
	}
}

func TestSetVersionRejectsMissingVersion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "package.json")
	if err := os.WriteFile(path, []byte("{\n  \"name\": \"demo\"\n}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	err := setVersion(path, "1.1.0")
	if err == nil || !strings.Contains(err.Error(), "top-level version") {
		t.Fatalf("err = %v, want 'top-level version'", err)
	}
}

func TestLatestTagChoosesHighestStableEvenWhenDetached(t *testing.T) {
	stubRun(t, func(args ...string) (string, error) {
		return "v1.10.7\nv1.11.0-rc.1\nv1.10.9\n", nil
	})

	tag, err := latestTag()
	if err != nil {
		t.Fatalf("latestTag: %v", err)
	}
	if tag != "v1.10.9" {
		t.Errorf("latestTag() = %s, want v1.10.9", tag)
	}
}

func TestReleaseCutoffUsesManifestWithOldTagFallback(t *testing.T) {
	cutoff := strings.Repeat("b", 40)
	oldTagSHA := strings.Repeat("a", 40)
	stubRun(t, func(args ...string) (string, error) {
		switch {
		case len(args) >= 3 && args[0] == "git" && args[1] == "show" && args[2] == "v1.10.8:.release.toml":
			return "cutoff = \"" + cutoff + "\"\n", nil
		case len(args) >= 3 && args[0] == "git" && args[1] == "show" && args[2] == "v1.10.7:.release.toml":
			return "", errf("missing manifest")
		case len(args) >= 3 && args[0] == "git" && args[1] == "rev-parse" && args[2] == "v1.10.7^{commit}":
			return oldTagSHA, nil
		case len(args) >= 3 && args[0] == "git" && args[1] == "cat-file" && args[2] == "-e":
			return "", nil
		}
		t.Fatalf("unexpected command: %v", args)
		return "", nil
	})

	got, err := releaseCutoff("v1.10.8")
	if err != nil {
		t.Fatalf("releaseCutoff(v1.10.8): %v", err)
	}
	if got != cutoff {
		t.Errorf("releaseCutoff(v1.10.8) = %s, want %s", got, cutoff)
	}
	got, err = releaseCutoff("v1.10.7")
	if err != nil {
		t.Fatalf("releaseCutoff(v1.10.7): %v", err)
	}
	if got != oldTagSHA {
		t.Errorf("releaseCutoff(v1.10.7) = %s, want %s", got, oldTagSHA)
	}
}

func TestDiscoverySkipsPriorReleaseMetadata(t *testing.T) {
	releaseCommit := Commit{strings.Repeat("a", 40), "Maintainer", "m@example.com", "chore(release): v1.10.8", ""}
	featureCommit := Commit{strings.Repeat("b", 40), "Contributor", "c@example.com", "feat: next change", ""}
	stubCommitLog(t, func(revisionRange string) ([]Commit, error) {
		return []Commit{releaseCommit, featureCommit}, nil
	})
	stubGHJSON(t, func(repo, endpoint string) (any, error) {
		if strings.Contains(endpoint, releaseCommit.sha) {
			return []any{map[string]any{
				"number":    float64(1),
				"merged_at": "2026-08-01",
				"base":      map[string]any{"ref": "main"},
				"title":     releaseCommit.title,
			}}, nil
		}
		return []any{}, nil
	})

	changes, err := discoverChanges("Garudex-Labs/caracal", strings.Repeat("c", 40), "upstream/main")
	if err != nil {
		t.Fatalf("discoverChanges: %v", err)
	}
	if len(changes) != 1 || changes[0].title != "feat: next change" {
		titles := make([]string, len(changes))
		for i, change := range changes {
			titles[i] = change.title
		}
		t.Errorf("change titles = %v, want [feat: next change]", titles)
	}
}

func TestResolveReleasePushUsesExactMergedPRHead(t *testing.T) {
	normal := Commit{strings.Repeat("a", 40), "A", "a@example.com", "fix: normal", ""}
	merged := Commit{strings.Repeat("b", 40), "B", "b@example.com", "chore(release): v1.10.8", ""}
	head := strings.Repeat("c", 40)
	before := strings.Repeat("0", 40)
	after := strings.Repeat("f", 40)
	stubCommitLog(t, func(revisionRange string) ([]Commit, error) {
		return []Commit{normal, merged}, nil
	})
	stubRun(t, func(args ...string) (string, error) {
		switch {
		case len(args) >= 4 && args[0] == "git" && args[1] == "log" && args[2] == "--format=%H" && args[3] == before+".."+after:
			return merged.sha, nil
		case len(args) >= 3 && args[0] == "git" && args[1] == "fetch" && args[2] == "--no-tags":
			return "", nil
		case len(args) >= 3 && args[0] == "git" && args[1] == "rev-parse" && args[2] == "FETCH_HEAD^{commit}":
			return head, nil
		}
		t.Fatalf("unexpected command: %v", args)
		return "", nil
	})
	stubGHJSON(t, func(repo, endpoint string) (any, error) {
		switch endpoint {
		case "commits/" + merged.sha + "/pulls":
			return []any{map[string]any{
				"number":    float64(42),
				"merged_at": "2026-08-02T00:00:00Z",
				"base":      map[string]any{"ref": "main"},
				"title":     merged.title,
			}}, nil
		case "pulls/42":
			return map[string]any{
				"merged_at":        "2026-08-02T00:00:00Z",
				"merge_commit_sha": merged.sha,
				"title":            merged.title,
				"base":             map[string]any{"ref": "main"},
				"head":             map[string]any{"sha": head},
			}, nil
		}
		t.Fatalf("unexpected endpoint: %s", endpoint)
		return nil, nil
	})

	gotHead, number, ok, err := resolveReleasePush(before, after, "Garudex-Labs/caracal")
	if err != nil {
		t.Fatalf("resolveReleasePush: %v", err)
	}
	if !ok || gotHead != head || number != 42 {
		t.Errorf("resolveReleasePush = (%s, %d, %t), want (%s, 42, true)", gotHead, number, ok, head)
	}
}

func TestResolveReleasePushRejectsManifestWithoutReleaseCommit(t *testing.T) {
	normal := Commit{strings.Repeat("a", 40), "A", "a@example.com", "fix: normal", ""}
	stubCommitLog(t, func(revisionRange string) ([]Commit, error) {
		return []Commit{normal}, nil
	})
	stubRun(t, func(args ...string) (string, error) {
		return normal.sha, nil
	})

	_, _, _, err := resolveReleasePush(strings.Repeat("0", 40), strings.Repeat("f", 40), "Garudex-Labs/caracal")
	if err == nil || !strings.Contains(err.Error(), "ambiguous or malformed") {
		t.Fatalf("err = %v, want 'ambiguous or malformed'", err)
	}
}

func TestReleasePRInstructionsAllowLinearMerges(t *testing.T) {
	body := prBody("1.10.8", "v1.10.7", strings.Repeat("a", 40), []*Change{testChange()}, "preview")

	if !strings.Contains(body, "squash, rebase, or the merge queue") {
		t.Errorf("PR body does not allow linear merges:\n%s", body)
	}
	if strings.Contains(body, "merge commit") {
		t.Errorf("PR body mentions merge commits:\n%s", body)
	}
}

func TestWriteManifestSupportsNoPullRequests(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".release.toml")

	change := testChange(func(c *Change) { c.pr = 0 })
	if err := writeManifest(path, "1.1.0", "stable", "v1.0.0", strings.Repeat("a", 40), []*Change{change}); err != nil {
		t.Fatalf("writeManifest: %v", err)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	manifest := string(raw)
	for _, want := range []string{
		"version = \"1.1.0\"",
		"cutoff = \"" + strings.Repeat("a", 40) + "\"",
		"included_prs = []",
	} {
		if !strings.Contains(manifest, want) {
			t.Errorf("manifest missing %q:\n%s", want, manifest)
		}
	}
}

func TestVersionMustMatchReleaseChannel(t *testing.T) {
	if err := validateVersionChannel("1.1.0", "stable"); err != nil {
		t.Errorf("validateVersionChannel(1.1.0, stable) = %v, want nil", err)
	}
	if err := validateVersionChannel("1.1.0-rc.1", "rc"); err != nil {
		t.Errorf("validateVersionChannel(1.1.0-rc.1, rc) = %v, want nil", err)
	}
	err := validateVersionChannel("1.1.0-rc.1", "stable")
	if err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Errorf("validateVersionChannel(1.1.0-rc.1, stable) = %v, want 'does not match'", err)
	}
	err = validateVersionChannel("1.1.0-beta.1", "rc")
	if err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Errorf("validateVersionChannel(1.1.0-beta.1, rc) = %v, want 'does not match'", err)
	}
}

func TestCommitAuthorsAreIncludedAsContributors(t *testing.T) {
	contributors := allContributors(
		[]*Change{testChange(func(c *Change) { c.contributor = &Contributor{name: "owner", login: "owner"} })},
		[]Commit{{strings.Repeat("a", 40), "Coauthor", "123+coauthor@users.noreply.github.com", "feat: work", "feat: work"}},
	)

	labels := make([]string, len(contributors))
	for i, contributor := range contributors {
		labels[i] = contributor.label()
	}
	if len(labels) != 2 || labels[0] != "@coauthor" || labels[1] != "@owner" {
		t.Errorf("labels = %v, want [@coauthor @owner]", labels)
	}
}

func TestHumanNamesEndingInBotAreNotFiltered(t *testing.T) {
	contributors := allContributors(
		[]*Change{
			testChange(func(c *Change) { c.contributor = &Contributor{name: "Talbot", login: "talbot"} }),
			testChange(func(c *Change) { c.contributor = &Contributor{name: "dependabot", login: "dependabot[bot]"} }),
		},
		nil,
	)

	labels := make([]string, len(contributors))
	for i, contributor := range contributors {
		labels[i] = contributor.label()
	}
	if len(labels) != 1 || labels[0] != "@talbot" {
		t.Errorf("labels = %v, want [@talbot]", labels)
	}
}

func TestReleaseNotesIncludeVersionAndComparisonLink(t *testing.T) {
	notes := renderReleaseNotes(
		"1.10.8",
		"v1.10.7",
		strings.Repeat("a", 40),
		[]*Change{testChange()},
		[]Contributor{
			{name: "Ryan", login: "ryan"},
			{name: "New Person", login: "new-person", firstTime: true},
		},
	)

	for _, want := range []string{
		"v1.10.7...v1.10.8",
		"add safe releases",
		"docs/security/release-verification.md",
	} {
		if !strings.Contains(notes, want) {
			t.Errorf("notes missing %q:\n%s", want, notes)
		}
	}
}

func TestChangelogUsesOnlySelectedPublicNotes(t *testing.T) {
	section := renderChangelogSection(
		"1.10.8",
		"2026-07-28",
		[]*Change{
			testChange(),
			testChange(func(c *Change) {
				c.title = "ci: internal work"
				c.category = "Maintenance"
				c.includeInNotes = false
			}),
		},
	)

	if !strings.Contains(section, "add safe releases") {
		t.Errorf("selected note missing from section:\n%s", section)
	}
	if strings.Contains(section, "internal work") {
		t.Errorf("unselected note leaked into section:\n%s", section)
	}
}
