"""
Exception hierarchy for Caracal Core.

All custom exceptions inherit from CaracalError base class.
"""


class CaracalError(Exception):
    """Base exception for all Caracal Core errors."""
    pass


# Identity and Registry Errors
class IdentityError(CaracalError):
    """Base exception for identity-related errors."""
    pass


class AgentNotFoundError(IdentityError):
    """Raised when an agent ID is not found in the registry."""
    pass


class DuplicateAgentNameError(IdentityError):
    """Raised when attempting to register an agent with a duplicate name."""
    pass


class InvalidAgentIDError(IdentityError):
    """Raised when an agent ID is invalid or malformed."""
    pass


# Policy Errors
class PolicyError(CaracalError):
    """Base exception for policy-related errors."""
    pass


class PolicyNotFoundError(PolicyError):
    """Raised when a policy is not found."""
    pass


class InvalidPolicyError(PolicyError):
    """Raised when a policy is invalid or malformed."""
    pass


class PolicyEvaluationError(PolicyError):
    """Raised when policy evaluation fails."""
    pass


class BudgetExceededError(PolicyError):
    """Raised when an agent exceeds its budget limit."""
    pass


# Ledger Errors
class LedgerError(CaracalError):
    """Base exception for ledger-related errors."""
    pass


class LedgerWriteError(LedgerError):
    """Raised when writing to the ledger fails."""
    pass


class LedgerReadError(LedgerError):
    """Raised when reading from the ledger fails."""
    pass


class InvalidLedgerEventError(LedgerError):
    """Raised when a ledger event is invalid or malformed."""
    pass


# Metering Errors
class MeteringError(CaracalError):
    """Base exception for metering-related errors."""
    pass


class InvalidMeteringEventError(MeteringError):
    """Raised when a metering event is invalid or malformed."""
    pass


class MeteringCollectionError(MeteringError):
    """Raised when metering event collection fails."""
    pass


# Pricebook Errors
class PricebookError(CaracalError):
    """Base exception for pricebook-related errors."""
    pass


class InvalidPriceError(PricebookError):
    """Raised when a price is invalid (e.g., negative)."""
    pass


class PricebookLoadError(PricebookError):
    """Raised when loading the pricebook fails."""
    pass


class ResourceNotFoundError(PricebookError):
    """Raised when a resource is not found in the pricebook."""
    pass


# Configuration Errors
class ConfigurationError(CaracalError):
    """Base exception for configuration-related errors."""
    pass


class InvalidConfigurationError(ConfigurationError):
    """Raised when configuration is invalid or malformed."""
    pass


class ConfigurationLoadError(ConfigurationError):
    """Raised when loading configuration fails."""
    pass


# Storage and Persistence Errors
class StorageError(CaracalError):
    """Base exception for storage-related errors."""
    pass


class FileWriteError(StorageError):
    """Raised when writing to a file fails."""
    pass


class FileReadError(StorageError):
    """Raised when reading from a file fails."""
    pass


class BackupError(StorageError):
    """Raised when backup operations fail."""
    pass


class RestoreError(StorageError):
    """Raised when restore operations fail."""
    pass


# SDK Errors
class SDKError(CaracalError):
    """Base exception for SDK-related errors."""
    pass


class ConnectionError(SDKError):
    """Raised when SDK cannot connect to Caracal Core."""
    pass


class SDKConfigurationError(SDKError):
    """Raised when SDK configuration is invalid."""
    pass


# Provisional Charge Errors
class ProvisionalChargeError(CaracalError):
    """Base exception for provisional charge-related errors."""
    pass


# Delegation Token Errors
class DelegationTokenError(CaracalError):
    """Base exception for delegation token-related errors."""
    pass


class InvalidDelegationTokenError(DelegationTokenError):
    """Raised when a delegation token is invalid or malformed."""
    pass


class TokenExpiredError(DelegationTokenError):
    """Raised when a delegation token has expired."""
    pass


class TokenValidationError(DelegationTokenError):
    """Raised when delegation token validation fails."""
    pass


class SpendingLimitExceededError(DelegationTokenError):
    """Raised when spending exceeds delegation token limit."""
    pass


# Kafka Errors
class KafkaError(CaracalError):
    """Base exception for Kafka-related errors."""
    pass


class KafkaPublishError(KafkaError):
    """Raised when publishing to Kafka fails."""
    pass


class KafkaConsumerError(KafkaError):
    """Raised when Kafka consumer operations fail."""
    pass


# Redis Errors
class RedisError(CaracalError):
    """Base exception for Redis-related errors."""
    pass


class RedisConnectionError(RedisError):
    """Raised when Redis connection or operations fail."""
    pass


