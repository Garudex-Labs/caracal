"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for flow state management dataclasses.
"""

import pytest
from datetime import datetime

pytestmark = pytest.mark.unit


class TestOnboardingState:
    def test_default_not_completed(self):
        from caracal.flow.state import OnboardingState
        s = OnboardingState()
        assert s.completed is False
        assert s.completed_at is None

    def test_mark_step_complete_adds_to_list(self):
        from caracal.flow.state import OnboardingState
        s = OnboardingState()
        s.mark_step_complete("database")
        assert "database" in s.steps_completed

    def test_mark_step_complete_no_duplicates(self):
        from caracal.flow.state import OnboardingState
        s = OnboardingState()
        s.mark_step_complete("database")
        s.mark_step_complete("database")
        assert s.steps_completed.count("database") == 1

    def test_mark_step_skipped_adds_to_list(self):
        from caracal.flow.state import OnboardingState
        s = OnboardingState()
        s.mark_step_skipped("principal")
        assert "principal" in s.skipped_steps

    def test_mark_step_skipped_no_duplicates(self):
        from caracal.flow.state import OnboardingState
        s = OnboardingState()
        s.mark_step_skipped("principal")
        s.mark_step_skipped("principal")
        assert s.skipped_steps.count("principal") == 1

    def test_mark_complete_sets_flags(self):
        from caracal.flow.state import OnboardingState
        s = OnboardingState()
        before = datetime.utcnow().isoformat()
        s.mark_complete()
        assert s.completed is True
        assert s.completed_at is not None
        assert s.completed_at >= before


class TestSessionData:
    def test_default_screen_is_welcome(self):
        from caracal.flow.state import SessionData
        s = SessionData()
        assert s.current_screen == "welcome"

    def test_navigate_to_records_history(self):
        from caracal.flow.state import SessionData
        s = SessionData()
        s.navigate_to("dashboard")
        assert "welcome" in s.previous_screens
        assert s.current_screen == "dashboard"

    def test_navigate_to_same_screen_no_op(self):
        from caracal.flow.state import SessionData
        s = SessionData(current_screen="dashboard")
        s.navigate_to("dashboard")
        assert len(s.previous_screens) == 0

    def test_go_back_returns_previous_screen(self):
        from caracal.flow.state import SessionData
        s = SessionData()
        s.navigate_to("settings")
        result = s.go_back()
        assert result == "welcome"

    def test_go_back_when_empty_returns_current(self):
        from caracal.flow.state import SessionData
        s = SessionData(current_screen="home")
        result = s.go_back()
        assert result == "home"


class TestAuthoritySessionData:
    def test_set_and_clear_principal(self):
        from caracal.flow.state import AuthoritySessionData
        s = AuthoritySessionData()
        s.set_principal("pid_1")
        assert s.selected_principal_id == "pid_1"
        s.clear()
        assert s.selected_principal_id is None

    def test_set_mandate(self):
        from caracal.flow.state import AuthoritySessionData
        s = AuthoritySessionData()
        s.set_mandate("mid_1")
        assert s.selected_mandate_id == "mid_1"

    def test_set_policy(self):
        from caracal.flow.state import AuthoritySessionData
        s = AuthoritySessionData()
        s.set_policy("pol_1")
        assert s.selected_policy_id == "pol_1"

    def test_set_delegation_path(self):
        from caracal.flow.state import AuthoritySessionData
        s = AuthoritySessionData()
        s.set_delegation_path(["a", "b", "c"])
        assert s.current_delegation_path == ["a", "b", "c"]

    def test_clear_resets_all(self):
        from caracal.flow.state import AuthoritySessionData
        s = AuthoritySessionData(
            selected_principal_id="pid",
            selected_mandate_id="mid",
            selected_policy_id="pol",
            current_delegation_path=["x"],
        )
        s.clear()
        assert s.selected_principal_id is None
        assert s.selected_mandate_id is None
        assert s.selected_policy_id is None
        assert s.current_delegation_path == []


class TestFlowState:
    def test_defaults(self):
        from caracal.flow.state import FlowState
        state = FlowState()
        assert state.recent_actions == []
        assert state.favorite_commands == []

    def test_add_favorite_is_unique(self):
        from caracal.flow.state import FlowState
        state = FlowState()
        state.add_favorite("cmd_a")
        state.add_favorite("cmd_a")
        assert state.favorite_commands.count("cmd_a") == 1

    def test_remove_favorite(self):
        from caracal.flow.state import FlowState
        state = FlowState()
        state.add_favorite("cmd_b")
        state.remove_favorite("cmd_b")
        assert "cmd_b" not in state.favorite_commands

    def test_remove_nonexistent_favorite_is_noop(self):
        from caracal.flow.state import FlowState
        state = FlowState()
        state.remove_favorite("nonexistent")

    def test_add_recent_action_prepends(self):
        from caracal.flow.state import FlowState, RecentAction
        state = FlowState()
        a1 = RecentAction(action="a1", description="first", timestamp="2026-01-01", success=True)
        a2 = RecentAction(action="a2", description="second", timestamp="2026-01-02", success=True)
        state.add_recent_action(a1)
        state.add_recent_action(a2)
        assert state.recent_actions[0]["action"] == "a2"

    def test_add_recent_action_limits_history(self):
        from caracal.flow.state import FlowState, RecentAction
        state = FlowState()
        state.preferences.recent_limit = 3
        for i in range(5):
            a = RecentAction(action=f"a{i}", description="d", timestamp="2026-01-01", success=True)
            state.add_recent_action(a)
        assert len(state.recent_actions) == 3


class TestRecentAction:
    def test_create_returns_instance(self):
        from caracal.flow.state import RecentAction
        action = RecentAction.create("test_action", "A test action", success=True)
        assert action.action == "test_action"
        assert action.success is True
        assert action.timestamp is not None
