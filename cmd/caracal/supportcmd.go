// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

// ── redaction ──────────────────────────────────────────────────────

var redactKeyRe = regexp.MustCompile(`(?i)(password|secret|token|api_key|apikey|api[-_]key|access_key|private_key|credential|authorization|client_secret|bearer)`)
var redactJWTRe = regexp.MustCompile(`eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`)
var redactAWSRe = regexp.MustCompile(`AKIA[0-9A-Z]{16}`)
var redactURLUserRe = regexp.MustCompile(`([a-z][a-z0-9+\-.]*://)([^@/\s]+)@`)
var redactSplitRe = regexp.MustCompile("([\\s\"'`,;=\\[\\]{}()])")

func shannonEntropy(s string) float64 {
	counts := map[rune]int{}
	for _, r := range s {
		counts[r]++
	}
	entropy := 0.0
	total := float64(len([]rune(s)))
	for _, count := range counts {
		p := float64(count) / total
		entropy -= p * math.Log2(p)
	}
	return entropy
}

func redactString(value string, count *int) string {
	for {
		next := redactJWTRe.ReplaceAllString(value, "<REDACTED>")
		next = redactAWSRe.ReplaceAllString(next, "<REDACTED>")
		next = redactURLUserRe.ReplaceAllString(next, "${1}<REDACTED>@")
		parts := redactSplitRe.Split(next, -1)
		seps := redactSplitRe.FindAllString(next, -1)
		var rebuilt strings.Builder
		for i, part := range parts {
			if len(part) >= 32 && shannonEntropy(part) > 4.5 {
				rebuilt.WriteString("<REDACTED>")
			} else {
				rebuilt.WriteString(part)
			}
			if i < len(seps) {
				rebuilt.WriteString(seps[i])
			}
		}
		next = rebuilt.String()
		if next == value {
			return value
		}
		*count++
		value = next
	}
}

func redactValue(value any, count *int) any {
	switch v := value.(type) {
	case string:
		return redactString(v, count)
	case map[string]any:
		out := map[string]any{}
		for key, item := range v {
			if redactKeyRe.MatchString(key) {
				out[key] = "<REDACTED>"
				*count++
				continue
			}
			out[key] = redactValue(item, count)
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = redactValue(item, count)
		}
		return out
	default:
		return value
	}
}

// ── bundle collection ──────────────────────────────────────────────

var durationRe = regexp.MustCompile(`(?i)^(?:[1-9]\d*[dhms])+$`)
var durationPartRe = regexp.MustCompile(`(?i)([1-9]\d*)([dhms])`)

func durationSeconds(value string) (int64, bool) {
	if !durationRe.MatchString(value) {
		return 0, false
	}
	units := map[string]int64{"d": 86400, "h": 3600, "m": 60, "s": 1}
	total := int64(0)
	for _, match := range durationPartRe.FindAllStringSubmatch(value, -1) {
		n, _ := strconv.ParseInt(match[1], 10, 64)
		total += n * units[strings.ToLower(match[2])]
	}
	return total, true
}

type collectorResult struct {
	Name       string
	OK         bool
	DurationMS int64
	Error      string
}

type bundleFile struct {
	Path    string
	Content []byte
}

var remoteCollectors = map[string]bool{
	"versions": true, "health": true, "config": true, "aggregates": true, "errors": true, "logs": true,
}

var configAllowlist = map[string]bool{
	"DATABASE_URL": true, "CLICKHOUSE_URL": true, "REDIS_URL": true, "REDIS_SOCKET_TIMEOUT": true,
	"EVAL_MODEL_NAME": true, "EVAL_MODEL_PROVIDER": true, "AWS_REGION": true, "FRONTEND_URL": true,
	"JWT_ACCESS_TOKEN_EXPIRE_MINUTES": true, "JWT_REFRESH_TOKEN_EXPIRE_DAYS": true,
	"JWT_SIGNING_ALGORITHM": true,
	"RATE_LIMIT_AUTH":       true, "RATE_LIMIT_AUTH_STRICT": true, "DATA_RETENTION_DAYS": true,
}

var safeArchiveNameRe = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
var driveRe = regexp.MustCompile(`^[A-Za-z]:`)

func safeArchivePath(path string) bool {
	if path == "" || strings.Contains(path, `\`) || driveRe.MatchString(path) || strings.HasPrefix(path, "/") {
		return false
	}
	for _, part := range strings.Split(path, "/") {
		if part == ".." {
			return false
		}
	}
	return true
}

func redactedJSON(value any, count *int) []byte {
	blob, _ := json.MarshalIndent(redactValue(value, count), "", "  ")
	return blob
}

func supportBundleCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "bundle", Short: "Generate a redacted diagnostic bundle", Args: cobra.NoArgs}
	fileFlag := cmd.Flags().StringP("file", "f", "", "Archive path (default: ./caracal-support-{timestamp}.tar.gz)")
	logsSince := cmd.Flags().String("logs-since", "1h", "Duration of logs to include (e.g. 1h, 30m, 2d)")
	includeSystem := cmd.Flags().Bool("include-system", true, "Include OS/CPU/memory/disk metrics")
	noIncludeSystem := cmd.Flags().Bool("no-include-system", false, "Skip system metrics")
	force := cmd.Flags().Bool("force", false, "Overwrite files and skip size confirmation")
	yes := cmd.Flags().Bool("yes", false, "Overwrite files and skip size confirmation")
	mode := outputFlag(cmd)
	cmd.RunE = func(c *cobra.Command, _ []string) error {
		const op = "Generate support bundle"
		forceFlag := *force || *yes
		withSystem := *includeSystem && !*noIncludeSystem
		seconds, ok := durationSeconds(*logsSince)
		if !ok || seconds > 30*86400 {
			return validationErr(fmt.Sprintf("Invalid log duration: %s.", *logsSince), op, "log duration",
				"Use a positive duration no greater than 30 days, such as 30m, 2h, or 1d12h.")
		}
		outputPath := *fileFlag
		if outputPath == "" {
			outputPath = fmt.Sprintf("caracal-support-%s.tar.gz", time.Now().UTC().Format("20060102-150405"))
		}
		if strings.HasPrefix(outputPath, "~/") {
			home, _ := os.UserHomeDir()
			outputPath = filepath.Join(home, outputPath[2:])
		}
		if _, err := os.Stat(outputPath); err == nil && !forceFlag {
			if *mode == "json" {
				return &clierr.Error{
					Category: clierr.Conflict, Message: fmt.Sprintf("Support bundle already exists: %s.", outputPath),
					Operation: op, Resource: outputPath,
					Remediation: "Choose another path or add --force.",
				}
			}
			if !confirmDanger(fmt.Sprintf("Overwrite %s?", outputPath)) {
				return abortErr(op)
			}
		}
		warnings := []string{}
		results := []collectorResult{}
		remoteStatus := "ok"
		var serverResponse *omap
		client, cerr := newClient()
		if cerr == nil {
			started := time.Now()
			raw, rerr := client.Do("POST", "/api/v1/support/collect",
				nil, map[string]any{"collectors": []string{"all"}, "logs_since": *logsSince}, op, "support bundle")
			if rerr != nil {
				remoteStatus = string(rerr.Category)
				warning := fmt.Sprintf("Remote collectors unavailable: %s Local collectors will continue.", rerr.Message)
				warnings = append(warnings, warning)
				results = append(results, collectorResult{Name: "remote", OK: false, DurationMS: 0, Error: warning})
			} else {
				value, err := decodeOrderedJSON(raw)
				doc, _ := value.(*omap)
				if err != nil || doc == nil {
					remoteStatus = "invalid_response"
					warning := "Remote collectors returned invalid data: SyntaxError. Local collectors will continue."
					warnings = append(warnings, warning)
					results = append(results, collectorResult{Name: "remote", OK: false, DurationMS: 0, Error: warning})
				} else {
					serverResponse = doc
					_ = started
				}
			}
		} else {
			remoteStatus = string(cerr.Category)
			warning := fmt.Sprintf("Remote collectors unavailable: %s Local collectors will continue.", cerr.Message)
			warnings = append(warnings, warning)
			results = append(results, collectorResult{Name: "remote", OK: false, DurationMS: 0, Error: warning})
		}
		files := []bundleFile{}
		redactionCounts := map[string]int{}
		addFile := func(path string, content []byte) {
			files = append(files, bundleFile{Path: path, Content: content})
		}
		serverVersion := "unknown"
		var remoteConfigData any
		if serverResponse != nil {
			if v := serverResponse.str("server_version"); v != "" {
				serverVersion = v
			}
			collectors := serverResponse.object("collectors")
			if collectors != nil {
				for _, name := range collectors.keys {
					entry, _ := collectors.get(name).(*omap)
					if entry == nil {
						warnings = append(warnings, fmt.Sprintf("Invalid remote collector skipped: %s.", name))
						continue
					}
					if !remoteCollectors[name] {
						warnings = append(warnings, fmt.Sprintf("Unknown remote collector skipped: %s.", name))
						continue
					}
					durationMS := int64(0)
					if n, ok := entry.get("duration_ms").(json.Number); ok {
						parsed, err := n.Int64()
						if err != nil {
							warnings = append(warnings, fmt.Sprintf("Invalid remote collector duration skipped: %s.", name))
							continue
						}
						durationMS = parsed
					}
					okFlag, _ := entry.get("ok").(bool)
					results = append(results, collectorResult{Name: name, OK: okFlag, DurationMS: durationMS})
					if !okFlag {
						continue
					}
					data := plain(entry.get("data"))
					count := 0
					switch name {
					case "config":
						remoteConfigData = data
					case "versions":
						versionData, _ := redactValue(data, &count).(map[string]any)
						appVersion, buildHash := "unknown", "unknown"
						if versionData != nil {
							if v, ok := versionData["app_version"].(string); ok && v != "" {
								appVersion = v
							}
							if v, ok := versionData["build_hash"].(string); ok && v != "" {
								buildHash = v
							}
						}
						appDoc, _ := json.MarshalIndent(map[string]any{
							"cli_version": cliVersion, "server_version": serverVersion,
							"build_hash": buildHash, "app_version": appVersion,
						}, "", "  ")
						addFile("versions/app.json", appDoc)
						alembic := "unknown"
						clickhouseVersion := "unknown"
						var clickhouseTables any = []any{}
						if versionData != nil {
							if v, ok := versionData["alembic_revision"].(string); ok && v != "" {
								alembic = v
							}
							if v, ok := versionData["clickhouse_version"].(string); ok && v != "" {
								clickhouseVersion = v
							}
							if v, ok := versionData["clickhouse_tables"]; ok && v != nil {
								clickhouseTables = v
							}
						}
						alembicDoc, _ := json.MarshalIndent(map[string]any{"current_revision": alembic}, "", "  ")
						addFile("versions/alembic.json", alembicDoc)
						chDoc, _ := json.MarshalIndent(map[string]any{"server_version": clickhouseVersion, "tables": clickhouseTables}, "", "  ")
						addFile("versions/clickhouse.json", chDoc)
						redactionCounts["versions"] += count
					case "health":
						healthData, _ := redactValue(data, &count).(map[string]any)
						for service, payload := range healthData {
							if !safeArchiveNameRe.MatchString(service) {
								warnings = append(warnings, fmt.Sprintf("Unsafe health collector name skipped: %s.", service))
								continue
							}
							blob, _ := json.MarshalIndent(payload, "", "  ")
							addFile("health/"+service+".json", blob)
						}
						redactionCounts["health"] += count
					case "aggregates":
						aggData, _ := redactValue(data, &count).(map[string]any)
						if aggData != nil {
							if v, ok := aggData["pg_table_counts"]; ok {
								blob, _ := json.MarshalIndent(v, "", "  ")
								addFile("aggregates/pg_table_counts.json", blob)
							}
							if v, ok := aggData["ch_table_counts"]; ok {
								blob, _ := json.MarshalIndent(v, "", "  ")
								addFile("aggregates/ch_table_counts.json", blob)
							}
						}
						redactionCounts["aggregates"] += count
					case "logs":
						logData, _ := data.(map[string]any)
						lines, _ := logData["lines"].([]any)
						if len(lines) > 0 {
							parts := make([]string, len(lines))
							for i, line := range lines {
								blob, _ := json.Marshal(redactValue(line, &count))
								parts[i] = string(blob)
							}
							addFile("logs/recent.ndjson", []byte(strings.Join(parts, "\n")))
						} else if note, ok := logData["note"]; ok {
							blob, _ := json.MarshalIndent(map[string]any{"note": redactValue(note, &count)}, "", "  ")
							addFile("logs/recent.ndjson", blob)
						}
						redactionCounts["logs/recent.ndjson"] += count
					default:
						addFile(name+".json", redactedJSON(data, &count))
						redactionCounts[name+".json"] += count
					}
				}
			}
		}
		// Local allowlisted configuration owns config/config.json.
		configStart := time.Now()
		allowlisted := map[string]any{}
		if configMap, ok := remoteConfigData.(map[string]any); ok {
			for key, value := range configMap {
				if configAllowlist[key] {
					allowlisted[key] = value
				}
			}
		}
		count := 0
		addFile("config/config.json", redactedJSON(allowlisted, &count))
		redactionCounts["config/config.json"] += count
		results = append(results, collectorResult{Name: "config_allowlisted", OK: true, DurationMS: time.Since(configStart).Milliseconds()})
		if withSystem {
			systemStart := time.Now()
			systemDoc := map[string]any{
				"os_name": runtime.GOOS, "os_version": "", "kernel_version": "",
				"cpu_count":          runtime.NumCPU(),
				"memory_total_bytes": nil, "memory_available_bytes": nil,
				"disk_total_bytes": nil, "disk_free_bytes": nil,
				"container_runtime": nil,
			}
			if _, err := os.Stat("/.dockerenv"); err == nil {
				systemDoc["container_runtime"] = "docker"
			} else if _, err := os.Stat("/run/.containerenv"); err == nil {
				systemDoc["container_runtime"] = "podman"
			} else if os.Getenv("KUBERNETES_SERVICE_HOST") != "" {
				systemDoc["container_runtime"] = "kubernetes"
			}
			count = 0
			addFile("system/system.json", redactedJSON(systemDoc, &count))
			redactionCounts["system/system.json"] += count
			results = append(results, collectorResult{Name: "system_info", OK: true, DurationMS: time.Since(systemStart).Milliseconds()})
		}
		for _, file := range files {
			if !safeArchivePath(file.Path) {
				return validationErr("A support collector produced an unsafe archive path.", op, file.Path,
					"Update the CLI or server before generating another bundle.")
			}
		}
		if len(files) == 0 {
			return &clierr.Error{
				Category: clierr.Unavailable, Message: "No diagnostic data could be collected.",
				Operation: op, Resource: "support collectors",
				Remediation: "Check local collector dependencies or server connectivity and retry.",
			}
		}
		totalBytes := int64(0)
		for _, file := range files {
			totalBytes += int64(len(file.Content))
		}
		if totalBytes > 100*1024*1024 {
			warning := fmt.Sprintf("Uncompressed bundle size %s exceeds the 100 MB budget.", humanSize(totalBytes))
			warnings = append(warnings, warning)
			if !forceFlag {
				if *mode == "json" {
					return validationErr(warning, op, "bundle size",
						"Add --force to accept the large archive or collect fewer logs.")
				}
				if !confirm("Continue writing the archive?") {
					return nil
				}
			}
		}
		hostname, _ := os.Hostname()
		hostHash := sha256.Sum256([]byte(hostname))
		collectorDocs := map[string]any{}
		for _, result := range results {
			entry := map[string]any{"ok": result.OK, "duration_ms": result.DurationMS}
			if result.Error != "" {
				redactCount := 0
				entry["error"] = redactString(result.Error, &redactCount)
			}
			collectorDocs[result.Name] = entry
		}
		inventory := []map[string]any{}
		sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
		for _, file := range files {
			sum := sha256.Sum256(file.Content)
			inventory = append(inventory, map[string]any{
				"path": file.Path, "size_bytes": len(file.Content), "sha256": hex.EncodeToString(sum[:]),
			})
		}
		manifest := map[string]any{
			"bundle_schema_version": "1",
			"created_at":            time.Now().UTC().Format("2006-01-02T15:04:05.000000+00:00"),
			"cli_version":           cliVersion,
			"host_os":               runtime.GOOS,
			"node_id":               hex.EncodeToString(hostHash[:])[:12],
			"flags_used": map[string]any{
				"file": filepath.Base(outputPath), "logs_since": *logsSince, "include_system": withSystem,
			},
			"collector_results": collectorDocs,
			"redaction_counts":  redactionCounts,
			"file_inventory":    inventory,
		}
		manifestBlob, _ := json.MarshalIndent(manifest, "", "  ")
		if cerr := writeSupportArchive(outputPath, manifestBlob, files, op); cerr != nil {
			return cerr
		}
		info, _ := os.Stat(outputPath)
		sizeBytes := int64(0)
		if info != nil {
			sizeBytes = info.Size()
		}
		warningParts := make([]string, len(warnings))
		for i, warning := range warnings {
			warningParts[i] = jsonString(warning)
		}
		collectorsBlob, _ := json.Marshal(collectorDocs)
		redactionBlob, _ := json.Marshal(redactionCounts)
		doc := fmt.Sprintf(`{"path": %s, "size_bytes": %d, "remote_status": %s, "warnings": [%s], "collector_results": %s, "redaction_counts": %s}`,
			jsonString(outputPath), sizeBytes, jsonString(remoteStatus), strings.Join(warningParts, ", "),
			string(collectorsBlob), string(redactionBlob))
		if *mode == "json" {
			outputJSONRaw([]byte(doc))
			return nil
		}
		fmt.Printf("Support bundle written to %s (%s)\n", outputPath, humanSize(sizeBytes))
		fmt.Printf("  Review contents with: caracal doctor support inspect %s\n", outputPath)
		return nil
	}
	return cmd
}

func humanSize(n int64) string {
	if n < 1024 {
		return fmt.Sprintf("%d B", n)
	}
	units := []string{"KB", "MB", "GB", "TB"}
	value := float64(n)
	for i, unit := range units {
		value /= 1024
		if value < 1024 || i == len(units)-1 {
			return fmt.Sprintf("%.1f %s", value, unit)
		}
	}
	return fmt.Sprintf("%.1f TB", value)
}

func writeSupportArchive(path string, manifest []byte, files []bundleFile, op string) *clierr.Error {
	fail := func(err error) *clierr.Error {
		return &clierr.Error{
			Category: clierr.Unavailable, Message: fmt.Sprintf("Could not write support bundle: %s.", path),
			Operation: op, Resource: path,
			Remediation: "Check the destination path, free space, and permissions, then retry.", Detail: err.Error(),
		}
	}
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".caracal-support-*")
	if err != nil {
		return fail(err)
	}
	tmpName := tmp.Name()
	gz := gzip.NewWriter(tmp)
	tw := tar.NewWriter(gz)
	now := time.Now().Unix()
	writeEntry := func(name string, content []byte) error {
		header := &tar.Header{Name: name, Mode: 0o644, Size: int64(len(content)), ModTime: time.Unix(now, 0)}
		if err := tw.WriteHeader(header); err != nil {
			return err
		}
		_, err := tw.Write(content)
		return err
	}
	if err := writeEntry("bundle_manifest.json", manifest); err != nil {
		_ = tw.Close()
		_ = gz.Close()
		_ = tmp.Close()
		os.Remove(tmpName)
		return fail(err)
	}
	for _, file := range files {
		if err := writeEntry(file.Path, file.Content); err != nil {
			_ = tw.Close()
			_ = gz.Close()
			_ = tmp.Close()
			os.Remove(tmpName)
			return fail(err)
		}
	}
	if err := tw.Close(); err != nil {
		_ = gz.Close()
		_ = tmp.Close()
		os.Remove(tmpName)
		return fail(err)
	}
	if err := gz.Close(); err != nil {
		_ = tmp.Close()
		os.Remove(tmpName)
		return fail(err)
	}
	_ = tmp.Close()
	_ = os.Chmod(tmpName, 0o600)
	if err := os.Rename(tmpName, path); err != nil {
		os.Remove(tmpName)
		return fail(err)
	}
	return nil
}

// ── inspect ────────────────────────────────────────────────────────

func supportInspectCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "inspect BUNDLE", Short: "Inspect a support bundle", Args: cobra.ExactArgs(1)}
	show := cmd.Flags().String("show", "", "Print one regular file from the archive")
	mode := outputFlag(cmd)
	cmd.RunE = func(_ *cobra.Command, args []string) error {
		const op = "Inspect support bundle"
		bundlePath := args[0]
		info, err := os.Stat(bundlePath)
		if err != nil || info.IsDir() {
			return &clierr.Error{
				Category: clierr.NotFound, Message: fmt.Sprintf("Support bundle not found: %s.", bundlePath),
				Operation: op, Resource: bundlePath,
				Remediation: "Choose an existing .tar.gz support bundle.",
			}
		}
		file, err := os.Open(bundlePath)
		if err != nil {
			return validationErr(fmt.Sprintf("Cannot open support bundle: %s.", bundlePath), op, bundlePath,
				"Choose a valid .tar.gz support bundle.")
		}
		defer func() { _ = file.Close() }()
		gz, err := gzip.NewReader(file)
		if err != nil {
			return validationErr(fmt.Sprintf("Cannot open support bundle: %s.", bundlePath), op, bundlePath,
				"Choose a valid .tar.gz support bundle.")
		}
		tr := tar.NewReader(gz)
		warnings := []string{}
		unsafeCount := 0
		type memberInfo struct {
			Size    int64
			Content []byte
		}
		members := map[string]memberInfo{}
		order := []string{}
		for {
			header, err := tr.Next()
			if err != nil {
				break
			}
			if header.Typeflag != tar.TypeReg {
				continue
			}
			if !safeArchivePath(header.Name) || strings.HasPrefix(filepath.Clean(header.Name), "..") {
				unsafeCount++
				continue
			}
			content := []byte{}
			if header.Size <= 4*1024*1024 {
				content = make([]byte, header.Size)
				_, _ = io.ReadFull(tr, content)
			}
			members[header.Name] = memberInfo{Size: header.Size, Content: content}
			order = append(order, header.Name)
		}
		if unsafeCount > 0 {
			warnings = append(warnings, fmt.Sprintf("Ignored %d unsafe archive member(s).", unsafeCount))
		}
		manifestEntry, ok := members["bundle_manifest.json"]
		if !ok {
			return validationErr("Support bundle manifest is missing or is not a regular file.", op,
				"bundle_manifest.json", "Generate a new bundle with the current CLI.")
		}
		if manifestEntry.Size > 1024*1024 {
			return validationErr("Support bundle manifest exceeds the inspection size limit.", op,
				"bundle_manifest.json", "Generate a new bundle with the current CLI.")
		}
		manifestValue, err := decodeOrderedJSON(manifestEntry.Content)
		if err != nil {
			return validationErr("Support bundle manifest is malformed.", op,
				"bundle_manifest.json", "Generate a new bundle with the current CLI.")
		}
		manifestDoc, ok := manifestValue.(*omap)
		if !ok {
			return validationErr("Support bundle manifest must be a JSON object.", op,
				"bundle_manifest.json", "Generate a new bundle with the current CLI.")
		}
		if version := manifestDoc.str("bundle_schema_version"); version != "" {
			if parsed, err := strconv.Atoi(version); err != nil {
				warnings = append(warnings, fmt.Sprintf("Unrecognized bundle schema version: %s.", version))
			} else if parsed > 1 {
				warnings = append(warnings, fmt.Sprintf("Bundle uses newer schema v%d; some fields may not be recognized.", parsed))
			}
		}
		shownDoc := "null"
		if *show != "" {
			if !safeArchivePath(*show) {
				return validationErr(fmt.Sprintf("Unsafe archive path: %s.", *show), op, *show,
					"Choose a regular file listed in the bundle.")
			}
			entry, ok := members[*show]
			if !ok {
				names := []string{}
				for name := range members {
					names = append(names, name)
				}
				sort.Strings(names)
				return &clierr.Error{
					Category: clierr.NotFound, Message: fmt.Sprintf("File not found in support bundle: %s.", *show),
					Operation: op, Resource: *show,
					Remediation: fmt.Sprintf("Choose an available file: %s.", strings.Join(names, ", ")),
				}
			}
			if entry.Size > 1024*1024 {
				return validationErr(fmt.Sprintf("Support bundle file is too large to display: %s.", *show), op, *show,
					"Inspect the archive with a size-limited local tool.")
			}
			shownDoc = fmt.Sprintf(`{"path": %s, "content": %s}`, jsonString(*show), jsonString(string(entry.Content)))
		}
		fileDocs := []string{}
		names := []string{}
		for _, name := range order {
			if name != "bundle_manifest.json" {
				names = append(names, name)
			}
		}
		sort.Strings(names)
		for _, name := range names {
			fileDocs = append(fileDocs, fmt.Sprintf(`{"path": %s, "size_bytes": %d}`, jsonString(name), members[name].Size))
		}
		warningParts := make([]string, len(warnings))
		for i, warning := range warnings {
			warningParts[i] = jsonString(warning)
		}
		manifestBlob, _ := marshalOrdered(manifestDoc)
		doc := fmt.Sprintf(`{"manifest": %s, "files": [%s], "warnings": [%s], "shown": %s}`,
			string(manifestBlob), strings.Join(fileDocs, ", "), strings.Join(warningParts, ", "), shownDoc)
		if *mode == "json" {
			outputJSONRaw([]byte(doc))
			return nil
		}
		printDocumentSummary([]byte(doc))
		return nil
	}
	return cmd
}

func supportGroup() *cobra.Command {
	group := &cobra.Command{Use: "support", Short: "Diagnostic bundle tools"}
	group.AddCommand(supportBundleCommand(), supportInspectCommand())
	return group
}
