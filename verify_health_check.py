#!/usr/bin/env python3
"""
Verification script for health check implementation.
Exits with 0 if all checks pass, 1 otherwise.
"""

import sys
from unittest.mock import Mock
from fastapi.testclient import TestClient

try:
    # Test Gateway Proxy health check
    from caracal.gateway.proxy import GatewayProxy, GatewayConfig
    from caracal.gateway.auth import Authenticator
    from caracal.core.policy import PolicyEvaluator
    from caracal.core.metering import MeteringCollector
    from caracal.gateway.cache import PolicyCache, PolicyCacheConfig

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
    client = TestClient(gateway.app)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "healthy"
    assert "checks" in response.json()

    # Test 2: Health check with healthy database
    mock_db_manager = Mock()
    mock_db_manager.health_check.return_value = True
    gateway.db_connection_manager = mock_db_manager
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["checks"]["database"] == "healthy"

    # Test 3: Health check with unhealthy database (degraded mode)
    mock_db_manager.health_check.return_value = False
    cache_config = PolicyCacheConfig(ttl_seconds=60, max_size=100)
    gateway.policy_cache = PolicyCache(cache_config)
    gateway.config.enable_policy_cache = True
    response = client.get("/health")
    assert response.status_code == 503
    assert response.json()["status"] == "degraded"

    # Test MCP Adapter Service health check
    from caracal.mcp.service import MCPAdapterService, MCPServiceConfig, MCPServerConfig
    from caracal.mcp.adapter import MCPAdapter
    from unittest.mock import AsyncMock

    # Create mocks
    mcp_config = MCPServiceConfig(
        listen_address="127.0.0.1:8080",
        mcp_servers=[MCPServerConfig(name="test-server", url="http://localhost:9001")]
    )
    mock_mcp_adapter = Mock(spec=MCPAdapter)

    # Create MCP service
    mcp_service = MCPAdapterService(
        config=mcp_config,
        mcp_adapter=mock_mcp_adapter,
        policy_evaluator=mock_policy_evaluator,
        metering_collector=mock_metering_collector
    )

    # Test 4: MCP health check with healthy database
    mock_response = Mock()
    mock_response.status_code = 200
    for client_obj in mcp_service.mcp_clients.values():
        client_obj.get = AsyncMock(return_value=mock_response)

    mock_db_manager = Mock()
    mock_db_manager.health_check.return_value = True
    mcp_service.db_connection_manager = mock_db_manager

    client = TestClient(mcp_service.app)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "healthy"

    # Test 5: MCP health check with unhealthy database
    mock_db_manager.health_check.return_value = False
    response = client.get("/health")
    assert response.status_code == 503
    assert response.json()["status"] == "degraded"

    sys.exit(0)

except AssertionError as e:
    sys.exit(1)
except Exception as e:
    sys.exit(1)
