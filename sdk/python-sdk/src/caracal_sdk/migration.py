"""Grouped migration-oriented SDK surface."""

from caracal_sdk.authority_client import AuthorityClient
from caracal_sdk.secrets import SecretsAdapter, SecretsAdapterError

try:
    from caracal_sdk.async_authority_client import AsyncAuthorityClient as _AsyncAuthorityClient
except Exception:
    _AsyncAuthorityClient = None

__all__ = [
    "AuthorityClient",
    "AsyncAuthorityClient",
    "SecretsAdapter",
    "SecretsAdapterError",
]


def __getattr__(name: str):
    if name == "AsyncAuthorityClient":
        if _AsyncAuthorityClient is None:
            raise ImportError(
                "AsyncAuthorityClient requires optional dependency 'aiohttp'"
            )
        return _AsyncAuthorityClient
    raise AttributeError(f"module 'caracal_sdk.migration' has no attribute {name!r}")
