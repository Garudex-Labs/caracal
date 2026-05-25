// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Interoperability contract tests for shared JSON fixtures.

package interoperability_test

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/packages/core/go/crypto"
)

type jwtClaims struct {
	Iss        string   `json:"iss"`
	Sub        string   `json:"sub"`
	Aud        string   `json:"aud"`
	ZoneID     string   `json:"zone_id"`
	ClientID   string   `json:"client_id"`
	Sid        string   `json:"sid"`
	RootSid    string   `json:"root_sid"`
	Use        string   `json:"use"`
	SubType    string   `json:"sub_type"`
	Target     []string `json:"target"`
	HopCount   int      `json:"hop_count"`
	GraphEpoch int64    `json:"delegation_graph_epoch"`
}

func fixturePath(t *testing.T, name string) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test path")
	}
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "shared", "fixtures", "interoperability", name)
}

func readFixture[T any](t *testing.T, name string) T {
	t.Helper()
	var out T
	data, err := os.ReadFile(fixturePath(t, name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("decode fixture %s: %v", name, err)
	}
	return out
}

func TestJWTClaimsFixturePreservesVerifierContract(t *testing.T) {
	claims := readFixture[jwtClaims](t, "jwt-claims.resource.valid.json")

	if claims.Iss == "" || claims.Sub == "" || claims.Aud == "" {
		t.Fatalf("missing registered claims: %#v", claims)
	}
	if claims.ZoneID == "" || claims.ClientID == "" || claims.Sid == "" || claims.RootSid == "" {
		t.Fatalf("missing authority anchors: %#v", claims)
	}
	if claims.Use != "resource" || claims.SubType != "user" {
		t.Fatalf("unexpected token class: use=%q sub_type=%q", claims.Use, claims.SubType)
	}
	if len(claims.Target) != 1 || claims.Target[0] != claims.Aud {
		t.Fatalf("target must include the protected audience: %#v", claims.Target)
	}
	if claims.HopCount < 0 || claims.GraphEpoch < 0 {
		t.Fatalf("delegation counters must be non-negative: %#v", claims)
	}
}

func TestTraceContextFixtureUsesW3CHeaders(t *testing.T) {
	headers := readFixture[map[string]string](t, "trace-context.headers.valid.json")

	if !strings.HasPrefix(headers["traceparent"], "00-") || len(headers["traceparent"]) != 55 {
		t.Fatalf("invalid traceparent fixture: %q", headers["traceparent"])
	}
	if !strings.Contains(headers["baggage"], "caracal.agent_session=") || !strings.Contains(headers["baggage"], "caracal.hop=1") {
		t.Fatalf("missing registered Caracal baggage keys: %q", headers["baggage"])
	}
	if headers["tracestate"] == "" {
		t.Fatal("tracestate fixture must be present for propagation conformance")
	}
}

func TestGatewayManifestFixtureDeclaresEnforcementRequirements(t *testing.T) {
	manifest := readFixture[map[string]any](t, "gateway-upstream-manifest.http.valid.json")

	if manifest["schema_version"] != "2026-05-21" || manifest["resource_identifier"] != "resource://api" {
		t.Fatalf("unexpected manifest identity: %#v", manifest)
	}
	audit, ok := manifest["audit"].(map[string]any)
	if !ok || audit["action_result_required"] != true {
		t.Fatalf("gateway-compatible upstreams must declare action-result audit: %#v", manifest["audit"])
	}
}

func TestProviderPluginManifestKeepsCredentialsGatewayOnly(t *testing.T) {
	manifest := readFixture[map[string]any](t, "provider-credential-plugin-manifest.valid.json")
	execution, ok := manifest["execution"].(map[string]any)
	if !ok {
		t.Fatalf("missing execution contract: %#v", manifest)
	}
	if execution["credential_exposure"] != "gateway_only" {
		t.Fatalf("provider plugins must not expose credentials to agents: %#v", execution)
	}
}

func TestAgentConnectorManifestLabelsEnforcement(t *testing.T) {
	manifest := readFixture[map[string]any](t, "agent-connector-manifest.valid.json")
	audit, ok := manifest["audit"].(map[string]any)
	if !ok || audit["labels_enforcement_mode"] != true {
		t.Fatalf("agent connectors must label enforcement mode: %#v", manifest["audit"])
	}
}

func TestStreamSigCanonicalizeVectors(t *testing.T) {
	type vector struct {
		Description       string         `json:"description"`
		Stream            string         `json:"stream"`
		Values            map[string]any `json:"values"`
		ExpectedCanonical string         `json:"expected_canonical"`
		HmacKeyHex        string         `json:"hmac_key_hex"`
		ExpectedSigHex    string         `json:"expected_sig_hex"`
	}

	vectors := readFixture[[]vector](t, "stream-sig-canonicalize.vectors.json")

	for _, v := range vectors {
		t.Run(v.Description, func(t *testing.T) {
			got := string(crypto.CanonicalizeStream(v.Stream, v.Values))
			if got != v.ExpectedCanonical {
				t.Fatalf("canonical mismatch:\ngot:  %q\nwant: %q", got, v.ExpectedCanonical)
			}

			key, err := hex.DecodeString(v.HmacKeyHex)
			if err != nil {
				t.Fatalf("bad hmac key hex: %v", err)
			}
			sig := crypto.SignStream(key, v.Stream, v.Values)
			if sig != v.ExpectedSigHex {
				t.Fatalf("sig mismatch:\ngot:  %s\nwant: %s", sig, v.ExpectedSigHex)
			}
		})
	}
}

