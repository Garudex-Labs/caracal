"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Workflows Extension (Enterprise Stub).

Event-driven workflow automation.
In the open-source edition, all methods raise EnterpriseFeatureRequired.
"""

from __future__ import annotations
from caracal_sdk._compat import get_version

from typing import NoReturn

from caracal_sdk.extensions import CaracalExtension
from caracal_sdk.hooks import HookRegistry, StateSnapshot
from caracal_sdk.json_types import JsonObject
from caracal_sdk.enterprise.exceptions import EnterpriseFeatureRequired


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

    def _trigger_workflows(self, state: StateSnapshot) -> None:
        raise EnterpriseFeatureRequired(
            feature="Workflow Automation",
            message=(
                "Event-driven workflows require Caracal Enterprise. "
                f"(state snapshot: {type(state).__name__})"
            ),
        )

    def register_workflow(self, name: str, trigger: str, action: JsonObject) -> NoReturn:
        """Register a workflow trigger → action pair."""
        raise EnterpriseFeatureRequired(
            feature="Workflow Registration",
            message=(
                "Workflow registration requires Caracal Enterprise. "
                f"(name={name!r}, trigger={trigger!r}, action keys: {', '.join(sorted(action)) if action else '—'})"
            ),
        )
