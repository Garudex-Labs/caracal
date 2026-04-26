"""Helpers for container-aware path handling and truthy env parsing."""

from __future__ import annotations

import os
from pathlib import Path


IN_CONTAINER_ENV = "CCL_RUNTIME_IN_CONTAINER"
IN_CONTAINER_COMPAT_ENVS: tuple[str, ...] = ()
HOST_IO_ROOT_ENV = "CCL_HOST_IO_ROOT"
HOST_IO_ROOT_COMPAT_ENVS: tuple[str, ...] = ()
DEFAULT_HOST_IO_ROOT = Path("/caracal-host-io")
TRUTHY_ENV_VALUES = frozenset({"1", "true", "yes", "on"})
FALSY_ENV_VALUES = frozenset({"0", "false", "no", "off"})

CCL_HOME_ENV = "CCL_HOME"
CCL_HOME_COMPAT_ENVS: tuple[str, ...] = ()
CCL_CONFIG_DIR_ENV = "CCL_CONFIG_DIR"
CCL_CONFIG_DIR_COMPAT_ENVS: tuple[str, ...] = ()


class StorageLayoutError(RuntimeError):
    """Raised when storage layout is invalid or cannot be created safely."""


def _env_value(name: str, *compat_names: str) -> str | None:
    """Read a canonical env var, falling back to compatibility names when unset."""
    for env_name in (name, *compat_names):
        value = os.getenv(env_name)
        if value:
            return value
    return None


def _explicit_env_value(name: str, *compat_names: str) -> str | None:
    """Read env vars while preserving explicit falsy/empty canonical values."""
    if name in os.environ:
        return os.environ[name]
    for env_name in compat_names:
        if env_name in os.environ:
            return os.environ[env_name]
    return None


def resolve_caracal_home(require_explicit: bool = False) -> Path:
    """Resolve CCL_HOME root.

    Resolution order is deterministic:
    1. CCL_CONFIG_DIR (demo/override alias)
    2. CCL_HOME
    3. ~/.caracal (only when require_explicit=False)
    """
    config_dir_value = _env_value(CCL_CONFIG_DIR_ENV, *CCL_CONFIG_DIR_COMPAT_ENVS)
    if config_dir_value:
        return Path(config_dir_value).expanduser().resolve(strict=False)

    home_value = _env_value(CCL_HOME_ENV, *CCL_HOME_COMPAT_ENVS)
    if home_value:
        return Path(home_value).expanduser().resolve(strict=False)

    if require_explicit:
        raise StorageLayoutError(
            "CCL_HOME is required but not set. Set CCL_HOME to an explicit runtime path."
        )

    return (Path.home() / ".caracal").resolve(strict=False)


def is_truthy_env(value: str | None, *, default: bool = False) -> bool:
    """Interpret common environment-style truthy and falsy values."""
    if value is None:
        return default

    normalized = value.strip().lower()
    if normalized in TRUTHY_ENV_VALUES:
        return True
    if normalized in FALSY_ENV_VALUES:
        return False
    return default


def in_container_runtime(*, detect_dockerenv: bool = False) -> bool:
    """Return whether the current process is running in the runtime container."""
    if is_truthy_env(_explicit_env_value(IN_CONTAINER_ENV, *IN_CONTAINER_COMPAT_ENVS)):
        return True
    return detect_dockerenv and Path("/.dockerenv").exists()


def host_io_root() -> Path:
    """Return the shared host I/O mount path used by the runtime container."""
    value = _env_value(HOST_IO_ROOT_ENV, *HOST_IO_ROOT_COMPAT_ENVS)
    return Path(value or str(DEFAULT_HOST_IO_ROOT)).resolve(strict=False)


def normalize_optional_text(value: str | None) -> str | None:
    """Strip optional text inputs and collapse empty values to ``None``."""
    if value is None:
        return None

    normalized = value.strip()
    return normalized or None


def path_scope_label(path: str | Path | None = None) -> str:
    """Describe whether a path is a host path, container path, or shared mount."""
    if not in_container_runtime():
        return "host path"
    if path is None:
        return "container path"

    root = host_io_root()
    resolved = Path(path).expanduser().resolve(strict=False)
    if resolved == root or root in resolved.parents:
        return "container path (host-shared mount)"
    return "container path"


def resolve_workspace_transfer_path(path: str | Path) -> Path:
    """Resolve import/export paths, enforcing the host-shared mount in containers."""
    candidate = Path(path).expanduser()
    if not in_container_runtime():
        return candidate.resolve(strict=False)

    root = host_io_root()
    if candidate.is_absolute():
        resolved = candidate.resolve(strict=False)
        if resolved == root or root in resolved.parents:
            return resolved
        raise ValueError(
            f"In container runtime, workspace import/export paths must be under {root}."
        )

    return (root / candidate).resolve(strict=False)


def map_common_host_io_path(candidate: Path, root: Path | None = None) -> Path | None:
    """Map pasted host paths into the container's shared host I/O mount when possible."""
    resolved_root = root or host_io_root()
    parts = list(candidate.parts)

    if "caracal-host-io" in parts:
        idx = parts.index("caracal-host-io")
        trailing = parts[idx + 1 :]
        return resolved_root.joinpath(*trailing).resolve(strict=False)

    mapped_by_name = (resolved_root / candidate.name).resolve(strict=False)
    if mapped_by_name.exists():
        return mapped_by_name

    return None
