// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/spf13/cobra"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
	"github.com/garudex-labs/caracal/internal/cli/sessions"
	"github.com/garudex-labs/caracal/internal/cli/ui"
)

// sessionEntry is one per-session reconcile outcome in contract order.
type sessionEntry struct {
	SessionID  string `json:"session_id"`
	Status     string `json:"status"`
	BytesNew   int64  `json:"bytes_new"`
	Reason     string `json:"reason,omitempty"`
	HTTPStatus int    `json:"http_status,omitempty"`
}

// harnessResult is one harness's reconcile outcome in contract order.
type harnessResult struct {
	Harness       string         `json:"harness"`
	Discovered    int            `json:"discovered"`
	Pushed        int            `json:"pushed"`
	Finalized     int            `json:"finalized"`
	Queued        int            `json:"queued"`
	Rejected      int            `json:"rejected"`
	WouldPush     int            `json:"would_push"`
	WouldFinalize int            `json:"would_finalize"`
	UpToDate      int            `json:"up_to_date"`
	Skipped       int            `json:"skipped"`
	Errors        int            `json:"errors"`
	Sessions      []sessionEntry `json:"sessions"`
}

// reconcileSummary aggregates all targets in contract order.
type reconcileSummary struct {
	Discovered    int `json:"discovered"`
	Pushed        int `json:"pushed"`
	Finalized     int `json:"finalized"`
	Queued        int `json:"queued"`
	Rejected      int `json:"rejected"`
	WouldPush     int `json:"would_push"`
	WouldFinalize int `json:"would_finalize"`
	UpToDate      int `json:"up_to_date"`
	Skipped       int `json:"skipped"`
	Errors        int `json:"errors"`
}

type rejectionRow struct {
	Harness    string `json:"harness"`
	SessionID  string `json:"session_id"`
	HTTPStatus int    `json:"http_status"`
}

// reconcileResult is the command's JSON document in contract order.
type reconcileResult struct {
	DryRun        bool             `json:"dry_run"`
	SinceHours    int              `json:"since_hours"`
	OutboxDrained *bool            `json:"outbox_drained"`
	Targets       []harnessResult  `json:"targets"`
	Summary       reconcileSummary `json:"summary"`
	Rejections    []rejectionRow   `json:"rejections"`
}

func reconcileCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "reconcile",
		Short: "Backfill local session records missed by automatic hook delivery",
	}
	harness := cmd.Flags().StringP("harness", "i", "", "Target one harness")
	since := cmd.Flags().Int("since", 168, "Recent-session window in hours")
	dryRun := cmd.Flags().BoolP("dry-run", "n", false, "Preview without network or cursor changes")
	mode := outputFlag(cmd)
	cmd.RunE = func(_ *cobra.Command, _ []string) error {
		return runReconcile(strings.ToLower(strings.TrimSpace(*harness)), *since, *dryRun, *mode)
	}
	return cmd
}

func runReconcile(harness string, sinceHours int, dryRun bool, mode string) error {
	jsonMode := mode == "json"
	say := func(format string, args ...any) {
		if !jsonMode {
			fmt.Printf(format+"\n", args...)
		}
	}
	if sinceHours < 1 || sinceHours > 8760 {
		return &clierr.Error{
			Category:    clierr.Usage,
			Message:     fmt.Sprintf("Invalid value for '--since': %d is not in the range 1<=x<=8760.", sinceHours),
			Operation:   "Run caracal reconcile",
			Remediation: "Run caracal reconcile --help for valid usage.",
		}
	}
	home, _ := os.UserHomeDir()
	cfg := sessions.LoadConfig(home)
	if cfg == nil || cfg.UserID == "" {
		return &clierr.Error{
			Category: clierr.Auth, Message: "Caracal session delivery is not configured.",
			Operation: "Reconcile local sessions", Resource: "CLI authentication configuration",
			Remediation: "Run `caracal auth login` and retry.",
		}
	}
	if harness != "" {
		if _, ok := sessions.Discoverers[harness]; !ok {
			names := make([]string, 0, len(sessions.Discoverers))
			for name := range sessions.Discoverers {
				names = append(names, name)
			}
			sort.Strings(names)
			return &clierr.Error{
				Category: clierr.Validation, Message: fmt.Sprintf("Unknown harness: %s.", harness),
				Operation: "Reconcile local sessions", Resource: "harness",
				Remediation: "Choose from: " + strings.Join(names, ", ") + ".",
			}
		}
	}
	targets := []string{}
	if harness != "" {
		targets = append(targets, harness)
	} else {
		names := make([]string, 0, len(sessions.Discoverers))
		for name := range sessions.Discoverers {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			if sessions.Installed(name, home) {
				targets = append(targets, name)
			}
		}
	}

	rejections := []sessions.Rejection{}
	var outboxDrained *bool
	if !dryRun {
		drained, err := sessions.DrainOutbox(cfg, sessions.DrainOptions{Home: home}, &rejections, nil)
		if err != nil {
			return &clierr.Error{
				Category: clierr.Unavailable, Message: "Could not read or deliver the durable session outbox.",
				Operation: "Reconcile local sessions", Resource: "session outbox",
				Remediation: "Check local storage and server connectivity, then retry.",
				Detail:      err.Error(),
			}
		}
		outboxDrained = &drained
		if !drained {
			say("The durable session outbox still has pending records.")
		}
	}

	results := make([]harnessResult, 0, len(targets))
	for _, target := range targets {
		result, err := reconcileHarness(target, cfg, sinceHours, dryRun, home, &rejections, say)
		if err != nil {
			return err
		}
		results = append(results, result)
	}

	summary := reconcileSummary{}
	for _, result := range results {
		summary.Discovered += result.Discovered
		summary.Pushed += result.Pushed
		summary.Finalized += result.Finalized
		summary.Queued += result.Queued
		summary.WouldPush += result.WouldPush
		summary.WouldFinalize += result.WouldFinalize
		summary.UpToDate += result.UpToDate
		summary.Skipped += result.Skipped
		summary.Errors += result.Errors
	}
	uniqueRejections := dedupeRejections(rejections)
	summary.Rejected = len(uniqueRejections)

	switch {
	case dryRun:
		say("\nDry run: %d session(s) would send records; %d would send final metadata.",
			summary.WouldPush, summary.WouldFinalize)
	case summary.Pushed > 0 || summary.Finalized > 0:
		if !jsonMode {
			fmt.Println()
			ui.Stdout().Successf("Delivered %d session(s) and finalized %d session(s).", summary.Pushed, summary.Finalized)
		}
	case len(targets) == 0:
		say("No installed harnesses were detected.")
	default:
		say("No new sessions to deliver.")
	}
	if summary.Queued > 0 && !jsonMode {
		ui.Stdout().Warnf("%d session(s) remain queued for retry.", summary.Queued)
	}
	if summary.Rejected > 0 && !jsonMode {
		ui.Stdout().Warnf("%d session batch(es) were rejected and quarantined.", summary.Rejected)
	}

	rows := make([]rejectionRow, 0, len(uniqueRejections))
	for _, rejection := range uniqueRejections {
		rows = append(rows, rejectionRow{
			Harness: rejection.Harness, SessionID: rejection.SessionID, HTTPStatus: rejection.StatusCode,
		})
	}
	if jsonMode {
		outputJSON(reconcileResult{
			DryRun: dryRun, SinceHours: sinceHours, OutboxDrained: outboxDrained,
			Targets: results, Summary: summary, Rejections: rows,
		})
	}
	return nil
}

func dedupeRejections(rejections []sessions.Rejection) []sessions.Rejection {
	seen := map[sessions.Rejection]bool{}
	out := []sessions.Rejection{}
	for _, rejection := range rejections {
		if !seen[rejection] {
			seen[rejection] = true
			out = append(out, rejection)
		}
	}
	return out
}

func reconcileHarness(harness string, cfg *sessions.Config, sinceHours int, dryRun bool,
	home string, rejections *[]sessions.Rejection, say func(string, ...any)) (harnessResult, error) {
	result := harnessResult{Harness: harness, Sessions: []sessionEntry{}}
	discoverer := sessions.Discoverers[harness]
	sources, err := discoverer.Discover(home, sinceHours)
	if err != nil {
		return result, &clierr.Error{
			Category: clierr.Unavailable, Message: fmt.Sprintf("Could not discover %s sessions.", harness),
			Operation: "Reconcile local sessions", Resource: harness,
			Remediation: "Check the harness session directory and permissions, then retry.",
			Detail:      err.Error(),
		}
	}
	result.Discovered = len(sources)
	if len(sources) == 0 {
		if !dryRun {
			say("No %s sessions found", harness)
		}
		return result, nil
	}
	say("%s: scanning sessions...", harness)

	for _, source := range sources {
		entry := sessionEntry{SessionID: source.SessionID, Status: "skipped"}
		if source.Path == "" {
			result.Skipped++
			entry.Reason = "source path unavailable"
			result.Sessions = append(result.Sessions, entry)
			continue
		}
		info, err := os.Stat(source.Path)
		if err != nil {
			result.Errors++
			entry.Status = "error"
			entry.Reason = "OSError"
			result.Sessions = append(result.Sessions, entry)
			say("  ✗ %s could not be read", source.SessionID)
			continue
		}
		size := info.Size()
		localOffset, _, finalized, _ := sessions.CursorStatus(source.CheckpointKey(), home)
		bytesNew := size - localOffset
		if bytesNew < 0 {
			bytesNew = 0
		}
		entry.BytesNew = bytesNew
		if dryRun {
			switch {
			case bytesNew > 0:
				result.WouldPush++
				entry.Status = "would_push"
				say("  Would push: %s (%d bytes new)", source.SessionID, bytesNew)
			case !finalized:
				result.WouldFinalize++
				entry.Status = "would_finalize"
				say("  Would finalize: %s", source.SessionID)
			default:
				result.UpToDate++
				entry.Status = "up_to_date"
			}
			result.Sessions = append(result.Sessions, entry)
			continue
		}
		if finalized && localOffset >= size {
			result.UpToDate++
			entry.Status = "up_to_date"
			result.Sessions = append(result.Sessions, entry)
			continue
		}
		offset, _, ok := sessions.RecoverCursorFromServer(cfg, source, home, nil)
		if !ok {
			result.Errors++
			entry.Status = "checkpoint_mismatch"
			entry.Reason = "server checkpoint does not match local source"
			result.Sessions = append(result.Sessions, entry)
			say("  ↻ %s checkpoint does not match local source", source.SessionID)
			continue
		}
		entry.BytesNew = size - offset
		if entry.BytesNew < 0 {
			entry.BytesNew = 0
		}
		rejectionsBefore := len(*rejections)
		delivered, err := sessions.DrainSessionSource(cfg, source, sessions.SourceOptions{
			HookEvent: "Reconcile", Final: true, Home: home, Rejections: rejections,
		})
		if err != nil {
			return result, &clierr.Error{
				Category: clierr.Unavailable, Message: "Could not write to the durable session outbox.",
				Operation: "Reconcile local sessions", Resource: "session outbox",
				Remediation: "Check local storage and retry.", Detail: err.Error(),
			}
		}
		sourceRejections := []sessions.Rejection{}
		for _, rejection := range (*rejections)[rejectionsBefore:] {
			if rejection.Harness == harness && rejection.SessionID == source.SessionID {
				sourceRejections = append(sourceRejections, rejection)
			}
		}
		switch {
		case len(sourceRejections) > 0:
			result.Rejected += len(sourceRejections)
			entry.Status = "rejected"
			entry.HTTPStatus = sourceRejections[len(sourceRejections)-1].StatusCode
			say("  ✗ %s rejected by server", source.SessionID)
		case delivered:
			key := "finalized"
			if offset < size {
				key = "pushed"
			}
			if key == "pushed" {
				result.Pushed++
			} else {
				result.Finalized++
			}
			entry.Status = key
			say("  ✓ %s", source.SessionID)
		default:
			result.Queued++
			entry.Status = "queued"
			say("  ↻ %s queued for retry", source.SessionID)
		}
		result.Sessions = append(result.Sessions, entry)
	}
	return result, nil
}
