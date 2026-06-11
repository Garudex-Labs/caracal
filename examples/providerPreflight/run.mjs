/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

CLI entry that gathers live state from the Caracal Admin API, Gateway, DNS, and TCP probes, runs the provider preflight checks, and reports a phased, remediation-oriented readiness verdict.
*/

import { resolve4, resolve6 } from "node:dns/promises";
import { connect } from "node:net";
import { PHASES, runProviderPreflight } from "./preflight.mjs";

const PROBE_TIMEOUT_MS = 5000;

function env(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

async function adminGet(apiUrl, token, path) {
  const res = await fetch(`${apiUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function adminPost(apiUrl, token, path, body) {
  const res = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function probeReady(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/ready`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const body = await res.json().catch(() => undefined);
    return { status: res.status, body };
  } catch (err) {
    return { error: err.message };
  }
}

async function resolveHost(host) {
  const results = await Promise.allSettled([resolve4(host), resolve6(host)]);
  const addresses = [];
  for (const r of results) if (r.status === "fulfilled") addresses.push(...r.value);
  return addresses;
}

function probeOrigin(origin) {
  return new Promise((resolveProbe) => {
    let host;
    let port;
    try {
      const url = new URL(origin);
      host = url.hostname;
      port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    } catch (err) {
      resolveProbe({ reachable: false, detail: err.message });
      return;
    }
    const socket = connect({ host, port, timeout: PROBE_TIMEOUT_MS });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(result);
    };
    socket.on("connect", () => finish({ reachable: true, detail: `tcp ${host}:${port}` }));
    socket.on("error", (err) => finish({ reachable: false, detail: err.message }));
    socket.on("timeout", () => finish({ reachable: false, detail: `timeout after ${PROBE_TIMEOUT_MS}ms` }));
  });
}

// Mirrors the OPA input STS builds for a real token exchange, so the simulated
// decision is the decision the Gateway request will actually receive.
function policyInput(zoneId, applicationId, resource, requestedScopes) {
  return {
    principal: { type: "Application", id: applicationId, zone_id: zoneId },
    resource: { type: "Resource", id: resource.id, identifier: resource.identifier, scopes: resource.scopes ?? [] },
    action: { id: "TokenExchange" },
    context: { actor_claims: {}, challenge_resolved: false, requested_scopes: requestedScopes },
  };
}

async function loadSimulation(apiUrl, token, zoneId, resource, applicationId, requestedScopes) {
  const sets = await adminGet(apiUrl, token, `/v1/zones/${zoneId}/policy-sets`);
  const active = (sets ?? []).find((s) => s.active_version_id);
  if (!active) return undefined;
  return adminPost(apiUrl, token, `/v1/zones/${zoneId}/policy-sets/${active.id}/simulate`, {
    version_id: active.active_version_id,
    input: policyInput(zoneId, applicationId, resource, requestedScopes),
  });
}

function printReport(report) {
  const marks = { ok: "PASS", warn: "WARN", fail: "FAIL" };
  for (const phase of PHASES) {
    const phaseChecks = report.checks.filter((c) => c.phase === phase);
    if (phaseChecks.length === 0) continue;
    process.stdout.write(`\n== ${phase} ==\n`);
    for (const c of phaseChecks) {
      process.stdout.write(`[${marks[c.status]}] ${c.id}: ${c.detail}\n`);
      if (c.remediation) process.stdout.write(`       fix: ${c.remediation}\n`);
    }
  }
  const { ok, warn, fail, total } = report.summary;
  process.stdout.write(`\n${ok}/${total} ok, ${warn} warn, ${fail} fail\n`);
  process.stdout.write(report.passed
    ? "Preflight passed: the resource is ready for its first Gateway request.\n"
    : "Preflight failed: resolve the FAIL items above before sending Gateway traffic.\n");
}

async function main() {
  const apiUrl = env("CARACAL_API_URL", "http://127.0.0.1:3000").replace(/\/$/, "");
  const token = env("CARACAL_ADMIN_TOKEN");
  const zoneId = env("PREFLIGHT_ZONE_ID");
  const resourceId = env("PREFLIGHT_RESOURCE_ID");
  const applicationId = env("PREFLIGHT_APPLICATION_ID");
  const gatewayUrl = process.env.PREFLIGHT_GATEWAY_URL?.replace(/\/$/, "");
  const requestedScopes = env("PREFLIGHT_SCOPES", "").split(",").map((s) => s.trim()).filter(Boolean);
  const requireInjection = process.env.PREFLIGHT_REQUIRE_RUNTIME_INJECTION === "true";

  const apiProbe = await probeReady(apiUrl);
  const gatewayProbe = gatewayUrl ? await probeReady(gatewayUrl) : undefined;

  let resource;
  let provider;
  let application;
  let simulation;
  if (!apiProbe.error) {
    resource = await adminGet(apiUrl, token, `/v1/zones/${zoneId}/resources/${resourceId}`);
    provider = resource?.credential_provider_id
      ? await adminGet(apiUrl, token, `/v1/zones/${zoneId}/providers/${resource.credential_provider_id}`)
      : undefined;
    application = await adminGet(apiUrl, token, `/v1/zones/${zoneId}/applications/${applicationId}`);
    simulation = resource
      ? await loadSimulation(apiUrl, token, zoneId, resource, applicationId, requestedScopes)
      : undefined;
  }

  const report = await runProviderPreflight({
    apiProbe,
    gatewayProbe,
    resource,
    provider,
    application,
    requestedScopes,
    requireInjection,
    resolveHost,
    probeOrigin,
    simulation,
  });

  if (process.env.PREFLIGHT_OUTPUT === "json") {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printReport(report);
  }
  process.exit(report.passed ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`provider preflight error: ${err.message}\n`);
  process.exit(2);
});
