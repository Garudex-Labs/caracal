// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/garudex-labs/caracal/internal/cli/api"
	"github.com/garudex-labs/caracal/internal/cli/clierr"
	"github.com/garudex-labs/caracal/internal/cli/config"
)

// namespaceRule mirrors the registry namespace charset shared with usernames.
var namespaceRule = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,30}[a-z0-9]$`)

const namespaceRuleText = "Namespaces must be 3-32 characters using lowercase letters, numbers, " +
	"hyphens, and dots, and must start and end with a letter or number"

func validNamespace(handle string) bool {
	value := strings.ToLower(strings.TrimSpace(handle))
	if value == "" || strings.Contains(value, "..") {
		return false
	}
	return namespaceRule.MatchString(value)
}

func changePasswordCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "change-password",
		Short: "Change your password",
		Long: "Both modes read CARACAL_CURRENT_PASSWORD and CARACAL_NEW_PASSWORD,\n" +
			"including their FILE forms. Human mode prompts for missing values; JSON\n" +
			"mode requires both values and never prompts.",
	}
	mode := outputFlag(cmd)
	cmd.RunE = func(_ *cobra.Command, _ []string) error {
		cfg, cerr := config.Load()
		if cerr != nil {
			return cerr
		}
		if config.Str(cfg, "server_url") == "" || config.Str(cfg, "access_token") == "" {
			return &clierr.Error{
				Category: clierr.Auth, Message: "An authenticated session is required to change the password.",
				Operation: "Change password", Resource: config.File(),
				Remediation: "Run caracal auth login and retry.",
			}
		}
		jsonMode := *mode == "json"
		current, cerr2 := secretFromEnvOp("CARACAL_CURRENT_PASSWORD", "Change password")
		if cerr2 != nil {
			return cerr2
		}
		newPassword, cerr2 := secretFromEnvOp("CARACAL_NEW_PASSWORD", "Change password")
		if cerr2 != nil {
			return cerr2
		}
		if jsonMode && (current == "" || newPassword == "") {
			return &clierr.Error{
				Category: clierr.Validation, Message: "JSON password change requires current and new password secrets.",
				Operation: "Change password", Resource: "password input",
				Remediation: "Set CARACAL_CURRENT_PASSWORD and CARACAL_NEW_PASSWORD, or their FILE forms, then retry.",
			}
		}
		if current == "" {
			current = passwordInput("Current password")
		}
		if newPassword == "" {
			newPassword = passwordInput("New password")
			confirmation := passwordInput("Confirm password")
			if newPassword != confirmation {
				return &clierr.Error{
					Category: clierr.Validation, Message: "Passwords do not match.",
					Operation: "Change password", Resource: "new password",
					Remediation: "Enter matching passwords and retry.",
				}
			}
		}
		if len(validatePassword(newPassword)) > 0 {
			return &clierr.Error{
				Category: clierr.Validation, Message: "The new password does not meet security requirements.",
				Operation: "Change password", Resource: "new password",
				Remediation: "Use at least 12 characters with uppercase, number, and special characters.",
			}
		}
		serverURL := strings.TrimRight(config.Str(cfg, "server_url"), "/")
		sessionToken := config.Str(cfg, "session_token")
		if sessionToken == "" {
			return &clierr.Error{
				Category: clierr.Auth, Message: "No identity-service session is stored for this login.",
				Operation: "Change password", Resource: config.File(),
				Remediation: "Run caracal auth login and retry.",
			}
		}
		status, blob, cerr2 := postJSONWithBearer(serverURL+"/api/auth/change-password",
			map[string]any{"currentPassword": current, "newPassword": newPassword, "revokeOtherSessions": true},
			sessionToken, "Change password", "server "+serverURL)
		if cerr2 != nil {
			return cerr2
		}
		if status >= 400 {
			return authHTTPError(status, blob, "Change password", "server "+serverURL)
		}
		if *mode == "json" {
			outputJSON(struct {
				Changed bool `json:"changed"`
			}{true})
			return nil
		}
		fmt.Println("Password changed successfully.")
		return nil
	}
	return cmd
}

// postJSONWithBearer posts an identity-service request with a session token.
func postJSONWithBearer(target string, body map[string]any, token, operation, resource string) (int, []byte, *clierr.Error) {
	payload, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodPost, target, strings.NewReader(string(payload)))
	if err != nil {
		return 0, nil, transportFailure(err, operation, resource)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return 0, nil, transportFailure(err, operation, resource)
	}
	defer func() { _ = resp.Body.Close() }()
	blob, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, nil, transportFailure(err, operation, resource)
	}
	return resp.StatusCode, blob, nil
}

// secretFromEnvOp resolves NAME or NAME_FILE under a specific operation label.
func secretFromEnvOp(prefix, operation string) (string, *clierr.Error) {
	value, cerr := secretFromEnv(prefix)
	if cerr != nil {
		cerr.Operation = operation
		return "", cerr
	}
	return value, nil
}

func setUsernameCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "set-username USERNAME",
		Short: "Set or update your username",
		Args:  cobra.ExactArgs(1),
	}
	mode := outputFlag(cmd)
	cmd.RunE = func(_ *cobra.Command, args []string) error {
		username := args[0]
		if username != strings.ToLower(strings.TrimSpace(username)) || !validNamespace(username) {
			return &clierr.Error{
				Category: clierr.Validation, Message: namespaceRuleText,
				Operation: "Update username", Resource: "username",
				Remediation: "Choose a valid registry namespace and retry.",
			}
		}
		client, cerr := api.New(cliVersion)
		if cerr != nil {
			return cerr
		}
		if cerr := client.EnforceVersion("auth"); cerr != nil {
			return cerr
		}
		raw, cerr := client.RequestRaw("PUT", "/api/v1/auth/profile/username", nil,
			map[string]string{"username": username})
		if cerr != nil {
			return cerr
		}
		effective := username
		var doc map[string]any
		if json.Unmarshal(raw, &doc) == nil {
			if s, ok := doc["username"].(string); ok && s != "" {
				effective = s
			}
		}
		if cerr := config.Save(map[string]any{"username": effective}); cerr != nil {
			return cerr
		}
		if *mode == "json" {
			outputJSONRaw(raw)
			return nil
		}
		fmt.Printf("Username set to @%s\n", effective)
		return nil
	}
	return cmd
}
