// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
	"unicode"

	"github.com/spf13/cobra"
	"golang.org/x/term"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
	"github.com/garudex-labs/caracal/internal/cli/config"
	"github.com/garudex-labs/caracal/internal/cli/ui"
)

// loginUser is the user block of the login result contract.
type loginUser struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Email    string `json:"email"`
	Role     string `json:"role"`
	Username string `json:"username"`
}

// loginResult mirrors the login JSON contract field order.
type loginResult struct {
	Authenticated bool      `json:"authenticated"`
	ServerURL     string    `json:"server_url"`
	Method        string    `json:"method"`
	Bootstrapped  bool      `json:"bootstrapped"`
	User          loginUser `json:"user"`
}

func loginCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "login",
		Short: "Connect to Caracal",
		Long: "The server URL resolves from --server, CARACAL_SERVER_URL, the saved\n" +
			"config from a previous login, then a running local stack; human mode\n" +
			"prompts only when none of those resolve.\n" +
			"On a fresh server, creates the first admin account. On an initialized\n" +
			"server, authenticates with credentials. Set CARACAL_PASSWORD or\n" +
			"CARACAL_PASSWORD_FILE to avoid exposing a password in shell history.\n" +
			"JSON credential login requires complete inputs and never prompts.",
	}
	server := cmd.Flags().StringP("server", "s", "", "Server URL")
	email := cmd.Flags().StringP("email", "e", "", "Email or username")
	password := cmd.Flags().StringP("password", "p", "", "Password")
	name := cmd.Flags().StringP("name", "n", "", "Your name (used for admin setup)")
	sso := cmd.Flags().Bool("sso", false, "Authenticate via browser SSO")
	saml := cmd.Flags().Bool("saml", false, "Authenticate via browser SAML SSO")
	noSetup := cmd.Flags().Bool("no-setup", false, "Skip post-login skill installation and doctor")
	mode := outputFlag(cmd)
	_ = noSetup
	cmd.RunE = func(_ *cobra.Command, _ []string) error {
		return runLogin(*server, *email, *password, *name, *mode, *sso, *saml)
	}
	return cmd
}

func runLogin(server, email, password, name, mode string, sso, saml bool) error {
	jsonMode := mode == "json"
	stored, cerr := config.Load()
	if cerr != nil {
		return cerr
	}

	var serverURL string
	switch {
	case server != "":
		serverURL = strings.TrimRight(server, "/")
	case jsonMode:
		serverURL = strings.TrimRight(config.Str(stored, "server_url"), "/")
		if serverURL == "" {
			serverURL = "http://localhost:80"
		}
	default:
		// Reuse the configured server (CARACAL_SERVER_URL or a previous
		// login); on a fresh machine detect a running local stack. Only
		// prompt when neither resolves.
		serverURL = strings.TrimRight(config.Str(stored, "server_url"), "/")
		if serverURL == "" && localServerAlive() {
			serverURL = "http://localhost"
		}
		if serverURL == "" {
			answer := textInput("Server URL (leave blank for http://localhost)", "")
			if answer == "" {
				answer = "http://localhost"
			}
			serverURL = strings.TrimRight(answer, "/")
		}
	}

	// A localhost URL with a nonstandard port falls back to the bare host,
	// which reaches the load balancer of a local stack.
	candidates := []string{serverURL}
	if parsed, err := url.Parse(serverURL); err == nil && server == "" {
		host := parsed.Hostname()
		port := parsed.Port()
		if (host == "localhost" || host == "127.0.0.1" || host == "::1") && port != "" && port != "80" && port != "443" {
			scheme := parsed.Scheme
			if scheme == "" {
				scheme = "http"
			}
			if strings.Contains(host, ":") {
				host = "[" + host + "]"
			}
			candidates = append(candidates, scheme+"://"+host)
		}
	}

	client := &http.Client{Timeout: 10 * time.Second}
	var health map[string]any
	var lastErr error
	var failure *clierr.Error
	connected := false
	for _, candidate := range candidates {
		resp, err := client.Get(candidate + "/health")
		if err != nil {
			lastErr = err
			continue
		}
		blob, err := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if err != nil {
			lastErr = err
			continue
		}
		if resp.StatusCode >= 400 {
			if failure == nil {
				failure = &clierr.Error{
					Category: clierr.Unavailable, Message: fmt.Sprintf("The server returned HTTP %d.", resp.StatusCode),
					Operation: "Check server before login", Resource: "server " + candidate,
					Remediation: "Check server health and logs, then run caracal doctor.",
					HTTPStatus:  resp.StatusCode,
				}
			}
			continue
		}
		if json.Unmarshal(blob, &health) != nil || health == nil {
			if failure == nil {
				failure = &clierr.Error{
					Category: clierr.Unexpected, Message: "The server returned an invalid health response.",
					Operation: "Check server before login", Resource: "server " + candidate,
					Remediation: "Check server health and version compatibility, then retry.",
				}
			}
			continue
		}
		serverURL = candidate
		connected = true
		break
	}
	if !connected {
		if failure != nil {
			return failure
		}
		detail := ""
		if lastErr != nil {
			detail = lastErr.Error()
		}
		return &clierr.Error{
			Category: clierr.Unavailable, Message: "Cannot reach the Caracal server.",
			Operation: "Check server before login", Resource: "server " + candidates[len(candidates)-1],
			Remediation: "Check the server URL and service health, then run caracal doctor.",
			Detail:      detail,
		}
	}

	if cerr := ensureVersionMatch(serverURL); cerr != nil {
		return cerr
	}

	if !jsonMode {
		ui.Stdout().Successf("Connected to %s", serverURL)
	}

	initialized := true
	if v, ok := health["initialized"].(bool); ok {
		initialized = v
	}
	suppliedPassword := password
	if suppliedPassword == "" {
		secret, err := secretFromEnv("CARACAL_PASSWORD")
		if err != nil {
			return err
		}
		suppliedPassword = secret
	}

	if !initialized {
		return bootstrapAdmin(serverURL, email, name, suppliedPassword, jsonMode, mode)
	}

	ssoMode := sso || saml
	directSSO := ssoMode
	provider := ""
	if saml {
		provider = "saml"
	}
	if ssoOnlyServer(serverURL) {
		ssoMode = true
		directSSO = true
	}

	if jsonMode && !sso && !saml && (email == "" || suppliedPassword == "") {
		return &clierr.Error{
			Category: clierr.Validation, Message: "JSON login requires complete credentials or an explicit SSO option.",
			Operation: "Authenticate with Caracal", Resource: "server " + serverURL,
			Remediation: "Provide email and CARACAL_PASSWORD, or select SSO or SAML, then retry.",
		}
	}
	if !jsonMode && !ssoMode && email == "" && suppliedPassword == "" {
		out := ui.Stdout()
		fmt.Printf("  %s Email + password\n", out.Info("[1]"))
		fmt.Printf("  %s Web sign-in %s\n", out.Info("[2]"), out.Dim("(browser; includes Google, GitHub, and enterprise SSO)"))
		if quickChoice("Login method", []string{"1", "2"}) == "2" {
			ssoMode = true
		}
	}
	if ssoMode {
		return deviceFlowLogin(serverURL, directSSO, provider, mode)
	}

	loginEmail := email
	if loginEmail == "" {
		loginEmail = textInput("Email", "")
	}
	loginPassword := suppliedPassword
	if loginPassword == "" {
		loginPassword = passwordInput("Password")
	}
	return passwordLogin(serverURL, loginEmail, loginPassword, mode)
}

// localServerAlive reports whether a local stack answers on http://localhost.
func localServerAlive() bool {
	resp, err := (&http.Client{Timeout: 2 * time.Second}).Get("http://localhost/health")
	if err != nil {
		return false
	}
	_ = resp.Body.Close()
	return resp.StatusCode < 400
}

// ssoOnlyServer reports whether the deployment forbids password login.
func ssoOnlyServer(serverURL string) bool {
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Get(serverURL + "/api/v1/config/public")
	if err != nil {
		return false
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	var public struct {
		SSOOnly bool `json:"sso_only"`
	}
	if json.NewDecoder(resp.Body).Decode(&public) != nil {
		return false
	}
	return public.SSOOnly
}

// quickChoice prompts until one of the allowed answers is entered.
func quickChoice(prompt string, allowed []string) string {
	for {
		answer := textInput(prompt, "")
		for _, value := range allowed {
			if answer == value {
				return value
			}
		}
	}
}

// ensureVersionMatch blocks login on an exact-version mismatch.
func ensureVersionMatch(serverURL string) *clierr.Error {
	if cliVersion == "" || cliVersion == "0.0.0" {
		return nil
	}
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Get(serverURL + "/api/v1/config/version")
	if err != nil {
		return nil
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	var data struct {
		ServerVersion string `json:"server_version"`
	}
	if json.NewDecoder(resp.Body).Decode(&data) != nil || data.ServerVersion == "" || data.ServerVersion == "dev" {
		return nil
	}
	if data.ServerVersion == cliVersion {
		return nil
	}
	command := "caracal self upgrade --version " + data.ServerVersion
	if cliVersion > data.ServerVersion {
		command = "caracal self downgrade --version " + data.ServerVersion
	}
	return &clierr.Error{
		Category:  clierr.Version,
		Message:   fmt.Sprintf("CLI version %s does not match server version %s.", cliVersion, data.ServerVersion),
		Operation: "Authenticate with Caracal", Resource: "server " + serverURL,
		Remediation: "Run " + command + " and retry login.",
	}
}

func secretFromEnv(prefix string) (string, *clierr.Error) {
	direct := os.Getenv(prefix)
	filePath := os.Getenv(prefix + "_FILE")
	if direct != "" && filePath != "" {
		return "", &clierr.Error{
			Category: clierr.Validation, Message: prefix + " is configured incorrectly.",
			Operation: "Authenticate with Caracal", Resource: prefix,
			Remediation: fmt.Sprintf("Set only %s or %s_FILE, then retry.", prefix, prefix),
		}
	}
	if direct != "" {
		return direct, nil
	}
	if filePath != "" {
		blob, err := os.ReadFile(filePath)
		if err != nil {
			return "", &clierr.Error{
				Category: clierr.Validation, Message: prefix + " is configured incorrectly.",
				Operation: "Authenticate with Caracal", Resource: prefix,
				Remediation: fmt.Sprintf("Set only %s or %s_FILE, then retry.", prefix, prefix),
				Detail:      err.Error(),
			}
		}
		return strings.TrimSpace(string(blob)), nil
	}
	return "", nil
}

// validatePassword reports unmet strength requirements.
func validatePassword(password string) []string {
	failed := []string{}
	if len(password) < 12 {
		failed = append(failed, "At least 12 characters")
	}
	hasUpper, hasDigit, hasSpecial := false, false, false
	for _, r := range password {
		switch {
		case unicode.IsUpper(r):
			hasUpper = true
		case r >= '0' && r <= '9':
			hasDigit = true
		}
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) {
			hasSpecial = true
		}
	}
	if !hasUpper {
		failed = append(failed, "One uppercase letter")
	}
	if !hasDigit {
		failed = append(failed, "One number")
	}
	if !hasSpecial {
		failed = append(failed, "One special character")
	}
	return failed
}

func bootstrapAdmin(serverURL, email, name, suppliedPassword string, jsonMode bool, mode string) error {
	resource := "server " + serverURL
	adminEmail, adminName, adminPassword := email, name, suppliedPassword
	if jsonMode {
		if adminEmail == "" || adminName == "" || adminPassword == "" {
			return &clierr.Error{
				Category: clierr.Validation, Message: "Fresh-server JSON login requires email, name, and a password.",
				Operation: "Initialize Caracal administrator", Resource: resource,
				Remediation: "Provide email and name, and set CARACAL_PASSWORD or CARACAL_PASSWORD_FILE, then retry.",
			}
		}
	} else {
		ui.Stdout().Notef("No users yet; setting up the administrator account.")
		if adminEmail == "" {
			adminEmail = textInput("Admin email", "")
		}
		if adminName == "" {
			adminName = textInput("Admin name", "admin")
		}
		if adminPassword == "" {
			adminPassword = passwordInput("Admin password")
			confirm := passwordInput("Confirm password")
			if adminPassword != confirm {
				return &clierr.Error{
					Category: clierr.Validation, Message: "Passwords do not match.",
					Operation: "Initialize Caracal administrator", Resource: "administrator password",
					Remediation: "Enter matching passwords and retry.",
				}
			}
		}
	}
	if len(validatePassword(adminPassword)) > 0 {
		return &clierr.Error{
			Category: clierr.Validation, Message: "The administrator password does not meet security requirements.",
			Operation: "Initialize Caracal administrator", Resource: "administrator password",
			Remediation: "Use at least 12 characters with uppercase, number, and special characters.",
		}
	}
	status, blob, cerr := postJSON(serverURL+"/api/auth/sign-up/email",
		map[string]string{"email": adminEmail, "name": adminName, "password": adminPassword},
		"Initialize Caracal administrator", resource)
	if cerr != nil {
		return cerr
	}
	if status == 422 && strings.Contains(strings.ToLower(string(blob)), "exist") {
		return &clierr.Error{
			Category: clierr.Conflict, Message: "The server was initialized by another user before this request completed.",
			Operation: "Initialize Caracal administrator", Resource: resource,
			Remediation: "Retry login with an existing account.", HTTPStatus: 422,
		}
	}
	if status >= 400 {
		return authHTTPError(status, blob, "Initialize Caracal administrator", resource)
	}
	sessionToken := tokenFrom(blob)
	if sessionToken == "" {
		// Sign-up succeeded but withheld the session (email-verification
		// policy); the bootstrap account is born verified, so a direct
		// sign-in completes the flow.
		status, blob, cerr = postJSON(serverURL+"/api/auth/sign-in/email",
			map[string]string{"email": adminEmail, "password": adminPassword},
			"Initialize Caracal administrator", resource)
		if cerr != nil {
			return cerr
		}
		if status < 400 {
			sessionToken = tokenFrom(blob)
		}
	}
	if sessionToken == "" {
		return &clierr.Error{
			Category: clierr.Unexpected, Message: "The server returned an invalid initialization response.",
			Operation: "Initialize Caracal administrator", Resource: resource,
			Remediation: "Check server health and version compatibility, then retry.",
		}
	}
	data, cerr := establishSession(serverURL, sessionToken, "Initialize Caracal administrator")
	if cerr != nil {
		return cerr
	}
	return finishLogin(serverURL, data, mode, "bootstrap", true, false)
}

func passwordLogin(serverURL, email, password, mode string) error {
	resource := "server " + serverURL
	status, blob, cerr := postJSON(serverURL+"/api/auth/sign-in/email",
		map[string]string{"email": email, "password": password},
		"Authenticate with password", resource)
	if cerr != nil {
		return cerr
	}
	if status >= 400 {
		return authHTTPError(status, blob, "Authenticate with password", resource)
	}
	sessionToken := tokenFrom(blob)
	if sessionToken == "" {
		return &clierr.Error{
			Category: clierr.Unexpected, Message: "The server returned an invalid login response.",
			Operation: "Authenticate with password", Resource: resource,
			Remediation: "Check server health and version compatibility, then retry.",
		}
	}
	data, cerr := establishSession(serverURL, sessionToken, "Authenticate with password")
	if cerr != nil {
		return cerr
	}
	return finishLogin(serverURL, data, mode, "password", false, false)
}

// sessionData carries the established credentials and profile.
type sessionData struct {
	SessionToken string
	AccessToken  string
	User         map[string]any
}

// establishSession turns an identity session token into saved credentials.
func establishSession(serverURL, sessionToken, operation string) (*sessionData, *clierr.Error) {
	resource := "server " + serverURL
	client := &http.Client{Timeout: 30 * time.Second}

	req, _ := http.NewRequest(http.MethodGet, serverURL+"/api/auth/tenant-token", nil)
	req.Header.Set("Authorization", "Bearer "+sessionToken)
	resp, err := client.Do(req)
	if err != nil {
		return nil, transportFailure(err, operation, resource)
	}
	blob, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, authHTTPError(resp.StatusCode, blob, operation, resource)
	}
	jwt := tokenFrom(blob)
	if jwt == "" {
		return nil, invalidAuthResponse(operation, resource, "identity service returned no token")
	}

	req, _ = http.NewRequest(http.MethodGet, serverURL+"/api/v1/auth/whoami", nil)
	req.Header.Set("Authorization", "Bearer "+jwt)
	resp, err = client.Do(req)
	if err != nil {
		return nil, transportFailure(err, operation, resource)
	}
	blob, _ = io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, authHTTPError(resp.StatusCode, blob, operation, resource)
	}
	var user map[string]any
	if json.Unmarshal(blob, &user) != nil || user == nil {
		return nil, invalidAuthResponse(operation, resource, "whoami returned no user document")
	}
	return &sessionData{SessionToken: sessionToken, AccessToken: jwt, User: user}, nil
}

// finishLogin persists credentials, discovery endpoints, and reports the result.
func finishLogin(serverURL string, data *sessionData, mode, method string, bootstrapped, stream bool) error {
	userStr := func(key string) string {
		s, _ := data.User[key].(string)
		return s
	}
	values := map[string]any{
		"server_url":    serverURL,
		"access_token":  data.AccessToken,
		"session_token": data.SessionToken,
		"user_id":       userStr("id"),
		"user_name":     userStr("name"),
		"username":      userStr("username"),
	}
	if endpoints := fetchEndpoints(serverURL); endpoints != nil {
		web, _ := endpoints["web"].(string)
		values["web_url"] = web
	}
	if cerr := config.Save(values); cerr != nil {
		return cerr
	}
	result := loginResult{
		Authenticated: true,
		ServerURL:     serverURL,
		Method:        method,
		Bootstrapped:  bootstrapped,
		User: loginUser{
			ID: userStr("id"), Name: userStr("name"), Email: userStr("email"),
			Role: userStr("role"), Username: userStr("username"),
		},
	}
	if mode == "json" {
		if stream {
			jsonLine(struct {
				Event string `json:"event"`
				loginResult
			}{Event: "authenticated", loginResult: result})
			return nil
		}
		outputJSON(result)
		return nil
	}
	ui.Stdout().Successf("Logged in as %s (%s)", result.User.Name, result.User.Email)
	ui.Stdout().Notef("Config saved to %s", config.File())
	if home, err := os.UserHomeDir(); err == nil {
		_ = syncBundledSkills(home, true)
	}
	return nil
}

// fetchEndpoints reads service URLs from discovery, tolerating absence.
func fetchEndpoints(serverURL string) map[string]any {
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Get(serverURL + "/api/v1/config/endpoints")
	if err != nil {
		return nil
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	var endpoints map[string]any
	if json.NewDecoder(resp.Body).Decode(&endpoints) != nil {
		return nil
	}
	return endpoints
}

func postJSON(target string, body map[string]string, operation, resource string) (int, []byte, *clierr.Error) {
	payload, _ := json.Marshal(body)
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Post(target, "application/json", strings.NewReader(string(payload)))
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

func tokenFrom(blob []byte) string {
	var data map[string]any
	if json.Unmarshal(blob, &data) != nil {
		return ""
	}
	token, _ := data["token"].(string)
	return token
}

func transportFailure(err error, operation, resource string) *clierr.Error {
	return &clierr.Error{
		Category: clierr.Unavailable, Message: "Cannot reach the Caracal server.",
		Operation: operation, Resource: resource,
		Remediation: "Check the server URL and service health, then run caracal doctor.",
		Detail:      err.Error(),
	}
}

func invalidAuthResponse(operation, resource, detail string) *clierr.Error {
	return &clierr.Error{
		Category: clierr.Unexpected, Message: "The server returned an invalid authentication response.",
		Operation: operation, Resource: resource,
		Remediation: "Check server health and version compatibility, then retry.",
		Detail:      detail,
	}
}

// authHTTPError maps an identity-path HTTP failure onto the error contract.
func authHTTPError(status int, blob []byte, operation, resource string) *clierr.Error {
	detail := ""
	var data map[string]any
	if json.Unmarshal(blob, &data) == nil {
		if s, ok := data["detail"].(string); ok {
			detail = strings.TrimSpace(s)
		} else if s, ok := data["message"].(string); ok {
			detail = strings.TrimSpace(s)
		}
	}
	base := &clierr.Error{Operation: operation, Resource: resource, HTTPStatus: status}
	orDefault := func(fallback string) string {
		if detail != "" {
			return detail
		}
		return fallback
	}
	switch {
	case status == 401:
		base.Category = clierr.Auth
		// The identity service deliberately answers wrong-password and
		// unknown-account identically, so account existence never leaks.
		base.Message = orDefault("The email or password is incorrect.")
		base.Remediation = "Check the credentials and retry. Accounts created with Google, GitHub, or enterprise SSO " +
			"have no password: use caracal auth login --sso. Forgotten passwords are reset from the web sign-in page."
	case status == 403:
		base.Category = clierr.Permission
		base.Message = orDefault("You do not have permission to perform this operation.")
		if strings.Contains(strings.ToLower(detail), "verif") {
			base.Category = clierr.Auth
			base.Remediation = "Verify the email address using the link sent at sign-up, or resend it from the web sign-in page, then retry."
		} else {
			base.Remediation = "Ask an administrator or resource owner for the required access."
		}
	case status == 429:
		base.Category, base.Message = clierr.RateLimit, "The server rate limit was reached."
		base.Remediation = "Retry in a few seconds."
	case status >= 500:
		base.Category = clierr.Unavailable
		base.Message = fmt.Sprintf("The server returned HTTP %d.", status)
		base.Remediation = "Check server health and logs, then run caracal doctor."
	default:
		base.Category = clierr.Validation
		base.Message = orDefault(fmt.Sprintf("The server rejected the request with HTTP %d.", status))
		base.Remediation = "Correct the request input and retry."
	}
	return base
}

// promptAbort exits when the interactive input stream closes mid-prompt;
// retrying would spin forever and submitting half-empty answers is worse.
func promptAbort() {
	fmt.Fprintln(os.Stderr, "\nAborted: input closed before the prompt was answered. Pass flags for non-interactive use.")
	os.Exit(1)
}

func textInput(prompt, defaultValue string) string {
	out := ui.Stdout()
	if defaultValue != "" {
		fmt.Printf("%s %s: ", out.Bold(prompt), out.Dim("["+defaultValue+"]"))
	} else {
		fmt.Printf("%s: ", out.Bold(prompt))
	}
	reader := bufio.NewReader(os.Stdin)
	line, err := reader.ReadString('\n')
	if err != nil && line == "" {
		promptAbort()
	}
	line = strings.TrimSpace(line)
	if line == "" {
		return defaultValue
	}
	return line
}

func passwordInput(prompt string) string {
	fmt.Printf("%s: ", prompt)
	blob, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Println()
	if err != nil {
		reader := bufio.NewReader(os.Stdin)
		line, readErr := reader.ReadString('\n')
		if readErr != nil && line == "" {
			promptAbort()
		}
		return strings.TrimSpace(line)
	}
	return string(blob)
}
