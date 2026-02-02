"""
SQLAlchemy models for Caracal Core v0.2 PostgreSQL backend.

This module defines the database schema for:
- Agent identities with parent-child relationships
- Budget policies with delegation tracking
- Ledger events for immutable spending records
- Provisional charges for budget reservations
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


class AgentIdentity(Base):
    """
    Agent identity registry with parent-child relationships.
    
    Stores agent identities with support for hierarchical agent structures.
    Parent agents can create child agents with delegated budgets.
    
    Requirements: 3.2, 8.2, 8.3, 8.7
    """
    
    __tablename__ = "agent_identities"
    
    # Primary key
    agent_id = Column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    
    # Core fields
    name = Column(String(255), unique=True, nullable=False, index=True)
    owner = Column(String(255), nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    
    # Parent-child relationship
    parent_agent_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("agent_identities.agent_id"),
        nullable=True,
        index=True,
    )
    
    # Metadata and authentication
    agent_metadata = Column("metadata", JSON().with_variant(JSONB, "postgresql"), nullable=True)
    api_key_hash = Column(String(255), nullable=True)
    
    # Relationships
    parent = relationship(
        "AgentIdentity",
        remote_side=[agent_id],
        backref="children",
        foreign_keys=[parent_agent_id],
    )
    
    policies = relationship("BudgetPolicy", back_populates="agent", foreign_keys="BudgetPolicy.agent_id")
    ledger_events = relationship("LedgerEvent", back_populates="agent")
    provisional_charges = relationship("ProvisionalCharge", back_populates="agent")
    
    def __repr__(self):
        return f"<AgentIdentity(agent_id={self.agent_id}, name={self.name})>"


class BudgetPolicy(Base):
    """
    Budget policy store with delegation tracking.
    
    Stores budget policies for agents with support for delegation from parent agents.
    Policies define spending limits over time windows (daily, weekly, monthly).
    
    Requirements: 4.2, 9.1, 9.3
    """
    
    __tablename__ = "budget_policies"
    
    # Primary key
    policy_id = Column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    
    # Foreign key to agent
    agent_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("agent_identities.agent_id"),
        nullable=False,
        index=True,
    )
    
    # Budget configuration
    limit_amount = Column(Numeric(precision=20, scale=6), nullable=False)
    time_window = Column(String(50), nullable=False)  # "daily", "weekly", "monthly"
    currency = Column(String(3), nullable=False, default="USD")
    
    # Delegation tracking
    delegated_from_agent_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("agent_identities.agent_id"),
        nullable=True,
    )
    
    # Metadata
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    active = Column(Boolean, nullable=False, default=True)
    
    # Relationships
    agent = relationship("AgentIdentity", back_populates="policies", foreign_keys=[agent_id])
    delegated_from = relationship("AgentIdentity", foreign_keys=[delegated_from_agent_id])
    
    # Composite index for active policy queries
    __table_args__ = (
        Index("ix_budget_policies_agent_active", "agent_id", "active"),
    )
    
    def __repr__(self):
        return f"<BudgetPolicy(policy_id={self.policy_id}, agent_id={self.agent_id}, limit={self.limit_amount})>"


class LedgerEvent(Base):
    """
    Immutable ledger events for spending tracking.
    
    Stores all metering events with automatic monotonic ID generation.
    Events are append-only and never modified or deleted.
    
    Requirements: 5.2, 15.1, 15.2
    """
    
    __tablename__ = "ledger_events"
    
    # Primary key with auto-increment
    event_id = Column(BigInteger, primary_key=True, autoincrement=True)
    
    # Foreign key to agent
    agent_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("agent_identities.agent_id"),
        nullable=False,
        index=True,
    )
    
    # Event data
    timestamp = Column(DateTime, nullable=False, default=datetime.utcnow, index=True)
    resource_type = Column(String(255), nullable=False)
    quantity = Column(Numeric(precision=20, scale=6), nullable=False)
    cost = Column(Numeric(precision=20, scale=6), nullable=False)
    currency = Column(String(3), nullable=False, default="USD")
    
    # Metadata and provisional charge tracking
    event_metadata = Column("metadata", JSON().with_variant(JSONB, "postgresql"), nullable=True)
    provisional_charge_id = Column(PG_UUID(as_uuid=True), nullable=True)
    
    # Relationships
    agent = relationship("AgentIdentity", back_populates="ledger_events")
    
    # Composite index for time-range queries
    __table_args__ = (
        Index("ix_ledger_events_agent_timestamp", "agent_id", "timestamp"),
    )
    
    def __repr__(self):
        return f"<LedgerEvent(event_id={self.event_id}, agent_id={self.agent_id}, cost={self.cost})>"


class ProvisionalCharge(Base):
    """
    Provisional charges for budget reservations with automatic expiration.
    
    Stores budget reservations created during policy checks. Charges automatically
    expire after a configurable timeout and are released by a background cleanup job.
    
    Requirements: 14.1, 14.2, 14.3, 14.4, 14.6
    """
    
    __tablename__ = "provisional_charges"
    
    # Primary key
    charge_id = Column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    
    # Foreign key to agent
    agent_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("agent_identities.agent_id"),
        nullable=False,
        index=True,
    )
    
    # Charge data
    amount = Column(Numeric(precision=20, scale=6), nullable=False)
    currency = Column(String(3), nullable=False, default="USD")
    
    # Lifecycle timestamps
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    expires_at = Column(DateTime, nullable=False, index=True)
    
    # Release tracking
    released = Column(Boolean, nullable=False, default=False)
    final_charge_event_id = Column(
        BigInteger,
        ForeignKey("ledger_events.event_id"),
        nullable=True,
    )
    
    # Relationships
    agent = relationship("AgentIdentity", back_populates="provisional_charges")
    final_charge = relationship("LedgerEvent")
    
    # Composite indexes for queries
    __table_args__ = (
        Index("ix_provisional_charges_agent_released", "agent_id", "released"),
        Index("ix_provisional_charges_expires_released", "expires_at", "released"),
    )
    
    def __repr__(self):
        return f"<ProvisionalCharge(charge_id={self.charge_id}, agent_id={self.agent_id}, amount={self.amount}, released={self.released})>"


class AuditLog(Base):
    """
    Append-only audit log for all system events.
    
    Stores comprehensive audit trail of all events from Kafka topics.
    Records are append-only with no updates or deletes allowed.
    
    Requirements: 17.1, 17.2, 17.3, 17.4
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
    
    # Timestamp
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow, index=True)
    
    # Composite index for event range queries
    __table_args__ = (
        Index("ix_merkle_roots_event_range", "first_event_id", "last_event_id"),
    )
    
    def __repr__(self):
        return f"<MerkleRoot(root_id={self.root_id}, batch_id={self.batch_id}, events={self.first_event_id}-{self.last_event_id})>"

