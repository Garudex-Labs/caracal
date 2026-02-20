"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SDK Lifecycle Hook Registry.

Provides a centralized registry of lifecycle hooks that extensions
can subscribe to in order to intercept and augment SDK execution
without modifying the core architecture.

Available hooks:
- on_initialize: Fired once when the client finishes setup
- on_before_request: Fired before every outbound SDK request
- on_after_response: Fired after every response
- on_state_change: Fired when SDK state mutates
- on_error: Fired on any SDK error
- on_context_switch: Fired when scope context changes
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from caracal.logging_config import get_logger

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Request / Response / State data structures
# ---------------------------------------------------------------------------

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


@dataclass
class StateSnapshot:
    """Immutable snapshot of SDK state at a point in time."""
    organization_id: Optional[str] = None
    workspace_id: Optional[str] = None
    project_id: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Scope context (lightweight forward reference — full impl in context.py)
# ---------------------------------------------------------------------------

@dataclass
class ScopeRef:
    """Lightweight scope reference for hook callbacks."""
    organization_id: Optional[str] = None
    workspace_id: Optional[str] = None
    project_id: Optional[str] = None


# ---------------------------------------------------------------------------
# Hook callback type aliases
# ---------------------------------------------------------------------------

InitializeCallback = Callable[..., None]
BeforeRequestCallback = Callable[[SDKRequest, ScopeRef], SDKRequest]
AfterResponseCallback = Callable[[SDKResponse, ScopeRef], None]
StateChangeCallback = Callable[[StateSnapshot], None]
ErrorCallback = Callable[[Exception], None]
ContextSwitchCallback = Callable[[Optional[ScopeRef], ScopeRef], None]


# ---------------------------------------------------------------------------
# HookRegistry
# ---------------------------------------------------------------------------

class HookRegistry:
    """
    Manages lifecycle hooks for the Caracal SDK.

    Extensions register callbacks via the ``on_*`` methods.  The SDK engine
    fires hooks at the appropriate points in the request lifecycle.  Multiple
    callbacks per hook are supported and executed in registration order.
    """

    def __init__(self) -> None:
        self._initialize_callbacks: List[InitializeCallback] = []
        self._before_request_callbacks: List[BeforeRequestCallback] = []
        self._after_response_callbacks: List[AfterResponseCallback] = []
        self._state_change_callbacks: List[StateChangeCallback] = []
        self._error_callbacks: List[ErrorCallback] = []
        self._context_switch_callbacks: List[ContextSwitchCallback] = []

    # -- Registration methods ------------------------------------------------

    def on_initialize(self, callback: InitializeCallback) -> None:
        """Register a callback fired once when the client finishes setup."""
        self._initialize_callbacks.append(callback)
        logger.debug("Registered on_initialize hook")

    def on_before_request(self, callback: BeforeRequestCallback) -> None:
        """Register a callback fired before every outbound request.

        The callback receives ``(request, scope)`` and **must** return
        an ``SDKRequest`` (possibly modified).
        """
        self._before_request_callbacks.append(callback)
        logger.debug("Registered on_before_request hook")

    def on_after_response(self, callback: AfterResponseCallback) -> None:
        """Register a callback fired after every response."""
        self._after_response_callbacks.append(callback)
        logger.debug("Registered on_after_response hook")

    def on_state_change(self, callback: StateChangeCallback) -> None:
        """Register a callback fired when SDK state mutates."""
        self._state_change_callbacks.append(callback)
        logger.debug("Registered on_state_change hook")

    def on_error(self, callback: ErrorCallback) -> None:
        """Register a callback fired on any SDK error."""
        self._error_callbacks.append(callback)
        logger.debug("Registered on_error hook")

    def on_context_switch(self, callback: ContextSwitchCallback) -> None:
        """Register a callback fired when ``context.checkout()`` changes scope."""
        self._context_switch_callbacks.append(callback)
        logger.debug("Registered on_context_switch hook")

    # -- Firing methods (called by the SDK engine) ---------------------------

    def fire_initialize(self, **kwargs: Any) -> None:
        """Fire all registered on_initialize callbacks."""
        for cb in self._initialize_callbacks:
            try:
                cb(**kwargs)
            except Exception as exc:
                logger.error(f"on_initialize hook error: {exc}", exc_info=True)
                self.fire_error(exc)

    def fire_before_request(
        self, request: SDKRequest, scope: ScopeRef
    ) -> SDKRequest:
        """Fire all on_before_request callbacks in order.

        Each callback receives the (possibly mutated) request from the
        previous callback, forming a pipeline.
        """
        current = request
        for cb in self._before_request_callbacks:
            try:
                current = cb(current, scope)
            except Exception as exc:
                logger.error(f"on_before_request hook error: {exc}", exc_info=True)
                self.fire_error(exc)
        return current

    def fire_after_response(
        self, response: SDKResponse, scope: ScopeRef
    ) -> None:
        """Fire all on_after_response callbacks."""
        for cb in self._after_response_callbacks:
            try:
                cb(response, scope)
            except Exception as exc:
                logger.error(f"on_after_response hook error: {exc}", exc_info=True)
                self.fire_error(exc)

    def fire_state_change(self, state: StateSnapshot) -> None:
        """Fire all on_state_change callbacks."""
        for cb in self._state_change_callbacks:
            try:
                cb(state)
            except Exception as exc:
                logger.error(f"on_state_change hook error: {exc}", exc_info=True)
                self.fire_error(exc)

    def fire_error(self, error: Exception) -> None:
        """Fire all on_error callbacks."""
        for cb in self._error_callbacks:
            try:
                cb(error)
            except Exception:
                # Avoid infinite recursion — silently log
                logger.error("on_error hook itself raised an exception", exc_info=True)

    def fire_context_switch(
        self, from_ctx: Optional[ScopeRef], to_ctx: ScopeRef
    ) -> None:
        """Fire all on_context_switch callbacks."""
        for cb in self._context_switch_callbacks:
            try:
                cb(from_ctx, to_ctx)
            except Exception as exc:
                logger.error(f"on_context_switch hook error: {exc}", exc_info=True)
                self.fire_error(exc)
