"""
Basic test to verify AuthorityLedgerWriter and AuthorityLedgerQuery implementation.

This is a simple smoke test to ensure the classes can be instantiated and
basic operations work correctly.
"""

import sys
from datetime import datetime, timedelta
from uuid import uuid4

# Mock database session for testing
class MockSession:
    def __init__(self):
        self.events = []
        self.flushed = False
        self.rolled_back = False
    
    def add(self, event):
        self.events.append(event)
    
    def flush(self):
        self.flushed = True
        # Simulate auto-increment event_id
        for i, event in enumerate(self.events):
            if not hasattr(event, 'event_id') or event.event_id is None:
                event.event_id = i + 1
    
    def rollback(self):
        self.rolled_back = True
        self.events = []
    
    def query(self, model):
        return MockQuery(self.events)


class MockQuery:
    def __init__(self, events):
        self.events = events
        self.filters = []
        self.order = None
        self.limit_value = None
    
    def filter(self, *args):
        # Store filters but don't actually apply them for this basic test
        self.filters.extend(args)
        return self
    
    def order_by(self, *args):
        self.order = args
        return self
    
    def limit(self, value):
        self.limit_value = value
        return self
    
    def group_by(self, *args):
        return self
    
    def all(self):
        return self.events
    
    def first(self):
        return self.events[0] if self.events else None


def test_authority_ledger_writer():
    """Test AuthorityLedgerWriter basic functionality."""
    print("Testing AuthorityLedgerWriter...")
    
    from caracal.core.authority_ledger import AuthorityLedgerWriter
    
    # Create mock session
    session = MockSession()
    
    # Create writer
    writer = AuthorityLedgerWriter(db_session=session, kafka_producer=None)
    
    # Test record_issuance
    mandate_id = uuid4()
    principal_id = uuid4()
    
    event = writer.record_issuance(
        mandate_id=mandate_id,
        principal_id=principal_id,
        metadata={"test": "data"}
    )
    
    assert event is not None
    assert event.event_type == "issued"
    assert event.mandate_id == mandate_id
    assert event.principal_id == principal_id
    assert session.flushed
    print("✓ record_issuance works")
    
    # Test record_validation
    session.events = []
    session.flushed = False
    
    event = writer.record_validation(
        mandate_id=mandate_id,
        principal_id=principal_id,
        decision="allowed",
        denial_reason=None,
        requested_action="api_call",
        requested_resource="api:openai:gpt-4"
    )
    
    assert event is not None
    assert event.event_type == "validated"
    assert event.decision == "allowed"
    assert event.requested_action == "api_call"
    assert session.flushed
    print("✓ record_validation works")
    
    # Test record_validation with denial
    session.events = []
    session.flushed = False
    
    event = writer.record_validation(
        mandate_id=mandate_id,
        principal_id=principal_id,
        decision="denied",
        denial_reason="Mandate expired",
        requested_action="api_call",
        requested_resource="api:openai:gpt-4"
    )
    
    assert event is not None
    assert event.event_type == "denied"
    assert event.decision == "denied"
    assert event.denial_reason == "Mandate expired"
    assert session.flushed
    print("✓ record_validation with denial works")
    
    # Test record_revocation
    session.events = []
    session.flushed = False
    
    event = writer.record_revocation(
        mandate_id=mandate_id,
        principal_id=principal_id,
        reason="Security breach"
    )
    
    assert event is not None
    assert event.event_type == "revoked"
    assert event.denial_reason == "Security breach"
    assert session.flushed
    print("✓ record_revocation works")
    
    print("✓ All AuthorityLedgerWriter tests passed!")


def test_authority_ledger_query():
    """Test AuthorityLedgerQuery basic functionality."""
    print("\nTesting AuthorityLedgerQuery...")
    
    from caracal.core.authority_ledger import AuthorityLedgerQuery
    from caracal.db.models import AuthorityLedgerEvent
    
    # Create mock session with some events
    session = MockSession()
    
    principal_id = uuid4()
    mandate_id = uuid4()
    
    # Add some mock events
    event1 = AuthorityLedgerEvent(
        event_id=1,
        event_type="issued",
        timestamp=datetime.utcnow(),
        principal_id=principal_id,
        mandate_id=mandate_id,
        decision=None,
        denial_reason=None,
        requested_action=None,
        requested_resource=None
    )
    
    event2 = AuthorityLedgerEvent(
        event_id=2,
        event_type="validated",
        timestamp=datetime.utcnow(),
        principal_id=principal_id,
        mandate_id=mandate_id,
        decision="allowed",
        denial_reason=None,
        requested_action="api_call",
        requested_resource="api:openai:gpt-4"
    )
    
    session.events = [event1, event2]
    
    # Create query
    query = AuthorityLedgerQuery(db_session=session)
    
    # Test get_events
    events = query.get_events()
    assert len(events) == 2
    print("✓ get_events works")
    
    # Test get_events with filters
    events = query.get_events(principal_id=principal_id)
    assert len(events) == 2
    print("✓ get_events with filters works")
    
    # Test aggregate_by_principal
    start_time = datetime.utcnow() - timedelta(hours=1)
    end_time = datetime.utcnow() + timedelta(hours=1)
    
    aggregation = query.aggregate_by_principal(
        start_time=start_time,
        end_time=end_time
    )
    
    assert principal_id in aggregation
    assert aggregation[principal_id] == 2
    print("✓ aggregate_by_principal works")
    
    print("✓ All AuthorityLedgerQuery tests passed!")


if __name__ == "__main__":
    try:
        test_authority_ledger_writer()
        test_authority_ledger_query()
        print("\n✅ All tests passed!")
        sys.exit(0)
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
