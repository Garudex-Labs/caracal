"""
Workspace management for Caracal Flow.

Provides centralized path resolution so every module resolves files
relative to the active workspace root instead of hardcoding ``~/.caracal/``.

The default workspace root is ``~/.caracal/``, preserving backward
compatibility with existing installations.

Usage::

    from caracal.flow.workspace import get_workspace

    ws = get_workspace()                    # default (~/.caracal/)
    ws = get_workspace("/opt/myproject")    # custom path

    ws.config_path   # -> /opt/myproject/config.yaml
    ws.state_path    # -> /opt/myproject/flow_state.json
    ws.db_path       # -> /opt/myproject/caracal.db
    ws.backups_dir   # -> /opt/myproject/backups
    ws.log_path      # -> /opt/myproject/caracal.log
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional


_DEFAULT_ROOT = Path.home() / ".caracal"

# Global registry file lives *outside* any workspace so it can index all of them.
_REGISTRY_PATH = Path.home() / ".caracal" / "workspaces.json"


class WorkspaceManager:
    """Resolve all Caracal paths relative to a workspace root.

    Parameters
    ----------
    root:
        Workspace root directory.  Defaults to ``~/.caracal/``.
    """

    def __init__(self, root: Optional[Path] = None) -> None:
        self._root = Path(root) if root else _DEFAULT_ROOT

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
        """Path to ``caracal.db`` (SQLite fallback)."""
        return self._root / "caracal.db"

    @property
    def backups_dir(self) -> Path:
        """Path to ``backups/`` sub-directory."""
        return self._root / "backups"

    @property
    def log_path(self) -> Path:
        """Path to ``caracal.log``."""
        return self._root / "caracal.log"

    @property
    def agents_path(self) -> Path:
        """Path to ``agents.json``."""
        return self._root / "agents.json"

    @property
    def policies_path(self) -> Path:
        """Path to ``policies.json``."""
        return self._root / "policies.json"

    @property
    def ledger_path(self) -> Path:
        """Path to ``ledger.jsonl``."""
        return self._root / "ledger.jsonl"

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
        
        rp = registry_path or _REGISTRY_PATH
        if not rp.exists():
            return False

        with open(rp, "r") as fh:
            data = json.load(fh)
        workspaces = data.get("workspaces", [])

        # Find and remove by resolved path
        resolved = str(Path(path).resolve())
        original_count = len(workspaces)
        workspaces = [
            w for w in workspaces
            if str(Path(w["path"]).resolve()) != resolved
        ]

        if len(workspaces) < original_count:
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

    When called without arguments the first time, creates the default
    workspace (``~/.caracal/``).  Subsequent calls without arguments
    return the same instance.  Passing *root* always creates a fresh
    manager.
    """
    global _current_workspace

    if root is not None:
        return WorkspaceManager(Path(root))

    if _current_workspace is None:
        _current_workspace = WorkspaceManager()

    return _current_workspace


def set_workspace(root: str | Path) -> WorkspaceManager:
    """Set the global workspace root and return the manager.

    This is typically called once at application startup (CLI or TUI)
    before any other module reads paths.
    """
    global _current_workspace
    _current_workspace = WorkspaceManager(Path(root))
    return _current_workspace
