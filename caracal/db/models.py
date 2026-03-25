"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SQLAlchemy models for Caracal Core PostgreSQL backend.

This module defines the database schema for:
- Principal identities (user, agent, service)
- Graph-based authority delegation (DelegationEdgeModel)
- Authority policies with delegation constraints
- Ledger events for immutable resource usage records
- Execution mandates for authority enforcement

PostgreSQL is the only supported backend.
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
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import relationship

Base = declarative_base()


def get_json_type():
    """Return JSONB for PostgreSQL."""
    return JSONB


class LedgerEvent(Base):
    """
    Immutable ledger events for resource usage tracking.
    
    Stores all metering events with automatic monotonic ID generation.
    Events are append-only and never modified or deleted.
    
    """
    
    __tablename__ = "ledger_events"
    
    # Primary key with auto-increment
    event_id = Column(BigInteger, primary_key=True, autoincrement=True)
    
    # Foreign key to principal
    principal_id = Column(
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
    event_metadata = Column("metadata", JSONB, nullable=True)
    
    # Merkle tree integration 
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
        Index("ix_ledger_events_agent_timestamp", "principal_id", "timestamp"),
    )
    
    def __repr__(self):
        return f"<LedgerEvent(event_id={self.event_id}, principal_id={self.principal_id})>"


class AuditLog(Base):
    """
    Append-only audit log for all system events.
    
    Stores comprehensive audit trail of all system events.
    Records are append-only with no updates or deletes allowed.
    
    """
    
    __tablename__ = "audit_logs"
    
    # Primary key with auto-increment
    log_id = Column(BigInteger, primary_key=True, autoincrement=True)
    
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
    principal_id = Column(PG_UUID(as_uuid=True), nullable=True, index=True)
    correlation_id = Column(String(255), nullable=True, index=True)
    event_data = Column(JSONB, nullable=False)
    
    # Composite indexes for common queries
    __table_args__ = (
        Index("ix_audit_logs_agent_timestamp", "principal_id", "event_timestamp"),
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
    
    """
    
    __tablename__ = "ledger_snapshots"
    
    # Primary key
    snapshot_id = Column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    
    # Snapshot metadata
    snapshot_timestamp = Column(DateTime, nullable=False, index=True)
    total_events = Column(BigInteger, nullable=False)
    merkle_root = Column(String(64), nullable=False)  # Hex-encoded SHA-256 hash
    
    # Snapshot data (aggregated usage per agent)
    snapshot_data = Column(JSONB, nullable=False)
    
    # Creation timestamp
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow, index=True)
    
    def __repr__(self):
        return f"<LedgerSnapshot(snapshot_id={self.snapshot_id}, timestamp={self.snapshot_timestamp}, events={self.total_events})>"


# ============================================================================
# Authority Enforcement Models
# ============================================================================


class Principal(Base):
    """
    Principal identity (agent, user, or service).
    
    Represents an entity that can hold authority and perform actions.
    Replaces AgentIdentity with more general concept for authority enforcement.
    
    """
    
    __tablename__ = "principals"
    
    # Primary key
    principal_id = Column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    
    # Identity
    name = Column(String(255), unique=True, nullable=False, index=True)
    principal_type = Column(String(50), nullable=False, index=True)  # agent, user, service
    owner = Column(String(255), nullable=False)
    
    # Cryptographic keys
    public_key_pem = Column(String(2000), nullable=True)
    private_key_pem = Column(String(4000), nullable=True)  # Encrypted or stored in KMS
    
    # Metadata
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    principal_metadata = Column("metadata", JSONB, nullable=True)
    
    def __repr__(self):
        return f"<Principal(principal_id={self.principal_id}, name={self.name}, type={self.principal_type})>"


class ExecutionMandate(Base):
    """
    Execution mandate for authority enforcement.
    
    Represents a cryptographically signed authorization that grants
    specific execution rights to a principal for a limited time.
    
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
    resource_scope = Column(JSONB, nullable=False)  # List of resource patterns
    action_scope = Column(JSONB, nullable=False)    # List of allowed actions
    
    # Cryptographic signature
    signature = Column(String(512), nullable=False)  # ECDSA P-256 signature
    
    # Metadata
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    mandate_metadata = Column("metadata", JSONB, nullable=True)
    
    # Revocation
    revoked = Column(Boolean, nullable=False, default=False, index=True)
    revoked_at = Column(DateTime, nullable=True)
    revocation_reason = Column(String(1000), nullable=True)
    
    # Graph-based delegation
    delegation_type = Column(
        String(50), nullable=False, default="hierarchical",
        server_default="hierarchical"
    )  # hierarchical, peer
    context_tags = Column(JSONB, nullable=True)  # Context tags for dynamic filtering
    
    # Intent constraint (optional)
    intent_hash = Column(String(64), nullable=True)  # SHA-256 hash of intent
    
    # Delegation hierarchy
    parent_mandate_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("execution_mandates.mandate_id"),
        nullable=True,
        index=True,
    )
    delegation_depth = Column(Integer, nullable=True, default=0)
    
    # Relationships
    issuer = relationship("Principal", foreign_keys=[issuer_id], backref="issued_mandates")
    subject = relationship("Principal", foreign_keys=[subject_id], backref="received_mandates")
    
    def __repr__(self):
        return f"<ExecutionMandate(mandate_id={self.mandate_id}, subject_id={self.subject_id}, revoked={self.revoked})>"


class DelegationEdgeModel(Base):
    """
    Directed edge in the authority delegation graph.
    
    Represents a delegation relationship between two mandates,
    tracking the principal types involved and delegation direction.
    Authority flows downward: user → agent → service.
    
    """
    
    __tablename__ = "delegation_edges"
    
    # Primary key
    edge_id = Column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    
    # Edge endpoints
    source_mandate_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("execution_mandates.mandate_id"),
        nullable=False,
        index=True,
    )
    target_mandate_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("execution_mandates.mandate_id"),
        nullable=False,
        index=True,
    )
    
    # Principal type tracking
    source_principal_type = Column(String(50), nullable=False, index=True)  # user, agent, service
    target_principal_type = Column(String(50), nullable=False, index=True)  # user, agent, service
    
    # Delegation metadata
    delegation_type = Column(
        String(50), nullable=False, default="hierarchical"
    )  # hierarchical, peer
    context_tags = Column(JSONB, nullable=True)  # ["production", "read-only"]
    
    # Validity
    granted_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    expires_at = Column(DateTime, nullable=True)
    
    # Revocation
    revoked = Column(Boolean, nullable=False, default=False, index=True)
    revoked_at = Column(DateTime, nullable=True)
    
    # Metadata
    edge_metadata = Column("metadata", JSONB, nullable=True)
    
    # Relationships
    source_mandate = relationship(
        "ExecutionMandate",
        foreign_keys=[source_mandate_id],
        backref="outgoing_edges",
    )
    target_mandate = relationship(
        "ExecutionMandate",
        foreign_keys=[target_mandate_id],
        backref="incoming_edges",
    )
    
    # Composite indexes
    __table_args__ = (
        Index("ix_delegation_edges_source_target", "source_mandate_id", "target_mandate_id"),
        Index("ix_delegation_edges_types", "source_principal_type", "target_principal_type"),
    )
    
    def __repr__(self):
        return (
            f"<DelegationEdge(edge_id={self.edge_id}, "
            f"{self.source_principal_type}→{self.target_principal_type}, "
            f"type={self.delegation_type}, revoked={self.revoked})>"
        )


class AuthorityLedgerEvent(Base):
    """
    Immutable ledger event for authority decisions.
    
    Records all authority-related events including mandate issuance,
    validation attempts, and revocations.
    
    """
    
    __tablename__ = "authority_ledger_events"
    
    # Primary key with auto-increment
    event_id = Column(BigInteger, primary_key=True, autoincrement=True)
    
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
    event_metadata = Column(JSONB, nullable=True)
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
    allowed_resource_patterns = Column(JSONB, nullable=False)  # List of regex/glob patterns
    allowed_actions = Column(JSONB, nullable=False)  # List of action types
    
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


class GatewayProvider(Base):
    """
    Registered upstream provider for the enterprise gateway.

    Provider entries are loaded by ProviderRegistry and used to map
    logical provider IDs to validated upstream URLs, preventing SSRF.
    """

    __tablename__ = "gateway_providers"

    provider_id = Column(String(255), primary_key=True)
    name = Column(String(255), nullable=False)
    base_url = Column(String(2048), nullable=False)

    # JSON arrays stored as JSONB
    allowed_paths = Column(JSONB, nullable=False, default=list, server_default=text("'[]'"))
    scopes = Column(JSONB, nullable=False, default=list, server_default=text("'[]'"))

    tls_pin = Column(String(255), nullable=True)
    secret_ref = Column(String(512), nullable=True)
    enabled = Column(Boolean, nullable=False, default=True, index=True)

    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    def __repr__(self):
        return f"<GatewayProvider(provider_id={self.provider_id!r}, base_url={self.base_url!r}, enabled={self.enabled})>"


