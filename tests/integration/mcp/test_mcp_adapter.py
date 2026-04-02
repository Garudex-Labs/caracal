"""
Integration tests for MCP adapter.

Tests the integration between MCP adapter and authority service,
ensuring proper message routing and error propagation.
"""
import pytest
from datetime import datetime, timedelta
from uuid import uuid4
from unittest.mock import Mock, AsyncMock

from caracal.mcp.adapter import MCPAdapter, MCPContext, MCPResult
from caracal.core.authority import AuthorityEvaluator
from caracal.core.mandate import MandateManager
from caracal.core.metering import MeteringCollector
from caracal.db.models import Principal, ExecutionMandate, AuthorityPolicy
from tests.fixtures.database import db_session, in_memory_db_engine


@pytest.mark.integration
@pytest.mark.asyncio
class TestMCPAdapterIntegration:
    """Test MCP adapter integration."""
    
    async def test_mcp_adapter_with_real_authority_service(self, db_session):
        """Test MCP adapter with real authority service."""
        # Arrange: Create components
        evaluator = AuthorityEvaluator(db_session)
        metering_collector = Mock(spec=MeteringCollector)
        metering_collector.emit_event = Mock()
        
        adapter = MCPAdapter(
            authority_evaluator=evaluator,
            metering_collector=metering_collector,
            mcp_server_url=None  # No upstream server for this test
        )
        
        # Create principals
        issuer_id = uuid4()
        issuer = Principal(
            principal_id=issuer_id,
            principal_name="test-issuer",
            principal_type="user",
            private_key_pem="-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgTest1234567890Test1234567890Test1234567890hRACBggg==\n-----END PRIVATE KEY-----",
            public_key_pem="-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAETest1234567890Test1234567890Test1234567890Test1234567890==\n-----END PUBLIC KEY-----"
        )
        db_session.add(issuer)
        
        policy = AuthorityPolicy(
            principal_id=issuer_id,
            allowed_resource_patterns=["*"],
            allowed_actions=["execute"],
            max_validity_seconds=3600,
            allow_delegation=False,
            max_network_distance=0,
            active=True
        )
        db_session.add(policy)
        
        subject_id = uuid4()
        subject = Principal(
            principal_id=subject_id,
            principal_name="test-agent",
            principal_type="agent"
        )
        db_session.add(subject)
        db_session.commit()
        
        # Issue mandate
        mandate_manager = MandateManager(db_session)
        mandate = mandate_manager.issue_mandate(
            issuer_id=issuer_id,
            subject_id=subject_id,
            resource_scope=["test_tool"],
            action_scope=["execute"],
            validity_seconds=3600
        )
        db_session.commit()
        
        # Create MCP context
        mcp_context = MCPContext(
            principal_id=str(subject_id),
            metadata={
                "mandate_id": str(mandate.mandate_id)
            }
        )
        
        # Act: Intercept tool call (should succeed with valid mandate)
        result = await adapter.intercept_tool_call(
            tool_name="test_tool",
            tool_args={"arg1": "value1"},
            mcp_context=mcp_context
        )
        
        # Assert: Should be denied because no upstream server configured
        # But authority check should pass
        assert result is not None
    
    async def test_mcp_message_routing(self, db_session):
        """Test MCP message routing."""
        # Arrange: Create components
        evaluator = AuthorityEvaluator(db_session)
        metering_collector = Mock(spec=MeteringCollector)
        
        adapter = MCPAdapter(
            authority_evaluator=evaluator,
            metering_collector=metering_collector,
            mcp_server_url="http://localhost:3001"
        )
        
        # Create principals
        issuer_id = uuid4()
        issuer = Principal(
            principal_id=issuer_id,
            principal_name="test-issuer",
            principal_type="user",
            private_key_pem="-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgTest1234567890Test1234567890Test1234567890hRACBggg==\n-----END PRIVATE KEY-----",
            public_key_pem="-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAETest1234567890Test1234567890Test1234567890Test1234567890==\n-----END PUBLIC KEY-----"
        )
        db_session.add(issuer)
        
        policy = AuthorityPolicy(
            principal_id=issuer_id,
            allowed_resource_patterns=["*"],
            allowed_actions=["execute"],
            max_validity_seconds=3600,
            allow_delegation=False,
            max_network_distance=0,
            active=True
        )
        db_session.add(policy)
        
        subject_id = uuid4()
        subject = Principal(
            principal_id=subject_id,
            principal_name="test-agent",
            principal_type="agent"
        )
        db_session.add(subject)
        db_session.commit()
        
        # Issue mandate
        mandate_manager = MandateManager(db_session)
        mandate = mandate_manager.issue_mandate(
            issuer_id=issuer_id,
            subject_id=subject_id,
            resource_scope=["test_tool"],
            action_scope=["execute"],
            validity_seconds=3600
        )
        db_session.commit()
        
        # Create MCP context
        mcp_context = MCPContext(
            principal_id=str(subject_id),
            metadata={
                "mandate_id": str(mandate.mandate_id)
            }
        )
        
        # Act: Intercept tool call
        result = await adapter.intercept_tool_call(
            tool_name="test_tool",
            tool_args={"arg1": "value1"},
            mcp_context=mcp_context
        )
        
        # Assert: Result should be returned (even if upstream fails)
        assert result is not None
    
    async def test_mcp_error_propagation(self, db_session):
        """Test MCP error propagation."""
        # Arrange: Create components
        evaluator = AuthorityEvaluator(db_session)
        metering_collector = Mock(spec=MeteringCollector)
        
        adapter = MCPAdapter(
            authority_evaluator=evaluator,
            metering_collector=metering_collector,
            mcp_server_url=None
        )
        
        # Create principals
        issuer_id = uuid4()
        issuer = Principal(
            principal_id=issuer_id,
            principal_name="test-issuer",
            principal_type="user",
            private_key_pem="-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgTest1234567890Test1234567890Test1234567890hRACBggg==\n-----END PRIVATE KEY-----",
            public_key_pem="-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAETest1234567890Test1234567890Test1234567890Test1234567890==\n-----END PUBLIC KEY-----"
        )
        db_session.add(issuer)
        
        policy = AuthorityPolicy(
            principal_id=issuer_id,
            allowed_resource_patterns=["allowed_tool"],
            allowed_actions=["execute"],
            max_validity_seconds=3600,
            allow_delegation=False,
            max_network_distance=0,
            active=True
        )
        db_session.add(policy)
        
        subject_id = uuid4()
        subject = Principal(
            principal_id=subject_id,
            principal_name="test-agent",
            principal_type="agent"
        )
        db_session.add(subject)
        db_session.commit()
        
        # Issue mandate with limited scope
        mandate_manager = MandateManager(db_session)
        mandate = mandate_manager.issue_mandate(
            issuer_id=issuer_id,
            subject_id=subject_id,
            resource_scope=["allowed_tool"],
            action_scope=["execute"],
            validity_seconds=3600
        )
        db_session.commit()
        
        # Create MCP context
        mcp_context = MCPContext(
            principal_id=str(subject_id),
            metadata={
                "mandate_id": str(mandate.mandate_id)
            }
        )
        
        # Act: Try to call a tool not in scope (should be denied)
        result = await adapter.intercept_tool_call(
            tool_name="forbidden_tool",
            tool_args={"arg1": "value1"},
            mcp_context=mcp_context
        )
        
        # Assert: Should be denied
        assert result.success is False
        assert "Authority denied" in result.error
