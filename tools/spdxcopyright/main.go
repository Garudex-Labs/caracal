// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Command spdxcopyright is a pre-commit hook that ensures the committer's
// SPDX-FileCopyrightText line is present in every staged file that already
// has an SPDX header.
//
//   - Reads committer identity from git config (user.name + user.email)
//   - Adds a fresh header to staged files without one
//   - Skips binary files and files in .reuse/
//   - Uses the current year
//   - Idempotent: does nothing if the email is already in the header
package main

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

var skipDirs = map[string]bool{
	".reuse":       true,
	"node_modules": true,
	".git":         true,
	".venv":        true,
	"__pycache__":  true,
}

var skipExts = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".ico": true,
	".woff": true, ".woff2": true, ".ttf": true, ".eot": true, ".map": true, ".lock": true,
	// Go module manifests: go.mod only accepts // directives and go.sum
	// accepts no comments at all, so header injection corrupts the build.
	".mod": true, ".sum": true,
	// JSON accepts no comments at all; REUSE covers these files through
	// directory annotations instead.
	".json": true,
}

var hashExts = map[string]bool{
	".py": true, ".sh": true, ".yml": true, ".yaml": true, ".toml": true,
	".tf": true, ".tfvars": true, ".conf": true, ".cfg": true, ".env": true,
	".example": true, ".gitignore": true,
}

var slashExts = map[string]bool{".ts": true, ".tsx": true, ".mjs": true, ".js": true}

var markupExts = map[string]bool{".md": true, ".xml": true, ".svg": true, ".html": true}

var hashNames = map[string]bool{
	"Makefile": true, "Dockerfile": true, "Dockerfile.api": true, "Dockerfile.web": true,
	".dockerignore": true, ".editorconfig": true, ".gitattributes": true,
}

func gitOutput(args ...string) string {
	out, _ := exec.Command("git", args...).Output()
	return strings.TrimSpace(string(out))
}

func gitAdd(path string) {
	cmd := exec.Command("git", "add", path)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	_ = cmd.Run()
}

func gitIdentity() (name, email string) {
	name = gitOutput("config", "user.name")
	email = gitOutput("config", "user.email")
	if name == "" || email == "" {
		fmt.Fprintln(os.Stderr, "::error:: git user.name or user.email not configured")
		os.Exit(1)
	}
	return name, email
}

// fileSuffix returns the lowercased extension, treating a leading dot as part
// of the name rather than an extension separator (".gitignore" has none).
func fileSuffix(name string) string {
	i := strings.LastIndexByte(name, '.')
	if i <= 0 {
		return ""
	}
	return strings.ToLower(name[i:])
}

// commentPrefix returns the (prefix, suffix) comment style for a file, or
// ok=false for files that must be skipped.
func commentPrefix(path string) (prefix, suffix string, ok bool) {
	name := filepath.Base(path)
	ext := fileSuffix(name)

	switch {
	case skipExts[ext]:
		return "", "", false
	case hashExts[ext]:
		return "# ", "", true
	case slashExts[ext]:
		return "// ", "", true
	case markupExts[ext]:
		return "<!-- ", " -->", true
	case ext == ".css":
		return "/* ", " */", true
	case hashNames[name]:
		return "# ", "", true
	}
	// default
	return "# ", "", true
}

func alreadyHasEmail(raw []byte, email string) bool {
	head := raw
	if len(head) > 1024 {
		head = head[:1024]
	}
	return bytes.Contains(bytes.ToLower(head), []byte(strings.ToLower(email)))
}

func hasSPDXHeader(raw []byte) bool {
	head := raw
	if len(head) > 512 {
		head = head[:512]
	}
	return bytes.Contains(head, []byte("SPDX-FileCopyrightText"))
}

func detectNewline(raw []byte) string {
	head := raw
	if len(head) > 1024 {
		head = head[:1024]
	}
	if bytes.Contains(head, []byte("\r\n")) {
		return "\r\n"
	}
	return "\n"
}

// splitKeepEnds splits raw into lines, each retaining its trailing newline.
func splitKeepEnds(raw []byte) [][]byte {
	var lines [][]byte
	for len(raw) > 0 {
		i := bytes.IndexByte(raw, '\n')
		if i == -1 {
			lines = append(lines, raw)
			break
		}
		lines = append(lines, raw[:i+1])
		raw = raw[i+1:]
	}
	return lines
}

func writeFileKeepMode(path string, content []byte) error {
	mode := os.FileMode(0o644)
	if info, err := os.Stat(path); err == nil {
		mode = info.Mode()
	}
	return os.WriteFile(path, content, mode)
}

// injectCopyright inserts the committer copyright line after the last
// existing SPDX-FileCopyrightText line. Returns whether the file changed.
func injectCopyright(path, name, email string, year int) bool {
	prefix, suffix, ok := commentPrefix(path)
	if !ok {
		return false
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	nl := detectNewline(raw)
	newLine := fmt.Sprintf("%sSPDX-FileCopyrightText: %d %s <%s>%s%s", prefix, year, name, email, suffix, nl)

	lines := splitKeepEnds(raw)
	lastCopyrightIdx := -1
	for i, line := range lines {
		if bytes.Contains(line, []byte("SPDX-FileCopyrightText")) {
			lastCopyrightIdx = i
		}
	}
	if lastCopyrightIdx == -1 {
		return false
	}

	var out bytes.Buffer
	for i, line := range lines {
		out.Write(line)
		if i == lastCopyrightIdx {
			out.WriteString(newLine)
		}
	}
	return writeFileKeepMode(path, out.Bytes()) == nil
}

// addFreshHeader adds a complete SPDX header to a file that doesn't have one
// yet, preserving a shebang on the first line. Returns whether the file changed.
func addFreshHeader(path, name, email string, year int) bool {
	prefix, suffix, ok := commentPrefix(path)
	if !ok {
		return false
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	nl := detectNewline(raw)

	copyrightLine := fmt.Sprintf("%sSPDX-FileCopyrightText: %d %s <%s>%s", prefix, year, name, email, suffix)
	// REUSE-IgnoreStart
	licenseLine := prefix + "SPDX-License-Identifier: Apache-2.0" + suffix
	// REUSE-IgnoreEnd
	header := copyrightLine + nl + licenseLine + nl + nl

	var out bytes.Buffer
	if bytes.HasPrefix(raw, []byte("#!")) {
		idx := bytes.IndexByte(raw, '\n')
		if idx == -1 {
			out.Write(raw)
			out.WriteString(nl)
			out.WriteString(header)
		} else {
			out.Write(raw[:idx+1])
			out.WriteString(header)
			out.Write(raw[idx+1:])
		}
	} else {
		out.WriteString(header)
		out.Write(raw)
	}
	return writeFileKeepMode(path, out.Bytes()) == nil
}

func stagedFiles() []string {
	out := gitOutput("diff", "--cached", "--name-only", "--diff-filter=ACM")
	var paths []string
	for _, line := range strings.Split(out, "\n") {
		p := strings.TrimSpace(line)
		if p == "" {
			continue
		}
		if _, err := os.Stat(p); err != nil {
			continue
		}
		parts := strings.Split(filepath.ToSlash(p), "/")
		skip := false
		for _, part := range parts {
			if skipDirs[part] {
				skip = true
				break
			}
		}
		if skip || (len(parts) >= 2 && parts[0] == "fuzz" && parts[1] == "corpus") {
			continue
		}
		paths = append(paths, p)
	}
	return paths
}

func main() {
	name, email := gitIdentity()
	year := time.Now().Year()
	var modified []string
	var created []string

	for _, path := range stagedFiles() {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}

		if !hasSPDXHeader(raw) {
			// New file without header - add a fresh one
			if addFreshHeader(path, name, email, year) {
				gitAdd(path)
				created = append(created, path)
			}
			continue
		}
		if alreadyHasEmail(raw, email) {
			continue
		}

		if injectCopyright(path, name, email, year) {
			// re-stage the file
			gitAdd(path)
			modified = append(modified, path)
		}
	}

	if len(created) > 0 {
		fmt.Printf("[spdx-update] Added SPDX header to %d new file(s):\n", len(created))
		for _, f := range created {
			fmt.Printf("  %s\n", f)
		}
	}
	if len(modified) > 0 {
		fmt.Printf("[spdx-update] Added copyright line to %d file(s):\n", len(modified))
		for _, f := range modified {
			fmt.Printf("  %s\n", f)
		}
	}
}
