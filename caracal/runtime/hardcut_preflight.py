"""Hard-cut preflight checks for authority/runtime startup paths.

These checks enforce the strict hard-cut constraints:
- no file-backed runtime state
- no SQLite backends
- no JSON/JSONB domain persistence
- no compatibility aliases
- no dual-write compatibility windows
- no legacy migration command path
"""

from __future__ import annotations

from pathlib import Path
from typing import Mapping, Sequence


class HardCutPreflightError(RuntimeError):
    """Raised when strict hard-cut preflight constraints are violated."""


_FORBIDDEN_SQLITE_PREFIXES = ("sqlite://", "sqlite+")
_FORBIDDEN_RUNTIME_COMPOSE_MARKERS = (
    "caracal_state:",
    "/home/caracal/.caracal",
    "caracal_home",
)
_FORBIDDEN_STATE_RELATIVE_PATHS = (
    "enterprise.json",
    "workspaces.json",
    "keystore/master_key",
)
_FORBIDDEN_COMPAT_ENV_VARS = (
    "CARACAL_ENABLE_COMPAT_ALIASES",
    "CARACAL_COMPAT_ALIASES",
    "CARACAL_COMPAT_MODE",
    "CARACAL_ENABLE_DUAL_WRITE",
    "CARACAL_DUAL_WRITE_WINDOW",
)
_FORBIDDEN_CONFIG_MARKERS = (
    "enterprise.json",
    "workspaces.json",
    "sqlite://",
    "sqlite+",
    "dual-write",
    "dual_write",
    "compat alias",
    "compatibility alias",
)


def _default_models_file() -> Path:
    return Path(__file__).resolve().parents[1] / "db" / "models.py"


def _sqlite_violations(database_urls: Mapping[str, str | None] | None) -> list[str]:
    violations: list[str] = []
    if not database_urls:
        return violations

    for key, raw_value in database_urls.items():
        value = (raw_value or "").strip()
        lowered = value.lower()
        if not value:
            continue
        if lowered.startswith(_FORBIDDEN_SQLITE_PREFIXES):
            violations.append(
                f"{key} uses SQLite ({value}). PostgreSQL is required in hard-cut mode."
            )
    return violations


def _runtime_compose_violations(compose_file: Path | None) -> list[str]:
    if compose_file is None:
        return []

    try:
        payload = compose_file.read_text(encoding="utf-8")
    except OSError as exc:
        return [f"Could not read runtime compose file {compose_file}: {exc}"]

    lowered = payload.lower()
    markers = [marker for marker in _FORBIDDEN_RUNTIME_COMPOSE_MARKERS if marker in lowered]
    if not markers:
        return []

    marker_list = ", ".join(markers)
    return [
        f"Runtime compose file {compose_file} contains forbidden file-backed state markers: {marker_list}."
    ]


def _state_root_violations(state_roots: Sequence[Path] | None) -> list[str]:
    violations: list[str] = []
    if not state_roots:
        return violations

    for root in state_roots:
        for relative_path in _FORBIDDEN_STATE_RELATIVE_PATHS:
            candidate = root / relative_path
            if candidate.exists():
                violations.append(
                    f"Legacy file-backed state artifact detected at {candidate}."
                )

        audit_log_dir = root / "ledger" / "audit_logs"
        if audit_log_dir.exists() and audit_log_dir.is_dir():
            jsonl_logs = sorted(audit_log_dir.glob("*.jsonl"))
            for jsonl_log in jsonl_logs[:5]:
                violations.append(
                    f"Legacy JSONL ledger side log detected at {jsonl_log}."
                )
            if len(jsonl_logs) > 5:
                violations.append(
                    f"Legacy JSONL ledger side logs detected under {audit_log_dir} (count={len(jsonl_logs)})."
                )

    return violations


def _compatibility_violations(env_vars: Mapping[str, str | None] | None) -> list[str]:
    if not env_vars:
        return []

    violations: list[str] = []
    for var_name in _FORBIDDEN_COMPAT_ENV_VARS:
        value = (env_vars.get(var_name) or "").strip()
        if not value:
            continue
        violations.append(
            f"{var_name} is set ({value!r}). Compatibility aliases and dual-write windows are forbidden in hard-cut mode."
        )

    return violations


def _config_path_violations(config_paths: Sequence[Path] | None) -> list[str]:
    if not config_paths:
        return []

    violations: list[str] = []
    for config_path in config_paths:
        try:
            payload = config_path.read_text(encoding="utf-8")
        except OSError as exc:
            violations.append(f"Could not read config path {config_path}: {exc}")
            continue

        lowered = payload.lower()
        matched_markers = [marker for marker in _FORBIDDEN_CONFIG_MARKERS if marker in lowered]
        if matched_markers:
            violations.append(
                f"Config path {config_path} contains forbidden markers: {', '.join(sorted(set(matched_markers)))}."
            )

    return violations


def _jsonb_violations(models_file: Path | None, check_jsonb: bool) -> list[str]:
    if not check_jsonb:
        return []

    target = models_file or _default_models_file()
    try:
        payload = target.read_text(encoding="utf-8")
    except OSError as exc:
        return [f"Could not read model definitions at {target}: {exc}"]

    if "JSONB" not in payload and "jsonb" not in payload:
        return []

    return [
        f"Model definitions in {target} still include JSON/JSONB persistence. Normalize to relational columns."
    ]


def _raise_if_violations(scope: str, violations: list[str]) -> None:
    if not violations:
        return

    detail_block = "\n".join(f"- {item}" for item in violations)
    raise HardCutPreflightError(
        f"Hard-cut preflight failed for {scope}.\n"
        "Forbidden in this mode: file-backed state, SQLite, JSON/JSONB domain persistence, and legacy migration flows.\n"
        f"{detail_block}"
    )


def assert_runtime_hardcut(
    *,
    compose_file: Path | None,
    database_urls: Mapping[str, str | None] | None,
    models_file: Path | None = None,
    check_jsonb: bool = True,
    state_roots: Sequence[Path] | None = None,
    env_vars: Mapping[str, str | None] | None = None,
    config_paths: Sequence[Path] | None = None,
) -> None:
    """Fail-fast preflight for runtime startup paths."""
    violations: list[str] = []
    violations.extend(_sqlite_violations(database_urls))
    violations.extend(_runtime_compose_violations(compose_file))
    violations.extend(_state_root_violations(state_roots))
    violations.extend(_compatibility_violations(env_vars))
    violations.extend(_config_path_violations(config_paths))
    violations.extend(_jsonb_violations(models_file=models_file, check_jsonb=check_jsonb))
    _raise_if_violations("runtime", violations)


def assert_enterprise_hardcut(
    *,
    database_urls: Mapping[str, str | None] | None,
    models_file: Path | None = None,
    check_jsonb: bool = True,
    state_roots: Sequence[Path] | None = None,
    env_vars: Mapping[str, str | None] | None = None,
    config_paths: Sequence[Path] | None = None,
) -> None:
    """Fail-fast preflight for enterprise API startup."""
    violations: list[str] = []
    violations.extend(_sqlite_violations(database_urls))
    violations.extend(_state_root_violations(state_roots))
    violations.extend(_compatibility_violations(env_vars))
    violations.extend(_config_path_violations(config_paths))
    violations.extend(_jsonb_violations(models_file=models_file, check_jsonb=check_jsonb))
    _raise_if_violations("enterprise-api", violations)


def assert_migration_hardcut(
    *,
    database_urls: Mapping[str, str | None] | None,
    models_file: Path | None = None,
    check_jsonb: bool = True,
    state_roots: Sequence[Path] | None = None,
    env_vars: Mapping[str, str | None] | None = None,
    config_paths: Sequence[Path] | None = None,
) -> None:
    """Fail-fast preflight for migration startup paths."""
    violations: list[str] = []
    violations.extend(_sqlite_violations(database_urls))
    violations.extend(_state_root_violations(state_roots))
    violations.extend(_compatibility_violations(env_vars))
    violations.extend(_config_path_violations(config_paths))
    violations.extend(_jsonb_violations(models_file=models_file, check_jsonb=check_jsonb))
    _raise_if_violations("migration", violations)


def assert_migration_cli_allowed() -> None:
    """Migration CLI is intentionally disabled in strict hard-cut mode."""
    raise HardCutPreflightError(
        "Hard-cut preflight blocked migration command usage. "
        "Legacy file-backed migration/backup workflows are disabled."
    )