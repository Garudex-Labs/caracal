"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

DEPRECATED — Gateway has been moved to caracalEnterprise.

The Gateway module has been relocated to the proprietary caracalEnterprise
repository as part of the SDK v2 architecture redesign.

Install caracal-enterprise for gateway functionality:
    pip install caracal-enterprise

See: SDK_ARCHITECTURE.md § 7 — Gateway & SSO Enterprise Isolation
"""

import warnings

warnings.warn(
    "The caracal.gateway module has been moved to caracalEnterprise/services/gateway/. "
    "Install caracal-enterprise for gateway functionality. "
    "This import path will be removed in v0.4.",
    DeprecationWarning,
    stacklevel=2,
)


def __getattr__(name: str):
    """Raise ImportError for any attribute access."""
    raise ImportError(
        f"Gateway component '{name}' has been moved to caracalEnterprise. "
        "Install caracal-enterprise for gateway functionality."
    )
