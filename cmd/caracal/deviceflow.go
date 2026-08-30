// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
	"github.com/garudex-labs/caracal/internal/cli/ui"
)

const deviceClientID = "caracal-cli"

// jsonLine writes one compact JSON Lines record for a streaming command.
func jsonLine(data any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(data)
	fmt.Print(buf.String())
}

// authorizationEvent is the streamed device authorization prompt.
type authorizationEvent struct {
	Event                   string `json:"event"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	UserCode                string `json:"user_code"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
}

// deviceFlowLogin authenticates through the identity device authorization flow.
func deviceFlowLogin(serverURL string, directSSO bool, provider, mode string) error {
	jsonMode := mode == "json"
	resource := "server " + serverURL

	status, blob, cerr := postJSON(serverURL+"/api/auth/device/code",
		map[string]string{"client_id": deviceClientID},
		"Request device authorization", resource)
	if cerr != nil {
		return cerr
	}
	if status >= 400 {
		return authHTTPError(status, blob, "Request device authorization", resource)
	}
	var grant struct {
		DeviceCode              string `json:"device_code"`
		UserCode                string `json:"user_code"`
		VerificationURI         string `json:"verification_uri"`
		VerificationURIComplete string `json:"verification_uri_complete"`
		ExpiresIn               int    `json:"expires_in"`
		Interval                int    `json:"interval"`
	}
	if json.Unmarshal(blob, &grant) != nil || grant.DeviceCode == "" || grant.UserCode == "" || grant.VerificationURI == "" {
		return &clierr.Error{
			Category: clierr.Unexpected, Message: "The server returned an invalid device authorization response.",
			Operation: "Request device authorization", Resource: resource,
			Remediation: "Check server health and version compatibility, then retry.",
		}
	}
	if grant.VerificationURIComplete == "" {
		grant.VerificationURIComplete = grant.VerificationURI
	}
	if grant.ExpiresIn == 0 {
		grant.ExpiresIn = 600
	}
	if grant.Interval == 0 {
		grant.Interval = 5
	}

	// Direct SSO lands the browser on the SSO entry with the device page as
	// the post-login destination, instead of the generic login form.
	if directSSO {
		webBase := serverURL
		if endpoints := fetchEndpoints(serverURL); endpoints != nil {
			if web, _ := endpoints["web"].(string); web != "" {
				webBase = web
			}
		}
		nextPath := "/device?code=" + grant.UserCode + "&sso=1"
		grant.VerificationURI = strings.TrimRight(webBase, "/") + "/login?sso=1&next=" + nextPath
		grant.VerificationURIComplete = grant.VerificationURI
	}

	// A localhost verification page from a remote server is unreachable;
	// rebase it onto the server host.
	if verification, err := url.Parse(grant.VerificationURI); err == nil {
		server, serr := url.Parse(serverURL)
		vh := verification.Hostname()
		if serr == nil && (vh == "localhost" || vh == "127.0.0.1" || vh == "::1") &&
			server.Hostname() != "" && server.Hostname() != "localhost" &&
			server.Hostname() != "127.0.0.1" && server.Hostname() != "::1" {
			base := server.Scheme + "://" + server.Host
			path := verification.Path
			if path == "" {
				path = "/device"
			}
			originalQuery := ""
			if complete, cerr2 := url.Parse(grant.VerificationURIComplete); cerr2 == nil {
				originalQuery = complete.RawQuery
			}
			grant.VerificationURI = base + path
			if originalQuery != "" {
				grant.VerificationURIComplete = base + path + "?" + originalQuery
			} else {
				grant.VerificationURIComplete = base + path
			}
		}
	}

	var wait *ui.Spinner
	if jsonMode {
		jsonLine(authorizationEvent{
			Event:                   "authorization_required",
			VerificationURI:         grant.VerificationURI,
			VerificationURIComplete: grant.VerificationURIComplete,
			UserCode:                grant.UserCode,
			ExpiresIn:               grant.ExpiresIn,
			Interval:                grant.Interval,
		})
	} else {
		out := ui.Stdout()
		fmt.Println()
		fmt.Println("To sign in, open this URL in your browser:")
		fmt.Println()
		fmt.Printf("  %s\n", out.Info(grant.VerificationURI))
		fmt.Println()
		fmt.Printf("  Then enter code: %s\n", out.Bold(grant.UserCode))
		fmt.Println()
		if openBrowser(grant.VerificationURIComplete) {
			fmt.Println("Browser opened automatically.")
		} else {
			fmt.Println("Could not open browser automatically. Please open the URL manually.")
		}
		fmt.Println()
		wait = ui.Stderr().Spin("Waiting for browser authorization")
		defer wait.Stop()
	}

	client := &http.Client{Timeout: 10 * time.Second}
	interval := grant.Interval
	deadline := time.Now().Add(time.Duration(grant.ExpiresIn) * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(time.Duration(interval) * time.Second)
		payload, _ := json.Marshal(map[string]string{
			"device_code": grant.DeviceCode,
			"client_id":   deviceClientID,
			"grant_type":  "urn:ietf:params:oauth:grant-type:device_code",
		})
		resp, err := client.Post(serverURL+"/api/auth/device/token", "application/json", strings.NewReader(string(payload)))
		if err != nil {
			continue
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()

		if resp.StatusCode == http.StatusOK {
			var token struct {
				AccessToken string `json:"access_token"`
			}
			if json.Unmarshal(body, &token) != nil || token.AccessToken == "" {
				return &clierr.Error{
					Category: clierr.Unexpected, Message: "The server returned an invalid device token response.",
					Operation: "Complete device authorization", Resource: resource,
					Remediation: "Check server health and version compatibility, then retry.",
				}
			}
			if wait != nil {
				wait.Done("Authorized.")
			}
			data, cerr := establishSession(serverURL, token.AccessToken, "Complete device authorization")
			if cerr != nil {
				return cerr
			}
			method := provider
			if method == "" {
				method = "sso"
			}
			return finishLogin(serverURL, data, mode, method, false, jsonMode)
		}

		var failure struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(body, &failure) != nil || failure.Error == "" {
			failure.Error = "unknown_error"
		}
		switch failure.Error {
		case "authorization_pending", "slow_down":
			if failure.Error == "slow_down" {
				interval += 5
			}
			continue
		case "expired_token":
			return &clierr.Error{
				Category: clierr.Auth, Message: "The device authorization code expired.",
				Operation: "Complete device authorization", Resource: "device authorization",
				Remediation: "Start login again to request a new code.", HTTPStatus: resp.StatusCode,
			}
		case "access_denied":
			return &clierr.Error{
				Category: clierr.Permission, Message: "Device authorization was denied.",
				Operation: "Complete device authorization", Resource: "device authorization",
				Remediation: "Approve the browser authorization request and retry.", HTTPStatus: resp.StatusCode,
			}
		}
		return authHTTPError(resp.StatusCode, body, "Complete device authorization", resource)
	}

	return &clierr.Error{
		Category: clierr.Unavailable, Message: "Device authorization timed out.",
		Operation: "Complete device authorization", Resource: "device authorization",
		Remediation: "Start login again and complete browser authorization before the code expires.",
	}
}

// openBrowser launches the platform browser, tolerating headless hosts.
func openBrowser(target string) bool {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", target).Start() == nil
	case "linux":
		if exec.Command("wslpath", "-w", "/").Run() == nil {
			return exec.Command("powershell.exe", "-NoProfile", "-c", "Start-Process '"+target+"'").Start() == nil
		}
		return exec.Command("xdg-open", target).Start() == nil
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", target).Start() == nil
	}
	return false
}
