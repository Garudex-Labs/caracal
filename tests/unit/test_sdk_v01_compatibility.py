"""
Unit tests for v0.1 SDK API backward compatibility with v0.2.

Tests that all v0.1 SDK APIs continue to work unchanged in v0.2.
This ensures existing agent code doesn't break when upgrading.

Feature: caracal-core-v02
Requirements: 20.1, 20.2, 20.3, 20.7
"""

from decimal import Decimal
from pathlib import Path
import warnings

import pytest

from caracal.exceptions import BudgetExceededError, ConnectionError
from caracal.sdk.client import CaracalClient
from caracal.sdk.context import BudgetCheckContext


class TestV01ContextManagerCompatibility:
    """Test that v0.1 context manager interface works unchanged in v0.2."""
    
    def test_budget_check_context_manager_interface(self, temp_dir, sample_pricebook_path):
        """
        Test that BudgetCheckContext works with v0.1 interface.
        
        Requirements: 20.1, 20.3
        """
        # Create v0.1-style config
        config_path = temp_dir / "config.yaml"
        config_content = f"""
storage:
  agent_registry: {temp_dir}/agents.json
  policy_store: {temp_dir}/policies.json
  ledger: {temp_dir}/ledger.jsonl
  pricebook: {sample_pricebook_path}
  backup_dir: {temp_dir}/backups
  backup_count: 3
"""
        config_path.write_text(config_content)
        
        # Initialize client
        client = CaracalClient(config_path=str(config_path))
        
        # Register agent and create policy
        agent = client.agent_registry.register_agent(
            name="v01-compat-agent",
            owner="test@example.com"
        )
        client.policy_store.create_policy(
            agent_id=agent.agent_id,
            limit_amount=Decimal("100.00"),
            time_window="daily"
        )
        
        # Test v0.1 context manager usage pattern
        execution_count = 0
        with client.budget_check(agent_id=agent.agent_id):
            execution_count += 1
            # Simulate work
            pass
        
        assert execution_count == 1
    
    def test_context_manager_raises_budget_exceeded_error(self, temp_dir, sample_pricebook_path):
        """
        Test that context manager raises BudgetExceededError on v0.1 pattern.
        
        Requirements: 20.1, 20.3
        """
        # Create config
        config_path = temp_dir / "config.yaml"
        config_content = f"""
storage:
  agent_registry: {temp_dir}/agents.json
  policy_store: {temp_dir}/policies.json
  ledger: {temp_dir}/ledger.jsonl
  pricebook: {sample_pricebook_path}
  backup_dir: {temp_dir}/backups
  backup_count: 3
"""
        config_path.write_text(config_content)
        
        client = CaracalClient(config_path=str(config_path))
        
        # Register agent with low budget
        agent = client.agent_registry.register_agent(
            name="low-budget-agent",
            owner="test@example.com"
        )
        client.policy_store.create_policy(
            agent_id=agent.agent_id,
            limit_amount=Decimal("0.01"),
            time_window="daily"
        )
        
        # Exhaust budget
        client.emit_event(
            agent_id=agent.agent_id,
            resource_type="openai.gpt4.input_tokens",
            quantity=Decimal("1000")
        )
        
        # v0.1 pattern: context manager should raise BudgetExceededError
        with pytest.raises(BudgetExceededError):
            with client.budget_check(agent_id=agent.agent_id):
                pass
    
    def test_context_manager_returns_self_on_enter(self, temp_dir, sample_pricebook_path):
        """
        Test that context manager __enter__ returns self (v0.1 behavior).
        
        Requirements: 20.1, 20.3
        """
        config_path = temp_dir / "config.yaml"
        config_content = f"""
storage:
  agent_registry: {temp_dir}/agents.json
  policy_store: {temp_dir}/policies.json
  ledger: {temp_dir}/ledger.jsonl
  pricebook: {sample_pricebook_path}
  backup_dir: {temp_dir}/backups
  backup_count: 3
"""
        config_path.write_text(config_content)
        
        client = CaracalClient(config_path=str(config_path))
        
        agent = client.agent_registry.register_agent(
            name="test-agent",
            owner="test@example.com"
        )
        client.policy_store.create_policy(
            agent_id=agent.agent_id,
            limit_amount=Decimal("100.00"),
            time_window="daily"
        )
        
        # v0.1 pattern: can use 'as' clause
        with client.budget_check(agent_id=agent.agent_id) as ctx:
            assert isinstance(ctx, BudgetCheckContext)
            assert ctx.agent_id == agent.agent_id
    
    def test_context_manager_does_not_suppress_exceptions(self, temp_dir, sample_pricebook_path):
        """
        Test that context manager doesn't suppress exceptions (v0.1 behavior).
        
        Requirements: 20.1, 20.3
        """
        config_path = temp_dir / "config.yaml"
        config_content = f"""
storage:
  agent_registry: {temp_dir}/agents.json
  policy_store: {temp_dir}/policies.json
  ledger: {temp_dir}/ledger.jsonl
  pricebook: {sample_pricebook_path}
  backup_dir: {temp_dir}/backups
  backup_count: 3
"""
        config_path.write_text(config_content)
        
        client = CaracalClient(config_path=str(config_path))
        
        agent = client.agent_registry.register_agent(
            name="test-agent",
            owner="test@example.com"
        )
        client.policy_store.create_policy(
            agent_id=agent.agent_id,
            limit_amount=Decimal("100.00"),
            time_window="daily"
        )
        
        # v0.1 pattern: exceptions propagate
        with pytest.raises(ValueError) as exc_info:
            with client.budget_check(agent_id=agent.agent_id):
                raise ValueError("Test exception")
        
        assert "Test exception" in str(exc_info.value)


class TestV01ClientMethodsCompatibility:
    """Test that all v0.1 client methods work unchanged in v0.2."""
    
    def test_emit_event_method_signature(self, temp_dir, sample_pricebook_path):
        """
        Test that emit_event() works with v0.1 signature.
        
        Requirements: 20.1, 20.2
        """
        config_path = temp_dir / "config.yaml"
        config_content = f"""
storage:
  agent_registry: {temp_dir}/agents.json
  policy_store: {temp_dir}/policies.json
  ledger: {temp_dir}/ledger.jsonl
  pricebook: {sample_pricebook_path}
  backup_dir: {temp_dir}/backups
  backup_count: 3
"""
        config_path.write_text(config_content)
        
        client = CaracalClient(config_path=str(config_path))
        
        agent = client.agent_registry.register_agent(
            name="emit-test-agent",
            owner="test@example.com"
        )
        
        # v0.1 signature: agent_id, resource_type, quantity, metadata (optional)
        client.emit_event(
            agent_id=agent.agent_id,
            resource_type="openai.gpt4.input_tokens",
            quantity=Decimal("1000")
        )
        
        # With metadata
        client.emit_event(
            agent_id=agent.agent_id,
            resource_type="openai.gpt4.output_tokens",
            quantity=Decimal("500"),
            metadata={"model": "gpt-4", "request_id": "req_123"}
        )
        
        # Verify events recorded
        events = client.ledger_query.get_events(agent_id=agent.agent_id)
        assert len(events) == 2
    
    def test_check_budget_method_signature(self, temp_dir, sample_pricebook_path):
        """
        Test that check_budget() works with v0.1 signature.
        
        Requirements: 20.1, 20.2
        """
        config_path = temp_dir / "config.yaml"
        config_content = f"""
storage:
  agent_registry: {temp_dir}/agents.json
  policy_store: {temp_dir}/policies.json
  ledger: {temp_dir}/ledger.jsonl
  pricebook: {sample_pricebook_path}
  backup_dir: {temp_dir}/backups
  backup_count: 3
"""
        config_path.write_text(config_content)
        
        client = CaracalClient(config_path=str(config_path))
        
        agent = client.agent_registry.register_agent(
            name="check-test-agent",
            owner="test@example.com"
        )
        client.policy_store.create_policy(
            agent_id=agent.agent_id,
            limit_amount=Decimal("100.00"),
            time_window="daily"
        )
        
        # v0.1 signature: agent_id -> bool
        result = client.check_budget(agent_id=agent.agent_id)
        assert isinstance(result, bool)
        assert result is True
    
    def test_get_remaining_budget_method_signature(self, temp_dir, sample_pricebook_path):
        """
        Test that get_remaining_budget() works with v0.1 signature.
        
        Requirements: 20.1, 20.2
        """
        config_path = temp_dir / "config.yaml"
        config_content = f"""
storage:
  agent_registry: {temp_dir}/agents.json
  policy_store: {temp_dir}/policies.json
  ledger: {temp_dir}/ledger.jsonl
  pricebook: {sample_pricebook_path}
  backup_dir: {temp_dir}/backups
  backup_count: 3
"""
        config_path.write_text(config_content)
        
        client = CaracalClient(config_path=str(config_path))
        
        agent = client.agent_registry.register_agent(
            name="remaining-test-agent",
            owner="test@example.com"
        )
        client.policy_store.create_policy(
            agent_id=agent.agent_id,
            limit_amount=Decimal("100.00"),
            time_window="daily"
        )
        
        # v0.1 signature: agent_id -> Optional[Decimal]
        remaining = client.get_remaining_budget(agent_id=agent.agent_id)
        assert remaining is not None
        assert isinstance(remaining, Decimal)
        assert remaining == Decimal("100.00")
    
    def test_budget_check_method_returns_context(self, temp_dir, sample_pricebook_path):
        """
        Test that budget_check() returns BudgetCheckContext (v0.1 behavior).
        
        Requirements: 20.1, 20.2, 20.3
        """
        config_path = temp_dir / "config.yaml"
        config_content = f"""
storage:
  agent_registry: {temp_dir}/agents.json
  policy_store: {temp_dir}/policies.json
  ledger: {temp_dir}/ledger.jsonl
  pricebook: {sample_pricebook_path}
  backup_dir: {temp_dir}/backups
  backup_count: 3
"""
        config_path.write_text(config_content)
        
        client = CaracalClient(config_path=str(config_path))
        
        agent = client.agent_registry.register_agent(
            name="context-test-agent",
            owner="test@example.com"
        )
        
        # v0.1 signature: agent_id -> BudgetCheckContext
        context = client.budget_check(agent_id=agent.agent_id)
        assert isinstance(context, BudgetCheckContext)
        assert context.client is client
        assert context.agent_id == agent.agent_id


class TestV01ClientInitializationCompatibility:
    """Test that v0.1 client initialization patterns work in v0.2."""
    
    def test_client_init_with_config_path(self, temp_dir, sample_pricebook_path):
        """
        Test that CaracalClient(config_path=...) works (v0.1 pattern).
        
        Requirements: 20.1, 20.2
        """
        config_path = temp_dir / "config.yaml"
        config_content = f"""
storage:
  agent_registry: {temp_dir}/agents.json
  policy_store: {temp_dir}/policies.json
  ledger: {temp_dir}/ledger.jsonl
  pricebook: {sample_pricebook_path}
  backup_dir: {temp_dir}/backups
  backup_count: 3
"""
        config_path.write_text(config_content)
        
        # v0.1 pattern: explicit config path
        client = CaracalClient(config_path=str(config_path))
        
        assert client is not None
        assert client.agent_registry is not None
        assert client.policy_store is not None
        assert client.ledger_writer is not None
        assert client.ledger_query is not None
        assert client.policy_evaluator is not None
        assert client.metering_collector is not None
    
    def test_client_init_without_config_path(self, temp_dir, sample_pricebook_path, monkeypatch):
        """
        Test that CaracalClient() works without config path (v0.1 pattern).
        
        Requirements: 20.1, 20.2
        """
        # Mock default config
        def mock_load_config(path):
            from caracal.config.settings import (
                CaracalConfig, StorageConfig, DefaultsConfig, 
                LoggingConfig, PerformanceConfig
            )
            return CaracalConfig(
                storage=StorageConfig(
                    agent_registry=str(temp_dir / "agents.json"),
                    policy_store=str(temp_dir / "policies.json"),
                    ledger=str(temp_dir / "ledger.jsonl"),
                    pricebook=str(sample_pricebook_path),
                    backup_dir=str(temp_dir / "backups"),
                    backup_count=3,
                ),
                defaults=DefaultsConfig(),
                logging=LoggingConfig(file=str(temp_dir / "caracal.log")),
                performance=PerformanceConfig(),
            )
        
        monkeypatch.setattr("caracal.sdk.client.load_config", mock_load_config)
        
        # v0.1 pattern: no config path (uses default)
        client = CaracalClient()
        
        assert client is not None
        assert client.agent_registry is not None
    
    def test_client_init_with_nonexistent_config_uses_defaults(self, temp_dir):
        """
        Test that client initialization uses defaults when config doesn't exist (v0.1 behavior).
        
        In v0.1, if a config file doesn't exist, the system uses default configuration
        and creates files in ~/.caracal/. This is the expected behavior.
        
        Requirements: 20.1, 20.2
        """
        # Nonexistent config path
        nonexistent_config = temp_dir / "nonexistent.yaml"
        
        # v0.1 behavior: uses defaults when config doesn't exist
        # This should succeed and use ~/.caracal/ as the default location
        client = CaracalClient(config_path=str(nonexistent_config))
        
        # Verify client initialized successfully
        assert client is not None
        assert client.agent_registry is not None
        assert client.policy_store is not None


class TestV01FailClosedSemantics:
    """Test that v0.1 fail-closed semantics are preserved in v0.2."""
    
    def test_check_budget_returns_false_on_no_policy(self, temp_dir, sample_pricebook_path):
        """
        Test that check_budget() returns False when no policy (v0.1 fail-closed).
        
        Requirements: 20.1, 20.2
        """
        config_path = temp_dir / "config.yaml"
        config_content = f"""
storage:
  agent_registry: {temp_dir}/agents.json
  policy_store: {temp_dir}/policies.json
  ledger: {temp_dir}/ledger.jsonl
  pricebook: {sample_pricebook_path}
  backup_dir: {temp_dir}/backups
  backup_count: 3
"""
        config_path.write_text(config_content)
        
        client = CaracalClient(config_path=str(config_path))
        
        agent = client.agent_registry.register_agent(
            name="no-policy-agent",
            owner="test@example.com"
        )
        
        # v0.1 fail-closed: returns False when no policy
        result = client.check_budget(agent_id=agent.agent_id)
        assert result is False
    
    def test_get_remaining_budget_returns_none_on_no_policy(self, temp_dir, sample_pricebook_path):
        """
        Test that get_remaining_budget() returns None when no policy (v0.1 fail-closed).
        
        Requirements: 20.1, 20.2
        """
        config_path = temp_dir / "config.yaml"
        config_content = f"""
storage:
  agent_registry: {temp_dir}/agents.json
  policy_store: {temp_dir}/policies.json
  ledger: {temp_dir}/ledger.jsonl
  pricebook: {sample_pricebook_path}
  backup_dir: {temp_dir}/backups
  backup_count: 3
"""
        config_path.write_text(config_content)
        
        client = CaracalClient(config_path=str(config_path))
        
        agent = client.agent_registry.register_agent(
            name="no-policy-agent",
            owner="test@example.com"
        )
        
        # v0.1 fail-closed: returns None when no policy
        result = client.get_remaining_budget(agent_id=agent.agent_id)
        assert result is None
    
    def test_context_manager_raises_on_no_policy(self, temp_dir, sample_pricebook_path):
        """
        Test that context manager raises BudgetExceededError when no policy (v0.1 fail-closed).
        
        Requirements: 20.1, 20.2, 20.3
        """
        config_path = temp_dir / "config.yaml"
        config_content = f"""
storage:
  agent_registry: {temp_dir}/agents.json
  policy_store: {temp_dir}/policies.json
  ledger: {temp_dir}/ledger.jsonl
  pricebook: {sample_pricebook_path}
  backup_dir: {temp_dir}/backups
  backup_count: 3
"""
        config_path.write_text(config_content)
        
        client = CaracalClient(config_path=str(config_path))
        
        agent = client.agent_registry.register_agent(
            name="no-policy-agent",
            owner="test@example.com"
        )
        
        # v0.1 fail-closed: raises BudgetExceededError when no policy
        with pytest.raises(BudgetExceededError):
            with client.budget_check(agent_id=agent.agent_id):
                pass


class TestV01WorkflowPatterns:
    """Test that common v0.1 workflow patterns work unchanged in v0.2."""
    
    def test_v01_pattern_check_then_emit(self, temp_dir, sample_pricebook_path):
        """
        Test v0.1 pattern: check budget, do work, emit event.
        
        Requirements: 20.1, 20.2
        """
        config_path = temp_dir / "config.yaml"
        config_content = f"""
storage:
  agent_registry: {temp_dir}/agents.json
  policy_store: {temp_dir}/policies.json
  ledger: {temp_dir}/ledger.jsonl
  pricebook: {sample_pricebook_path}
  backup_dir: {temp_dir}/backups
  backup_count: 3
"""
        config_path.write_text(config_content)
        
        client = CaracalClient(config_path=str(config_path))
        
        agent = client.agent_registry.register_agent(
            name="workflow-agent",
            owner="test@example.com"
        )
        client.policy_store.create_policy(
            agent_id=agent.agent_id,
            limit_amount=Decimal("100.00"),
            time_window="daily"
        )
        
        # v0.1 pattern: check, work, emit
        if client.check_budget(agent_id=agent.agent_id):
            # Do expensive work
            result = "api_call_result"
            
            # Emit event
            client.emit_event(
                agent_id=agent.agent_id,
                resource_type="openai.gpt4.input_tokens",
                quantity=Decimal("1000")
            )
        
        # Verify event recorded
        events = client.ledger_query.get_events(agent_id=agent.agent_id)
        assert len(events) == 1
    
    def test_v01_pattern_context_manager_with_manual_emit(self, temp_dir, sample_pricebook_path):
        """
        Test v0.1 pattern: context manager with manual event emission.
        
        Requirements: 20.1, 20.2, 20.3
        """
        config_path = temp_dir / "config.yaml"
        config_content = f"""
storage:
  agent_registry: {temp_dir}/agents.json
  policy_store: {temp_dir}/policies.json
  ledger: {temp_dir}/ledger.jsonl
  pricebook: {sample_pricebook_path}
  backup_dir: {temp_dir}/backups
  backup_count: 3
"""
        config_path.write_text(config_content)
        
        client = CaracalClient(config_path=str(config_path))
        
        agent = client.agent_registry.register_agent(
            name="context-workflow-agent",
            owner="test@example.com"
        )
        client.policy_store.create_policy(
            agent_id=agent.agent_id,
            limit_amount=Decimal("100.00"),
            time_window="daily"
        )
        
        # v0.1 pattern: context manager + manual emit
        with client.budget_check(agent_id=agent.agent_id):
            # Do expensive work
            tokens_used = 1000
            
            # Manually emit event
            client.emit_event(
                agent_id=agent.agent_id,
                resource_type="openai.gpt4.input_tokens",
                quantity=Decimal(str(tokens_used))
            )
        
        # Verify event recorded
        events = client.ledger_query.get_events(agent_id=agent.agent_id)
        assert len(events) == 1
    
    def test_v01_pattern_get_remaining_budget_before_operation(self, temp_dir, sample_pricebook_path):
        """
        Test v0.1 pattern: check remaining budget before operation.
        
        Requirements: 20.1, 20.2
        """
        config_path = temp_dir / "config.yaml"
        config_content = f"""
storage:
  agent_registry: {temp_dir}/agents.json
  policy_store: {temp_dir}/policies.json
  ledger: {temp_dir}/ledger.jsonl
  pricebook: {sample_pricebook_path}
  backup_dir: {temp_dir}/backups
  backup_count: 3
"""
        config_path.write_text(config_content)
        
        client = CaracalClient(config_path=str(config_path))
        
        agent = client.agent_registry.register_agent(
            name="remaining-workflow-agent",
            owner="test@example.com"
        )
        client.policy_store.create_policy(
            agent_id=agent.agent_id,
            limit_amount=Decimal("100.00"),
            time_window="daily"
        )
        
        # v0.1 pattern: check remaining budget
        remaining = client.get_remaining_budget(agent_id=agent.agent_id)
        
        if remaining and remaining > Decimal("10.00"):
            # Proceed with expensive operation
            client.emit_event(
                agent_id=agent.agent_id,
                resource_type="openai.gpt4.input_tokens",
                quantity=Decimal("1000")
            )
        
        # Verify event recorded
        events = client.ledger_query.get_events(agent_id=agent.agent_id)
        assert len(events) == 1


class TestV01DeprecationWarnings:
    """Test that deprecation warnings are emitted for v0.1-only features."""
    
    def test_file_based_storage_emits_deprecation_warning(self, temp_dir, sample_pricebook_path):
        """
        Test that using file-based storage emits deprecation warnings.
        
        Requirements: 20.7
        """
        config_path = temp_dir / "config.yaml"
        config_content = f"""
storage:
  agent_registry: {temp_dir}/agents.json
  policy_store: {temp_dir}/policies.json
  ledger: {temp_dir}/ledger.jsonl
  pricebook: {sample_pricebook_path}
  backup_dir: {temp_dir}/backups
  backup_count: 3
"""
        config_path.write_text(config_content)
        
        # Initialize client and expect deprecation warnings
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            client = CaracalClient(config_path=str(config_path))
            
            # Should have 3 deprecation warnings (agent_registry, policy_store, ledger)
            deprecation_warnings = [warning for warning in w if issubclass(warning.category, DeprecationWarning)]
            assert len(deprecation_warnings) == 3
            
            # Check warning messages
            warning_messages = [str(warning.message) for warning in deprecation_warnings]
            assert any("agent registry" in msg.lower() for msg in warning_messages)
            assert any("policy store" in msg.lower() for msg in warning_messages)
            assert any("ledger" in msg.lower() for msg in warning_messages)
            
            # All warnings should mention v0.3 removal
            assert all("v0.3" in msg for msg in warning_messages)
            
            # All warnings should mention PostgreSQL migration
            assert all("PostgreSQL" in msg for msg in warning_messages)
    
    def test_deprecation_warning_includes_migration_guide_link(self, temp_dir, sample_pricebook_path):
        """
        Test that deprecation warnings include link to migration guide.
        
        Requirements: 20.7
        """
        config_path = temp_dir / "config.yaml"
        config_content = f"""
storage:
  agent_registry: {temp_dir}/agents.json
  policy_store: {temp_dir}/policies.json
  ledger: {temp_dir}/ledger.jsonl
  pricebook: {sample_pricebook_path}
  backup_dir: {temp_dir}/backups
  backup_count: 3
"""
        config_path.write_text(config_content)
        
        # Initialize client and check warning content
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            client = CaracalClient(config_path=str(config_path))
            
            # Check that warnings include migration guide link
            deprecation_warnings = [warning for warning in w if issubclass(warning.category, DeprecationWarning)]
            warning_messages = [str(warning.message) for warning in deprecation_warnings]
            
            # All warnings should include migration guide link
            assert all("migration" in msg.lower() for msg in warning_messages)
            assert all("v0.1-to-v0.2" in msg for msg in warning_messages)
