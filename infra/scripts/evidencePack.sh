#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Generates a reproducible evidence pack that demonstrates Caracal's assurance
# case: supply-chain provenance, schema-level enforcement, and runtime readiness.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${OUT_DIR:-${ROOT}/evidence}/caracal-evidence-${STAMP}"
RAW_DIR="${OUT_DIR}/raw"
REPORT="${OUT_DIR}/REPORT.md"
REGISTRY="${CARACAL_REGISTRY:-ghcr.io/garudex-labs}"
HOST="${CARACAL_SMOKE_HOST:-127.0.0.1}"
IMAGES=(caracal-go caracal-node caracal-postgres caracal-redis caracal-runtime)

mkdir -p "${RAW_DIR}"

declare -a NAMES STATUSES DETAILS PILLARS LOGS
failures=0

record() {
    PILLARS+=("$1")
    NAMES+=("$2")
    STATUSES+=("$3")
    DETAILS+=("$4")
    LOGS+=("$5")
    [ "$3" = "FAIL" ] && failures=$((failures + 1))
    printf '  %-6s %s\n' "$3" "$2"
}

# 1. Supply chain: signed provenance and SBOM on every published image.
provenance() {
    local log="${RAW_DIR}/provenance.log"
    if ! command -v gh >/dev/null 2>&1; then
        record "Supply chain" "Release provenance" "SKIPPED" "gh CLI not installed" "raw/provenance.log"
        echo "gh CLI not installed; skipped." >"${log}"
        return
    fi
    if [ -z "${CARACAL_VERSION:-}" ]; then
        record "Supply chain" "Release provenance" "SKIPPED" "set CARACAL_VERSION to a release tag" "raw/provenance.log"
        echo "CARACAL_VERSION not set; skipped." >"${log}"
        return
    fi
    : >"${log}"
    local ok=1
    for image in "${IMAGES[@]}"; do
        local ref="oci://${REGISTRY}/${image}:${CARACAL_VERSION}"
        echo "### gh attestation verify ${ref}" >>"${log}"
        if gh attestation verify "${ref}" --repo Garudex-Labs/caracal >>"${log}" 2>&1; then
            echo "verified ${image}" >>"${log}"
        else
            echo "FAILED ${image}" >>"${log}"
            ok=0
        fi
    done
    if [ "${ok}" -eq 1 ]; then
        record "Supply chain" "Release provenance" "PASS" "all images carry workflow-issued provenance" "raw/provenance.log"
    else
        record "Supply chain" "Release provenance" "FAIL" "see log for the unverified image" "raw/provenance.log"
    fi
}

# 2. Schema enforcement: fail-closed RLS, append-only audit, immutable policy.
schema() {
    local log="${RAW_DIR}/schema-enforcement.log"
    if [ -z "${PGPASSWORD:-}" ] || ! command -v psql >/dev/null 2>&1; then
        record "Enforcement (data)" "Schema enforcement" "SKIPPED" "set PGPASSWORD and point at the database" "raw/schema-enforcement.log"
        echo "PGPASSWORD unset or psql missing; skipped." >"${log}"
        return
    fi
    if bash "${ROOT}/infra/postgres/scripts/validateMigrations.sh" >"${log}" 2>&1; then
        record "Enforcement (data)" "Schema enforcement" "PASS" "RLS fail-closed, append-only audit, immutable policy versions" "raw/schema-enforcement.log"
    else
        record "Enforcement (data)" "Schema enforcement" "FAIL" "validateMigrations.sh reported a failing check" "raw/schema-enforcement.log"
    fi
}

# 3. Runtime enforcement: every mediation point answers readiness.
runtime() {
    local log="${RAW_DIR}/runtime-readiness.log"
    if ! command -v curl >/dev/null 2>&1; then
        record "Enforcement (runtime)" "Runtime readiness" "SKIPPED" "curl not installed" "raw/runtime-readiness.log"
        echo "curl missing; skipped." >"${log}"
        return
    fi
    if CARACAL_SMOKE_HOST="${HOST}" bash "${ROOT}/infra/scripts/smokeTest.sh" >"${log}" 2>&1; then
        record "Enforcement (runtime)" "Runtime readiness" "PASS" "API, STS, Gateway, Audit, Coordinator answer /ready" "raw/runtime-readiness.log"
    else
        record "Enforcement (runtime)" "Runtime readiness" "FAIL" "a mediation point did not answer readiness" "raw/runtime-readiness.log"
    fi
}

# 4. Assurance case: the written threat model the checks above demonstrate.
threatModel() {
    local src="${ROOT}/governance/THREAT_MODEL.md"
    if [ -f "${src}" ]; then
        cp "${src}" "${RAW_DIR}/THREAT_MODEL.md"
        record "Assurance case" "Threat model" "PASS" "governance/THREAT_MODEL.md captured with this pack" "raw/THREAT_MODEL.md"
    else
        record "Assurance case" "Threat model" "FAIL" "governance/THREAT_MODEL.md not found" ""
    fi
}

echo "Generating Caracal evidence pack -> ${OUT_DIR}"
provenance
schema
runtime
threatModel

git_rev="$(git -C "${ROOT}" rev-parse --short HEAD 2>/dev/null || echo unknown)"

{
    echo "# Caracal Evidence Pack"
    echo ""
    echo "Demonstrated assurance for this Caracal deployment. Each row links a"
    echo "claim from the assurance case to a check that was run against this"
    echo "release, with the raw output captured alongside this report."
    echo ""
    echo "| Field | Value |"
    echo "| --- | --- |"
    echo "| Generated (UTC) | ${STAMP} |"
    echo "| Source revision | ${git_rev} |"
    echo "| Release tag | ${CARACAL_VERSION:-not provided} |"
    echo "| Registry | ${REGISTRY} |"
    echo ""
    echo "## Summary"
    echo ""
    echo "| Pillar | Check | Status | Evidence |"
    echo "| --- | --- | --- | --- |"
    for i in "${!NAMES[@]}"; do
        link="${LOGS[$i]}"
        [ -n "${link}" ] && link="[\`${link}\`](./${link})"
        echo "| ${PILLARS[$i]} | ${NAMES[$i]} | ${STATUSES[$i]} | ${link:--} |"
    done
    echo ""
    echo "## Checks"
    echo ""
    for i in "${!NAMES[@]}"; do
        echo "### ${NAMES[$i]} - ${STATUSES[$i]}"
        echo ""
        echo "${DETAILS[$i]}"
        echo ""
        [ -n "${LOGS[$i]}" ] && echo "Raw output: [\`${LOGS[$i]}\`](./${LOGS[$i]})"
        echo ""
    done
    echo "## Reading This Pack"
    echo ""
    echo "A distributed topology is not the same as a large attack surface. This"
    echo "pack converts the topology into demonstrated assurance: provenance proves"
    echo "what you run was built by the Caracal release workflow, schema enforcement"
    echo "proves the data layer is fail-closed and tamper-evident independent of"
    echo "application code, and runtime readiness proves every mediation point is"
    echo "live. \`raw/THREAT_MODEL.md\` is the written assurance case these checks"
    echo "exercise."
} >"${REPORT}"

echo ""
echo "Report written to ${REPORT}"
if [ "${failures}" -ne 0 ]; then
    echo "Evidence pack recorded ${failures} failing check(s)." >&2
    exit 1
fi
echo "All executed checks passed."
