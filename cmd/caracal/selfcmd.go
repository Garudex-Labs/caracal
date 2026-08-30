// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
	"github.com/garudex-labs/caracal/internal/cli/config"
	"github.com/garudex-labs/caracal/internal/cli/ui"
)

const selfRepo = "Garudex-Labs/caracal"

var redirectAllowlist = map[string]bool{
	"github.com": true, "objects.githubusercontent.com": true, "github-releases.githubusercontent.com": true,
}

type installInfo struct {
	Method    string
	Path      string
	Writable  bool
	ManagedBy string
}

// detectInstall classifies how this binary is installed.
func detectInstall() installInfo {
	exe, err := os.Executable()
	if err != nil {
		exe = "caracal"
	}
	resolved, err := filepath.EvalSymlinks(exe)
	if err == nil {
		exe = resolved
	}
	lower := strings.ToLower(exe)
	writable := fileWritable
	switch {
	case strings.Contains(lower, "/homebrew/") || strings.Contains(lower, "linuxbrew"):
		return installInfo{Method: "homebrew", Path: exe, Writable: false, ManagedBy: "brew"}
	case strings.HasPrefix(lower, "/usr/bin/") || strings.HasPrefix(lower, "/usr/sbin/"):
		return installInfo{Method: "system", Path: exe, Writable: writable(exe), ManagedBy: "the system package manager"}
	default:
		return installInfo{Method: "binary", Path: exe, Writable: writable(exe)}
	}
}

func managedInstallGuard(install installInfo, operation string) *clierr.Error {
	if install.Method == "homebrew" || install.Method == "system" {
		manager := orDefault(install.ManagedBy, "the system package manager")
		return &clierr.Error{
			Category: clierr.Conflict, Message: fmt.Sprintf("Caracal is managed by %s.", manager),
			Operation: operation, Resource: "CLI installation",
			Remediation: fmt.Sprintf("Use `%s upgrade caracal` or the equivalent package-manager command.", manager),
		}
	}
	return nil
}

func selfArtifactName() (string, *clierr.Error) {
	arch := ""
	switch runtime.GOARCH {
	case "amd64":
		arch = "x64"
	case "arm64":
		arch = "arm64"
	default:
		return "", &clierr.Error{
			Category: clierr.Unavailable, Message: fmt.Sprintf("Unsupported architecture: %s", runtime.GOARCH),
			Operation: "Upgrade Caracal CLI", Resource: "CLI installation",
			Remediation: "Install a supported release manually.",
		}
	}
	osName := ""
	suffix := ""
	switch runtime.GOOS {
	case "linux":
		osName = "linux"
	case "darwin":
		osName = "macos"
	case "windows":
		osName = "windows"
		suffix = ".exe"
	default:
		return "", &clierr.Error{
			Category: clierr.Unavailable, Message: fmt.Sprintf("Unsupported OS: %s", runtime.GOOS),
			Operation: "Upgrade Caracal CLI", Resource: "CLI installation",
			Remediation: "Install a supported release manually.",
		}
	}
	return fmt.Sprintf("caracal-%s-%s%s", osName, arch, suffix), nil
}

func githubJSON(url string, timeout time.Duration, out any) bool {
	client := &http.Client{Timeout: timeout}
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return false
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "caracal-cli/"+cliVersion)
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != 200 {
		return false
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1_048_576+1))
	if err != nil || len(body) > 1_048_576 {
		return false
	}
	return json.Unmarshal(body, out) == nil
}

func selfGithubRepo() string {
	cfg, cerr := config.Load()
	if cerr == nil {
		if repo := config.Str(cfg, "update_check_repo"); repo != "" {
			return repo
		}
	}
	return selfRepo
}

func fetchLatestRelease(includePre bool) string {
	repo := selfGithubRepo()
	if includePre {
		var releases []struct {
			TagName string `json:"tag_name"`
		}
		if !githubJSON("https://api.github.com/repos/"+repo+"/releases?per_page=1", 3*time.Second, &releases) || len(releases) == 0 {
			return ""
		}
		return strings.TrimLeft(releases[0].TagName, "v")
	}
	var release struct {
		TagName string `json:"tag_name"`
	}
	if !githubJSON("https://api.github.com/repos/"+repo+"/releases/latest", 3*time.Second, &release) {
		return ""
	}
	return strings.TrimLeft(release.TagName, "v")
}

// acquireCLILock guards concurrent version changes.
func acquireCLILock(operation string) (string, *clierr.Error) {
	lockPath := filepath.Join(config.Dir(), ".cli-upgrade.lock")
	if blob, err := os.ReadFile(lockPath); err == nil {
		var state struct {
			PID       int     `json:"pid"`
			Timestamp float64 `json:"timestamp"`
		}
		stale := true
		if json.Unmarshal(blob, &state) == nil {
			age := time.Now().Unix() - int64(state.Timestamp)
			if age <= 1800 && state.PID > 0 && processAlive(state.PID) {
				stale = false
			}
		}
		if !stale {
			return "", &clierr.Error{
				Category: clierr.Conflict, Message: "Another CLI version change is already running.",
				Operation: operation, Resource: "CLI upgrade lock",
				Remediation: "Wait for it to finish, then retry.",
			}
		}
		_ = os.Remove(lockPath)
	}
	_ = os.MkdirAll(config.Dir(), 0o755)
	blob, _ := json.Marshal(map[string]any{"pid": os.Getpid(), "timestamp": float64(time.Now().Unix()), "scope": "cli"})
	if err := os.WriteFile(lockPath, blob, 0o644); err != nil {
		return "", &clierr.Error{
			Category: clierr.Unavailable, Message: "Another CLI version change is already running.",
			Operation: operation, Resource: "CLI upgrade lock",
			Remediation: "Wait for it to finish, then retry.", Detail: err.Error(),
		}
	}
	return lockPath, nil
}

// installBinaryRelease downloads, verifies, and swaps in a release binary.
func installBinaryRelease(install installInfo, targetVersion, direction, operation string, jsonMode bool) *clierr.Error {
	artifact, cerr := selfArtifactName()
	if cerr != nil {
		cerr.Operation = operation
		return cerr
	}
	installFail := func(detail string) *clierr.Error {
		return &clierr.Error{
			Category: clierr.Unavailable, Message: fmt.Sprintf("CLI %s failed.", direction),
			Operation: operation, Resource: "CLI installation",
			Remediation: "Check network access, the install method, and filesystem permissions, then retry.",
			Detail:      detail,
		}
	}
	var release struct {
		Assets []struct {
			Name               string `json:"name"`
			BrowserDownloadURL string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if !githubJSON("https://api.github.com/repos/"+selfRepo+"/releases/tags/v"+targetVersion, 15*time.Second, &release) {
		return installFail(fmt.Sprintf("Release v%s not found on GitHub.", targetVersion))
	}
	assets := map[string]string{}
	for _, asset := range release.Assets {
		assets[asset.Name] = asset.BrowserDownloadURL
	}
	assetURL, ok := assets[artifact]
	if !ok {
		return installFail(fmt.Sprintf("Binary '%s' not found in release assets.", artifact))
	}
	download := func(url string, timeout time.Duration) ([]byte, error) {
		client := &http.Client{Timeout: timeout}
		resp, err := client.Get(url)
		if err != nil {
			return nil, err
		}
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != 200 {
			return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
		}
		if !redirectAllowlist[resp.Request.URL.Hostname()] {
			return nil, fmt.Errorf("Download redirected to untrusted host: %s", resp.Request.URL.Hostname())
		}
		return io.ReadAll(resp.Body)
	}
	checksums := map[string]string{}
	if checksumURL, ok := assets["checksums.txt"]; ok {
		if blob, err := download(checksumURL, 15*time.Second); err == nil {
			for _, line := range strings.Split(string(blob), "\n") {
				parts := strings.Fields(strings.TrimSpace(line))
				if len(parts) == 2 {
					checksums[parts[1]] = parts[0]
				}
			}
		}
	}
	fetch := ui.Stderr().Spin("Downloading " + artifact)
	content, err := download(assetURL, 120*time.Second)
	fetch.Stop()
	if err != nil {
		return installFail("Download failed: " + err.Error())
	}
	actualHash := hex.EncodeToString(func() []byte { sum := sha256.Sum256(content); return sum[:] }())
	expected, hasExpected := checksums[artifact]
	if hasExpected && expected != actualHash {
		return installFail("CHECKSUM MISMATCH - download may be corrupted or tampered.")
	}
	if !hasExpected {
		if jsonMode {
			return installFail("Non-interactive installation requires a published checksum.")
		}
		ui.Stdout().Warnf("No checksum available for verification.")
		if !confirmDanger("Install without verification?") {
			return abortErr(operation)
		}
	} else if !jsonMode {
		ui.Stdout().Successf("SHA-256 verified: %s...", actualHash[:16])
	}
	if !install.Writable {
		return installFail(fmt.Sprintf("Cannot write to %s - permission denied.", install.Path))
	}
	backupDir := filepath.Join(config.Dir(), "bin")
	_ = os.MkdirAll(backupDir, 0o755)
	backup := filepath.Join(backupDir, "caracal.prev")
	if _, err := os.Stat(install.Path); err == nil {
		if blob, err := os.ReadFile(install.Path); err == nil {
			_ = os.WriteFile(backup, blob, 0o755)
		}
	}
	tmp, err := os.CreateTemp(filepath.Dir(install.Path), ".caracal-update-")
	if err != nil {
		return installFail(err.Error())
	}
	if _, err := tmp.Write(content); err != nil {
		_ = tmp.Close()
		os.Remove(tmp.Name())
		return installFail(err.Error())
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return installFail(err.Error())
	}
	_ = os.Chmod(tmp.Name(), 0o755)
	if err := os.Rename(tmp.Name(), install.Path); err != nil {
		os.Remove(tmp.Name())
		return installFail(fmt.Sprintf("Failed to replace binary: %v", err))
	}
	return verifyInstall(install, targetVersion, direction, operation, jsonMode)
}

var versionOutputRe = regexp.MustCompile(`(?:^|[^\w.])v?(\d+(?:\.\d+){2}(?:[-+][0-9A-Za-z.-]+)?)`)

func verifyInstall(install installInfo, expected, direction, operation string, jsonMode bool) *clierr.Error {
	command := exec.Command(install.Path, "--version")
	output, err := command.CombinedOutput()
	verifyFail := func(detail string) *clierr.Error {
		return &clierr.Error{
			Category: clierr.Unavailable, Message: fmt.Sprintf("CLI %s failed.", direction),
			Operation: operation, Resource: "CLI installation",
			Remediation: "Review the release, install method, and filesystem permissions, then retry.",
			Detail:      detail,
		}
	}
	if err != nil {
		return verifyFail(fmt.Sprintf("verification failed: %v", err))
	}
	match := versionOutputRe.FindStringSubmatch(strings.TrimSpace(string(output)))
	if match == nil {
		return verifyFail(fmt.Sprintf("could not parse version from %q", strings.TrimSpace(string(output))))
	}
	actual := match[1]
	if actual != expected {
		return verifyFail(fmt.Sprintf("expected v%s, but %s reports v%s.", expected, install.Path, actual))
	}
	if !jsonMode {
		ui.Stdout().Successf("%sd to v%s", strings.ToUpper(direction[:1])+direction[1:], actual)
	}
	return nil
}

func selfCommand() *cobra.Command {
	group := &cobra.Command{Use: "self", Short: "CLI self-management commands (upgrade, downgrade, rollback, status)"}

	status := &cobra.Command{Use: "status", Short: "Show installation and update status", Args: cobra.NoArgs}
	statusMode := outputFlag(status)
	status.RunE = func(_ *cobra.Command, _ []string) error {
		install := detectInstall()
		latest := fetchLatestRelease(false)
		githubAvailable := latest != ""
		latestValue, updateValue := "null", "null"
		if githubAvailable {
			latestValue = jsonString(latest)
			newer, err := versionNewer(latest, cliVersion)
			if err == nil {
				updateValue = fmt.Sprint(newer)
			} else {
				updateValue = "false"
			}
		}
		managedValue := "null"
		if install.ManagedBy != "" {
			managedValue = jsonString(install.ManagedBy)
		}
		doc := fmt.Sprintf(`{"current_version": %s, "install_method": %s, "path": %s, "writable": %t, "managed_by": %s, "github_available": %t, "latest_version": %s, "update_available": %s}`,
			jsonString(cliVersion), jsonString(install.Method), jsonString(install.Path), install.Writable,
			managedValue, githubAvailable, latestValue, updateValue)
		if *statusMode == "json" {
			outputJSONRaw([]byte(doc))
			return nil
		}
		fmt.Printf("  Version:  v%s\n  Install:  %s (%s)\n", cliVersion, install.Method, install.Path)
		if githubAvailable {
			suffix := "up to date"
			if updateValue == "true" {
				suffix = "update available"
			}
			fmt.Printf("  Latest:   v%s (%s)\n", latest, suffix)
			if updateValue == "true" {
				fmt.Println("\n  Run: caracal self upgrade")
			}
		} else {
			fmt.Println("  Latest:   could not reach GitHub")
		}
		return nil
	}

	upgrade := &cobra.Command{Use: "upgrade", Short: "Upgrade the CLI to a newer release", Args: cobra.NoArgs}
	upgradeVersion := upgrade.Flags().StringP("version", "v", "", "Target version to upgrade to. Defaults to the latest stable release.")
	upgradePre := upgrade.Flags().Bool("pre", false, "Include prerelease versions when resolving latest")
	upgradeForce := upgrade.Flags().BoolP("force", "f", false, "Skip interactive confirmation prompt")
	upgradeMode := outputFlag(upgrade)
	upgrade.RunE = func(_ *cobra.Command, _ []string) error {
		const op = "Upgrade Caracal CLI"
		install := detectInstall()
		if cerr := managedInstallGuard(install, op); cerr != nil {
			return cerr
		}
		target := *upgradeVersion
		if target != "" {
			if !pep440Re.MatchString(target) {
				return validationErr(fmt.Sprintf("Invalid target version: %s.", target), op, "target version",
					"Use a release version such as 2.5.0.")
			}
		} else {
			target = fetchLatestRelease(*upgradePre)
			if target == "" {
				return &clierr.Error{
					Category: clierr.Unavailable, Message: "Could not fetch the latest CLI release from GitHub.",
					Operation: op, Resource: "GitHub releases",
					Remediation: "Check network access and retry, or provide --version.",
				}
			}
		}
		if target == cliVersion {
			doc := fmt.Sprintf(`{"action": "upgrade", "status": "up_to_date", "current_version": %s, "target_version": %s, "install_method": %s, "path": %s}`,
				jsonString(cliVersion), jsonString(target), jsonString(install.Method), jsonString(install.Path))
			if *upgradeMode == "json" {
				outputJSONRaw([]byte(doc))
			} else {
				fmt.Printf("Already on v%s (latest).\n", cliVersion)
			}
			return nil
		}
		if older, err := versionNewer(cliVersion, target); err == nil && older {
			return validationErr(fmt.Sprintf("Upgrade target v%s is older than current v%s.", target, cliVersion),
				op, "target version",
				fmt.Sprintf("Use `caracal self downgrade --version %s` instead.", target))
		}
		if *upgradeMode == "json" && !*upgradeForce {
			return validationErr("JSON mode cannot prompt before upgrading the CLI.", op, "CLI installation",
				"Add --force to confirm the upgrade.")
		}
		if !*upgradeForce {
			fmt.Printf("  Current: v%s\n  Target:  v%s\n  Method:  %s (%s)\n", cliVersion, target, install.Method, install.Path)
			if !confirm("\nProceed with upgrade?") {
				return abortErr(op)
			}
		}
		lockPath, cerr := acquireCLILock(op)
		if cerr != nil {
			return cerr
		}
		defer os.Remove(lockPath)
		if cerr := installBinaryRelease(install, target, "upgrade", op, *upgradeMode == "json"); cerr != nil {
			return cerr
		}
		if *upgradeMode == "json" {
			outputJSONRaw([]byte(fmt.Sprintf(`{"action": "upgrade", "status": "completed", "from_version": %s, "to_version": %s, "install_method": %s, "path": %s}`,
				jsonString(cliVersion), jsonString(target), jsonString(install.Method), jsonString(install.Path))))
		}
		return nil
	}

	downgrade := &cobra.Command{Use: "downgrade", Short: "Downgrade the CLI to an older release", Args: cobra.NoArgs}
	downgradeVersion := downgrade.Flags().StringP("version", "v", "", "Target version to downgrade to")
	downgradeList := downgrade.Flags().BoolP("list", "l", false, "List available releases")
	downgradeForce := downgrade.Flags().BoolP("force", "f", false, "Skip confirmation prompt")
	downgradeMode := outputFlag(downgrade)
	downgrade.RunE = func(_ *cobra.Command, _ []string) error {
		const op = "Downgrade Caracal CLI"
		if *downgradeList && *downgradeVersion != "" {
			return validationErr("Choose either --list or --version, not both.", op, "downgrade mode",
				"Remove one of the conflicting options.")
		}
		if *downgradeList {
			repo := selfGithubRepo()
			releaseParts := []string{}
			for page := 1; page <= 10; page++ {
				var releases []struct {
					TagName     string `json:"tag_name"`
					PublishedAt string `json:"published_at"`
					Prerelease  bool   `json:"prerelease"`
					HTMLURL     string `json:"html_url"`
				}
				url := fmt.Sprintf("https://api.github.com/repos/%s/releases?per_page=10&page=%d", repo, page)
				if !githubJSON(url, 15*time.Second, &releases) || len(releases) == 0 {
					break
				}
				for _, release := range releases {
					if release.Prerelease {
						continue
					}
					version := strings.TrimLeft(release.TagName, "v")
					releaseParts = append(releaseParts, fmt.Sprintf(
						`{"version": %s, "published_at": %s, "prerelease": false, "url": %s, "current": %t}`,
						jsonString(version), jsonString(release.PublishedAt), jsonString(release.HTMLURL),
						version == cliVersion))
				}
			}
			if len(releaseParts) == 0 {
				return &clierr.Error{
					Category: clierr.Unavailable, Message: "Could not fetch CLI releases from GitHub.",
					Operation: "List Caracal CLI releases", Resource: "GitHub releases",
					Remediation: "Check network access and retry.",
				}
			}
			doc := fmt.Sprintf(`{"current_version": %s, "items": [%s]}`, jsonString(cliVersion), strings.Join(releaseParts, ", "))
			if *downgradeMode == "json" {
				outputJSONRaw([]byte(doc))
				return nil
			}
			printDocumentSummary([]byte(doc))
			return nil
		}
		if *downgradeVersion == "" {
			return validationErr("A target version is required for downgrade.", op, "target version",
				"Provide --version or use --list.")
		}
		target := *downgradeVersion
		if !pep440Re.MatchString(target) {
			return validationErr(fmt.Sprintf("Invalid target version: %s.", target), op, "target version",
				"Use a release version such as 2.4.0.")
		}
		if belowFloor, err := versionNewer("1.0.0", target); err == nil && belowFloor {
			return validationErr("Cannot downgrade below v1.0.0.", op, "target version",
				"Choose v1.0.0 or newer.")
		}
		if newer, err := versionNewer(target, cliVersion); err == nil && (newer || target == cliVersion) {
			return validationErr(fmt.Sprintf("Downgrade target v%s is not older than current v%s.", target, cliVersion),
				op, "target version", "Choose an older release or use `caracal self upgrade`.")
		}
		install := detectInstall()
		if cerr := managedInstallGuard(install, op); cerr != nil {
			return cerr
		}
		if *downgradeMode == "json" && !*downgradeForce {
			return validationErr("JSON mode cannot prompt before downgrading the CLI.", op, "CLI installation",
				"Add --force to confirm the downgrade.")
		}
		if !*downgradeForce {
			fmt.Printf("  Current: v%s\n  Target:  v%s\n", cliVersion, target)
			if !confirm("\nProceed with downgrade?") {
				return abortErr(op)
			}
		}
		lockPath, cerr := acquireCLILock(op)
		if cerr != nil {
			return cerr
		}
		defer os.Remove(lockPath)
		if cerr := installBinaryRelease(install, target, "downgrade", op, *downgradeMode == "json"); cerr != nil {
			return cerr
		}
		if *downgradeMode == "json" {
			outputJSONRaw([]byte(fmt.Sprintf(`{"action": "downgrade", "status": "completed", "from_version": %s, "to_version": %s, "install_method": %s, "path": %s, "automatic_updates_disabled": false}`,
				jsonString(cliVersion), jsonString(target), jsonString(install.Method), jsonString(install.Path))))
		}
		return nil
	}

	rollback := &cobra.Command{Use: "rollback", Short: "Restore the previous CLI binary", Args: cobra.NoArgs}
	rollbackForce := rollback.Flags().BoolP("force", "f", false, "Skip confirmation prompt")
	rollbackMode := outputFlag(rollback)
	rollback.RunE = func(_ *cobra.Command, _ []string) error {
		const op = "Rollback Caracal CLI"
		install := detectInstall()
		backup := filepath.Join(config.Dir(), "bin", "caracal.prev")
		if info, err := os.Stat(backup); err != nil || info.IsDir() {
			return &clierr.Error{
				Category: clierr.NotFound, Message: "No CLI rollback backup was found.",
				Operation: op, Resource: backup,
				Remediation: "Run a successful binary upgrade or downgrade before rollback.",
			}
		}
		if install.Method != "binary" {
			return &clierr.Error{
				Category: clierr.Conflict, Message: "Rollback is only supported for standalone binary installations.",
				Operation: op, Resource: "CLI installation",
				Remediation: "Install the previous version with the current package manager.",
			}
		}
		if *rollbackMode == "json" && !*rollbackForce {
			return validationErr("JSON mode cannot prompt before rolling back the CLI.", op, "CLI installation",
				"Add --force to confirm rollback.")
		}
		if !*rollbackForce {
			fmt.Printf("  Restore: %s → %s\n", backup, install.Path)
			if !confirm("Proceed?") {
				return abortErr(op)
			}
		}
		lockPath, cerr := acquireCLILock(op)
		if cerr != nil {
			return cerr
		}
		defer os.Remove(lockPath)
		tmp, err := os.CreateTemp(filepath.Dir(install.Path), ".caracal-rollback-")
		restoreFail := func(err error) *clierr.Error {
			return &clierr.Error{
				Category: clierr.Unavailable, Message: "Could not restore the previous CLI binary.",
				Operation: op, Resource: install.Path,
				Remediation: "Check filesystem permissions and retry.", Detail: err.Error(),
			}
		}
		if err != nil {
			return restoreFail(err)
		}
		blob, err := os.ReadFile(backup)
		if err != nil {
			_ = tmp.Close()
			os.Remove(tmp.Name())
			return restoreFail(err)
		}
		if _, err := tmp.Write(blob); err != nil {
			_ = tmp.Close()
			os.Remove(tmp.Name())
			return restoreFail(err)
		}
		if err := tmp.Close(); err != nil {
			os.Remove(tmp.Name())
			return restoreFail(err)
		}
		_ = os.Chmod(tmp.Name(), 0o755)
		if err := os.Rename(tmp.Name(), install.Path); err != nil {
			os.Remove(tmp.Name())
			return restoreFail(err)
		}
		doc := fmt.Sprintf(`{"action": "rollback", "status": "completed", "backup": %s, "path": %s}`,
			jsonString(backup), jsonString(install.Path))
		if *rollbackMode == "json" {
			outputJSONRaw([]byte(doc))
			return nil
		}
		ui.Stdout().Successf("Rolled back to previous version.")
		return nil
	}

	group.AddCommand(status, upgrade, downgrade, rollback)
	return group
}
