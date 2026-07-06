// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Gateway action audit event construction tests.

package internal

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/garudex-labs/caracal/packages/core/go/audit"
)

func TestResultClassBuckets(t *testing.T) {
	cases := map[int]string{
		200: "success",
		204: "success",
		301: "redirect",
		404: "client_error",
		500: "server_error",
		503: "server_error",
		0:   "unknown",
		42:  "unknown",
	}
	for status, want := range cases {
		if got := resultClass(status); got != want {
			t.Errorf("resultClass(%d) = %q, want %q", status, got, want)
		}
	}
}

func TestGatewayActionEventCarriesForensicMetadata(t *testing.T) {
	event, err := gatewayActionEvent(gatewayAuditInput{
		RequestID:          "req-1",
		ZoneID:             "zone-1",
		ApplicationID:      "app-1",
		Resource:           "resource://nucleus",
		SubjectFingerprint: "fp-1",
		Method:             "POST",
		UpstreamHost:       "api.pipernet.example",
		AuthMode:           "provider_oauth",
		ProviderID:         "provider-1",
		ConnectionID:       "grant-1",
		GatewayStatus:      200,
		UpstreamStatus:     502,
		Latency:            1500 * time.Millisecond,
		ResponseBytes:      64,
		RevocationHit:      true,
		EvaluationStatus:   "complete",
		ErrorKind:          "upstream_error",
	})
	if err != nil {
		t.Fatal(err)
	}
	if event.EventType != gatewayResourceRequestEvent || event.RequestID != "req-1" || event.ZoneID != "zone-1" {
		t.Fatalf("unexpected event envelope %#v", event)
	}
	var meta map[string]any
	if err := json.Unmarshal(event.MetadataJSON, &meta); err != nil {
		t.Fatal(err)
	}
	if meta["upstream_status"] != float64(502) || meta["result_class"] != "server_error" {
		t.Fatalf("upstream result metadata missing: %#v", meta)
	}
	if meta["revocation_interrupted"] != true || meta["error_kind"] != "upstream_error" {
		t.Fatalf("failure metadata missing: %#v", meta)
	}
	if meta["upstream_host"] != "api.pipernet.example" || meta["auth_mode"] != "provider_oauth" || meta["provider_id"] != "provider-1" || meta["connection_id"] != "grant-1" {
		t.Fatalf("upstream identity metadata missing: %#v", meta)
	}
	if meta["latency_ms"] != float64(1500) || meta["response_bytes"] != float64(64) {
		t.Fatalf("size and latency metadata missing: %#v", meta)
	}
}

func TestGatewayActionEventOmitsOptionalFields(t *testing.T) {
	event, err := gatewayActionEvent(gatewayAuditInput{
		RequestID:     "req-1",
		ZoneID:        "zone-1",
		ResponseBytes: -1,
	})
	if err != nil {
		t.Fatal(err)
	}
	var meta map[string]any
	if err := json.Unmarshal(event.MetadataJSON, &meta); err != nil {
		t.Fatal(err)
	}
	for _, absent := range []string{"upstream_host", "auth_mode", "provider_id", "connection_id", "upstream_status", "result_class", "response_bytes", "revocation_interrupted", "error_kind"} {
		if _, ok := meta[absent]; ok {
			t.Errorf("metadata key %q must be omitted when unset", absent)
		}
	}
}

type recordingEmitter struct {
	events []audit.Event
}

func (r *recordingEmitter) Emit(event audit.Event) {
	r.events = append(r.events, event)
}

func TestEmitGatewayActionAuditPaths(t *testing.T) {
	logged := errors.New("unset")
	logEvent := func(err error) { logged = err }

	emitGatewayActionAudit(nil, logEvent, gatewayAuditInput{RequestID: "req-1"})
	if logged.Error() != "unset" {
		t.Fatal("nil emitter must be a silent no-op")
	}

	emitter := &recordingEmitter{}
	emitGatewayActionAudit(emitter, logEvent, gatewayAuditInput{RequestID: "req-1", ZoneID: "zone-1"})
	if len(emitter.events) != 1 || emitter.events[0].RequestID != "req-1" {
		t.Fatalf("expected one emitted event, got %#v", emitter.events)
	}
}
