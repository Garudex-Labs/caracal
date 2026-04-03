"""Reusable test fixtures for Caracal tests."""

# Import all fixtures to make them available
from .authority import (
    valid_authority_data,
    authority_with_metadata,
    expired_authority_data,
    multiple_authorities,
)
from .mandate import (
    valid_mandate_data,
    mandate_with_constraints,
    expired_mandate_data,
    revoked_mandate_data,
    multiple_mandates,
)
from .delegation import (
    valid_delegation_data,
    delegation_chain,
    delegation_with_constraints,
    revoked_delegation_data,
)
from .crypto import (
    test_keypair,
    multiple_keypairs,
    test_signature,
    test_data_to_sign,
    encryption_key,
    encrypted_data,
    certificate_data,
    crypto_fixtures,
)
from .database import (
    in_memory_db_engine,
    db_session,
    db_connection,
    test_database_url,
    migration_versions,
)
from .redis import (
    redis_config,
    redis_url,
    cached_mandate_data,
    cache_keys,
    redis_cluster_config,
)
from .users import (
    test_user,
    admin_user,
    service_principal,
    multiple_users,
    user_with_mandates,
)

__all__ = [
    # Authority fixtures
    "valid_authority_data",
    "authority_with_metadata",
    "expired_authority_data",
    "multiple_authorities",
    # Mandate fixtures
    "valid_mandate_data",
    "mandate_with_constraints",
    "expired_mandate_data",
    "revoked_mandate_data",
    "multiple_mandates",
    # Delegation fixtures
    "valid_delegation_data",
    "delegation_chain",
    "delegation_with_constraints",
    "revoked_delegation_data",
    # Crypto fixtures
    "test_keypair",
    "multiple_keypairs",
    "test_signature",
    "test_data_to_sign",
    "encryption_key",
    "encrypted_data",
    "certificate_data",
    "crypto_fixtures",
    # Database fixtures
    "in_memory_db_engine",
    "db_session",
    "db_connection",
    "test_database_url",
    "migration_versions",
    # Redis fixtures
    "redis_config",
    "redis_url",
    "cached_mandate_data",
    "cache_keys",
    "redis_cluster_config",
    # User fixtures
    "test_user",
    "admin_user",
    "service_principal",
    "multiple_users",
    "user_with_mandates",
]
