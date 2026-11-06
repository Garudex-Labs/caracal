#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# OpenTofu validation harness: formatting plus offline validate of every
# environment root and module. Providers are resolved once per root with no
# backend so the harness never touches state or a cluster.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

command -v tofu >/dev/null 2>&1 || { echo "opentofu (tofu) is required" >&2; exit 1; }

tofu fmt -check -recursive "${ROOT}"

for dir in "${ROOT}"/envs/*/ "${ROOT}"/modules/*/ "${ROOT}"/providers/*/*/; do
    echo "==> Validating ${dir}"
    tofu -chdir="${dir}" init -backend=false -input=false -lockfile=readonly >/dev/null
    tofu -chdir="${dir}" validate
done

# Every provider adapter implements the same host contract. A caller that swaps
# one adapter for another must not have to rename an input or an output, so the
# contract is asserted rather than left to review.
echo "==> Checking host contract conformance"
contractInputs="name region zone machineSize diskGb diskType userData adminUsername adminPublicKey ingressCidrs adminCidrs networkCidr subnetId dnsZone hostnames dnsTtl tags"
contractOutputs="publicIp hostId identityId hostnames"
for dir in "${ROOT}"/providers/*/host/; do
    provider="$(basename "$(dirname "${dir}")")"
    for name in ${contractInputs}; do
        grep -q "^variable \"${name}\"" "${dir}/variables.tf" || {
            echo "FAIL: ${provider} host adapter is missing contract input ${name}" >&2
            exit 1
        }
    done
    for name in ${contractOutputs}; do
        grep -q "^output \"${name}\"" "${dir}/outputs.tf" || {
            echo "FAIL: ${provider} host adapter is missing contract output ${name}" >&2
            exit 1
        }
    done
    echo "  ${provider}: host contract satisfied"
done

# validate never evaluates templatefile, so the rendered cloud-config is checked
# separately: a malformed host bootstrap only surfaces at first boot otherwise.
echo "==> Rendering caracalHost cloud-config"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
cat >"${WORK}/main.tf" <<EOF
module "host" {
  source         = "${ROOT}/modules/caracalHost"
  caracalVersion = "v0.2.1"
  envOverrides   = { CARACAL_OPEN_REGISTRATION = "false" }
  operatorEmails = ["richard.hendricks@piedpiper.example"]
  tlsProxy = {
    email  = "ops@example.com"
    routes = { "console.example.com" = "web", "sts.example.com" = "sts" }
  }
}
output "userData" { value = module.host.userData }
EOF
tofu -chdir="${WORK}" init -backend=false -input=false >/dev/null
tofu -chdir="${WORK}" apply -auto-approve >/dev/null
tofu -chdir="${WORK}" output -raw userData >"${WORK}/userData.yaml"

node --input-type=module -e "
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
const doc = parse(readFileSync('${WORK}/userData.yaml', 'utf8'))
const files = Object.fromEntries(doc.write_files.map((f) => [f.path, f.content]))

const caddyfile = files['/var/lib/caracal/proxy/Caddyfile']
if (!caddyfile) throw new Error('proxy Caddyfile missing')
for (const [host, port] of [['console.example.com', 3001], ['sts.example.com', 8080]]) {
  if (!caddyfile.includes(host)) throw new Error(\`route \${host} missing\`)
  if (!caddyfile.includes(\`127.0.0.1:\${port}\`)) throw new Error(\`\${host} must proxy to \${port}\`)
}

// A console origin that disagrees with the terminating hostname breaks
// credentialed requests, so the derived values are asserted, not assumed.
const env = files['/var/lib/caracal/caracal.env']
for (const line of [
  'CARACAL_WEB_URL=https://console.example.com',
  'CARACAL_WEB_ORIGIN=https://console.example.com',
  'CARACAL_STS_ISSUER_URL=https://sts.example.com',
  'CARACAL_AUTH_TRUST_PROXY=1',
  'CARACAL_OPEN_REGISTRATION=false',
]) {
  if (!env.includes(line)) throw new Error(\`caracal.env missing \${line}\`)
}

// The bootstrap script owns the ordered boot: install, allowlist seeding, stack
// start, proxy start, readiness gate. Order matters, so positions are asserted.
const script = files['/usr/local/lib/caracalBootstrap.sh']
if (!script) throw new Error('bootstrap script missing')
if (!script.startsWith('#!/bin/sh\nset -eu')) throw new Error('bootstrap script must run under strict mode')
if (!script.includes('/v0.2.1/install.sh')) throw new Error('installer must resolve from the selected release, not main')
if (script.includes('| sh')) throw new Error('download failure must not be hidden by a shell pipeline')
const positions = [
  ['install.sh', script.indexOf('CARACAL_INSTALL_DIR=/usr/local/bin')],
  ['allowlist seeding', script.indexOf(\`allowlist add 'richard.hendricks@piedpiper.example'\`)],
  ['stack start', script.indexOf('/usr/local/bin/caracal up')],
  ['proxy start', script.indexOf('caracalProxy')],
  ['readiness gate', script.indexOf('status --ready')],
]
for (const [step, at] of positions) {
  if (at < 0) throw new Error(\`bootstrap script missing \${step}\`)
}
for (let i = 1; i < positions.length; i += 1) {
  if (positions[i][1] < positions[i - 1][1]) throw new Error(\`\${positions[i][0]} must come after \${positions[i - 1][0]}\`)
}
if (!doc.runcmd.some((c) => typeof c === 'string' && c.includes('bootstrapStatus'))) {
  throw new Error('boot outcome marker is never written')
}
console.log('  cloud-config renders with proxy routes, matching public origins, and an ordered bootstrap')
"

cat >"${WORK}/main.tf" <<EOF
module "host" {
  source         = "${ROOT}/modules/caracalHost"
  caracalVersion = "v0.2.1"
}
output "userData" { value = module.host.userData }
EOF
tofu -chdir="${WORK}" apply -auto-approve >/dev/null
tofu -chdir="${WORK}" output -raw userData >"${WORK}/plain.yaml"
node --input-type=module -e "
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
const doc = parse(readFileSync('${WORK}/plain.yaml', 'utf8'))
const files = Object.fromEntries(doc.write_files.map((f) => [f.path, f.content]))
// A provisioned host is a deployment surface with no guided-setup window, so the
// sign-in requirement is armed even with no operator overrides.
const env = files['/var/lib/caracal/caracal.env']
if (!env || env.trim() !== 'CARACAL_REQUIRE_SIGN_IN_METHOD=1') {
  throw new Error('a bare host must write exactly the armed sign-in requirement')
}
if (files['/var/lib/caracal/proxy/Caddyfile']) throw new Error('no proxy must write no Caddyfile')
const script = files['/usr/local/lib/caracalBootstrap.sh']
if (!script) throw new Error('bootstrap script missing')
if (script.includes('caracalProxy')) throw new Error('proxy must not start when tlsProxy is unset')
if (script.includes('allowlist add')) throw new Error('allowlist must not seed when no operators are given')
console.log('  cloud-config renders without a proxy when none is configured')
"

echo "tofu validation passed"
