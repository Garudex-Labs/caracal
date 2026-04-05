#!/usr/bin/env python3
"""Forbidden-marker scanner for hard-cut implementation gating.

This scanner does two jobs:
1. Capture a baseline count for known legacy markers.
2. Fail gate checks only when a marker count increases above baseline.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class MarkerDefinition:
    key: str
    description: str
    pattern: str


MARKER_DEFINITIONS: tuple[MarkerDefinition, ...] = (
    MarkerDefinition(
        key="sync_engine_imports",
        description="Legacy SyncEngine imports/usages",
        pattern=r"(from\s+caracal\.deployment\.sync_engine\s+import|import\s+caracal\.deployment\.sync_engine|\bSyncEngine\s*\()",
    ),
    MarkerDefinition(
        key="sync_command_registrations",
        description="Legacy caracal sync command registrations/references",
        pattern=r"(\bcaracal\s+sync\b|add_command\([^\n]*\bsync\b|click\.group\([^\n]*\bsync\b)",
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
        pattern=r"(\bSyncExtension\b|enterprise/sync|from\s+[^\n]*\.sync\s+import)",
    ),
    MarkerDefinition(
        key="aws_kms_fernet_imports",
        description="Legacy AWS/KMS/Fernet/keyring imports and markers",
        pattern=r"(\bboto3\b|\baws_kms\b|\bAWS_KMS\b|\bCARACAL_AWS_\b|cryptography\.fernet|\bFernet\b|\bkeyring\b)",
    ),
)

SCAN_REPO_KEYS: tuple[str, ...] = ("opensource", "enterprise")

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
}

SKIP_FILE_NAMES = {
    "coverage.xml",
    "junit-test.xml",
    "junit-unit.xml",
    "tsconfig.tsbuildinfo",
    "pnpm-lock.yaml",
    "package-lock.json",
    "forbidden-marker-baseline.json",
}

MAX_FILE_BYTES = 1_500_000

SELF_MARKER_SCANNER_NAMES = {
    "hardcut_forbidden_marker_scan.py",
    "hardcut_phase0_scan.py",
    "hardcut_migration_safety_snapshot.py",
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


def _scan_root(root: Path, definitions: tuple[MarkerDefinition, ...]) -> dict[str, dict[str, Any]]:
    compiled = {item.key: re.compile(item.pattern, flags=re.IGNORECASE) for item in definitions}
    marker_hits = {item.key: _new_marker_hit() for item in definitions}

    for path in _iter_scan_files(root):
        try:
            payload = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue

        relative_path = str(path.relative_to(root))
        for item in definitions:
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
        scan_results[repo_key] = _scan_root(repo_root, definitions)

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
                "repos": repo_counts,
                "total_count": total_count,
            }
        )

    report = {
        "schema_version": 1,
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


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _extract_counts(report: dict[str, Any]) -> dict[tuple[str, str], int]:
    counts: dict[tuple[str, str], int] = {}
    markers = report.get("markers", [])
    for marker in markers:
        key = marker.get("key")
        repos = marker.get("repos", {})
        if not isinstance(key, str):
            continue
        for repo_key in SCAN_REPO_KEYS:
            repo_entry = repos.get(repo_key, {})
            count = int(repo_entry.get("count", 0))
            counts[(key, repo_key)] = count
    return counts


def _gate_regressions(current_report: dict[str, Any], baseline_report: dict[str, Any]) -> list[str]:
    current_counts = _extract_counts(current_report)
    baseline_counts = _extract_counts(baseline_report)
    regressions: list[str] = []

    for marker in MARKER_DEFINITIONS:
        for repo_key in SCAN_REPO_KEYS:
            current = current_counts.get((marker.key, repo_key), 0)
            baseline = baseline_counts.get((marker.key, repo_key), 0)
            if current > baseline:
                regressions.append(
                    f"{marker.key} ({repo_key}) increased from {baseline} to {current}."
                )

    return regressions


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
        print(
            f"- {marker.get('key')}: opensource={os_count} enterprise={ent_count} total={total_count}"
        )


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mode",
        choices=("scan", "baseline", "gate"),
        default="scan",
        help="scan: print report; baseline: write baseline file; gate: fail on baseline regression",
    )
    parser.add_argument(
        "--baseline-file",
        type=Path,
        default=None,
        help="Path to baseline report JSON (default: Caracal/.github/hardcut/forbidden-marker-baseline.json)",
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

    if not baseline_file.exists():
        print(f"Baseline file not found: {baseline_file}", file=sys.stderr)
        return 2

    baseline_report = _load_json(baseline_file)
    regressions = _gate_regressions(report, baseline_report)
    _print_summary(report)
    if regressions:
        print("Hard-cut marker gate failed:", file=sys.stderr)
        for item in regressions:
            print(f"- {item}", file=sys.stderr)
        return 1

    print(f"Hard-cut marker gate passed against baseline: {baseline_file}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
