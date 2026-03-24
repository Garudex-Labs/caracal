"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for native implementations (MeteringEvent, AgentIdentity, AuditReference).

These tests verify that the native implementations work correctly after ASE removal.
Tests cover instantiation, validation, and serialization for all native types.

Requirements: 14.3, 14.4, 14.5
"""

import pytest
from datetime import datetime
from decimal import Decimal

from caracal.core.metering import MeteringEvent
from caracal.core.identity import AgentIdentity, VerificationStatus
from caracal.core.audit import AuditReference
from caracal.exceptions import InvalidMeteringEventError


class TestMeteringEventInstantiation:
    """Test MeteringEvent instantiation and validation."""
    
    def test_metering_event_with_all_fields(self):
        """Test MeteringEvent instantiation with all fields."""
        timestamp = datetime.utcnow()
        event = MeteringEvent(
            agent_id="agent-123",
            resource_type="mcp.tool.search",
            quantity=Decimal("1.5"),
            timestamp=timestamp,
            metadata={"tool": "search", "query": "test"},
            correlation_id="corr-456",
            parent_event_id="parent-789",
            tags=["mcp", "search"]
        )
        
        assert event.agent_id == "agent-123"
        assert event.resource_type == "mcp.tool.search"
        assert event.quantity == Decimal("1.5")
        assert event.timestamp == timestamp
        assert event.metadata == {"tool": "search", "query": "test"}
        assert event.correlation_id == "corr-456"
        assert event.parent_event_id == "parent-789"
        assert event.tags == ["mcp", "search"]
    
    def test_metering_event_with_minimal_fields(self):
        """Test MeteringEvent instantiation with minimal required fields."""
        event = MeteringEvent(
            agent_id="agent-123",
            resource_type="api.call",
            quantity=Decimal("1")
        )
        
        assert event.agent_id == "agent-123"
        assert event.resource_type == "api.call"
        assert event.quantity == Decimal("1")
        assert event.timestamp is not None  # Auto-generated
        assert isinstance(event.timestamp, datetime)
        assert event.metadata == {}
        assert event.correlation_id is None
        assert event.parent_event_id is None
        assert event.tags == []
    
    def test_metering_event_auto_timestamp(self):
        """Test that timestamp is auto-generated when not provided."""
        before = datetime.utcnow()
        event = MeteringEvent(
            agent_id="agent-123",
            resource_type="api.call",
            quantity=Decimal("1")
        )
        after = datetime.utcnow()
        
        assert before <= event.timestamp <= after
    
    def test_metering_event_validation_empty_agent_id(self):
        """Test that empty agent_id raises InvalidMeteringEventError."""
        with pytest.raises(InvalidMeteringEventError, match="agent_id must be non-empty string"):
            MeteringEvent(
                agent_id="",
                resource_type="api.call",
                quantity=Decimal("1")
            )
    
    def test_metering_event_validation_empty_resource_type(self):
        """Test that empty resource_type raises InvalidMeteringEventError."""
        with pytest.raises(InvalidMeteringEventError, match="resource_type must be non-empty string"):
            MeteringEvent(
                agent_id="agent-123",
                resource_type="",
                quantity=Decimal("1")
            )
    
    def test_metering_event_validation_negative_quantity(self):
        """Test that negative quantity raises InvalidMeteringEventError."""
        with pytest.raises(InvalidMeteringEventError, match="quantity must be non-negative"):
            MeteringEvent(
                agent_id="agent-123",
                resource_type="api.call",
                quantity=Decimal("-1")
            )
    
    def test_metering_event_validation_invalid_quantity_type(self):
        """Test that non-Decimal quantity raises InvalidMeteringEventError."""
        with pytest.raises(InvalidMeteringEventError, match="quantity must be a Decimal"):
            MeteringEvent(
                agent_id="agent-123",
                resource_type="api.call",
                quantity=1  # Should be Decimal, not int
            )


class TestMeteringEventSerialization:
    """Test MeteringEvent serialization and deserialization."""
    
    def test_metering_event_to_dict(self):
        """Test MeteringEvent serialization to dictionary."""
        timestamp = datetime(2024, 1, 15, 10, 30, 0)
        event = MeteringEvent(
            agent_id="agent-123",
            resource_type="mcp.tool.search",
            quantity=Decimal("1.5"),
            timestamp=timestamp,
            metadata={"tool": "search"},
            correlation_id="corr-456",
            parent_event_id="parent-789",
            tags=["mcp", "search"]
        )
        
        data = event.to_dict()
        
        assert data["agent_id"] == "agent-123"
        assert data["resource_type"] == "mcp.tool.search"
        assert data["quantity"] == "1.5"
        assert data["timestamp"] == "2024-01-15T10:30:00"
        assert data["metadata"] == {"tool": "search"}
        assert data["correlation_id"] == "corr-456"
        assert data["parent_event_id"] == "parent-789"
        assert data["tags"] == ["mcp", "search"]
    
    def test_metering_event_from_dict(self):
        """Test MeteringEvent deserialization from dictionary."""
        data = {
            "agent_id": "agent-123",
            "resource_type": "mcp.tool.search",
            "quantity": "1.5",
            "timestamp": "2024-01-15T10:30:00",
            "metadata": {"tool": "search"},
            "correlation_id": "corr-456",
            "parent_event_id": "parent-789",
            "tags": ["mcp", "search"]
        }
        
        event = MeteringEvent.from_dict(data)
        
        assert event.agent_id == "agent-123"
        assert event.resource_type == "mcp.tool.search"
        assert event.quantity == Decimal("1.5")
        assert event.timestamp == datetime(2024, 1, 15, 10, 30, 0)
        assert event.metadata == {"tool": "search"}
        assert event.correlation_id == "corr-456"
        assert event.parent_event_id == "parent-789"
        assert event.tags == ["mcp", "search"]
    
    def test_metering_event_round_trip(self):
        """Test MeteringEvent serialization round-trip."""
        original = MeteringEvent(
            agent_id="agent-123",
            resource_type="mcp.tool.search",
            quantity=Decimal("1.5"),
            timestamp=datetime(2024, 1, 15, 10, 30, 0),
            metadata={"tool": "search"},
            correlation_id="corr-456",
            parent_event_id="parent-789",
            tags=["mcp", "search"]
        )
        
        # Serialize and deserialize
        data = original.to_dict()
        restored = MeteringEvent.from_dict(data)
        
        # Verify all fields match
        assert restored.agent_id == original.agent_id
        assert restored.resource_type == original.resource_type
        assert restored.quantity == original.quantity
        assert restored.timestamp == original.timestamp
        assert restored.metadata == original.metadata
        assert restored.correlation_id == original.correlation_id
        assert restored.parent_event_id == original.parent_event_id
        assert restored.tags == original.tags


class TestAgentIdentityInstantiation:
    """Test AgentIdentity instantiation and validation."""
    
    def test_agent_identity_with_all_fields(self):
        """Test AgentIdentity instantiation with all fields."""
        created_at = datetime.utcnow().isoformat() + "Z"
        last_verified = datetime.utcnow().isoformat() + "Z"
        
        identity = AgentIdentity(
            agent_id="agent-123",
            name="Test Agent",
            owner="owner@example.com",
            created_at=created_at,
            metadata={"key": "value"},
            public_key="public-key-123",
            org_id="org-456",
            role="admin",
            verification_status=VerificationStatus.VERIFIED,
            trust_level=75,
            capabilities=["read", "write"],
            last_verified_at=last_verified
        )
        
        assert identity.agent_id == "agent-123"
        assert identity.name == "Test Agent"
        assert identity.owner == "owner@example.com"
        assert identity.created_at == created_at
        assert identity.metadata == {"key": "value"}
        assert identity.public_key == "public-key-123"
        assert identity.org_id == "org-456"
        assert identity.role == "admin"
        assert identity.verification_status == VerificationStatus.VERIFIED
        assert identity.trust_level == 75
        assert identity.capabilities == ["read", "write"]
        assert identity.last_verified_at == last_verified
    
    def test_agent_identity_with_minimal_fields(self):
        """Test AgentIdentity instantiation with minimal required fields."""
        identity = AgentIdentity(
            agent_id="agent-123",
            name="Test Agent",
            owner="owner@example.com",
            created_at=datetime.utcnow().isoformat() + "Z",
            metadata={}
        )
        
        assert identity.agent_id == "agent-123"
        assert identity.name == "Test Agent"
        assert identity.owner == "owner@example.com"
        assert identity.public_key is None
        assert identity.org_id is None
        assert identity.role is None
        assert identity.verification_status == VerificationStatus.UNVERIFIED
        assert identity.trust_level == 0
        assert identity.capabilities == []
        assert identity.last_verified_at is None
    
    def test_agent_identity_validation_empty_agent_id(self):
        """Test that empty agent_id raises ValueError."""
        with pytest.raises(ValueError, match="agent_id must be non-empty string"):
            AgentIdentity(
                agent_id="",
                name="Test Agent",
                owner="owner@example.com",
                created_at=datetime.utcnow().isoformat() + "Z",
                metadata={}
            )
    
    def test_agent_identity_validation_trust_level_too_low(self):
        """Test that trust_level below 0 raises ValueError."""
        with pytest.raises(ValueError, match="trust_level must be between 0 and 100"):
            AgentIdentity(
                agent_id="agent-123",
                name="Test Agent",
                owner="owner@example.com",
                created_at=datetime.utcnow().isoformat() + "Z",
                metadata={},
                trust_level=-1
            )
    
    def test_agent_identity_validation_trust_level_too_high(self):
        """Test that trust_level above 100 raises ValueError."""
        with pytest.raises(ValueError, match="trust_level must be between 0 and 100"):
            AgentIdentity(
                agent_id="agent-123",
                name="Test Agent",
                owner="owner@example.com",
                created_at=datetime.utcnow().isoformat() + "Z",
                metadata={},
                trust_level=101
            )
    
    def test_agent_identity_has_capability(self):
        """Test has_capability method."""
        identity = AgentIdentity(
            agent_id="agent-123",
            name="Test Agent",
            owner="owner@example.com",
            created_at=datetime.utcnow().isoformat() + "Z",
            metadata={},
            capabilities=["read", "write"]
        )
        
        assert identity.has_capability("read") is True
        assert identity.has_capability("write") is True
        assert identity.has_capability("delete") is False
    
    def test_agent_identity_is_verified(self):
        """Test is_verified method."""
        unverified = AgentIdentity(
            agent_id="agent-123",
            name="Test Agent",
            owner="owner@example.com",
            created_at=datetime.utcnow().isoformat() + "Z",
            metadata={},
            verification_status=VerificationStatus.UNVERIFIED
        )
        
        verified = AgentIdentity(
            agent_id="agent-456",
            name="Test Agent 2",
            owner="owner@example.com",
            created_at=datetime.utcnow().isoformat() + "Z",
            metadata={},
            verification_status=VerificationStatus.VERIFIED
        )
        
        trusted = AgentIdentity(
            agent_id="agent-789",
            name="Test Agent 3",
            owner="owner@example.com",
            created_at=datetime.utcnow().isoformat() + "Z",
            metadata={},
            verification_status=VerificationStatus.TRUSTED
        )
        
        assert unverified.is_verified() is False
        assert verified.is_verified() is True
        assert trusted.is_verified() is True


class TestAgentIdentitySerialization:
    """Test AgentIdentity serialization and deserialization."""
    
    def test_agent_identity_to_dict(self):
        """Test AgentIdentity serialization to dictionary."""
        created_at = "2024-01-15T10:30:00Z"
        last_verified = "2024-01-16T10:30:00Z"
        
        identity = AgentIdentity(
            agent_id="agent-123",
            name="Test Agent",
            owner="owner@example.com",
            created_at=created_at,
            metadata={"key": "value"},
            public_key="public-key-123",
            org_id="org-456",
            role="admin",
            verification_status=VerificationStatus.VERIFIED,
            trust_level=75,
            capabilities=["read", "write"],
            last_verified_at=last_verified
        )
        
        data = identity.to_dict()
        
        assert data["agent_id"] == "agent-123"
        assert data["name"] == "Test Agent"
        assert data["owner"] == "owner@example.com"
        assert data["created_at"] == created_at
        assert data["metadata"] == {"key": "value"}
        assert data["public_key"] == "public-key-123"
        assert data["org_id"] == "org-456"
        assert data["role"] == "admin"
        assert data["verification_status"] == "verified"
        assert data["trust_level"] == 75
        assert data["capabilities"] == ["read", "write"]
        assert data["last_verified_at"] == last_verified
    
    def test_agent_identity_from_dict(self):
        """Test AgentIdentity deserialization from dictionary."""
        data = {
            "agent_id": "agent-123",
            "name": "Test Agent",
            "owner": "owner@example.com",
            "created_at": "2024-01-15T10:30:00Z",
            "metadata": {"key": "value"},
            "public_key": "public-key-123",
            "org_id": "org-456",
            "role": "admin",
            "verification_status": "verified",
            "trust_level": 75,
            "capabilities": ["read", "write"],
            "last_verified_at": "2024-01-16T10:30:00Z"
        }
        
        identity = AgentIdentity.from_dict(data)
        
        assert identity.agent_id == "agent-123"
        assert identity.name == "Test Agent"
        assert identity.owner == "owner@example.com"
        assert identity.created_at == "2024-01-15T10:30:00Z"
        assert identity.metadata == {"key": "value"}
        assert identity.public_key == "public-key-123"
        assert identity.org_id == "org-456"
        assert identity.role == "admin"
        assert identity.verification_status == VerificationStatus.VERIFIED
        assert identity.trust_level == 75
        assert identity.capabilities == ["read", "write"]
        assert identity.last_verified_at == "2024-01-16T10:30:00Z"
    
    def test_agent_identity_round_trip(self):
        """Test AgentIdentity serialization round-trip."""
        original = AgentIdentity(
            agent_id="agent-123",
            name="Test Agent",
            owner="owner@example.com",
            created_at="2024-01-15T10:30:00Z",
            metadata={"key": "value"},
            public_key="public-key-123",
            org_id="org-456",
            role="admin",
            verification_status=VerificationStatus.VERIFIED,
            trust_level=75,
            capabilities=["read", "write"],
            last_verified_at="2024-01-16T10:30:00Z"
        )
        
        # Serialize and deserialize
        data = original.to_dict()
        restored = AgentIdentity.from_dict(data)
        
        # Verify all fields match
        assert restored.agent_id == original.agent_id
        assert restored.name == original.name
        assert restored.owner == original.owner
        assert restored.created_at == original.created_at
        assert restored.metadata == original.metadata
        assert restored.public_key == original.public_key
        assert restored.org_id == original.org_id
        assert restored.role == original.role
        assert restored.verification_status == original.verification_status
        assert restored.trust_level == original.trust_level
        assert restored.capabilities == original.capabilities
        assert restored.last_verified_at == original.last_verified_at


class TestAuditReferenceInstantiation:
    """Test AuditReference instantiation and validation."""
    
    def test_audit_reference_with_all_fields(self):
        """Test AuditReference instantiation with all fields."""
        timestamp = datetime.utcnow()
        
        ref = AuditReference(
            audit_id="audit-123",
            location="s3://bucket/audit-123.json",
            hash="abc123def456",
            hash_algorithm="SHA-256",
            previous_hash="prev-hash-789",
            signature="signature-xyz",
            signer_id="signer-456",
            timestamp=timestamp,
            entry_count=100
        )
        
        assert ref.audit_id == "audit-123"
        assert ref.location == "s3://bucket/audit-123.json"
        assert ref.hash == "abc123def456"
        assert ref.hash_algorithm == "SHA-256"
        assert ref.previous_hash == "prev-hash-789"
        assert ref.signature == "signature-xyz"
        assert ref.signer_id == "signer-456"
        assert ref.timestamp == timestamp
        assert ref.entry_count == 100
    
    def test_audit_reference_with_minimal_fields(self):
        """Test AuditReference instantiation with minimal required fields."""
        ref = AuditReference(audit_id="audit-123")
        
        assert ref.audit_id == "audit-123"
        assert ref.location is None
        assert ref.hash == ""
        assert ref.hash_algorithm == "SHA-256"
        assert ref.previous_hash is None
        assert ref.signature is None
        assert ref.signer_id is None
        assert ref.timestamp is not None  # Auto-generated
        assert isinstance(ref.timestamp, datetime)
        assert ref.entry_count == 0
    
    def test_audit_reference_auto_timestamp(self):
        """Test that timestamp is auto-generated when not provided."""
        before = datetime.utcnow()
        ref = AuditReference(audit_id="audit-123")
        after = datetime.utcnow()
        
        assert before <= ref.timestamp <= after
    
    def test_audit_reference_validation_empty_audit_id(self):
        """Test that empty audit_id raises ValueError."""
        with pytest.raises(ValueError, match="audit_id must be non-empty string"):
            AuditReference(audit_id="")


class TestAuditReferenceSerialization:
    """Test AuditReference serialization and deserialization."""
    
    def test_audit_reference_to_dict(self):
        """Test AuditReference serialization to dictionary."""
        timestamp = datetime(2024, 1, 15, 10, 30, 0)
        
        ref = AuditReference(
            audit_id="audit-123",
            location="s3://bucket/audit-123.json",
            hash="abc123def456",
            hash_algorithm="SHA-256",
            previous_hash="prev-hash-789",
            signature="signature-xyz",
            signer_id="signer-456",
            timestamp=timestamp,
            entry_count=100
        )
        
        data = ref.to_dict()
        
        assert data["audit_id"] == "audit-123"
        assert data["location"] == "s3://bucket/audit-123.json"
        assert data["hash"] == "abc123def456"
        assert data["hash_algorithm"] == "SHA-256"
        assert data["previous_hash"] == "prev-hash-789"
        assert data["signature"] == "signature-xyz"
        assert data["signer_id"] == "signer-456"
        assert data["timestamp"] == "2024-01-15T10:30:00"
        assert data["entry_count"] == 100
    
    def test_audit_reference_from_dict(self):
        """Test AuditReference deserialization from dictionary."""
        data = {
            "audit_id": "audit-123",
            "location": "s3://bucket/audit-123.json",
            "hash": "abc123def456",
            "hash_algorithm": "SHA-256",
            "previous_hash": "prev-hash-789",
            "signature": "signature-xyz",
            "signer_id": "signer-456",
            "timestamp": "2024-01-15T10:30:00",
            "entry_count": 100
        }
        
        ref = AuditReference.from_dict(data)
        
        assert ref.audit_id == "audit-123"
        assert ref.location == "s3://bucket/audit-123.json"
        assert ref.hash == "abc123def456"
        assert ref.hash_algorithm == "SHA-256"
        assert ref.previous_hash == "prev-hash-789"
        assert ref.signature == "signature-xyz"
        assert ref.signer_id == "signer-456"
        assert ref.timestamp == datetime(2024, 1, 15, 10, 30, 0)
        assert ref.entry_count == 100
    
    def test_audit_reference_round_trip(self):
        """Test AuditReference serialization round-trip."""
        original = AuditReference(
            audit_id="audit-123",
            location="s3://bucket/audit-123.json",
            hash="abc123def456",
            hash_algorithm="SHA-256",
            previous_hash="prev-hash-789",
            signature="signature-xyz",
            signer_id="signer-456",
            timestamp=datetime(2024, 1, 15, 10, 30, 0),
            entry_count=100
        )
        
        # Serialize and deserialize
        data = original.to_dict()
        restored = AuditReference.from_dict(data)
        
        # Verify all fields match
        assert restored.audit_id == original.audit_id
        assert restored.location == original.location
        assert restored.hash == original.hash
        assert restored.hash_algorithm == original.hash_algorithm
        assert restored.previous_hash == original.previous_hash
        assert restored.signature == original.signature
        assert restored.signer_id == original.signer_id
        assert restored.timestamp == original.timestamp
        assert restored.entry_count == original.entry_count
