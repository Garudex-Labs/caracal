import sys

from datetime import datetime
from decimal import Decimal
import os

sys.path.insert(0, "/home/raw/Documents/workspace/caracalEcosystem/Caracal")

def test_ase_integration():
    try:
        from ase.protocol import MeteringEvent
        print("SUCCESS: Imported MeteringEvent from ase.protocol")
    except ImportError as e:
        print(f"FAILURE: Could not import MeteringEvent from ase.protocol: {e}")
        sys.exit(1)

    from caracal.core.metering import MeteringEvent as CaracalMeteringEvent

    if MeteringEvent is not CaracalMeteringEvent:
        print("FAILURE: Caracal does not use ase.protocol.MeteringEvent")
        sys.exit(1)

    # Verify instantiation
    try:
        event = MeteringEvent(
            agent_id="agent-123",
            resource_type="token",
            quantity=Decimal("100"),
            timestamp=datetime.utcnow()
        )
        print("SUCCESS: Instantiated MeteringEvent")
        print(event.model_dump_json())
    except Exception as e:
        print(f"FAILURE: Could not instantiate MeteringEvent: {e}")
        sys.exit(1)

if __name__ == "__main__":
    test_ase_integration()
