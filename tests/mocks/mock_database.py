"""Mock database implementations for testing."""
from typing import Dict, Any, List, Optional
from datetime import datetime


class MockDatabase:
    """Mock database for testing."""
    
    def __init__(self):
        """Initialize mock database."""
        self._data: Dict[str, Dict[str, Any]] = {}
        self._transactions = []
        self._connected = False
    
    def connect(self):
        """Mock database connection."""
        self._connected = True
    
    def disconnect(self):
        """Mock database disconnection."""
        self._connected = False
    
    def is_connected(self) -> bool:
        """Check if connected."""
        return self._connected
    
    def insert(self, table: str, data: Dict[str, Any]) -> str:
        """Mock insert operation."""
        if table not in self._data:
            self._data[table] = {}
        
        record_id = data.get("id", str(len(self._data[table]) + 1))
        self._data[table][record_id] = {**data, "id": record_id}
        return record_id
    
    def select(self, table: str, record_id: str) -> Optional[Dict[str, Any]]:
        """Mock select operation."""
        return self._data.get(table, {}).get(record_id)
    
    def select_all(self, table: str) -> List[Dict[str, Any]]:
        """Mock select all operation."""
        return list(self._data.get(table, {}).values())

    def update(self, table: str, record_id: str, data: Dict[str, Any]) -> bool:
        """Mock update operation."""
        if table in self._data and record_id in self._data[table]:
            self._data[table][record_id].update(data)
            return True
        return False
    
    def delete(self, table: str, record_id: str) -> bool:
        """Mock delete operation."""
        if table in self._data and record_id in self._data[table]:
            del self._data[table][record_id]
            return True
        return False
    
    def begin_transaction(self):
        """Mock begin transaction."""
        self._transactions.append({"started_at": datetime.utcnow()})
    
    def commit(self):
        """Mock commit transaction."""
        if self._transactions:
            self._transactions[-1]["committed_at"] = datetime.utcnow()
    
    def rollback(self):
        """Mock rollback transaction."""
        if self._transactions:
            self._transactions[-1]["rolled_back_at"] = datetime.utcnow()
    
    def cleanup(self):
        """Clean up mock database."""
        self._data.clear()
        self._transactions.clear()
        self._connected = False
