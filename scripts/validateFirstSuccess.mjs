// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// First-success validation script for real Gateway, STS, and upstream paths.

import { readFile } from 'node:fs/promises';

const args = parseArgs(process.argv.slice(2));
const timeoutMs = Number(args.timeoutMs ?? 10_000);

if (args.help) {
  usage(0);
}

requireArg('gatewayUrl');
requireArg('stsUrl');
requireArg('resource');

const token = args.token ?? process.env[args.tokenEnv ?? 'CARACAL_TOKEN'];
if (!token) {
  fail(`missing token; set --token-env or --token with a real Caracal mandate`);
}

const gatewayUrl = trimSlash(args.gatewayUrl);
const stsUrl = trimSlash(args.stsUrl);
const requestPath = args.path ?? '/';
const method = (args.method ?? 'GET').toUpperCase();
const headers = await loadHeaders(args.headersFile);
const body = args.bodyFile ? await readFile(args.bodyFile) : undefined;

await expectReady(`${stsUrl}/ready`, 'STS');
await expectReady(`${gatewayUrl}/ready`, 'Gateway');

const before = await gatewayMetric(gatewayUrl, 'caracal_gateway_requests_allowed_total');
const requestUrl = new URL(requestPath, `${gatewayUrl}/`);
const response = await fetchWithTimeout(requestUrl, {
  method,
  headers: {
    ...headers,
    Authorization: `Bearer ${token}`,
    'X-Caracal-Resource': args.resource,
  },
  body,
});

if (response.status < 200 || response.status >= 400) {
  const text = await response.text();
  fail(`gateway request failed with HTTP ${response.status}: ${text.slice(0, 1000)}`);
}

const after = await gatewayMetric(gatewayUrl, 'caracal_gateway_requests_allowed_total');
if (after <= before) {
  fail(`gateway success counter did not advance; check Gateway metrics exposure and request routing`);
}

console.log(JSON.stringify({
  ok: true,
  gateway_status: response.status,
  resource: args.resource,
  request_allowed_before: before,
  request_allowed_after: after,
}, null, 2));

function parseArgs(values) {
  const out = {};
  for (let i = 0; i < values.length; i++) {
    const raw = values[i];
    if (!raw.startsWith('--')) {
      fail(`unexpected positional argument: ${raw}`);
    }
    const eq = raw.indexOf('=');
    const key = eq === -1 ? raw.slice(2) : raw.slice(2, eq);
    const inline = eq === -1 ? undefined : raw.slice(eq + 1);
    const name = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (name === 'help') {
      out.help = true;
      continue;
    }
    out[name] = inline ?? values[++i];
    if (out[name] === undefined || String(out[name]).startsWith('--')) {
      fail(`missing value for --${key}`);
    }
  }
  return out;
}

async function loadHeaders(path) {
  if (!path) {
    return {};
  }
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('--headers-file must contain a JSON object');
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      fail(`header ${key} must be a string`);
    }
  }
  return parsed;
}

async function expectReady(url, name) {
  const response = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    const text = await response.text();
    fail(`${name} readiness failed with HTTP ${response.status}: ${text.slice(0, 1000)}`);
  }
}

async function gatewayMetric(gatewayUrl, name) {
  const response = await fetchWithTimeout(`${gatewayUrl}/metrics`);
  if (!response.ok) {
    fail(`gateway metrics failed with HTTP ${response.status}`);
  }
  const text = await response.text();
  for (const line of text.split('\n')) {
    if (line.startsWith(`${name} `)) {
      return Number(line.slice(name.length).trim());
    }
  }
  fail(`gateway metric not found: ${name}`);
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function trimSlash(value) {
  return String(value).replace(/\/+$/, '');
}

function requireArg(name) {
  if (!args[name]) {
    fail(`missing --${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function usage(code) {
  console.log(`Usage:
node scripts/validateFirstSuccess.mjs \\
  --gateway-url http://localhost:8081 \\
  --sts-url http://localhost:8080 \\
  --resource <real-resource-id> \\
  --token-env CARACAL_TOKEN \\
  --path /real/protected/path

Options:
  --token <token>             Use a real mandate directly instead of --token-env.
  --method <method>           HTTP method for the protected request. Defaults to GET.
  --headers-file <path>       JSON object of additional request headers.
  --body-file <path>          Request body file for POST/PUT/PATCH requests.
  --timeout-ms <ms>           Per-request timeout. Defaults to 10000.
`);
  process.exit(code);
}
