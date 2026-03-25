"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Integration tests for Enterprise Gateway metering with native MeteringEvent.

Tests the integration between the Enterprise Gateway proxy and the native
Caracal MeteringEvent implementation.
"""

import json
from decimal import Decimal
from datetime import datetime
from pathlib import Path
from unittest.mock import Mock, AsyncMock, patch

import pytest
import httpx
from fastapi import Request
from fastapi.responses import Response

# Import from caracalEnterprise
import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / "caracalEnterprise" / "services"))

from gateway.proxy import GatewayProxy, GatewayConfig

# Import from Caracal
from caracal.core.metering import MeteringCollector, MeteringEvent
from caracal.core.ledger import LedgerWriter


class TestEnterpriseGatewayMetering:
    """Integration tests for Enterprise Gateway metering with native types."""
    
    @pytest.fixture
    def temp_ledger(self, temp_dir):
        """Create a temporary ledger for testing."""
        ledger_path = temp_dir / "gateway_ledger.jsonl"
        return str(ledger_path)
    
    @pytest.fixture
    def metering_collector(self, temp_ledger):
        """Create a MeteringCollector with temporary ledger."""
        ledger_writer = LedgerWriter(temp_ledger)
        return MeteringCollector(ledger_writer)
    
    @pytest.fixture
    def gateway_config(self):
        """Create a basic gateway configuration."""
        return GatewayConfig(
            listen_address="0.0.0.0:8443",
            request_timeout_seconds=30,
            enable_provider_registry=False,
            enable_revocation_sync=False,
            enable_quota_enforcement=False,
            enable_secret_binding=False,
            fail_closed=False  # Fail open for testing
        )
    
    @pytest.fixture
    def gateway_proxy(self, gateway_config, metering_collector):
        """Create a GatewayProxy instance for testing."""
        return GatewayProxy(
            config=gateway_config,
            metering_collector=metering_collector,
            db_connection_manager=None
        )
    
    @pytest.mark.asyncio
    async def test_gateway_creates_native_metering_event(
        self, gateway_proxy, temp_ledger
    ):
        """Test that gateway creates native MeteringEvent correctly."""
        # Mock the HTTP client to return a successful response
        mock_response = httpx.Response(
            status_code=200,
            headers={"content-type": "application/json"},
            content=b'{"result": "success"}',
            request=Mock()
        )
        
        with patch.object(gateway_proxy.http_client, 'stream') as mock_stream:
            # Setup async context manager mock
            mock_stream_context = AsyncMock()
            mock_stream_context.__aenter__.return_value = mock_response
            mock_stream_context.__aexit__.return_value = None
            
            # Create async iterator for aiter_bytes
            async def async_iter():
                yield b'{"result": "success"}'
            
            mock_response.aiter_bytes = async_iter
            mock_stream.return_value = mock_stream_context
            
            # Create a mock request
            mock_request = Mock(spec=Request)
            mock_request.method = "POST"
            mock_request.headers = {
                "X-Caracal-Agent-ID": "test-agent-123",
                "X-Caracal-Target-URL": "https://api.example.com/test",
                "X-Caracal-Resource-Type": "api_call",
                "X-Caracal-Mandate-ID": "mandate-456"
            }
            mock_request.body = AsyncMock(return_value=b'{"query": "test"}')
            mock_request.state = Mock()
            
            # Handle the request
            response = await gateway_proxy._handle_request(mock_request, "/test")
            
            # Verify response
            assert response.status_code == 200
            
            # Verify metering event was written to ledger
            with open(temp_ledger, 'r') as f:
                line = f.readline()
                ledger_event = json.loads(line)
            
            # Verify event structure
            assert ledger_event["agent_id"] == "test-agent-123"
            assert ledger_event["resource_type"] == "api_call"
            assert ledger_event["quantity"] == "1"
            
            # Verify metadata
            metadata = ledger_event["metadata"]
            assert metadata["method"] == "POST"
            assert metadata["path"] == "/test"
            assert metadata["target_url"] == "https://api.example.com/test"
            assert metadata["status_code"] == "200"
            assert metadata["mandate_id"] == "mandate-456"
    
    @pytest.mark.asyncio
    async def test_gateway_metering_with_different_resource_types(
        self, gateway_proxy, temp_ledger
    ):
        """Test gateway metering with different resource types."""
        mock_response = httpx.Response(
            status_code=200,
            headers={"content-type": "application/json"},
            content=b'{"result": "success"}',
            request=Mock()
        )
        
        resource_types = ["mcp.tool.search", "mcp.tool.analyze", "api_call"]
        
        for resource_type in resource_types:
            with patch.object(gateway_proxy.http_client, 'stream') as mock_stream:
                mock_stream_context = AsyncMock()
                mock_stream_context.__aenter__.return_value = mock_response
                mock_stream_context.__aexit__.return_value = None
                
                # Create async iterator for aiter_bytes
                async def async_iter():
                    yield b'{"result": "success"}'
                
                mock_response.aiter_bytes = async_iter
                mock_stream.return_value = mock_stream_context
                
                mock_request = Mock(spec=Request)
                mock_request.method = "GET"
                mock_request.headers = {
                    "X-Caracal-Agent-ID": f"agent-{resource_type}",
                    "X-Caracal-Target-URL": "https://api.example.com/test",
                    "X-Caracal-Resource-Type": resource_type
                }
                mock_request.body = AsyncMock(return_value=b'')
                mock_request.state = Mock()
                
                await gateway_proxy._handle_request(mock_request, "/test")
        
        # Verify all events were written
        with open(temp_ledger, 'r') as f:
            lines = f.readlines()
        
        assert len(lines) == len(resource_types)
        
        for i, resource_type in enumerate(resource_types):
            ledger_event = json.loads(lines[i])
            assert ledger_event["resource_type"] == resource_type
            assert ledger_event["agent_id"] == f"agent-{resource_type}"
    
    @pytest.mark.asyncio
    async def test_gateway_metering_metadata_collection(
        self, gateway_proxy, temp_ledger
    ):
        """Test that gateway collects comprehensive metadata."""
        mock_response = httpx.Response(
            status_code=201,
            headers={"content-type": "application/json"},
            content=b'{"id": "12345", "status": "created"}',
            request=Mock()
        )
        
        with patch.object(gateway_proxy.http_client, 'stream') as mock_stream:
            mock_stream_context = AsyncMock()
            mock_stream_context.__aenter__.return_value = mock_response
            mock_stream_context.__aexit__.return_value = None
            
            # Create async iterator for aiter_bytes
            async def async_iter():
                yield b'{"id": "12345", "status": "created"}'
            
            mock_response.aiter_bytes = async_iter
            mock_stream.return_value = mock_stream_context
            
            mock_request = Mock(spec=Request)
            mock_request.method = "PUT"
            mock_request.headers = {
                "X-Caracal-Agent-ID": "metadata-test-agent",
                "X-Caracal-Target-URL": "https://api.example.com/resource/123",
                "X-Caracal-Resource-Type": "resource.update",
                "X-Caracal-Mandate-ID": "mandate-789"
            }
            mock_request.body = AsyncMock(return_value=b'{"data": "test"}')
            mock_request.state = Mock()
            
            response = await gateway_proxy._handle_request(
                mock_request, "/resource/123"
            )
            
            assert response.status_code == 201
            
            # Verify metadata is comprehensive
            with open(temp_ledger, 'r') as f:
                line = f.readline()
                ledger_event = json.loads(line)
            
            metadata = ledger_event["metadata"]
            assert metadata["method"] == "PUT"
            assert metadata["path"] == "/resource/123"
            assert metadata["target_url"] == "https://api.example.com/resource/123"
            assert metadata["status_code"] == "201"
            assert metadata["mandate_id"] == "mandate-789"
            assert "response_size_bytes" in metadata
            assert int(metadata["response_size_bytes"]) > 0
    
    @pytest.mark.asyncio
    async def test_gateway_metering_without_mandate_id(
        self, gateway_proxy, temp_ledger
    ):
        """Test gateway metering when mandate_id is not provided."""
        mock_response = httpx.Response(
            status_code=200,
            headers={"content-type": "application/json"},
            content=b'{"result": "success"}',
            request=Mock()
        )
        
        with patch.object(gateway_proxy.http_client, 'stream') as mock_stream:
            mock_stream_context = AsyncMock()
            mock_stream_context.__aenter__.return_value = mock_response
            mock_stream_context.__aexit__.return_value = None
            
            # Create async iterator for aiter_bytes
            async def async_iter():
                yield b'{"result": "success"}'
            
            mock_response.aiter_bytes = async_iter
            mock_stream.return_value = mock_stream_context
            
            mock_request = Mock(spec=Request)
            mock_request.method = "GET"
            mock_request.headers = {
                "X-Caracal-Agent-ID": "no-mandate-agent",
                "X-Caracal-Target-URL": "https://api.example.com/test"
                # No X-Caracal-Mandate-ID header
            }
            mock_request.body = AsyncMock(return_value=b'')
            mock_request.state = Mock()
            
            await gateway_proxy._handle_request(mock_request, "/test")
            
            # Verify event was still created with "none" as mandate_id
            with open(temp_ledger, 'r') as f:
                line = f.readline()
                ledger_event = json.loads(line)
            
            assert ledger_event["metadata"]["mandate_id"] == "none"
    
    @pytest.mark.asyncio
    async def test_gateway_metering_continues_on_error(
        self, gateway_proxy, temp_ledger
    ):
        """Test that gateway continues even if metering fails."""
        mock_response = httpx.Response(
            status_code=200,
            headers={"content-type": "application/json"},
            content=b'{"result": "success"}',
            request=Mock()
        )
        
        with patch.object(gateway_proxy.http_client, 'stream') as mock_stream:
            mock_stream_context = AsyncMock()
            mock_stream_context.__aenter__.return_value = mock_response
            mock_stream_context.__aexit__.return_value = None
            
            # Create async iterator for aiter_bytes
            async def async_iter():
                yield b'{"result": "success"}'
            
            mock_response.aiter_bytes = async_iter
            mock_stream.return_value = mock_stream_context
            
            # Mock metering collector to raise an exception
            with patch.object(
                gateway_proxy.metering_collector,
                'collect_event',
                side_effect=Exception("Metering failed")
            ):
                mock_request = Mock(spec=Request)
                mock_request.method = "GET"
                mock_request.headers = {
                    "X-Caracal-Agent-ID": "error-test-agent",
                    "X-Caracal-Target-URL": "https://api.example.com/test"
                }
                mock_request.body = AsyncMock(return_value=b'')
                mock_request.state = Mock()
                
                # Should not raise, request should still succeed
                response = await gateway_proxy._handle_request(mock_request, "/test")
                
                # Verify response is still successful
                assert response.status_code == 200
    
    @pytest.mark.asyncio
    async def test_gateway_metering_with_org_id(
        self, gateway_proxy, temp_ledger
    ):
        """Test gateway metering includes org_id from tenant."""
        mock_response = httpx.Response(
            status_code=200,
            headers={"content-type": "application/json"},
            content=b'{"result": "success"}',
            request=Mock()
        )
        
        with patch.object(gateway_proxy.http_client, 'stream') as mock_stream:
            mock_stream_context = AsyncMock()
            mock_stream_context.__aenter__.return_value = mock_response
            mock_stream_context.__aexit__.return_value = None
            
            # Create async iterator for aiter_bytes
            async def async_iter():
                yield b'{"result": "success"}'
            
            mock_response.aiter_bytes = async_iter
            mock_stream.return_value = mock_stream_context
            
            # Create mock tenant
            mock_tenant = Mock()
            mock_tenant.org_id = "org-12345"
            mock_tenant.tier = "enterprise"
            
            mock_request = Mock(spec=Request)
            mock_request.method = "GET"
            mock_request.headers = {
                "X-Caracal-Agent-ID": "org-test-agent",
                "X-Caracal-Target-URL": "https://api.example.com/test"
            }
            mock_request.body = AsyncMock(return_value=b'')
            mock_request.state = Mock()
            mock_request.state.tenant = mock_tenant
            
            await gateway_proxy._handle_request(mock_request, "/test")
            
            # Verify org_id is in metadata
            with open(temp_ledger, 'r') as f:
                line = f.readline()
                ledger_event = json.loads(line)
            
            assert ledger_event["metadata"]["org_id"] == "org-12345"
    
    def test_metering_event_import_from_caracal(self):
        """Test that MeteringEvent can be imported from caracal.core.metering."""
        from caracal.core.metering import MeteringEvent
        
        # Verify we can create an instance
        event = MeteringEvent(
            agent_id="test-agent",
            resource_type="test.resource",
            quantity=Decimal("1")
        )
        
        assert event.principal_id == "test-agent"
        assert event.resource_type == "test.resource"
        assert event.quantity == Decimal("1")
        assert event.timestamp is not None

