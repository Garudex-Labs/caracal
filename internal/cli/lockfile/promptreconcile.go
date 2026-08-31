// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package lockfile

import (
	"os"
	"path/filepath"
	"strings"
)

// managedPromptMarker is the ownership marker harnessgen writes into every
// native prompt file. Reconcile only ever deletes files carrying it, so a
// user-authored prompt at the same path is never removed.
const managedPromptMarker = "<!-- caracal-managed: prompt"

// resolveManagedPromptPath maps a stored prompt path to an absolute location:
// "~/" against the home directory, a workspace-relative path against the
// install directory. An unresolvable path yields "".
func resolveManagedPromptPath(stored, directory string) string {
	stored = strings.TrimSpace(stored)
	if stored == "" {
		return ""
	}
	if strings.HasPrefix(stored, "~/") {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			return ""
		}
		return filepath.Join(home, stored[2:])
	}
	if filepath.IsAbs(stored) {
		return stored
	}
	if directory == "" {
		return ""
	}
	return filepath.Join(directory, stored)
}

// managedPromptPathSet resolves a list of stored paths to an absolute-path set.
func managedPromptPathSet(paths []string, directory string) map[string]bool {
	out := map[string]bool{}
	for _, p := range paths {
		if abs := resolveManagedPromptPath(p, directory); abs != "" {
			out[abs] = true
		}
	}
	return out
}

// fileHasManagedPromptMarker reports whether a file is a Caracal-authored
// prompt, read from the file head where the marker always sits.
func fileHasManagedPromptMarker(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer func() { _ = f.Close() }()
	buf := make([]byte, 4096)
	n, _ := f.Read(buf)
	return strings.Contains(string(buf[:n]), managedPromptMarker)
}

// pruneStaleManagedPrompts deletes each old file that the current install no
// longer writes and no other install still references, but only when it still
// carries the managed marker. It returns the absolute paths removed.
func pruneStaleManagedPrompts(oldAbs, newAbs, referencedAbs map[string]bool) []string {
	deleted := []string{}
	for abs := range oldAbs {
		if newAbs[abs] || referencedAbs[abs] {
			continue
		}
		if !fileHasManagedPromptMarker(abs) {
			continue
		}
		if os.Remove(abs) == nil {
			deleted = append(deleted, abs)
		}
	}
	return deleted
}

// referencedManagedPrompts is the set of absolute prompt paths still claimed by
// any installed entry across every registry and harness, each resolved against
// its own install directory so per-project and shared user-level files compare
// correctly.
func referencedManagedPrompts(data *File) map[string]bool {
	referenced := map[string]bool{}
	for _, reg := range data.Registries {
		if reg == nil {
			continue
		}
		for _, section := range reg.Harnesses {
			if section == nil {
				continue
			}
			for _, list := range [][]Entry{section.Agents, section.Standalone} {
				for _, e := range list {
					for abs := range managedPromptPathSet(e.ManagedPrompts, e.Directory) {
						referenced[abs] = true
					}
				}
			}
		}
	}
	return referenced
}

// ReconcileManagedPrompts removes native prompt files a prior install of this
// agent wrote that the current install no longer writes. A file is deleted only
// when it still carries the managed marker (never a user file) and no other
// installed entry references it (safe for shared user-level directories).
func ReconcileManagedPrompts(directory string, oldPrompts, newPrompts []string) ([]string, error) {
	if len(oldPrompts) == 0 {
		return nil, nil
	}
	data, err := Read()
	if err != nil {
		return nil, err
	}
	oldAbs := managedPromptPathSet(oldPrompts, directory)
	newAbs := managedPromptPathSet(newPrompts, directory)
	referenced := referencedManagedPrompts(data)
	return pruneStaleManagedPrompts(oldAbs, newAbs, referenced), nil
}

// agentManagedPrompts returns the prompt files a matching agent install
// previously recorded, before the current pull replaces its entry.
func agentManagedPrompts(harness, agentID, scope, directory string) []string {
	_, registry, err := ReadRegistry(false)
	if err != nil || registry == nil {
		return nil
	}
	section := registry.Harnesses[harness]
	if section == nil {
		return nil
	}
	if idx := findAgent(section.Agents, agentID, scope, directory); idx >= 0 {
		return append([]string{}, section.Agents[idx].ManagedPrompts...)
	}
	return nil
}
