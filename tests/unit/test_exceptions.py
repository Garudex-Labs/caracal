"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for exception hierarchy.
"""

import pytest
from caracal.exceptions import (
    CaracalError,
    IdentityError,
    AgentNotFoundError,
    DuplicateAgentNameError,
    PolicyError,
    LedgerError,
    MeteringError,
    ConfigurationError,
    StorageError,
    SDKError,
)


class TestExceptionHierarchy:
    """Test that exception hierarchy is correctly defined."""
    
    def test_base_exception(self):
        """Test that CaracalError is the base exception."""
        error = CaracalError("test error")
        assert isinstance(error, Exception)
        assert str(error) == "test error"
    
    def test_identity_errors_inherit_from_base(self):
        """Test that identity errors inherit from CaracalError."""
        assert issubclass(IdentityError, CaracalError)
        assert issubclass(AgentNotFoundError, IdentityError)
        assert issubclass(DuplicateAgentNameError, IdentityError)
    
    def test_policy_errors_inherit_from_base(self):
        """Test that policy errors inherit from CaracalError."""
        assert issubclass(PolicyError, CaracalError)
    
    def test_ledger_errors_inherit_from_base(self):
        """Test that ledger errors inherit from CaracalError."""
        assert issubclass(LedgerError, CaracalError)
    
    def test_metering_errors_inherit_from_base(self):
        """Test that metering errors inherit from CaracalError."""
        assert issubclass(MeteringError, CaracalError)
    
    def test_configuration_errors_inherit_from_base(self):
        """Test that configuration errors inherit from CaracalError."""
        assert issubclass(ConfigurationError, CaracalError)
    
    def test_storage_errors_inherit_from_base(self):
        """Test that storage errors inherit from CaracalError."""
        assert issubclass(StorageError, CaracalError)
    
    def test_sdk_errors_inherit_from_base(self):
        """Test that SDK errors inherit from CaracalError."""
        assert issubclass(SDKError, CaracalError)
    
    def test_exception_can_be_raised_and_caught(self):
        """Test that exceptions can be raised and caught."""
        with pytest.raises(PolicyError) as exc_info:
            raise PolicyError("Policy violation")
        
        assert "Policy violation" in str(exc_info.value)
        assert isinstance(exc_info.value, CaracalError)
