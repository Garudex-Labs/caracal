---
title: v2026.05.27-rc.1 Release Validation Report
---

# Caracal v2026.05.27-rc.1 Release Validation

**Published:** undefined
**Ecosystem quality score:** 99% (pass / total checks)
**Total blockers:** 0

## Compatibility matrix

### Runtime / Console binaries

| Artifact | Version |
| --- | --- |
| `shell` | 2026.05.27-rc.1 |
| `console` | 2026.05.27-rc.1 |

### Container images (ghcr.io/garudex-labs)

| Artifact | Version |
| --- | --- |
| `ghcr.io/garudex-labs/caracal-api` | v2026.05.27-rc.1 |
| `ghcr.io/garudex-labs/caracal-sts` | v2026.05.27-rc.1 |
| `ghcr.io/garudex-labs/caracal-gateway` | v2026.05.27-rc.1 |
| `ghcr.io/garudex-labs/caracal-audit` | v2026.05.27-rc.1 |
| `ghcr.io/garudex-labs/caracal-coordinator` | v2026.05.27-rc.1 |
| `ghcr.io/garudex-labs/caracal-control` | v2026.05.27-rc.1 |
| `ghcr.io/garudex-labs/caracal-postgres` | v2026.05.27-rc.1 |
| `ghcr.io/garudex-labs/caracal-redis` | v2026.05.27-rc.1 |

### Published PyPI packages

| Artifact | Version |
| --- | --- |
| `caracalai-core` | 0.1.3rc1 |
| `caracalai-oauth` | 0.1.3rc1 |
| `caracalai-identity` | 0.1.3rc1 |
| `caracalai-revocation` | 0.1.3rc1 |
| `caracalai-sdk` | 0.1.3rc1 |
| `caracalai-transport-mcp` | 0.1.3rc1 |
| `caracalai-mcp-fastmcp` | 0.1.3rc1 |
| `caracalai-revocation-redis` | 0.1.3rc1 |

### Published npm packages

| Artifact | Version |
| --- | --- |
| `@caracalai/core` | 0.1.3-rc.1 |
| `@caracalai/oauth` | 0.1.3-rc.1 |
| `@caracalai/admin` | 0.1.3-rc.1 |
| `@caracalai/identity` | 0.1.3-rc.1 |
| `@caracalai/revocation` | 0.1.3-rc.1 |
| `@caracalai/sdk` | 0.1.3-rc.1 |
| `@caracalai/transport-mcp` | 0.1.3-rc.1 |
| `@caracalai/transport-a2a` | 0.1.3-rc.1 |
| `@caracalai/mcp-express` | 0.1.3-rc.1 |
| `@caracalai/mcp-fastmcp` | 0.1.3-rc.1 |
| `@caracalai/tokenstate-postgres` | 0.1.3-rc.1 |
| `@caracalai/revocation-redis` | 0.1.3-rc.1 |


## Summary

| Area | Pass | Warn | Fail | Blockers |
| --- | --- | --- | --- | --- |
| Registry Metadata | 20 | 0 | 0 | 0 |
| PyPI Install Matrix | 48 | 0 | 0 | 0 |
| npm Install Matrix | 72 | 0 | 0 | 0 |
| Shell Binaries | 15 | 0 | 0 | 0 |
| Console Binaries | 15 | 0 | 0 | 0 |
| Installers | 4 | 2 | 0 | 0 |
| Container Stack | 10 | 0 | 0 | 0 |
| Provenance & Signing | 19 | 0 | 0 | 0 |

## Severity rubric

- **blocker**: unusable artifact
- **major**: broken contract
- **minor**: cosmetic or docs issue
- **info**: informational only

## Findings

### Registry Metadata

- **[info]** PASS: `caracalai-core` (registry/pypi/-): metadata ok @ 0.1.3rc1
  - Repro: `curl https://pypi.org/pypi/caracalai-core/json`
- **[info]** PASS: `caracalai-oauth` (registry/pypi/-): metadata ok @ 0.1.3rc1
  - Repro: `curl https://pypi.org/pypi/caracalai-oauth/json`
- **[info]** PASS: `caracalai-identity` (registry/pypi/-): metadata ok @ 0.1.3rc1
  - Repro: `curl https://pypi.org/pypi/caracalai-identity/json`
- **[info]** PASS: `caracalai-revocation` (registry/pypi/-): metadata ok @ 0.1.3rc1
  - Repro: `curl https://pypi.org/pypi/caracalai-revocation/json`
- **[info]** PASS: `caracalai-sdk` (registry/pypi/-): metadata ok @ 0.1.3rc1
  - Repro: `curl https://pypi.org/pypi/caracalai-sdk/json`
- **[info]** PASS: `caracalai-transport-mcp` (registry/pypi/-): metadata ok @ 0.1.3rc1
  - Repro: `curl https://pypi.org/pypi/caracalai-transport-mcp/json`
- **[info]** PASS: `caracalai-mcp-fastmcp` (registry/pypi/-): metadata ok @ 0.1.3rc1
  - Repro: `curl https://pypi.org/pypi/caracalai-mcp-fastmcp/json`
- **[info]** PASS: `caracalai-revocation-redis` (registry/pypi/-): metadata ok @ 0.1.3rc1
  - Repro: `curl https://pypi.org/pypi/caracalai-revocation-redis/json`
- **[info]** PASS: `@caracalai/core` (registry/npm/-): metadata ok @ 0.1.3-rc.1
  - Repro: `curl https://registry.npmjs.org/@caracalai/core`
- **[info]** PASS: `@caracalai/oauth` (registry/npm/-): metadata ok @ 0.1.3-rc.1
  - Repro: `curl https://registry.npmjs.org/@caracalai/oauth`
- **[info]** PASS: `@caracalai/admin` (registry/npm/-): metadata ok @ 0.1.3-rc.1
  - Repro: `curl https://registry.npmjs.org/@caracalai/admin`
- **[info]** PASS: `@caracalai/identity` (registry/npm/-): metadata ok @ 0.1.3-rc.1
  - Repro: `curl https://registry.npmjs.org/@caracalai/identity`
- **[info]** PASS: `@caracalai/revocation` (registry/npm/-): metadata ok @ 0.1.3-rc.1
  - Repro: `curl https://registry.npmjs.org/@caracalai/revocation`
- **[info]** PASS: `@caracalai/sdk` (registry/npm/-): metadata ok @ 0.1.3-rc.1
  - Repro: `curl https://registry.npmjs.org/@caracalai/sdk`
- **[info]** PASS: `@caracalai/transport-mcp` (registry/npm/-): metadata ok @ 0.1.3-rc.1
  - Repro: `curl https://registry.npmjs.org/@caracalai/transport-mcp`
- **[info]** PASS: `@caracalai/transport-a2a` (registry/npm/-): metadata ok @ 0.1.3-rc.1
  - Repro: `curl https://registry.npmjs.org/@caracalai/transport-a2a`
- **[info]** PASS: `@caracalai/mcp-express` (registry/npm/-): metadata ok @ 0.1.3-rc.1
  - Repro: `curl https://registry.npmjs.org/@caracalai/mcp-express`
- **[info]** PASS: `@caracalai/mcp-fastmcp` (registry/npm/-): metadata ok @ 0.1.3-rc.1
  - Repro: `curl https://registry.npmjs.org/@caracalai/mcp-fastmcp`
- **[info]** PASS: `@caracalai/tokenstate-postgres` (registry/npm/-): metadata ok @ 0.1.3-rc.1
  - Repro: `curl https://registry.npmjs.org/@caracalai/tokenstate-postgres`
- **[info]** PASS: `@caracalai/revocation-redis` (registry/npm/-): metadata ok @ 0.1.3-rc.1
  - Repro: `curl https://registry.npmjs.org/@caracalai/revocation-redis`

### PyPI Install Matrix

- **[info]** PASS: `caracalai-core` (darwin-arm64/uv/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `uv install caracalai-core==0.1.3rc1`
- **[info]** PASS: `caracalai-oauth` (darwin-arm64/uv/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `uv install caracalai-oauth==0.1.3rc1`
- **[info]** PASS: `caracalai-identity` (darwin-arm64/uv/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `uv install caracalai-identity==0.1.3rc1`
- **[info]** PASS: `caracalai-revocation` (darwin-arm64/uv/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `uv install caracalai-revocation==0.1.3rc1`
- **[info]** PASS: `caracalai-sdk` (darwin-arm64/uv/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `uv install caracalai-sdk==0.1.3rc1`
- **[info]** PASS: `caracalai-transport-mcp` (darwin-arm64/uv/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `uv install caracalai-transport-mcp==0.1.3rc1`
- **[info]** PASS: `caracalai-mcp-fastmcp` (darwin-arm64/uv/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `uv install caracalai-mcp-fastmcp==0.1.3rc1`
- **[info]** PASS: `caracalai-revocation-redis` (darwin-arm64/uv/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `uv install caracalai-revocation-redis==0.1.3rc1`
- **[info]** PASS: `caracalai-core` (darwin-arm64/pip/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `pip install caracalai-core==0.1.3rc1`
- **[info]** PASS: `caracalai-oauth` (darwin-arm64/pip/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `pip install caracalai-oauth==0.1.3rc1`
- **[info]** PASS: `caracalai-identity` (darwin-arm64/pip/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `pip install caracalai-identity==0.1.3rc1`
- **[info]** PASS: `caracalai-revocation` (darwin-arm64/pip/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `pip install caracalai-revocation==0.1.3rc1`
- **[info]** PASS: `caracalai-sdk` (darwin-arm64/pip/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `pip install caracalai-sdk==0.1.3rc1`
- **[info]** PASS: `caracalai-transport-mcp` (darwin-arm64/pip/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `pip install caracalai-transport-mcp==0.1.3rc1`
- **[info]** PASS: `caracalai-mcp-fastmcp` (darwin-arm64/pip/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `pip install caracalai-mcp-fastmcp==0.1.3rc1`
- **[info]** PASS: `caracalai-revocation-redis` (darwin-arm64/pip/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `pip install caracalai-revocation-redis==0.1.3rc1`
- **[info]** PASS: `caracalai-core` (windows-amd64/pip/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `pip install caracalai-core==0.1.3rc1`
- **[info]** PASS: `caracalai-oauth` (windows-amd64/pip/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `pip install caracalai-oauth==0.1.3rc1`
- **[info]** PASS: `caracalai-identity` (windows-amd64/pip/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `pip install caracalai-identity==0.1.3rc1`
- **[info]** PASS: `caracalai-revocation` (windows-amd64/pip/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `pip install caracalai-revocation==0.1.3rc1`
- **[info]** PASS: `caracalai-sdk` (windows-amd64/pip/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `pip install caracalai-sdk==0.1.3rc1`
- **[info]** PASS: `caracalai-transport-mcp` (windows-amd64/pip/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `pip install caracalai-transport-mcp==0.1.3rc1`
- **[info]** PASS: `caracalai-mcp-fastmcp` (windows-amd64/pip/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `pip install caracalai-mcp-fastmcp==0.1.3rc1`
- **[info]** PASS: `caracalai-revocation-redis` (windows-amd64/pip/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `pip install caracalai-revocation-redis==0.1.3rc1`
- **[info]** PASS: `caracalai-core` (linux-amd64/uv/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `uv install caracalai-core==0.1.3rc1`
- **[info]** PASS: `caracalai-oauth` (linux-amd64/uv/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `uv install caracalai-oauth==0.1.3rc1`
- **[info]** PASS: `caracalai-identity` (linux-amd64/uv/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `uv install caracalai-identity==0.1.3rc1`
- **[info]** PASS: `caracalai-revocation` (linux-amd64/uv/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `uv install caracalai-revocation==0.1.3rc1`
- **[info]** PASS: `caracalai-sdk` (linux-amd64/uv/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `uv install caracalai-sdk==0.1.3rc1`
- **[info]** PASS: `caracalai-transport-mcp` (linux-amd64/uv/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `uv install caracalai-transport-mcp==0.1.3rc1`
- **[info]** PASS: `caracalai-mcp-fastmcp` (linux-amd64/uv/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `uv install caracalai-mcp-fastmcp==0.1.3rc1`
- **[info]** PASS: `caracalai-revocation-redis` (linux-amd64/uv/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `uv install caracalai-revocation-redis==0.1.3rc1`
- **[info]** PASS: `caracalai-core` (windows-amd64/uv/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `uv install caracalai-core==0.1.3rc1`
- **[info]** PASS: `caracalai-oauth` (windows-amd64/uv/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `uv install caracalai-oauth==0.1.3rc1`
- **[info]** PASS: `caracalai-identity` (windows-amd64/uv/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `uv install caracalai-identity==0.1.3rc1`
- **[info]** PASS: `caracalai-revocation` (windows-amd64/uv/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `uv install caracalai-revocation==0.1.3rc1`
- **[info]** PASS: `caracalai-sdk` (windows-amd64/uv/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `uv install caracalai-sdk==0.1.3rc1`
- **[info]** PASS: `caracalai-transport-mcp` (windows-amd64/uv/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `uv install caracalai-transport-mcp==0.1.3rc1`
- **[info]** PASS: `caracalai-mcp-fastmcp` (windows-amd64/uv/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `uv install caracalai-mcp-fastmcp==0.1.3rc1`
- **[info]** PASS: `caracalai-revocation-redis` (windows-amd64/uv/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `uv install caracalai-revocation-redis==0.1.3rc1`
- **[info]** PASS: `caracalai-core` (linux-amd64/pip/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `pip install caracalai-core==0.1.3rc1`
- **[info]** PASS: `caracalai-oauth` (linux-amd64/pip/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `pip install caracalai-oauth==0.1.3rc1`
- **[info]** PASS: `caracalai-identity` (linux-amd64/pip/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `pip install caracalai-identity==0.1.3rc1`
- **[info]** PASS: `caracalai-revocation` (linux-amd64/pip/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `pip install caracalai-revocation==0.1.3rc1`
- **[info]** PASS: `caracalai-sdk` (linux-amd64/pip/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `pip install caracalai-sdk==0.1.3rc1`
- **[info]** PASS: `caracalai-transport-mcp` (linux-amd64/pip/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `pip install caracalai-transport-mcp==0.1.3rc1`
- **[info]** PASS: `caracalai-mcp-fastmcp` (linux-amd64/pip/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `pip install caracalai-mcp-fastmcp==0.1.3rc1`
- **[info]** PASS: `caracalai-revocation-redis` (linux-amd64/pip/py3.14): install + import ok @ 0.1.3rc1
  - Repro: `pip install caracalai-revocation-redis==0.1.3rc1`

### npm Install Matrix

- **[info]** PASS: `@caracalai/core` (linux-amd64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/core@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/oauth` (linux-amd64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/oauth@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/admin` (linux-amd64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/admin@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/identity` (linux-amd64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/identity@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/revocation` (linux-amd64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/revocation@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/sdk` (linux-amd64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/sdk@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/transport-mcp` (linux-amd64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/transport-mcp@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/transport-a2a` (linux-amd64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/transport-a2a@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/mcp-express` (linux-amd64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/mcp-express@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/mcp-fastmcp` (linux-amd64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/mcp-fastmcp@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/tokenstate-postgres` (linux-amd64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/tokenstate-postgres@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/revocation-redis` (linux-amd64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/revocation-redis@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/core` (windows-amd64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/core@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/oauth` (windows-amd64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/oauth@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/admin` (windows-amd64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/admin@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/identity` (windows-amd64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/identity@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/revocation` (windows-amd64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/revocation@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/sdk` (windows-amd64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/sdk@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/transport-mcp` (windows-amd64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/transport-mcp@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/transport-a2a` (windows-amd64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/transport-a2a@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/mcp-express` (windows-amd64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/mcp-express@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/mcp-fastmcp` (windows-amd64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/mcp-fastmcp@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/tokenstate-postgres` (windows-amd64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/tokenstate-postgres@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/revocation-redis` (windows-amd64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/revocation-redis@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/core` (windows-amd64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/core@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/oauth` (windows-amd64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/oauth@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/admin` (windows-amd64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/admin@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/identity` (windows-amd64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/identity@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/revocation` (windows-amd64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/revocation@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/sdk` (windows-amd64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/sdk@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/transport-mcp` (windows-amd64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/transport-mcp@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/transport-a2a` (windows-amd64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/transport-a2a@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/mcp-express` (windows-amd64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/mcp-express@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/mcp-fastmcp` (windows-amd64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/mcp-fastmcp@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/tokenstate-postgres` (windows-amd64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/tokenstate-postgres@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/revocation-redis` (windows-amd64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/revocation-redis@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/core` (linux-amd64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/core@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/oauth` (linux-amd64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/oauth@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/admin` (linux-amd64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/admin@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/identity` (linux-amd64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/identity@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/revocation` (linux-amd64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/revocation@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/sdk` (linux-amd64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/sdk@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/transport-mcp` (linux-amd64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/transport-mcp@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/transport-a2a` (linux-amd64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/transport-a2a@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/mcp-express` (linux-amd64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/mcp-express@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/mcp-fastmcp` (linux-amd64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/mcp-fastmcp@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/tokenstate-postgres` (linux-amd64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/tokenstate-postgres@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/revocation-redis` (linux-amd64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/revocation-redis@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/core` (darwin-arm64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/core@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/oauth` (darwin-arm64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/oauth@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/admin` (darwin-arm64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/admin@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/identity` (darwin-arm64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/identity@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/revocation` (darwin-arm64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/revocation@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/sdk` (darwin-arm64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/sdk@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/transport-mcp` (darwin-arm64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/transport-mcp@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/transport-a2a` (darwin-arm64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/transport-a2a@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/mcp-express` (darwin-arm64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/mcp-express@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/mcp-fastmcp` (darwin-arm64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/mcp-fastmcp@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/tokenstate-postgres` (darwin-arm64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/tokenstate-postgres@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/revocation-redis` (darwin-arm64/pnpm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `pnpm add @caracalai/revocation-redis@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/core` (darwin-arm64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/core@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/oauth` (darwin-arm64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/oauth@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/admin` (darwin-arm64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/admin@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/identity` (darwin-arm64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/identity@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/revocation` (darwin-arm64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/revocation@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/sdk` (darwin-arm64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/sdk@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/transport-mcp` (darwin-arm64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/transport-mcp@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/transport-a2a` (darwin-arm64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/transport-a2a@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/mcp-express` (darwin-arm64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/mcp-express@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/mcp-fastmcp` (darwin-arm64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/mcp-fastmcp@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/tokenstate-postgres` (darwin-arm64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/tokenstate-postgres@0.1.3-rc.1`
- **[info]** PASS: `@caracalai/revocation-redis` (darwin-arm64/npm/node24): install + ESM import ok @ 0.1.3-rc.1
  - Repro: `npm add @caracalai/revocation-redis@0.1.3-rc.1`

### Shell Binaries

- **[info]** PASS: `caracal-shell-linux-amd64-v2026.05.27-rc.1.tar.gz` (linux-amd64/github/-): --version returns 2026.05.27-rc.1
  - Repro: `./caracal --version`
- **[info]** PASS: `caracal-shell-linux-arm64-v2026.05.27-rc.1.tar.gz` (linux-arm64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`
- **[info]** PASS: `caracal-shell-darwin-amd64-v2026.05.27-rc.1.tar.gz` (darwin-amd64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`
- **[info]** PASS: `caracal-shell-darwin-arm64-v2026.05.27-rc.1.tar.gz` (darwin-arm64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`
- **[info]** PASS: `caracal-shell-windows-amd64-v2026.05.27-rc.1.zip` (windows-amd64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`
- **[info]** PASS: `caracal-shell-linux-amd64-v2026.05.27-rc.1.tar.gz` (linux-amd64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`
- **[info]** PASS: `caracal-shell-linux-arm64-v2026.05.27-rc.1.tar.gz` (linux-arm64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`
- **[info]** PASS: `caracal-shell-darwin-amd64-v2026.05.27-rc.1.tar.gz` (darwin-amd64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`
- **[info]** PASS: `caracal-shell-darwin-arm64-v2026.05.27-rc.1.tar.gz` (darwin-arm64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`
- **[info]** PASS: `caracal-shell-windows-amd64-v2026.05.27-rc.1.zip` (windows-amd64/github/-): --version returns 2026.05.27-rc.1
  - Repro: `./caracal.exe --version`
- **[info]** PASS: `caracal-shell-linux-amd64-v2026.05.27-rc.1.tar.gz` (linux-amd64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`
- **[info]** PASS: `caracal-shell-linux-arm64-v2026.05.27-rc.1.tar.gz` (linux-arm64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`
- **[info]** PASS: `caracal-shell-darwin-amd64-v2026.05.27-rc.1.tar.gz` (darwin-amd64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`
- **[info]** PASS: `caracal-shell-darwin-arm64-v2026.05.27-rc.1.tar.gz` (darwin-arm64/github/-): --version returns 2026.05.27-rc.1
  - Repro: `./caracal --version`
- **[info]** PASS: `caracal-shell-windows-amd64-v2026.05.27-rc.1.zip` (windows-amd64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`

### Console Binaries

- **[info]** PASS: `caracal-console-linux-amd64-v2026.05.27-rc.1.tar.gz` (linux-amd64/github/-): --version returns 2026.05.27-rc.1
  - Repro: `./caracal-console --version`
- **[info]** PASS: `caracal-console-linux-arm64-v2026.05.27-rc.1.tar.gz` (linux-arm64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`
- **[info]** PASS: `caracal-console-darwin-amd64-v2026.05.27-rc.1.tar.gz` (darwin-amd64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`
- **[info]** PASS: `caracal-console-darwin-arm64-v2026.05.27-rc.1.tar.gz` (darwin-arm64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`
- **[info]** PASS: `caracal-console-windows-amd64-v2026.05.27-rc.1.zip` (windows-amd64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`
- **[info]** PASS: `caracal-console-linux-amd64-v2026.05.27-rc.1.tar.gz` (linux-amd64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`
- **[info]** PASS: `caracal-console-linux-arm64-v2026.05.27-rc.1.tar.gz` (linux-arm64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`
- **[info]** PASS: `caracal-console-darwin-amd64-v2026.05.27-rc.1.tar.gz` (darwin-amd64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`
- **[info]** PASS: `caracal-console-darwin-arm64-v2026.05.27-rc.1.tar.gz` (darwin-arm64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`
- **[info]** PASS: `caracal-console-windows-amd64-v2026.05.27-rc.1.zip` (windows-amd64/github/-): --version returns 2026.05.27-rc.1
  - Repro: `./caracal-console.exe --version`
- **[info]** PASS: `caracal-console-linux-amd64-v2026.05.27-rc.1.tar.gz` (linux-amd64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`
- **[info]** PASS: `caracal-console-linux-arm64-v2026.05.27-rc.1.tar.gz` (linux-arm64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`
- **[info]** PASS: `caracal-console-darwin-amd64-v2026.05.27-rc.1.tar.gz` (darwin-amd64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`
- **[info]** PASS: `caracal-console-darwin-arm64-v2026.05.27-rc.1.tar.gz` (darwin-arm64/github/-): --version returns 2026.05.27-rc.1
  - Repro: `./caracal-console --version`
- **[info]** PASS: `caracal-console-windows-amd64-v2026.05.27-rc.1.zip` (windows-amd64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`

### Installers

- **[info]** PASS: `install-console.sh` (darwin-arm64/shell/-): installer placed caracal and caracal-console on PATH
  - Repro: `bash install-console.sh --version v2026.05.27-rc.1`
- **[info]** WARN: `install-console.ps1` (darwin-arm64/pwsh/-): PowerShell installer is only exercised on Windows runners
  - Repro: `pwsh -File install-console.ps1 -Version v2026.05.27-rc.1`
- **[info]** PASS: `install-console.sh` (windows-amd64/shell/-): installer placed caracal and caracal-console on PATH
  - Repro: `bash install-console.sh --version v2026.05.27-rc.1`
- **[info]** PASS: `install-console.ps1` (windows-amd64/pwsh/-): PowerShell installer placed caracal-console on PATH
  - Repro: `pwsh -File install-console.ps1 -Version v2026.05.27-rc.1`
- **[info]** PASS: `install-console.sh` (linux-amd64/shell/-): installer placed caracal and caracal-console on PATH
  - Repro: `bash install-console.sh --version v2026.05.27-rc.1`
- **[info]** WARN: `install-console.ps1` (linux-amd64/pwsh/-): PowerShell installer is only exercised on Windows runners
  - Repro: `pwsh -File install-console.ps1 -Version v2026.05.27-rc.1`

### Container Stack

- **[info]** PASS: `ghcr.io/garudex-labs/caracal-api:v2026.05.27-rc.1` (linux-amd64/ghcr/docker): image pulled
  - Repro: `docker pull ghcr.io/garudex-labs/caracal-api:v2026.05.27-rc.1`
- **[info]** PASS: `ghcr.io/garudex-labs/caracal-sts:v2026.05.27-rc.1` (linux-amd64/ghcr/docker): image pulled
  - Repro: `docker pull ghcr.io/garudex-labs/caracal-sts:v2026.05.27-rc.1`
- **[info]** PASS: `ghcr.io/garudex-labs/caracal-gateway:v2026.05.27-rc.1` (linux-amd64/ghcr/docker): image pulled
  - Repro: `docker pull ghcr.io/garudex-labs/caracal-gateway:v2026.05.27-rc.1`
- **[info]** PASS: `ghcr.io/garudex-labs/caracal-audit:v2026.05.27-rc.1` (linux-amd64/ghcr/docker): image pulled
  - Repro: `docker pull ghcr.io/garudex-labs/caracal-audit:v2026.05.27-rc.1`
- **[info]** PASS: `ghcr.io/garudex-labs/caracal-coordinator:v2026.05.27-rc.1` (linux-amd64/ghcr/docker): image pulled
  - Repro: `docker pull ghcr.io/garudex-labs/caracal-coordinator:v2026.05.27-rc.1`
- **[info]** PASS: `ghcr.io/garudex-labs/caracal-control:v2026.05.27-rc.1` (linux-amd64/ghcr/docker): image pulled
  - Repro: `docker pull ghcr.io/garudex-labs/caracal-control:v2026.05.27-rc.1`
- **[info]** PASS: `ghcr.io/garudex-labs/caracal-postgres:v2026.05.27-rc.1` (linux-amd64/ghcr/docker): image pulled
  - Repro: `docker pull ghcr.io/garudex-labs/caracal-postgres:v2026.05.27-rc.1`
- **[info]** PASS: `ghcr.io/garudex-labs/caracal-redis:v2026.05.27-rc.1` (linux-amd64/ghcr/docker): image pulled
  - Repro: `docker pull ghcr.io/garudex-labs/caracal-redis:v2026.05.27-rc.1`
- **[info]** PASS: `ghcr.io/garudex-labs/caracal-runtime:v2026.05.27-rc.1` (linux-amd64/ghcr/docker): image pulled
  - Repro: `docker pull ghcr.io/garudex-labs/caracal-runtime:v2026.05.27-rc.1`
- **[info]** PASS: `stack` (linux-amd64/compose/docker): compose up succeeded
  - Repro: `docker compose up -d`

### Provenance & Signing

- **[info]** PASS: `caracal-shell-linux-amd64-v2026.05.27-rc.1.tar.gz` (github/gh/-): attestation verified
  - Repro: `gh attestation verify caracal-shell-linux-amd64-v2026.05.27-rc.1.tar.gz --repo Garudex-Labs/caracal`
- **[info]** PASS: `caracal-console-linux-amd64-v2026.05.27-rc.1.tar.gz` (github/gh/-): attestation verified
  - Repro: `gh attestation verify caracal-console-linux-amd64-v2026.05.27-rc.1.tar.gz --repo Garudex-Labs/caracal`
- **[info]** PASS: `caracal-shell-linux-arm64-v2026.05.27-rc.1.tar.gz` (github/gh/-): attestation verified
  - Repro: `gh attestation verify caracal-shell-linux-arm64-v2026.05.27-rc.1.tar.gz --repo Garudex-Labs/caracal`
- **[info]** PASS: `caracal-console-linux-arm64-v2026.05.27-rc.1.tar.gz` (github/gh/-): attestation verified
  - Repro: `gh attestation verify caracal-console-linux-arm64-v2026.05.27-rc.1.tar.gz --repo Garudex-Labs/caracal`
- **[info]** PASS: `caracal-shell-darwin-amd64-v2026.05.27-rc.1.tar.gz` (github/gh/-): attestation verified
  - Repro: `gh attestation verify caracal-shell-darwin-amd64-v2026.05.27-rc.1.tar.gz --repo Garudex-Labs/caracal`
- **[info]** PASS: `caracal-console-darwin-amd64-v2026.05.27-rc.1.tar.gz` (github/gh/-): attestation verified
  - Repro: `gh attestation verify caracal-console-darwin-amd64-v2026.05.27-rc.1.tar.gz --repo Garudex-Labs/caracal`
- **[info]** PASS: `caracal-shell-darwin-arm64-v2026.05.27-rc.1.tar.gz` (github/gh/-): attestation verified
  - Repro: `gh attestation verify caracal-shell-darwin-arm64-v2026.05.27-rc.1.tar.gz --repo Garudex-Labs/caracal`
- **[info]** PASS: `caracal-console-darwin-arm64-v2026.05.27-rc.1.tar.gz` (github/gh/-): attestation verified
  - Repro: `gh attestation verify caracal-console-darwin-arm64-v2026.05.27-rc.1.tar.gz --repo Garudex-Labs/caracal`
- **[info]** PASS: `caracal-shell-windows-amd64-v2026.05.27-rc.1.zip` (github/gh/-): attestation verified
  - Repro: `gh attestation verify caracal-shell-windows-amd64-v2026.05.27-rc.1.zip --repo Garudex-Labs/caracal`
- **[info]** PASS: `caracal-console-windows-amd64-v2026.05.27-rc.1.zip` (github/gh/-): attestation verified
  - Repro: `gh attestation verify caracal-console-windows-amd64-v2026.05.27-rc.1.zip --repo Garudex-Labs/caracal`
- **[info]** PASS: `ghcr.io/garudex-labs/caracal-api:v2026.05.27-rc.1` (ghcr/docker/-): image SLSA provenance found
  - Repro: `docker buildx imagetools inspect ghcr.io/garudex-labs/caracal-api:v2026.05.27-rc.1`
- **[info]** PASS: `ghcr.io/garudex-labs/caracal-sts:v2026.05.27-rc.1` (ghcr/docker/-): image SLSA provenance found
  - Repro: `docker buildx imagetools inspect ghcr.io/garudex-labs/caracal-sts:v2026.05.27-rc.1`
- **[info]** PASS: `ghcr.io/garudex-labs/caracal-gateway:v2026.05.27-rc.1` (ghcr/docker/-): image SLSA provenance found
  - Repro: `docker buildx imagetools inspect ghcr.io/garudex-labs/caracal-gateway:v2026.05.27-rc.1`
- **[info]** PASS: `ghcr.io/garudex-labs/caracal-audit:v2026.05.27-rc.1` (ghcr/docker/-): image SLSA provenance found
  - Repro: `docker buildx imagetools inspect ghcr.io/garudex-labs/caracal-audit:v2026.05.27-rc.1`
- **[info]** PASS: `ghcr.io/garudex-labs/caracal-coordinator:v2026.05.27-rc.1` (ghcr/docker/-): image SLSA provenance found
  - Repro: `docker buildx imagetools inspect ghcr.io/garudex-labs/caracal-coordinator:v2026.05.27-rc.1`
- **[info]** PASS: `ghcr.io/garudex-labs/caracal-control:v2026.05.27-rc.1` (ghcr/docker/-): image SLSA provenance found
  - Repro: `docker buildx imagetools inspect ghcr.io/garudex-labs/caracal-control:v2026.05.27-rc.1`
- **[info]** PASS: `ghcr.io/garudex-labs/caracal-postgres:v2026.05.27-rc.1` (ghcr/docker/-): image SLSA provenance found
  - Repro: `docker buildx imagetools inspect ghcr.io/garudex-labs/caracal-postgres:v2026.05.27-rc.1`
- **[info]** PASS: `ghcr.io/garudex-labs/caracal-redis:v2026.05.27-rc.1` (ghcr/docker/-): image SLSA provenance found
  - Repro: `docker buildx imagetools inspect ghcr.io/garudex-labs/caracal-redis:v2026.05.27-rc.1`
- **[info]** PASS: `ghcr.io/garudex-labs/caracal-runtime:v2026.05.27-rc.1` (ghcr/docker/-): image SLSA provenance found
  - Repro: `docker buildx imagetools inspect ghcr.io/garudex-labs/caracal-runtime:v2026.05.27-rc.1`


## Highest priority fixes

_No failing findings._

## Sign-off

- [ ] Compatibility matrix matches GitHub Release assets
- [ ] Registry metadata reviewed
- [ ] PyPI install matrix green
- [ ] npm install matrix green
- [ ] Runtime and Console binaries verified on all platforms
- [ ] Installers verified
- [ ] Containers boot cleanly
- [ ] Provenance verified
