# infra/scripts

## Scope

- Covers operator scripts for validating and operating the local infrastructure stack under `infra/scripts/`.

## Architecture Design

- Scripts in this directory probe running OSS services, support CI or local stack gates, and provide the backup/restore lifecycle for compose deployments.
- `backup.sh` and `restore.sh` resolve containers through compose labels so they stay independent of compose file paths and work against any project name.

## Required

- Must keep scripts executable, fail-fast, and runnable from the repository root.
- Must default local probes to loopback addresses unless explicitly configured otherwise.
- Must exit non-zero on the first failed health or readiness gate.

## Forbidden

- Must not store credentials or echo secret values.
- Must not bypass health gates with success-shaped fallbacks.
- Must not mutate service data while performing smoke checks.
- Must not include secrets in backup bundles; secret material is managed and backed up separately.

## Validation

- Validate script edits by running the touched script against a running local stack or with shell syntax checks.
- Run `shellcheck` on every touched script; all scripts must pass with zero findings.
