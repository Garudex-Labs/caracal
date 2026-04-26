#!/usr/bin/env python3
"""Forbidden-marker scanner for hard-cut implementation gating.

This scanner supports three operational modes:
1. ``scan``: report current marker counts across repositories.
2. ``baseline``: persist a snapshot report for historical audits.
3. ``gate``: strict-zero enforcement; any forbidden marker hit fails.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCAN_REPO_KEYS: tuple[str, ...] = ("opensource", "enterprise")


@dataclass(frozen=True)
class MarkerDefinition:
    key: str
    description: str
    pattern: str
    owner_phase: str = "Phase 13"
    repos: tuple[str, ...] = field(default_factory=lambda: SCAN_REPO_KEYS)


MARKER_DEFINITIONS: tuple[MarkerDefinition, ...] = (
    MarkerDefinition(
        key="sync_engine_imports",
        description="Legacy SyncEngine imports/usages",
        pattern=r"(from\s+caracal\.deployment\.sync_engine\s+import|import\s+caracal\.deployment\.sync_engine|\bSyncEngine\s*\()",
    ),
    MarkerDefinition(
        key="sync_command_registrations",
        description="Legacy caracal sync command registrations/references",
        pattern=r"(\bcaracal\s+sync\b|\bdef\s+sync\s*\(\s*ctx\b|cli\.add_command\([^\n]*\bsync\b|@click\.group\(name\s*=\s*[\"']sync[\"'])",
    ),
    MarkerDefinition(
        key="sync_state_tables",
        description="Legacy sync-state table/model identifiers",
        pattern=r"\bsync_(operations|conflicts|metadata)\b",
    ),
    MarkerDefinition(
        key="connection_route_wiring",
        description="Legacy /api/connection route wiring",
        pattern=r"(/api/connection\b|prefix\s*=\s*[\"']/api/connection|include_router\([^\n]*connection\.router)",
    ),
    MarkerDefinition(
        key="sdk_sync_exports",
        description="Legacy SDK sync export surfaces",
        pattern=r"(\bSyncExtension\b|from\s+caracal_sdk\.enterprise\.sync\s+import|\bcaracal_sdk\.enterprise\.sync\b|export\s*\{\s*SyncExtension\s*\}\s*from\s*[\"']\./sync[\"'])",
    ),
    MarkerDefinition(
        key="aws_kms_fernet_imports",
        description="Legacy AWS/KMS/Fernet/keyring imports and markers",
        pattern=r"(\bboto3\b|\baws_kms\b|\bAWS_KMS\b|\bCCL_AWS_\b|cryptography\.fernet|\bFernet\b|\bkeyring\b)",
    ),
    MarkerDefinition(
        key="legacy_sync_auth_surfaces",
        description="Removed password-era sync auth fields and onboarding route markers",
        pattern=r"(\bsync_password\b|/api/onboarding/connection-status\b|cleanup-license-password\b|/api/license/update-password\b)",
    ),
    MarkerDefinition(
        key="compatibility_env_aliases",
        description="Legacy compatibility env aliases and dual-write markers",
        pattern=r"(\bCCL_COMPAT_ALIASES\b|\bCCL_COMPAT_MODE\b|\bCCL_DUAL_WRITE_ON\b|\bCCL_DUAL_WRITE_WIN\b)",
    ),
    MarkerDefinition(
        key="enterprise_logic_leakage",
        description="Enterprise package imports from OSS code paths",
        pattern=r"(\bfrom\s+caracal_enterprise\b|\bimport\s+caracal_enterprise\b|caracal_enterprise\.)",
        owner_phase="Phase 13",
        repos=("opensource",),
    ),
    MarkerDefinition(
        key="combined_onboarding_setup_helpers",
        description="Removed combined onboarding setup helpers that blend identity and authority setup",
        pattern=r"(/api/onboarding/setup(?:[\"'/?]|$)|\bonboardingApi\.runSetup\s*\(|\bsetup_onboarding\s*\()",
    ),
    MarkerDefinition(
        key="stale_removed_surface_names",
        description="Removed module or facade names that should stay unreachable after hard-cut cleanup",
        pattern=r"(\bsync_monitor\b|\bconnectionApi\b|\bonboardingApi\.runSetup\b|\bsetup_onboarding\b)",
    ),
    MarkerDefinition(
        key="split_mode_markers",
        description="Hardcut-vs-non-hardcut split terminology and mode aliases",
        pattern=r"(\bnon-hardcut\b|\bnon hardcut\b|\bhardcut vs non-hardcut\b|\bhard-cut vs non-hard-cut\b|\bsoft-cut\b|\bsoft cut\b|\bCCL_NON_HARDCUT\b|\bCCL_SOFTCUT\b)",
    ),
    MarkerDefinition(
        key="single_lineage_residuals",
        description="Single-lineage and parent-child-only delegation markers",
        pattern=r"(\bsingle_lineage\b|\bsingle-lineage\b|\bsingle lineage\b|\bparent-child\b)",
    ),
    MarkerDefinition(
        key="transitional_architecture_markers",
        description="Transition sentinel and compatibility cleanup markers on active paths",
        pattern=r"(\bbackward-compat(?:ible)?\b|\bcompatibility layer\b|\btransition window\b|\btemporary blocker\b|\bguard file\b)",
    ),
    MarkerDefinition(
        key="provider_legacy_contract_fields",
        description="Removed provider contract field names on active code paths",
        pattern=r"(\bprovider_definition_data\b|\bapi_key_ref\b)",
        owner_phase="Phase 7",
    ),
    MarkerDefinition(
        key="provider_legacy_secret_ref_schema_alias",
        description="Removed provider secret_ref schema/runtime aliases on active enterprise paths",
        pattern=r"([\"']secret_ref[\"'])",
        owner_phase="Phase 7",
        repos=("enterprise",),
    ),
    MarkerDefinition(
        key="provider_configmanager_secret_usage",
        description="Provider lifecycle code routing secrets through ConfigManager secret helpers",
        pattern=r"(ConfigManager\.store_secret\(|ConfigManager\.get_secret\()",
        owner_phase="Phase 7",
        repos=("opensource",),
    ),
    MarkerDefinition(
        key="vault_legacy_infisical_secret_endpoints",
        description="Removed legacy Infisical /api/secrets transport paths and payload keys",
        pattern=r"([\"']/api/secrets[\"']|[\"']secret_name[\"']|[\"']secret_value[\"'])",
        owner_phase="Phase 7",
        repos=("opensource",),
    ),
)

TEXT_SUFFIXES = {
    ".py",
    ".pyi",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".json",
    ".yml",
    ".yaml",
    ".toml",
    ".ini",
    ".env",
    ".example",
    ".sh",
    ".mdx",
}

SPECIAL_FILENAMES = {
    ".env",
    ".env.example",
    "Dockerfile",
    "docker-compose.yml",
    "docker-compose.enterprise.yml",
    "docker-compose.image.yml",
}

SKIP_DIR_NAMES = {
    ".git",
    ".github",
    ".venv",
    "venv",
    "node_modules",
    ".next",
    "htmlcov",
    "build",
    "dist",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "coverage",
    "tests",
    "docs",
}

SKIP_FILE_NAMES = {
    "coverage.xml",
    "junit-test.xml",
    "junit-unit.xml",
    "tsconfig.tsbuildinfo",
    "pnpm-lock.yaml",
    "package-lock.json",
    "forbidden-marker-baseline.json",
    ".env",
}

MAX_FILE_BYTES = 1_500_000

SELF_MARKER_SCANNER_NAMES = {
    "hardcut_forbidden_marker_scan.py",
    "hardcut_phase0_scan.py",
    "hardcut_migration_safety_snapshot.py",
}

# Marker-specific path excludes to avoid counting intentional hard-cut guard text
# as runtime legacy usage regressions.
MARKER_PATH_EXCLUDES: dict[str, set[str]] = {
    "sync_state_tables": {
        "caracal/runtime/hardcut_preflight.py",
        "caracal/db/schema_version.py",
        "caracal/db/migrations/versions/9bc013f8f3a6_add_sync_state_tables.py",
        "caracal/db/migrations/versions/s8t9u0v1w2x3_drop_sync_state_tables_hardcut.py",
        "caracal/db/migrations/versions/r7s8t9u0v1w2_enterprise_runtime_persistence_hardcut.py",
    },
    "aws_kms_fernet_imports": {
        "caracal/runtime/hardcut_preflight.py",
        "caracal/db/migrations/versions/l1m2n3o4p5q6_principal_key_custody_hardcut.py",
        "caracal/db/migrations/versions/n3o4p5q6r7s8_authority_relational_constraints_hardcut.py",
        "services/enterprise-api/alembic/versions/026_principal_key_custody_hardcut.py",
        "services/enterprise-api/alembic/versions/028_authority_relational_constraints_hardcut.py",
    },
    "legacy_sync_auth_surfaces": {
        "services/enterprise-api/src/caracal_enterprise/main.py",
        "services/enterprise-api/src/caracal_enterprise/services/enterprise_registration_service.py",
        "services/enterprise-api/alembic/versions/030_cleanup_registration_metadata_hardcut.py",
    },
    "single_lineage_residuals": {
        "caracal/db/migrations/versions/t9u0v1w2x3y4_single_lineage_active_inbound_constraint.py",
    },
    "compatibility_env_aliases": {
        "caracal/runtime/hardcut_preflight.py",
    },
    "provider_legacy_contract_fields": {
        "services/enterprise-api/alembic/versions/023_add_gateway_provider_registry.py",
        "services/enterprise-api/alembic/versions/032_gateway_provider_contract_field_names.py",
    },
    "provider_legacy_secret_ref_schema_alias": {
        "services/enterprise-api/alembic/versions/023_add_gateway_provider_registry.py",
        "services/enterprise-api/alembic/versions/032_gateway_provider_contract_field_names.py",
    },
}


def _discover_roots() -> tuple[Path, Path, Path | None]:
    caracal_root = Path(__file__).resolve().parents[1]
    workspace_root = caracal_root.parent
    enterprise_root = workspace_root / "caracalEnterprise"
    if not enterprise_root.exists() or not enterprise_root.is_dir():
        enterprise_root = None
    return workspace_root, caracal_root, enterprise_root


def _default_baseline_path(caracal_root: Path) -> Path:
    return caracal_root / ".github" / "hardcut" / "forbidden-marker-baseline.json"


def _should_scan_file(path: Path) -> bool:
    if not path.is_file():
        return False
    if path.name in SKIP_FILE_NAMES:
        return False
    if path.name in SELF_MARKER_SCANNER_NAMES:
        return False
    if any(part in SKIP_DIR_NAMES for part in path.parts):
        return False
    try:
        if path.stat().st_size > MAX_FILE_BYTES:
            return False
    except OSError:
        return False

    suffix = path.suffix.lower()
    if suffix in TEXT_SUFFIXES:
        return True
    if path.name in SPECIAL_FILENAMES:
        return True

    return False


def _iter_scan_files(root: Path) -> list[Path]:
    if not root.exists() or not root.is_dir():
        return []
    return [path for path in root.rglob("*") if _should_scan_file(path)]


def _new_marker_hit() -> dict[str, Any]:
    return {
        "count": 0,
        "file_hits": [],
    }


def _scan_root(
    root: Path,
    definitions: tuple[MarkerDefinition, ...],
    *,
    repo_key: str,
) -> dict[str, dict[str, Any]]:
    compiled = {item.key: re.compile(item.pattern, flags=re.IGNORECASE) for item in definitions}
    marker_hits = {item.key: _new_marker_hit() for item in definitions}

    for path in _iter_scan_files(root):
        try:
            payload = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue

        relative_path = str(path.relative_to(root))
        for item in definitions:
            if repo_key not in item.repos:
                continue
            excluded_paths = MARKER_PATH_EXCLUDES.get(item.key, set())
            if relative_path in excluded_paths:
                continue
            matches = list(compiled[item.key].finditer(payload))
            if not matches:
                continue
            count = len(matches)
            marker_hits[item.key]["count"] += count
            marker_hits[item.key]["file_hits"].append({
                "path": relative_path,
                "count": count,
            })

    for hit in marker_hits.values():
        hit["file_hits"] = sorted(
            hit["file_hits"],
            key=lambda item: (-item["count"], item["path"]),
        )
    return marker_hits


def _build_report(
    *,
    caracal_root: Path,
    enterprise_root: Path | None,
    definitions: tuple[MarkerDefinition, ...],
) -> dict[str, Any]:
    roots = {
        "opensource": caracal_root,
        "enterprise": enterprise_root,
    }

    scan_results: dict[str, dict[str, dict[str, Any]]] = {}
    for repo_key, repo_root in roots.items():
        if repo_root is None:
            scan_results[repo_key] = {item.key: _new_marker_hit() for item in definitions}
            continue
        scan_results[repo_key] = _scan_root(repo_root, definitions, repo_key=repo_key)

    marker_items: list[dict[str, Any]] = []
    repo_totals = {repo_key: 0 for repo_key in roots}

    for definition in definitions:
        repo_counts: dict[str, Any] = {}
        total_count = 0
        for repo_key in roots:
            repo_hit = scan_results[repo_key][definition.key]
            count = int(repo_hit["count"])
            total_count += count
            repo_totals[repo_key] += count
            repo_counts[repo_key] = {
                "count": count,
                "file_count": len(repo_hit["file_hits"]),
                "file_hits": repo_hit["file_hits"],
            }

        marker_items.append(
            {
                "key": definition.key,
                "description": definition.description,
                "pattern": definition.pattern,
                "owner_phase": definition.owner_phase,
                "repos": repo_counts,
                "total_count": total_count,
            }
        )

    report = {
        "schema_version": 2,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "roots": {
            "opensource": str(caracal_root),
            "enterprise": str(enterprise_root) if enterprise_root else None,
        },
        "markers": marker_items,
        "totals": {
            "opensource": repo_totals["opensource"],
            "enterprise": repo_totals["enterprise"],
            "all": repo_totals["opensource"] + repo_totals["enterprise"],
        },
    }
    return report


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _gate_strict_zero_violations(report: dict[str, Any]) -> list[str]:
    """Return violation messages when any forbidden marker count is non-zero."""
    violations: list[str] = []

    for marker in report.get("markers", []):
        marker_key = marker.get("key")
        repos = marker.get("repos", {})
        if not isinstance(marker_key, str):
            continue

        for repo_key in SCAN_REPO_KEYS:
            repo_entry = repos.get(repo_key, {})
            count = int(repo_entry.get("count", 0))
            if count <= 0:
                continue

            top_hits = repo_entry.get("file_hits", [])[:3]
            if top_hits:
                rendered_hits = ", ".join(
                    f"{hit.get('path', '<unknown>')} ({int(hit.get('count', 0))})"
                    for hit in top_hits
                )
                violations.append(
                    f"{marker_key} ({repo_key}) has {count} forbidden marker hit(s). "
                    f"Top files: {rendered_hits}"
                )
            else:
                violations.append(
                    f"{marker_key} ({repo_key}) has {count} forbidden marker hit(s)."
                )

    return violations


def _gate_missing_repo_violations(report: dict[str, Any]) -> list[str]:
    """Return violation messages when gate mode cannot evaluate both repos."""
    violations: list[str] = []
    roots = report.get("roots", {})

    for repo_key in SCAN_REPO_KEYS:
        repo_root = roots.get(repo_key)
        if repo_root:
            continue
        violations.append(
            f"{repo_key} repository root is unavailable. "
            "Strict-zero gate mode requires both opensource and enterprise repositories."
        )

    return violations


def _print_summary(report: dict[str, Any]) -> None:
    print("Hard-cut forbidden marker scan summary")
    print(f"Generated: {report.get('generated_at_utc')}")
    totals = report.get("totals", {})
    print(
        "Totals: "
        f"opensource={totals.get('opensource', 0)} "
        f"enterprise={totals.get('enterprise', 0)} "
        f"all={totals.get('all', 0)}"
    )
    for marker in report.get("markers", []):
        repos = marker.get("repos", {})
        os_count = repos.get("opensource", {}).get("count", 0)
        ent_count = repos.get("enterprise", {}).get("count", 0)
        total_count = marker.get("total_count", 0)
        owner_phase = marker.get("owner_phase", "<unspecified>")
        print(
            f"- {marker.get('key')} [{owner_phase}]: "
            f"opensource={os_count} enterprise={ent_count} total={total_count}"
        )


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mode",
        choices=("scan", "baseline", "gate"),
        default="scan",
        help=(
            "scan: print report; baseline: write baseline file; "
            "gate: fail when any forbidden marker count is non-zero"
        ),
    )
    parser.add_argument(
        "--baseline-file",
        type=Path,
        default=None,
        help=(
            "Path to baseline report JSON used by baseline mode "
            "(default: Caracal/.github/hardcut/forbidden-marker-baseline.json)"
        ),
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Optional output JSON path for current scan report.",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    _, caracal_root, enterprise_root = _discover_roots()
    baseline_file = args.baseline_file or _default_baseline_path(caracal_root)

    report = _build_report(
        caracal_root=caracal_root,
        enterprise_root=enterprise_root,
        definitions=MARKER_DEFINITIONS,
    )

    if args.mode == "baseline":
        _write_json(baseline_file, report)
        _print_summary(report)
        print(f"Baseline written to {baseline_file}")
        return 0

    if args.output is not None:
        _write_json(args.output, report)

    if args.mode == "scan":
        _print_summary(report)
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0

    regressions = _gate_missing_repo_violations(report) + _gate_strict_zero_violations(report)
    _print_summary(report)
    if regressions:
        print("Hard-cut marker gate failed (strict-zero mode):", file=sys.stderr)
        for item in regressions:
            print(f"- {item}", file=sys.stderr)
        return 1

    print("Hard-cut marker gate passed (strict-zero mode).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
