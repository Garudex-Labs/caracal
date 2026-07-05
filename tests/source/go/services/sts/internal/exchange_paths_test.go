// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for exchange helpers: delegation TTLs, agent session liveness, Control traits, and provider value validators.

package internal

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestEffectiveTokenTTLDelegationBounds(t *testing.T) {
	now := time.Now()
	edge := func(expiresIn time.Duration) *DelegationEdge {
		return &DelegationEdge{ID: "edge-1", ExpiresAt: now.Add(expiresIn)}
	}

	if ttl, err := effectiveTokenTTL(time.Minute, nil, now); err != nil || ttl != time.Minute {
		t.Fatalf("nil proof must pass through, ttl=%v err=%v", ttl, err)
	}
	if _, err := effectiveTokenTTL(time.Minute, &delegationProof{edge: edge(-time.Second)}, now); err == nil {
		t.Fatal("expired edge must fail")
	}
	if ttl, err := effectiveTokenTTL(time.Hour, &delegationProof{edge: edge(time.Minute)}, now); err != nil || ttl != time.Minute {
		t.Fatalf("edge expiry must cap ttl, ttl=%v err=%v", ttl, err)
	}
	proof := &delegationProof{edge: edge(time.Hour), constraints: delegationConstraints{TTLSeconds: 30}}
	if ttl, err := effectiveTokenTTL(time.Hour, proof, now); err != nil || ttl != 30*time.Second {
		t.Fatalf("constraint ttl must cap, ttl=%v err=%v", ttl, err)
	}
	proof = &delegationProof{edge: edge(time.Hour), constraints: delegationConstraints{ExpiresAt: "not-a-time"}}
	if _, err := effectiveTokenTTL(time.Hour, proof, now); err == nil {
		t.Fatal("invalid constraint expiry must fail")
	}
	proof = &delegationProof{edge: edge(time.Hour), constraints: delegationConstraints{ExpiresAt: now.Add(-time.Minute).Format(time.RFC3339)}}
	if _, err := effectiveTokenTTL(time.Hour, proof, now); err == nil {
		t.Fatal("past constraint expiry must fail")
	}
	proof = &delegationProof{edge: edge(time.Hour), constraints: delegationConstraints{ExpiresAt: now.Add(45 * time.Second).Format(time.RFC3339)}}
	ttl, err := effectiveTokenTTL(time.Hour, proof, now)
	if err != nil || ttl > 46*time.Second || ttl <= 0 {
		t.Fatalf("constraint expiry must cap ttl, ttl=%v err=%v", ttl, err)
	}
}

func TestActiveAgentSessionLifecycles(t *testing.T) {
	now := time.Now()
	heartbeat := now.Add(time.Minute)
	stale := now.Add(-time.Minute)
	cases := map[string]struct {
		session *AgentSession
		want    bool
	}{
		"nil session":          {nil, false},
		"wrong zone":           {&AgentSession{ZoneID: "other", Status: "active"}, false},
		"inactive status":      {&AgentSession{ZoneID: "zone1", Status: "revoked"}, false},
		"service without beat": {&AgentSession{ZoneID: "zone1", Status: "active", Lifecycle: "service"}, false},
		"service stale beat":   {&AgentSession{ZoneID: "zone1", Status: "active", Lifecycle: "service", HeartbeatDeadlineAt: &stale}, false},
		"service live beat":    {&AgentSession{ZoneID: "zone1", Status: "active", Lifecycle: "service", HeartbeatDeadlineAt: &heartbeat}, true},
		"task without ttl":     {&AgentSession{ZoneID: "zone1", Status: "active", Lifecycle: "task"}, false},
		"task expired ttl":     {&AgentSession{ZoneID: "zone1", Status: "active", Lifecycle: "task", SpawnedAt: now.Add(-time.Hour), TTLSeconds: 60}, false},
		"task live ttl":        {&AgentSession{ZoneID: "zone1", Status: "active", Lifecycle: "task", SpawnedAt: now, TTLSeconds: 600}, true},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if got := activeAgentSession(tc.session, "zone1", now); got != tc.want {
				t.Fatalf("activeAgentSession = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestControlTraitHelpers(t *testing.T) {
	if got := controlMaxTTL(&Application{Traits: []string{controlMaxTTLTrait + "60"}}); got != 60 {
		t.Fatalf("max ttl = %d", got)
	}
	if got := controlMaxTTL(&Application{Traits: []string{controlMaxTTLTrait + "abc", controlMaxTTLTrait + "-1"}}); got != 0 {
		t.Fatalf("invalid max ttl traits must be ignored, got %d", got)
	}
	if got := controlMaxTTL(&Application{Traits: []string{controlInvokeTrait}}); got != 0 {
		t.Fatalf("absent max ttl trait must be zero, got %d", got)
	}

	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	if !controlExpired(&Application{Traits: []string{controlExpiresTrait + "2025-01-01T00:00:00Z"}}, now) {
		t.Fatal("past expiry trait must expire the key")
	}
	if controlExpired(&Application{Traits: []string{controlExpiresTrait + "2027-01-01T00:00:00Z"}}, now) {
		t.Fatal("future expiry trait must keep the key live")
	}
	if controlExpired(&Application{Traits: []string{controlExpiresTrait + "not-a-time"}}, now) {
		t.Fatal("unparseable expiry trait must not expire the key")
	}
	if controlExpired(&Application{Traits: []string{controlInvokeTrait}}, now) {
		t.Fatal("absent expiry trait must not expire the key")
	}
}

func TestControlAudienceOverride(t *testing.T) {
	t.Setenv("CONTROL_AUDIENCE", "")
	if got := controlAudience(); got != defaultControlAudience {
		t.Fatalf("default audience = %q", got)
	}
	t.Setenv("CONTROL_AUDIENCE", "hooli-control")
	if got := controlAudience(); got != "hooli-control" {
		t.Fatalf("override audience = %q", got)
	}
}

func TestIsZoneDerivedControlTokenRequest(t *testing.T) {
	valid := TokenExchangeRequest{
		Resources: []string{defaultControlAudience},
		Scope:     "control:agent:read control:zone:read",
	}
	if !isZoneDerivedControlTokenRequest(valid) {
		t.Fatal("control-audience request with control scopes must qualify")
	}
	cases := map[string]TokenExchangeRequest{
		"subject token":     {SubjectToken: "x", Resources: valid.Resources, Scope: valid.Scope},
		"session reference": {SessionID: "s", Resources: valid.Resources, Scope: valid.Scope},
		"no resources":      {Scope: valid.Scope},
		"foreign resource":  {Resources: []string{"resource://pipernet"}, Scope: valid.Scope},
		"no scopes":         {Resources: valid.Resources},
		"non-control scope": {Resources: valid.Resources, Scope: "pipernet:read"},
	}
	for name, req := range cases {
		t.Run(name, func(t *testing.T) {
			if isZoneDerivedControlTokenRequest(req) {
				t.Fatal("request must not qualify as zone-derived control exchange")
			}
		})
	}
}

func TestZoneMismatchErrorText(t *testing.T) {
	err := &zoneMismatchError{requested: "zone-req", actual: "zone-act"}
	if msg := err.Error(); msg != "application registered in zone zone-act, not requested zone zone-req" {
		t.Fatalf("message = %q", msg)
	}
}

func TestDetectZoneMismatchBranches(t *testing.T) {
	hash, err := hashClientSecret("piper-secret")
	if err != nil {
		t.Fatal(err)
	}
	request := TokenExchangeRequest{ClientSecret: "piper-secret"}
	otherZoneApp := &Application{ID: "app1", ZoneID: "zone-actual", ClientSecretHash: &hash}

	gatewaySrv := &Server{db: &stubDB{appGlobal: otherZoneApp}}
	if got := gatewaySrv.detectZoneMismatch(context.Background(), TokenExchangeRequest{GatewayAuthenticated: true}, "app1", "zone-requested"); got != nil {
		t.Fatalf("gateway exchange must not disclose zone mismatch, got %v", got)
	}
	lookupFail := &Server{db: &stubDB{appGlobalErr: errors.New("not found")}}
	if got := lookupFail.detectZoneMismatch(context.Background(), request, "app1", "zone-requested"); got != nil {
		t.Fatalf("missing application must stay hidden, got %v", got)
	}
	sameZone := &Server{db: &stubDB{appGlobal: &Application{ID: "app1", ZoneID: "zone-requested", ClientSecretHash: &hash}}}
	if got := sameZone.detectZoneMismatch(context.Background(), request, "app1", "zone-requested"); got != nil {
		t.Fatalf("same-zone application is not a mismatch, got %v", got)
	}
	noHash := &Server{db: &stubDB{appGlobal: &Application{ID: "app1", ZoneID: "zone-actual"}}}
	if got := noHash.detectZoneMismatch(context.Background(), request, "app1", "zone-requested"); got != nil {
		t.Fatalf("application without secret hash must stay hidden, got %v", got)
	}
	wrongSecret := &Server{db: &stubDB{appGlobal: otherZoneApp}}
	if got := wrongSecret.detectZoneMismatch(context.Background(), TokenExchangeRequest{ClientSecret: "wrong"}, "app1", "zone-requested"); got != nil {
		t.Fatalf("wrong secret must stay hidden, got %v", got)
	}
	if got := wrongSecret.detectZoneMismatch(context.Background(), request, "app1", "zone-requested"); got == nil {
		t.Fatal("proven possession across zones must surface the mismatch")
	}
}

func TestMintScopeAndMandateScopes(t *testing.T) {
	claims := map[string]any{"scope": "pipernet:read hooli:write"}
	if got := mintScope(TokenExchangeRequest{Scope: "explicit"}, claims); got != "explicit" {
		t.Fatalf("explicit scope must win, got %q", got)
	}
	if got := mintScope(TokenExchangeRequest{GatewayAuthenticated: true}, claims); got != "pipernet:read hooli:write" {
		t.Fatalf("gateway re-exchange must inherit mandate scope, got %q", got)
	}
	if got := mintScope(TokenExchangeRequest{}, claims); got != "" {
		t.Fatalf("public exchange without scope mints none, got %q", got)
	}
	scopes := mandateScopeSet(claims)
	if _, ok := scopes["pipernet:read"]; !ok || len(scopes) != 2 {
		t.Fatalf("mandate scope set = %v", scopes)
	}
	if got := mandateScopeSet(nil); len(got) != 0 {
		t.Fatalf("absent claims must produce empty set, got %v", got)
	}
}

func TestStepUpAuditMetaOptionalFields(t *testing.T) {
	base := &StepUpChallengePG{ID: "c1", Tier: "money", ApproverClass: ApproverClassOperator, PrivacyMode: PrivacyIdentified, ResourceSetHash: []byte{0xaa}}
	meta := stepUpAuditMeta(base)
	if meta["challenge_id"] != "c1" || meta["binding"] != "aa" {
		t.Fatalf("meta = %#v", meta)
	}
	if _, ok := meta["application_id"]; ok {
		t.Fatal("empty application id must be omitted")
	}
	if _, ok := meta["session_id"]; ok {
		t.Fatal("empty session id must be omitted")
	}
	base.ApplicationID = "app1"
	base.SessionID = "sess-1"
	meta = stepUpAuditMeta(base)
	if meta["application_id"] != "app1" || meta["session_id"] != "sess-1" {
		t.Fatalf("populated meta = %#v", meta)
	}
}

func TestAgentSessionHelperNilSafety(t *testing.T) {
	if agentSessionLifecycle(nil) != "" {
		t.Fatal("nil session lifecycle must be empty")
	}
	if agentSessionLabels(nil) != nil || agentSessionLabels(&AgentSession{}) != nil {
		t.Fatal("absent labels must be nil")
	}
	if agentAuditMeta(nil) != nil {
		t.Fatal("nil session audit meta must be nil")
	}
	parent := "agent-parent"
	meta := agentAuditMeta(&AgentSession{Lifecycle: "task", ParentID: &parent, Depth: 2})
	if meta["agent_parent_id"] != "agent-parent" || meta["agent_depth"] != 2 {
		t.Fatalf("meta = %#v", meta)
	}
}

func TestProviderValueValidators(t *testing.T) {
	hostCases := map[string]bool{
		"api.pipernet.example": true,
		"":                     false,
		"a..b":                 false,
		"-lead.example":        false,
		"trail.example-":       false,
		"über.example":         false,
		"under_score.example":  false,
	}
	for host, want := range hostCases {
		if got := validProviderHost(host); got != want {
			t.Errorf("validProviderHost(%q) = %v, want %v", host, got, want)
		}
	}
	if validProviderHost(strings.Repeat("a", 260)) {
		t.Error("overlong host must be invalid")
	}

	schemeCases := map[string]bool{
		"Bearer":  true,
		"ApiKey1": true,
		"x-token": true,
		"":        false,
		"1Bearer": false,
		"Bea rer": false,
		"Beär":    false,
	}
	for scheme, want := range schemeCases {
		if got := validProviderAuthScheme(scheme); got != want {
			t.Errorf("validProviderAuthScheme(%q) = %v, want %v", scheme, got, want)
		}
	}

	queryCases := map[string]bool{
		"api_key": true,
		"key-1.x": true,
		"":        false,
		"a$b":     false,
		"ké":      false,
	}
	for name, want := range queryCases {
		if got := validProviderQueryParamName(name); got != want {
			t.Errorf("validProviderQueryParamName(%q) = %v, want %v", name, got, want)
		}
	}

	if hosts, err := normalizedProviderHosts(nil); err != nil || hosts != nil {
		t.Errorf("empty host list must normalize to nil, got %v err=%v", hosts, err)
	}
	hosts, err := normalizedProviderHosts([]string{" API.Pipernet.Example "})
	if err != nil || len(hosts) != 1 || hosts[0] != "api.pipernet.example" {
		t.Errorf("hosts = %v err=%v", hosts, err)
	}
	if _, err := normalizedProviderHosts([]string{"bad..host"}); err == nil {
		t.Error("invalid host must fail normalization")
	}
}
