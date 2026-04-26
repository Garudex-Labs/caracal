"""Hard-cut preflight checks for authority/runtime startup paths.

These checks enforce the strict hard-cut constraints:
- no file-backed runtime state
- no SQLite backends
- no JSON/JSONB domain persistence
- no compatibility aliases
- no dual-write compatibility windows
- no legacy migration command path

Frozen hard-cut contracts:
- `/api/sync` is the only allowed enterprise API family
- `caracal enterprise` is the only allowed enterprise CLI family
- runtime code must not depend on legacy sync-state models
"""

from __future__ import annotations

from pathlib import Path
from typing import Mapping, Sequence

from caracal.runtime.host_io import is_truthy_env


class HardCutPreflightError(RuntimeError):
    """Raised when strict hard-cut preflight constraints are violated."""


_CANONICAL_ENTERPRISE_API_FAMILY = "/api/sync"
_CANONICAL_ENTERPRISE_CLI_FAMILY = "caracal enterprise"
_FORBIDDEN_SYNC_RUNTIME_MODEL_MARKERS = (
    "sync_operations",
    "sync_conflicts",
    "sync_metadata",
)
_FORBIDDEN_SQLITE_PREFIXES = ("sqlite://", "sqlite+")
_FORBIDDEN_RUNTIME_COMPOSE_MARKERS = (
    "caracal_state:",
    "/home/caracal/.caracal",
)
_REQUIRED_RUNTIME_COMPOSE_MARKERS = (
    "  vault:",
    "image: ${ccl_vault_sidecar_image",
    "ccl_principal_key_backend: ${ccl_principal_key_backend:-vault}",
    "ccl_vault_url: ${ccl_vault_url:-http://vault:8080}",
    "ccl_vault_token:",
    "ccl_vault_environment: ${ccl_vault_environment:-dev}",
    "ccl_vault_secret_path: ${ccl_vault_secret_path:-/}",
    "ccl_vault_signing_key_ref:",
    "ccl_vault_session_public_key_ref:",
    "ccl_session_signing_algorithm: ${ccl_session_signing_algorithm:-rs256}",
)
_FORBIDDEN_ENTERPRISE_COMPOSE_MARKERS = (
    "caracal_secret_backend",
    ":-null",
    "vault_addr",
    "vault_role_id",
    "vault_secret_id",
    "aws_region",
    "aws_access_key_id",
    "aws_secret_access_key",
)
_REQUIRED_ENTERPRISE_COMPOSE_MARKERS = (
    "  vault:",
    "image: ${ccl_vault_sidecar_image",
    "${ccle_vault_port:-8180}:8080",
    "ccl_principal_key_backend=${ccl_principal_key_backend:-vault}",
    "ccl_vault_url=${ccl_vault_url:-http://vault:8080}",
    "ccl_vault_token=${ccl_vault_token:-enterprise-local-token}",
    "ccl_vault_workspace_id=${ccl_vault_workspace_id:-caracal-enterprise-local}",
    "ccl_vault_environment=${ccl_vault_environment:-enterprise-dev}",
    "ccl_vault_secret_path=${ccl_vault_secret_path:-/enterprise}",
    "ccl_vault_signing_key_ref=${ccl_vault_signing_key_ref:-keys/mandate-signing}",
    "ccl_vault_session_public_key_ref=${ccl_vault_session_public_key_ref:-keys/session-public}",
    "ccl_session_signing_algorithm=${ccl_session_signing_algorithm:-rs256}",
    "vault:\n        condition: service_healthy",
)
_FORBIDDEN_STATE_RELATIVE_PATHS = (
    "enterprise.json",
    "workspaces.json",
    "keystore/master_key",
)
_FORBIDDEN_COMPAT_ENV_VARS = (
    "CCL_COMPAT_ON",
    "CCL_COMPAT_ALIASES",
    "CCL_COMPAT_MODE",
    "CCL_HARDCUT_MODE",
    "CCL_DUAL_WRITE_ON",
    "CCL_DUAL_WRITE_WIN",
)
_REQUIRED_SECRET_BACKEND_ENV = "CCL_PRINCIPAL_KEY_BACKEND"
_ALLOWED_SECRET_BACKENDS = ("vault",)
_REQUIRED_VAULT_ENV_VARS = (
    "CCL_VAULT_URL",
    "CCL_VAULT_TOKEN",
    "CCL_VAULT_SIGNING_KEY_REF",
    "CCL_VAULT_SESSION_PUBLIC_KEY_REF",
)
_SESSION_SIGNING_ALGORITHM_ENV_VARS = (
    "CCL_SESSION_SIGNING_ALGORITHM",
)
_ALLOWED_SESSION_SIGNING_ALGORITHMS = ("RS256", "ES256")
_VAULT_MODE_ENV = "CCL_VAULT_MODE"
_LOCAL_VAULT_MODE_VALUES = ("local", "dev", "development")
_FORBIDDEN_CONFIG_MARKERS = (
    "enterprise.json",
    "workspaces.json",
    "sqlite://",
    "sqlite+",
    "caracal_principal_key_backend=local",
    "caracal_principal_key_backend=aws_kms",
    "principal_key_backend = local",
    "principal_key_backend = aws_kms",
    "principal_key_backend: local",
    "principal_key_backend: aws_kms",
    "caracal_aws_kms_",
    "aws_kms_key_id",
    "aws_region",
    "dual-write",
    "dual_write",
    "compat alias",
    "compatibility alias",
)
_GW_URL_ENV_KEYS = (
    "CCLE_API_URL",
)
_GATEWAY_ENABLED_ENV_KEY = "CCLE_GATEWAY_ENABLED"


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


def _compose_contract_violations(
    *,
    compose_file: Path | None,
    required_markers: Sequence[str],
    forbidden_markers: Sequence[str],
    scope_name: str,
) -> list[str]:
    if compose_file is None:
        return []

    try:
        payload = compose_file.read_text(encoding="utf-8")
    except OSError as exc:
        return [f"Could not read {scope_name} compose file {compose_file}: {exc}"]

    lowered = payload.lower()
    violations: list[str] = []

    matched_forbidden = [
        marker for marker in forbidden_markers if marker.lower() in lowered
    ]
    if matched_forbidden:
        violations.append(
            f"{scope_name} compose file {compose_file} contains forbidden markers: "
            f"{', '.join(sorted(set(matched_forbidden)))}."
        )

    missing_required = [
        marker for marker in required_markers if marker.lower() not in lowered
    ]
    if missing_required:
        violations.append(
            f"{scope_name} compose file {compose_file} is missing required hard-cut markers: "
            f"{', '.join(missing_required)}."
        )

    return violations


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


def _secret_backend_violations(env_vars: Mapping[str, str | None] | None) -> list[str]:
    """Reject local file secret backends in hard-cut mode."""
    if env_vars is None:
        return []

    backend_value = (env_vars.get(_REQUIRED_SECRET_BACKEND_ENV) or "").strip().lower()
    if not backend_value:
        return [
            f"{_REQUIRED_SECRET_BACKEND_ENV} is not set. "
            "Hard-cut mode requires an explicit managed secret backend (vault)."
        ]

    if backend_value not in _ALLOWED_SECRET_BACKENDS:
        return [
            f"{_REQUIRED_SECRET_BACKEND_ENV}={backend_value!r} is forbidden in hard-cut mode. "
            "Local/file-backed secret backends are not allowed."
        ]

    violations: list[str] = []
    for env_key in _REQUIRED_VAULT_ENV_VARS:
        value = (env_vars.get(env_key) or "").strip()
        if value:
            continue
        violations.append(
            f"{env_key} is required when {_REQUIRED_SECRET_BACKEND_ENV}=vault in hard-cut mode."
        )

    vault_mode = (env_vars.get(_VAULT_MODE_ENV) or "").strip().lower()
    if vault_mode in _LOCAL_VAULT_MODE_VALUES:
        violations.append(
            f"{_VAULT_MODE_ENV}={vault_mode!r} is forbidden in hard-cut runtime paths. "
            "Local vault mode is development-only."
        )

    return violations


def _asymmetric_session_signing_violations(
    env_vars: Mapping[str, str | None] | None,
) -> list[str]:
    """Reject symmetric/unsupported session JWT algorithms in hard-cut mode."""
    if env_vars is None:
        return []

    violations: list[str] = []
    for env_key in _SESSION_SIGNING_ALGORITHM_ENV_VARS:
        raw_value = (env_vars.get(env_key) or "").strip()
        if not raw_value:
            continue

        normalized = raw_value.upper()
        if normalized.startswith("HS"):
            violations.append(
                f"{env_key}={raw_value!r} is forbidden in hard-cut mode. "
                "Session tokens must use asymmetric signing algorithms (RS256 or ES256)."
            )
            continue

        if normalized not in _ALLOWED_SESSION_SIGNING_ALGORITHMS:
            violations.append(
                f"{env_key}={raw_value!r} is unsupported for hard-cut session signing. "
                f"Use one of {_ALLOWED_SESSION_SIGNING_ALGORITHMS}."
            )

    return violations


def _is_truthy(value: str | None) -> bool:
    return is_truthy_env(value)


def _is_falsy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"0", "false", "no", "off"}


def _execution_exclusivity_violations(env_vars: Mapping[str, str | None] | None) -> list[str]:
    """Reject mixed or contradictory broker/gateway execution startup signals."""
    if env_vars is None:
        return []

    violations: list[str] = []
    gateway_endpoints = {
        key: (env_vars.get(key) or "").strip()
        for key in _GW_URL_ENV_KEYS
    }
    has_gateway_endpoint = any(value for value in gateway_endpoints.values())

    gateway_enabled_raw = env_vars.get(_GATEWAY_ENABLED_ENV_KEY)
    gateway_enabled_truthy = _is_truthy(gateway_enabled_raw)
    gateway_enabled_falsy = _is_falsy(gateway_enabled_raw)

    if gateway_enabled_truthy and not has_gateway_endpoint:
        violations.append(
            f"{_GATEWAY_ENABLED_ENV_KEY} enables gateway execution but no gateway endpoint is configured "
            f"({_GW_URL_ENV_KEYS[0]})."
        )

    if has_gateway_endpoint and gateway_enabled_falsy:
        violations.append(
            "Execution exclusivity violation: gateway endpoint is configured while "
            f"{_GATEWAY_ENABLED_ENV_KEY} explicitly disables gateway mode. "
            "Configure exactly one execution mode (broker or gateway)."
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
    except FileNotFoundError:
        return []
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
    violations.extend(
        _compose_contract_violations(
            compose_file=compose_file,
            required_markers=_REQUIRED_RUNTIME_COMPOSE_MARKERS,
            forbidden_markers=(),
            scope_name="runtime",
        )
    )
    violations.extend(_state_root_violations(state_roots))
    violations.extend(_compatibility_violations(env_vars))
    violations.extend(_secret_backend_violations(env_vars))
    violations.extend(_asymmetric_session_signing_violations(env_vars))
    violations.extend(_config_path_violations(config_paths))
    violations.extend(_jsonb_violations(models_file=models_file, check_jsonb=check_jsonb))
    _raise_if_violations("runtime", violations)


def assert_enterprise_hardcut(
    *,
    compose_file: Path | None = None,
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
    violations.extend(
        _compose_contract_violations(
            compose_file=compose_file,
            required_markers=_REQUIRED_ENTERPRISE_COMPOSE_MARKERS,
            forbidden_markers=_FORBIDDEN_ENTERPRISE_COMPOSE_MARKERS,
            scope_name="enterprise",
        )
    )
    violations.extend(_state_root_violations(state_roots))
    violations.extend(_compatibility_violations(env_vars))
    violations.extend(_execution_exclusivity_violations(env_vars))
    violations.extend(_secret_backend_violations(env_vars))
    violations.extend(_asymmetric_session_signing_violations(env_vars))
    violations.extend(_config_path_violations(config_paths))
    violations.extend(_jsonb_violations(models_file=models_file, check_jsonb=check_jsonb))
    _raise_if_violations("enterprise-api", violations)


def assert_migration_hardcut(
    *,
    compose_file: Path | None = None,
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
    violations.extend(
        _compose_contract_violations(
            compose_file=compose_file,
            required_markers=_REQUIRED_ENTERPRISE_COMPOSE_MARKERS,
            forbidden_markers=_FORBIDDEN_ENTERPRISE_COMPOSE_MARKERS,
            scope_name="enterprise",
        )
    )
    violations.extend(_state_root_violations(state_roots))
    violations.extend(_compatibility_violations(env_vars))
    violations.extend(_execution_exclusivity_violations(env_vars))
    violations.extend(_secret_backend_violations(env_vars))
    violations.extend(_asymmetric_session_signing_violations(env_vars))
    violations.extend(_config_path_violations(config_paths))
    violations.extend(_jsonb_violations(models_file=models_file, check_jsonb=check_jsonb))
    _raise_if_violations("migration", violations)


def assert_migration_cli_allowed() -> None:
    """Migration CLI is intentionally disabled in strict hard-cut mode."""
    raise HardCutPreflightError(
        "Hard-cut preflight blocked migration command usage. "
        "Legacy file-backed migration/backup workflows are disabled."
    )
