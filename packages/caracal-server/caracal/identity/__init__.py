"""Identity runtime services and helpers."""

from .attestation_nonce import (
    AttestationNonceConsumedError,
    AttestationNonceManager,
    AttestationNonceValidationError,
    IssuedAttestationNonce,
)
from .principal_ttl import (
    ChildTTLDecision,
    PrincipalTTLExpiryProcessor,
    PrincipalTTLLease,
    PrincipalTTLLeaseExpiredError,
    PrincipalTTLManager,
    PrincipalTTLValidationError,
    serialize_ttl_decision,
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
    "ChildTTLDecision",
    "IdentityService",
    "IssuedAttestationNonce",
    "PrincipalTTLExpiryProcessor",
    "PrincipalTTLLease",
    "PrincipalTTLLeaseExpiredError",
    "PrincipalTTLManager",
    "PrincipalTTLValidationError",
    "create_ais_app",
    "resolve_ais_listen_target",
    "serialize_ttl_decision",
    "validate_ais_bind_host",
]
