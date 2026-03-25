"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for AuthorityMetadata implementation.

These tests validate the AuthorityMetadata class functionality including
instantiation, serialization, and integration with PrincipalIdentity and AuditReference.
"""

from datetime import datetime

import pytest

from caracal.core.authority_metadata import AuthorityMetadata
from caracal.core.identity import PrincipalIdentity, VerificationStatus
from caracal.core.audit import AuditReference


class TestAuthorityMetadata:
    """Unit tests for AuthorityMetadata."""
    
    def test_instantiation_with_all_fields(self):
        """
        Test instantiation with all fields.
        
        **Validates: Requirements 19.1**
        """
        # Create agent identity
        agent_identity = PrincipalIdentity(
            agent_id="agent-123",
            name="Test Agent",
            owner="test-owner",
            created_at=datetime.utcnow().isoformat() + "Z",
            metadata={},
            verification_status=VerificationStatus.VERIFIED,
            trust_level=75
        )
        
        # Create audit reference
        audit_reference = AuditReference(
            audit_id="audit-456",
            hash="abc123def456",
            hash_algorithm="SHA-256"
        )
        
        # Create authority metadata
        metadata = AuthorityMetadata(
            version="1.0.0",
            agent_identity=agent_identity,
            mandate_id="mandate-789",
            audit_reference=audit_reference,
            delegation_token="jwt.token.here",
            delegation_chain=["agent-123", "agent-456"],
            timestamp=datetime.utcnow(),
            signature="signature-xyz"
        )
        
        # Verify all fields
        assert metadata.version == "1.0.0"
        assert metadata.principal_identity == agent_identity
        assert metadata.mandate_id == "mandate-789"
        assert metadata.audit_reference == audit_reference
        assert metadata.delegation_token == "jwt.token.here"
        assert metadata.delegation_chain == ["agent-123", "agent-456"]
        assert metadata.timestamp is not None
        assert metadata.signature == "signature-xyz"
    
    def test_instantiation_with_minimal_fields(self):
        """
        Test instantiation with minimal fields (defaults).
        
        **Validates: Requirements 19.1**
        """
        metadata = AuthorityMetadata()
        
        # Verify defaults
        assert metadata.version == "1.0.0"
        assert metadata.principal_identity is None
        assert metadata.mandate_id is None
        assert metadata.audit_reference is None
        assert metadata.delegation_token is None
        assert metadata.delegation_chain == []
        assert metadata.timestamp is not None  # Auto-generated
        assert metadata.signature is None
    
    def test_auto_timestamp_generation(self):
        """
        Test that timestamp is auto-generated if not provided.
        
        **Validates: Requirements 19.1**
        """
        before = datetime.utcnow()
        metadata = AuthorityMetadata()
        after = datetime.utcnow()
        
        # Timestamp should be between before and after
        assert metadata.timestamp is not None
        assert before <= metadata.timestamp <= after
    
    def test_serialization_deserialization(self):
        """
        Test serialization and deserialization.
        
        **Validates: Requirements 19.2**
        """
        # Create agent identity
        agent_identity = PrincipalIdentity(
            agent_id="agent-123",
            name="Test Agent",
            owner="test-owner",
            created_at=datetime.utcnow().isoformat() + "Z",
            metadata={"key": "value"},
            verification_status=VerificationStatus.TRUSTED,
            trust_level=90,
            capabilities=["read", "write"]
        )
        
        # Create audit reference
        audit_reference = AuditReference(
            audit_id="audit-456",
            hash="abc123def456",
            hash_algorithm="SHA-256",
            entry_count=10
        )
        
        # Create authority metadata
        original = AuthorityMetadata(
            version="1.0.0",
            agent_identity=agent_identity,
            mandate_id="mandate-789",
            audit_reference=audit_reference,
            delegation_token="jwt.token.here",
            delegation_chain=["agent-123", "agent-456", "agent-789"],
            signature="signature-xyz"
        )
        
        # Serialize to dict
        metadata_dict = original.to_dict()
        
        # Verify dict structure
        assert metadata_dict["version"] == "1.0.0"
        assert metadata_dict["agent_identity"] is not None
        assert metadata_dict["agent_identity"]["agent_id"] == "agent-123"
        assert metadata_dict["mandate_id"] == "mandate-789"
        assert metadata_dict["audit_reference"] is not None
        assert metadata_dict["audit_reference"]["audit_id"] == "audit-456"
        assert metadata_dict["delegation_token"] == "jwt.token.here"
        assert metadata_dict["delegation_chain"] == ["agent-123", "agent-456", "agent-789"]
        assert metadata_dict["signature"] == "signature-xyz"
        
        # Deserialize back to AuthorityMetadata
        restored = AuthorityMetadata.from_dict(metadata_dict)
        
        # Verify all fields match
        assert restored.version == original.version
        assert restored.principal_identity.principal_id == original.principal_identity.principal_id
        assert restored.principal_identity.name == original.principal_identity.name
        assert restored.principal_identity.verification_status == original.principal_identity.verification_status
        assert restored.mandate_id == original.mandate_id
        assert restored.audit_reference.audit_id == original.audit_reference.audit_id
        assert restored.audit_reference.hash == original.audit_reference.hash
        assert restored.delegation_token == original.delegation_token
        assert restored.delegation_chain == original.delegation_chain
        assert restored.signature == original.signature
    
    def test_serialization_with_none_fields(self):
        """
        Test serialization with None fields.
        
        **Validates: Requirements 19.2**
        """
        metadata = AuthorityMetadata(
            version="1.0.0",
            agent_identity=None,
            audit_reference=None
        )
        
        # Serialize to dict
        metadata_dict = metadata.to_dict()
        
        # Verify None fields are preserved
        assert metadata_dict["agent_identity"] is None
        assert metadata_dict["audit_reference"] is None
        
        # Deserialize back
        restored = AuthorityMetadata.from_dict(metadata_dict)
        
        # Verify None fields are preserved
        assert restored.principal_identity is None
        assert restored.audit_reference is None
    
    def test_integration_with_agent_identity(self):
        """
        Test integration with PrincipalIdentity.
        
        **Validates: Requirements 19.3**
        """
        # Create agent identity with enhanced fields
        agent_identity = PrincipalIdentity(
            agent_id="agent-123",
            name="Test Agent",
            owner="test-owner",
            created_at=datetime.utcnow().isoformat() + "Z",
            metadata={"department": "engineering"},
            public_key="public-key-pem",
            org_id="org-456",
            role="developer",
            verification_status=VerificationStatus.VERIFIED,
            trust_level=80,
            capabilities=["api_call", "mcp_tool"],
            last_verified_at=datetime.utcnow().isoformat() + "Z"
        )
        
        # Create authority metadata with agent identity
        metadata = AuthorityMetadata(
            agent_identity=agent_identity,
            mandate_id="mandate-789"
        )
        
        # Verify integration
        assert metadata.principal_identity == agent_identity
        assert metadata.principal_identity.principal_id == "agent-123"
        assert metadata.principal_identity.verification_status == VerificationStatus.VERIFIED
        assert metadata.principal_identity.trust_level == 80
        assert metadata.principal_identity.has_capability("api_call")
        assert metadata.principal_identity.is_verified()
        
        # Serialize and deserialize
        metadata_dict = metadata.to_dict()
        restored = AuthorityMetadata.from_dict(metadata_dict)
        
        # Verify agent identity is preserved
        assert restored.principal_identity.principal_id == agent_identity.principal_id
        assert restored.principal_identity.verification_status == agent_identity.verification_status
        assert restored.principal_identity.trust_level == agent_identity.trust_level
        assert restored.principal_identity.capabilities == agent_identity.capabilities
    
    def test_integration_with_audit_reference(self):
        """
        Test integration with AuditReference.
        
        **Validates: Requirements 19.3**
        """
        # Create audit reference with enhanced fields
        audit_reference = AuditReference(
            audit_id="audit-456",
            location="s3://bucket/audit-456.json",
            hash="abc123def456",
            hash_algorithm="SHA3-256",
            previous_hash="xyz789",
            signature="audit-signature",
            signer_id="signer-123",
            entry_count=25
        )
        
        # Create authority metadata with audit reference
        metadata = AuthorityMetadata(
            audit_reference=audit_reference,
            mandate_id="mandate-789"
        )
        
        # Verify integration
        assert metadata.audit_reference == audit_reference
        assert metadata.audit_reference.audit_id == "audit-456"
        assert metadata.audit_reference.hash_algorithm == "SHA3-256"
        assert metadata.audit_reference.entry_count == 25
        
        # Serialize and deserialize
        metadata_dict = metadata.to_dict()
        restored = AuthorityMetadata.from_dict(metadata_dict)
        
        # Verify audit reference is preserved
        assert restored.audit_reference.audit_id == audit_reference.audit_id
        assert restored.audit_reference.hash == audit_reference.hash
        assert restored.audit_reference.hash_algorithm == audit_reference.hash_algorithm
        assert restored.audit_reference.previous_hash == audit_reference.previous_hash
        assert restored.audit_reference.entry_count == audit_reference.entry_count
    
    def test_delegation_chain_handling(self):
        """
        Test delegation chain handling.
        
        **Validates: Requirements 19.1, 19.2**
        """
        # Create metadata with delegation chain
        metadata = AuthorityMetadata(
            delegation_chain=["agent-1", "agent-2", "agent-3", "agent-4"]
        )
        
        # Verify delegation chain
        assert len(metadata.delegation_chain) == 4
        assert metadata.delegation_chain[0] == "agent-1"
        assert metadata.delegation_chain[-1] == "agent-4"
        
        # Serialize and deserialize
        metadata_dict = metadata.to_dict()
        restored = AuthorityMetadata.from_dict(metadata_dict)
        
        # Verify delegation chain is preserved
        assert restored.delegation_chain == metadata.delegation_chain
    
    def test_empty_delegation_chain(self):
        """
        Test empty delegation chain (default).
        
        **Validates: Requirements 19.1**
        """
        metadata = AuthorityMetadata()
        
        # Verify empty delegation chain
        assert metadata.delegation_chain == []
        assert len(metadata.delegation_chain) == 0
    
    def test_version_field(self):
        """
        Test version field handling.
        
        **Validates: Requirements 19.1, 19.2**
        """
        # Test default version
        metadata1 = AuthorityMetadata()
        assert metadata1.version == "1.0.0"
        
        # Test custom version
        metadata2 = AuthorityMetadata(version="2.0.0")
        assert metadata2.version == "2.0.0"
        
        # Test serialization preserves version
        metadata_dict = metadata2.to_dict()
        assert metadata_dict["version"] == "2.0.0"
        
        # Test deserialization preserves version
        restored = AuthorityMetadata.from_dict(metadata_dict)
        assert restored.version == "2.0.0"
