"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Regression tests for Flow workspace registry filtering.
"""

import json

from caracal.flow.workspace import WorkspaceManager


class TestFlowWorkspaceRegistry:
    """Test registry handling for discoverable workspaces."""

    def test_list_workspaces_filters_reserved_internal_entries(self, tmp_path, monkeypatch):
        """Reserved internal directories must be scrubbed from the registry."""
        registry_path = tmp_path / "workspaces.json"
        workspaces_dir = tmp_path / "workspaces"
        monkeypatch.setattr("caracal.flow.workspace._WORKSPACES_DIR", workspaces_dir)

        registry_path.write_text(
            json.dumps(
                {
                    "workspaces": [
                        {
                            "name": "_deleted_backups",
                            "path": str(workspaces_dir / "_deleted_backups"),
                            "default": True,
                        },
                        {
                            "name": "default",
                            "path": str(workspaces_dir / "default"),
                            "default": False,
                        },
                    ]
                }
            ),
            encoding="utf-8",
        )

        listed = WorkspaceManager.list_workspaces(registry_path)

        assert listed == [
            {
                "name": "default",
                "path": str(workspaces_dir / "default"),
                "default": True,
            }
        ]
