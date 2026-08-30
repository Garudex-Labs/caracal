// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package adminmigrate

import (
	"encoding/json"
	"time"
)

// ArtifactMeta describes one downloadable artifact attached to a job.
type ArtifactMeta struct {
	Name      string `json:"name"`
	SizeBytes int64  `json:"size_bytes"`
	Sha256    string `json:"sha256"`
	Kind      string `json:"kind"` // archive | parquet | manifest
}

// jobResponse is the wire shape of a migration job.
type jobResponse struct {
	ID              string          `json:"id"`
	OperationType   string          `json:"operation_type"`
	DataScope       string          `json:"data_scope"`
	Status          string          `json:"status"`
	ProgressPhase   *string         `json:"progress_phase"`
	ProgressPct     int             `json:"progress_pct"`
	ProgressMessage *string         `json:"progress_message"`
	ErrorMessage    *string         `json:"error_message"`
	CreatedAt       string          `json:"created_at"`
	FinishedAt      *string         `json:"finished_at"`
	Artifacts       []ArtifactMeta  `json:"artifacts"`
	Result          json.RawMessage `json:"result"`
	SchemaVersion   *string         `json:"schema_version"`
}

func wireTimeZ(t time.Time) string {
	t = t.UTC()
	if t.Nanosecond() == 0 {
		return t.Format("2006-01-02T15:04:05Z")
	}
	return t.Format("2006-01-02T15:04:05.000000Z")
}

func wireJob(j *Job) jobResponse {
	resp := jobResponse{
		ID:              j.ID.String(),
		OperationType:   j.Operation,
		DataScope:       j.Scope,
		Status:          j.Status,
		ProgressPhase:   j.ProgressPhase,
		ProgressPct:     j.ProgressPct,
		ProgressMessage: j.ProgressMessage,
		ErrorMessage:    j.ErrorMessage,
		CreatedAt:       wireTimeZ(j.CreatedAt),
		Artifacts:       []ArtifactMeta{},
		SchemaVersion:   j.SchemaVersion,
	}
	if j.FinishedAt != nil {
		s := wireTimeZ(*j.FinishedAt)
		resp.FinishedAt = &s
	}
	if len(j.ArtifactsJSON) > 0 {
		var artifacts []ArtifactMeta
		if err := json.Unmarshal(j.ArtifactsJSON, &artifacts); err == nil && artifacts != nil {
			resp.Artifacts = artifacts
		}
	}
	if len(j.ResultJSON) > 0 && string(j.ResultJSON) != "null" {
		resp.Result = json.RawMessage(j.ResultJSON)
	}
	return resp
}
