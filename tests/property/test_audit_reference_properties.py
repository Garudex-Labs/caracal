"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Property-based tests for enhanced AuditReference implementation.

These tests validate universal correctness properties that should hold
across all valid executions of the AuditReference system.
"""

import hashlib
from datetime import datetime
from typing import Any, Dict, Optional

import pytest
from hypothesis import given, strategies as st

from caracal.core.audit import AuditReference


# Strategies for generating test data
@st.composite
def valid_audit_ids(draw):
    """Generate valid non-empty audit IDs."""
    return draw(st.text(min_size=1, max_size=100).filter(lambda x: x.strip()))


@st.composite
def valid_hashes(draw):
    """Generate valid hash strings (hex format)."""
    # Generate random bytes and convert to hex
    length = draw(st.integers(min_value=32, max_value=64))
    return draw(st.binary(min_size=length, max_size=length)).hex()


@st.composite
def valid_hash_algorithms(draw):
    """Generate valid hash algorithm names."""
    return draw(st.sampled_from(["SHA-256", "SHA3-256"]))


@st.composite
def valid_audit_references(draw):
    """Generate valid AuditReference instances."""
    return AuditReference(
        audit_id=draw(valid_audit_ids()),
        location=draw(st.one_of(st.none(), st.text(min_size=1, max_size=200))),
        hash=draw(valid_hashes()),
        hash_algorithm=draw(valid_hash_algorithms()),
        previous_hash=draw(st.one_of(st.none(), valid_hashes())),
        signature=draw(st.one_of(st.none(), st.text(min_size=1, max_size=500))),
        signer_id=draw(st.one_of(st.none(), st.text(min_size=1, max_size=100))),
        timestamp=draw(st.one_of(st.none(), st.datetimes())),
        entry_count=draw(st.integers(min_value=0, max_value=10000))
    )


class TestAuditReferenceProperties:
    """Property-based tests for AuditReference."""
    
    @given(valid_audit_references())
    def test_property_9_serialization_round_trip(self, audit_ref):
        """
        Property 9: AuditReference Serialization Round-Trip (with new fields)
        
        For any valid AuditReference instance, serializing it to JSON via to_dict()
        and then deserializing via from_dict() should produce an equivalent
        AuditReference with the same field values.
        
        **Validates: Requirements 5.13, 5.14, 18.3**
        """
        # Serialize to dict
        audit_dict = audit_ref.to_dict()
        
        # Deserialize back to AuditReference
        restored_ref = AuditReference.from_dict(audit_dict)
        
        # Verify all fields match
        assert restored_ref.audit_id == audit_ref.audit_id
        assert restored_ref.location == audit_ref.location
        assert restored_ref.hash == audit_ref.hash
        assert restored_ref.hash_algorithm == audit_ref.hash_algorithm
        assert restored_ref.previous_hash == audit_ref.previous_hash
        assert restored_ref.signature == audit_ref.signature
        assert restored_ref.signer_id == audit_ref.signer_id
        assert restored_ref.entry_count == audit_ref.entry_count
        
        # Verify timestamps match (handle None case)
        if audit_ref.timestamp is not None:
            assert restored_ref.timestamp is not None
            # Compare timestamps with microsecond precision
            assert abs((restored_ref.timestamp - audit_ref.timestamp).total_seconds()) < 0.001
        else:
            # If original was None, restored should have auto-generated timestamp
            assert restored_ref.timestamp is not None
    
    @given(
        valid_audit_ids(),
        st.binary(min_size=1, max_size=1000),
        valid_hash_algorithms()
    )
    def test_property_10_hash_verification(self, audit_id, content, hash_algorithm):
        """
        Property 10: Hash Verification
        
        For any AuditReference with a computed hash, the verify_hash() method
        should return True when given the original content and False when given
        different content.
        
        **Validates: Requirements 5.13**
        """
        # Compute hash based on algorithm
        if hash_algorithm == "SHA-256":
            computed_hash = hashlib.sha256(content).hexdigest()
        elif hash_algorithm == "SHA3-256":
            computed_hash = hashlib.sha3_256(content).hexdigest()
        
        # Create audit reference with computed hash
        audit_ref = AuditReference(
            audit_id=audit_id,
            hash=computed_hash,
            hash_algorithm=hash_algorithm
        )
        
        # Verify with original content should succeed
        assert audit_ref.verify_hash(content)
        
        # Verify with different content should fail (if content is not empty)
        if len(content) > 0:
            different_content = content + b"x"
            assert not audit_ref.verify_hash(different_content)
    
    @given(
        valid_audit_ids(),
        valid_audit_ids(),
        valid_hashes(),
        valid_hash_algorithms()
    )
    def test_property_11_chain_verification(self, audit_id1, audit_id2, hash_value, hash_algorithm):
        """
        Property 11: Chain Verification
        
        For any two AuditReferences forming a chain, the verify_chain() method
        should return True if the second reference's previous_hash matches the
        first reference's hash.
        
        **Validates: Requirements 5.14**
        """
        # Create first audit reference
        first_ref = AuditReference(
            audit_id=audit_id1,
            hash=hash_value,
            hash_algorithm=hash_algorithm
        )
        
        # Create second audit reference with matching previous_hash
        second_ref = AuditReference(
            audit_id=audit_id2,
            hash=hash_value + "abc",  # Different hash
            hash_algorithm=hash_algorithm,
            previous_hash=hash_value  # Matches first_ref.hash
        )
        
        # Chain verification should succeed
        assert second_ref.verify_chain(first_ref)
        
        # Create third audit reference with non-matching previous_hash
        third_ref = AuditReference(
            audit_id=audit_id2,
            hash=hash_value + "def",
            hash_algorithm=hash_algorithm,
            previous_hash=hash_value + "xyz"  # Does NOT match first_ref.hash
        )
        
        # Chain verification should fail
        assert not third_ref.verify_chain(first_ref)
    
    @given(valid_audit_ids())
    def test_property_first_in_chain_verification(self, audit_id):
        """
        Property: First audit reference in chain should always verify
        
        For any AuditReference with previous_hash=None (first in chain),
        verify_chain() should return True regardless of the previous reference.
        """
        # Create first audit reference (no previous_hash)
        first_ref = AuditReference(
            audit_id=audit_id,
            hash="somehash123",
            previous_hash=None  # First in chain
        )
        
        # Create a dummy previous reference
        dummy_prev = AuditReference(
            audit_id="dummy",
            hash="differenthash456"
        )
        
        # First in chain should always verify
        assert first_ref.verify_chain(dummy_prev)
    
    @given(st.one_of(st.just(""), st.text(max_size=0)))
    def test_property_empty_audit_id_validation(self, empty_audit_id):
        """
        Property: Empty audit_id should be rejected
        
        For any AuditReference instance, when audit_id is set to an empty string,
        the validation should reject it with ValueError.
        """
        with pytest.raises(ValueError, match="audit_id must be non-empty string"):
            AuditReference(
                audit_id=empty_audit_id,
                hash="somehash"
            )
    
    @given(valid_audit_ids())
    def test_property_auto_timestamp_generation(self, audit_id):
        """
        Property: Auto-generated timestamps should be datetime objects
        
        For any AuditReference created without an explicit timestamp,
        the __post_init__ should auto-generate a valid datetime.
        """
        audit_ref = AuditReference(
            audit_id=audit_id,
            hash="somehash"
        )
        
        # Should have auto-generated timestamp
        assert audit_ref.timestamp is not None
        assert isinstance(audit_ref.timestamp, datetime)
    
    @given(
        valid_audit_ids(),
        st.text(min_size=1, max_size=100)
    )
    def test_property_unsupported_hash_algorithm(self, audit_id, unsupported_algorithm):
        """
        Property: Unsupported hash algorithms should raise ValueError
        
        For any AuditReference with an unsupported hash_algorithm,
        verify_hash() should raise ValueError.
        """
        # Filter out supported algorithms
        if unsupported_algorithm in ["SHA-256", "SHA3-256"]:
            return
        
        audit_ref = AuditReference(
            audit_id=audit_id,
            hash="somehash",
            hash_algorithm=unsupported_algorithm
        )
        
        with pytest.raises(ValueError, match="Unsupported hash algorithm"):
            audit_ref.verify_hash(b"some content")
    
    @given(
        valid_audit_ids(),
        st.integers(min_value=0, max_value=1000000)
    )
    def test_property_entry_count_non_negative(self, audit_id, entry_count):
        """
        Property: Entry count should be non-negative
        
        For any AuditReference, the entry_count field should accept
        non-negative integers.
        """
        audit_ref = AuditReference(
            audit_id=audit_id,
            hash="somehash",
            entry_count=entry_count
        )
        
        assert audit_ref.entry_count >= 0
        assert audit_ref.entry_count == entry_count
