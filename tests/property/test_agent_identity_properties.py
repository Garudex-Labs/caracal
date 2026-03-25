"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Property-based tests for enhanced PrincipalIdentity implementation.

These tests validate universal correctness properties that should hold
across all valid executions of the PrincipalIdentity system.
"""

from datetime import datetime
from typing import Any, Dict, List, Optional

import pytest
from hypothesis import given, strategies as st

from caracal.core.identity import PrincipalIdentity, VerificationStatus


# Strategies for generating test data
@st.composite
def valid_agent_ids(draw):
    """Generate valid non-empty agent IDs."""
    return draw(st.text(min_size=1, max_size=100).filter(lambda x: x.strip()))


@st.composite
def valid_names(draw):
    """Generate valid agent names."""
    return draw(st.text(min_size=1, max_size=100).filter(lambda x: x.strip()))


@st.composite
def valid_owners(draw):
    """Generate valid owner identifiers."""
    return draw(st.text(min_size=1, max_size=100).filter(lambda x: x.strip()))


@st.composite
def valid_metadata(draw):
    """Generate valid metadata dictionaries."""
    return draw(st.dictionaries(
        keys=st.text(min_size=1, max_size=50),
        values=st.one_of(
            st.text(max_size=100),
            st.integers(),
            st.floats(allow_nan=False, allow_infinity=False),
            st.booleans(),
            st.none()
        ),
        max_size=10
    ))


@st.composite
def valid_trust_levels(draw):
    """Generate valid trust levels (0-100)."""
    return draw(st.integers(min_value=0, max_value=100))


@st.composite
def valid_capabilities(draw):
    """Generate valid capability lists."""
    return draw(st.lists(
        st.text(min_size=1, max_size=50),
        max_size=10
    ))


@st.composite
def valid_verification_statuses(draw):
    """Generate valid verification statuses."""
    return draw(st.sampled_from([
        VerificationStatus.UNVERIFIED,
        VerificationStatus.VERIFIED,
        VerificationStatus.TRUSTED
    ]))


@st.composite
def valid_agent_identities(draw):
    """Generate valid PrincipalIdentity instances."""
    return PrincipalIdentity(
        agent_id=draw(valid_agent_ids()),
        name=draw(valid_names()),
        owner=draw(valid_owners()),
        created_at=datetime.utcnow().isoformat() + "Z",
        metadata=draw(valid_metadata()),
        public_key=draw(st.one_of(st.none(), st.text(min_size=1, max_size=500))),
        org_id=draw(st.one_of(st.none(), st.text(min_size=1, max_size=100))),
        role=draw(st.one_of(st.none(), st.text(min_size=1, max_size=100))),
        verification_status=draw(valid_verification_statuses()),
        trust_level=draw(valid_trust_levels()),
        capabilities=draw(valid_capabilities()),
        last_verified_at=draw(st.one_of(st.none(), st.just(datetime.utcnow().isoformat() + "Z")))
    )


class TestPrincipalIdentityProperties:
    """Property-based tests for PrincipalIdentity."""
    
    @given(valid_agent_identities())
    def test_property_6_serialization_round_trip(self, identity):
        """
        Property 6: PrincipalIdentity Serialization Round-Trip (with new fields)
        
        For any valid PrincipalIdentity instance, serializing it to JSON via to_dict()
        and then deserializing via from_dict() should produce an equivalent
        PrincipalIdentity with the same field values.
        
        **Validates: Requirements 4.13, 4.14, 18.2**
        """
        # Serialize to dict
        identity_dict = identity.to_dict()
        
        # Deserialize back to PrincipalIdentity
        restored_identity = PrincipalIdentity.from_dict(identity_dict)
        
        # Verify all fields match
        assert restored_identity.agent_id == identity.agent_id
        assert restored_identity.name == identity.name
        assert restored_identity.owner == identity.owner
        assert restored_identity.created_at == identity.created_at
        assert restored_identity.metadata == identity.metadata
        assert restored_identity.public_key == identity.public_key
        assert restored_identity.org_id == identity.org_id
        assert restored_identity.role == identity.role
        assert restored_identity.verification_status == identity.verification_status
        assert restored_identity.trust_level == identity.trust_level
        assert restored_identity.capabilities == identity.capabilities
        assert restored_identity.last_verified_at == identity.last_verified_at
    
    @given(st.integers().filter(lambda x: x < 0 or x > 100))
    def test_property_7_trust_level_validation(self, invalid_trust_level):
        """
        Property 7: Trust Level Validation
        
        For any PrincipalIdentity instance, when trust_level is set to a value
        outside the range 0-100, the validation should reject it with ValueError.
        
        **Validates: Requirements 4.13**
        """
        with pytest.raises(ValueError, match="trust_level must be between 0 and 100"):
            PrincipalIdentity(
                agent_id="test-agent",
                name="Test Agent",
                owner="test-owner",
                created_at=datetime.utcnow().isoformat() + "Z",
                metadata={},
                trust_level=invalid_trust_level
            )
    
    @given(
        valid_agent_ids(),
        valid_names(),
        valid_owners(),
        valid_capabilities()
    )
    def test_property_8_capability_checking(self, agent_id, name, owner, capabilities):
        """
        Property 8: Capability Checking
        
        For any PrincipalIdentity with a list of capabilities, the has_capability()
        method should return True for capabilities in the list and False for
        capabilities not in the list.
        
        **Validates: Requirements 4.14**
        """
        identity = PrincipalIdentity(
            agent_id=agent_id,
            name=name,
            owner=owner,
            created_at=datetime.utcnow().isoformat() + "Z",
            metadata={},
            capabilities=capabilities
        )
        
        # All declared capabilities should return True
        for capability in capabilities:
            assert identity.has_capability(capability)
        
        # A capability not in the list should return False
        non_existent_capability = "capability_that_does_not_exist_xyz123"
        if non_existent_capability not in capabilities:
            assert not identity.has_capability(non_existent_capability)
    
    @given(
        valid_agent_ids(),
        valid_names(),
        valid_owners(),
        valid_verification_statuses()
    )
    def test_property_verification_status_checking(self, agent_id, name, owner, verification_status):
        """
        Property: Verification Status Checking
        
        For any PrincipalIdentity, the is_verified() method should return True
        if verification_status is VERIFIED or TRUSTED, and False if UNVERIFIED.
        """
        identity = PrincipalIdentity(
            agent_id=agent_id,
            name=name,
            owner=owner,
            created_at=datetime.utcnow().isoformat() + "Z",
            metadata={},
            verification_status=verification_status
        )
        
        if verification_status in [VerificationStatus.VERIFIED, VerificationStatus.TRUSTED]:
            assert identity.is_verified()
        else:
            assert not identity.is_verified()
    
    @given(
        valid_agent_ids(),
        valid_names(),
        valid_owners()
    )
    def test_property_default_values(self, agent_id, name, owner):
        """
        Property: Default values should be set correctly
        
        For any PrincipalIdentity created with only required fields,
        optional fields should have appropriate defaults.
        """
        identity = PrincipalIdentity(
            agent_id=agent_id,
            name=name,
            owner=owner,
            created_at=datetime.utcnow().isoformat() + "Z",
            metadata={}
        )
        
        # Check default values
        assert identity.public_key is None
        assert identity.org_id is None
        assert identity.role is None
        assert identity.verification_status == VerificationStatus.UNVERIFIED
        assert identity.trust_level == 0
        assert identity.capabilities == []
        assert identity.last_verified_at is None
    
    @given(st.one_of(st.just(""), st.text(max_size=0)))
    def test_property_empty_agent_id_validation(self, empty_agent_id):
        """
        Property: Empty agent_id should be rejected
        
        For any PrincipalIdentity instance, when agent_id is set to an empty string,
        the validation should reject it with ValueError.
        """
        with pytest.raises(ValueError, match="agent_id must be non-empty string"):
            PrincipalIdentity(
                agent_id=empty_agent_id,
                name="Test Agent",
                owner="test-owner",
                created_at=datetime.utcnow().isoformat() + "Z",
                metadata={}
            )
    
    @given(
        valid_agent_ids(),
        valid_names(),
        valid_owners(),
        st.sampled_from(["unverified", "verified", "trusted"])
    )
    def test_property_verification_status_string_conversion(self, agent_id, name, owner, status_string):
        """
        Property: Verification status strings should be converted to enums
        
        For any PrincipalIdentity created with a string verification_status,
        it should be automatically converted to the appropriate enum value.
        """
        identity = PrincipalIdentity(
            agent_id=agent_id,
            name=name,
            owner=owner,
            created_at=datetime.utcnow().isoformat() + "Z",
            metadata={},
            verification_status=status_string
        )
        
        # Should be converted to enum
        assert isinstance(identity.verification_status, VerificationStatus)
        assert identity.verification_status.value == status_string
