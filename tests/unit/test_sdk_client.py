"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for SDK client.

Tests the CaracalClient class for configuration loading, component initialization,
event emission, and fail-closed semantics.
"""

from decimal import Decimal
from pathlib import Path

import pytest

from caracal.exceptions import ConnectionError
from caracal.sdk.client import CaracalClient


class TestCaracalClient:
    """Test CaracalClient class."""

    def test_client_initialization_with_config(self, temp_dir, make_config_yaml):
        """Test initializing client with configuration file."""
        # Create config file using helper that includes merkle settings
        config_path = temp_dir / "config.yaml"
        config_content = make_config_yaml()
        config_path.write_text(config_content)
        
        # Initialize client
        client = CaracalClient(config_path=str(config_path))
        
        # Verify components are initialized
        assert client.agent_registry is not None
        assert client.policy_store is not None
        assert client.ledger_writer is not None
        assert client.ledger_query is not None
        assert client.policy_evaluator is not None
        assert client.metering_collector is not None

    def test_client_initialization_with_default_config(self, temp_dir, monkeypatch):
        """Test initializing client with default configuration."""
        # Mock the default config path to use temp directory
        def mock_get_default_config():
            from caracal.config.settings import CaracalConfig, StorageConfig, DefaultsConfig, LoggingConfig, PerformanceConfig
            return CaracalConfig(
                storage=StorageConfig(
                    agent_registry=str(temp_dir / "agents.json"),
                    policy_store=str(temp_dir / "policies.json"),
                    ledger=str(temp_dir / "ledger.jsonl"),
                    backup_dir=str(temp_dir / "backups"),
                    backup_count=3,
                ),
                defaults=DefaultsConfig(),
                logging=LoggingConfig(file=str(temp_dir / "caracal.log")),
                performance=PerformanceConfig(),
            )
        
        monkeypatch.setattr("caracal.sdk.client.load_config", lambda x: mock_get_default_config())
        
        # Initialize client without config path
        client = CaracalClient()
        
        # Verify components are initialized
        assert client.agent_registry is not None
        assert client.policy_store is not None

    def test_emit_event(self, temp_dir):
        """Test emitting a metering event."""
        # Create config
        config_path = temp_dir / "config.yaml"
        config_content = f"""
storage:
  agent_registry: {temp_dir}/agents.json
  policy_store: {temp_dir}/policies.json
  ledger: {temp_dir}/ledger.jsonl
  backup_dir: {temp_dir}/backups
  backup_count: 3
"""
        config_path.write_text(config_content)
        
        # Initialize client
        client = CaracalClient(config_path=str(config_path))
        
        # Register an agent first
        agent = client.agent_registry.register_agent(
            name="test-agent",
            owner="test@example.com"
        )
        
        # Emit event
        client.emit_event(
            agent_id=agent.agent_id,
            resource_type="openai.gpt-5.2.input_tokens",
            quantity=Decimal("10"),
            metadata={"model": "gpt-5.2"}
        )
        
        # Verify event was written to ledger
        ledger_path = temp_dir / "ledger.jsonl"
        assert ledger_path.exists()
        
        # Read ledger and verify event
        with open(ledger_path, 'r') as f:
            lines = f.readlines()
        
        assert len(lines) == 1
        
        import json
        event_data = json.loads(lines[0])
        assert event_data["agent_id"] == agent.agent_id
        assert event_data["resource_type"] == "openai.gpt-5.2.input_tokens"
        assert event_data["quantity"] == "10"
        # Cost should be 10 * 1.75 = 17.50
        assert event_data["cost"] == "17.50"
        assert Decimal(event_data["cost"]) == Decimal("17.50")

    def test_emit_event_with_metadata(self, temp_dir):
        """Test emitting event with metadata."""
        # Create config
        config_path = temp_dir / "config.yaml"
        config_content = f"""
storage:
  agent_registry: {temp_dir}/agents.json
  policy_store: {temp_dir}/policies.json
  ledger: {temp_dir}/ledger.jsonl
  backup_dir: {temp_dir}/backups
  backup_count: 3
"""
        config_path.write_text(config_content)
        
        # Initialize client
        client = CaracalClient(config_path=str(config_path))
        
        # Register an agent
        agent = client.agent_registry.register_agent(
            name="test-agent",
            owner="test@example.com"
        )
        
        # Emit event with metadata
        metadata = {
            "model": "gpt-4",
            "request_id": "req_123",
            "user": "test@example.com"
        }
        
        client.emit_event(
            agent_id=agent.agent_id,
            resource_type="openai.gpt-5.2.input_tokens",
            quantity=Decimal("1000"),
            metadata=metadata
        )
        
        # Verify metadata was stored
        ledger_path = temp_dir / "ledger.jsonl"
        with open(ledger_path, 'r') as f:
            import json
            event_data = json.loads(f.readline())
        
        assert event_data["metadata"] == metadata


class TestSDKV02Features:
    """Test v0.2 SDK features: create_child_agent, get_delegation_token."""

    def test_create_child_agent_without_budget(self, temp_dir):
        """Test creating a child agent without delegated budget."""
        # Create config
        config_path = temp_dir / "config.yaml"
        config_content = f"""
storage:
  agent_registry: {temp_dir}/agents.json
  policy_store: {temp_dir}/policies.json
  ledger: {temp_dir}/ledger.jsonl
  backup_dir: {temp_dir}/backups
  backup_count: 3
"""
        config_path.write_text(config_content)
        
        # Initialize client
        client = CaracalClient(config_path=str(config_path))
        
        # Register parent agent
        parent = client.agent_registry.register_agent(
            name="parent-agent",
            owner="parent@example.com"
        )
        
        # Create child agent without budget
        result = client.create_child_agent(
            parent_agent_id=parent.agent_id,
            child_name="child-agent-1",
            child_owner="child@example.com"
        )
        
        # Verify result
        assert "agent_id" in result
        assert result["name"] == "child-agent-1"
        assert result["owner"] == "child@example.com"
        assert result["parent_agent_id"] == parent.agent_id
        assert "delegation_token" not in result  # No token without budget
        assert "policy_id" not in result  # No policy without budget
        
        # Verify child agent was registered
        child = client.agent_registry.get_agent(result["agent_id"])
        assert child is not None
        assert child.name == "child-agent-1"
        assert child.parent_agent_id == parent.agent_id

    def test_create_child_agent_with_budget(self, temp_dir):
        """Test creating a child agent with delegated budget."""
        # Create config
        config_path = temp_dir / "config.yaml"
        config_content = f"""
storage:
  agent_registry: {temp_dir}/agents.json
  policy_store: {temp_dir}/policies.json
  ledger: {temp_dir}/ledger.jsonl
  backup_dir: {temp_dir}/backups
  backup_count: 3
"""
        config_path.write_text(config_content)
        
        # Initialize client
        client = CaracalClient(config_path=str(config_path))
        
        # Register parent agent
        parent = client.agent_registry.register_agent(
            name="parent-agent",
            owner="parent@example.com"
        )
        
        # Create child agent with budget
        result = client.create_child_agent(
            parent_agent_id=parent.agent_id,
            child_name="child-agent-2",
            child_owner="child@example.com",
            delegated_budget=Decimal("50.00"),
            budget_currency="USD",
            budget_time_window="daily"
        )
        
        # Verify result
        assert "agent_id" in result
        assert result["name"] == "child-agent-2"
        assert result["owner"] == "child@example.com"
        assert result["parent_agent_id"] == parent.agent_id
        assert "policy_id" in result
        assert result["delegated_budget"] == "50.00"
        assert result["budget_currency"] == "USD"
        assert result["budget_time_window"] == "daily"
        assert "delegation_token" in result
        
        # Verify child agent was registered
        child = client.agent_registry.get_agent(result["agent_id"])
        assert child is not None
        assert child.parent_agent_id == parent.agent_id
        
        # Verify policy was created
        policies = client.policy_store.get_policies(result["agent_id"])
        assert len(policies) == 1
        # Handle both string and Decimal types for limit_amount
        policy_limit = policies[0].limit_amount
        if isinstance(policy_limit, str):
            policy_limit = Decimal(policy_limit)
        assert policy_limit == Decimal("50.00")
        assert policies[0].delegated_from_agent_id == parent.agent_id

    def test_create_child_agent_with_metadata(self, temp_dir):
        """Test creating a child agent with custom metadata."""
        # Create config
        config_path = temp_dir / "config.yaml"
        config_content = f"""
storage:
  agent_registry: {temp_dir}/agents.json
  policy_store: {temp_dir}/policies.json
  ledger: {temp_dir}/ledger.jsonl
  backup_dir: {temp_dir}/backups
  backup_count: 3
"""
        config_path.write_text(config_content)
        
        # Initialize client
        client = CaracalClient(config_path=str(config_path))
        
        # Register parent agent
        parent = client.agent_registry.register_agent(
            name="parent-agent",
            owner="parent@example.com"
        )
        
        # Create child agent with metadata
        metadata = {"team": "engineering", "project": "test"}
        result = client.create_child_agent(
            parent_agent_id=parent.agent_id,
            child_name="child-agent-3",
            child_owner="child@example.com",
            metadata=metadata
        )
        
        # Verify child agent has metadata
        child = client.agent_registry.get_agent(result["agent_id"])
        assert child is not None
        assert "team" in child.metadata
        assert child.metadata["team"] == "engineering"

    def test_get_delegation_token(self, temp_dir):
        """Test generating a delegation token for existing child agent."""
        # Create config
        config_path = temp_dir / "config.yaml"
        config_content = f"""
storage:
  agent_registry: {temp_dir}/agents.json
  policy_store: {temp_dir}/policies.json
  ledger: {temp_dir}/ledger.jsonl
  backup_dir: {temp_dir}/backups
  backup_count: 3
"""
        config_path.write_text(config_content)
        
        # Initialize client
        client = CaracalClient(config_path=str(config_path))
        
        # Register parent and child agents
        parent = client.agent_registry.register_agent(
            name="parent-agent",
            owner="parent@example.com"
        )
        
        child = client.agent_registry.register_agent(
            name="child-agent",
            owner="child@example.com",
            parent_agent_id=parent.agent_id
        )
        
        # Generate delegation token
        token = client.get_delegation_token(
            parent_agent_id=parent.agent_id,
            child_agent_id=child.agent_id,
            spending_limit=Decimal("25.00"),
            currency="USD",
            expiration_seconds=3600
        )
        
        # Verify token was generated
        assert token is not None
        assert isinstance(token, str)
        assert len(token) > 0
        
        # Token should be a valid JWT (has 3 parts separated by dots)
        parts = token.split('.')
        assert len(parts) == 3

    def test_get_delegation_token_custom_operations(self, temp_dir):
        """Test generating delegation token with custom allowed operations."""
        # Create config
        config_path = temp_dir / "config.yaml"
        config_content = f"""
storage:
  agent_registry: {temp_dir}/agents.json
  policy_store: {temp_dir}/policies.json
  ledger: {temp_dir}/ledger.jsonl
  backup_dir: {temp_dir}/backups
  backup_count: 3
"""
        config_path.write_text(config_content)
        
        # Initialize client
        client = CaracalClient(config_path=str(config_path))
        
        # Register parent and child agents
        parent = client.agent_registry.register_agent(
            name="parent-agent",
            owner="parent@example.com"
        )
        
        child = client.agent_registry.register_agent(
            name="child-agent",
            owner="child@example.com",
            parent_agent_id=parent.agent_id
        )
        
        # Generate delegation token with custom operations
        token = client.get_delegation_token(
            parent_agent_id=parent.agent_id,
            child_agent_id=child.agent_id,
            spending_limit=Decimal("10.00"),
            allowed_operations=["api_call"]  # Only API calls, no MCP tools
        )
        
        # Verify token was generated
        assert token is not None
