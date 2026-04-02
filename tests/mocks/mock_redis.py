"""Mock Redis implementations for testing."""
from typing import Dict, Any, Optional
from datetime import datetime, timedelta


class MockRedis:
    """Mock Redis client for testing."""
    
    def __init__(self):
        """Initialize mock Redis."""
        self._data: Dict[str, Any] = {}
        self._expiry: Dict[str, datetime] = {}
        self._connected = False
    
    def connect(self):
        """Mock Redis connection."""
        self._connected = True
    
    def disconnect(self):
        """Mock Redis disconnection."""
        self._connected = False
    
    def is_connected(self) -> bool:
        """Check if connected."""
        return self._connected
    
    def set(self, key: str, value: Any, ex: Optional[int] = None) -> bool:
        """Mock set operation."""
        self._data[key] = value
        if ex:
            self._expiry[key] = datetime.utcnow() + timedelta(seconds=ex)
        return True
    
    def get(self, key: str) -> Optional[Any]:
        """Mock get operation."""
        if key in self._expiry and datetime.utcnow() > self._expiry[key]:
            del self._data[key]
            del self._expiry[key]
            return None
        return self._data.get(key)
    
    def delete(self, key: str) -> int:
        """Mock delete operation."""
        if key in self._data:
            del self._data[key]
            if key in self._expiry:
                del self._expiry[key]
            return 1
        return 0

    def exists(self, key: str) -> bool:
        """Mock exists operation."""
        return key in self._data
    
    def ttl(self, key: str) -> int:
        """Mock TTL operation."""
        if key not in self._expiry:
            return -1
        remaining = (self._expiry[key] - datetime.utcnow()).total_seconds()
        return int(remaining) if remaining > 0 else -2
    
    def keys(self, pattern: str = "*") -> list:
        """Mock keys operation."""
        return list(self._data.keys())
    
    def flushdb(self):
        """Mock flush database."""
        self._data.clear()
        self._expiry.clear()
    
    def cleanup(self):
        """Clean up mock Redis."""
        self.flushdb()
        self._connected = False
