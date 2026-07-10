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

	"github.com/google/uuid"

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

// authenticateRunWorkload resolves a workload that proves possession of its secret. The
// authenticated result is nil unless verification succeeds; a workload that exists but
// fails verification is still returned so the failure can be audited in its zone. A
// dummy argon2id derivation runs for unknown ids so both failure paths cost one
// verification, keeping the caller's opaque error free of a timing oracle.
func (s *Server) authenticateRunWorkload(ctx context.Context, workloadID, secret string) (authenticated, known *Workload) {
	workload, err := s.db.GetWorkloadByID(ctx, workloadID)
	if err != nil || workload.SecretHash == "" {
		verifyArgon2id("", secret)
		return nil, nil
	}
	if !verifyClientSecret(workload.SecretHash, secret) {
		return nil, workload
	}
	return workload, workload
}

// launchIDFromHeader returns the client-generated launch correlation id when it is a
// well-formed UUID; anything else is dropped so audit metadata never carries free text.
func launchIDFromHeader(r *http.Request) string {
	id := strings.TrimSpace(r.Header.Get("X-Caracal-Launch-Id"))
	if id == "" {
		return ""
	}
	if _, err := uuid.Parse(id); err != nil {
		return ""
	}
	return id
}

// emitRunAudit records a workload launch decision under the run_launch event type so
// manifest fetches and workload authentication failures are visible in the zone ledger.
func (s *Server) emitRunAudit(requestID, zoneID, decision, status string, meta map[string]any) *sharederr.CaracalError {
	event, err := buildAuditEvent(requestID, zoneID, decision, status, &OPAResult{}, meta)
	if err != nil {
		s.log.Error().Err(err).Str("request_id", requestID).Str("zone_id", zoneID).Msg("audit event id generation failed")
		return sharederr.New(sharederr.Internal, "audit event creation failed")
	}
	event.EventType = "run_launch"
	s.auditBuffer.Emit(event)
	return nil
}

// requireRunAuth authenticates a workload for a run endpoint, auditing a failed secret
// verification in the workload's zone and logging unknown ids, which cannot be zone
// attributed. Both failures answer with the same opaque 401.
func (s *Server) requireRunAuth(w http.ResponseWriter, r *http.Request, requestID, launchID, workloadID, secret string) *Workload {
	workload, known := s.authenticateRunWorkload(r.Context(), workloadID, secret)
	if workload != nil {
		return workload
	}
	if known != nil {
		meta := workloadAuditMeta(known)
		if launchID != "" {
			meta["launch_id"] = launchID
		}
		if auditErr := s.emitRunAudit(requestID, known.ZoneID, "deny", "workload_auth_failed", meta); auditErr != nil {
			writeError(w, http.StatusInternalServerError, auditErr)
			return nil
		}
	} else {
		s.log.Warn().Str("workload_id", workloadID).Str("request_id", requestID).Msg("run authentication failed for unknown workload id")
	}
	writeError(w, http.StatusUnauthorized, sharederr.New(sharederr.AccessDenied, "invalid workload credentials"))
	return nil
}

// runRequestID returns the caller-provided request id or a generated UUIDv7.
func (s *Server) runRequestID(w http.ResponseWriter, r *http.Request) (string, bool) {
	requestID := r.Header.Get("X-Request-Id")
	if requestID == "" {
		id, err := uuid.NewV7()
		if err != nil {
			s.log.Error().Err(err).Msg("request id generation failed")
			writeError(w, http.StatusInternalServerError, sharederr.New(sharederr.Internal, "generate request id"))
			return "", false
		}
		requestID = id.String()
	}
	return requestID, true
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
	form, _, ok := readFormBody(w, r)
	if !ok {
		return
	}
	workloadID := strings.TrimSpace(form.Get("workload_id"))
	secret := form.Get("secret")
	if workloadID == "" || secret == "" {
		writeError(w, http.StatusBadRequest, sharederr.New(sharederr.InvalidToken, "workload_id and secret are required"))
		return
	}

	requestID, ok := s.runRequestID(w, r)
	if !ok {
		return
	}
	launchID := launchIDFromHeader(r)

	ctx := r.Context()
	if rateErr := s.checkRateLimit(ctx, "run-manifest", workloadID, "fetch"); rateErr != nil {
		writeError(w, http.StatusTooManyRequests, rateErr)
		return
	}

	workload := s.requireRunAuth(w, r, requestID, launchID, workloadID, secret)
	if workload == nil {
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

	meta := workloadAuditMeta(workload)
	meta["binding_count"] = len(bindings)
	if launchID != "" {
		meta["launch_id"] = launchID
	}
	if auditErr := s.emitRunAudit(requestID, workload.ZoneID, "allow", "complete", meta); auditErr != nil {
		writeError(w, http.StatusInternalServerError, auditErr)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(RunManifestResponse{
		ZoneID:     workload.ZoneID,
		WorkloadID: workload.ID,
		Bindings:   bindings,
	}); err != nil {
		logEvt := s.log.Error().
			Err(err).
			Str("request_id", requestID).
			Str("workload_id", workload.ID)
		if launchID != "" {
			logEvt = logEvt.Str("launch_id", launchID)
		}
		logEvt.Msg("failed to encode run manifest response")
	}
}
