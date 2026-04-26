"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SDK Transport Adapters.
"""

from caracal_sdk.adapters.base import BaseAdapter, SDKRequest, SDKResponse
from caracal_sdk.adapters.http import HttpAdapter
from caracal_sdk.adapters.mock import MockAdapter

__all__ = [
    "BaseAdapter",
    "SDKRequest",
    "SDKResponse",
    "HttpAdapter",
    "MockAdapter",
]
