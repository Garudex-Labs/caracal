"""Delegation test fixtures."""
import pytest
from datetime import datetime, timedelta
from typing import Dict, Any
import uuid


@pytest.fixture
def valid_delegation_data() -> Dict[str, Any]:
    """Provide valid delegation data for testing."""
    return {
        "delegator_id": str(uuid.uuid4()),
        "delegatee_id": str(uuid.uuid4()),
        "mandate_id": str(uuid.uuid4()),
        "scope": "read:secrets",
        "created_at": datetime.utcnow(),
        "expires_at": datetime.utcnow() + timedelta(hours=12),
    }


@pytest.fixture
def delegation_chain() -> list[Dict[str, Any]]:
    """Provide a chain of delegations for testing."""
    base_time = datetime.utcnow()
    mandate_id = str(uuid.uuid4())
    
    # Create a chain: user-1 -> user-2 -> user-3
    return [
        {
            "delegator_id": "user-1",
            "delegatee_id": "user-2",
            "mandate_id": mandate_id,
            "scope": "read:secrets",
            "depth": 0,
            "created_at": base_time,
            "expires_at": base_time + timedelta(hours=24),
        },
        {
            "delegator_id": "user-2",
            "delegatee_id": "user-3",
            "mandate_id": mandate_id,
            "scope": "read:secrets",
            "depth": 1,
            "created_at": base_time + timedelta(minutes=30),
            "expires_at": base_time + timedelta(hours=12),
        },
    ]


@pytest.fixture
def delegation_with_constraints() -> Dict[str, Any]:
    """Provide delegation data with constraints."""
    return {
        "delegator_id": str(uuid.uuid4()),
        "delegatee_id": str(uuid.uuid4()),
        "mandate_id": str(uuid.uuid4()),
        "scope": "write:secrets",
        "constraints": {
            "max_depth": 2,
            "no_further_delegation": False,
            "allowed_scopes": ["read:secrets", "write:secrets"],
        },
        "created_at": datetime.utcnow(),
        "expires_at": datetime.utcnow() + timedelta(hours=6),
    }


@pytest.fixture
def revoked_delegation_data() -> Dict[str, Any]:
    """Provide revoked delegation data for testing."""
    return {
        "delegator_id": str(uuid.uuid4()),
        "delegatee_id": str(uuid.uuid4()),
        "mandate_id": str(uuid.uuid4()),
        "scope": "admin:all",
        "status": "revoked",
        "revoked_at": datetime.utcnow() - timedelta(hours=1),
        "revoked_by": "admin-user",
        "created_at": datetime.utcnow() - timedelta(days=2),
        "expires_at": datetime.utcnow() + timedelta(days=5),
    }
