// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/garudex-labs/caracal/internal/httpapi"
)

// SyncResponse is the wire shape of a source sync run.
type SyncResponse struct {
	SourceID        string  `json:"source_id"`
	Status          string  `json:"status"`
	ComponentsFound int     `json:"components_found"`
	CommitSHA       string  `json:"commit_sha"`
	Error           *string `json:"error"`
}

// TriggerSync mirrors one source now and records the outcome. Admins only.
func (s *Store) TriggerSync(ctx context.Context, viewer *Viewer, sourceID uuid.UUID, m *Mirror) (*SyncResponse, error) {
	if !viewer.seesPrivateListings() {
		return nil, &apiError{Status: http.StatusForbidden, Detail: "Insufficient permissions"}
	}
	var url, componentType string
	err := s.DB.QueryRow(ctx,
		`SELECT url, component_type FROM component_sources WHERE id = $1`, sourceID).
		Scan(&url, &componentType)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &apiError{Status: http.StatusNotFound, Detail: "Source not found"}
	}
	if err != nil {
		return nil, err
	}
	if _, err := s.DB.Exec(ctx,
		`UPDATE component_sources SET sync_status = 'syncing', updated_at = now() WHERE id = $1`, sourceID); err != nil {
		return nil, err
	}

	result := m.SyncSource(ctx, url, componentType)

	status := "success"
	var syncErr *string
	if !result.Success {
		status = "failed"
		syncErr = &result.Error
	}
	if _, err := s.DB.Exec(ctx,
		`UPDATE component_sources SET last_synced_at = now(), sync_status = $2, sync_error = $3, updated_at = now()
		 WHERE id = $1`, sourceID, status, syncErr); err != nil {
		return nil, err
	}
	var respErr *string
	if result.Error != "" {
		respErr = &result.Error
	}
	return &SyncResponse{
		SourceID:        sourceID.String(),
		Status:          status,
		ComponentsFound: len(result.Components),
		CommitSHA:       result.CommitSHA,
		Error:           respErr,
	}, nil
}

func (h *Handler) syncSource() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		errs := []fieldError{}
		sourceID := pathUUID(r, "source_id", &errs)
		if len(errs) > 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, errs)
			return
		}
		out, err := h.Store.TriggerSync(r.Context(), viewer, sourceID, h.Mirror)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, out)
	})
}

// SourceSyncer periodically refreshes sources whose auto-sync interval has
// elapsed. Cycles fire at the six-hour marks (00/06/12/18 UTC).
type SourceSyncer struct {
	DB     PGQuerier
	Mirror *Mirror

	now func() time.Time
}

const syncBoundaryHours = 6

// nextCycleWait is the duration until the next six-hour boundary.
func nextCycleWait(now time.Time) time.Duration {
	utc := now.UTC()
	boundary := utc.Truncate(time.Hour).Add(time.Duration(syncBoundaryHours-utc.Hour()%syncBoundaryHours) * time.Hour)
	return boundary.Sub(utc)
}

// Run syncs due sources at every boundary until the context ends.
func (s *SourceSyncer) Run(ctx context.Context) {
	clock := s.now
	if clock == nil {
		clock = time.Now
	}
	for {
		timer := time.NewTimer(nextCycleWait(clock()))
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
			s.Cycle(ctx)
		}
	}
}

// Cycle syncs every source that is due once.
func (s *SourceSyncer) Cycle(ctx context.Context) {
	rows, err := s.DB.Query(ctx,
		`SELECT id, url, component_type FROM component_sources
		 WHERE auto_sync_interval IS NOT NULL
		   AND (last_synced_at IS NULL OR last_synced_at + auto_sync_interval < now())`)
	if err != nil {
		slog.Error("source sync cannot list due sources", "error", err)
		return
	}
	type dueSource struct {
		id            uuid.UUID
		url           string
		componentType string
	}
	due := []dueSource{}
	for rows.Next() {
		var src dueSource
		if err := rows.Scan(&src.id, &src.url, &src.componentType); err != nil {
			rows.Close()
			slog.Error("source sync row scan failed", "error", err)
			return
		}
		due = append(due, src)
	}
	rows.Close()

	for _, src := range due {
		slog.Info("syncing component source", "source_id", src.id, "url", src.url)
		if _, err := s.DB.Exec(ctx,
			`UPDATE component_sources SET sync_status = 'syncing', updated_at = now() WHERE id = $1`, src.id); err != nil {
			slog.Error("source sync status update failed", "source_id", src.id, "error", err)
			continue
		}
		result := s.Mirror.SyncSource(ctx, src.url, src.componentType)
		status := "success"
		var syncErr *string
		if !result.Success {
			status = "failed"
			syncErr = &result.Error
		}
		if _, err := s.DB.Exec(ctx,
			`UPDATE component_sources SET last_synced_at = now(), sync_status = $2, sync_error = $3, updated_at = now()
			 WHERE id = $1`, src.id, status, syncErr); err != nil {
			slog.Error("source sync result update failed", "source_id", src.id, "error", err)
			continue
		}
		slog.Info("component source synced", "url", src.url, "status", status, "components", len(result.Components))
	}
}
