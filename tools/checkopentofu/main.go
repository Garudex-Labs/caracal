// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Command checkopentofu verifies OpenTofu <-> app environment consistency:
//
//  1. Common variables exist across all OpenTofu modules
//  2. Every env var the deployed containers require has a provisioning path
//  3. Every env var OpenTofu injects is one the containers actually read
//  4. .env.example stays within the known environment contract
//
// The environment contract below is the source of truth for what the Go API
// server (cmd/caracal-server) and the identity service (apps/auth) read at
// boot. Update it when either service gains or loses an environment variable.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var moduleOrder = []string{"aws", "gcp"}

var commonVars = stringSet("environment", "name_prefix", "image_tag", "clickhouse_mode")

var providerSpecific = map[string]map[string]bool{
	"aws": stringSet("region"),
	"gcp": stringSet("region", "project_id"),
}

// serverEnv is every variable the Go API server and its init command read.
// Aliases (DATABASE_URL et al.) are the fallback names the server accepts
// when the CARACAL_* form is absent.
var serverEnv = stringSet(
	"CARACAL_POSTGRES_URL", "DATABASE_URL",
	"CARACAL_CLICKHOUSE_URL", "CLICKHOUSE_URL",
	"CARACAL_REDIS_URL", "REDIS_URL",
	"CARACAL_JWKS_URL",
	"CARACAL_JWT_ISSUER",
	"CARACAL_JWT_AUDIENCE",
	"CARACAL_AUTH_SERVICE_URL",
	"CARACAL_GO_ADDR",
	"AUTH_INTERNAL_SECRET",
	"SECRET_KEY",
	"MIGRATION_ARTIFACT_ROOT",
	"TMPDIR",
)

// identityEnv is every variable the identity service (Better Auth) reads.
var identityEnv = stringSet(
	"NODE_ENV",
	"AUTH_PORT",
	"AUTH_BASE_PATH",
	"DATABASE_URL",
	"BETTER_AUTH_SECRET",
	"BETTER_AUTH_URL",
	"AUTH_TRUSTED_ORIGINS",
	"AUTH_INTERNAL_SECRET",
	"AUTH_DEV_LOGIN",
	"AUTH_EMAIL_WEBHOOK_URL",
	"AUTH_SESSION_HISTORY_RETENTION_DAYS",
	"CARACAL_OPERATOR_EMAILS",
	"GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET",
	"GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET",
)

// requiredEnv lists what a cloud deployment must provision for the stack to
// come up. Each entry is a group of interchangeable names: provisioning any
// one of them satisfies the requirement.
var requiredEnv = [][]string{
	{"CARACAL_POSTGRES_URL", "DATABASE_URL"},
	{"CARACAL_CLICKHOUSE_URL", "CLICKHOUSE_URL"},
	{"CARACAL_REDIS_URL", "REDIS_URL"},
	{"CARACAL_JWKS_URL"},
	{"CARACAL_JWT_ISSUER"},
	{"CARACAL_AUTH_SERVICE_URL"},
	{"AUTH_INTERNAL_SECRET"},
	{"SECRET_KEY"},
	{"BETTER_AUTH_SECRET"},
	{"BETTER_AUTH_URL"},
}

// dockerComposeOnly lists .env.example vars consumed by docker-compose
// itself (container credentials, host ports), not by any deployed app.
var dockerComposeOnly = stringSet(
	"POSTGRES_USER",
	"POSTGRES_PASSWORD",
	"CLICKHOUSE_USER",
	"CLICKHOUSE_PASSWORD",
	"AUTH_NODE_ENV",
	"AUTH_DATABASE_URL",
	"POSTGRES_HOST_PORT",
	"CLICKHOUSE_HOST_PORT",
	"REDIS_HOST_PORT",
	"WEB_HOST_PORT",
	"LB_HOST_PORT",
	"CLICKHOUSE_MEMORY_LIMIT",
)

// infraOnly lists env names OpenTofu injects for infrastructure containers
// (managed ClickHouse, Grafana) rather than the app services.
var infraOnly = stringSet(
	"GRAFANA_ADMIN_PASSWORD",
	"DB_PASSWORD",
	"CLICKHOUSE_PASSWORD",
	"CLICKHOUSE_USER",
	"CLICKHOUSE_DB",
	"POSTGRES_USER",
	"POSTGRES_PASSWORD",
	"POSTGRES_DB",
)

var (
	variableRe   = regexp.MustCompile(`^\s*variable\s+"([^"]+)"`)
	secretKeyRe  = regexp.MustCompile(`"([A-Z][A-Z_0-9]+)"\s*=`)
	envNameRe    = regexp.MustCompile(`name\s*=\s*"([A-Z][A-Z_0-9]+)"`)
	envExampleRe = regexp.MustCompile(`^([A-Z][A-Z_0-9]+)\s*=`)
)

const (
	warnIcon = "\033[1;33m!\033[0m"
	passIcon = "\033[0;32m\u2713\033[0m"
	failIcon = "\033[0;31m\u2717\033[0m"
)

func stringSet(items ...string) map[string]bool {
	set := make(map[string]bool, len(items))
	for _, item := range items {
		set[item] = true
	}
	return set
}

func sortedKeys(set map[string]bool) []string {
	keys := make([]string, 0, len(set))
	for k := range set {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// listRepr renders a sorted string list as ['a', 'b'].
func listRepr(items []string) string {
	if len(items) == 0 {
		return "[]"
	}
	return "['" + strings.Join(items, "', '") + "']"
}

// findRoot walks up from the working directory to the repository root.
func findRoot() string {
	dir, err := os.Getwd()
	if err != nil {
		return "."
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "."
		}
		dir = parent
	}
}

func modulePath(root, name string) string {
	return filepath.Join(root, "infra", "opentofu", name)
}

// ── Check 1: Common variables across modules ─────────────────────────────────

// parseVariables extracts variable names from a variables.tf file (ignoring commented lines).
func parseVariables(tfPath string) map[string]bool {
	content, err := os.ReadFile(tfPath)
	if err != nil {
		return map[string]bool{}
	}
	results := map[string]bool{}
	for _, line := range strings.Split(string(content), "\n") {
		stripped := strings.TrimSpace(line)
		if strings.HasPrefix(stripped, "#") || strings.HasPrefix(stripped, "//") {
			continue
		}
		if m := variableRe.FindStringSubmatch(line); m != nil {
			results[m[1]] = true
		}
	}
	return results
}

func checkCommonVariables(root string) []string {
	var errs []string
	for _, name := range moduleOrder {
		varsFile := filepath.Join(modulePath(root, name), "variables.tf")
		if _, err := os.Stat(varsFile); err != nil {
			errs = append(errs, fmt.Sprintf("  %s/variables.tf does not exist", name))
			continue
		}
		declared := parseVariables(varsFile)
		var missing []string
		for _, required := range []map[string]bool{commonVars, providerSpecific[name]} {
			for v := range required {
				if !declared[v] {
					missing = append(missing, v)
				}
			}
		}
		if len(missing) > 0 {
			sort.Strings(missing)
			errs = append(errs, fmt.Sprintf("  %s/variables.tf missing: %s", name, listRepr(missing)))
		}
	}
	return errs
}

// ── Provisioned env extraction ────────────────────────────────────────────────

// parseOpentofuProvisioned extracts env var names a module injects into
// containers. name = "UPPER_CASE" patterns in these .tf files exclusively
// appear inside container env/secret blocks; resource names use lowercase.
func parseOpentofuProvisioned(module string) map[string]bool {
	provisioned := map[string]bool{}
	entries, err := os.ReadDir(module)
	if err != nil {
		return provisioned
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".tf") {
			continue
		}
		content, err := os.ReadFile(filepath.Join(module, entry.Name()))
		if err != nil {
			continue
		}
		for _, m := range envNameRe.FindAllStringSubmatch(string(content), -1) {
			provisioned[m[1]] = true
		}
		if entry.Name() == "secrets.tf" {
			for _, m := range secretKeyRe.FindAllStringSubmatch(string(content), -1) {
				provisioned[m[1]] = true
			}
		}
	}
	return provisioned
}

// ── Check 2: Required env coverage ────────────────────────────────────────────

// checkRequiredEnv verifies each module provisions every required variable
// group (any alias in a group counts).
func checkRequiredEnv(root string) []string {
	var errs []string
	for _, moduleName := range moduleOrder {
		provisioned := parseOpentofuProvisioned(modulePath(root, moduleName))
		var missing []string
		for _, group := range requiredEnv {
			satisfied := false
			for _, name := range group {
				if provisioned[name] {
					satisfied = true
					break
				}
			}
			if !satisfied {
				missing = append(missing, group[0])
			}
		}
		if len(missing) > 0 {
			sort.Strings(missing)
			errs = append(errs, fmt.Sprintf(
				"  %s: deployment requires these env vars but the module "+
					"doesn't provision them: %s", moduleName, listRepr(missing)))
		}
	}
	return errs
}

// ── Check 3: Injected env cross-check ─────────────────────────────────────────

// checkInjectedVars ensures every injected env var maps to something a
// deployed container reads.
func checkInjectedVars(root string) []string {
	known := map[string]bool{}
	for _, set := range []map[string]bool{serverEnv, identityEnv, infraOnly} {
		for name := range set {
			known[name] = true
		}
	}

	var errs []string
	for _, moduleName := range moduleOrder {
		provisioned := parseOpentofuProvisioned(modulePath(root, moduleName))
		var unknown []string
		for name := range provisioned {
			if !known[name] {
				unknown = append(unknown, name)
			}
		}
		if len(unknown) > 0 {
			sort.Strings(unknown)
			errs = append(errs, fmt.Sprintf(
				"  %s: OpenTofu injects vars no deployed container reads: %s", moduleName, listRepr(unknown)))
		}
	}
	return errs
}

// ── Check 4: .env.example coverage ───────────────────────────────────────────

// parseEnvExample extracts KEY names from .env.example, including commented
// optional entries (# KEY=).
func parseEnvExample(root string) map[string]bool {
	content, err := os.ReadFile(filepath.Join(root, ".env.example"))
	if err != nil {
		return map[string]bool{}
	}
	keys := map[string]bool{}
	for _, line := range strings.Split(string(content), "\n") {
		line = strings.TrimSpace(line)
		line = strings.TrimPrefix(line, "# ")
		if m := envExampleRe.FindStringSubmatch(line); m != nil {
			keys[m[1]] = true
		}
	}
	return keys
}

// checkEnvExample requires every .env.example var to be part of the known
// environment contract (app-read or docker-compose-only).
func checkEnvExample(root string) []string {
	envKeys := parseEnvExample(root)
	if len(envKeys) == 0 {
		return []string{"  .env.example not found or empty"}
	}

	var errs []string
	for _, key := range sortedKeys(envKeys) {
		if dockerComposeOnly[key] || serverEnv[key] || identityEnv[key] {
			continue
		}
		errs = append(errs, fmt.Sprintf("  .env.example has %s but no deployed container reads it", key))
	}
	return errs
}

// ── Main ──────────────────────────────────────────────────────────────────────

func main() {
	root := findRoot()

	fmt.Println("OpenTofu <-> App consistency checks")
	fmt.Println(strings.Repeat("=", 60))

	var allErrors []string

	fmt.Println("\n[1/4] Common variables across modules...")
	errs := checkCommonVariables(root)
	allErrors = append(allErrors, errs...)
	if len(errs) == 0 {
		fmt.Printf("  %s PASS\n", passIcon)
	} else {
		fmt.Println(strings.Join(errs, "\n"))
	}

	fmt.Println("\n[2/4] Required env coverage...")
	errs = checkRequiredEnv(root)
	allErrors = append(allErrors, errs...)
	if len(errs) == 0 {
		fmt.Printf("  %s PASS\n", passIcon)
	} else {
		fmt.Println(strings.Join(errs, "\n"))
	}

	fmt.Println("\n[3/4] Injected env cross-check...")
	errs = checkInjectedVars(root)
	allErrors = append(allErrors, errs...)
	if len(errs) == 0 {
		fmt.Printf("  %s PASS\n", passIcon)
	} else {
		fmt.Println(strings.Join(errs, "\n"))
	}

	fmt.Println("\n[4/4] .env.example coverage...")
	errs = checkEnvExample(root)
	allErrors = append(allErrors, errs...)
	if len(errs) == 0 {
		fmt.Printf("  %s PASS\n", passIcon)
	} else {
		fmt.Println(strings.Join(errs, "\n"))
	}

	fmt.Println("\n" + strings.Repeat("=", 60))
	if len(allErrors) > 0 {
		fmt.Printf("%s FAILED: %d error(s)\n", failIcon, len(allErrors))
		os.Exit(1)
	}
	fmt.Printf("%s ALL CHECKS PASSED\n", passIcon)
}
