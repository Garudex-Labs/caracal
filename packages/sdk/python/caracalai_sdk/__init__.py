"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Public surface of the Caracal Python SDK.

The drop-in API is the ``Caracal`` class. Construct it once (or call
``Caracal.from_env()``) and use ``run``, ``delegate``, ``httpx_client``,
``middleware``, ``context``, and ``headers`` directly. Everything else
is advanced and lives in ``caracalai_sdk.advanced``.
"""

from .client import Caracal, CaracalConfig
from .context import CaracalContext
from .http import CaracalASGIMiddleware

__all__ = [
    "Caracal",
    "CaracalConfig",
    "CaracalContext",
    "CaracalASGIMiddleware",
]

