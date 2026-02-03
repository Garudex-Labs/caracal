"""
Verification script for DLQ implementation.

Tests basic DLQ functionality without requiring Kafka infrastructure.
"""

import json
from datetime import datetime

# Test DLQEvent class
print("Testing DLQEvent class...")

from caracal.kafka.dlq import DLQEvent

# Create a DLQ event
event = DLQEvent(
    dlq_id="test-dlq-id-123",
    original_topic="caracal.metering.events",
    original_partition=0,
    original_offset=456,
    original_key="test-key",
    original_value='{"event": "test"}',
    error_type="ValueError",
    error_message="Test error message",
    retry_count=3,
    failure_timestamp=datetime.utcnow().isoformat(),
    consumer_group="test-consumer-group",
)

print(f"✓ Created DLQ event: {event.dlq_id}")

# Test to_dict
event_dict = event.to_dict()
assert event_dict["dlq_id"] == "test-dlq-id-123"
assert event_dict["original_topic"] == "caracal.metering.events"
assert event_dict["error_type"] == "ValueError"
assert event_dict["retry_count"] == 3
print("✓ DLQEvent.to_dict() works correctly")

# Test from_dict
restored_event = DLQEvent.from_dict(event_dict)
assert restored_event.dlq_id == event.dlq_id
assert restored_event.original_topic == event.original_topic
assert restored_event.error_type == event.error_type
print("✓ DLQEvent.from_dict() works correctly")

# Test JSON serialization
json_str = json.dumps(event_dict)
parsed_dict = json.loads(json_str)
final_event = DLQEvent.from_dict(parsed_dict)
assert final_event.dlq_id == event.dlq_id
print("✓ DLQ event JSON serialization works correctly")

print("\n" + "="*60)
print("DLQ Implementation Verification: PASSED")
print("="*60)
print("\nAll DLQ components are working correctly:")
print("  ✓ DLQEvent data class")
print("  ✓ Event serialization (to_dict/from_dict)")
print("  ✓ JSON round-trip")
print("\nNote: DLQHandler and DLQMonitorConsumer require Kafka infrastructure")
print("      and are tested separately in integration tests.")
