"""Helpers for container-aware path handling and truthy env parsing."""

from __future__ import annotations

import os
from pathlib import Path


IN_CONTAINER_ENV = "CARACAL_RUNTIME_IN_CONTAINER"
HOST_IO_ROOT_ENV = "CARACAL_HOST_IO_ROOT"
DEFAULT_HOST_IO_ROOT = Path("/caracal-host-io")
TRUTHY_ENV_VALUES = frozenset({"1", "true", "yes", "on"})
FALSY_ENV_VALUES = frozenset({"0", "false", "no", "off"})


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
    if is_truthy_env(os.environ.get(IN_CONTAINER_ENV)):
        return True
    return detect_dockerenv and Path("/.dockerenv").exists()


def host_io_root() -> Path:
    """Return the shared host I/O mount path used by the runtime container."""
    return Path(os.environ.get(HOST_IO_ROOT_ENV, str(DEFAULT_HOST_IO_ROOT))).resolve(strict=False)


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
