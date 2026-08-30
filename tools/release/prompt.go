// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// prompter abstracts the interactive questions so tests can script answers.
type prompter interface {
	selectOne(question string, options []string, defaultIndex int) (int, error)
	checkbox(question string, options []string, checked []bool) ([]int, error)
	confirm(question string, defaultAnswer bool) (bool, error)
	text(question, defaultAnswer string) (string, error)
}

type stdPrompter struct {
	reader *bufio.Reader
}

func newStdPrompter() prompter {
	return &stdPrompter{reader: bufio.NewReader(os.Stdin)}
}

func (p *stdPrompter) readLine() (string, error) {
	line, err := p.reader.ReadString('\n')
	if err != nil && line == "" {
		return "", errf("Release cancelled")
	}
	return strings.TrimSpace(line), nil
}

func (p *stdPrompter) selectOne(question string, options []string, defaultIndex int) (int, error) {
	fmt.Println(question)
	for i, option := range options {
		marker := " "
		if i == defaultIndex {
			marker = "*"
		}
		fmt.Printf(" %s %2d) %s\n", marker, i+1, option)
	}
	for {
		fmt.Printf("Choice [%d]: ", defaultIndex+1)
		answer, err := p.readLine()
		if err != nil {
			return 0, err
		}
		if answer == "" {
			return defaultIndex, nil
		}
		index, err := strconv.Atoi(answer)
		if err == nil && index >= 1 && index <= len(options) {
			return index - 1, nil
		}
		fmt.Println("Enter a number from the list.")
	}
}

func (p *stdPrompter) checkbox(question string, options []string, checked []bool) ([]int, error) {
	fmt.Println(question)
	var defaults []string
	for i, option := range options {
		marker := " "
		if checked[i] {
			marker = "x"
			defaults = append(defaults, strconv.Itoa(i+1))
		}
		fmt.Printf(" [%s] %2d) %s\n", marker, i+1, option)
	}
	fmt.Printf("Comma-separated numbers, 'none', or Enter for checked [%s]: ", strings.Join(defaults, ","))
	answer, err := p.readLine()
	if err != nil {
		return nil, err
	}
	if answer == "" {
		var selected []int
		for i, isChecked := range checked {
			if isChecked {
				selected = append(selected, i)
			}
		}
		return selected, nil
	}
	if strings.EqualFold(answer, "none") {
		return nil, nil
	}
	var selected []int
	for _, part := range strings.Split(answer, ",") {
		index, err := strconv.Atoi(strings.TrimSpace(part))
		if err != nil || index < 1 || index > len(options) {
			return nil, errf("Invalid selection: %s", part)
		}
		selected = append(selected, index-1)
	}
	return selected, nil
}

func (p *stdPrompter) confirm(question string, defaultAnswer bool) (bool, error) {
	hint := "y/N"
	if defaultAnswer {
		hint = "Y/n"
	}
	fmt.Printf("%s [%s]: ", question, hint)
	answer, err := p.readLine()
	if err != nil {
		return false, err
	}
	if answer == "" {
		return defaultAnswer, nil
	}
	return strings.EqualFold(answer, "y") || strings.EqualFold(answer, "yes"), nil
}

func (p *stdPrompter) text(question, defaultAnswer string) (string, error) {
	if defaultAnswer != "" {
		fmt.Printf("%s [%s]: ", question, defaultAnswer)
	} else {
		fmt.Printf("%s ", question)
	}
	answer, err := p.readLine()
	if err != nil {
		return "", err
	}
	if answer == "" {
		return defaultAnswer, nil
	}
	return answer, nil
}

func chooseRelease(p prompter, changes []*Change, previousVersion string, tags map[string]bool) ([]*Change, string, string, error) {
	cutoffOptions := make([]string, len(changes))
	for i, change := range changes {
		ref := change.commits[len(change.commits)-1][:7]
		if change.pr != 0 {
			ref = "#" + strconv.Itoa(change.pr)
		}
		plural := ""
		if len(change.commits) != 1 {
			plural = "s"
		}
		cutoffOptions[i] = fmt.Sprintf("%3d. %s  %s  (%d commit%s)",
			i+1, ref, cleanTitle(change.title), len(change.commits), plural)
	}
	cutoffIndex, err := p.selectOne("Release through which pull request or commit?", cutoffOptions, len(changes)-1)
	if err != nil {
		return nil, "", "", err
	}
	included := changes[:cutoffIndex+1]

	noteOptions := make([]string, len(included))
	noteChecked := make([]bool, len(included))
	for i, change := range included {
		noteOptions[i] = fmt.Sprintf("%s: %s", change.category, cleanTitle(change.title))
		noteChecked[i] = change.includeInNotes
	}
	selectedNotes, err := p.checkbox("Which included changes belong in public release notes?", noteOptions, noteChecked)
	if err != nil {
		return nil, "", "", err
	}
	selectedSet := map[int]bool{}
	for _, index := range selectedNotes {
		selectedSet[index] = true
	}
	for i, change := range included {
		change.includeInNotes = selectedSet[i]
	}

	if len(selectedNotes) > 0 {
		edit, err := p.confirm("Edit selected note titles and categories?", false)
		if err != nil {
			return nil, "", "", err
		}
		if edit {
			for _, index := range selectedNotes {
				change := included[index]
				title, err := p.text("Release-note title:", cleanTitle(change.title))
				if err != nil {
					return nil, "", "", err
				}
				if title != "" {
					change.title = title
				} else {
					change.title = cleanTitle(change.title)
				}
				categoryDefault := 0
				for i, category := range categories {
					if category == change.category {
						categoryDefault = i
					}
				}
				categoryIndex, err := p.selectOne("Category:", categories, categoryDefault)
				if err != nil {
					return nil, "", "", err
				}
				change.category = categories[categoryIndex]
				if change.highlight, err = p.confirm("Highlight this change?", false); err != nil {
					return nil, "", "", err
				}
				if change.breaking, err = p.confirm("Breaking change?", change.breaking); err != nil {
					return nil, "", "", err
				}
			}
		}
	}

	suggested := "patch"
	for _, change := range included {
		if change.includeInNotes && change.category == "Features" {
			suggested = "feature"
		}
	}
	for _, change := range included {
		if change.breaking {
			suggested = "major"
		}
	}
	bumpOptions := []string{suggested}
	for _, option := range []string{"patch", "feature", "major", "custom"} {
		if option != suggested {
			bumpOptions = append(bumpOptions, option)
		}
	}
	bumpIndex, err := p.selectOne("Version bump:", bumpOptions, 0)
	if err != nil {
		return nil, "", "", err
	}
	bump := bumpOptions[bumpIndex]

	var version string
	if bump == "custom" {
		if version, err = p.text("Version:", ""); err != nil {
			return nil, "", "", err
		}
	} else if version, err = bumpVersion(previousVersion, bump); err != nil {
		return nil, "", "", err
	}

	channels := []string{"stable", "rc", "beta", "alpha"}
	channelIndex, err := p.selectOne("Release channel:", channels, 0)
	if err != nil {
		return nil, "", "", err
	}
	channel := channels[channelIndex]
	if channel != "stable" && !strings.Contains(version, "-") {
		serial := 1
		for tags[fmt.Sprintf("v%s-%s.%d", version, channel, serial)] {
			serial++
		}
		version = fmt.Sprintf("%s-%s.%d", version, channel, serial)
	}
	if err := validateVersionChannel(version, channel); err != nil {
		return nil, "", "", err
	}
	return included, version, channel, nil
}
