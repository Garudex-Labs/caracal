"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SDK Transport Adapters.
"""

from caracal.sdk.adapters.base import BaseAdapter, SDKRequest, SDKResponse
from caracal.sdk.adapters.http import HttpAdapter
from caracal.sdk.adapters.mock import MockAdapter
from caracal.sdk.adapters.websocket import WebSocketAdapter

__all__ = [
    "BaseAdapter",
    "SDKRequest",
    "SDKResponse",
    "HttpAdapter",
    "MockAdapter",
    "WebSocketAdapter",
]
