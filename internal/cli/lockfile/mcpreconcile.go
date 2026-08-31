// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package lockfile

// MCP servers are entries inside a shared harness config file rather than
// standalone files, so pruning is by server name within one config file. An
// entry is removed only when a prior install of this agent wrote it, the
// current install no longer writes it, and no other installed entry still
// claims the same name in the same resolved config file.

// agentManagedMcps returns the MCP server names, stored config path, and
// servers key a matching prior agent install recorded, before the current
// pull replaces its entry.
func agentManagedMcps(harness, agentID, scope, directory string) (names []string, path, key string) {
	_, registry, err := ReadRegistry(false)
	if err != nil || registry == nil {
		return nil, "", ""
	}
	section := registry.Harnesses[harness]
	if section == nil {
		return nil, "", ""
	}
	if idx := findAgent(section.Agents, agentID, scope, directory); idx >= 0 {
		e := section.Agents[idx]
		return append([]string{}, e.ManagedMcps...), e.ManagedMcpPath, e.ManagedMcpKey
	}
	return nil, "", ""
}

// referencedManagedMcps maps each resolved absolute config path to the MCP
// server names still claimed by any installed entry, so pruning never removes
// a name another install still writes to the same shared config file.
func referencedManagedMcps(data *File) map[string]map[string]bool {
	referenced := map[string]map[string]bool{}
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
					if e.ManagedMcpPath == "" || len(e.ManagedMcps) == 0 {
						continue
					}
					abs := resolveManagedPromptPath(e.ManagedMcpPath, e.Directory)
					if abs == "" {
						continue
					}
					if referenced[abs] == nil {
						referenced[abs] = map[string]bool{}
					}
					for _, n := range e.ManagedMcps {
						referenced[abs][n] = true
					}
				}
			}
		}
	}
	return referenced
}

// StaleManagedMcps returns the resolved absolute config path, its servers key,
// and the MCP server names a prior install of this agent wrote there that the
// current install no longer writes and no other installed entry still claims.
// Call after UpsertAgent so the current install's own names are protected.
func StaleManagedMcps(entry Entry, oldNames []string, oldPath, oldKey string) (absPath, key string, stale []string) {
	if len(oldNames) == 0 || oldPath == "" {
		return "", "", nil
	}
	absPath = resolveManagedPromptPath(oldPath, entry.Directory)
	if absPath == "" {
		return "", "", nil
	}
	data, err := Read()
	if err != nil {
		return "", "", nil
	}
	referenced := referencedManagedMcps(data)[absPath]
	newNames := map[string]bool{}
	for _, n := range entry.ManagedMcps {
		newNames[n] = true
	}
	for _, n := range oldNames {
		if newNames[n] {
			continue
		}
		if referenced != nil && referenced[n] {
			continue
		}
		stale = append(stale, n)
	}
	return absPath, oldKey, stale
}

// UpsertAgentWithReconcile records the agent install, reconciles native prompt
// files, and computes the stale MCP prune plan (resolved config path, servers
// key, and server names) the caller must remove from the shared harness config.
// MCP entries live inside a config file the harness also owns, so the caller
// performs the format-aware key removal.
func UpsertAgentWithReconcile(harness string, entry Entry) (prompts []string, mcpPath, mcpKey string, staleMcps []string, err error) {
	oldPrompts := agentManagedPrompts(harness, entry.ID, entry.Scope, entry.Directory)
	oldMcps, oldMcpPath, oldMcpKey := agentManagedMcps(harness, entry.ID, entry.Scope, entry.Directory)
	if err = UpsertAgent(harness, entry); err != nil {
		return nil, "", "", nil, err
	}
	prompts, err = ReconcileManagedPrompts(entry.Directory, oldPrompts, entry.ManagedPrompts)
	if err != nil {
		return prompts, "", "", nil, err
	}
	mcpPath, mcpKey, staleMcps = StaleManagedMcps(entry, oldMcps, oldMcpPath, oldMcpKey)
	return prompts, mcpPath, mcpKey, staleMcps, nil
}
