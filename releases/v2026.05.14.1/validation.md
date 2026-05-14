---
title: v2026.05.14.1 Release Validation Report
---

# Caracal v2026.05.14.1 Release Validation

**Published:** 2026-05-14
**Ecosystem quality score:** 99% (pass / total checks)
**Total blockers:** 0

## Compatibility matrix

### CLI / TUI binaries

| Artifact | Version |
| --- | --- |
| `cli` | 2026.05.14.1 |
| `tui` | 2026.05.14.1 |

### Container images (ghcr.io/garudex-labs)

| Artifact | Version |
| --- | --- |
| `ghcr.io/garudex-labs/caracal-api` | v2026.05.14.1 |
| `ghcr.io/garudex-labs/caracal-coordinator` | v2026.05.14.1 |
| `ghcr.io/garudex-labs/caracal-audit` | v2026.05.14.1 |
| `ghcr.io/garudex-labs/caracal-gateway` | v2026.05.14.1 |
| `ghcr.io/garudex-labs/caracal-sts` | v2026.05.14.1 |

### PyPI packages

| Artifact | Version |
| --- | --- |
| `caracalai-core` | 0.1.1 |
| `caracalai-identity` | 0.1.1 |
| `caracalai-revocation` | 0.1.1 |
| `caracalai-sdk` | 0.1.1 |
| `caracalai-transport-mcp` | 0.1.1 |
| `caracalai-mcp-fastmcp` | 0.1.1 |
| `caracalai-revocation-redis` | 0.1.1 |

### npm packages

| Artifact | Version |
| --- | --- |
| `@caracalai/core` | 0.1.1 |
| `@caracalai/sdk` | 0.1.1 |
| `@caracalai/identity` | 0.1.1 |
| `@caracalai/revocation` | 0.1.1 |
| `@caracalai/oauth` | 0.1.1 |
| `@caracalai/admin` | 0.1.1 |
| `@caracalai/transport-a2a` | 0.1.1 |
| `@caracalai/transport-mcp` | 0.1.1 |
| `@caracalai/mcp-express` | 0.1.1 |
| `@caracalai/mcp-fastmcp` | 0.1.1 |
| `@caracalai/tokenstate-postgres` | 0.1.1 |
| `@caracalai/revocation-redis` | 0.1.1 |


## Summary

| Area | Pass | Warn | Fail | Blockers |
| --- | --- | --- | --- | --- |
| Registry Metadata | 19 | 0 | 0 | 0 |
| PyPI Install Matrix | 7 | 0 | 0 | 0 |
| npm Install Matrix | 12 | 0 | 0 | 0 |
| CLI Binaries | 5 | 0 | 0 | 0 |
| TUI Binaries | 5 | 0 | 0 | 0 |
| Installers | 1 | 1 | 0 | 0 |
| Container Stack | 6 | 0 | 0 | 0 |
| Provenance & Signing | 15 | 0 | 0 | 0 |
| Docs & Examples | 1 | 0 | 0 | 0 |

## Severity rubric

- **blocker** — artifact is unusable for consumers (download fails, install errors, signature invalid)
- **major** — published but a contract is broken (wrong version, missing export, broken healthcheck)
- **minor** — cosmetic or documentation issue
- **info** — informational only

## Findings

### Registry Metadata

- **[info]** PASS — `caracalai-core` (registry/pypi/-): dry-run: would check https://pypi.org/pypi/caracalai-core/json for 0.1.1
  - Repro: `curl -fsSL https://pypi.org/pypi/caracalai-core/json`
- **[info]** PASS — `caracalai-identity` (registry/pypi/-): dry-run: would check https://pypi.org/pypi/caracalai-identity/json for 0.1.1
  - Repro: `curl -fsSL https://pypi.org/pypi/caracalai-identity/json`
- **[info]** PASS — `caracalai-revocation` (registry/pypi/-): dry-run: would check https://pypi.org/pypi/caracalai-revocation/json for 0.1.1
  - Repro: `curl -fsSL https://pypi.org/pypi/caracalai-revocation/json`
- **[info]** PASS — `caracalai-sdk` (registry/pypi/-): dry-run: would check https://pypi.org/pypi/caracalai-sdk/json for 0.1.1
  - Repro: `curl -fsSL https://pypi.org/pypi/caracalai-sdk/json`
- **[info]** PASS — `caracalai-transport-mcp` (registry/pypi/-): dry-run: would check https://pypi.org/pypi/caracalai-transport-mcp/json for 0.1.1
  - Repro: `curl -fsSL https://pypi.org/pypi/caracalai-transport-mcp/json`
- **[info]** PASS — `caracalai-mcp-fastmcp` (registry/pypi/-): dry-run: would check https://pypi.org/pypi/caracalai-mcp-fastmcp/json for 0.1.1
  - Repro: `curl -fsSL https://pypi.org/pypi/caracalai-mcp-fastmcp/json`
- **[info]** PASS — `caracalai-revocation-redis` (registry/pypi/-): dry-run: would check https://pypi.org/pypi/caracalai-revocation-redis/json for 0.1.1
  - Repro: `curl -fsSL https://pypi.org/pypi/caracalai-revocation-redis/json`
- **[info]** PASS — `@caracalai/core` (registry/npm/-): dry-run: would check https://registry.npmjs.org/@caracalai/core for 0.1.1
  - Repro: `curl -fsSL https://registry.npmjs.org/@caracalai/core`
- **[info]** PASS — `@caracalai/sdk` (registry/npm/-): dry-run: would check https://registry.npmjs.org/@caracalai/sdk for 0.1.1
  - Repro: `curl -fsSL https://registry.npmjs.org/@caracalai/sdk`
- **[info]** PASS — `@caracalai/identity` (registry/npm/-): dry-run: would check https://registry.npmjs.org/@caracalai/identity for 0.1.1
  - Repro: `curl -fsSL https://registry.npmjs.org/@caracalai/identity`
- **[info]** PASS — `@caracalai/revocation` (registry/npm/-): dry-run: would check https://registry.npmjs.org/@caracalai/revocation for 0.1.1
  - Repro: `curl -fsSL https://registry.npmjs.org/@caracalai/revocation`
- **[info]** PASS — `@caracalai/oauth` (registry/npm/-): dry-run: would check https://registry.npmjs.org/@caracalai/oauth for 0.1.1
  - Repro: `curl -fsSL https://registry.npmjs.org/@caracalai/oauth`
- **[info]** PASS — `@caracalai/admin` (registry/npm/-): dry-run: would check https://registry.npmjs.org/@caracalai/admin for 0.1.1
  - Repro: `curl -fsSL https://registry.npmjs.org/@caracalai/admin`
- **[info]** PASS — `@caracalai/transport-a2a` (registry/npm/-): dry-run: would check https://registry.npmjs.org/@caracalai/transport-a2a for 0.1.1
  - Repro: `curl -fsSL https://registry.npmjs.org/@caracalai/transport-a2a`
- **[info]** PASS — `@caracalai/transport-mcp` (registry/npm/-): dry-run: would check https://registry.npmjs.org/@caracalai/transport-mcp for 0.1.1
  - Repro: `curl -fsSL https://registry.npmjs.org/@caracalai/transport-mcp`
- **[info]** PASS — `@caracalai/mcp-express` (registry/npm/-): dry-run: would check https://registry.npmjs.org/@caracalai/mcp-express for 0.1.1
  - Repro: `curl -fsSL https://registry.npmjs.org/@caracalai/mcp-express`
- **[info]** PASS — `@caracalai/mcp-fastmcp` (registry/npm/-): dry-run: would check https://registry.npmjs.org/@caracalai/mcp-fastmcp for 0.1.1
  - Repro: `curl -fsSL https://registry.npmjs.org/@caracalai/mcp-fastmcp`
- **[info]** PASS — `@caracalai/tokenstate-postgres` (registry/npm/-): dry-run: would check https://registry.npmjs.org/@caracalai/tokenstate-postgres for 0.1.1
  - Repro: `curl -fsSL https://registry.npmjs.org/@caracalai/tokenstate-postgres`
- **[info]** PASS — `@caracalai/revocation-redis` (registry/npm/-): dry-run: would check https://registry.npmjs.org/@caracalai/revocation-redis for 0.1.1
  - Repro: `curl -fsSL https://registry.npmjs.org/@caracalai/revocation-redis`

### PyPI Install Matrix

- **[info]** PASS — `caracalai-core` (linux-amd64/pip/py3.12): install + import ok @ 0.1.1
  - Repro: `pip install caracalai-core==0.1.1`
- **[info]** PASS — `caracalai-identity` (linux-amd64/pip/py3.12): install + import ok @ 0.1.1
  - Repro: `pip install caracalai-identity==0.1.1`
- **[info]** PASS — `caracalai-revocation` (linux-amd64/pip/py3.12): install + import ok @ 0.1.1
  - Repro: `pip install caracalai-revocation==0.1.1`
- **[info]** PASS — `caracalai-sdk` (linux-amd64/pip/py3.12): install + import ok @ 0.1.1
  - Repro: `pip install caracalai-sdk==0.1.1`
- **[info]** PASS — `caracalai-transport-mcp` (linux-amd64/pip/py3.12): install + import ok @ 0.1.1
  - Repro: `pip install caracalai-transport-mcp==0.1.1`
- **[info]** PASS — `caracalai-mcp-fastmcp` (linux-amd64/pip/py3.12): install + import ok @ 0.1.1
  - Repro: `pip install caracalai-mcp-fastmcp==0.1.1`
- **[info]** PASS — `caracalai-revocation-redis` (linux-amd64/pip/py3.12): install + import ok @ 0.1.1
  - Repro: `pip install caracalai-revocation-redis==0.1.1`

### npm Install Matrix

- **[info]** PASS — `@caracalai/core` (linux-amd64/npm/node22): install + ESM import ok @ 0.1.1
  - Repro: `npm add @caracalai/core@0.1.1`
- **[info]** PASS — `@caracalai/sdk` (linux-amd64/npm/node22): install + ESM import ok @ 0.1.1
  - Repro: `npm add @caracalai/sdk@0.1.1`
- **[info]** PASS — `@caracalai/identity` (linux-amd64/npm/node22): install + ESM import ok @ 0.1.1
  - Repro: `npm add @caracalai/identity@0.1.1`
- **[info]** PASS — `@caracalai/revocation` (linux-amd64/npm/node22): install + ESM import ok @ 0.1.1
  - Repro: `npm add @caracalai/revocation@0.1.1`
- **[info]** PASS — `@caracalai/oauth` (linux-amd64/npm/node22): install + ESM import ok @ 0.1.1
  - Repro: `npm add @caracalai/oauth@0.1.1`
- **[info]** PASS — `@caracalai/admin` (linux-amd64/npm/node22): install + ESM import ok @ 0.1.1
  - Repro: `npm add @caracalai/admin@0.1.1`
- **[info]** PASS — `@caracalai/transport-a2a` (linux-amd64/npm/node22): install + ESM import ok @ 0.1.1
  - Repro: `npm add @caracalai/transport-a2a@0.1.1`
- **[info]** PASS — `@caracalai/transport-mcp` (linux-amd64/npm/node22): install + ESM import ok @ 0.1.1
  - Repro: `npm add @caracalai/transport-mcp@0.1.1`
- **[info]** PASS — `@caracalai/mcp-express` (linux-amd64/npm/node22): install + ESM import ok @ 0.1.1
  - Repro: `npm add @caracalai/mcp-express@0.1.1`
- **[info]** PASS — `@caracalai/mcp-fastmcp` (linux-amd64/npm/node22): install + ESM import ok @ 0.1.1
  - Repro: `npm add @caracalai/mcp-fastmcp@0.1.1`
- **[info]** PASS — `@caracalai/tokenstate-postgres` (linux-amd64/npm/node22): install + ESM import ok @ 0.1.1
  - Repro: `npm add @caracalai/tokenstate-postgres@0.1.1`
- **[info]** PASS — `@caracalai/revocation-redis` (linux-amd64/npm/node22): install + ESM import ok @ 0.1.1
  - Repro: `npm add @caracalai/revocation-redis@0.1.1`

### CLI Binaries

- **[info]** PASS — `caracal-cli-linux-amd64-v2026.05.14.1.tar.gz` (linux-amd64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`
- **[info]** PASS — `caracal-cli-linux-arm64-v2026.05.14.1.tar.gz` (linux-arm64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`
- **[info]** PASS — `caracal-cli-darwin-amd64-v2026.05.14.1.tar.gz` (darwin-amd64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`
- **[info]** PASS — `caracal-cli-darwin-arm64-v2026.05.14.1.tar.gz` (darwin-arm64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`
- **[info]** PASS — `caracal-cli-windows-amd64-v2026.05.14.1.zip` (windows-amd64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`

### TUI Binaries

- **[info]** PASS — `caracal-tui-linux-amd64-v2026.05.14.1.tar.gz` (linux-amd64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`
- **[info]** PASS — `caracal-tui-linux-arm64-v2026.05.14.1.tar.gz` (linux-arm64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`
- **[info]** PASS — `caracal-tui-darwin-amd64-v2026.05.14.1.tar.gz` (darwin-amd64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`
- **[info]** PASS — `caracal-tui-darwin-arm64-v2026.05.14.1.tar.gz` (darwin-arm64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`
- **[info]** PASS — `caracal-tui-windows-amd64-v2026.05.14.1.zip` (windows-amd64/github/-): checksum ok; not host-executable
  - Repro: `sha256 check`

### Installers

- **[info]** PASS — `install.sh` (linux-amd64/shell/-): installer placed caracal on PATH
  - Repro: `bash install.sh --version v2026.05.14.1`
- **[info]** WARN — `install.ps1` (linux-amd64/pwsh/-): PowerShell installer is only exercised on Windows runners
  - Repro: `pwsh -File install.ps1 -Version v2026.05.14.1`

### Container Stack

- **[info]** PASS — `ghcr.io/garudex-labs/caracal-api:v2026.05.14.1` (linux-amd64/ghcr/docker): image pulled
  - Repro: `docker pull ghcr.io/garudex-labs/caracal-api:v2026.05.14.1`
- **[info]** PASS — `ghcr.io/garudex-labs/caracal-coordinator:v2026.05.14.1` (linux-amd64/ghcr/docker): image pulled
  - Repro: `docker pull ghcr.io/garudex-labs/caracal-coordinator:v2026.05.14.1`
- **[info]** PASS — `ghcr.io/garudex-labs/caracal-audit:v2026.05.14.1` (linux-amd64/ghcr/docker): image pulled
  - Repro: `docker pull ghcr.io/garudex-labs/caracal-audit:v2026.05.14.1`
- **[info]** PASS — `ghcr.io/garudex-labs/caracal-gateway:v2026.05.14.1` (linux-amd64/ghcr/docker): image pulled
  - Repro: `docker pull ghcr.io/garudex-labs/caracal-gateway:v2026.05.14.1`
- **[info]** PASS — `ghcr.io/garudex-labs/caracal-sts:v2026.05.14.1` (linux-amd64/ghcr/docker): image pulled
  - Repro: `docker pull ghcr.io/garudex-labs/caracal-sts:v2026.05.14.1`
- **[info]** PASS — `stack` (linux-amd64/compose/docker): compose up succeeded
  - Repro: `docker compose up -d`

### Provenance & Signing

- **[info]** PASS — `caracal-cli-linux-amd64-v2026.05.14.1.tar.gz` (github/gh/-): attestation verified
  - Repro: `gh attestation verify caracal-cli-linux-amd64-v2026.05.14.1.tar.gz --repo Garudex-Labs/caracal`
- **[info]** PASS — `caracal-tui-linux-amd64-v2026.05.14.1.tar.gz` (github/gh/-): attestation verified
  - Repro: `gh attestation verify caracal-tui-linux-amd64-v2026.05.14.1.tar.gz --repo Garudex-Labs/caracal`
- **[info]** PASS — `caracal-cli-linux-arm64-v2026.05.14.1.tar.gz` (github/gh/-): attestation verified
  - Repro: `gh attestation verify caracal-cli-linux-arm64-v2026.05.14.1.tar.gz --repo Garudex-Labs/caracal`
- **[info]** PASS — `caracal-tui-linux-arm64-v2026.05.14.1.tar.gz` (github/gh/-): attestation verified
  - Repro: `gh attestation verify caracal-tui-linux-arm64-v2026.05.14.1.tar.gz --repo Garudex-Labs/caracal`
- **[info]** PASS — `caracal-cli-darwin-amd64-v2026.05.14.1.tar.gz` (github/gh/-): attestation verified
  - Repro: `gh attestation verify caracal-cli-darwin-amd64-v2026.05.14.1.tar.gz --repo Garudex-Labs/caracal`
- **[info]** PASS — `caracal-tui-darwin-amd64-v2026.05.14.1.tar.gz` (github/gh/-): attestation verified
  - Repro: `gh attestation verify caracal-tui-darwin-amd64-v2026.05.14.1.tar.gz --repo Garudex-Labs/caracal`
- **[info]** PASS — `caracal-cli-darwin-arm64-v2026.05.14.1.tar.gz` (github/gh/-): attestation verified
  - Repro: `gh attestation verify caracal-cli-darwin-arm64-v2026.05.14.1.tar.gz --repo Garudex-Labs/caracal`
- **[info]** PASS — `caracal-tui-darwin-arm64-v2026.05.14.1.tar.gz` (github/gh/-): attestation verified
  - Repro: `gh attestation verify caracal-tui-darwin-arm64-v2026.05.14.1.tar.gz --repo Garudex-Labs/caracal`
- **[info]** PASS — `caracal-cli-windows-amd64-v2026.05.14.1.zip` (github/gh/-): attestation verified
  - Repro: `gh attestation verify caracal-cli-windows-amd64-v2026.05.14.1.zip --repo Garudex-Labs/caracal`
- **[info]** PASS — `caracal-tui-windows-amd64-v2026.05.14.1.zip` (github/gh/-): attestation verified
  - Repro: `gh attestation verify caracal-tui-windows-amd64-v2026.05.14.1.zip --repo Garudex-Labs/caracal`
- **[info]** PASS — `ghcr.io/garudex-labs/caracal-api:v2026.05.14.1` (ghcr/cosign/-): dry-run: would cosign verify ghcr.io/garudex-labs/caracal-api:v2026.05.14.1
  - Repro: `cosign verify ghcr.io/garudex-labs/caracal-api:v2026.05.14.1`
- **[info]** PASS — `ghcr.io/garudex-labs/caracal-coordinator:v2026.05.14.1` (ghcr/cosign/-): dry-run: would cosign verify ghcr.io/garudex-labs/caracal-coordinator:v2026.05.14.1
  - Repro: `cosign verify ghcr.io/garudex-labs/caracal-coordinator:v2026.05.14.1`
- **[info]** PASS — `ghcr.io/garudex-labs/caracal-audit:v2026.05.14.1` (ghcr/cosign/-): dry-run: would cosign verify ghcr.io/garudex-labs/caracal-audit:v2026.05.14.1
  - Repro: `cosign verify ghcr.io/garudex-labs/caracal-audit:v2026.05.14.1`
- **[info]** PASS — `ghcr.io/garudex-labs/caracal-gateway:v2026.05.14.1` (ghcr/cosign/-): dry-run: would cosign verify ghcr.io/garudex-labs/caracal-gateway:v2026.05.14.1
  - Repro: `cosign verify ghcr.io/garudex-labs/caracal-gateway:v2026.05.14.1`
- **[info]** PASS — `ghcr.io/garudex-labs/caracal-sts:v2026.05.14.1` (ghcr/cosign/-): dry-run: would cosign verify ghcr.io/garudex-labs/caracal-sts:v2026.05.14.1
  - Repro: `cosign verify ghcr.io/garudex-labs/caracal-sts:v2026.05.14.1`

### Docs & Examples

- **[info]** PASS — `lynxCapital` (linux-amd64/pnpm/-): example install ok with manifest pins
  - Repro: `pnpm install`


## Highest priority fixes

_No failing findings._

## Sign-off

- [ ] Compatibility matrix matches GitHub Release assets
- [ ] Registry metadata reviewed
- [ ] PyPI install matrix green
- [ ] npm install matrix green
- [ ] CLI / TUI binaries verified on all platforms
- [ ] Installers verified
- [ ] Containers boot cleanly
- [ ] Provenance verified
- [ ] Examples run against released packages
