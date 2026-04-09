"""Runtime surface guards for removed SDK resource APIs."""

from __future__ import annotations

from caracal_sdk._compat import SDKConfigurationError

def require_legacy_resource_api(operation: str, endpoint_group: str) -> None:
    """Fail closed for removed legacy resource APIs.

    Hard-cut runtime supports MCP/AIS execution APIs and does not expose legacy
    CRUD resource routes.
    """

    raise SDKConfigurationError(
        (
            f"{operation} targets removed legacy '{endpoint_group}' SDK routes. "
            "Legacy compatibility is not supported in hard-cut mode. "
            "Use scope.tools.call(...) for execution, and manage principal identities "
            "(orchestrator/worker/service/human) via principal control surfaces."
        )
    )
