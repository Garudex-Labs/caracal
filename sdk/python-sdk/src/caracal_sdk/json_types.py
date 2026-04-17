"""
Shared JSON payload type aliases for SDK transport and extension surfaces.
"""

from __future__ import annotations

from typing import TypeAlias

JsonPrimitive: TypeAlias = None | bool | int | float | str
JsonValue: TypeAlias = JsonPrimitive | list["JsonValue"] | dict[str, "JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]
JsonArray: TypeAlias = list[JsonValue]
QueryValue: TypeAlias = str | int | float | bool | None
QueryParams: TypeAlias = dict[str, QueryValue]
