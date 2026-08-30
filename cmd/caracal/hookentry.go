// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/spf13/cobra"

	"github.com/garudex-labs/caracal/internal/cli/sessions"
)

// hookCommand is the harness-invoked telemetry entrypoint. It must never
// fail: harnesses treat a non-zero hook exit as a session error.
func hookCommand() *cobra.Command {
	group := &cobra.Command{Use: "hook", Hidden: true, Short: "Harness hook entrypoints"}
	push := &cobra.Command{Use: "session-push", Short: "Deliver session telemetry for a harness", Args: cobra.NoArgs}
	harnessName := push.Flags().String("harness", "claude-code", "Source harness")
	jsonResponse := push.Flags().Bool("json-response", false, "Emit a JSON hook response")
	push.RunE = func(_ *cobra.Command, _ []string) error {
		raw, _ := io.ReadAll(os.Stdin)
		defer func() { _ = recover() }()
		if *jsonResponse {
			defer fmt.Println("{}")
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return nil
		}
		cfg := sessions.LoadConfig(home)
		if cfg == nil {
			return nil
		}
		var event map[string]any
		_ = json.Unmarshal(raw, &event)
		hookEvent := sessions.ResolveHookEvent(event)
		isStop := hookEvent == "Stop" || hookEvent == "SessionEnd"
		eventSession, _ := event["session_id"].(string)
		if eventSession == "" {
			eventSession, _ = event["sessionId"].(string)
		}
		// Final delivery applies only to the session the event names.
		optsFor := func(sessionID string) sessions.SourceOptions {
			final := isStop && eventSession != "" && sessionID == eventSession
			return sessions.SourceOptions{Home: home, HookEvent: hookEvent, Final: final}
		}
		// VS Code Copilot's hook payload is the only durable record; write it
		// to a local source before draining.
		if *harnessName == "copilot" {
			if source, ok := sessions.MaterializeCopilotHookEvent(home, event); ok {
				_, _ = sessions.DrainSessionSource(cfg, source, optsFor(source.SessionID))
			}
		}
		discoverer, ok := sessions.Discoverers[*harnessName]
		if !ok {
			return nil
		}
		sources, err := discoverer.Discover(home, 24)
		if err != nil {
			return nil
		}
		for _, source := range sources {
			_, _ = sessions.DrainSessionSource(cfg, source, optsFor(source.SessionID))
		}
		_, _ = sessions.DrainOutbox(cfg, sessions.DrainOptions{Home: home}, nil, nil)
		return nil
	}
	group.AddCommand(push)
	return group
}
