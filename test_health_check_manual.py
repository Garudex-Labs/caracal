#!/usr/bin/env python3
"""
Manual test script for health check endpoints.
"""

import sys
from unittest.mock import Mock
from fastapi.testclient import TestClient

# Test Gateway Proxy health check
print("=" * 60)
print("Testing Gateway Proxy Health Check")
print("=" * 60)

from caracal.gateway.proxy import GatewayProxy, GatewayConfig
from caracal.gateway.auth import Authenticator
from caracal.core.policy import PolicyEvaluator
from caracal.core.metering import MeteringCollector

# Create mocks
config = GatewayConfig(listen_address="127.0.0.1:8443", auth_mode="jwt")
mock_authenticator = Mock(spec=Authenticator)
mock_policy_evaluator = Mock(spec=PolicyEvaluator)
mock_metering_collector = Mock(spec=MeteringCollector)

# Create gateway proxy
gateway = GatewayProxy(
    config=config,
    authenticator=mock_authenticator,
    policy_evaluator=mock_policy_evaluator,
    metering_collector=mock_metering_collector
)

# Test 1: Health check without database
print("\n1. Testing health check without database...")
client = TestClient(gateway.app)
response = client.get("/health")
print(f"   Status: {response.status_code}")
print(f"   Response: {response.json()}")
assert response.status_code == 200, "Expected 200 OK"
assert response.json()["status"] == "healthy", "Expected healthy status"
print("   ✓ PASSED")

# Test 2: Health check with healthy database
print("\n2. Testing health check with healthy database...")
mock_db_manager = Mock()
mock_db_manager.health_check.return_value = True
gateway.db_connection_manager = mock_db_manager

response = client.get("/health")
print(f"   Status: {response.status_code}")
print(f"   Response: {response.json()}")
assert response.status_code == 200, "Expected 200 OK"
assert response.json()["status"] == "healthy", "Expected healthy status"
assert response.json()["checks"]["database"] == "healthy", "Expected healthy database"
print("   ✓ PASSED")

# Test 3: Health check with unhealthy database (no cache)
print("\n3. Testing health check with unhealthy database (no cache)...")
mock_db_manager.health_check.return_value = False
gateway.policy_cache = None
gateway.config.enable_policy_cache = False

response = client.get("/health")
print(f"   Status: {response.status_code}")
print(f"   Response: {response.json()}")
assert response.status_code == 503, "Expected 503 Service Unavailable"
assert response.json()["status"] == "unhealthy", "Expected unhealthy status"
print("   ✓ PASSED")

# Test 4: Health check with unhealthy database (with cache - degraded mode)
print("\n4. Testing health check with unhealthy database (with cache - degraded mode)...")
from caracal.gateway.cache import PolicyCache, PolicyCacheConfig
cache_config = PolicyCacheConfig(ttl_seconds=60, max_size=100)
gateway.policy_cache = PolicyCache(cache_config)
gateway.config.enable_policy_cache = True

response = client.get("/health")
print(f"   Status: {response.status_code}")
print(f"   Response: {response.json()}")
assert response.status_code == 503, "Expected 503 Service Unavailable"
assert response.json()["status"] == "degraded", "Expected degraded status"
print("   ✓ PASSED")

print("\n" + "=" * 60)
print("Testing MCP Adapter Service Health Check")
print("=" * 60)

from caracal.mcp.service import MCPAdapterService, MCPServiceConfig, MCPServerConfig
from caracal.mcp.adapter import MCPAdapter

# Create mocks
mcp_config = MCPServiceConfig(
    listen_address="127.0.0.1:8080",
    mcp_servers=[
        MCPServerConfig(name="test-server", url="http://localhost:9001")
    ]
)
mock_mcp_adapter = Mock(spec=MCPAdapter)

# Create MCP service
mcp_service = MCPAdapterService(
    config=mcp_config,
    mcp_adapter=mock_mcp_adapter,
    policy_evaluator=mock_policy_evaluator,
    metering_collector=mock_metering_collector
)

# Test 5: MCP health check without database
print("\n5. Testing MCP health check without database...")
# Mock MCP server health check
from unittest.mock import AsyncMock
mock_response = Mock()
mock_response.status_code = 200
for client in mcp_service.mcp_clients.values():
    client.get = AsyncMock(return_value=mock_response)

client = TestClient(mcp_service.app)
response = client.get("/health")
print(f"   Status: {response.status_code}")
print(f"   Response: {response.json()}")
assert response.status_code == 200, "Expected 200 OK"
assert response.json()["status"] == "healthy", "Expected healthy status"
print("   ✓ PASSED")

# Test 6: MCP health check with healthy database
print("\n6. Testing MCP health check with healthy database...")
mock_db_manager = Mock()
mock_db_manager.health_check.return_value = True
mcp_service.db_connection_manager = mock_db_manager

response = client.get("/health")
print(f"   Status: {response.status_code}")
print(f"   Response: {response.json()}")
assert response.status_code == 200, "Expected 200 OK"
assert response.json()["status"] == "healthy", "Expected healthy status"
assert response.json()["mcp_servers"]["database"] == "healthy", "Expected healthy database"
print("   ✓ PASSED")

# Test 7: MCP health check with unhealthy database
print("\n7. Testing MCP health check with unhealthy database...")
mock_db_manager.health_check.return_value = False

response = client.get("/health")
print(f"   Status: {response.status_code}")
print(f"   Response: {response.json()}")
assert response.status_code == 503, "Expected 503 Service Unavailable"
assert response.json()["status"] == "degraded", "Expected degraded status"
assert response.json()["mcp_servers"]["database"] == "unhealthy", "Expected unhealthy database"
print("   ✓ PASSED")

# Test 8: MCP health check with unhealthy MCP server
print("\n8. Testing MCP health check with unhealthy MCP server...")
mock_db_manager.health_check.return_value = True
mock_response.status_code = 503

response = client.get("/health")
print(f"   Status: {response.status_code}")
print(f"   Response: {response.json()}")
assert response.status_code == 503, "Expected 503 Service Unavailable"
assert response.json()["status"] == "degraded", "Expected degraded status"
print("   ✓ PASSED")

print("\n" + "=" * 60)
print("ALL TESTS PASSED ✓")
print("=" * 60)
