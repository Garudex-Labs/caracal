# Deployment and automation verification — November 6, 2026

## Scope and safety

Baseline: pristine archive of commit `b365fa5d85e43e5eacab1ab0cc42b272b770c9b4`. After measurements use the working tree, which already contained substantial application/dependency changes and received concurrent updates. Those changes were preserved; image/time deltas must not be attributed solely to this deployment work.

Execution used local Docker and a newly created `caracal-deployment-audit` kind cluster with a separate kubeconfig, generated credentials, and disposable data. No production deployment, cloud provisioning, repository-policy change, publishing, or operational credential rotation was performed.

## Compatibility matrix

| Repository path / method | Executed result | Boundary |
| --- | --- | --- |
| Source Docker Compose | **PASS**, Linux amd64; real distributed workflow, failures, upgrades, restore, shutdown | Isolated projects/dynamic ports; stock CLI `up` not run because normal ports were occupied by unrelated host processes |
| Released runtime Compose topology | **PASS** in **stable** mode, including backup/restore and repeated protected requests | Exact locally built images substituted; does not verify public registry publication or public TLS |
| Helm chart, dev profile | **PASS**, Kubernetes 1.32.2 / Helm 3.17.3; install, migrations, PVCs, protected workflow, workload restarts, same-version upgrades | Disposable Postgres/Redis; not an HA, ingress-controller, HPA, or observability-controller test |
| Helm rc/stable and AKS/EKS/GKE overlays | Render/guardrail tests **PASS** | Live managed stores, TLS, ingress, identities, and controllers not available/authorized |
| OpenTofu Kubernetes dev root | **PASS**, OpenTofu 1.11.5; actual namespace/Secret/Helm apply and distributed contracts under restricted Pod Security | Private local state, disposable kind only |
| OpenTofu Kubernetes production root | Init/validate **PASS** with committed provider locks | No production apply |
| `caracalHost` and AWS/Azure/GCP VM adapters; Azure VM environment | Init/validate and cloud-init rendering **PASS** | No VM/firewall/DNS/proxy created |
| Azure Container Apps, AWS ECS, GCP Cloud Run adapters | All render and negative-configuration tests **PASS** | No provider API deployment; no claim of live connectivity or recovery |
| Runtime launcher artifacts | All five targets compile; Linux amd64 `--version` / `--help` execute | Linux arm64, macOS x64/arm64, Windows x64 not executed; launcher image is not a standalone stack |
| POSIX/PowerShell installation and public releases | Installer/release fixture tests **PASS**; manifest/version drift checks **PASS** | No real public install, PowerShell execution, registry publishing, or OIDC/provenance run |

The protected workflow creates a managed application, resource, policy and policy set, waits for activation, opens nested SDK sessions through Coordinator/STS, accesses a protected upstream through Gateway, and confirms correlated token-exchange and gateway allow events through the Audit API. It is rerun after failures and recovery, not replaced with health probes.

## Implemented reliability/security changes

- Web image health probes `/ready` rather than dependency-free `/health`; both Compose files give the BFF 30 seconds to finish its 25-second drain window. Smoke tests include web readiness and the SPA.
- Backup bundles are owner-private, unique, and atomically published. Redis rewrite acceptance, scheduled/in-progress completion, and final status are checked; failures cannot publish a misleading successful backup.
- Restore uses the actual local helper image ID and mounts only the named persistent volume being repaired. It no longer inherits tmpfs and Secret mounts, contacts a registry, or grants the helper network access/default capabilities. Database identifiers are escaped and client/connection failures are no longer swallowed.
- Build contexts exclude operator state, secrets, backups, Terraform state/plans, and local test executables.
- VM bootstrap downloads fail separately from execution and uses the selected release's installer instead of mutable `main`. HTTPS is required for installer mirrors.
- OpenTofu dev accepts cluster-specific chart overrides. Module profile/evaluation/Secret identity remains authoritative even when overlays or `setValues` try to override it; this was verified in an actual plan without applying the conflicting configuration.
- New reusable Compose and kind harnesses exercise real contracts, restarts, same-version upgrades and recovery. Their credentials/state are disposable; the Compose harness rejects remote Docker contexts and does not inherit operator cloud/service credentials.

## CI/CD and release changes

- No workflow-level PR path filter can strand `Test status`; merge-queue events run the full suite.
- Change selection is a tested Node script, covers infrastructure/deployment/installer/toolchain paths, and treats renames as removal/addition.
- The aggregate status depends on and inspects **every** test job, including workflow invariants and Helm install. Mutation tests demonstrate that omitting Helm installation fails validation.
- Repository TypeScript coverage runs once; its lcov artifact is used by Codecov. The redundant workspace-build job is removed while native launcher smoke and full-event five-target compilation remain in the TypeScript job. Root ESLint is actually executed.
- Compose/Helm CI exercises protected requests after restarts/upgrades. Compose CI also tests dependency loss, missing configuration, persistent data, and backup/restore. Shared images build once and reuse BuildKit caches rather than starting another duplicate source stack.
- Release image creation time and `SOURCE_DATE_EPOCH` come from the immutable source commit. Two warm Go builds with fixed epoch/labels and provenance disabled produced identical image IDs: `sha256:d84510387825297aea530caff63607eb2eaa3e85506ed12e705bc94b00e7c35a`.
- HIGH/CRITICAL scans, including unfixed findings, gate source-image promotion to release tags. Public source-SHA images can already exist at that point; a failure blocks release-tag/downstream promotion, not the initial source-image upload. Dry-run multi-platform builds do not publish an image for that remote scan.
- Local `testCi.sh` no longer references absent audit/constraint scripts, and supports explicit infrastructure/deployment verification flags.

## Measurements

Single observed runs, not controlled benchmarks; caches, updated dependencies/base images and concurrent host work differ. Sizes are Docker-reported bytes converted to decimal MB.

| Measure | Before | After |
| --- | ---: | ---: |
| Five shared source images build | 113.4 s | 94.5 s intermediate; 61.6 s final incremental build |
| Source stack readiness | 26.2 s | 17.6 s final acceptance run |
| Stable runtime topology readiness | Not measured | 16.0 s final acceptance run |
| Source / stable application shutdown | Baseline aborted on the false-green health regression | 5.3 / 5.4 s; no SIGKILL/OOM |
| Shared Go image | 162.4 MB | 162.9 MB |
| Shared Node image | 311.7 MB | 333.6 MB |
| Web image | 301.7 MB | 316.4 MB |
| Postgres image | 442.8 MB | 436.1 MB |
| Redis image | 169.8 MB | 162.4 MB |
| Launcher image | 261.2 MB | 248.9 MB |

Node/web images became larger with the working tree's dependency/base refreshes; no size reduction is claimed for them. Resource snapshots are captured in the harness reports, but are insufficient to justify reducing production limits. New GitHub runner wall time was not measured: modified local workflows cannot be executed remotely before their changes are committed/pushed.

## Validation and remaining limitations

- Compose source: 36 acceptance checks; stable runtime: 35. Both recover deliberately deleted application data from a backup and pass the distributed contract afterward.
- Helm and OpenTofu installations each pass the protected contract before/after workload restarts and repeated upgrades. A private test upstream initially failed NetworkPolicy; adding a precisely scoped test rule fixed it. Independent installations must not share Redis consumer-group state; the OpenTofu check was isolated from the earlier Helm installation.
- Migration validation on a fresh Postgres 18 instance passes frozen-ledger, idempotency, concurrent-runner and schema checks. Its CI validator needs GNU host tools; an attempted BusyBox-only invocation was insufficient. The actual runtime migration script works in the Alpine image.
- Workflow invariants/actionlint, infrastructure ShellCheck, lint, typechecks, release manifest/version checks, docs builds, language tests and coverage were run. The latest full TypeScript run passed 3,438 tests (24 infrastructure-dependent skips), Go race coverage passed at 80.3%, and Python passed 509 tests with 92% coverage. Linux launcher smoke and all five cross-compilations were run. The final release/deployment regression subset passes 82 tests.
- Trivy 0.76.2 with a freshly fetched DB: final Go/Redis/Postgres images have **zero HIGH/CRITICAL findings**. Node and web each retain **two unfixed Debian zlib findings** (`CVE-2026-76844`, `CVE-2026-85091`). The tested Debian launcher retains **48 unfixed package findings**. These are not suppressed; the strict release promotion gate remains blocked until fixed images or independently reviewed remediations are available. This is not a clean-vulnerability claim.
- Read-only GitHub inspection found an active main-branch ruleset requiring review, but **no required status-check rule**. An authorized administrator still needs to require `Test status` and the intended security checks. Repository settings were not modified.
- OAuth/SMTP sign-in, public TLS, actual version-to-version/schema upgrades, HA/failover, autoscaling, multi-node storage, cloud identity/secret delivery, production restores, other CPU/OS execution, and remote publication were not verified. Same-version recreation is not proof of a new-version upgrade or zero downtime.
- Online backups are not one globally atomic cross-service snapshot. OS package repositories and provenance/attestation metadata remain mutable build inputs; fixed release digests reproduce deployments, not arbitrary cold builds byte-for-byte.

## Reproduce

See `src/content/docs/operations/deployment-verification.mdx` for complete isolated commands and safety boundaries. Core entrypoints:

```bash
pnpm install --frozen-lockfile
pnpm run build:typescript
node scripts/validateWorkflows.mjs
bash scripts/testCi.sh --infra
node infra/scripts/verifyDeployment.mjs --go-contracts --image-tag verify-local --report .caracal/deployment-source.json
node infra/scripts/verifyDeployment.mjs --mode runtime --skip-build --image-tag verify-local --report .caracal/deployment-runtime.json
# After installing the dev chart in a disposable kind-caracal-* context:
CARACAL_VERIFY_DISPOSABLE=yes bash infra/helm/caracal/scripts/verifyInstall.sh
```

Raw local evidence was collected under `/tmp/caracal-deployment-audit`; sensitive fixture files/state are private and are not release artifacts. No blanket vulnerability exceptions or unrelated application refactoring were introduced by this deployment work.
