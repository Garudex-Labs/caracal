# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# caracalai_verify: framework-neutral mandate verification surface.

from .authenticate import (
    MandateVerifier,
    auth_error,
    authenticate,
    authenticate_options,
    check_active_authority,
    create_mandate_verifier,
    extract_bearer,
    http_status_for_auth_error,
)
from .types import AuthError, AuthOptions, AuthResult, ErrorCode, Principal

__all__ = [
    "AuthError",
    "AuthOptions",
    "AuthResult",
    "ErrorCode",
    "MandateVerifier",
    "Principal",
    "auth_error",
    "authenticate",
    "authenticate_options",
    "check_active_authority",
    "create_mandate_verifier",
    "extract_bearer",
    "http_status_for_auth_error",
]
