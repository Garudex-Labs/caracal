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

import json
from datetime import datetime
from decimal import Decimal
from enum import Enum
from typing import Any, Optional
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
from sqlalchemy.dialects.postgresql import JSON, UUID as PG_UUID
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import relationship

Base = declarative_base()


def get_json_type():
    """Return JSON for PostgreSQL."""
    return JSON


class PrincipalKind(str, Enum):
    """Behavioral principal taxonomy."""

    HUMAN = "human"
    ORCHESTRATOR = "orchestrator"
    WORKER = "worker"
    SERVICE = "service"


class PrincipalLifecycleStatus(str, Enum):
    """Principal lifecycle status values."""

    PENDING_ATTESTATION = "pending_attestation"
    ACTIVE = "active"
    SUSPENDED = "suspended"
    DEACTIVATED = "deactivated"
    EXPIRED = "expired"
    REVOKED = "revoked"


class PrincipalAttestationStatus(str, Enum):
    """Principal attestation state values."""

    UNATTESTED = "unattested"
    PENDING = "pending"
    ATTESTED = "attested"
    FAILED = "failed"


class PrincipalKeyBackend(str, Enum):
    """Supported custody backends for principal private keys."""

    VAULT = "vault"


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
    event_metadata = Column("metadata", JSON, nullable=True)
    
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
    event_data = Column(JSON, nullable=False)
    
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
    snapshot_data = Column(JSON, nullable=False)
    
    # Creation timestamp
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow, index=True)
    
    def __repr__(self):
        return f"<LedgerSnapshot(snapshot_id={self.snapshot_id}, timestamp={self.snapshot_timestamp}, events={self.total_events})>"


# ============================================================================
# Authority Enforcement Models
# ============================================================================


class Principal(Base):
    """
    Principal identity with behavioral taxonomy and lifecycle state.
    
    Represents an entity that can hold authority and perform actions.
    Replaces older identity naming with principal-centric authority enforcement.
    
    """
    
    __tablename__ = "principals"
    
    # Primary key
    principal_id = Column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    
    # Identity
    name = Column(String(255), unique=True, nullable=False, index=True)
    principal_kind = Column(String(50), nullable=False, index=True)  # human, orchestrator, worker, service
    owner = Column(String(255), nullable=False)

    # Lifecycle graph relation
    source_principal_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("principals.principal_id"),
        nullable=True,
        index=True,
    )

    # Lifecycle and attestation status
    lifecycle_status = Column(
        String(50),
        nullable=False,
        default=PrincipalLifecycleStatus.ACTIVE.value,
        server_default=PrincipalLifecycleStatus.ACTIVE.value,
        index=True,
    )
    attestation_status = Column(
        String(50),
        nullable=False,
        default=PrincipalAttestationStatus.UNATTESTED.value,
        server_default=PrincipalAttestationStatus.UNATTESTED.value,
        index=True,
    )
    
    # Cryptographic keys
    public_key_pem = Column(String(2000), nullable=True)
    
    # Metadata
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    principal_metadata = Column("metadata", JSON, nullable=True)

    source_principal = relationship(
        "Principal",
        remote_side=[principal_id],
        foreign_keys=[source_principal_id],
        backref="spawned_principals",
    )
    key_custody = relationship(
        "PrincipalKeyCustody",
        back_populates="principal",
        cascade="all, delete-orphan",
        uselist=False,
    )
    workload_bindings = relationship(
        "PrincipalWorkloadBinding",
        back_populates="principal",
        cascade="all, delete-orphan",
    )
    capability_grants = relationship(
        "PrincipalCapabilityGrant",
        back_populates="principal",
        cascade="all, delete-orphan",
    )

    @property
    def capabilities(self) -> list[str]:
        return [grant.capability for grant in self.capability_grants]

    @capabilities.setter
    def capabilities(self, values: Optional[list[str]]) -> None:
        self.capability_grants = [
            PrincipalCapabilityGrant(capability=str(value))
            for value in (values or [])
        ]
    
    def __repr__(self):
        return (
            f"<Principal(principal_id={self.principal_id}, name={self.name}, "
            f"kind={self.principal_kind}, lifecycle={self.lifecycle_status})>"
        )


class PrincipalKeyCustody(Base):
    """Canonical private-key custody record for a principal."""

    __tablename__ = "principal_key_custody"

    custody_id = Column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    principal_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("principals.principal_id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
        index=True,
    )
    backend = Column(String(50), nullable=False, index=True)
    key_reference = Column(String(2000), nullable=False)
    key_updated_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    rotated_at = Column(DateTime, nullable=True)

    principal = relationship("Principal", back_populates="key_custody")
    vault_details = relationship(
        "PrincipalKeyCustodyVault",
        back_populates="custody",
        cascade="all, delete-orphan",
        uselist=False,
    )


class PrincipalKeyCustodyVault(Base):
    """Vault custody details for principal signing keys."""

    __tablename__ = "principal_key_custody_vault"

    custody_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("principal_key_custody.custody_id", ondelete="CASCADE"),
        primary_key=True,
    )
    vault_key_ref = Column(String(2000), nullable=False)
    vault_namespace = Column(String(255), nullable=True)

    custody = relationship("PrincipalKeyCustody", back_populates="vault_details")


class PrincipalWorkloadBinding(Base):
    """Typed workload binding rows for a principal."""

    __tablename__ = "principal_workload_bindings"

    binding_id = Column(BigInteger, primary_key=True, autoincrement=True)
    principal_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("principals.principal_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    workload = Column(String(255), nullable=False)
    binding_type = Column(String(50), nullable=False, default="workload", server_default="workload")
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)

    principal = relationship("Principal", back_populates="workload_bindings")


class PrincipalCapabilityGrant(Base):
    """Typed capability grant rows for a principal."""

    __tablename__ = "principal_capability_grants"

    grant_id = Column(BigInteger, primary_key=True, autoincrement=True)
    principal_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("principals.principal_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    capability = Column(String(255), nullable=False)
    granted_by = Column(String(255), nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)

    principal = relationship("Principal", back_populates="capability_grants")


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
    
    # Cryptographic signature
    signature = Column(String(512), nullable=False)  # ECDSA P-256 signature
    
    # Metadata
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    mandate_metadata = Column("metadata", JSON, nullable=True)
    
    # Revocation
    revoked = Column(Boolean, nullable=False, default=False, index=True)
    revoked_at = Column(DateTime, nullable=True)
    revocation_reason = Column(String(1000), nullable=True)
    
    # Graph-based delegation
    delegation_type = Column(
        String(50), nullable=False, default="directed",
        server_default="directed"
    )  # directed, peer
    
    # Intent constraint (optional)
    intent_hash = Column(String(64), nullable=True)  # SHA-256 hash of intent
    
    # Delegation hierarchy
    source_mandate_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("execution_mandates.mandate_id"),
        nullable=True,
        index=True,
    )
    network_distance = Column(Integer, nullable=True, default=0)
    
    # Relationships
    issuer = relationship("Principal", foreign_keys=[issuer_id], backref="issued_mandates")
    subject = relationship("Principal", foreign_keys=[subject_id], backref="received_mandates")
    resource_scope_entries = relationship(
        "MandateResourceScope",
        back_populates="mandate",
        cascade="all, delete-orphan",
        order_by="MandateResourceScope.position",
    )
    action_scope_entries = relationship(
        "MandateActionScope",
        back_populates="mandate",
        cascade="all, delete-orphan",
        order_by="MandateActionScope.position",
    )
    context_tag_entries = relationship(
        "MandateContextTag",
        back_populates="mandate",
        cascade="all, delete-orphan",
        order_by="MandateContextTag.position",
    )

    @property
    def resource_scope(self) -> list[str]:
        return [entry.resource_scope for entry in self.resource_scope_entries]

    @resource_scope.setter
    def resource_scope(self, values: Optional[list[str]]) -> None:
        self.resource_scope_entries = [
            MandateResourceScope(resource_scope=str(value), position=index)
            for index, value in enumerate(values or [])
        ]

    @property
    def action_scope(self) -> list[str]:
        return [entry.action_scope for entry in self.action_scope_entries]

    @action_scope.setter
    def action_scope(self, values: Optional[list[str]]) -> None:
        self.action_scope_entries = [
            MandateActionScope(action_scope=str(value), position=index)
            for index, value in enumerate(values or [])
        ]

    @property
    def context_tags(self) -> list[str]:
        return [entry.context_tag for entry in self.context_tag_entries]

    @context_tags.setter
    def context_tags(self, values: Optional[list[str]]) -> None:
        self.context_tag_entries = [
            MandateContextTag(context_tag=str(value), position=index)
            for index, value in enumerate(values or [])
        ]
    
    def __repr__(self):
        return f"<ExecutionMandate(mandate_id={self.mandate_id}, subject_id={self.subject_id}, revoked={self.revoked})>"


class MandateResourceScope(Base):
    """Resource scope entries for a mandate."""

    __tablename__ = "mandate_resource_scopes"

    resource_scope_id = Column(BigInteger, primary_key=True, autoincrement=True)
    mandate_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("execution_mandates.mandate_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    resource_scope = Column(String(1000), nullable=False)
    position = Column(Integer, nullable=False, default=0)

    mandate = relationship("ExecutionMandate", back_populates="resource_scope_entries")


class MandateActionScope(Base):
    """Action scope entries for a mandate."""

    __tablename__ = "mandate_action_scopes"

    action_scope_id = Column(BigInteger, primary_key=True, autoincrement=True)
    mandate_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("execution_mandates.mandate_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    action_scope = Column(String(255), nullable=False)
    position = Column(Integer, nullable=False, default=0)

    mandate = relationship("ExecutionMandate", back_populates="action_scope_entries")


class MandateContextTag(Base):
    """Context tag entries for a mandate."""

    __tablename__ = "mandate_context_tags"

    context_tag_id = Column(BigInteger, primary_key=True, autoincrement=True)
    mandate_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("execution_mandates.mandate_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    context_tag = Column(String(255), nullable=False)
    position = Column(Integer, nullable=False, default=0)

    mandate = relationship("ExecutionMandate", back_populates="context_tag_entries")


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
        String(50), nullable=False, default="directed"
    )  # directed, peer
    
    # Validity
    granted_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    expires_at = Column(DateTime, nullable=True)
    
    # Revocation
    revoked = Column(Boolean, nullable=False, default=False, index=True)
    revoked_at = Column(DateTime, nullable=True)
    
    # Metadata
    edge_metadata = Column("metadata", JSON, nullable=True)
    
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
    context_tag_entries = relationship(
        "DelegationEdgeTag",
        back_populates="edge",
        cascade="all, delete-orphan",
        order_by="DelegationEdgeTag.position",
    )

    @property
    def context_tags(self) -> list[str]:
        return [entry.context_tag for entry in self.context_tag_entries]

    @context_tags.setter
    def context_tags(self, values: Optional[list[str]]) -> None:
        self.context_tag_entries = [
            DelegationEdgeTag(context_tag=str(value), position=index)
            for index, value in enumerate(values or [])
        ]
    
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


class DelegationEdgeTag(Base):
    """Context tag entries for delegation edges."""

    __tablename__ = "delegation_edge_tags"

    edge_tag_id = Column(BigInteger, primary_key=True, autoincrement=True)
    edge_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("delegation_edges.edge_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    context_tag = Column(String(255), nullable=False)
    position = Column(Integer, nullable=False, default=0)

    edge = relationship("DelegationEdgeModel", back_populates="context_tag_entries")


class SessionHandoffTransfer(Base):
    """Transactional record of handoff issuance and source-scope narrowing."""

    __tablename__ = "session_handoff_transfers"

    transfer_id = Column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    handoff_jti = Column(String(255), nullable=False, unique=True, index=True)
    source_token_jti = Column(String(255), nullable=False, index=True)
    source_subject_id = Column(String(255), nullable=False, index=True)
    target_subject_id = Column(String(255), nullable=False, index=True)
    organization_id = Column(String(255), nullable=False, index=True)
    tenant_id = Column(String(255), nullable=False, index=True)
    transferred_caveats = Column(JSON, nullable=False, default=list)
    source_remaining_caveats = Column(JSON, nullable=False, default=list)
    issued_at = Column(DateTime, nullable=False, default=datetime.utcnow, index=True)
    source_token_revoked_at = Column(DateTime, nullable=True, index=True)
    consumed_at = Column(DateTime, nullable=True, index=True)

    __table_args__ = (
        Index("ix_session_handoff_transfers_source_revoked", "source_token_jti", "source_token_revoked_at"),
        Index("ix_session_handoff_transfers_handoff_consumed", "handoff_jti", "consumed_at"),
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
    event_attributes = relationship(
        "AuthorityEventAttribute",
        back_populates="event",
        cascade="all, delete-orphan",
        order_by="AuthorityEventAttribute.position",
    )

    @property
    def event_metadata(self) -> dict[str, Any]:
        metadata: dict[str, Any] = {}
        for entry in self.event_attributes:
            metadata[entry.attribute_key] = _decode_authority_attribute(
                entry.attribute_value,
                entry.value_type,
            )
        return metadata

    @event_metadata.setter
    def event_metadata(self, values: Optional[dict[str, Any]]) -> None:
        metadata = values or {}
        self.event_attributes = []
        for index, key in enumerate(sorted(metadata.keys())):
            encoded_value, value_type = _encode_authority_attribute(metadata[key])
            self.event_attributes.append(
                AuthorityEventAttribute(
                    attribute_key=str(key),
                    attribute_value=encoded_value,
                    value_type=value_type,
                    position=index,
                )
            )
    
    # Composite indexes for common queries
    __table_args__ = (
        Index("ix_authority_ledger_events_principal_timestamp", "principal_id", "timestamp"),
        Index("ix_authority_ledger_events_mandate_timestamp", "mandate_id", "timestamp"),
    )
    
    def __repr__(self):
        return f"<AuthorityLedgerEvent(event_id={self.event_id}, event_type={self.event_type}, decision={self.decision})>"


class AuthorityEventAttribute(Base):
    """Typed authority event attributes replacing JSON metadata."""

    __tablename__ = "authority_event_attributes"

    attribute_id = Column(BigInteger, primary_key=True, autoincrement=True)
    event_id = Column(
        BigInteger,
        ForeignKey("authority_ledger_events.event_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    attribute_key = Column(String(255), nullable=False)
    attribute_value = Column(String(4000), nullable=False)
    value_type = Column(String(20), nullable=False, default="str", server_default="str")
    position = Column(Integer, nullable=False, default=0)

    event = relationship("AuthorityLedgerEvent", back_populates="event_attributes")


def _encode_authority_attribute(value: Any) -> tuple[str, str]:
    if value is None:
        return "", "null"
    if isinstance(value, bool):
        return ("true" if value else "false"), "bool"
    if isinstance(value, int):
        return str(value), "int"
    if isinstance(value, float):
        return str(value), "float"
    if isinstance(value, str):
        return value, "str"
    return json.dumps(value, sort_keys=True), "json"


def _decode_authority_attribute(value: str, value_type: str) -> Any:
    normalized = (value_type or "str").lower()
    if normalized == "null":
        return None
    if normalized == "bool":
        return value.lower() == "true"
    if normalized == "int":
        try:
            return int(value)
        except Exception:
            return 0
    if normalized == "float":
        try:
            return float(value)
        except Exception:
            return 0.0
    if normalized == "json":
        try:
            return json.loads(value)
        except Exception:
            return value
    return value


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
    allowed_resource_patterns = Column(JSON, nullable=False)  # List of regex/glob patterns
    allowed_actions = Column(JSON, nullable=False)  # List of action types
    
    # Delegation constraints
    allow_delegation = Column(Boolean, nullable=False, default=False)
    max_network_distance = Column(Integer, nullable=False, default=0)
    
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
    organization_id = Column(PG_UUID(as_uuid=True), nullable=True, index=True)
    name = Column(String(255), nullable=False)
    base_url = Column(String(2048), nullable=False)
    service_type = Column(String(100), nullable=False, default="application", server_default="application")
    auth_scheme = Column(String(100), nullable=False, default="api_key", server_default="api_key")
    version = Column(String(255), nullable=True)
    capabilities = Column(JSON, nullable=False, default=list, server_default=text("'[]'"))
    tags = Column(JSON, nullable=False, default=list, server_default=text("'[]'"))
    provider_metadata = Column("metadata", JSON, nullable=False, default=dict, server_default=text("'{}'"))
    provider_definition = Column(String(255), nullable=False, default="custom", server_default="custom")
    provider_definition_data = Column(JSON, nullable=False, default=dict, server_default=text("'{}'"))
    resources = Column(JSON, nullable=False, default=list, server_default=text("'[]'"))
    actions = Column(JSON, nullable=False, default=list, server_default=text("'[]'"))
    auth_metadata = Column(JSON, nullable=False, default=dict, server_default=text("'{}'"))
    provider_layer = Column(String(50), nullable=False, default="user_provider", server_default="user_provider", index=True)
    template_id = Column(String(255), nullable=True)
    managed_by = Column(String(255), nullable=True)
    credential_storage = Column(String(50), nullable=False, default="gateway_vault", server_default="gateway_vault")

    # JSON arrays stored as JSON
    allowed_paths = Column(JSON, nullable=False, default=list, server_default=text("'[]'"))
    scopes = Column(JSON, nullable=False, default=list, server_default=text("'[]'"))

    tls_pin = Column(String(255), nullable=True)
    secret_ref = Column(String(512), nullable=True)
    healthcheck_path = Column(String(255), nullable=False, default="/health", server_default="/health")
    timeout_seconds = Column(Integer, nullable=False, default=30, server_default="30")
    max_retries = Column(Integer, nullable=False, default=3, server_default="3")
    rate_limit_rpm = Column(Integer, nullable=True)
    default_headers = Column(JSON, nullable=False, default=dict, server_default=text("'{}'"))
    access_policy = Column(JSON, nullable=False, default=dict, server_default=text("'{}'"))
    enabled = Column(Boolean, nullable=False, default=True, index=True)

    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    def __repr__(self):
        return f"<GatewayProvider(provider_id={self.provider_id!r}, base_url={self.base_url!r}, enabled={self.enabled})>"




# ============================================================================
# Sync State Management Models
# ============================================================================


class SyncOperation(Base):
    """
    Queued sync operation for workspace synchronization.
    
    Stores operations that need to be synchronized between local and
    enterprise instances. Operations are queued when offline and processed
    when connectivity is restored.
    
    """
    
    __tablename__ = "sync_operations"
    
    # Primary key
    operation_id = Column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    
    # Workspace identification
    workspace = Column(String(64), nullable=False, index=True)
    
    # Operation details
    operation_type = Column(String(20), nullable=False, index=True)  # create, update, delete
    entity_type = Column(String(100), nullable=False, index=True)
    entity_id = Column(String(255), nullable=False, index=True)
    
    # Operation data (JSON for flexibility)
    operation_data = Column(JSON, nullable=False)
    
    # Timing
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow, index=True)
    scheduled_at = Column(DateTime, nullable=True, index=True)  # For delayed operations
    
    # Retry tracking
    retry_count = Column(Integer, nullable=False, default=0)
    last_retry_at = Column(DateTime, nullable=True)
    last_error = Column(String(2000), nullable=True)
    max_retries = Column(Integer, nullable=False, default=5)
    
    # Status
    status = Column(
        String(20), 
        nullable=False, 
        default="pending", 
        index=True
    )  # pending, processing, completed, failed
    completed_at = Column(DateTime, nullable=True)
    
    # Metadata
    operation_metadata = Column("metadata", JSON, nullable=True)
    correlation_id = Column(String(255), nullable=True, index=True)
    
    # Composite indexes for efficient querying
    __table_args__ = (
        Index("ix_sync_operations_workspace_status", "workspace", "status"),
        Index("ix_sync_operations_workspace_created", "workspace", "created_at"),
        Index("ix_sync_operations_entity", "entity_type", "entity_id"),
    )
    
    def __repr__(self):
        return (
            f"<SyncOperation(operation_id={self.operation_id}, "
            f"workspace={self.workspace}, type={self.operation_type}, "
            f"status={self.status})>"
        )


class SyncConflict(Base):
    """
    Detected conflict during workspace synchronization.
    
    Stores conflicts that occur when the same entity is modified on both
    local and enterprise instances. Tracks resolution status and strategy.
    
    """
    
    __tablename__ = "sync_conflicts"
    
    # Primary key
    conflict_id = Column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    
    # Workspace identification
    workspace = Column(String(64), nullable=False, index=True)
    
    # Entity identification
    entity_type = Column(String(100), nullable=False, index=True)
    entity_id = Column(String(255), nullable=False, index=True)
    
    # Conflict versions (JSON for flexibility)
    local_version = Column(JSON, nullable=False)
    remote_version = Column(JSON, nullable=False)
    
    # Timestamps
    local_timestamp = Column(DateTime, nullable=False, index=True)
    remote_timestamp = Column(DateTime, nullable=False, index=True)
    detected_at = Column(DateTime, nullable=False, default=datetime.utcnow, index=True)
    
    # Resolution
    resolution_strategy = Column(String(50), nullable=True)  # operational_transform, last_write_wins, etc.
    resolved_version = Column(JSON, nullable=True)
    resolved_at = Column(DateTime, nullable=True, index=True)
    resolved_by = Column(String(255), nullable=True)  # system or user identifier
    
    # Status
    status = Column(
        String(20), 
        nullable=False, 
        default="unresolved", 
        index=True
    )  # unresolved, resolved, manual_review
    
    # Metadata
    conflict_metadata = Column("metadata", JSON, nullable=True)
    correlation_id = Column(String(255), nullable=True, index=True)
    
    # Composite indexes for efficient querying
    __table_args__ = (
        Index("ix_sync_conflicts_workspace_status", "workspace", "status"),
        Index("ix_sync_conflicts_workspace_detected", "workspace", "detected_at"),
        Index("ix_sync_conflicts_entity", "entity_type", "entity_id"),
    )
    
    def __repr__(self):
        return (
            f"<SyncConflict(conflict_id={self.conflict_id}, "
            f"workspace={self.workspace}, entity={self.entity_type}:{self.entity_id}, "
            f"status={self.status})>"
        )


class SyncMetadata(Base):
    """
    Sync metadata for workspace synchronization state.
    
    Stores sync configuration and state for each workspace, including
    last sync timestamp, remote URL, and sync statistics.
    
    """
    
    __tablename__ = "sync_metadata"
    
    # Primary key (workspace name)
    workspace = Column(String(64), primary_key=True)
    
    # Remote configuration
    remote_url = Column(String(2048), nullable=True)
    remote_version = Column(String(50), nullable=True)
    
    # Sync state
    sync_enabled = Column(Boolean, nullable=False, default=False, index=True)
    last_sync_at = Column(DateTime, nullable=True, index=True)
    last_sync_direction = Column(String(20), nullable=True)  # push, pull, bidirectional
    last_sync_status = Column(String(20), nullable=True)  # success, failed, partial
    
    # Statistics
    total_operations_synced = Column(BigInteger, nullable=False, default=0)
    total_conflicts_detected = Column(BigInteger, nullable=False, default=0)
    total_conflicts_resolved = Column(BigInteger, nullable=False, default=0)
    
    # Error tracking
    last_error = Column(String(2000), nullable=True)
    last_error_at = Column(DateTime, nullable=True)
    consecutive_failures = Column(Integer, nullable=False, default=0)
    
    # Auto-sync configuration
    auto_sync_enabled = Column(Boolean, nullable=False, default=False)
    auto_sync_interval_seconds = Column(Integer, nullable=True)
    next_auto_sync_at = Column(DateTime, nullable=True, index=True)
    
    # Timestamps
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # Metadata
    sync_metadata_data = Column("metadata", JSON, nullable=True)
    
    def __repr__(self):
        return (
            f"<SyncMetadata(workspace={self.workspace}, "
            f"sync_enabled={self.sync_enabled}, "
            f"last_sync={self.last_sync_at})>"
        )
