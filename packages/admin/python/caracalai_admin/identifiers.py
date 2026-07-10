"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Identifier helpers for provider and resource audience strings.
"""

from __future__ import annotations

import re
from urllib.parse import urlsplit

PROVIDER_IDENTIFIER_PATTERN = re.compile(r"^provider://[a-z0-9]+(?:-[a-z0-9]+)*$")
RESOURCE_IDENTIFIER_PREFIX = "resource://"
PROVIDER_IDENTIFIER_PREFIX = "provider://"


def _slug_value(value: str, fallback: str) -> str:
    slug = ""
    separator = False
    for character in value.strip().lower():
        if "a" <= character <= "z" or "0" <= character <= "9":
            if separator and slug:
                slug += "-"
            slug += character
            separator = False
        else:
            separator = True
    return slug or fallback


def provider_identifier(value: str) -> str:
    """Normalizes a value into a provider:// audience slug."""
    base = value.strip().removeprefix(PROVIDER_IDENTIFIER_PREFIX)
    return PROVIDER_IDENTIFIER_PREFIX + _slug_value(base, "provider")


def is_provider_identifier(value: str) -> bool:
    """Reports whether the value is a canonical provider:// audience."""
    return PROVIDER_IDENTIFIER_PATTERN.match(value) is not None


def resource_identifier(value: str) -> str:
    """Normalizes a value into a resource audience, preserving absolute
    URIs."""
    text = value.strip()
    if is_resource_identifier(text):
        return text
    base = text.removeprefix(RESOURCE_IDENTIFIER_PREFIX)
    return RESOURCE_IDENTIFIER_PREFIX + _slug_value(base, "resource")


def is_resource_identifier(value: str, control_audience: str | None = None) -> bool:
    """Reports whether the value is a resource audience: the control audience
    or an absolute URI that is not provider-scoped and carries no
    credentials."""
    if control_audience and value == control_audience:
        return True
    try:
        parts = urlsplit(value)
    except ValueError:
        return False
    return (
        bool(parts.scheme)
        and parts.scheme != "provider"
        and not parts.username
        and not parts.password
    )
