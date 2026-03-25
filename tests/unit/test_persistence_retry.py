"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Integration tests for retry logic in persistence components.
"""

import os
import pytest
import tempfile
from pathlib import Path
from decimal import Decimal
from unittest.mock import patch, MagicMock

from caracal.core.identity import PrincipalRegistry
from caracal.core.ledger import LedgerWriter
from caracal.exceptions import FileWriteError


class TestPrincipalRegistryRetry:
    """Tests for retry logic in PrincipalRegistry."""
    
    def test_principal_registry_persist_with_transient_failure(self):
        """Test that PrincipalRegistry retries on transient write failures."""
        with tempfile.TemporaryDirectory() as tmpdir:
            registry_path = Path(tmpdir) / "agents.json"
            registry = PrincipalRegistry(str(registry_path))
            
            # Mock open to fail twice then succeed
            call_count = 0
            original_open = open
            
            def mock_open(*args, **kwargs):
                nonlocal call_count
                call_count += 1
                # Convert Path to string for comparison
                path_str = str(args[0]) if hasattr(args[0], '__fspath__') else args[0]
                if call_count <= 2 and path_str.endswith('.tmp'):
                    raise OSError("Simulated transient failure")
                return original_open(*args, **kwargs)
            
            with patch('builtins.open', side_effect=mock_open):
                # This should succeed after retries
                agent = registry.register_principal("test-agent", "owner@example.com")
                
                assert agent.name == "test-agent"
                assert call_count >= 3  # At least 3 attempts (2 failures + 1 success)
    
    def test_principal_registry_persist_permanent_failure(self):
        """Test that PrincipalRegistry fails after max retries."""
        with tempfile.TemporaryDirectory() as tmpdir:
            registry_path = Path(tmpdir) / "agents.json"
            registry = PrincipalRegistry(str(registry_path))
            
            # Mock open to always fail
            def mock_open(*args, **kwargs):
                # Convert Path to string for comparison
                path_str = str(args[0]) if hasattr(args[0], '__fspath__') else args[0]
                if path_str.endswith('.tmp'):
                    raise OSError("Permanent failure")
                return open(*args, **kwargs)
            
            with patch('builtins.open', side_effect=mock_open):
                # This should fail after max retries
                with pytest.raises(FileWriteError):
                    registry.register_principal("test-agent", "owner@example.com")


