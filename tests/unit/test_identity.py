"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for agent identity management.
"""

import json
import uuid
from pathlib import Path

import pytest

from caracal.core.identity import AgentIdentity, AgentRegistry
from caracal.exceptions import DuplicateAgentNameError


class TestAgentIdentity:
    """Test AgentIdentity dataclass."""

    def test_agent_identity_creation(self):
        """Test creating an AgentIdentity."""
        agent = AgentIdentity(
            agent_id="550e8400-e29b-41d4-a716-446655440000",
            name="test-agent",
            owner="test@example.com",
            created_at="2024-01-15T10:00:00Z",
            metadata={"department": "AI Research"}
        )
        
        assert agent.agent_id == "550e8400-e29b-41d4-a716-446655440000"
        assert agent.name == "test-agent"
        assert agent.owner == "test@example.com"
        assert agent.created_at == "2024-01-15T10:00:00Z"
        assert agent.metadata == {"department": "AI Research"}

    def test_agent_identity_to_dict(self):
        """Test converting AgentIdentity to dictionary."""
        agent = AgentIdentity(
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
        """Test creating AgentIdentity from dictionary."""
        data = {
            "agent_id": "550e8400-e29b-41d4-a716-446655440000",
            "name": "test-agent",
            "owner": "test@example.com",
            "created_at": "2024-01-15T10:00:00Z",
            "metadata": {"key": "value"}
        }
        
        agent = AgentIdentity.from_dict(data)
        assert agent.agent_id == "550e8400-e29b-41d4-a716-446655440000"
        assert agent.name == "test-agent"
        assert agent.metadata == {"key": "value"}


class TestAgentRegistry:
    """Test AgentRegistry class."""

    def test_registry_initialization(self, temp_dir):
        """Test initializing an AgentRegistry."""
        registry_path = temp_dir / "agents.json"
        registry = AgentRegistry(str(registry_path))
        
        assert registry.registry_path == registry_path
        assert registry.backup_count == 3
        assert len(registry.list_agents()) == 0

    def test_register_agent(self, temp_dir):
        """Test registering a new agent."""
        registry_path = temp_dir / "agents.json"
        registry = AgentRegistry(str(registry_path))
        
        agent = registry.register_agent(
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
            uuid_obj = uuid.UUID(agent.agent_id, version=4)
            assert str(uuid_obj) == agent.agent_id
        except ValueError:
            pytest.fail("Agent ID is not a valid UUID v4")
        
        # Verify timestamp format
        assert agent.created_at.endswith("Z")
        assert "T" in agent.created_at

    def test_register_agent_duplicate_name(self, temp_dir):
        """Test that duplicate agent names are rejected."""
        registry_path = temp_dir / "agents.json"
        registry = AgentRegistry(str(registry_path))
        
        # Register first agent
        registry.register_agent(
            name="test-agent",
            owner="user1@example.com"
        )
        
        # Attempt to register second agent with same name
        with pytest.raises(DuplicateAgentNameError) as exc_info:
            registry.register_agent(
                name="test-agent",
                owner="user2@example.com"
            )
        
        assert "test-agent" in str(exc_info.value)

    def test_get_agent(self, temp_dir):
        """Test retrieving an agent by ID."""
        registry_path = temp_dir / "agents.json"
        registry = AgentRegistry(str(registry_path))
        
        # Register agent
        agent = registry.register_agent(
            name="test-agent",
            owner="test@example.com"
        )
        
        # Retrieve agent
        retrieved = registry.get_agent(agent.agent_id)
        assert retrieved is not None
        assert retrieved.agent_id == agent.agent_id
        assert retrieved.name == agent.name
        assert retrieved.owner == agent.owner

    def test_get_agent_not_found(self, temp_dir):
        """Test retrieving a non-existent agent."""
        registry_path = temp_dir / "agents.json"
        registry = AgentRegistry(str(registry_path))
        
        result = registry.get_agent("non-existent-id")
        assert result is None

    def test_list_agents(self, temp_dir):
        """Test listing all agents."""
        registry_path = temp_dir / "agents.json"
        registry = AgentRegistry(str(registry_path))
        
        # Register multiple agents
        agent1 = registry.register_agent(
            name="agent-1",
            owner="user1@example.com"
        )
        agent2 = registry.register_agent(
            name="agent-2",
            owner="user2@example.com"
        )
        
        # List agents
        agents = registry.list_agents()
        assert len(agents) == 2
        
        agent_ids = {a.agent_id for a in agents}
        assert agent1.agent_id in agent_ids
        assert agent2.agent_id in agent_ids

    def test_persistence(self, temp_dir):
        """Test that agents are persisted to disk."""
        registry_path = temp_dir / "agents.json"
        registry = AgentRegistry(str(registry_path))
        
        # Register agent
        agent = registry.register_agent(
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
        assert data[0]["agent_id"] == agent.agent_id
        assert data[0]["name"] == "test-agent"
        assert data[0]["owner"] == "test@example.com"
        assert data[0]["metadata"] == {"key": "value"}

    def test_load_from_disk(self, temp_dir):
        """Test loading agents from disk."""
        registry_path = temp_dir / "agents.json"
        
        # Create first registry and register agent
        registry1 = AgentRegistry(str(registry_path))
        agent = registry1.register_agent(
            name="test-agent",
            owner="test@example.com"
        )
        
        # Create second registry (should load from disk)
        registry2 = AgentRegistry(str(registry_path))
        
        # Verify agent was loaded
        loaded_agent = registry2.get_agent(agent.agent_id)
        assert loaded_agent is not None
        assert loaded_agent.agent_id == agent.agent_id
        assert loaded_agent.name == agent.name
        assert loaded_agent.owner == agent.owner

    def test_backup_creation(self, temp_dir):
        """Test that backups are created."""
        registry_path = temp_dir / "agents.json"
        registry = AgentRegistry(str(registry_path))
        
        # Register first agent (creates initial file)
        registry.register_agent(name="agent-1", owner="user1@example.com")
        
        # Register second agent (should create backup)
        registry.register_agent(name="agent-2", owner="user2@example.com")
        
        # Verify backup exists
        backup_path = Path(f"{registry_path}.bak.1")
        assert backup_path.exists()

    def test_backup_rotation(self, temp_dir):
        """Test that backups are rotated correctly."""
        registry_path = temp_dir / "agents.json"
        registry = AgentRegistry(str(registry_path), backup_count=3)
        
        # Register multiple agents to trigger backup rotation
        for i in range(5):
            registry.register_agent(
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
        registry = AgentRegistry(str(registry_path))
        
        agent = registry.register_agent(
            name="test-agent",
            owner="test@example.com"
        )
        
        assert agent.metadata == {}

    def test_register_agent_with_parent(self, temp_dir):
        """Test registering a child agent with a parent."""
        registry_path = temp_dir / "agents.json"
        registry = AgentRegistry(str(registry_path))
        
        # Register parent agent
        parent = registry.register_agent(
            name="parent-agent",
            owner="parent@example.com"
        )
        
        # Register child agent
        child = registry.register_agent(
            name="child-agent",
            owner="child@example.com",
            parent_agent_id=parent.agent_id
        )
        
        assert child.parent_agent_id == parent.agent_id
        assert child.name == "child-agent"

    def test_register_agent_with_nonexistent_parent(self, temp_dir):
        """Test that registering with non-existent parent fails."""
        from caracal.exceptions import AgentNotFoundError
        
        registry_path = temp_dir / "agents.json"
        registry = AgentRegistry(str(registry_path))
        
        # Attempt to register child with non-existent parent
        with pytest.raises(AgentNotFoundError) as exc_info:
            registry.register_agent(
                name="child-agent",
                owner="child@example.com",
                parent_agent_id="non-existent-id"
            )
        
        assert "non-existent-id" in str(exc_info.value)

    def test_get_children(self, temp_dir):
        """Test getting direct children of an agent."""
        registry_path = temp_dir / "agents.json"
        registry = AgentRegistry(str(registry_path))
        
        # Register parent agent
        parent = registry.register_agent(
            name="parent-agent",
            owner="parent@example.com"
        )
        
        # Register child agents
        child1 = registry.register_agent(
            name="child-1",
            owner="child1@example.com",
            parent_agent_id=parent.agent_id
        )
        child2 = registry.register_agent(
            name="child-2",
            owner="child2@example.com",
            parent_agent_id=parent.agent_id
        )
        
        # Register unrelated agent
        registry.register_agent(
            name="unrelated-agent",
            owner="unrelated@example.com"
        )
        
        # Get children
        children = registry.get_children(parent.agent_id)
        
        assert len(children) == 2
        child_ids = {c.agent_id for c in children}
        assert child1.agent_id in child_ids
        assert child2.agent_id in child_ids

    def test_get_children_no_children(self, temp_dir):
        """Test getting children when agent has none."""
        registry_path = temp_dir / "agents.json"
        registry = AgentRegistry(str(registry_path))
        
        # Register agent without children
        agent = registry.register_agent(
            name="lonely-agent",
            owner="lonely@example.com"
        )
        
        children = registry.get_children(agent.agent_id)
        assert len(children) == 0

    def test_get_descendants(self, temp_dir):
        """Test getting all descendants recursively."""
        registry_path = temp_dir / "agents.json"
        registry = AgentRegistry(str(registry_path))
        
        # Create hierarchy: grandparent -> parent -> child
        grandparent = registry.register_agent(
            name="grandparent",
            owner="gp@example.com"
        )
        
        parent = registry.register_agent(
            name="parent",
            owner="parent@example.com",
            parent_agent_id=grandparent.agent_id
        )
        
        child = registry.register_agent(
            name="child",
            owner="child@example.com",
            parent_agent_id=parent.agent_id
        )
        
        # Get descendants of grandparent
        descendants = registry.get_descendants(grandparent.agent_id)
        
        assert len(descendants) == 2
        descendant_ids = {d.agent_id for d in descendants}
        assert parent.agent_id in descendant_ids
        assert child.agent_id in descendant_ids

    def test_get_descendants_multiple_branches(self, temp_dir):
        """Test getting descendants with multiple branches."""
        registry_path = temp_dir / "agents.json"
        registry = AgentRegistry(str(registry_path))
        
        # Create hierarchy with multiple branches
        root = registry.register_agent(
            name="root",
            owner="root@example.com"
        )
        
        # First branch
        child1 = registry.register_agent(
            name="child-1",
            owner="child1@example.com",
            parent_agent_id=root.agent_id
        )
        grandchild1 = registry.register_agent(
            name="grandchild-1",
            owner="gc1@example.com",
            parent_agent_id=child1.agent_id
        )
        
        # Second branch
        child2 = registry.register_agent(
            name="child-2",
            owner="child2@example.com",
            parent_agent_id=root.agent_id
        )
        grandchild2 = registry.register_agent(
            name="grandchild-2",
            owner="gc2@example.com",
            parent_agent_id=child2.agent_id
        )
        
        # Get all descendants
        descendants = registry.get_descendants(root.agent_id)
        
        assert len(descendants) == 4
        descendant_ids = {d.agent_id for d in descendants}
        assert child1.agent_id in descendant_ids
        assert child2.agent_id in descendant_ids
        assert grandchild1.agent_id in descendant_ids
        assert grandchild2.agent_id in descendant_ids

    def test_parent_child_persistence(self, temp_dir):
        """Test that parent-child relationships are persisted."""
        registry_path = temp_dir / "agents.json"
        
        # Create first registry and register agents
        registry1 = AgentRegistry(str(registry_path))
        parent = registry1.register_agent(
            name="parent",
            owner="parent@example.com"
        )
        child = registry1.register_agent(
            name="child",
            owner="child@example.com",
            parent_agent_id=parent.agent_id
        )
        
        # Create second registry (should load from disk)
        registry2 = AgentRegistry(str(registry_path))
        
        # Verify parent-child relationship was loaded
        loaded_child = registry2.get_agent(child.agent_id)
        assert loaded_child is not None
        assert loaded_child.parent_agent_id == parent.agent_id
        
        # Verify get_children works after loading
        children = registry2.get_children(parent.agent_id)
        assert len(children) == 1
        assert children[0].agent_id == child.agent_id
