"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SDK Transport Adapter base class and data structures.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, Optional


@dataclass
class SDKRequest:
    """Outbound SDK request representation."""
    method: str
    path: str
    headers: Dict[str, str] = field(default_factory=dict)
    body: Optional[Dict[str, Any]] = None
    params: Optional[Dict[str, Any]] = None


@dataclass
class SDKResponse:
    """Inbound SDK response representation."""
    status_code: int
    headers: Dict[str, str] = field(default_factory=dict)
    body: Any = None
    elapsed_ms: float = 0.0


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
