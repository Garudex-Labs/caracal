// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/garudex-labs/caracal/internal/cli/api"
	"github.com/garudex-labs/caracal/internal/cli/clierr"
	"github.com/garudex-labs/caracal/internal/cli/config"
	"github.com/garudex-labs/caracal/internal/cli/outbox"
	"github.com/garudex-labs/caracal/internal/cli/ui"
)

func authCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "auth", Short: "Authentication and session management"}
	cmd.AddCommand(loginCommand(), whoamiCommand(), statusCommand(), logoutCommand(), changePasswordCommand(), setUsernameCommand())
	return cmd
}

func whoamiCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "whoami",
		Short: "Show current authenticated user",
		Long:  "Queries the server for the user associated with the stored access token.",
	}
	mode := outputFlag(cmd)
	cmd.RunE = func(_ *cobra.Command, _ []string) error {
		client, cerr := api.New(cliVersion)
		if cerr != nil {
			return cerr
		}
		if cerr := client.EnforceVersion("auth"); cerr != nil {
			return cerr
		}
		raw, cerr := client.GetRaw("/api/v1/auth/whoami", nil)
		if cerr != nil {
			return cerr
		}
		if *mode == "json" {
			outputJSONRaw(raw)
			return nil
		}
		var doc map[string]any
		_ = json.Unmarshal(raw, &doc)
		name, _ := doc["name"].(string)
		username, _ := doc["username"].(string)
		if username == "" {
			username = "not set"
		} else {
			username = "@" + username
		}
		role, _ := doc["role"].(string)
		if role == "" {
			role = "user"
		}
		out := ui.Stdout()
		fmt.Println(out.Bold(name))
		fmt.Printf("  %s %s\n", out.Dim("Username:"), username)
		fmt.Printf("  %s %v\n", out.Dim("Email:   "), doc["email"])
		fmt.Printf("  %s %s\n", out.Dim("Role:    "), role)
		fmt.Printf("  %s %v\n", out.Dim("ID:      "), doc["id"])
		return nil
	}
	return cmd
}

func statusCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "status",
		Short: "Check authenticated server connectivity and local outbox health",
		Long: "Returns authentication code 3 when credentials are absent and unavailable\n" +
			"code 9 when the configured server cannot be reached.",
	}
	mode := outputFlag(cmd)
	cmd.RunE = func(_ *cobra.Command, _ []string) error {
		cfg, cerr := config.Load()
		if cerr != nil {
			return cerr
		}
		url := strings.TrimRight(config.Str(cfg, "server_url"), "/")
		if url == "" || (config.Str(cfg, "access_token") == "" && config.Str(cfg, "session_token") == "") {
			return &clierr.Error{
				Category: clierr.Auth, Message: "Caracal authentication is not configured.",
				Operation: "Check authentication status", Resource: config.File(),
				Remediation: "Run caracal auth login or configure an access token, then retry.",
			}
		}
		client, cerr := api.New(cliVersion)
		if cerr != nil {
			return cerr
		}
		ok, latency := client.Health()
		if !ok {
			return &clierr.Error{
				Category: clierr.Unavailable, Message: "The configured Caracal server is unreachable.",
				Operation: "Check authentication status", Resource: "server " + url,
				Remediation: "Check the server URL and service health, then retry.",
			}
		}
		result := statusDocument{
			ServerURL:     url,
			Authenticated: true,
			Health:        statusHealth{Reachable: true, LatencyMS: roundTo(latency, 3)},
			Outbox:        outboxStats(),
		}
		if *mode == "json" {
			outputJSON(result)
			return nil
		}
		out := ui.Stdout()
		fmt.Printf("  %s %s\n", out.Dim("Server:"), url)
		fmt.Printf("  %s %s\n", out.Dim("Health:"), out.Success(fmt.Sprintf("reachable (%.1f ms)", latency)))
		return nil
	}
	return cmd
}

// statusDocument mirrors the auth status JSON contract field order.
type statusDocument struct {
	ServerURL     string       `json:"server_url"`
	Authenticated bool         `json:"authenticated"`
	Health        statusHealth `json:"health"`
	Outbox        any          `json:"outbox"`
}

type statusHealth struct {
	Reachable bool    `json:"reachable"`
	LatencyMS float64 `json:"latency_ms"`
}

type outboxSummary struct {
	Available     bool    `json:"available"`
	Total         int64   `json:"total"`
	Pending       int64   `json:"pending"`
	Bytes         int64   `json:"bytes"`
	OldestPending *string `json:"oldest_pending"`
}

type outboxUnavailable struct {
	Available bool   `json:"available"`
	Error     string `json:"error"`
}

// outboxStats summarizes the durable session delivery buffer.
func outboxStats() any {
	store, err := outbox.Open("")
	if err != nil {
		return outboxUnavailable{Available: false, Error: "OutboxError"}
	}
	defer func() { _ = store.Close() }()
	stats, err := store.ReadStats()
	if err != nil {
		return outboxUnavailable{Available: false, Error: "OutboxError"}
	}
	return outboxSummary{
		Available:     true,
		Total:         stats.Total,
		Pending:       stats.Pending,
		Bytes:         stats.Bytes,
		OldestPending: stats.OldestPending,
	}
}

func roundTo(value float64, places int) float64 {
	shift := 1.0
	for range places {
		shift *= 10
	}
	return float64(int64(value*shift+0.5)) / shift
}

func logoutCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "logout",
		Short: "Clear saved credentials",
		Long: "Revokes the remote session when possible, then removes local access and\n" +
			"session tokens. Remote revocation failure never blocks local cleanup.",
	}
	mode := outputFlag(cmd)
	cmd.RunE = func(_ *cobra.Command, _ []string) error {
		_, statErr := os.Stat(config.File())
		existed := statErr == nil
		attempted := false
		var revoked any
		if existed {
			blob, err := os.ReadFile(config.File())
			var raw map[string]any
			if err != nil || json.Unmarshal(blob, &raw) != nil {
				return &clierr.Error{
					Category: clierr.Validation, Message: "The local authentication configuration cannot be read.",
					Operation: "Log out of Caracal", Resource: config.File(),
					Remediation: "Repair or remove the configuration file, then retry.",
				}
			}
			sessionToken, _ := raw["session_token"].(string)
			serverURL := strings.TrimRight(config.Str(raw, "server_url"), "/")
			if sessionToken != "" && serverURL != "" {
				attempted = true
				revoked = revokeSession(serverURL, sessionToken)
			}
			if cerr := config.Remove("access_token", "refresh_token", "session_token"); cerr != nil {
				return cerr
			}
		}
		result := logoutDocument{
			LoggedOut:           true,
			ConfigExisted:       existed,
			LocalTokensCleared:  true,
			RevocationAttempted: attempted,
			RemoteRevoked:       revoked,
		}
		if *mode == "json" {
			outputJSON(result)
			return nil
		}
		ui.Stdout().Successf("Logged out.")
		return nil
	}
	return cmd
}

// logoutDocument mirrors the logout JSON contract field order.
type logoutDocument struct {
	LoggedOut           bool `json:"logged_out"`
	ConfigExisted       bool `json:"config_existed"`
	LocalTokensCleared  bool `json:"local_tokens_cleared"`
	RevocationAttempted bool `json:"remote_revocation_attempted"`
	RemoteRevoked       any  `json:"remote_revoked"`
}

func revokeSession(serverURL, sessionToken string) bool {
	req, err := http.NewRequest(http.MethodPost, serverURL+"/api/auth/sign-out", strings.NewReader("{}"))
	if err != nil {
		return false
	}
	req.Header.Set("Authorization", "Bearer "+sessionToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return false
	}
	_ = resp.Body.Close()
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}
