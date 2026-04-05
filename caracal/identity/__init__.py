"""Identity runtime services and helpers."""

from .attestation_nonce import (
    AttestationNonceConsumedError,
    AttestationNonceManager,
    AttestationNonceValidationError,
    IssuedAttestationNonce,
)
from .ais_server import (
    AISBindTargetError,
    AISHandlers,
    AISListenTarget,
    AISServerConfig,
    create_ais_app,
    resolve_ais_listen_target,
    validate_ais_bind_host,
)


def __getattr__(name: str):
    if name == "IdentityService":
        from .service import IdentityService

        return IdentityService
    raise AttributeError(f"module 'caracal.identity' has no attribute {name!r}")

__all__ = [
    "AISBindTargetError",
    "AISHandlers",
    "AISListenTarget",
    "AISServerConfig",
    "AttestationNonceConsumedError",
    "AttestationNonceManager",
    "AttestationNonceValidationError",
    "IdentityService",
    "IssuedAttestationNonce",
    "create_ais_app",
    "resolve_ais_listen_target",
    "validate_ais_bind_host",
]
