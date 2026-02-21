from caracal._version import get_version
"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Workflows Extension (Enterprise Stub).

Event-driven workflow automation.
In the open-source edition, all methods raise EnterpriseFeatureRequired.
"""

from __future__ import annotations

from typing import Any

from caracal.sdk.extensions import CaracalExtension
from caracal.sdk.hooks import HookRegistry
from caracal.sdk.enterprise.exceptions import EnterpriseFeatureRequired


class WorkflowsExtension(CaracalExtension):
    """Enterprise event-driven workflow automation extension."""

    @property
    def name(self) -> str:
        return "workflows"

    @property
    def version(self) -> str:
        return get_version()

    def install(self, hooks: HookRegistry) -> None:
        hooks.on_state_change(self._trigger_workflows)

    def _trigger_workflows(self, state: Any) -> None:
        raise EnterpriseFeatureRequired(
            feature="Workflow Automation",
            message="Event-driven workflows require Caracal Enterprise.",
        )

    def register_workflow(self, name: str, trigger: str, action: Any) -> None:
        """Register a workflow trigger → action pair."""
        raise EnterpriseFeatureRequired(
            feature="Workflow Registration",
            message="Workflow registration requires Caracal Enterprise.",
        )
