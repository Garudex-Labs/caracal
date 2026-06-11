/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Offline tests for the provider preflight check functions and orchestrator, with network, DNS, and control-plane responses injected.
*/

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkApiReady,
  checkApplication,
  checkBinding,
  checkCallbackReachable,
  checkGatewayReady,
  checkPolicyDecision,
  checkProviderConfig,
  checkRuntimeInjection,
  checkScopeCoverage,
  checkTokenEndpointHost,
  checkUpstreamReachable,
  isPrivateAddress,
  runProviderPreflight,
} from "../preflight.mjs";

const reachable = async () => ({ reachable: true, detail: "tcp ok" });
const unreachable = async () => ({ reachable: false, detail: "ECONNREFUSED" });
const publicDns = async () => ["93.184.216.34"];
const privateDns = async () => ["10.1.2.3"];

test("isPrivateAddress classifies ranges", () => {
  assert.equal(isPrivateAddress("10.0.0.1"), true);
  assert.equal(isPrivateAddress("192.168.1.1"), true);
  assert.equal(isPrivateAddress("172.16.0.1"), true);
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("::1"), true);
  assert.equal(isPrivateAddress("93.184.216.34"), false);
});

test("api readiness fails on transport errors and non-200", () => {
  assert.equal(checkApiReady({ error: "fetch failed" }).status, "fail");
  assert.equal(checkApiReady({ status: 503, body: { ok: false } }).status, "fail");
  assert.equal(checkApiReady({ status: 200, body: { ok: true } }).status, "ok");
});

test("gateway readiness maps dependency reasons to remediation", () => {
  assert.equal(checkGatewayReady(undefined).status, "warn");
  assert.equal(checkGatewayReady({ error: "fetch failed" }).status, "fail");
  const stale = checkGatewayReady({ status: 503, body: { ok: false, ready: false, reason: "sts_unreachable" } });
  assert.equal(stale.status, "fail");
  assert.match(stale.remediation, /STS/);
  assert.equal(checkGatewayReady({ status: 200, body: { ok: true, ready: true } }).status, "ok");
});

test("binding requires a credential provider", () => {
  assert.equal(checkBinding(undefined, undefined).status, "fail");
  assert.equal(checkBinding({ identifier: "resource://x" }, undefined).status, "fail");
  const resource = { credential_provider_id: "p1", gateway_application_id: "app1" };
  const provider = { identifier: "provider://x", kind: "api_key" };
  assert.equal(checkBinding(resource, provider).status, "ok");
});

test("binding warns without a gateway application", () => {
  const resource = { credential_provider_id: "p1", identifier: "resource://x" };
  const provider = { identifier: "provider://x", kind: "api_key" };
  assert.equal(checkBinding(resource, provider).status, "warn");
});

test("application check validates existence, expiry, and binding match", () => {
  const now = new Date("2026-06-10T00:00:00Z");
  assert.equal(checkApplication(undefined, undefined, now).status, "fail");
  const managed = { id: "app1", name: "pied-piper", registration_method: "managed", expires_at: null };
  assert.equal(checkApplication(managed, { gateway_application_id: "app1" }, now).status, "ok");
  const expired = { ...managed, registration_method: "dcr", expires_at: "2026-06-09T00:00:00Z" };
  assert.equal(checkApplication(expired, undefined, now).status, "fail");
  const expiring = { ...managed, registration_method: "dcr", expires_at: "2026-06-10T12:00:00Z" };
  assert.equal(checkApplication(expiring, undefined, now).status, "warn");
  const mismatch = checkApplication(managed, { gateway_application_id: "app2" }, now);
  assert.equal(mismatch.status, "warn");
});

test("provider config requires kind-specific fields", () => {
  assert.equal(checkProviderConfig(undefined).status, "fail");
  const bare = { identifier: "provider://x", kind: "oauth2_client_credentials", config_json: {} };
  const missing = checkProviderConfig(bare);
  assert.equal(missing.status, "fail");
  assert.match(missing.detail, /token_endpoint/);
  const complete = {
    identifier: "provider://x",
    kind: "oauth2_client_credentials",
    config_json: { token_endpoint: "https://oauth.example.com/token", client_id: "abc" },
  };
  assert.equal(checkProviderConfig(complete).status, "ok");
});

test("provider config enforces allowed_token_hosts coverage", () => {
  const provider = {
    identifier: "provider://x",
    kind: "oauth2_client_credentials",
    config_json: {
      token_endpoint: "https://oauth.example.com/token",
      client_id: "abc",
      allowed_token_hosts: ["other.example.com"],
    },
  };
  assert.equal(checkProviderConfig(provider).status, "fail");
  provider.config_json.allowed_token_hosts = ["oauth.example.com"];
  assert.equal(checkProviderConfig(provider).status, "ok");
});

test("provider config validates api_key injection location", () => {
  const headerKind = { identifier: "provider://k", kind: "api_key", config_json: { auth_location: "header" } };
  assert.equal(checkProviderConfig(headerKind).status, "fail");
  headerKind.config_json.header_name = "X-Api-Key";
  assert.equal(checkProviderConfig(headerKind).status, "ok");
});

test("scope coverage requires requested scopes to be declared", () => {
  const resource = { scopes: ["pipernet:read", "pipernet:write"] };
  assert.equal(checkScopeCoverage(resource, []).status, "warn");
  assert.equal(checkScopeCoverage(resource, ["pipernet:read"]).status, "ok");
  const uncovered = checkScopeCoverage(resource, ["pipernet:admin"]);
  assert.equal(uncovered.status, "fail");
  assert.match(uncovered.detail, /pipernet:admin/);
});

test("token endpoint host rejects private resolution", async () => {
  const provider = { kind: "oauth2_client_credentials", config_json: { token_endpoint: "https://oauth.example.com/token" } };
  assert.equal((await checkTokenEndpointHost(provider, privateDns)).status, "fail");
  assert.equal((await checkTokenEndpointHost(provider, publicDns)).status, "ok");
});

test("token endpoint host skips non-oauth providers", async () => {
  const provider = { kind: "api_key", config_json: {} };
  assert.equal((await checkTokenEndpointHost(provider, privateDns)).status, "ok");
});

test("callback reachability needs https and a reachable origin", async () => {
  const httpProvider = { kind: "oauth2_authorization_code", config_json: { redirect_uri: "http://cb.example.com/cb" } };
  assert.equal((await checkCallbackReachable(httpProvider, reachable)).status, "fail");
  const httpsProvider = { kind: "oauth2_authorization_code", config_json: { redirect_uri: "https://cb.example.com/cb" } };
  assert.equal((await checkCallbackReachable(httpsProvider, reachable)).status, "ok");
  assert.equal((await checkCallbackReachable(httpsProvider, unreachable)).status, "fail");
});

test("upstream reachability warns when no upstream is set", async () => {
  assert.equal((await checkUpstreamReachable({}, reachable, publicDns)).status, "warn");
  assert.equal((await checkUpstreamReachable({ upstream_url: "https://api.example.com" }, reachable, publicDns)).status, "ok");
  assert.equal((await checkUpstreamReachable({ upstream_url: "https://api.example.com" }, unreachable, publicDns)).status, "fail");
});

test("upstream reachability warns on private resolution", async () => {
  const result = await checkUpstreamReachable({ upstream_url: "https://internal.example.com" }, reachable, privateDns);
  assert.equal(result.status, "warn");
  assert.match(result.remediation, /private/);
});

test("runtime injection enforces the provider flag", () => {
  const provider = { identifier: "provider://x", config_json: { allow_runtime_injection: true } };
  assert.equal(checkRuntimeInjection(provider, true).status, "ok");
  assert.equal(checkRuntimeInjection({ identifier: "provider://y", config_json: {} }, true).status, "fail");
  assert.equal(checkRuntimeInjection(provider, false).status, "ok");
});

test("policy decision distinguishes missing set, rejected input, and unavailable execution", () => {
  assert.equal(checkPolicyDecision(undefined).status, "fail");
  const rejected = checkPolicyDecision({ warnings: ["missing_action"], result: null });
  assert.equal(rejected.status, "fail");
  assert.match(rejected.detail, /missing_action/);
  const unexecuted = checkPolicyDecision({ warnings: [], explanation: { reason: "STS simulation is not configured" }, result: null });
  assert.equal(unexecuted.status, "fail");
  assert.match(unexecuted.detail, /not executed/);
  assert.equal(checkPolicyDecision({ warnings: [], result: { decision: "allow", evaluation_status: "ok" } }).status, "ok");
  assert.equal(checkPolicyDecision({ warnings: [], result: { decision: "deny", evaluation_status: "ok" } }).status, "fail");
});

const healthyInput = () => ({
  apiProbe: { status: 200, body: { ok: true } },
  gatewayProbe: { status: 200, body: { ok: true, ready: true } },
  resource: {
    id: "r1",
    identifier: "resource://pipernet",
    scopes: ["pipernet:read", "pipernet:write"],
    credential_provider_id: "p1",
    gateway_application_id: "app1",
    upstream_url: "https://api.example.com",
  },
  provider: {
    identifier: "provider://hooli-oauth",
    kind: "oauth2_client_credentials",
    config_json: {
      token_endpoint: "https://oauth.example.com/token",
      client_id: "abc",
      allow_runtime_injection: true,
    },
  },
  application: { id: "app1", name: "pied-piper", registration_method: "managed", expires_at: null },
  requestedScopes: ["pipernet:read"],
  requireInjection: true,
  resolveHost: publicDns,
  probeOrigin: reachable,
  simulation: { warnings: [], result: { decision: "allow", evaluation_status: "ok" } },
});

test("runProviderPreflight passes a fully healthy setup", async () => {
  const report = await runProviderPreflight(healthyInput());
  assert.equal(report.passed, true);
  assert.equal(report.summary.fail, 0);
  assert.equal(report.summary.total, report.checks.length);
});

test("runProviderPreflight fails closed on any failing check", async () => {
  const denied = await runProviderPreflight({
    ...healthyInput(),
    simulation: { warnings: [], result: { decision: "deny", evaluation_status: "ok" } },
  });
  assert.equal(denied.passed, false);
  assert.equal(denied.summary.fail, 1);

  const offline = await runProviderPreflight({ ...healthyInput(), apiProbe: { error: "fetch failed" } });
  assert.equal(offline.passed, false);
});
