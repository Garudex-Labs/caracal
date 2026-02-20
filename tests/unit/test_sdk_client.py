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


# ===========================================================================
# v2 CaracalClient & CaracalBuilder tests (SDK v2 architecture)
# ===========================================================================


class TestCaracalClientV2:
    """Test the new v2 CaracalClient and CaracalBuilder."""

    def test_init_with_api_key(self):
        """CaracalClient(api_key=...) creates v2 client with HttpAdapter."""
        from caracal.sdk.client import CaracalClient, SDKConfigurationError
        from caracal.sdk.adapters.http import HttpAdapter

        client = CaracalClient(api_key="sk_test_123")
        assert not client._is_legacy
        assert isinstance(client._adapter, HttpAdapter)
        assert client._adapter._api_key == "sk_test_123"
        client.close()

    def test_init_with_custom_base_url(self):
        """CaracalClient(api_key=, base_url=) uses custom URL."""
        from caracal.sdk.client import CaracalClient
        from caracal.sdk.adapters.http import HttpAdapter

        client = CaracalClient(api_key="sk_test_456", base_url="https://api.example.com")
        assert isinstance(client._adapter, HttpAdapter)
        assert client._adapter._base_url == "https://api.example.com"
        client.close()

    def test_init_with_mock_adapter(self):
        """CaracalClient with custom adapter skips api_key requirement."""
        from caracal.sdk.client import CaracalClient
        from caracal.sdk.adapters.mock import MockAdapter

        mock = MockAdapter(responses={})
        client = CaracalClient(adapter=mock)
        assert not client._is_legacy
        assert client._adapter is mock
        client.close()

    def test_init_requires_api_key_or_adapter(self):
        """CaracalClient without api_key or adapter raises SDKConfigurationError."""
        from caracal.sdk.client import CaracalClient, SDKConfigurationError

        with pytest.raises(SDKConfigurationError, match="requires either"):
            CaracalClient()

    def test_context_returns_context_manager(self):
        """client.context is a ContextManager."""
        from caracal.sdk.client import CaracalClient
        from caracal.sdk.context import ContextManager

        client = CaracalClient(api_key="sk_test_ctx")
        assert isinstance(client.context, ContextManager)
        client.close()

    def test_context_checkout_returns_scoped_context(self):
        """client.context.checkout() returns ScopeContext with correct IDs."""
        from caracal.sdk.client import CaracalClient
        from caracal.sdk.context import ScopeContext

        client = CaracalClient(api_key="sk_test_scope")
        ctx = client.context.checkout(
            organization_id="org_1",
            workspace_id="ws_2",
            project_id="proj_3",
        )
        assert isinstance(ctx, ScopeContext)
        assert ctx.organization_id == "org_1"
        assert ctx.workspace_id == "ws_2"
        assert ctx.project_id == "proj_3"
        client.close()

    def test_agents_returns_agent_operations(self):
        """client.agents shortcut returns AgentOperations."""
        from caracal.sdk.client import CaracalClient
        from caracal.sdk.agents import AgentOperations

        client = CaracalClient(api_key="sk_test_agents")
        assert isinstance(client.agents, AgentOperations)
        client.close()

    def test_mandates_returns_mandate_operations(self):
        """client.mandates shortcut returns MandateOperations."""
        from caracal.sdk.client import CaracalClient
        from caracal.sdk.mandates import MandateOperations

        client = CaracalClient(api_key="sk_test_mandates")
        assert isinstance(client.mandates, MandateOperations)
        client.close()

    def test_use_installs_extension(self):
        """client.use(extension) calls install and chains."""
        from caracal.sdk.client import CaracalClient
        from caracal.sdk.extensions import CaracalExtension
        from caracal.sdk.hooks import HookRegistry

        class TestExtension(CaracalExtension):
            installed = False

            @property
            def name(self) -> str:
                return "test-ext"

            @property
            def version(self) -> str:
                return "1.0.0"

            def install(self, hooks: HookRegistry) -> None:
                TestExtension.installed = True

        client = CaracalClient(api_key="sk_test_ext")
        result = client.use(TestExtension())
        assert result is client  # chaining
        assert TestExtension.installed
        assert len(client._extensions) == 1
        client.close()

    def test_config_path_emits_deprecation_warning(self):
        """CaracalClient(config_path=...) emits DeprecationWarning."""
        from caracal.sdk.client import CaracalClient

        with pytest.warns(DeprecationWarning, match="deprecated"):
            try:
                CaracalClient(config_path="/nonexistent/config.yaml")
            except Exception:
                pass  # Expected — no valid config, but warning should fire


class TestCaracalBuilderV2:
    """Test the v2 CaracalBuilder fluent API."""

    def test_builder_basic_build(self):
        """Builder with api_key builds successfully."""
        from caracal.sdk.client import CaracalBuilder, CaracalClient

        client = CaracalBuilder().set_api_key("sk_build_1").build()
        assert isinstance(client, CaracalClient)
        assert not client._is_legacy
        client.close()

    def test_builder_custom_base_url(self):
        """Builder with custom base_url."""
        from caracal.sdk.client import CaracalBuilder
        from caracal.sdk.adapters.http import HttpAdapter

        client = (
            CaracalBuilder()
            .set_api_key("sk_build_2")
            .set_base_url("https://custom.api.io")
            .build()
        )
        assert isinstance(client._adapter, HttpAdapter)
        assert client._adapter._base_url == "https://custom.api.io"
        client.close()

    def test_builder_with_transport(self):
        """Builder with custom transport adapter."""
        from caracal.sdk.client import CaracalBuilder
        from caracal.sdk.adapters.mock import MockAdapter

        mock = MockAdapter(responses={})
        client = CaracalBuilder().set_transport(mock).build()
        assert client._adapter is mock
        client.close()

    def test_builder_with_extension(self):
        """Builder .use() queues extensions, build() installs them."""
        from caracal.sdk.client import CaracalBuilder
        from caracal.sdk.extensions import CaracalExtension
        from caracal.sdk.hooks import HookRegistry

        installed_hooks = []

        class BuilderExt(CaracalExtension):
            @property
            def name(self) -> str:
                return "builder-ext"

            @property
            def version(self) -> str:
                return "2.0.0"

            def install(self, hooks: HookRegistry) -> None:
                installed_hooks.append(hooks)

        client = (
            CaracalBuilder()
            .set_api_key("sk_ext_build")
            .use(BuilderExt())
            .build()
        )
        assert len(installed_hooks) == 1
        assert len(client._extensions) == 1
        client.close()

    def test_builder_fires_initialize_hooks(self):
        """Builder.build() fires on_initialize hooks."""
        from caracal.sdk.client import CaracalBuilder
        from caracal.sdk.extensions import CaracalExtension
        from caracal.sdk.hooks import HookRegistry

        init_called = []

        class InitExt(CaracalExtension):
            @property
            def name(self) -> str:
                return "init-ext"

            @property
            def version(self) -> str:
                return "1.0.0"

            def install(self, hooks: HookRegistry) -> None:
                hooks.on_initialize(lambda: init_called.append(True))

        client = (
            CaracalBuilder()
            .set_api_key("sk_init")
            .use(InitExt())
            .build()
        )
        assert len(init_called) == 1
        client.close()

    def test_builder_no_key_no_adapter_raises(self):
        """Builder without api_key or transport raises SDKConfigurationError."""
        from caracal.sdk.client import CaracalBuilder, SDKConfigurationError

        with pytest.raises(SDKConfigurationError, match="requires either"):
            CaracalBuilder().build()

    def test_builder_fluent_chaining(self):
        """All builder methods return self for chaining."""
        from caracal.sdk.client import CaracalBuilder

        builder = CaracalBuilder()
        assert builder.set_api_key("x") is builder
        assert builder.set_base_url("http://x") is builder
