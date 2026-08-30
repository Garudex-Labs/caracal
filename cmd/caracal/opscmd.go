// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/garudex-labs/caracal/internal/cli/api"
	"github.com/garudex-labs/caracal/internal/cli/clierr"
	"github.com/garudex-labs/caracal/internal/cli/config"
	"github.com/garudex-labs/caracal/internal/cli/outbox"
	"github.com/garudex-labs/caracal/internal/cli/ref"
)

var rankingTypes = []string{"mcp", "agent"}

func commandChoice(value string, allowed []string, label, operation string) (string, *clierr.Error) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if !contains(allowed, normalized) {
		return "", &clierr.Error{
			Category: clierr.Validation, Message: fmt.Sprintf("Unknown %s: %s.", label, value),
			Operation: operation, Resource: label,
			Remediation: "Choose from: " + strings.Join(allowed, ", ") + ".",
		}
	}
	return normalized, nil
}

func opsCommand() *cobra.Command {
	group := &cobra.Command{Use: "ops", Short: "Observability and operational commands (sessions, telemetry, rankings, insights)"}
	group.AddCommand(opsTopCommand(), opsTracesCommand(), opsTelemetryGroup(), opsInsightsGroup(), opsLogsCommand())
	return group
}

func opsTopCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "top", Short: "List top registry items", Args: cobra.NoArgs}
	itemType := cmd.Flags().StringP("type", "t", "mcp", "mcp or agent")
	mode := outputFlag(cmd)
	cmd.RunE = func(_ *cobra.Command, _ []string) error {
		normalized, cerr := commandChoice(*itemType, rankingTypes, "ranking type", "List top registry items")
		if cerr != nil {
			return cerr
		}
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		path := "/api/v1/overview/top-mcps"
		if normalized == "agent" {
			path = "/api/v1/overview/top-agents"
		}
		raw, cerr := client.Do("GET", path, nil, nil, "List top registry items", "Caracal operations")
		if cerr != nil {
			return cerr
		}
		if *mode == "json" {
			outputJSONRaw(raw)
			return nil
		}
		printDocumentSummary(raw)
		return nil
	}
	return cmd
}

func opsTracesCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "traces", Short: "List traces", Args: cobra.NoArgs}
	platform := cmd.Flags().StringP("platform", "p", "", "Filter by harness platform")
	days := cmd.Flags().IntP("days", "d", 0, "Limit to last N days")
	limit := cmd.Flags().IntP("limit", "n", 20, "Result limit")
	turn := cmd.Flags().Bool("turn", false, "Unfold sessions to show turns (prompts)")
	span := cmd.Flags().Bool("span", false, "Show full detail including tool calls")
	mode := outputFlag(cmd)
	cmd.RunE = func(c *cobra.Command, _ []string) error {
		if c.Flags().Changed("days") && (*days < 1 || *days > 365) {
			return usageError("ops traces", fmt.Sprintf("Invalid value for '--days' / '-d': %d is not in the range 1<=x<=365.", *days))
		}
		if *limit < 1 || *limit > 200 {
			return usageError("ops traces", fmt.Sprintf("Invalid value for '--limit' / '-n': %d is not in the range 1<=x<=200.", *limit))
		}
		normalizedPlatform := ""
		if *platform != "" {
			var cerr *clierr.Error
			normalizedPlatform, cerr = commandChoice(*platform, validHarnesses, "harness platform", "List sessions")
			if cerr != nil {
				return cerr
			}
		}
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		params := map[string]string{"limit": fmt.Sprint(*limit)}
		if normalizedPlatform != "" {
			params["platform"] = normalizedPlatform
		}
		if c.Flags().Changed("days") {
			params["days"] = fmt.Sprint(*days)
		}
		raw, cerr := client.Do("GET", "/api/v1/sessions", params, nil, "List traces", "Caracal operations")
		if cerr != nil {
			return cerr
		}
		if !*turn && !*span {
			if *mode == "json" {
				outputJSONRaw(raw)
				return nil
			}
			printDocumentSummary(raw)
			return nil
		}
		var sessions []json.RawMessage
		_ = json.Unmarshal(raw, &sessions)
		items := make([]string, 0, len(sessions))
		for _, session := range sessions {
			var meta struct {
				SessionID string `json:"session_id"`
			}
			_ = json.Unmarshal(session, &meta)
			detail, cerr := client.Do("GET", "/api/v1/sessions/"+url.QueryEscape(meta.SessionID), nil, nil,
				"List traces", "Caracal operations")
			if cerr != nil {
				return cerr
			}
			items = append(items, fmt.Sprintf(`{"summary": %s, "detail": %s}`,
				string(bytes.TrimSpace(session)), string(bytes.TrimSpace(detail))))
		}
		view := "turn"
		if *span {
			view = "span"
		}
		doc := fmt.Sprintf(`{"view": %s, "items": [%s], "total": %d, "page": 1, "page_size": %d}`,
			jsonString(view), strings.Join(items, ", "), len(sessions), len(sessions))
		if *mode == "json" {
			outputJSONRaw([]byte(doc))
			return nil
		}
		printDocumentSummary([]byte(doc))
		return nil
	}
	return cmd
}

func opsTelemetryGroup() *cobra.Command {
	group := &cobra.Command{Use: "telemetry", Short: "Telemetry health commands"}
	status := &cobra.Command{Use: "status", Short: "Check telemetry status", Args: cobra.NoArgs}
	mode := outputFlag(status)
	status.RunE = func(_ *cobra.Command, _ []string) error {
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		serverRaw, cerr := client.Do("GET", "/api/v1/telemetry/status", nil, nil, "Check telemetry status", "Caracal operations")
		if cerr != nil {
			return cerr
		}
		outboxDoc := telemetryOutboxDoc()
		if *mode == "json" {
			doc := fmt.Sprintf(`{"server": %s, "outbox": %s}`, string(bytes.TrimSpace(serverRaw)), outboxDoc)
			outputJSONRaw([]byte(doc))
			return nil
		}
		printDocumentSummary(serverRaw)
		return nil
	}
	group.AddCommand(status)
	return group
}

func telemetryOutboxDoc() string {
	store, err := outbox.Open("")
	if err != nil {
		return `{"available": false, "error": "OutboxError"}`
	}
	defer func() { _ = store.Close() }()
	stats, err := store.ReadStats()
	if err != nil {
		return `{"available": false, "error": "OutboxError"}`
	}
	oldest, lastSync := "null", "null"
	if stats.OldestPending != nil {
		oldest = jsonString(*stats.OldestPending)
	}
	if stats.LastSync != nil {
		lastSync = jsonString(*stats.LastSync)
	}
	return fmt.Sprintf(`{"available": true, "pending": %d, "failed": %d, "sent": %d, "total": %d, "oldest_pending": %s, "last_sync": %s, "bytes": %d}`,
		stats.Pending, stats.Failed, stats.Sent, stats.Total, oldest, lastSync, stats.Bytes)
}

// ── ops insights ───────────────────────────────────────────────────

func resolveInsightAgentID(client *api.Client, agentRef string) (string, *clierr.Error) {
	resolved, cerr := ref.ResolveRegistryReference(client, "agent", agentRef, "Resolve insight agent", "agent insights")
	if cerr != nil {
		return "", cerr
	}
	raw, cerr := client.Do("GET", "/api/v1/agents/"+resolved, nil, nil, "Resolve insight agent", "agent insights")
	if cerr != nil {
		return "", cerr
	}
	var agent struct {
		ID any `json:"id"`
	}
	_ = json.Unmarshal(raw, &agent)
	if agent.ID == nil {
		return resolved, nil
	}
	return fmt.Sprint(agent.ID), nil
}

func opsInsightsGroup() *cobra.Command {
	group := &cobra.Command{Use: "insights", Short: "Agent insight reports"}

	list := &cobra.Command{Use: "list AGENT", Short: "List insight reports", Args: cobra.ExactArgs(1)}
	listMode := outputFlag(list)
	list.RunE = func(_ *cobra.Command, args []string) error {
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		agentID, cerr := resolveInsightAgentID(client, args[0])
		if cerr != nil {
			return cerr
		}
		raw, cerr := client.Do("GET", "/api/v1/agents/"+agentID+"/insights/reports", nil, nil,
			"List insight reports", "agent insights")
		if cerr != nil {
			return cerr
		}
		if *listMode == "json" {
			outputJSONRaw(raw)
			return nil
		}
		printDocumentSummary(raw)
		return nil
	}

	show := &cobra.Command{Use: "show TARGET [REPORT]", Short: "Show an agent insight report", Args: cobra.RangeArgs(1, 2)}
	showMode := outputFlag(show)
	section := show.Flags().StringP("section", "s", "", "Show only a specific section")
	show.RunE = func(_ *cobra.Command, args []string) error {
		const op = "Show agent insight report"
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		agentID, cerr := resolveInsightAgentID(client, args[0])
		if cerr != nil {
			return cerr
		}
		reportsRaw, cerr := client.Do("GET", "/api/v1/agents/"+agentID+"/insights/reports", nil, nil,
			"Resolve insight report", "agent insights")
		if cerr != nil {
			return cerr
		}
		var reports []struct {
			ID     any    `json:"id"`
			Status string `json:"status"`
		}
		_ = json.Unmarshal(reportsRaw, &reports)
		reportRef := ""
		if len(args) > 1 {
			reportRef = args[1]
		}
		if len(reports) == 0 {
			return &clierr.Error{
				Category: clierr.NotFound, Message: "No insight reports were found for this agent.",
				Operation: op, Resource: "agent insight reports",
				Remediation: "Generate a report first.",
			}
		}
		reportID := ""
		switch {
		case reportRef == "" || reportRef == "latest":
			reportID = fmt.Sprint(reports[0].ID)
			for _, report := range reports {
				if report.Status == "completed" {
					reportID = fmt.Sprint(report.ID)
					break
				}
			}
		case isDigitsOnly(reportRef):
			index, _ := strconv.Atoi(reportRef)
			if index < 1 || index > len(reports) {
				return &clierr.Error{
					Category: clierr.Validation, Message: fmt.Sprintf("Insight report row %d is out of range.", index),
					Operation: op, Resource: "insight report row",
					Remediation: fmt.Sprintf("Choose a row from 1 to %d.", len(reports)),
				}
			}
			reportID = fmt.Sprint(reports[index-1].ID)
		default:
			matches := []string{}
			for _, report := range reports {
				id := fmt.Sprint(report.ID)
				if strings.HasPrefix(strings.ToLower(id), strings.ToLower(reportRef)) {
					matches = append(matches, id)
				}
			}
			if len(matches) > 1 {
				return &clierr.Error{
					Category: clierr.Conflict, Message: fmt.Sprintf("Insight report prefix is ambiguous: %s.", reportRef),
					Operation: op, Resource: "insight report",
					Remediation: "Use a row number from `caracal ops insights list <agent>`.",
				}
			}
			if len(matches) == 0 {
				return &clierr.Error{
					Category: clierr.NotFound, Message: fmt.Sprintf("Insight report not found: %s.", reportRef),
					Operation: op, Resource: "insight report",
					Remediation: "Use a row number from `caracal ops insights list <agent>`.",
				}
			}
			reportID = matches[0]
		}
		raw, cerr := client.Do("GET", "/api/v1/agents/"+agentID+"/insights/reports/"+reportID, nil, nil,
			"Resolve insight report", "agent insights")
		if cerr != nil {
			return cerr
		}
		if *section != "" {
			value, err := decodeOrderedJSON(raw)
			doc, _ := value.(*omap)
			if err != nil || doc == nil {
				return &clierr.Error{
					Category: clierr.Unavailable, Message: "The insight report narrative has an invalid shape.",
					Operation: op, Resource: "insight report",
					Remediation: "Regenerate the report or check server compatibility.",
				}
			}
			narrative := doc.object("narrative")
			if narrative == nil {
				if doc.get("narrative") != nil {
					return &clierr.Error{
						Category: clierr.Unavailable, Message: "The insight report narrative has an invalid shape.",
						Operation: op, Resource: "insight report",
						Remediation: "Regenerate the report or check server compatibility.",
					}
				}
				narrative = newOmap()
			}
			if !narrative.has(*section) {
				return &clierr.Error{
					Category: clierr.Validation, Message: fmt.Sprintf("Unknown insight report section: %s.", *section),
					Operation: op, Resource: "insight report section",
					Remediation: "Choose from: " + strings.Join(narrative.keys, ", ") + ".",
				}
			}
			sectionData, _ := marshalOrdered(narrative.get(*section))
			reportIDValue, _ := marshalOrdered(doc.get("id"))
			out := fmt.Sprintf(`{"report_id": %s, "section": %s, "data": %s}`,
				string(reportIDValue), jsonString(*section), string(sectionData))
			if *showMode == "json" {
				outputJSONRaw([]byte(out))
				return nil
			}
			printDocumentSummary([]byte(out))
			return nil
		}
		if *showMode == "json" {
			outputJSONRaw(raw)
			return nil
		}
		printDocumentSummary(raw)
		return nil
	}

	generate := &cobra.Command{Use: "generate AGENT", Short: "Generate an insight report", Args: cobra.ExactArgs(1)}
	generateMode := outputFlag(generate)
	period := generate.Flags().IntP("period", "p", 14, "Analysis period in days")
	versionFlag := generate.Flags().StringP("version", "v", "", "Agent version to analyze")
	compare := generate.Flags().String("compare", "", "Baseline agent version for A/B comparison")
	wait := generate.Flags().Bool("wait", false, "Poll until the report completes")
	generate.RunE = func(c *cobra.Command, args []string) error {
		const op = "Generate agent insight report"
		if *period < 1 || *period > 365 {
			return usageError("ops insights generate", fmt.Sprintf("Invalid value for '--period' / '-p': %d is not in the range 1<=x<=365.", *period))
		}
		normalizeVersion := func(value, label string) (string, *clierr.Error) {
			if value == "" {
				return "", nil
			}
			if !pep440Re.MatchString(value) {
				return "", &clierr.Error{
					Category: clierr.Validation, Message: fmt.Sprintf("Invalid %s: %s.", label, value),
					Operation: op, Resource: label,
					Remediation: "Use a semantic version such as 1.2.3.",
				}
			}
			return value, nil
		}
		agentVersion, cerr := normalizeVersion(*versionFlag, "agent version")
		if cerr != nil {
			return cerr
		}
		compareVersion, cerr := normalizeVersion(*compare, "comparison version")
		if cerr != nil {
			return cerr
		}
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		statusRaw, cerr := client.Do("GET", "/api/v1/insights/status", nil, nil, "Generate insight report", "agent insights")
		if cerr != nil {
			return cerr
		}
		var status struct {
			Available bool    `json:"available"`
			Reason    *string `json:"reason"`
		}
		_ = json.Unmarshal(statusRaw, &status)
		if !status.Available {
			reason := "Insights is not configured."
			if status.Reason != nil {
				reason = *status.Reason
			}
			return &clierr.Error{
				Category: clierr.Unavailable, Message: "Insights is unavailable: " + reason,
				Operation: op, Resource: "insights service",
				Remediation: "Configure insights.model_sections and insights.api_key, then retry.",
			}
		}
		agentID, cerr := resolveInsightAgentID(client, args[0])
		if cerr != nil {
			return cerr
		}
		body := newOmap()
		body.set("period_days", *period)
		if agentVersion != "" {
			body.set("agent_version", agentVersion)
		}
		if compareVersion != "" {
			body.set("comparison_agent_version", compareVersion)
		}
		raw, cerr := client.Do("POST", "/api/v1/agents/"+agentID+"/insights/reports", nil, body,
			"Generate insight report", "agent insights")
		if cerr != nil {
			return cerr
		}
		if !*wait {
			if *generateMode == "json" {
				outputJSONRaw(raw)
				return nil
			}
			printDocumentSummary(raw)
			return nil
		}
		var queued struct {
			ID any `json:"id"`
		}
		_ = json.Unmarshal(raw, &queued)
		if *generateMode == "json" {
			emitJSONLine("queued", raw)
		}
		reportID := fmt.Sprint(queued.ID)
		finalStatus := ""
		var current []byte
		for attempt := 0; attempt < 120; attempt++ {
			current, cerr = client.Do("GET", "/api/v1/agents/"+agentID+"/insights/reports/"+reportID, nil, nil,
				"Generate insight report", "agent insights")
			if cerr != nil {
				return cerr
			}
			var progress struct {
				Status       string `json:"status"`
				ErrorMessage string `json:"error_message"`
			}
			_ = json.Unmarshal(current, &progress)
			if *generateMode == "json" {
				emitJSONLine("progress", current)
			}
			finalStatus = progress.Status
			if finalStatus == "completed" || finalStatus == "failed" {
				break
			}
			time.Sleep(3 * time.Second)
		}
		if finalStatus != "completed" && finalStatus != "failed" {
			return &clierr.Error{
				Category: clierr.Unavailable, Message: "Timed out waiting for the insight report.",
				Operation: op, Resource: "insight report",
				Remediation: "Use `caracal ops insights show <agent> latest` to check it later.",
			}
		}
		if finalStatus == "failed" {
			var failed struct {
				ErrorMessage *string `json:"error_message"`
			}
			_ = json.Unmarshal(current, &failed)
			detail := ""
			if failed.ErrorMessage != nil {
				detail = *failed.ErrorMessage
			}
			return &clierr.Error{
				Category: clierr.Unavailable, Message: "Insight report generation failed.",
				Operation: op, Resource: "insight report",
				Remediation: "Inspect the report error and insights provider configuration.", Detail: detail,
			}
		}
		if *generateMode != "json" {
			fmt.Println("Report completed")
		}
		return nil
	}

	group.AddCommand(list, show, generate)
	return group
}

// emitJSONLine writes one compact event record to stdout.
func emitJSONLine(event string, reportRaw []byte) {
	value, err := decodeOrderedJSON(reportRaw)
	var compactReport []byte
	if err == nil {
		compactReport, err = marshalOrderedCompact(value)
	}
	if err != nil {
		compactReport = bytes.TrimSpace(reportRaw)
	}
	fmt.Printf(`{"event":%s,"report":%s}`+"\n", compactJSONString(event), string(compactReport))
}

func compactJSONString(s string) string { return jsonString(s) }

// ── ops logs ───────────────────────────────────────────────────────

var logLevelRanks = map[string]int{"TRACE": 0, "DEBUG": 1, "INFO": 2, "WARNING": 3, "ERROR": 4, "CRITICAL": 5}
var logLevelOrder = []string{"TRACE", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}

func opsLogsCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "logs", Short: "Live log viewer (open in a separate tab)", Args: cobra.NoArgs}
	level := cmd.Flags().StringP("level", "l", "DEBUG", "Minimum level (TRACE, DEBUG, INFO, WARNING, ERROR, CRITICAL)")
	filterText := cmd.Flags().StringP("filter", "f", "", "Only show lines containing this text")
	lines := cmd.Flags().IntP("lines", "n", 20, "Recent lines to show before following")
	noFollow := cmd.Flags().Bool("no-follow", false, "Print recent lines and exit")
	remote := cmd.Flags().BoolP("remote", "r", false, "Stream from the connected server via SSE")
	noColor := cmd.Flags().Bool("no-color", false, "Disable colored output")
	mode := outputFlag(cmd)
	cmd.RunE = func(c *cobra.Command, _ []string) error {
		_ = noColor
		levelValue := strings.ToUpper(strings.TrimSpace(*level))
		if _, ok := logLevelRanks[levelValue]; !ok {
			return validationErr(fmt.Sprintf("Unknown log level: %s.", levelValue), "Stream logs", "log level",
				"Choose from: TRACE, DEBUG, INFO, WARNING, ERROR, CRITICAL.")
		}
		if *lines < 0 {
			return usageError("ops logs", fmt.Sprintf("Invalid value for '--lines' / '-n': %d is less than 0.", *lines))
		}
		if *remote {
			if *noFollow {
				return remoteRecentLogs(levelValue, *filterText, *lines, *mode)
			}
			return remoteStreamLogs(levelValue, *filterText, *mode)
		}
		return localLogs(levelValue, *filterText, *lines, *noFollow, *mode)
	}
	return cmd
}

func remoteRecentLogs(level, filterText string, lines int, mode string) error {
	if lines == 0 {
		return nil
	}
	client, cerr := newClient()
	if cerr != nil {
		return cerr
	}
	params := map[string]string{"level": level, "limit": fmt.Sprint(lines)}
	if filterText != "" {
		params["filter"] = filterText
	}
	raw, cerr := client.Do("GET", "/api/v1/operator/logs", params, nil, "Read recent server logs", "server logs")
	if cerr != nil {
		return cerr
	}
	value, err := decodeOrderedJSON(raw)
	doc, _ := value.(*omap)
	var entries []any
	if err == nil && doc != nil {
		entries, _ = doc.get("entries").([]any)
	}
	if doc == nil || doc.get("entries") == nil || entries == nil {
		return &clierr.Error{
			Category: clierr.Unavailable, Message: "The server returned an invalid recent logs response.",
			Operation: "Read recent server logs", Resource: "server logs",
			Remediation: "Check server health and version compatibility, then retry.",
		}
	}
	for _, rawEntry := range entries {
		entry, ok := rawEntry.(*omap)
		if !ok {
			return &clierr.Error{
				Category: clierr.Unavailable, Message: "The server returned an invalid recent logs response.",
				Operation: "Read recent server logs", Resource: "server logs",
				Remediation: "Check server health and version compatibility, then retry.",
			}
		}
		if mode == "json" {
			compact, _ := marshalOrderedCompact(entry)
			fmt.Printf(`{"event":"log","source":"remote","log":%s}`+"\n", string(compact))
		} else {
			fmt.Fprintln(os.Stderr, formatRemoteLog(entry))
		}
	}
	return nil
}

func formatRemoteLog(entry *omap) string {
	ts := entry.str("timestamp")
	if len(ts) >= 23 {
		ts = ts[11:23]
	}
	return fmt.Sprintf("%s | %-7s | %s:%s:%v - %s", ts, entry.str("level"),
		entry.str("logger_name"), entry.str("function"), entry.get("line"), entry.str("event"))
}

func remoteStreamLogs(level, filterText, mode string) error {
	cfg, cerr := config.Load()
	if cerr != nil {
		return cerr
	}
	baseURL := strings.TrimRight(config.Str(cfg, "server_url"), "/")
	token := config.Str(cfg, "access_token")
	params := url.Values{"level": {level}}
	if filterText != "" {
		params.Set("filter", filterText)
	}
	if mode != "json" {
		fmt.Fprintf(os.Stderr, "Connecting to %s …\n", baseURL)
	}
	req, err := http.NewRequest("GET", baseURL+"/api/v1/operator/logs/stream?"+params.Encode(), nil)
	if err != nil {
		return &clierr.Error{Category: clierr.Unexpected, Message: err.Error(), Operation: "Stream server logs", Resource: "server log stream"}
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Caracal-CLI-Version", cliVersion)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return &clierr.Error{
			Category: clierr.Unavailable, Message: "Cannot connect to the server log stream.",
			Operation: "Stream server logs", Resource: "server log stream",
			Remediation: "Check server connectivity and retry.", Detail: err.Error(),
		}
	}
	defer func() { _ = resp.Body.Close() }()
	switch {
	case resp.StatusCode == 401:
		return &clierr.Error{
			Category: clierr.Auth, Message: "Authentication failed while streaming logs.",
			Operation: "Stream server logs", Resource: "server log stream",
			Remediation: "Run `caracal auth login` and retry.", HTTPStatus: 401,
		}
	case resp.StatusCode == 403:
		return &clierr.Error{
			Category: clierr.Permission, Message: "Administrator access is required to stream server logs.",
			Operation: "Stream server logs", Resource: "server log stream",
			Remediation: "Use an administrator account or read local logs.", HTTPStatus: 403,
		}
	case resp.StatusCode != 200:
		return &clierr.Error{
			Category: clierr.Unavailable, Message: fmt.Sprintf("The server log stream returned HTTP %d.", resp.StatusCode),
			Operation: "Stream server logs", Resource: "server log stream",
			Remediation: "Check server health and retry.", HTTPStatus: resp.StatusCode,
		}
	}
	if mode != "json" {
		fmt.Fprintln(os.Stderr, "- Streaming (Ctrl+C to stop) -")
		fmt.Fprintln(os.Stderr)
	}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" || strings.HasPrefix(line, ": ") {
			continue
		}
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimLeft(line[5:], " \t")
		value, err := decodeOrderedJSON([]byte(payload))
		if err != nil {
			return &clierr.Error{
				Category: clierr.Unavailable, Message: "The server log stream returned malformed JSON.",
				Operation: "Stream server logs", Resource: "server log stream",
				Remediation: "Check server health and version compatibility.", Detail: err.Error(),
			}
		}
		entry, ok := value.(*omap)
		if !ok {
			return &clierr.Error{
				Category: clierr.Unavailable, Message: "The server log stream returned an invalid record.",
				Operation: "Stream server logs", Resource: "server log stream",
				Remediation: "Check server health and version compatibility.",
			}
		}
		if mode == "json" {
			compact, _ := marshalOrderedCompact(entry)
			fmt.Printf(`{"event":"log","source":"remote","log":%s}`+"\n", string(compact))
		} else {
			fmt.Fprintln(os.Stderr, formatRemoteLog(entry))
		}
	}
	return nil
}

func localLogs(level, filterText string, lines int, noFollow bool, mode string) error {
	home, _ := os.UserHomeDir()
	logPath := filepath.Join(home, ".caracal", "logs", "dev.log")
	file, err := os.Open(logPath)
	if err != nil {
		return &clierr.Error{
			Category: clierr.NotFound, Message: fmt.Sprintf("Local log file not found: %s.", logPath),
			Operation: "Read local logs", Resource: logPath,
			Remediation: "Use `caracal ops logs --remote` for a hosted server.",
		}
	}
	minRank := logLevelRanks[level]
	parseLevel := func(line string) (string, bool) {
		for _, name := range logLevelOrder {
			if strings.Contains(line, "| "+name+" ") || strings.Contains(line, "| "+name) {
				return name, true
			}
		}
		return "", false
	}
	shouldShow := func(line string) (string, bool) {
		parsed, ok := parseLevel(line)
		if ok && logLevelRanks[parsed] < minRank {
			return parsed, false
		}
		if filterText != "" && !strings.Contains(strings.ToLower(line), strings.ToLower(filterText)) {
			return parsed, false
		}
		return parsed, true
	}
	emit := func(line string) {
		line = strings.TrimRight(line, "\n")
		parsed, show := shouldShow(line)
		if !show {
			return
		}
		if mode == "json" {
			levelValue := "null"
			if parsed != "" {
				levelValue = jsonString(parsed)
			}
			fmt.Printf(`{"event":"log","source":"local","level":%s,"line":%s}`+"\n", levelValue, jsonString(line))
		} else {
			fmt.Fprintln(os.Stderr, line)
		}
	}
	if lines > 0 {
		tail := make([]string, 0, lines)
		scanner := bufio.NewScanner(file)
		scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		for scanner.Scan() {
			tail = append(tail, scanner.Text())
			if len(tail) > lines {
				tail = tail[1:]
			}
		}
		for _, line := range tail {
			emit(line)
		}
	}
	_ = file.Close()
	if noFollow {
		return nil
	}
	if mode != "json" {
		fmt.Fprintf(os.Stderr, "\n- Following %s (Ctrl+C to stop) -\n\n", logPath)
	}
	follow, err := os.Open(logPath)
	if err != nil {
		return &clierr.Error{
			Category: clierr.Unavailable, Message: fmt.Sprintf("Could not follow local log file: %s.", logPath),
			Operation: "Follow local logs", Resource: logPath,
			Remediation: "Check file permissions and retry.", Detail: err.Error(),
		}
	}
	defer func() { _ = follow.Close() }()
	_, _ = follow.Seek(0, 2)
	reader := bufio.NewReader(follow)
	for {
		line, err := reader.ReadString('\n')
		if line != "" {
			emit(line)
		}
		if err != nil {
			time.Sleep(100 * time.Millisecond)
		}
	}
}

func isDigitsOnly(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
