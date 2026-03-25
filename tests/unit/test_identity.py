"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for agent identity management.
"""

import json
import uuid
from pathlib import Path

import pytest

from caracal.core.identity import PrincipalIdentity, PrincipalRegistry
from caracal.exceptions import DuplicateAgentNameError


class TestPrincipalIdentity:
    """Test PrincipalIdentity dataclass."""

    def test_agent_identity_creation(self):
        """Test creating an PrincipalIdentity."""
        agent = PrincipalIdentity(
            agent_id="550e8400-e29b-41d4-a716-446655440000",
            name="test-agent",
            owner="test@example.com",
            created_at="2024-01-15T10:00:00Z",
            metadata={"department": "AI Research"}
        )
        
        assert agent.principal_id == "550e8400-e29b-41d4-a716-446655440000"
        assert agent.name == "test-agent"
        assert agent.owner == "test@example.com"
        assert agent.created_at == "2024-01-15T10:00:00Z"
        assert agent.metadata == {"department": "AI Research"}

    def test_agent_identity_to_dict(self):
        """Test converting PrincipalIdentity to dictionary."""
        agent = PrincipalIdentity(
            agent_id="550e8400-e29b-41d4-a716-446655440000",
            name="test-agent",
            owner="test@example.com",
            created_at="2024-01-15T10:00:00Z",
            metadata={}
        )
        
        data = agent.to_dict()
        assert data["agent_id"] == "550e8400-e29b-41d4-a716-446655440000"
        assert data["name"] == "test-agent"
        assert data["owner"] == "test@example.com"

    def test_agent_identity_from_dict(self):
        """Test creating PrincipalIdentity from dictionary."""
        data = {
            "agent_id": "550e8400-e29b-41d4-a716-446655440000",
            "name": "test-agent",
            "owner": "test@example.com",
            "created_at": "2024-01-15T10:00:00Z",
            "metadata": {"key": "value"}
        }
        
        agent = PrincipalIdentity.from_dict(data)
        assert agent.principal_id == "550e8400-e29b-41d4-a716-446655440000"
        assert agent.name == "test-agent"
        assert agent.metadata == {"key": "value"}


class TestPrincipalRegistry:
    """Test PrincipalRegistry class."""

    def test_registry_initialization(self, temp_dir):
        """Test initializing an PrincipalRegistry."""
        registry_path = temp_dir / "agents.json"
        registry = PrincipalRegistry(str(registry_path))
        
        assert registry.registry_path == registry_path
        assert registry.backup_count == 3
        assert len(registry.list_agents()) == 0

    def test_register_principal(self, temp_dir):
        """Test registering a new agent."""
        registry_path = temp_dir / "agents.json"
        registry = PrincipalRegistry(str(registry_path))
        
        agent = registry.register_principal(
            name="test-agent",
            owner="test@example.com",
            metadata={"department": "AI"}
        )
        
        # Verify agent properties
        assert agent.name == "test-agent"
        assert agent.owner == "test@example.com"
        assert agent.metadata == {"department": "AI"}
        
        # Verify UUID v4 format
        try:
            uuid_obj = uuid.UUID(agent.principal_id, version=4)
            assert str(uuid_obj) == agent.principal_id
        except ValueError:
            pytest.fail("Agent ID is not a valid UUID v4")
        
        # Verify timestamp format
        assert agent.created_at.endswith("Z")
        assert "T" in agent.created_at

    def test_register_principal_duplicate_name(self, temp_dir):
        """Test that duplicate agent names are rejected."""
        registry_path = temp_dir / "agents.json"
        registry = PrincipalRegistry(str(registry_path))
        
        # Register first agent
        registry.register_principal(
            name="test-agent",
            owner="user1@example.com"
        )
        
        # Attempt to register second agent with same name
        with pytest.raises(DuplicateAgentNameError) as exc_info:
            registry.register_principal(
                name="test-agent",
                owner="user2@example.com"
            )
        
        assert "test-agent" in str(exc_info.value)

    def test_get_principal(self, temp_dir):
        """Test retrieving an agent by ID."""
        registry_path = temp_dir / "agents.json"
        registry = PrincipalRegistry(str(registry_path))
        
        # Register agent
        agent = registry.register_principal(
            name="test-agent",
            owner="test@example.com"
        )
        
        # Retrieve agent
        retrieved = registry.get_principal(agent.principal_id)
        assert retrieved is not None
        assert retrieved.principal_id == agent.principal_id
        assert retrieved.name == agent.name
        assert retrieved.owner == agent.owner

    def test_get_principal_not_found(self, temp_dir):
        """Test retrieving a non-existent agent."""
        registry_path = temp_dir / "agents.json"
        registry = PrincipalRegistry(str(registry_path))
        
        result = registry.get_principal("non-existent-id")
        assert result is None

    def test_list_agents(self, temp_dir):
        """Test listing all agents."""
        registry_path = temp_dir / "agents.json"
        registry = PrincipalRegistry(str(registry_path))
        
        # Register multiple agents
        agent1 = registry.register_principal(
            name="agent-1",
            owner="user1@example.com"
        )
        agent2 = registry.register_principal(
            name="agent-2",
            owner="user2@example.com"
        )
        
        # List agents
        agents = registry.list_agents()
        assert len(agents) == 2
        
        agent_ids = {a.principal_id for a in agents}
        assert agent1.principal_id in agent_ids
        assert agent2.principal_id in agent_ids

    def test_persistence(self, temp_dir):
        """Test that agents are persisted to disk."""
        registry_path = temp_dir / "agents.json"
        registry = PrincipalRegistry(str(registry_path))
        
        # Register agent
        agent = registry.register_principal(
            name="test-agent",
            owner="test@example.com",
            metadata={"key": "value"}
        )
        
        # Verify file was created
        assert registry_path.exists()
        
        # Verify file content
        with open(registry_path, 'r') as f:
            data = json.load(f)
        
        assert len(data) == 1
        assert data[0]["agent_id"] == agent.principal_id
        assert data[0]["name"] == "test-agent"
        assert data[0]["owner"] == "test@example.com"
        assert data[0]["metadata"] == {"key": "value"}

    def test_load_from_disk(self, temp_dir):
        """Test loading agents from disk."""
        registry_path = temp_dir / "agents.json"
        
        # Create first registry and register agent
        registry1 = PrincipalRegistry(str(registry_path))
        agent = registry1.register_principal(
            name="test-agent",
            owner="test@example.com"
        )
        
        # Create second registry (should load from disk)
        registry2 = PrincipalRegistry(str(registry_path))
        
        # Verify agent was loaded
        loaded_agent = registry2.get_principal(agent.principal_id)
        assert loaded_agent is not None
        assert loaded_agent.principal_id == agent.principal_id
        assert loaded_agent.name == agent.name
        assert loaded_agent.owner == agent.owner

    def test_backup_creation(self, temp_dir):
        """Test that backups are created."""
        registry_path = temp_dir / "agents.json"
        registry = PrincipalRegistry(str(registry_path))
        
        # Register first agent (creates initial file)
        registry.register_principal(name="agent-1", owner="user1@example.com")
        
        # Register second agent (should create backup)
        registry.register_principal(name="agent-2", owner="user2@example.com")
        
        # Verify backup exists
        backup_path = Path(f"{registry_path}.bak.1")
        assert backup_path.exists()

    def test_backup_rotation(self, temp_dir):
        """Test that backups are rotated correctly."""
        registry_path = temp_dir / "agents.json"
        registry = PrincipalRegistry(str(registry_path), backup_count=3)
        
        # Register multiple agents to trigger backup rotation
        for i in range(5):
            registry.register_principal(
                name=f"agent-{i}",
                owner=f"user{i}@example.com"
            )
        
        # Verify backup files exist (up to backup_count)
        backup1 = Path(f"{registry_path}.bak.1")
        backup2 = Path(f"{registry_path}.bak.2")
        backup3 = Path(f"{registry_path}.bak.3")
        backup4 = Path(f"{registry_path}.bak.4")
        
        assert backup1.exists()
        assert backup2.exists()
        assert backup3.exists()
        assert not backup4.exists()  # Should not exceed backup_count

    def test_empty_metadata(self, temp_dir):
        """Test registering agent with no metadata."""
        registry_path = temp_dir / "agents.json"
        registry = PrincipalRegistry(str(registry_path))
        
        agent = registry.register_principal(
            name="test-agent",
            owner="test@example.com"
        )
        
        assert agent.metadata == {}


