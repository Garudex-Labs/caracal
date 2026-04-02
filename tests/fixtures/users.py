"""User and principal test fixtures."""
import pytest
from typing import Dict, Any
import uuid


@pytest.fixture
def test_user() -> Dict[str, Any]:
    """Provide a test user/principal."""
    return {
        "id": str(uuid.uuid4()),
        "username": "testuser",
        "email": "testuser@example.com",
        "role": "user",
        "active": True,
    }


@pytest.fixture
def admin_user() -> Dict[str, Any]:
    """Provide an admin user/principal."""
    return {
        "id": str(uuid.uuid4()),
        "username": "adminuser",
        "email": "admin@example.com",
        "role": "admin",
        "active": True,
        "permissions": ["read:all", "write:all", "admin:all"],
    }


@pytest.fixture
def service_principal() -> Dict[str, Any]:
    """Provide a service principal."""
    return {
        "id": str(uuid.uuid4()),
        "name": "test-service",
        "type": "service",
        "api_key": "sk_test_" + secrets.token_urlsafe(32),
        "scopes": ["read:secrets", "write:secrets"],
        "active": True,
    }


@pytest.fixture
def multiple_users() -> list[Dict[str, Any]]:
    """Provide multiple test users."""
    return [
        {
            "id": str(uuid.uuid4()),
            "username": f"user{i}",
            "email": f"user{i}@example.com",
            "role": "user" if i % 3 != 0 else "admin",
            "active": i % 5 != 0,
        }
        for i in range(10)
    ]


@pytest.fixture
def user_with_mandates() -> Dict[str, Any]:
    """Provide a user with associated mandates."""
    user_id = str(uuid.uuid4())
    return {
        "user": {
            "id": user_id,
            "username": "mandateuser",
            "email": "mandateuser@example.com",
            "role": "user",
            "active": True,
        },
        "mandates": [
            {
                "id": str(uuid.uuid4()),
                "principal_id": user_id,
                "scope": "read:secrets",
                "active": True,
            },
            {
                "id": str(uuid.uuid4()),
                "principal_id": user_id,
                "scope": "write:secrets",
                "active": True,
            },
        ],
    }


# Import secrets for service_principal fixture
import secrets
