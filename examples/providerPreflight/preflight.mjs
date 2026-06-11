/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Pure preflight check functions that validate control-plane readiness, dependency resolution, provider configuration, network connectivity, and policy authorization for a provider-backed resource before its first Gateway request.
*/

export const PHASES = ["readiness", "dependencies", "configuration", "connectivity", "authorization"];

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
];

export function isPrivateAddress(address) {
  if (!address) return true;
  const lower = address.toLowerCase();
  if (lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80")) return true;
  if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
  return PRIVATE_V4.some((re) => re.test(address));
}

function result(phase, id, status, detail, remediation) {
  return remediation ? { phase, id, status, detail, remediation } : { phase, id, status, detail };
}
const ok = (phase, id, detail) => result(phase, id, "ok", detail);
const warn = (phase, id, detail, remediation) => result(phase, id, "warn", detail, remediation);
const fail = (phase, id, detail, remediation) => result(phase, id, "fail", detail, remediation);

const OAUTH_KINDS = new Set(["oauth2_authorization_code", "oauth2_client_credentials"]);

// --- Phase 1: readiness -------------------------------------------------
// Probes are { status, body } on an HTTP response or { error } on transport failure.

export function checkApiReady(probe) {
  const id = "admin API readiness";
  if (probe.error) {
    return fail("readiness", id, `Admin API unreachable: ${probe.error}`,
      "Verify CARACAL_API_URL and that the API process is running before provisioning traffic.");
  }
  if (probe.status !== 200) {
    return fail("readiness", id, `GET /ready returned ${probe.status}`,
      "The API is up but not ready (database or dependencies unavailable); check API logs before continuing.");
  }
  return ok("readiness", id, "Admin API reports ready");
}

const GATEWAY_READY_REMEDIATION = {
  bindings_unavailable: "Gateway has no routing bindings loaded; confirm it can reach Postgres and that bindings exist.",
  postgres_unreachable: "Gateway cannot reach Postgres; check database connectivity and credentials.",
  redis_unreachable: "Gateway cannot reach Redis; check Redis connectivity (revocation and replay protection depend on it).",
  revocation_snapshot_stale: "Revocation snapshot is stale; verify the revocation snapshot poller and Postgres health.",
  audit_replay_unavailable: "Audit replay backlog is unavailable; check audit sink connectivity.",
  sts_unavailable: "Gateway has no STS configured; set the STS URL in the Gateway configuration.",
  sts_unreachable: "Gateway cannot reach STS; token exchange will fail. Check STS health and network path.",
};

export function checkGatewayReady(probe) {
  const id = "gateway readiness";
  if (!probe) {
    return warn("readiness", id, "Gateway not probed (PREFLIGHT_GATEWAY_URL not set)",
      "Set PREFLIGHT_GATEWAY_URL to validate the Gateway and its dependencies (Postgres, Redis, STS) before traffic.");
  }
  if (probe.error) {
    return fail("readiness", id, `Gateway unreachable: ${probe.error}`,
      "Verify PREFLIGHT_GATEWAY_URL and that the Gateway process is running.");
  }
  if (probe.status !== 200) {
    const reason = probe.body?.reason ?? "unknown";
    return fail("readiness", id, `GET /ready returned ${probe.status} (reason: ${reason})`,
      GATEWAY_READY_REMEDIATION[reason] ?? "Check Gateway logs for the failing dependency.");
  }
  return ok("readiness", id, "Gateway reports ready (bindings, Postgres, Redis, revocations, audit, STS)");
}

// --- Phase 2: dependencies ----------------------------------------------

export function checkBinding(resource, provider) {
  const id = "resource binding";
  if (!resource) {
    return fail("dependencies", id, "resource not found",
      "Verify PREFLIGHT_RESOURCE_ID and PREFLIGHT_ZONE_ID; create the resource if it does not exist.");
  }
  if (!resource.credential_provider_id) {
    return fail("dependencies", id, `resource ${resource.identifier} has no credential provider bound`,
      "Bind exactly one credential provider to the resource so the Gateway can mint upstream credentials.");
  }
  if (!provider) {
    return fail("dependencies", id, `credential_provider_id ${resource.credential_provider_id} does not resolve to a provider`,
      "The bound provider was deleted or lives in another zone; rebind the resource to an existing provider.");
  }
  if (!resource.gateway_application_id) {
    return warn("dependencies", id, `bound to ${provider.identifier} (${provider.kind}) but no gateway application is set`,
      "Set gateway_application_id on the resource; Gateway-mediated routing needs an application identity.");
  }
  return ok("dependencies", id, `bound to ${provider.identifier} (${provider.kind})`);
}

export function checkApplication(application, resource, now = new Date()) {
  const id = "application";
  if (!application) {
    return fail("dependencies", id, "application not found",
      "Verify PREFLIGHT_APPLICATION_ID; register the application before sending Gateway traffic.");
  }
  if (application.expires_at) {
    const expires = new Date(application.expires_at);
    if (expires <= now) {
      return fail("dependencies", id, `application ${application.name} expired at ${application.expires_at}`,
        "Re-register the application (DCR registrations expire); expired identities cannot exchange tokens.");
    }
    const dayMs = 24 * 60 * 60 * 1000;
    if (expires.getTime() - now.getTime() < dayMs) {
      return warn("dependencies", id, `application ${application.name} expires within 24h (${application.expires_at})`,
        "Renew the DCR registration before it expires, or traffic will start failing mid-operation.");
    }
  }
  if (resource?.gateway_application_id && resource.gateway_application_id !== application.id) {
    return warn("dependencies", id, `resource routes to application ${resource.gateway_application_id}, not ${application.id}`,
      "Either update the resource's gateway_application_id or run the preflight for the bound application.");
  }
  return ok("dependencies", id, `application ${application.name} (${application.registration_method}) is valid`);
}

// --- Phase 3: configuration ----------------------------------------------

const KIND_REQUIRED_CONFIG = {
  oauth2_authorization_code: ["authorization_endpoint", "token_endpoint", "redirect_uri", "client_id"],
  oauth2_client_credentials: ["token_endpoint", "client_id"],
};

export function checkProviderConfig(provider) {
  const id = "provider configuration";
  if (!provider) {
    return fail("configuration", id, "no provider to evaluate",
      "Resolve the resource binding failure first.");
  }
  const config = provider.config_json ?? {};
  const missing = (KIND_REQUIRED_CONFIG[provider.kind] ?? []).filter((key) => !config[key]);
  if (missing.length > 0) {
    return fail("configuration", id, `${provider.kind} provider is missing required config: ${missing.join(", ")}`,
      "Edit the provider in the Console or API and supply the missing fields; token acquisition cannot start without them.");
  }
  if (provider.kind === "api_key") {
    if (config.auth_location === "header" && !config.header_name) {
      return fail("configuration", id, "api_key provider uses header auth but header_name is unset",
        "Set header_name on the provider so the Gateway knows where to inject the key.");
    }
    if (config.auth_location === "query" && !config.query_param_name) {
      return fail("configuration", id, "api_key provider uses query auth but query_param_name is unset",
        "Set query_param_name on the provider so the Gateway knows where to inject the key.");
    }
  }
  if (OAUTH_KINDS.has(provider.kind) && Array.isArray(config.allowed_token_hosts) && config.allowed_token_hosts.length > 0) {
    let host;
    try {
      host = new URL(config.token_endpoint).hostname;
    } catch {
      host = undefined;
    }
    if (host && !config.allowed_token_hosts.includes(host)) {
      return fail("configuration", id, `token_endpoint host ${host} is not in allowed_token_hosts [${config.allowed_token_hosts.join(", ")}]`,
        "Add the token endpoint host to allowed_token_hosts, or fix the token_endpoint URL; token requests will be rejected otherwise.");
    }
  }
  return ok("configuration", id, `${provider.kind} provider config is complete`);
}

export function checkScopeCoverage(resource, requestedScopes) {
  const id = "scope coverage";
  if (!resource) return fail("configuration", id, "no resource to evaluate", "Resolve the resource lookup failure first.");
  if (!requestedScopes || requestedScopes.length === 0) {
    return warn("configuration", id, "no scopes requested",
      "Set PREFLIGHT_SCOPES to the scopes your application will request so authorization is validated realistically.");
  }
  const declared = new Set(resource.scopes ?? []);
  const uncovered = requestedScopes.filter((scope) => !declared.has(scope));
  if (uncovered.length > 0) {
    return fail("configuration", id, `requested scope(s) not declared on the resource: ${uncovered.join(", ")}`,
      `Add the scope(s) to the resource definition or correct the request; the resource declares [${[...declared].join(", ")}].`);
  }
  return ok("configuration", id, `requested scopes are declared on the resource: ${requestedScopes.join(", ")}`);
}

export function checkRuntimeInjection(provider, requireInjection) {
  const id = "runtime injection";
  if (!requireInjection) return ok("configuration", id, "not requested; skipped");
  if (!provider) return fail("configuration", id, "no provider to evaluate", "Resolve the resource binding failure first.");
  if (provider.config_json?.allow_runtime_injection !== true) {
    return fail("configuration", id, `provider ${provider.identifier} does not set allow_runtime_injection=true`,
      "Enable allow_runtime_injection on the provider if your workload injects tokens at runtime.");
  }
  return ok("configuration", id, `provider ${provider.identifier} permits runtime token injection`);
}

// --- Phase 4: connectivity -----------------------------------------------

export async function checkTokenEndpointHost(provider, resolveHost) {
  const id = "token endpoint host";
  if (!provider || !OAUTH_KINDS.has(provider.kind)) {
    return ok("connectivity", id, "not an OAuth provider; skipped");
  }
  const endpoint = provider.config_json?.token_endpoint;
  if (!endpoint) {
    return fail("connectivity", id, "OAuth provider has no token_endpoint",
      "Set token_endpoint on the provider; resolve the configuration failure first.");
  }
  let host;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:") {
      return fail("connectivity", id, `token_endpoint must be HTTPS: ${endpoint}`,
        "Use the provider's HTTPS token endpoint; STS refuses plaintext token exchanges.");
    }
    host = url.hostname;
  } catch {
    return fail("connectivity", id, `token_endpoint is not a valid URL: ${endpoint}`,
      "Correct the token_endpoint URL on the provider.");
  }
  try {
    const addresses = await resolveHost(host);
    if (addresses.length === 0) {
      return fail("connectivity", id, `${host} does not resolve`,
        "Check the hostname for typos and confirm DNS is available from the STS network position.");
    }
    const privateHit = addresses.find((a) => isPrivateAddress(a));
    if (privateHit) {
      return fail("connectivity", id, `${host} resolves to private address ${privateHit}`,
        "STS requires a public token endpoint; private or loopback token endpoints are rejected.");
    }
    return ok("connectivity", id, `${host} resolves to public address(es)`);
  } catch (err) {
    return fail("connectivity", id, `${host} resolution failed: ${err.message}`,
      "Confirm DNS is reachable from this host and the hostname exists.");
  }
}

export async function checkCallbackReachable(provider, probe) {
  const id = "callback reachability";
  if (!provider || provider.kind !== "oauth2_authorization_code") {
    return ok("connectivity", id, "no authorization-code callback; skipped");
  }
  const redirect = provider.config_json?.redirect_uri;
  if (!redirect) {
    return fail("connectivity", id, "authorization-code provider has no redirect_uri",
      "Set redirect_uri on the provider; resolve the configuration failure first.");
  }
  let url;
  try {
    url = new URL(redirect);
  } catch {
    return fail("connectivity", id, `redirect_uri is not a valid URI: ${redirect}`,
      "Correct the redirect_uri on the provider.");
  }
  if (url.protocol !== "https:") {
    return fail("connectivity", id, `redirect_uri must be HTTPS: ${redirect}`,
      "Serve the callback over HTTPS so upstream identity providers will return the browser to it.");
  }
  const reach = await probe(url.origin);
  if (!reach.reachable) {
    return fail("connectivity", id, `${url.origin} not reachable: ${reach.detail}`,
      "Expose the callback origin publicly (DNS, TLS, firewall) before users start authorization flows.");
  }
  return ok("connectivity", id, `${url.origin} reachable (${reach.detail})`);
}

export async function checkUpstreamReachable(resource, probe, resolveHost) {
  const id = "upstream reachability";
  const upstream = resource?.upstream_url;
  if (!upstream) {
    return warn("connectivity", id, "resource has no upstream_url",
      "Connector-verified or mandate-only resources may not need one; otherwise set upstream_url so the Gateway can route.");
  }
  let url;
  try {
    url = new URL(upstream);
  } catch {
    return fail("connectivity", id, `upstream_url is not a valid URL: ${upstream}`,
      "Correct the upstream_url on the resource.");
  }
  try {
    const addresses = await resolveHost(url.hostname);
    const privateHit = addresses.find((a) => isPrivateAddress(a));
    if (privateHit) {
      return warn("connectivity", id, `${url.hostname} resolves to private address ${privateHit}`,
        "The Gateway rejects private upstream addresses unless explicitly allowed (ALLOW_PRIVATE_UPSTREAMS); confirm this is intentional.");
    }
  } catch {
    // TCP probe below reports unresolvable hosts.
  }
  const reach = await probe(url.origin);
  if (!reach.reachable) {
    return fail("connectivity", id, `${url.origin} not reachable from this host: ${reach.detail}`,
      "Confirm the upstream is up and that this host's network position matches the Gateway's (see the position note in the README).");
  }
  return ok("connectivity", id, `${url.origin} reachable from this host (${reach.detail})`);
}

// --- Phase 5: authorization ----------------------------------------------

export function checkPolicyDecision(simulation) {
  const id = "policy authorization";
  if (!simulation) {
    return fail("authorization", id, "no active policy set in the zone",
      "Activate a policy set version that allows this application, resource, and scopes; with no policy the Gateway denies everything.");
  }
  const warnings = simulation.warnings ?? [];
  if (warnings.length > 0) {
    return fail("authorization", id, `simulation input rejected: ${warnings.join(", ")}`,
      "The simulation input does not match the policy input schema; this usually indicates a preflight/control-plane version mismatch.");
  }
  if (!simulation.result) {
    const reason = simulation.explanation?.reason ?? "policy execution unavailable";
    return fail("authorization", id, `policy was not executed: ${reason}`,
      "Enable STS-backed policy simulation on the control plane, or validate the policy decision in a staging environment that has it.");
  }
  const { decision, evaluation_status: status } = simulation.result;
  if (decision === "allow") {
    return ok("authorization", id, "active policy set allows the application, resource, and scopes");
  }
  return fail("authorization", id, `active policy set returned ${decision ?? "no decision"} (${status ?? "unknown status"})`,
    "Inspect the policy set's determining policies and adjust rules or the request (application, scopes) until simulation returns allow.");
}

// --- Orchestrator ----------------------------------------------------------

export function summarize(checks) {
  const summary = { ok: 0, warn: 0, fail: 0, total: checks.length };
  for (const c of checks) summary[c.status] += 1;
  return { summary, passed: summary.fail === 0 };
}

export async function runProviderPreflight(input) {
  const {
    apiProbe, gatewayProbe,
    resource, provider, application,
    requestedScopes, requireInjection,
    resolveHost, probeOrigin,
    simulation, now,
  } = input;
  const checks = [
    checkApiReady(apiProbe),
    checkGatewayReady(gatewayProbe),
    checkBinding(resource, provider),
    checkApplication(application, resource, now),
    checkProviderConfig(provider),
    checkScopeCoverage(resource, requestedScopes),
    checkRuntimeInjection(provider, requireInjection),
    await checkTokenEndpointHost(provider, resolveHost),
    await checkCallbackReachable(provider, probeOrigin),
    await checkUpstreamReachable(resource, probeOrigin, resolveHost),
    checkPolicyDecision(simulation),
  ];
  return { checks, ...summarize(checks) };
}
