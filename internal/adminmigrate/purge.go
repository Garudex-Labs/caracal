// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package adminmigrate

import (
	"context"
	"log/slog"
	"os"
	"time"
)

// RunArtifactPurge deletes artifact directories for jobs whose retention
// window has passed, clearing the job rows' artifact references. It ticks
// every six hours until the context is cancelled.
func (h *Handler) RunArtifactPurge(ctx context.Context) {
	ticker := time.NewTicker(6 * time.Hour)
	defer ticker.Stop()
	for {
		h.purgeExpiredArtifacts(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (h *Handler) purgeExpiredArtifacts(ctx context.Context) {
	ttlHours := h.Settings.Int(ctx, "migration.artifact_ttl_hours", 24)
	cutoff := time.Now().UTC().Add(-time.Duration(ttlHours) * time.Hour)
	rows, err := h.Store.DB.Query(ctx,
		`SELECT id::text, artifact_dir FROM migration_jobs
		 WHERE finished_at IS NOT NULL AND finished_at < $1 AND artifact_dir IS NOT NULL`, cutoff)
	if err != nil {
		slog.Warn("artifact purge query failed", "error", err)
		return
	}
	type target struct{ id, dir string }
	var targets []target
	for rows.Next() {
		var t target
		if rows.Scan(&t.id, &t.dir) == nil {
			targets = append(targets, t)
		}
	}
	rows.Close()
	purged := 0
	for _, t := range targets {
		if info, err := os.Stat(t.dir); err == nil && info.IsDir() {
			if err := os.RemoveAll(t.dir); err != nil {
				slog.Warn("artifact purge failed", "job", t.id, "error", err)
				if info, err := os.Stat(t.dir); err == nil && info.IsDir() {
					continue
				}
			}
		}
		if _, err := h.Store.DB.Exec(ctx,
			`UPDATE migration_jobs SET artifact_dir = NULL, artifacts_json = NULL WHERE id = $1::uuid`, t.id); err != nil {
			slog.Warn("artifact purge row update failed", "job", t.id, "error", err)
			continue
		}
		purged++
	}
	if purged > 0 {
		slog.Info("expired migration artifacts purged", "count", purged)
	}
}
