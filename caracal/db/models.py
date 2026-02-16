"""
SQLAlchemy models for Caracal Core v0.5 PostgreSQL backend.

This module defines the database schema for:
- Principal identities with parent-child relationships
- Authority policies with delegation tracking
- Ledger events for immutable resource usage records
- Execution mandates for authority enforcement
"""

from datetime import datetime
from decimal import Decimal
from typing import Optional
from uuid import UUID, uuid4

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    JSON,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import relationship

Base = declarative_base()


# Use JSONB for PostgreSQL, JSON for other databases
def get_json_type():
    """Get appropriate JSON type based on database dialect."""
    try:
        # Try to use JSONB for PostgreSQL
        return JSONB
    except:
        # Fall back to JSON for other databases
        return JSON


class LedgerEvent(Base):
    """
    Immutable ledger events for resource usage tracking.
    
    Stores all metering events with automatic monotonic ID generation.
    Events are append-only and never modified or deleted.
    
    Requirements: 5.2, 15.1, 15.2
    """
    
    __tablename__ = "ledger_events"
    
    # Primary key with auto-increment
    event_id = Column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    
    # Foreign key to principal
    agent_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("principals.principal_id"),
        nullable=False,
        index=True,
    )
    
    # Event data
    timestamp = Column(DateTime, nullable=False, default=datetime.utcnow, index=True)
    resource_type = Column(String(255), nullable=False)
    quantity = Column(Numeric(precision=20, scale=6), nullable=False)
    
    # Metadata
    event_metadata = Column("metadata", JSON().with_variant(JSONB, "postgresql"), nullable=True)
    
    # Merkle tree integration (v0.3)
    merkle_root_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("merkle_roots.root_id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    
    # Relationships
    principal = relationship("Principal", backref="ledger_events")
    merkle_root = relationship("MerkleRoot", back_populates="ledger_events")
    
    # Composite index for time-range queries
    __table_args__ = (
        Index("ix_ledger_events_agent_timestamp", "agent_id", "timestamp"),
    )
    
    def __repr__(self):
        return f"<LedgerEvent(event_id={self.event_id}, agent_id={self.agent_id})>"


class AuditLog(Base):
    """
    Append-only audit log for all system events.
    
    Stores comprehensive audit trail of all events from Kafka topics.
    Records are append-only with no updates or deletes allowed.
    
    Requirements: 17.1, 17.2, 17.3, 17.4
    """
    
    __tablename__ = "audit_logs"
    
    # Primary key with auto-increment
    log_id = Column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    
    # Event identification
    event_id = Column(String(255), nullable=False, index=True)
    event_type = Column(String(100), nullable=False, index=True)
    
    # Event source
    topic = Column(String(255), nullable=False, index=True)
    partition = Column(BigInteger, nullable=False)
    offset = Column(BigInteger, nullable=False)
    
    # Event timing
    event_timestamp = Column(DateTime, nullable=False, index=True)
    logged_at = Column(DateTime, nullable=False, default=datetime.utcnow, index=True)
    
    # Event data
    agent_id = Column(PG_UUID(as_uuid=True), nullable=True, index=True)
    correlation_id = Column(String(255), nullable=True, index=True)
    event_data = Column(JSON().with_variant(JSONB, "postgresql"), nullable=False)
    
    # Composite indexes for common queries
    __table_args__ = (
        Index("ix_audit_logs_agent_timestamp", "agent_id", "event_timestamp"),
        Index("ix_audit_logs_type_timestamp", "event_type", "event_timestamp"),
        Index("ix_audit_logs_correlation", "correlation_id", "event_timestamp"),
        Index("ix_audit_logs_topic_partition_offset", "topic", "partition", "offset", unique=True),
    )
    
    def __repr__(self):
        return f"<AuditLog(log_id={self.log_id}, event_type={self.event_type}, event_id={self.event_id})>"


class MerkleRoot(Base):
    """
    Merkle roots for cryptographic ledger integrity.
    
    Stores signed Merkle roots for batches of ledger events, enabling
    cryptographic verification of ledger integrity.
    
    Requirements: 3.4, 3.5, 4.2
    """
    
    __tablename__ = "merkle_roots"
    
    # Primary key
    root_id = Column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    
    # Batch identification
    batch_id = Column(PG_UUID(as_uuid=True), nullable=False, unique=True, index=True)
    
    # Merkle tree data
    merkle_root = Column(String(64), nullable=False)  # Hex-encoded SHA-256 hash
    signature = Column(String(512), nullable=False)  # Hex-encoded ECDSA signature
    
    # Batch metadata
    event_count = Column(BigInteger, nullable=False)
    first_event_id = Column(BigInteger, nullable=False, index=True)
    last_event_id = Column(BigInteger, nullable=False, index=True)
    
    # Source tracking (v0.3 backfill support)
    source = Column(
        String(50),
        nullable=False,
        default="live",
        server_default="live",
        index=True,
        comment='Source of the batch: "live" for real-time batches, "migration" for backfilled v0.2 events'
    )
    
    # Timestamp
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow, index=True)
    
    # Relationships
    ledger_events = relationship("LedgerEvent", back_populates="merkle_root")
    
    # Composite index for event range queries
    __table_args__ = (
        Index("ix_merkle_roots_event_range", "first_event_id", "last_event_id"),
    )
    
    def __repr__(self):
        return f"<MerkleRoot(root_id={self.root_id}, batch_id={self.batch_id}, events={self.first_event_id}-{self.last_event_id}, source={self.source})>"


class LedgerSnapshot(Base):
    """
    Ledger snapshots for fast recovery.
    
    Stores point-in-time snapshots of ledger state including aggregated usage
    per agent and current Merkle root. Enables fast recovery without replaying
    all events from the beginning.
    
    Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7
    """
    
    __tablename__ = "ledger_snapshots"
    
    # Primary key
    snapshot_id = Column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    
    # Snapshot metadata
    snapshot_timestamp = Column(DateTime, nullable=False, index=True)
    total_events = Column(BigInteger, nullable=False)
    merkle_root = Column(String(64), nullable=False)  # Hex-encoded SHA-256 hash
    
    # Snapshot data (aggregated usage per agent)
    snapshot_data = Column(JSON().with_variant(JSONB, "postgresql"), nullable=False)
    
    # Creation timestamp
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow, index=True)
    
    def __repr__(self):
        return f"<LedgerSnapshot(snapshot_id={self.snapshot_id}, timestamp={self.snapshot_timestamp}, events={self.total_events})>"


# ============================================================================
# Authority Enforcement Models (v0.5.0)
# ============================================================================


class Principal(Base):
    """
    Principal identity (agent, user, or service).
    
    Represents an entity that can hold authority and perform actions.
    Replaces AgentIdentity with more general concept for authority enforcement.
    
    Requirements: 1.2, 1.3, 3.2
    """
    
    __tablename__ = "principals"
    
    # Primary key
    principal_id = Column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    
    # Identity
    name = Column(String(255), unique=True, nullable=False, index=True)
    principal_type = Column(String(50), nullable=False, index=True)  # agent, user, service
    owner = Column(String(255), nullable=False)
    
    # Hierarchy
    parent_principal_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("principals.principal_id"),
        nullable=True,
        index=True,
    )
    
    # Cryptographic keys
    public_key_pem = Column(String(2000), nullable=True)
    private_key_pem = Column(String(4000), nullable=True)  # Encrypted or stored in KMS
    
    # Metadata
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    principal_metadata = Column("metadata", JSON().with_variant(JSONB, "postgresql"), nullable=True)
    
    # Relationships
    parent = relationship(
        "Principal",
        remote_side=[principal_id],
        backref="children",
        foreign_keys=[parent_principal_id],
    )
    
    def __repr__(self):
        return f"<Principal(principal_id={self.principal_id}, name={self.name}, type={self.principal_type})>"


class ExecutionMandate(Base):
    """
    Execution mandate for authority enforcement.
    
    Represents a cryptographically signed authorization that grants
    specific execution rights to a principal for a limited time.
    
    Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10
    """
    
    __tablename__ = "execution_mandates"
    
    # Primary key
    mandate_id = Column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    
    # Principal identifiers
    issuer_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("principals.principal_id"),
        nullable=False,
        index=True,
    )
    subject_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("principals.principal_id"),
        nullable=False,
        index=True,
    )
    
    # Validity period
    valid_from = Column(DateTime, nullable=False, index=True)
    valid_until = Column(DateTime, nullable=False, index=True)
    
    # Scope
    resource_scope = Column(JSON().with_variant(JSONB, "postgresql"), nullable=False)  # List of resource patterns
    action_scope = Column(JSON().with_variant(JSONB, "postgresql"), nullable=False)    # List of allowed actions
    
    # Cryptographic signature
    signature = Column(String(512), nullable=False)  # ECDSA P-256 signature
    
    # Metadata
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    mandate_metadata = Column("metadata", JSON().with_variant(JSONB, "postgresql"), nullable=True)
    
    # Revocation
    revoked = Column(Boolean, nullable=False, default=False, index=True)
    revoked_at = Column(DateTime, nullable=True)
    revocation_reason = Column(String(1000), nullable=True)
    
    # Delegation
    parent_mandate_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("execution_mandates.mandate_id"),
        nullable=True,
        index=True,
    )
    delegation_depth = Column(Integer, nullable=False, default=0)
    
    # Intent constraint (optional)
    intent_hash = Column(String(64), nullable=True)  # SHA-256 hash of intent
    
    # Relationships
    issuer = relationship("Principal", foreign_keys=[issuer_id], backref="issued_mandates")
    subject = relationship("Principal", foreign_keys=[subject_id], backref="received_mandates")
    parent_mandate = relationship("ExecutionMandate", remote_side=[mandate_id], backref="child_mandates")
    
    def __repr__(self):
        return f"<ExecutionMandate(mandate_id={self.mandate_id}, subject_id={self.subject_id}, revoked={self.revoked})>"


class AuthorityLedgerEvent(Base):
    """
    Immutable ledger event for authority decisions.
    
    Records all authority-related events including mandate issuance,
    validation attempts, and revocations.
    
    Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11
    """
    
    __tablename__ = "authority_ledger_events"
    
    # Primary key with auto-increment
    event_id = Column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    
    # Event identification
    event_type = Column(String(50), nullable=False, index=True)  # issued, validated, denied, revoked
    timestamp = Column(DateTime, nullable=False, default=datetime.utcnow, index=True)
    
    # Principal and mandate
    principal_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("principals.principal_id"),
        nullable=False,
        index=True,
    )
    mandate_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("execution_mandates.mandate_id"),
        nullable=True,
        index=True,
    )
    
    # Decision outcome (for validation events)
    decision = Column(String(20), nullable=True)  # allowed, denied
    denial_reason = Column(String(1000), nullable=True)
    
    # Request context
    requested_action = Column(String(255), nullable=True)
    requested_resource = Column(String(1000), nullable=True)
    
    # Metadata
    event_metadata = Column(JSON().with_variant(JSONB, "postgresql"), nullable=True)
    correlation_id = Column(String(255), nullable=True, index=True)
    
    # Merkle tree integration
    merkle_root_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("merkle_roots.root_id"),
        nullable=True,
        index=True,
    )
    
    # Relationships
    principal = relationship("Principal", backref="authority_events")
    mandate = relationship("ExecutionMandate", backref="ledger_events")
    merkle_root = relationship("MerkleRoot", backref="authority_events")
    
    # Composite indexes for common queries
    __table_args__ = (
        Index("ix_authority_ledger_events_principal_timestamp", "principal_id", "timestamp"),
        Index("ix_authority_ledger_events_mandate_timestamp", "mandate_id", "timestamp"),
    )
    
    def __repr__(self):
        return f"<AuthorityLedgerEvent(event_id={self.event_id}, event_type={self.event_type}, decision={self.decision})>"


class AuthorityPolicy(Base):
    """
    Authority policy for mandate issuance constraints.
    
    Defines rules for how mandates can be issued to a principal,
    including scope limits and validity period constraints.
    
    Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8
    """
    
    __tablename__ = "authority_policies"
    
    # Primary key
    policy_id = Column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    
    # Principal
    principal_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("principals.principal_id"),
        nullable=False,
        index=True,
    )
    
    # Validity constraints
    max_validity_seconds = Column(Integer, nullable=False)  # Maximum TTL for mandates
    
    # Scope constraints
    allowed_resource_patterns = Column(JSON().with_variant(JSONB, "postgresql"), nullable=False)  # List of regex/glob patterns
    allowed_actions = Column(JSON().with_variant(JSONB, "postgresql"), nullable=False)  # List of action types
    
    # Delegation constraints
    allow_delegation = Column(Boolean, nullable=False, default=False)
    max_delegation_depth = Column(Integer, nullable=False, default=0)
    
    # Metadata
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    created_by = Column(String(255), nullable=False)
    active = Column(Boolean, nullable=False, default=True, index=True)
    
    # Relationships
    principal = relationship("Principal", backref="authority_policies")
    
    # Composite index for active policy queries
    __table_args__ = (
        Index("ix_authority_policies_principal_active", "principal_id", "active"),
    )
    
    def __repr__(self):
        return f"<AuthorityPolicy(policy_id={self.policy_id}, principal_id={self.principal_id}, active={self.active})>"


