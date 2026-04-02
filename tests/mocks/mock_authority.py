"""Mock authority implementations for testing."""
from typing import Dict, Any, Optional, List
from datetime import datetime
import uuid


class MockAuthority:
    """Mock Authority class for testing."""
    
    def __init__(self, **kwargs):
        """Initialize mock authority."""
        self.id = kwargs.get("id", str(uuid.uuid4()))
        self.name = kwargs.get("name", "mock-authority")
        self.scope = kwargs.get("scope", "read:secrets")
        self.description = kwargs.get("description", "Mock authority")
        self.created_at = kwargs.get("created_at", datetime.utcnow())
        self.metadata = kwargs.get("metadata", {})
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "id": self.id,
            "name": self.name,
            "scope": self.scope,
            "description": self.description,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "metadata": self.metadata,
        }


class MockAuthorityClient:
    """Mock Authority client for testing."""
    
    def __init__(self):
        """Initialize mock client."""
        self._authorities: Dict[str, MockAuthority] = {}
        self._call_count = 0
    
    def create(self, data: Dict[str, Any]) -> MockAuthority:
        """Mock create authority."""
        self._call_count += 1
        authority = MockAuthority(**data)
        self._authorities[authority.id] = authority
        return authority
    
    def get(self, authority_id: str) -> Optional[MockAuthority]:
        """Mock get authority."""
        self._call_count += 1
        return self._authorities.get(authority_id)
    
    def list(self) -> List[MockAuthority]:
        """Mock list authorities."""
        self._call_count += 1
        return list(self._authorities.values())
    
    def update(self, authority_id: str, data: Dict[str, Any]) -> Optional[MockAuthority]:
        """Mock update authority."""
        self._call_count += 1
        authority = self._authorities.get(authority_id)
        if authority:
            for key, value in data.items():
                setattr(authority, key, value)
        return authority
    
    def delete(self, authority_id: str) -> bool:
        """Mock delete authority."""
        self._call_count += 1
        if authority_id in self._authorities:
            del self._authorities[authority_id]
            return True
        return False
    
    def reset(self):
        """Reset mock state."""
        self._authorities.clear()
        self._call_count = 0
    
    @property
    def call_count(self) -> int:
        """Get number of calls made."""
        return self._call_count
