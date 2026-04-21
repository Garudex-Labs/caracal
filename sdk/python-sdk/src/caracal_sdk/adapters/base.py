"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SDK Transport Adapter base class and data structures.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from caracal_sdk.transport_types import SDKRequest, SDKResponse


class BaseAdapter(ABC):
    """Abstract base for all transport adapters."""

    @abstractmethod
    async def send(self, request: SDKRequest) -> SDKResponse:
        """Send a request and return the response."""
        ...

    @abstractmethod
    def close(self) -> None:
        """Release adapter resources."""
        ...

    @property
    @abstractmethod
    def is_connected(self) -> bool:
        """Whether the adapter is in a usable state."""
        ...
