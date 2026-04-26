"""Runtime environment mode utilities.

Normalizes environment-driven runtime mode selection for containerized and
non-containerized execution.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from caracal.runtime.host_io import is_truthy_env


ENV_MODE_VAR = "CCL_ENV_MODE"
DEBUG_LOGS_VAR = "CCL_DEBUG_LOGS"
JSON_LOGS_VAR = "CCL_JSON_LOGS"


MODE_DEV = "dev"
MODE_STAGING = "staging"
MODE_PROD = "prod"

_MODE_ALIASES = {
    "development": MODE_DEV,
    "dev": MODE_DEV,
    "stage": MODE_STAGING,
    "staging": MODE_STAGING,
    "production": MODE_PROD,
    "prod": MODE_PROD,
}
def resolve_runtime_mode(explicit_mode: str | None = None) -> str:
    """Resolve the runtime mode as one of dev, staging, or prod."""
    if explicit_mode:
        return _MODE_ALIASES.get(explicit_mode.strip().lower(), MODE_DEV)

    raw_mode = os.getenv(ENV_MODE_VAR)

    if not raw_mode:
        return MODE_DEV

    return _MODE_ALIASES.get(raw_mode.strip().lower(), MODE_DEV)


def debug_logs_enabled(mode: str | None = None) -> bool:
    """Return whether debug logs are enabled for this runtime mode."""
    resolved_mode = resolve_runtime_mode(mode)
    if resolved_mode != MODE_DEV:
        return False
    return is_truthy_env(os.getenv(DEBUG_LOGS_VAR), default=False)


def prefers_json_logs(mode: str | None = None) -> bool:
    """Return whether logs should be emitted in structured JSON format."""
    resolved_mode = resolve_runtime_mode(mode)
    if resolved_mode in {MODE_STAGING, MODE_PROD}:
        return True
    return is_truthy_env(os.getenv(JSON_LOGS_VAR), default=False)


@dataclass(frozen=True)
class RuntimeModeSummary:
    """Summary of current runtime mode behavior derived from environment."""

    mode: str
    debug_logs: bool
    json_logs: bool


def get_runtime_mode_summary(explicit_mode: str | None = None) -> RuntimeModeSummary:
    """Return resolved runtime mode with log behavior toggles."""
    mode = resolve_runtime_mode(explicit_mode)
    return RuntimeModeSummary(
        mode=mode,
        debug_logs=debug_logs_enabled(mode),
        json_logs=prefers_json_logs(mode),
    )
