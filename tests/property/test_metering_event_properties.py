"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Property-based tests for enhanced MeteringEvent implementation.

These tests validate universal correctness properties that should hold
across all valid executions of the MeteringEvent system.
"""

from datetime import datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional

import pytest
from hypothesis import given, strategies as st

from caracal.core.metering import MeteringEvent
from caracal.exceptions import InvalidMeteringEventError


# Strategies for generating test data
@st.composite
def valid_principal_ids(draw):
    """Generate valid non-empty agent IDs."""
    return draw(st.text(min_size=1, max_size=100).filter(lambda x: x.strip()))


@st.composite
def valid_resource_types(draw):
    """Generate valid non-empty resource types with hierarchical patterns."""
    # Generate hierarchical resource types like "mcp.tool.search"
    parts = draw(st.lists(
        st.text(alphabet=st.characters(whitelist_categories=('Lu', 'Ll', 'Nd')), min_size=1, max_size=20),
        min_size=1,
        max_size=5
    ))
    return ".".join(parts)


@st.composite
def valid_quantities(draw):
    """Generate valid non-negative Decimal quantities."""
    # Generate positive decimals with reasonable precision
    value = draw(st.decimals(
        min_value=0,
        max_value=1000000,
        allow_nan=False,
        allow_infinity=False,
        places=2
    ))
    return value


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
def valid_tags(draw):
    """Generate valid tag lists."""
    return draw(st.lists(
        st.text(min_size=1, max_size=50),
        max_size=10
    ))


@st.composite
def valid_metering_events(draw):
    """Generate valid MeteringEvent instances."""
    return MeteringEvent(
        principal_id=draw(valid_principal_ids()),
        resource_type=draw(valid_resource_types()),
        quantity=draw(valid_quantities()),
        timestamp=draw(st.one_of(st.none(), st.datetimes())),
        metadata=draw(valid_metadata()),
        correlation_id=draw(st.one_of(st.none(), st.text(min_size=1, max_size=100))),
        source_event_id=draw(st.one_of(st.none(), st.text(min_size=1, max_size=100))),
        tags=draw(valid_tags())
    )


class TestMeteringEventProperties:
    """Property-based tests for MeteringEvent."""
    
    @given(st.one_of(st.just(""), st.text(max_size=0)))
    def test_property_1_empty_principal_id_validation(self, empty_principal_id):
        """
        Property 1: Non-empty String Field Validation (principal_id)
        
        For any MeteringEvent instance, when principal_id is set to an empty string,
        the validation should reject it with InvalidMeteringEventError.
        
        **Validates: Requirements 3.7, 3.8**
        """
        with pytest.raises(InvalidMeteringEventError, match="principal_id must be non-empty string"):
            MeteringEvent(
                principal_id=empty_principal_id,
                resource_type="test.resource",
                quantity=Decimal("1.0")
            )
    
    @given(st.one_of(st.just(""), st.text(max_size=0)))
    def test_property_1_empty_resource_type_validation(self, empty_resource_type):
        """
        Property 1: Non-empty String Field Validation (resource_type)
        
        For any MeteringEvent instance, when resource_type is set to an empty string,
        the validation should reject it with InvalidMeteringEventError.
        
        **Validates: Requirements 3.7, 3.8**
        """
        with pytest.raises(InvalidMeteringEventError, match="resource_type must be non-empty string"):
            MeteringEvent(
                principal_id="test-agent",
                resource_type=empty_resource_type,
                quantity=Decimal("1.0")
            )
    
    @given(st.decimals(
        max_value=-0.01,
        allow_nan=False,
        allow_infinity=False,
        places=2
    ))
    def test_property_2_negative_quantity_validation(self, negative_quantity):
        """
        Property 2: Non-negative Quantity Validation
        
        For any MeteringEvent instance, when the quantity field is set to a negative
        Decimal value, the validation should reject it with InvalidMeteringEventError.
        
        **Validates: Requirements 3.9**
        """
        with pytest.raises(InvalidMeteringEventError, match="quantity must be non-negative"):
            MeteringEvent(
                principal_id="test-agent",
                resource_type="test.resource",
                quantity=negative_quantity
            )
    
    @given(st.one_of(
        st.text(),
        st.integers(),
        st.floats(),
        st.booleans(),
        st.lists(st.integers())
    ))
    def test_property_3_timestamp_type_validation(self, invalid_timestamp):
        """
        Property 3: Timestamp Type Validation
        
        For any MeteringEvent instance, when the timestamp field is provided with
        a non-datetime value, the validation should reject it with InvalidMeteringEventError.
        
        **Validates: Requirements 3.10**
        """
        with pytest.raises(InvalidMeteringEventError, match="timestamp must be a datetime object"):
            MeteringEvent(
                principal_id="test-agent",
                resource_type="test.resource",
                quantity=Decimal("1.0"),
                timestamp=invalid_timestamp
            )
    
    @given(valid_metering_events())
    def test_property_4_serialization_round_trip(self, event):
        """
        Property 4: MeteringEvent Serialization Round-Trip (with new fields)
        
        For any valid MeteringEvent instance, serializing it to JSON via to_dict()
        and then deserializing via from_dict() should produce an equivalent
        MeteringEvent with the same field values.
        
        **Validates: Requirements 3.14, 18.1**
        """
        # Serialize to dict
        event_dict = event.to_dict()
        
        # Deserialize back to MeteringEvent
        restored_event = MeteringEvent.from_dict(event_dict)
        
        # Verify all fields match
        assert restored_event.principal_id == event.principal_id
        assert restored_event.resource_type == event.resource_type
        assert restored_event.quantity == event.quantity
        assert restored_event.metadata == event.metadata
        assert restored_event.correlation_id == event.correlation_id
        assert restored_event.source_event_id == event.source_event_id
        assert restored_event.tags == event.tags
        
        # Verify timestamps match (handle None case)
        if event.timestamp is not None:
            assert restored_event.timestamp is not None
            # Compare timestamps with microsecond precision
            assert abs((restored_event.timestamp - event.timestamp).total_seconds()) < 0.001
        else:
            # If original was None, restored should have auto-generated timestamp
            assert restored_event.timestamp is not None
    
    @given(
        valid_principal_ids(),
        valid_resource_types(),
        st.text(min_size=1, max_size=100)
    )
    def test_property_5_resource_pattern_matching(self, principal_id, resource_type, pattern_suffix):
        """
        Property 5: Resource Pattern Matching
        
        For any MeteringEvent with a hierarchical resource_type, the
        matches_resource_pattern() method should correctly match wildcard patterns.
        
        **Validates: Requirements 3.14**
        """
        event = MeteringEvent(
            principal_id=principal_id,
            resource_type=resource_type,
            quantity=Decimal("1.0")
        )
        
        # Exact match should always work
        assert event.matches_resource_pattern(resource_type)
        
        # Wildcard match should work
        assert event.matches_resource_pattern("*")
        
        # If resource has dots, test hierarchical patterns
        if "." in resource_type:
            parts = resource_type.split(".")
            # Pattern matching first part with wildcard should match
            pattern = parts[0] + ".*"
            assert event.matches_resource_pattern(pattern)
    
    @given(valid_metering_events())
    def test_property_auto_timestamp_generation(self, event):
        """
        Property: Auto-generated timestamps should be datetime objects
        
        For any MeteringEvent created without an explicit timestamp,
        the __post_init__ should auto-generate a valid datetime.
        """
        # All events should have a timestamp after initialization
        assert event.timestamp is not None
        assert isinstance(event.timestamp, datetime)
    
    @given(
        valid_principal_ids(),
        valid_resource_types(),
        valid_quantities()
    )
    def test_property_minimal_event_creation(self, principal_id, resource_type, quantity):
        """
        Property: Minimal events with only required fields should be valid
        
        For any valid principal_id, resource_type, and quantity, creating a
        MeteringEvent with only these fields should succeed.
        """
        event = MeteringEvent(
            principal_id=principal_id,
            resource_type=resource_type,
            quantity=quantity
        )
        
        # Should have auto-generated timestamp
        assert event.timestamp is not None
        
        # Should have default empty collections
        assert event.metadata == {}
        assert event.tags == []
        
        # Optional fields should be None
        assert event.correlation_id is None
        assert event.source_event_id is None
