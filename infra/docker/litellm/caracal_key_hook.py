# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Forwards the sealed key (request bearer) and the operator endpoint (X-Llm-Upstream) into the call, so any OpenAI-compatible provider works with no per-model config. The endpoint is always the admin-sealed provider base URL the gateway stamps server-side, never a caller value, so the gateway is the enforcement boundary; CARACAL_UPSTREAM_ALLOWLIST is optional extra confinement, off when unset.

import os
from urllib.parse import urlparse
from litellm.integrations.custom_logger import CustomLogger

_ALLOW = {h.strip().lower() for h in os.environ.get("CARACAL_UPSTREAM_ALLOWLIST", "").split(",") if h.strip()}


class CaracalKeyHook(CustomLogger):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        key = getattr(user_api_key_dict, "api_key", None)
        if key:
            data["api_key"] = key
        headers = (data.get("metadata") or {}).get("headers") or {}
        upstream = headers.get("x-llm-upstream")
        if upstream:
            host = (urlparse(upstream).hostname or "").lower()
            if _ALLOW and host not in _ALLOW:
                raise ValueError("upstream host not allowlisted")
            data["api_base"] = upstream
        return data


caracal_key_hook = CaracalKeyHook()
