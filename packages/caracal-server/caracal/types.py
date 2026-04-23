"""
Shared typing helpers for HTTP/API layers (Pydantic).

Centralizes strict request/response model configuration and JSON-shaped aliases
used across FastAPI surfaces so AIS, MCP, and future services stay consistent.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, JsonValue

JsonObject = dict[str, JsonValue]


class StrictAPIModel(BaseModel):
    """Reject unknown fields on API request models."""

    model_config = ConfigDict(extra="forbid")
