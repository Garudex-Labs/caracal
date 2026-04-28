#!/usr/bin/env python3
"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

OSS separation scanner for forbidden Enterprise runtime markers.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path


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
    ".sh",
    ".md",
    ".mdx",
}

SKIP_DIR_NAMES = {
    ".git",
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

MAX_FILE_BYTES = 1_500_000


@dataclass(frozen=True)
class Rule:
    key: str
    description: str
    pattern: str


RULES = (
    Rule(
        key="caracal_enterprise_import",
        description="OSS runtime code must not import Caracal Enterprise packages.",
        pattern=r"\bfrom\s+caracalEnterprise\b|\bimport\s+caracalEnterprise\b|caracalEnterprise\.",
    ),
    Rule(
        key="ccle_runtime_env",
        description="OSS runtime code must not read or define CCLE-prefixed runtime names.",
        pattern=r"\bCCLE_[A-Z0-9_]*\b",
    ),
    Rule(
        key="enterprise_secret_backend_selector",
        description="OSS secret code must not select Enterprise vault backends by tier.",
        pattern=r"\bbackend_for_tier\b",
    ),
    Rule(
        key="enterprise_gateway_provider_model",
        description="OSS runtime code must not own the Enterprise GatewayProvider model.",
        pattern=r"\bGatewayProvider\b",
    ),
    Rule(
        key="enterprise_runtime_config_model",
        description="OSS runtime code must not own Enterprise runtime config schema.",
        pattern=r"\bEnterpriseRuntimeConfig\b|\benterprise_runtime_config\b",
    ),
    Rule(
        key="enterprise_gateway_client",
        description="OSS runtime code must not own the Enterprise gateway client.",
        pattern=r"\bGatewayClient\b|\bgateway_client\b",
    ),
    Rule(
        key="enterprise_gateway_features",
        description="OSS runtime code must not own Enterprise gateway feature flags.",
        pattern=r"\bGatewayFeatureFlags\b|\bget_gateway_features\b|\bgateway_features\b",
    ),
)


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _scan_root() -> Path:
    return _repo_root() / "packages"


def _should_scan(path: Path) -> bool:
    if not path.is_file():
        return False
    if any(part in SKIP_DIR_NAMES for part in path.parts):
        return False
    try:
        if path.stat().st_size > MAX_FILE_BYTES:
            return False
    except OSError:
        return False
    return path.suffix.lower() in TEXT_SUFFIXES


def _iter_files(root: Path) -> list[Path]:
    if not root.exists():
        return []
    return [path for path in root.rglob("*") if _should_scan(path)]


def scan() -> dict[str, list[str]]:
    root = _scan_root()
    compiled = {rule.key: re.compile(rule.pattern) for rule in RULES}
    violations = {rule.key: [] for rule in RULES}

    for path in _iter_files(root):
        try:
            payload = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue

        relative_path = path.relative_to(_repo_root()).as_posix()
        for rule in RULES:
            if compiled[rule.key].search(payload):
                violations[rule.key].append(relative_path)

    return {key: sorted(paths) for key, paths in violations.items() if paths}


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mode",
        choices=("scan", "gate"),
        default="scan",
        help="scan prints results; gate exits non-zero when violations exist.",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    violations = scan()

    if not violations:
        print("OSS separation scan passed.")
        return 0

    print("OSS separation scan found forbidden markers:")
    for rule in RULES:
        paths = violations.get(rule.key, [])
        if not paths:
            continue
        print(f"- {rule.key}: {rule.description}")
        for path in paths:
            print(f"  - {path}")

    return 1 if args.mode == "gate" else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))