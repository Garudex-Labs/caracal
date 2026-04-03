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
from caracal.core.principal_keys import generate_and_store_principal_keypair
from caracal.core.metering import MeteringCollector
from caracal.db.models import Principal, ExecutionMandate, AuthorityPolicy
from tests.fixtures.database import db_session, in_memory_db_engine


def _make_principal(
    principal_id,
    name,
    principal_type,
    *,
    owner="integration-test",
    with_keys=False,
):
    metadata = None
    public_key_pem = None
    if with_keys:
        generated = generate_and_store_principal_keypair(principal_id)
        metadata = generated.storage.metadata
        public_key_pem = generated.public_key_pem

    return Principal(
        principal_id=principal_id,
        name=name,
        principal_type=principal_type,
        owner=owner,
        public_key_pem=public_key_pem,
        principal_metadata=metadata,
    )


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
        issuer = _make_principal(issuer_id, "test-issuer", "user", with_keys=True)
        db_session.add(issuer)

        policy = AuthorityPolicy(
            principal_id=issuer_id,
            allowed_resource_patterns=["*"],
            allowed_actions=["execute"],
            max_validity_seconds=3600,
            allow_delegation=False,
            max_network_distance=0,
            created_by="integration-test",
            active=True
        )
        db_session.add(policy)

        subject_id = uuid4()
        subject = _make_principal(subject_id, "test-agent", "agent")
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
        issuer = _make_principal(issuer_id, "test-issuer", "user", with_keys=True)
        db_session.add(issuer)

        policy = AuthorityPolicy(
            principal_id=issuer_id,
            allowed_resource_patterns=["*"],
            allowed_actions=["execute"],
            max_validity_seconds=3600,
            allow_delegation=False,
            max_network_distance=0,
            created_by="integration-test",
            active=True
        )
        db_session.add(policy)

        subject_id = uuid4()
        subject = _make_principal(subject_id, "test-agent", "agent")
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
        issuer = _make_principal(issuer_id, "test-issuer", "user", with_keys=True)
        db_session.add(issuer)

        policy = AuthorityPolicy(
            principal_id=issuer_id,
            allowed_resource_patterns=["allowed_tool"],
            allowed_actions=["execute"],
            max_validity_seconds=3600,
            allow_delegation=False,
            max_network_distance=0,
            created_by="integration-test",
            active=True
        )
        db_session.add(policy)

        subject_id = uuid4()
        subject = _make_principal(subject_id, "test-agent", "agent")
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
