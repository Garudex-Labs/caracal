# Dependency and security maintenance — November 6, 2026

## Scope and changes

This pass reviewed npm and Python manifests and locks, every Go module and
checksum set, container builds, PostgreSQL migration checksums, OpenTofu provider
locks, Helm and cloud configuration, GitHub Actions, dependency automation,
license metadata, and working-tree/history secret findings. Unrelated changes
from concurrent work in the shared checkout were preserved.

- Updated range-compatible npm dependencies and raised vulnerable direct-package
  minimums. The initial npm audit reported 54 findings, including three critical
  findings; the final audit reports none. Security overrides now select patched
  Vite, DOMPurify, Undici, URI/query parsers, KaTeX, glob, and minimatch versions.
  Vitest and its coverage provider are both pinned to 4.1.12.
- Removed the stale OpenTelemetry core override that violated SDK dependency
  versions, retained API 1.9.1 for the SDK 2.x peer contract, and enabled strict
  peer validation. Node type definitions and container builders now consistently
  target Node 24. TypeScript 7, Vitest 5, Mermaid 12, and other breaking upgrades
  were not adopted simply to obtain a newer version number.
- Updated vulnerable Python certificate, DNS, and ASN.1 dependencies and
  regenerated their SHA256 locks. The test lock now satisfies the SDK's
  `idna>=3.18` requirement. Hatchling is hash-locked for editable installs and
  release builds; build isolation no longer downloads an unpinned backend.
  Twine 7 was necessary to validate Hatchling's Metadata-Version 2.5 output.
- Updated Go HTTP/2 and compression dependencies, synchronized workspace/module
  sums, and pinned container compilation to the patched Go 1.26.10 toolchain.
  PostgreSQL's upstream gosu 1.19 is rebuilt from its immutable release commit
  using a separate, checksum-verified Go tool module. Its user parser is pinned
  to 0.5.0: the initial 0.4.1 security patch failed upstream group-parser tests;
  0.5.0 passes those tests and the vulnerability scan.
- Updated and verified container digest pins. Node/Go service runtime bases use
  Debian 13 distroless images. Native Argon2 hashing/verification was exercised
  inside the rebuilt Node image. Dependency cleanup preserves license/notice
  files rather than deleting every Markdown file.
- Updated compatible GitHub Actions using verified commit SHAs, including the
  actual CodeQL action release rather than its separately versioned bundle.
  Added imported-code Go scanning, npm audit/peer gates, and Python lock/manifest
  validation to existing CI. Checkout credential retention is rejected by the
  workflow validator. Expired container exceptions were removed; high/critical
  container findings now fail visibly and SARIF is uploaded on failure.
- Added OpenTofu dependency-update coverage and read-only lock validation.
  Removed stale Docker updater directories. Registered standalone performance
  entries with Knip and made their scoped service dependency loaders explicit,
  without retaining an unnecessary root Redis dependency. Removed a deprecated
  Fastify option and fixed router error typing, provider failover compatibility,
  and tests that incorrectly depended on the invoking terminal's color flags.

## Verified results

Validation used isolated snapshots where concurrent test runners would otherwise
share staged Go tests or coverage output. Temporary-directory quota exhaustion
and Vitest worker startup errors were investigated rather than counted as passes.

| Check                                                                       | Result                                                |
| --------------------------------------------------------------------------- | ----------------------------------------------------- |
| Clean npm installation, frozen offline reinstall, pristine store integrity  | Passed                                                |
| npm audit and peer validation                                               | Zero advisories; no peer issues                       |
| All three Python tooling lock audits                                        | Zero advisories                                       |
| Python installation, dependency consistency, and `pip check`                | Passed                                                |
| Python wheels and source distributions, Twine validation, installed imports | All ten packages / twenty artifacts passed            |
| Python tests                                                                | 509 passed                                            |
| TypeScript package test harness                                             | All 18 package suites passed in the isolated checkout |
| Current TypeScript builds, type checks, lint, targeted regression checks    | Passed; existing React Refresh warnings remain        |
| Go race tests and Go vet                                                    | Passed in the isolated checkout                       |
| Go module verification and imported-code vulnerability scans                | Passed; see module-only finding below                 |
| Two independent static builds of STS, Gateway, and Audit                    | Identical SHA256 hashes for each pair                 |
| PostgreSQL migration integrity and migration/schema tests                   | Passed                                                |
| PostgreSQL-backed TypeScript integration tests                              | Five files / 28 tests passed                          |
| Documentation build and version verification                                | Passed                                                |
| Helm validation and OpenTofu formatting/read-only validation                | Passed                                                |
| Workflow invariants, actionlint, maintenance source formatting, Knip        | Passed                                                |
| Six Linux/amd64 images and compiled runtime CLI smoke test                  | Built/scanned; CLI and native addon checks passed     |

The final complete coverage run passed: 246 files and 3,435 tests, with four
files / 22 tests skipped under their existing conditions. Coverage was 81.07%
statements, 75% branches, 74.32% functions, and 83.68% lines, exceeding all four
unchanged repository thresholds. The full run was repeated with one worker and
a disk-backed temporary directory after earlier worker-startup and temporary
quota failures; neither failed attempts nor threshold-only results were counted
as passing runs.

## Remaining findings and verification limits

The final unsuppressed Trivy image scans are **not clean**:

| Image              | Remaining findings                                |
| ------------------ | ------------------------------------------------- |
| PostgreSQL, Redis  | None                                              |
| Go services        | One UNKNOWN module-level finding                  |
| Node services, web | Two HIGH, 35 MEDIUM, eight LOW findings per image |
| Runtime CLI image  | 48 HIGH, 75 MEDIUM, 61 LOW findings               |

The Node/web HIGH findings are Debian zlib advisories CVE-2026-76844 and
CVE-2026-85091. The runtime image additionally carries unresolved Debian system
package findings. The scanner supplies no Debian fixed versions for these HIGH
findings. They were not suppressed or represented as repaired, and the scheduled
container gate will remain red while qualifying findings remain.

GO-2026-5932 remains visible in module-wide scans of `golang.org/x/crypto`.
Caracal does not import the affected OpenPGP packages; imported-package/symbol
scans found zero affected imported packages or reachable vulnerabilities. There
is no patched stable module release to select without adopting the untagged
OpenPGP split. No exception hides this finding.

License review identified documentation-build libvips LGPL metadata and khroma's
MIT license file despite missing package metadata. Required notices are retained;
this is not a certification of downstream redistribution compliance. Working-tree
secret matches reviewed were fixtures or constant identifiers. The redacted
history scan still contains 100 findings; historical credential validity/rotation
cannot be established from source alone, so no clean-history claim is made.

Provider packages loaded and validated against existing locks read-only, but
provider-version freshness could not be independently checked: the OpenTofu
versions endpoints returned HTTP 403. Cloud apply, hosted GitHub workflow runs,
production deployments, optional framework installations, and execution on
macOS/Windows/arm64 were not performed. Existing published 1.0.0 releases were
not rewritten or republished; a new release is required to distribute changes.

Dependency resolution and the tested Go binaries are reproducible. Container
builds still consume live apt/apk security repositories and provenance metadata,
so byte-identical container rebuilds across different dates are not claimed.
The host's Go 1.27.2 is also not the patched toolchain used for verification;
update that host line to 1.27.3 rather than treating a newer minor as necessarily
secure. Global host toolchain settings were not changed.
