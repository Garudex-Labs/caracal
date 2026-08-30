// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Command gennotices generates THIRD_PARTY_NOTICES.md from Node.js
// dependency licenses.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type pkg struct {
	Name        string
	License     string
	URL         string
	LicenseText string
}

func escapeMD(text string) string {
	return strings.ReplaceAll(text, "|", "\\|")
}

func runCommand(dir string, name string, args ...string) (stdout string, ok bool, failMsg string) {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	var out, errBuf bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errBuf
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return "", false, errBuf.String()
		}
		fmt.Fprintf(os.Stderr, "error: could not run %s: %v\n", name, err)
		os.Exit(1)
	}
	return out.String(), true, ""
}

func getString(m map[string]any, key, fallback string) string {
	v, ok := m[key]
	if !ok {
		return fallback
	}
	s, ok := v.(string)
	if !ok {
		return fmt.Sprintf("%v", v)
	}
	return s
}

// findRoot walks up from the working directory to the repository root.
func findRoot() string {
	dir, err := os.Getwd()
	if err != nil {
		return "."
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "."
		}
		dir = parent
	}
}

// getNodeLicenses collects Node.js dependency licenses via
// license-checker-rspack, preserving the tool's package order.
func getNodeLicenses() []pkg {
	formatPath, err := filepath.Abs(filepath.Join(findRoot(), "tools", "license-format.json"))
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
	stdout, ok, failMsg := runCommand("apps/web",
		"pnpm", "dlx", "license-checker-rspack",
		"--json", "--production", "--customPath", formatPath)
	if !ok {
		fmt.Fprintf(os.Stderr, "Warning: license-checker failed: %s\n", failMsg)
		return nil
	}
	names, infos, err := parseOrderedObject(stdout)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Warning: license-checker output is not valid JSON")
		return nil
	}
	packages := make([]pkg, 0, len(names))
	for _, name := range names {
		info := infos[name]
		packages = append(packages, pkg{
			Name:        name,
			License:     getString(info, "licenses", "Unknown"),
			URL:         getString(info, "repository", ""),
			LicenseText: getString(info, "licenseText", ""),
		})
	}
	return packages
}

// parseOrderedObject decodes a JSON object of objects, keeping key order.
func parseOrderedObject(raw string) ([]string, map[string]map[string]any, error) {
	dec := json.NewDecoder(strings.NewReader(raw))
	tok, err := dec.Token()
	if err != nil {
		return nil, nil, err
	}
	if delim, ok := tok.(json.Delim); !ok || delim != '{' {
		return nil, nil, fmt.Errorf("expected top-level object")
	}
	var names []string
	infos := map[string]map[string]any{}
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, nil, err
		}
		key, ok := keyTok.(string)
		if !ok {
			return nil, nil, fmt.Errorf("expected object key")
		}
		var info map[string]any
		if err := dec.Decode(&info); err != nil {
			return nil, nil, err
		}
		if _, seen := infos[key]; !seen {
			names = append(names, key)
		}
		infos[key] = info
	}
	if _, err := dec.Token(); err != nil {
		return nil, nil, err
	}
	return names, infos, nil
}

func sortByName(packages []pkg) []pkg {
	sorted := make([]pkg, len(packages))
	copy(sorted, packages)
	sort.SliceStable(sorted, func(i, j int) bool {
		return strings.ToLower(sorted[i].Name) < strings.ToLower(sorted[j].Name)
	})
	return sorted
}

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

// generateNotices writes the combined THIRD_PARTY_NOTICES.md file.
func generateNotices(nodePkgs []pkg, output string) {
	var b strings.Builder
	b.WriteString("# Third-Party Notices\n\n")
	b.WriteString("This file lists all third-party dependencies used by Caracal,\n")
	b.WriteString("along with their respective licenses.\n\n")
	fmt.Fprintf(&b, "Generated: %s\n\n", time.Now().UTC().Format("2006-01-02"))
	b.WriteString("---\n\n")

	b.WriteString("## Node.js Dependencies (web)\n\n")
	b.WriteString("| Package | License | URL |\n")
	b.WriteString("|---------|---------|-----|\n")
	for _, p := range sortByName(nodePkgs) {
		fmt.Fprintf(&b, "| %s | %s | %s |\n", escapeMD(p.Name), escapeMD(p.License), escapeMD(p.URL))
	}

	b.WriteString("\n---\n\n")

	b.WriteString("## NOTICE (Apache-2.0 Licensed Dependencies)\n\n")
	b.WriteString("The following dependencies are licensed under the Apache License 2.0.\n")
	b.WriteString("As required by Section 4(d), their NOTICE files are reproduced below\n")
	b.WriteString("where available.\n\n")

	var apachePkgs []pkg
	for _, p := range nodePkgs {
		if strings.Contains(strings.ToLower(p.License), "apache") {
			apachePkgs = append(apachePkgs, p)
		}
	}
	apachePkgs = sortByName(apachePkgs)
	for _, p := range apachePkgs {
		fmt.Fprintf(&b, "### %s\n\n", p.Name)
		if p.LicenseText != "" && p.LicenseText != "UNKNOWN" {
			// Truncate very long license texts to just the NOTICE portion
			fmt.Fprintf(&b, "```\n%s\n```\n\n", truncateRunes(p.LicenseText, 2000))
		} else {
			b.WriteString("NOTICE file not available in package metadata.\n\n")
		}
	}

	if err := os.WriteFile(output, []byte(b.String()), 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "error: could not write %s: %v\n", output, err)
		os.Exit(1)
	}

	fmt.Printf("Generated %s\n", output)
	fmt.Printf("  Node.js packages: %d\n", len(nodePkgs))
	fmt.Printf("  Apache-2.0 packages with NOTICE: %d\n", len(apachePkgs))
}

func main() {
	output := "THIRD_PARTY_NOTICES.md"
	if len(os.Args) > 1 {
		output = os.Args[1]
	}
	generateNotices(getNodeLicenses(), output)
}
