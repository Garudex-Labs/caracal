"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Workspace management for Caracal Flow.

Provides centralized path resolution so every module resolves files
relative to the active workspace root.

The initial workspace root is resolved dynamically from the workspace marked
as default/active.

Usage::

    from caracal.flow.workspace import get_workspace

    workspace = get_workspace()                    # active default workspace
    workspace = get_workspace("/opt/myproject")    # custom path

    workspace.config_path   # -> /opt/myproject/config.yaml
    workspace.state_path    # -> /opt/myproject/flow_state.json
    workspace.backups_dir   # -> /opt/myproject/backups
    workspace.logs_dir      # -> /opt/myproject/logs
    workspace.cache_dir     # -> /opt/myproject/cache
    workspace.log_path      # -> /opt/myproject/logs/caracal.log
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Optional

import toml

from caracal.pathing import ensure_source_tree
from caracal.storage.layout import resolve_caracal_home


_CCL_HOME_ROOT = resolve_caracal_home(require_explicit=False)
_WORKSPACES_DIR = _CCL_HOME_ROOT / "workspaces"
_RESERVED_WORKSPACE_NAMES = {"_deleted_backups"}


class WorkspaceManager:
    """Resolve all Caracal paths relative to a workspace root.

    Parameters
    ----------
    root:
        Workspace root directory.
    """

    def __init__(self, root: Optional[Path] = None) -> None:
        self._root = Path(root) if root else _resolve_initial_workspace_root()

    # ------------------------------------------------------------------
    # Path properties
    # ------------------------------------------------------------------

    @property
    def root(self) -> Path:
        """Workspace root directory."""
        return self._root

    @property
    def config_path(self) -> Path:
        """Path to ``config.yaml``."""
        return self._root / "config.yaml"

    @property
    def state_path(self) -> Path:
        """Path to ``flow_state.json``."""
        return self._root / "flow_state.json"

    @property
    def backups_dir(self) -> Path:
        """Path to ``backups/`` sub-directory."""
        return self._root / "backups"

    @property
    def logs_dir(self) -> Path:
        """Path to ``logs/`` sub-directory."""
        return self._root / "logs"

    @property
    def cache_dir(self) -> Path:
        """Path to ``cache/`` sub-directory."""
        return self._root / "cache"

    @property
    def keys_dir(self) -> Path:
        """Path to ``keys/`` sub-directory."""
        return self._root / "keys"

    @property
    def log_path(self) -> Path:
        """Path to workspace log file ``logs/caracal.log``."""
        return self.logs_dir / "caracal.log"

    # ------------------------------------------------------------------
    # Directory management
    # ------------------------------------------------------------------

    def ensure_dirs(self) -> None:
        """Create workspace directory structure if it does not exist."""
        ensure_source_tree(self._root)
        self.backups_dir.mkdir(exist_ok=True)
        self.logs_dir.mkdir(exist_ok=True)
        self.cache_dir.mkdir(exist_ok=True)
        self.keys_dir.mkdir(exist_ok=True)

    # ------------------------------------------------------------------
    # Workspace registry (optional multi-workspace support)
    # ------------------------------------------------------------------

    @staticmethod
    def list_workspaces() -> list[dict[str, object]]:
        """Return discovered workspaces with default selection from workspace metadata."""
        workspaces = _discover_workspace_directories()
        if not workspaces:
            return []

        default_name = _resolve_default_workspace_name(workspaces)
        for workspace in workspaces:
            workspace["default"] = workspace.get("name") == default_name

        _ensure_single_default(workspaces)
        return workspaces

    @staticmethod
    def register_workspace(
        name: str,
        path: str | Path,
        is_default: Optional[bool] = None,
    ) -> None:
        """Register workspace metadata without file-backed registry persistence."""
        workspace_path = Path(path).resolve()
        ensure_source_tree(workspace_path)
        _ensure_workspace_metadata_file(name, workspace_path, is_default=bool(is_default))
        if is_default:
            _set_default_workspace_name(name)

    @staticmethod
    def set_default_workspace(name: str) -> bool:
        """Mark one workspace as default using config manager state."""
        workspaces = WorkspaceManager.list_workspaces()
        if not any(workspace.get("name") == name for workspace in workspaces):
            return False

        _set_default_workspace_name(name)
        return True

    def delete_workspace(path: str | Path, delete_directory: bool = False) -> bool:
        """Remove a workspace from discovered workspace state.
        
        Args:
            path: Workspace path to delete
            delete_directory: If True, also delete the workspace directory from disk
            
        Returns:
            True if workspace was deleted, False otherwise
        """
        import shutil
        workspace_path = Path(path).resolve()
        workspace_name = workspace_path.name
        workspace_exists = workspace_path.exists()
        was_default = bool(_load_workspace_metadata(workspace_name).get("is_default"))

        if delete_directory and workspace_exists:
            shutil.rmtree(workspace_path)

        if was_default:
            remaining = [workspace["name"] for workspace in _discover_workspace_directories() if workspace["name"] != workspace_name]
            _set_default_workspace_name(remaining[0] if remaining else None)

        return workspace_exists or was_default

    @staticmethod
    def delete_all_workspaces(delete_directories: bool = False) -> int:
        """Delete all registered workspaces.

        Args:
            delete_directories: If True, also remove workspace directories from disk.

        Returns:
            Number of workspaces successfully removed from the registry.
        """
        workspaces = WorkspaceManager.list_workspaces()
        if not workspaces:
            return 0

        # Remove all registry entries first so deleting a workspace directory that
        # contains the registry file (e.g. ~/.caracal) does not interrupt the loop.
        deleted_count = 0
        for workspace in workspaces:
            if WorkspaceManager.delete_workspace(workspace["path"], delete_directory=False):
                deleted_count += 1

        if delete_directories:
            import shutil

            for workspace in workspaces:
                workspace_path = Path(workspace["path"]).resolve()
                if workspace_path.exists():
                    shutil.rmtree(workspace_path)

        return deleted_count

    # ------------------------------------------------------------------
    # repr
    # ------------------------------------------------------------------

    def __repr__(self) -> str:
        return f"WorkspaceManager(root={self._root!r})"


# ------------------------------------------------------------------
# Module-level convenience
# ------------------------------------------------------------------

_current_workspace: Optional[WorkspaceManager] = None


def clear_workspace_cache() -> None:
    """Clear cached workspace manager so next resolution uses current metadata."""
    global _current_workspace
    _current_workspace = None


def get_workspace(root: Optional[str | Path] = None) -> WorkspaceManager:
    """Return a ``WorkspaceManager`` for the given root.

    When called without arguments the first time, resolves the current
    default/active workspace. Subsequent calls without arguments
    return the same instance.  Passing *root* always creates a fresh
    manager.
    """
    global _current_workspace

    if root is not None:
        return WorkspaceManager(Path(root))

    if _current_workspace is None:
        _current_workspace = WorkspaceManager()
        _current_workspace.ensure_dirs()

    return _current_workspace


def set_workspace(root: str | Path) -> WorkspaceManager:
    """Set the global workspace root and return the manager.

    This is typically called once at application startup (CLI or TUI)
    before any other module reads paths.
    """
    global _current_workspace
    _current_workspace = WorkspaceManager(Path(root))
    _current_workspace.ensure_dirs()
    return _current_workspace


def _resolve_initial_workspace_root() -> Path:
    """Resolve initial workspace root from active/default workspace metadata."""
    default_name = _resolve_default_workspace_name(_discover_workspace_directories())
    if default_name:
        candidate = _WORKSPACES_DIR / default_name
        if candidate.exists():
            return candidate

    # Fallback to first valid workspace directory if it exists.
    try:
        if _WORKSPACES_DIR.exists():
            candidates = sorted(
                p for p in _WORKSPACES_DIR.iterdir()
                if p.is_dir() and (p / "workspace.toml").exists()
            )
            if candidates:
                return candidates[0]
    except OSError:
        pass

    # Last resort for brand-new installs before onboarding creates a workspace.
    return _CCL_HOME_ROOT


def _workspace_metadata_path(name: str) -> Path:
    return _WORKSPACES_DIR / name / "workspace.toml"


def _load_workspace_metadata(name: str) -> dict[str, object]:
    config_path = _workspace_metadata_path(name)
    if not config_path.exists():
        return {}
    try:
        loaded = toml.load(config_path)
    except (toml.TomlDecodeError, OSError, TypeError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _save_workspace_metadata(name: str, metadata: dict[str, object]) -> None:
    config_path = _workspace_metadata_path(name)
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(toml.dumps(metadata))


def _ensure_workspace_metadata_file(
    name: str,
    workspace_path: Path,
    *,
    is_default: bool = False,
) -> None:
    config = _load_workspace_metadata(name)
    if config:
        if is_default and not config.get("is_default"):
            config["is_default"] = True
            config["updated_at"] = datetime.now().isoformat()
            _save_workspace_metadata(name, config)
        return

    now = datetime.now().isoformat()
    _save_workspace_metadata(
        name,
        {
            "name": name,
            "created_at": now,
            "updated_at": now,
            "is_default": is_default,
            "metadata": {"source": "flow.workspace"},
        },
    )


def _resolve_default_workspace_name(workspaces: list[dict[str, object]]) -> Optional[str]:
    if not workspaces:
        return None

    names = [str(workspace.get("name")) for workspace in workspaces if workspace.get("name")]
    for name in names:
        if _load_workspace_metadata(name).get("is_default"):
            return name
    return names[0] if names else None


def _set_default_workspace_name(name: Optional[str]) -> None:
    discovered = _discover_workspace_directories()
    discovered_names = [str(workspace["name"]) for workspace in discovered]
    for workspace_name in discovered_names:
        workspace_path = _WORKSPACES_DIR / workspace_name
        _ensure_workspace_metadata_file(workspace_name, workspace_path)
        metadata = _load_workspace_metadata(workspace_name)
        should_be_default = name is not None and workspace_name == name
        if bool(metadata.get("is_default")) == should_be_default:
            continue
        metadata["is_default"] = should_be_default
        metadata["updated_at"] = datetime.now().isoformat()
        _save_workspace_metadata(workspace_name, metadata)

def _ensure_single_default(workspaces: list[dict[str, object]]) -> None:
    """Ensure at most one default workspace and assign one when possible."""
    if not workspaces:
        return

    default_indices = [idx for idx, workspace in enumerate(workspaces) if bool(workspace.get("default"))]
    if not default_indices:
        workspaces[0]["default"] = True
        return

    keep = default_indices[0]
    for idx, workspace in enumerate(workspaces):
        workspace["default"] = idx == keep


def _discover_workspace_directories() -> list[dict[str, object]]:
    """Discover valid workspace directories from disk."""
    discovered: list[dict[str, object]] = []
    if not _WORKSPACES_DIR.exists():
        return discovered

    for item in sorted(_WORKSPACES_DIR.iterdir()):
        if not item.is_dir() or item.name in _RESERVED_WORKSPACE_NAMES:
            continue
        discovered.append({
            "name": item.name,
            "path": str(item),
            "default": False,
        })

    return discovered
