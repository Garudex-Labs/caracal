"""
Integration tests for PolicyEvaluator with TimeWindowCalculator.

Tests policy evaluation with extended time windows (hourly, daily, weekly, monthly)
and both rolling and calendar window types.
"""

import pytest
from datetime import datetime, timedelta
from decimal import Decimal
from pathlib import Path
import tempfile
import os

from caracal.core.policy import PolicyStore, PolicyEvaluator
from caracal.core.ledger import LedgerWriter, LedgerQuery
from caracal.core.identity import AgentRegistry
from caracal.core.time_windows import TimeWindowCalculator


class TestPolicyEvaluatorWithTimeWindows:
    """Integration tests for PolicyEvaluator with TimeWindowCalculator."""
    
    def setup_method(self):
        """Set up test fixtures."""
        # Create temporary directory for test files
        self.temp_dir = tempfile.mkdtemp()
        
        # Create agent registry
        registry_path = Path(self.temp_dir) / "agents.json"
        self.agent_registry = AgentRegistry(str(registry_path))
        
        # Create test agent
        self.agent = self.agent_registry.register_agent("test-agent", "test-owner")
        
        # Create policy store
        policy_path = Path(self.temp_dir) / "policies.json"
        self.policy_store = PolicyStore(
            str(policy_path),
            agent_registry=self.agent_registry
        )
        
        # Create ledger
        ledger_path = Path(self.temp_dir) / "ledger.json"
        self.ledger_writer = LedgerWriter(str(ledger_path))
        self.ledger_query = LedgerQuery(str(ledger_path))
        
        # Create time window calculator
        self.time_calculator = TimeWindowCalculator()
        
        # Create policy evaluator with time window calculator
        self.policy_evaluator = PolicyEvaluator(
            self.policy_store,
            self.ledger_query,
            time_window_calculator=self.time_calculator
        )
    
    def teardown_method(self):
        """Clean up test files."""
        import shutil
        if os.path.exists(self.temp_dir):
            shutil.rmtree(self.temp_dir)
    
    def test_policy_evaluation_with_hourly_calendar_window(self):
        """Test policy evaluation with hourly calendar window."""
        # Create policy with hourly calendar window
        policy = self.policy_store.create_policy(
            agent_id=self.agent.agent_id,
            limit_amount=Decimal('100.00'),
            time_window='hourly',
            currency='USD'
        )
        
        # Set window_type attribute (v0.3)
        policy.window_type = 'calendar'
        
        # Use a fixed reference time
        reference_time = datetime(2024, 1, 15, 14, 30, 0)
        
        # Add spending within the current hour
        hour_start = datetime(2024, 1, 15, 14, 0, 0)
        self.ledger_writer.write_event(
            agent_id=self.agent.agent_id,
            resource_type='api_call',
            quantity=Decimal('1'),
            cost=Decimal('50.00'),
            currency='USD',
            timestamp=hour_start + timedelta(minutes=15)
        )
        
        # Check budget - should allow (50 spent, 50 remaining)
        decision = self.policy_evaluator.check_budget(
            self.agent.agent_id,
            estimated_cost=Decimal('30.00'),
            current_time=reference_time
        )
        
        assert decision.allowed is True
        assert decision.remaining_budget == Decimal('20.00')  # 100 - 50 - 30
    
    def test_policy_evaluation_with_daily_rolling_window(self):
        """Test policy evaluation with daily rolling window."""
        # Create policy with daily rolling window
        policy = self.policy_store.create_policy(
            agent_id=self.agent.agent_id,
            limit_amount=Decimal('200.00'),
            time_window='daily',
            currency='USD'
        )
        
        # Set window_type attribute (v0.3)
        policy.window_type = 'rolling'
        
        # Use a fixed reference time
        reference_time = datetime(2024, 1, 15, 14, 30, 0)
        
        # Add spending within the last 24 hours
        self.ledger_writer.write_event(
            agent_id=self.agent.agent_id,
            resource_type='api_call',
            quantity=Decimal('1'),
            cost=Decimal('100.00'),
            currency='USD',
            timestamp=reference_time - timedelta(hours=12)
        )
        
        # Add spending outside the rolling window (should not count)
        self.ledger_writer.write_event(
            agent_id=self.agent.agent_id,
            resource_type='api_call',
            quantity=Decimal('1'),
            cost=Decimal('50.00'),
            currency='USD',
            timestamp=reference_time - timedelta(hours=25)
        )
        
        # Check budget - should allow (100 spent in window, 100 remaining)
        decision = self.policy_evaluator.check_budget(
            self.agent.agent_id,
            estimated_cost=Decimal('50.00'),
            current_time=reference_time
        )
        
        assert decision.allowed is True
        assert decision.remaining_budget == Decimal('50.00')  # 200 - 100 - 50
    
    def test_policy_evaluation_with_weekly_calendar_window(self):
        """Test policy evaluation with weekly calendar window."""
        # Create policy with weekly calendar window
        policy = self.policy_store.create_policy(
            agent_id=self.agent.agent_id,
            limit_amount=Decimal('1000.00'),
            time_window='weekly',
            currency='USD'
        )
        
        # Set window_type attribute (v0.3)
        policy.window_type = 'calendar'
        
        # Use a fixed reference time (Wednesday, Jan 17, 2024)
        reference_time = datetime(2024, 1, 17, 14, 30, 0)
        
        # Add spending on Monday (start of week)
        monday = datetime(2024, 1, 15, 10, 0, 0)
        self.ledger_writer.write_event(
            agent_id=self.agent.agent_id,
            resource_type='api_call',
            quantity=Decimal('1'),
            cost=Decimal('300.00'),
            currency='USD',
            timestamp=monday
        )
        
        # Add spending on Tuesday
        tuesday = datetime(2024, 1, 16, 10, 0, 0)
        self.ledger_writer.write_event(
            agent_id=self.agent.agent_id,
            resource_type='api_call',
            quantity=Decimal('1'),
            cost=Decimal('200.00'),
            currency='USD',
            timestamp=tuesday
        )
        
        # Check budget - should allow (500 spent, 500 remaining)
        decision = self.policy_evaluator.check_budget(
            self.agent.agent_id,
            estimated_cost=Decimal('100.00'),
            current_time=reference_time
        )
        
        assert decision.allowed is True
        assert decision.remaining_budget == Decimal('400.00')  # 1000 - 500 - 100
    
    def test_policy_evaluation_with_monthly_rolling_window(self):
        """Test policy evaluation with monthly rolling window."""
        # Create policy with monthly rolling window
        policy = self.policy_store.create_policy(
            agent_id=self.agent.agent_id,
            limit_amount=Decimal('5000.00'),
            time_window='monthly',
            currency='USD'
        )
        
        # Set window_type attribute (v0.3)
        policy.window_type = 'rolling'
        
        # Use a fixed reference time
        reference_time = datetime(2024, 1, 15, 14, 30, 0)
        
        # Add spending within the last 30 days
        self.ledger_writer.write_event(
            agent_id=self.agent.agent_id,
            resource_type='api_call',
            quantity=Decimal('1'),
            cost=Decimal('2000.00'),
            currency='USD',
            timestamp=reference_time - timedelta(days=15)
        )
        
        # Add spending outside the rolling window (should not count)
        self.ledger_writer.write_event(
            agent_id=self.agent.agent_id,
            resource_type='api_call',
            quantity=Decimal('1'),
            cost=Decimal('1000.00'),
            currency='USD',
            timestamp=reference_time - timedelta(days=31)
        )
        
        # Check budget - should allow (2000 spent in window, 3000 remaining)
        decision = self.policy_evaluator.check_budget(
            self.agent.agent_id,
            estimated_cost=Decimal('1000.00'),
            current_time=reference_time
        )
        
        assert decision.allowed is True
        assert decision.remaining_budget == Decimal('2000.00')  # 5000 - 2000 - 1000
    
    def test_policy_evaluation_budget_exceeded(self):
        """Test policy evaluation when budget is exceeded."""
        # Create policy with daily calendar window
        policy = self.policy_store.create_policy(
            agent_id=self.agent.agent_id,
            limit_amount=Decimal('100.00'),
            time_window='daily',
            currency='USD'
        )
        
        # Set window_type attribute (v0.3)
        policy.window_type = 'calendar'
        
        # Use a fixed reference time
        reference_time = datetime(2024, 1, 15, 14, 30, 0)
        
        # Add spending that exceeds the limit
        day_start = datetime(2024, 1, 15, 0, 0, 0)
        self.ledger_writer.write_event(
            agent_id=self.agent.agent_id,
            resource_type='api_call',
            quantity=Decimal('1'),
            cost=Decimal('90.00'),
            currency='USD',
            timestamp=day_start + timedelta(hours=10)
        )
        
        # Check budget with cost that would exceed limit - should deny
        decision = self.policy_evaluator.check_budget(
            self.agent.agent_id,
            estimated_cost=Decimal('20.00'),
            current_time=reference_time
        )
        
        assert decision.allowed is False
        assert 'Insufficient budget' in decision.reason
