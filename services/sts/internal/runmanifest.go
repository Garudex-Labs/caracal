// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Run manifest endpoint: authenticates a workload and returns its console-authored launch bindings.

package internal

import (
	"encoding/json"
	"net/http"
	"strings"

	sharederr "github.com/garudex-labs/caracal/packages/core/go/errors"
)

// RunManifestCredential is one env-to-resource binding a caracal run launch injects.
type RunManifestCredential struct {
	Env            string `json:"env"`
	Resource       string `json:"resource"`
	CredentialType string `json:"credential_type,omitempty"`
	Optional       bool   `json:"optional,omitempty"`
	OnFailure      string `json:"on_failure,omitempty"`
}

// RunManifest is the stored launch profile for an application.
type RunManifest struct {
	TTLSeconds        *int                    `json:"ttl_seconds,omitempty"`
	ContinueOnFailure *bool                   `json:"continue_on_failure,omitempty"`
	Credentials       []RunManifestCredential `json:"credentials"`
}

// RunManifestResponse is the manifest joined with the identity STS resolved for it.
type RunManifestResponse struct {
	ZoneID            string                  `json:"zone_id"`
	ApplicationID     string                  `json:"application_id"`
	TTLSeconds        *int                    `json:"ttl_seconds,omitempty"`
	ContinueOnFailure *bool                   `json:"continue_on_failure,omitempty"`
	Credentials       []RunManifestCredential `json:"credentials"`
}

// handleRunManifest resolves the launch profile for a workload that proves possession of
// its client secret. The lookup is global so launches carry only the application identity;
// every authentication failure is reported identically to avoid an enumeration oracle.
func (s *Server) handleRunManifest(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)
	if err := r.ParseForm(); err != nil {
		writeError(w, http.StatusBadRequest, sharederr.New(sharederr.InvalidToken, "malformed request body"))
		return
	}
	appID := strings.TrimSpace(r.FormValue("application_id"))
	clientSecret := r.FormValue("client_secret")
	if appID == "" || clientSecret == "" {
		writeError(w, http.StatusBadRequest, sharederr.New(sharederr.InvalidToken, "application_id and client_secret are required"))
		return
	}

	ctx := r.Context()
	if rateErr := s.checkRateLimit(ctx, "run-manifest", appID, "fetch"); rateErr != nil {
		writeError(w, http.StatusTooManyRequests, rateErr)
		return
	}

	app, err := s.db.GetApplicationByIDGlobal(ctx, appID)
	if err != nil || app.ClientSecretHash == nil || !verifyClientSecret(*app.ClientSecretHash, clientSecret) {
		writeError(w, http.StatusUnauthorized, sharederr.New(sharederr.AccessDenied, "invalid application credentials"))
		return
	}

	raw, err := s.db.GetApplicationRunManifest(ctx, app.ID)
	if err != nil {
		s.log.Error().Err(err).Str("application_id", app.ID).Msg("run manifest lookup failed")
		writeError(w, http.StatusInternalServerError, sharederr.New(sharederr.Internal, "run manifest lookup failed"))
		return
	}
	var manifest RunManifest
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &manifest); err != nil {
			s.log.Error().Err(err).Str("application_id", app.ID).Msg("run manifest is not valid JSON")
			writeError(w, http.StatusInternalServerError, sharederr.New(sharederr.Internal, "run manifest is invalid"))
			return
		}
	}
	if len(manifest.Credentials) == 0 {
		writeError(w, http.StatusNotFound, sharederr.New(sharederr.ResourceNotFound,
			"run manifest not configured; define credential bindings for this application in the Caracal web console"))
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(RunManifestResponse{
		ZoneID:            app.ZoneID,
		ApplicationID:     app.ID,
		TTLSeconds:        manifest.TTLSeconds,
		ContinueOnFailure: manifest.ContinueOnFailure,
		Credentials:       manifest.Credentials,
	})
}
