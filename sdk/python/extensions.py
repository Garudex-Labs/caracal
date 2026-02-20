"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SDK Extension base class.

All Caracal extensions — both open-source and enterprise — implement this
interface.  Extensions register callbacks on the :class:`HookRegistry`
during :meth:`install` and are activated via ``client.use(extension)``.

Example::

    from caracal.sdk.extensions import CaracalExtension
    from caracal.sdk.hooks import HookRegistry

    class MyExtension(CaracalExtension):
        @property
        def name(self) -> str:
            return "my-extension"

        @property
        def version(self) -> str:
            return "1.0.0"

        def install(self, hooks: HookRegistry) -> None:
            hooks.on_before_request(self._inject_header)

        def _inject_header(self, request, scope):
            request.headers["X-Custom"] = "value"
            return request
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from caracal.sdk.hooks import HookRegistry


class CaracalExtension(ABC):
    """Base class for all Caracal SDK extensions.

    Both open-source community extensions and proprietary enterprise
    extensions (``caracal.sdk.enterprise.*``) implement this interface.
    The SDK core never imports concrete extensions — users explicitly
    register them via ``client.use(extension)``.
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """Unique, human-readable extension name (e.g. ``"compliance"``)."""
        ...

    @property
    @abstractmethod
    def version(self) -> str:
        """SemVer version string (e.g. ``"1.0.0"``)."""
        ...

    @abstractmethod
    def install(self, hooks: HookRegistry) -> None:
        """Register callbacks on lifecycle hooks.

        This method is called exactly once when the extension is attached
        to a :class:`CaracalClient` via ``.use()``.

        Args:
            hooks: The client's hook registry.
        """
        ...
