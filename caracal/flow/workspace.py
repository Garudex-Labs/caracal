"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Workspace management for Caracal Flow.

Provides centralized path resolution so every module resolves files
relative to the active workspace root instead of hardcoding ``~/.caracal/``.

The initial workspace root is resolved dynamically from the workspace marked
as default/active.

Usage::

    from caracal.flow.workspace import get_workspace

    ws = get_workspace()                    # active default workspace
    ws = get_workspace("/opt/myproject")    # custom path

    ws.config_path   # -> /opt/myproject/config.yaml
    ws.state_path    # -> /opt/myproject/flow_state.json
    ws.db_path       # -> /opt/myproject/caracal.db
    ws.backups_dir   # -> /opt/myproject/backups
    ws.logs_dir      # -> /opt/myproject/logs
    ws.cache_dir     # -> /opt/myproject/cache
    ws.log_path      # -> /opt/myproject/logs/caracal.log
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

from caracal.pathing import ensure_source_tree, source_of


_WORKSPACES_DIR = Path.home() / ".caracal" / "workspaces"
_LEGACY_ROOT = Path.home() / ".caracal"
_RESERVED_WORKSPACE_NAMES = {"primary", "_deleted_backups"}

# Global registry file lives outside any individual workspace so it can index all of them.
_REGISTRY_PATH = Path.home() / ".caracal" / "workspaces.json"


class WorkspaceManager:
    """Resolve all Caracal paths relative to a workspace root.

    Parameters
    ----------
    root:
        Workspace root directory.  Defaults to ``~/.caracal/``.
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
    def db_path(self) -> Path:
        """Legacy property — SQLite is no longer supported.

        Retained only so callers that check file existence don't crash.
        The returned path will typically not exist.
        """
        return self._root / "caracal.db"

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

    @property
    def master_password_path(self) -> Path:
        """Path to ``master_password``."""
        return self._root / "master_password"

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
        self._migrate_legacy_runtime_artifacts()

    def _migrate_legacy_runtime_artifacts(self) -> None:
        """Move legacy runtime files from ``~/.caracal`` into default workspace.

        This keeps ``~/.caracal`` focused on workspace registry/config files and
        avoids scattering runtime artifacts at the root level.
        """
        if source_of(self._root) != _WORKSPACES_DIR:
            return

        import shutil

        mappings = [
            (_LEGACY_ROOT / "backups", self.backups_dir),
            (_LEGACY_ROOT / "logs", self.logs_dir),
            (_LEGACY_ROOT / "cache", self.cache_dir),
            (_LEGACY_ROOT / "caracal.log", self.log_path),
        ]

        for legacy_path, workspace_path in mappings:
            if not legacy_path.exists():
                continue
            if legacy_path.resolve() == workspace_path.resolve():
                continue

            try:
                if legacy_path.is_file():
                    if not workspace_path.exists():
                        ensure_source_tree(source_of(workspace_path))
                        shutil.move(str(legacy_path), str(workspace_path))
                    continue

                ensure_source_tree(workspace_path)
                for legacy_child in legacy_path.iterdir():
                    target_path = workspace_path / legacy_child.name
                    if target_path.exists():
                        continue
                    shutil.move(str(legacy_child), str(target_path))

                # Remove empty legacy directory after migration.
                if not any(legacy_path.iterdir()):
                    legacy_path.rmdir()
            except Exception:
                # Best-effort migration; never block workspace initialization.
                continue

    # ------------------------------------------------------------------
    # Workspace registry (optional multi-workspace support)
    # ------------------------------------------------------------------

    @staticmethod
    def list_workspaces(
        registry_path: Optional[Path] = None,
    ) -> list[dict[str, Any]]:
        """Return the list of registered workspaces.

        Each entry has ``name``, ``path`` and ``default`` keys.
        """
        rp = registry_path or _REGISTRY_PATH
        workspaces = _load_registry_workspaces(rp)

        # Merge discovered workspace directories so onboarding/list screens
        # reflect what actually exists on disk even when registry is stale.
        discovered = _discover_workspace_directories()
        if discovered:
            known_paths = {
                str(Path(ws.get("path", "")).expanduser().resolve())
                for ws in workspaces
                if ws.get("path")
            }
            for ws in discovered:
                resolved_path = str(Path(ws["path"]).expanduser().resolve())
                if resolved_path in known_paths:
                    continue
                workspaces.append(ws)
                known_paths.add(resolved_path)

        _ensure_single_default(workspaces)

        # Persist when registry exists, or bootstrap it from discovery.
        if rp.exists() or workspaces:
            _save_registry_workspaces(rp, workspaces)
        return workspaces

    @staticmethod
    def register_workspace(
        name: str,
        path: str | Path,
        registry_path: Optional[Path] = None,
        is_default: Optional[bool] = None,
    ) -> None:
        """Add a workspace to the global registry.

        Duplicates (by path) are updated in place.
        """
        rp = registry_path or _REGISTRY_PATH
        ensure_source_tree(source_of(rp))
        workspaces = _load_registry_workspaces(rp)

        # Deduplicate by resolved path
        resolved = str(Path(path).resolve())
        existing_idx = next(
            (
                idx
                for idx, ws in enumerate(workspaces)
                if str(Path(ws.get("path", "")).resolve()) == resolved
            ),
            None,
        )

        if existing_idx is not None:
            workspaces[existing_idx]["name"] = name
            target_idx = existing_idx
        else:
            workspaces.append({"name": name, "path": str(path), "default": False})
            target_idx = len(workspaces) - 1

        # First workspace defaults to default=true unless explicitly set.
        if is_default is None:
            is_default = not any(bool(ws.get("default")) for ws in workspaces)

        if is_default:
            for ws in workspaces:
                ws["default"] = False
            workspaces[target_idx]["default"] = True
        else:
            workspaces[target_idx]["default"] = bool(workspaces[target_idx].get("default", False))

        _ensure_single_default(workspaces)
        _save_registry_workspaces(rp, workspaces)

    @staticmethod
    def set_default_workspace(
        name: str,
        registry_path: Optional[Path] = None,
    ) -> bool:
        """Mark one registered workspace as default by name."""
        rp = registry_path or _REGISTRY_PATH
        workspaces = _load_registry_workspaces(rp)
        if not workspaces:
            return False

        found = False
        for ws in workspaces:
            if ws.get("name") == name:
                ws["default"] = True
                found = True
            else:
                ws["default"] = False

        if not found:
            return False

        _save_registry_workspaces(rp, workspaces)
        return True

    def delete_workspace(
        path: str | Path,
        registry_path: Optional[Path] = None,
        delete_directory: bool = False,
    ) -> bool:
        """Remove a workspace from the global registry.
        
        Args:
            path: Workspace path to delete
            registry_path: Optional custom registry path
            delete_directory: If True, also delete the workspace directory from disk
            
        Returns:
            True if workspace was deleted, False otherwise
        """
        import shutil
        import re as _re
        
        rp = registry_path or _REGISTRY_PATH
        if not rp.exists():
            return False

        workspaces = _load_registry_workspaces(rp)

        # Find and remove by resolved path
        resolved = str(Path(path).resolve())
        original_count = len(workspaces)
        removed_ws = None
        remaining = []
        for w in workspaces:
            if str(Path(w["path"]).resolve()) == resolved:
                removed_ws = w
            else:
                remaining.append(w)
        workspaces = remaining

        if len(workspaces) < original_count:
            # Drop the workspace's PostgreSQL schema before removing files
            if removed_ws:
                ws_name = removed_ws.get("name", "")
                schema_name = "ws_" + _re.sub(r"[^a-z0-9_]", "_", ws_name.lower())
                try:
                    from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
                    # Try to read DB credentials from the workspace's own config.yaml
                    ws_config_file = Path(removed_ws["path"]) / "config.yaml"
                    db_kwargs = {}
                    if ws_config_file.exists():
                        try:
                            import yaml
                            with open(ws_config_file, "r") as _f:
                                _cfg = yaml.safe_load(_f) or {}
                            _db = _cfg.get("database", {})
                            schema_name = _db.get("schema", schema_name)
                            db_kwargs = {
                                "host": _db.get("host", "localhost"),
                                "port": int(_db.get("port", 5432)),
                                "database": _db.get("database", "caracal"),
                                "user": _db.get("user", "caracal"),
                                "password": _db.get("password", ""),
                            }
                        except Exception:
                            pass
                    # DatabaseConfig will also check env vars as fallback
                    db_config = DatabaseConfig(**db_kwargs)
                    mgr = DatabaseConnectionManager(db_config)
                    mgr.initialize()
                    mgr.drop_schema(schema_name=schema_name)
                    mgr.close()
                except Exception as _e:
                    import logging as _log
                    _log.getLogger(__name__).warning(
                        "Failed to drop schema %s: %s", schema_name, _e
                    )
            
            # Save updated registry
            _ensure_single_default(workspaces)
            _save_registry_workspaces(rp, workspaces)
            
            # Optionally delete the directory
            if delete_directory:
                workspace_path = Path(path).resolve()
                if workspace_path.exists():
                    shutil.rmtree(workspace_path)
            
            return True
        
        return False

    @staticmethod
    def delete_all_workspaces(
        registry_path: Optional[Path] = None,
        delete_directories: bool = False,
    ) -> int:
        """Delete all registered workspaces.

        Args:
            registry_path: Optional custom registry path.
            delete_directories: If True, also remove workspace directories from disk.

        Returns:
            Number of workspaces successfully removed from the registry.
        """
        rp = registry_path or _REGISTRY_PATH
        workspaces = WorkspaceManager.list_workspaces(rp)
        if not workspaces:
            return 0

        # Remove all registry entries first so deleting a workspace directory that
        # contains the registry file (e.g. ~/.caracal) does not interrupt the loop.
        deleted_count = 0
        for ws in workspaces:
            if WorkspaceManager.delete_workspace(
                ws["path"],
                registry_path=rp,
                delete_directory=False,
            ):
                deleted_count += 1

        if delete_directories:
            import shutil

            for ws in workspaces:
                workspace_path = Path(ws["path"]).resolve()
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
    _cleanup_legacy_primary_dir()

    try:
        from caracal.deployment.config_manager import ConfigManager

        cfg = ConfigManager()
        default_name = cfg.get_default_workspace_name()
        if default_name:
            return cfg.get_workspace_path(default_name)
    except Exception:
        pass

    # Fallback to default workspace from global registry if available.
    try:
        workspaces = WorkspaceManager.list_workspaces()
        default_ws = next((ws for ws in workspaces if ws.get("default")), None)
        if default_ws and default_ws.get("path"):
            return Path(str(default_ws["path"]))
        if workspaces and workspaces[0].get("path"):
            return Path(str(workspaces[0]["path"]))
    except Exception:
        pass

    # Fallback to first valid workspace directory if it exists.
    try:
        if _WORKSPACES_DIR.exists():
            candidates = sorted(
                p for p in _WORKSPACES_DIR.iterdir()
                if p.is_dir() and (p / "workspace.toml").exists() and p.name != "primary"
            )
            if candidates:
                return candidates[0]
    except Exception:
        pass

    # Last resort for brand-new installs before onboarding creates a workspace.
    # Do not create a synthetic "primary" workspace directory.
    return _LEGACY_ROOT


def _cleanup_legacy_primary_dir() -> None:
    """Remove legacy synthetic ``workspaces/primary`` when it is empty."""
    primary_dir = _WORKSPACES_DIR / "primary"
    if not primary_dir.exists() or not primary_dir.is_dir():
        return

    try:
        # Only remove when it contains no files and only known runtime dirs.
        targetren = list(primary_dir.iterdir())
        allowed = {"backups", "logs", "cache", "keys"}
        if any(target.is_file() for target in targetren):
            return
        if any(target.name not in allowed for target in targetren):
            return

        import shutil

        shutil.rmtree(primary_dir)
    except Exception:
        # Best effort cleanup; never block startup.
        return


def _load_registry_workspaces(registry_path: Path) -> list[dict[str, Any]]:
    """Load and normalize workspaces registry entries."""
    if not registry_path.exists():
        return []

    with open(registry_path, "r") as fh:
        data = json.load(fh) or {}

    normalized: list[dict[str, Any]] = []
    for ws in data.get("workspaces", []):
        if not isinstance(ws, dict):
            continue
        name = ws.get("name")
        path = ws.get("path")
        if not name or not path:
            continue
        if str(name) in _RESERVED_WORKSPACE_NAMES:
            continue
        normalized.append(
            {
                "name": str(name),
                "path": str(path),
                "default": bool(ws.get("default", False)),
            }
        )

    _ensure_single_default(normalized)
    return normalized


def _save_registry_workspaces(registry_path: Path, workspaces: list[dict[str, Any]]) -> None:
    """Persist normalized workspaces registry entries."""
    ensure_source_tree(source_of(registry_path))
    with open(registry_path, "w") as fh:
        json.dump({"workspaces": workspaces}, fh, indent=2)


def _ensure_single_default(workspaces: list[dict[str, Any]]) -> None:
    """Ensure at most one default workspace and assign one when possible."""
    if not workspaces:
        return

    default_indices = [idx for idx, ws in enumerate(workspaces) if bool(ws.get("default"))]
    if not default_indices:
        workspaces[0]["default"] = True
        return

    keep = default_indices[0]
    for idx, ws in enumerate(workspaces):
        ws["default"] = idx == keep


def _discover_workspace_directories() -> list[dict[str, Any]]:
    """Discover valid workspace directories from disk."""
    discovered: list[dict[str, Any]] = []
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
