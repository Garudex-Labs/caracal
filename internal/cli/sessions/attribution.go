// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"encoding/json"
	"os"
	"strings"

	"github.com/garudex-labs/caracal/internal/cli/lockfile"
)

// kiroDefaultAgent is Kiro's built-in profile; its sessions stay unattributed.
const kiroDefaultAgent = "kiro_default"

// ResolveAgent attributes a session to an installed agent through the harness
// session metadata, the environment, and the installed-agent lockfile.
// Attribution never fails a delivery: unknown sessions return nil identity.
func ResolveAgent(harness, cwd, sessionPath string, lines []string) (agentID, agentVersion any) {
	if harness == "kiro" {
		// Kiro identity comes from session metadata, never the global
		// hook environment; ambiguous lookups fail closed.
		name := kiroAgentName(sessionPath)
		if name == "" || name == kiroDefaultAgent {
			return nil, nil
		}
		entry, err := lockfile.AgentByName(name, harness, cwd)
		if err != nil || entry == nil {
			return nil, nil
		}
		return entryIdentity(entry)
	}

	if id := os.Getenv("CARACAL_AGENT_ID"); id != "" {
		// Prefer a harness-scoped match, but fall back to an unscoped
		// lookup: the harness recorded at pull time may differ from the
		// one reporting the session (e.g. copilot vs copilot-cli).
		entry, _ := lockfile.AgentByID(id, harness)
		if entry == nil {
			entry, _ = lockfile.AgentByID(id, "")
		}
		if entry == nil {
			return nil, nil
		}
		return entryIdentity(entry)
	}

	name := os.Getenv("CARACAL_AGENT_NAME")
	if name == "" {
		name = agentSettingName(lines)
	}
	var entry *lockfile.Entry
	if cwd != "" || name != "" {
		entry, _ = lockfile.AgentForSession(cwd, name)
	}
	if name != "" {
		// Only trust the lockfile version when the entry is this agent.
		if entry != nil && (entry.Name == name || entry.ID == name) {
			return entryIdentity(entry)
		}
		return name, nil
	}
	if entry != nil {
		return entryIdentity(entry)
	}
	return nil, nil
}

func entryIdentity(entry *lockfile.Entry) (any, any) {
	id := entry.ID
	if id == "" {
		id = entry.Name
	}
	if id == "" {
		return nil, nil
	}
	if entry.Version == nil {
		return id, nil
	}
	return id, *entry.Version
}

// agentSettingName extracts the active agent from an agent-setting record,
// e.g. {"type": "agent-setting", "agentSetting": "my-agent"}.
func agentSettingName(lines []string) string {
	for _, raw := range lines {
		if !strings.Contains(raw, "agent-setting") {
			continue
		}
		var record map[string]any
		if json.Unmarshal([]byte(raw), &record) != nil {
			continue
		}
		if kind, _ := record["type"].(string); kind != "agent-setting" {
			continue
		}
		for _, key := range []string{"agentSetting", "agentName", "name"} {
			if name, _ := record[key].(string); name != "" {
				return name
			}
		}
	}
	return ""
}

// kiroAgentName returns the active agent recorded in a Kiro companion
// session file: session_state.agent_name directly, else the most recent
// user turn's loop agent. Missing or malformed metadata stays unattributed.
func kiroAgentName(jsonlPath string) string {
	if jsonlPath == "" {
		return ""
	}
	companion := strings.TrimSuffix(jsonlPath, ".jsonl") + ".json"
	blob, err := os.ReadFile(companion)
	if err != nil {
		return ""
	}
	var session map[string]any
	if json.Unmarshal(blob, &session) != nil {
		return ""
	}
	state, _ := session["session_state"].(map[string]any)
	if state == nil {
		return ""
	}
	if name, _ := state["agent_name"].(string); strings.TrimSpace(name) != "" {
		return strings.TrimSpace(name)
	}
	conversation, _ := state["conversation_metadata"].(map[string]any)
	if conversation == nil {
		return ""
	}
	turns, _ := conversation["user_turn_metadatas"].([]any)
	for i := len(turns) - 1; i >= 0; i-- {
		turn, _ := turns[i].(map[string]any)
		if turn == nil {
			continue
		}
		loopID, _ := turn["loop_id"].(map[string]any)
		if loopID == nil {
			continue
		}
		agentID, _ := loopID["agent_id"].(map[string]any)
		if agentID == nil {
			continue
		}
		if name, _ := agentID["name"].(string); strings.TrimSpace(name) != "" {
			return strings.TrimSpace(name)
		}
	}
	return ""
}
