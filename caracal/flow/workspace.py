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
from typing import Optional


_WORKSPACES_DIR = Path.home() / ".caracal" / "workspaces"
_FALLBACK_ROOT = _WORKSPACES_DIR / "primary"
_LEGACY_ROOT = Path.home() / ".caracal"

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
        self._root.mkdir(parents=True, exist_ok=True)
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
        if self._root.parent != _WORKSPACES_DIR:
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
                        workspace_path.parent.mkdir(parents=True, exist_ok=True)
                        shutil.move(str(legacy_path), str(workspace_path))
                    continue

                workspace_path.mkdir(parents=True, exist_ok=True)
                for child in legacy_path.iterdir():
                    target = workspace_path / child.name
                    if target.exists():
                        continue
                    shutil.move(str(child), str(target))

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
    ) -> list[dict[str, str]]:
        """Return the list of registered workspaces.

        Each entry has ``name`` and ``path`` keys.
        """
        rp = registry_path or _REGISTRY_PATH
        if not rp.exists():
            return []
        with open(rp, "r") as fh:
            data = json.load(fh)
        return data.get("workspaces", [])

    @staticmethod
    def register_workspace(
        name: str,
        path: str | Path,
        registry_path: Optional[Path] = None,
    ) -> None:
        """Add a workspace to the global registry.

        Duplicates (by path) are silently skipped.
        """
        rp = registry_path or _REGISTRY_PATH
        rp.parent.mkdir(parents=True, exist_ok=True)

        workspaces: list[dict[str, str]] = []
        if rp.exists():
            with open(rp, "r") as fh:
                data = json.load(fh)
            workspaces = data.get("workspaces", [])

        # Deduplicate by resolved path
        resolved = str(Path(path).resolve())
        if any(str(Path(w["path"]).resolve()) == resolved for w in workspaces):
            return

        workspaces.append({"name": name, "path": str(path)})
        with open(rp, "w") as fh:
            json.dump({"workspaces": workspaces}, fh, indent=2)

    @staticmethod
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

        with open(rp, "r") as fh:
            data = json.load(fh)
        workspaces = data.get("workspaces", [])

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
            with open(rp, "w") as fh:
                json.dump({"workspaces": workspaces}, fh, indent=2)
            
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
    try:
        from caracal.deployment.config_manager import ConfigManager

        cfg = ConfigManager()
        default_name = cfg.get_default_workspace_name()
        if default_name:
            return cfg.get_workspace_path(default_name)
    except Exception:
        pass

    # Fallback to first valid workspace directory if it exists.
    try:
        if _WORKSPACES_DIR.exists():
            candidates = sorted(
                p for p in _WORKSPACES_DIR.iterdir()
                if p.is_dir() and (p / "workspace.toml").exists()
            )
            if candidates:
                return candidates[0]
    except Exception:
        pass

    # Last resort for brand-new installs before onboarding creates a workspace.
    return _FALLBACK_ROOT
