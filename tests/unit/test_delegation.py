"""
Unit tests for delegation token management.

Tests the DelegationTokenManager for generating and validating
ASE v1.0.8 delegation tokens.
"""

import pytest
from datetime import datetime, timedelta
from decimal import Decimal
from uuid import UUID, uuid4

from caracal.core.delegation import DelegationTokenManager, DelegationTokenClaims
from caracal.core.identity import AgentRegistry, AgentIdentity
from caracal.exceptions import (
    AgentNotFoundError,
    InvalidDelegationTokenError,
    TokenExpiredError,
    TokenValidationError,
)


@pytest.fixture
def temp_registry_path(tmp_path):
    """Create temporary registry path."""
    return str(tmp_path / "agents.json")


@pytest.fixture
def agent_registry(temp_registry_path):
    """Create agent registry with delegation token manager."""
    delegation_manager = DelegationTokenManager(agent_registry=None)
    registry = AgentRegistry(temp_registry_path, delegation_token_manager=delegation_manager)
    delegation_manager.agent_registry = registry
    return registry


@pytest.fixture
def delegation_manager(agent_registry):
    """Get delegation token manager from registry."""
    return agent_registry.delegation_token_manager


@pytest.fixture
def parent_agent(agent_registry):
    """Create parent agent with keys."""
    return agent_registry.register_agent(
        name="parent-agent",
        owner="parent@example.com",
        generate_keys=True
    )


@pytest.fixture
def child_agent(agent_registry, parent_agent):
    """Create child agent with keys."""
    return agent_registry.register_agent(
        name="child-agent",
        owner="child@example.com",
        parent_agent_id=parent_agent.agent_id,
        generate_keys=True
    )


class TestDelegationTokenManager:
    """Test DelegationTokenManager functionality."""
    
    def test_generate_key_pair(self, delegation_manager):
        """Test ECDSA P-256 key pair generation."""
        private_key_pem, public_key_pem = delegation_manager.generate_key_pair()
        
        # Verify keys are bytes
        assert isinstance(private_key_pem, bytes)
        assert isinstance(public_key_pem, bytes)
        
        # Verify PEM format
        assert private_key_pem.startswith(b"-----BEGIN PRIVATE KEY-----")
        assert public_key_pem.startswith(b"-----BEGIN PUBLIC KEY-----")
    
    def test_generate_token_success(self, delegation_manager, parent_agent, child_agent):
        """Test successful delegation token generation."""
        token = delegation_manager.generate_token(
            parent_agent_id=UUID(parent_agent.agent_id),
            child_agent_id=UUID(child_agent.agent_id),
            expiration_seconds=3600
        )
        
        # Verify token is a string
        assert isinstance(token, str)
        
        # Verify token has JWT structure (header.payload.signature)
        parts = token.split('.')
        assert len(parts) == 3
    
    def test_generate_token_parent_not_found(self, delegation_manager, child_agent):
        """Test token generation fails when parent agent not found."""
        fake_parent_id = uuid4()
        
        with pytest.raises(AgentNotFoundError):
            delegation_manager.generate_token(
                parent_agent_id=fake_parent_id,
                child_agent_id=UUID(child_agent.agent_id),
            )
    
    def test_generate_token_no_private_key(self, agent_registry, delegation_manager, child_agent):
        """Test token generation fails when parent has no private key."""
        # Create parent without keys
        parent_no_keys = agent_registry.register_agent(
            name="parent-no-keys",
            owner="parent@example.com",
            generate_keys=False
        )
        
        with pytest.raises(InvalidDelegationTokenError):
            delegation_manager.generate_token(
                parent_agent_id=UUID(parent_no_keys.agent_id),
                child_agent_id=UUID(child_agent.agent_id),
            )
    
    def test_validate_token_success(self, delegation_manager, parent_agent, child_agent):
        """Test successful token validation."""
        # Generate token
        token = delegation_manager.generate_token(
            parent_agent_id=UUID(parent_agent.agent_id),
            child_agent_id=UUID(child_agent.agent_id),
            expiration_seconds=3600,
            allowed_operations=["api_call", "mcp_tool"]
        )
        
        # Validate token
        claims = delegation_manager.validate_token(token)
        
        # Verify claims
        assert isinstance(claims, DelegationTokenClaims)
        assert claims.issuer == UUID(parent_agent.agent_id)
        assert claims.subject == UUID(child_agent.agent_id)
        assert claims.allowed_operations == ["api_call", "mcp_tool"]
        assert claims.audience == "caracal-core"
    
    def test_validate_token_expired(self, delegation_manager, parent_agent, child_agent):
        """Test token validation fails for expired token."""
        # Generate token with very short expiration
        token = delegation_manager.generate_token(
            parent_agent_id=UUID(parent_agent.agent_id),
            child_agent_id=UUID(child_agent.agent_id),
            expiration_seconds=1  # 1 second
        )
        
        # Wait for token to expire
        import time
        time.sleep(2)
        
        # Validate token should fail
        with pytest.raises(TokenExpiredError):
            delegation_manager.validate_token(token)
    
    def test_validate_token_invalid_signature(self, delegation_manager, parent_agent, child_agent):
        """Test token validation fails for tampered token."""
        # Generate valid token
        token = delegation_manager.generate_token(
            parent_agent_id=UUID(parent_agent.agent_id),
            child_agent_id=UUID(child_agent.agent_id),
        )
        
        # Tamper with token (change last character)
        tampered_token = token[:-1] + ('A' if token[-1] != 'A' else 'B')
        
        # Validate should fail
        with pytest.raises(TokenValidationError):
            delegation_manager.validate_token(tampered_token)
    
    def test_validate_token_issuer_not_found(self, delegation_manager, parent_agent, child_agent, agent_registry):
        """Test token validation fails when issuer agent deleted."""
        # Generate token
        token = delegation_manager.generate_token(
            parent_agent_id=UUID(parent_agent.agent_id),
            child_agent_id=UUID(child_agent.agent_id),
        )
        
        # Remove parent agent from registry (simulate deletion)
        del agent_registry._agents[parent_agent.agent_id]
        
        # Validate should fail
        with pytest.raises(AgentNotFoundError):
            delegation_manager.validate_token(token)
    
class TestAgentRegistryDelegation:
    """Test AgentRegistry delegation token integration."""
    
    def test_register_agent_generates_keys(self, agent_registry):
        """Test agent registration generates key pair."""
        agent = agent_registry.register_agent(
            name="test-agent",
            owner="test@example.com",
            generate_keys=True
        )
        
        # Verify keys in metadata
        assert "private_key_pem" in agent.metadata
        assert "public_key_pem" in agent.metadata
        assert agent.metadata["private_key_pem"].startswith("-----BEGIN PRIVATE KEY-----")
        assert agent.metadata["public_key_pem"].startswith("-----BEGIN PUBLIC KEY-----")
    
    def test_register_agent_no_keys(self, agent_registry):
        """Test agent registration without key generation."""
        agent = agent_registry.register_agent(
            name="test-agent-no-keys",
            owner="test@example.com",
            generate_keys=False
        )
        
        # Verify no keys in metadata
        assert "private_key_pem" not in agent.metadata
        assert "public_key_pem" not in agent.metadata
    
    def test_generate_delegation_token(self, agent_registry, parent_agent, child_agent):
        """Test delegation token generation via registry."""
        token = agent_registry.generate_delegation_token(
            parent_agent_id=parent_agent.agent_id,
            child_agent_id=child_agent.agent_id,
        )
        
        # Verify token generated
        assert token is not None
        assert isinstance(token, str)
        
        # Verify token metadata stored in child agent
        child = agent_registry.get_agent(child_agent.agent_id)
        assert "delegation_tokens" in child.metadata
        assert len(child.metadata["delegation_tokens"]) == 1
        
        token_metadata = child.metadata["delegation_tokens"][0]
        assert token_metadata["parent_agent_id"] == parent_agent.agent_id
    
    def test_generate_delegation_token_parent_not_found(self, agent_registry, child_agent):
        """Test delegation token generation fails when parent not found."""
        fake_parent_id = str(uuid4())
        
        with pytest.raises(AgentNotFoundError):
            agent_registry.generate_delegation_token(
                parent_agent_id=fake_parent_id,
                child_agent_id=child_agent.agent_id,
            )
    
    def test_generate_delegation_token_child_not_found(self, agent_registry, parent_agent):
        """Test delegation token generation fails when child not found."""
        fake_child_id = str(uuid4())
        
        with pytest.raises(AgentNotFoundError):
            agent_registry.generate_delegation_token(
                parent_agent_id=parent_agent.agent_id,
                child_agent_id=fake_child_id,
            )
