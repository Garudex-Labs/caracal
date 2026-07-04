// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Run manifest endpoint: authenticates a workload and returns its console-authored launch bindings.

package internal

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	sharederr "github.com/garudex-labs/caracal/packages/core/go/errors"
)

// RunBinding is one env-to-resource credential binding a caracal run launch injects.
// The scopes are the authority the binding requests when its credential is minted.
type RunBinding struct {
	Env       string   `json:"env"`
	Resource  string   `json:"resource"`
	Scopes    []string `json:"scopes,omitempty"`
	Optional  bool     `json:"optional,omitempty"`
	OnFailure string   `json:"on_failure,omitempty"`
}

// RunManifestResponse is the workload's binding list joined with the identity STS resolved.
type RunManifestResponse struct {
	ZoneID     string       `json:"zone_id"`
	WorkloadID string       `json:"workload_id"`
	Bindings   []RunBinding `json:"bindings"`
}

// authenticateRunWorkload resolves a workload that proves possession of its secret.
// Every failure returns nil so callers report one opaque error: an unknown id and a
// wrong secret are indistinguishable, avoiding an enumeration oracle.
func (s *Server) authenticateRunWorkload(ctx context.Context, workloadID, secret string) *Workload {
	workload, err := s.db.GetWorkloadByID(ctx, workloadID)
	if err != nil || workload.SecretHash == "" || !verifyClientSecret(workload.SecretHash, secret) {
		return nil
	}
	return workload
}

// runBindings decodes a workload's stored binding list.
func runBindings(workload *Workload) ([]RunBinding, error) {
	var bindings []RunBinding
	if len(workload.Bindings) > 0 {
		if err := json.Unmarshal(workload.Bindings, &bindings); err != nil {
			return nil, err
		}
	}
	return bindings, nil
}

// handleRunManifest resolves the launch profile for a workload that proves possession
// of its secret. The lookup is global so launches carry only the workload identity.
func (s *Server) handleRunManifest(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)
	if err := r.ParseForm(); err != nil {
		writeError(w, http.StatusBadRequest, sharederr.New(sharederr.InvalidToken, "malformed request body"))
		return
	}
	workloadID := strings.TrimSpace(r.FormValue("workload_id"))
	secret := r.FormValue("secret")
	if workloadID == "" || secret == "" {
		writeError(w, http.StatusBadRequest, sharederr.New(sharederr.InvalidToken, "workload_id and secret are required"))
		return
	}

	ctx := r.Context()
	if rateErr := s.checkRateLimit(ctx, "run-manifest", workloadID, "fetch"); rateErr != nil {
		writeError(w, http.StatusTooManyRequests, rateErr)
		return
	}

	workload := s.authenticateRunWorkload(ctx, workloadID, secret)
	if workload == nil {
		writeError(w, http.StatusUnauthorized, sharederr.New(sharederr.AccessDenied, "invalid workload credentials"))
		return
	}

	bindings, err := runBindings(workload)
	if err != nil {
		s.log.Error().Err(err).Str("workload_id", workload.ID).Msg("workload bindings are not valid JSON")
		writeError(w, http.StatusInternalServerError, sharederr.New(sharederr.Internal, "workload bindings are invalid"))
		return
	}
	if len(bindings) == 0 {
		writeError(w, http.StatusNotFound, sharederr.New(sharederr.ResourceNotFound,
			"no credential bindings configured; define them for this workload on the Launcher page in the Caracal web console"))
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(RunManifestResponse{
		ZoneID:     workload.ZoneID,
		WorkloadID: workload.ID,
		Bindings:   bindings,
	})
}
