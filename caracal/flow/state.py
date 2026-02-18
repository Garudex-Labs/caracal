"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal Flow State Management.

Handles application state including:
- Current screen/context
- User preferences
- Session data
- Onboarding completion tracking
"""

import json
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path
from typing import Any, Optional


@dataclass
class OnboardingState:
    """Tracks onboarding wizard completion."""
    
    completed: bool = False
    completed_at: Optional[str] = None
    steps_completed: list[str] = field(default_factory=list)
    skipped_steps: list[str] = field(default_factory=list)
    
    def mark_step_complete(self, step: str) -> None:
        """Mark a step as completed."""
        if step not in self.steps_completed:
            self.steps_completed.append(step)
    
    def mark_step_skipped(self, step: str) -> None:
        """Mark a step as skipped."""
        if step not in self.skipped_steps:
            self.skipped_steps.append(step)
    
    def mark_complete(self) -> None:
        """Mark the entire onboarding as complete."""
        self.completed = True
        self.completed_at = datetime.utcnow().isoformat()


@dataclass
class UserPreferences:
    """User UI preferences."""
    
    compact_mode: bool = False       # Use compact banners
    show_hints: bool = True          # Show keyboard hints
    confirm_destructive: bool = True # Confirm destructive actions
    default_format: str = "table"    # table or json
    recent_limit: int = 10           # Number of recent items to show


@dataclass
class SessionData:
    """Current session data (not persisted)."""
    
    current_screen: str = "welcome"
    previous_screens: list[str] = field(default_factory=list)
    selected_principal_id: Optional[str] = None
    selected_policy_id: Optional[str] = None
    temp_data: dict[str, Any] = field(default_factory=dict)
    
    def navigate_to(self, screen: str) -> None:
        """Navigate to a new screen, tracking history."""
        if self.current_screen != screen:
            self.previous_screens.append(self.current_screen)
            self.current_screen = screen
            # Keep history limited
            if len(self.previous_screens) > 20:
                self.previous_screens = self.previous_screens[-20:]
    
    def go_back(self) -> str:
        """Go back to previous screen."""
        if self.previous_screens:
            self.current_screen = self.previous_screens.pop()
        return self.current_screen


@dataclass
class AuthoritySessionData:
    """Authority management session data (not persisted)."""
    
    selected_principal_id: Optional[str] = None
    selected_mandate_id: Optional[str] = None
    selected_policy_id: Optional[str] = None
    current_delegation_chain: list[str] = field(default_factory=list)
    
    def set_principal(self, principal_id: str) -> None:
        """Set the currently selected principal."""
        self.selected_principal_id = principal_id
    
    def set_mandate(self, mandate_id: str) -> None:
        """Set the currently selected mandate."""
        self.selected_mandate_id = mandate_id
    
    def set_policy(self, policy_id: str) -> None:
        """Set the currently selected policy."""
        self.selected_policy_id = policy_id
    
    def set_delegation_chain(self, chain: list[str]) -> None:
        """Set the current delegation chain."""
        self.current_delegation_chain = chain
    
    def clear(self) -> None:
        """Clear all authority session data."""
        self.selected_principal_id = None
        self.selected_mandate_id = None
        self.selected_policy_id = None
        self.current_delegation_chain = []


@dataclass
class RecentAction:
    """Record of a recent action."""
    
    action: str
    description: str
    timestamp: str
    success: bool = True
    
    @classmethod
    def create(cls, action: str, description: str, success: bool = True) -> "RecentAction":
        """Create a new action record."""
        return cls(
            action=action,
            description=description,
            timestamp=datetime.utcnow().isoformat(),
            success=success,
        )


@dataclass 
class FlowState:
    """Complete application state."""
    
    onboarding: OnboardingState = field(default_factory=OnboardingState)
    preferences: UserPreferences = field(default_factory=UserPreferences)
    session: SessionData = field(default_factory=SessionData)
    authority_session: AuthoritySessionData = field(default_factory=AuthoritySessionData)
    recent_actions: list[dict] = field(default_factory=list)
    favorite_commands: list[str] = field(default_factory=list)
    
    def add_recent_action(self, action: RecentAction) -> None:
        """Add a recent action to history."""
        self.recent_actions.insert(0, asdict(action))
        # Keep only last N actions
        limit = self.preferences.recent_limit
        if len(self.recent_actions) > limit:
            self.recent_actions = self.recent_actions[:limit]
    
    def add_favorite(self, command: str) -> None:
        """Add a command to favorites."""
        if command not in self.favorite_commands:
            self.favorite_commands.append(command)
    
    def remove_favorite(self, command: str) -> None:
        """Remove a command from favorites."""
        if command in self.favorite_commands:
            self.favorite_commands.remove(command)


class StatePersistence:
    """Handles loading and saving state to disk."""
    
    def __init__(self, path: Optional[Path] = None, workspace: "Optional[WorkspaceManager]" = None):
        if path:
            self.path = path
        else:
            from caracal.flow.workspace import get_workspace
            ws = workspace or get_workspace()
            self.path = ws.state_path
    
    def load(self) -> FlowState:
        """Load state from disk, or return defaults."""
        try:
            if self.path.exists():
                data = json.loads(self.path.read_text())
                return self._deserialize(data)
        except (json.JSONDecodeError, KeyError, TypeError) as e:
            # Invalid state file, start fresh
            pass
        return FlowState()
    
    def save(self, state: FlowState) -> None:
        """Save state to disk."""
        # Ensure directory exists
        self.path.parent.mkdir(parents=True, exist_ok=True)
        
        # Serialize and save (exclude session data)
        data = self._serialize(state)
        self.path.write_text(json.dumps(data, indent=2))
    
    def _serialize(self, state: FlowState) -> dict:
        """Serialize state to dict (excludes session data)."""
        return {
            "version": 1,
            "onboarding": asdict(state.onboarding),
            "preferences": asdict(state.preferences),
            "recent_actions": state.recent_actions,
            "favorite_commands": state.favorite_commands,
        }
    
    def _deserialize(self, data: dict) -> FlowState:
        """Deserialize state from dict."""
        state = FlowState()
        
        if "onboarding" in data:
            ob = data["onboarding"]
            state.onboarding = OnboardingState(
                completed=ob.get("completed", False),
                completed_at=ob.get("completed_at"),
                steps_completed=ob.get("steps_completed", []),
                skipped_steps=ob.get("skipped_steps", []),
            )
        
        if "preferences" in data:
            prefs = data["preferences"]
            state.preferences = UserPreferences(
                compact_mode=prefs.get("compact_mode", False),
                show_hints=prefs.get("show_hints", True),
                confirm_destructive=prefs.get("confirm_destructive", True),
                default_format=prefs.get("default_format", "table"),
                recent_limit=prefs.get("recent_limit", 10),
            )
        
        state.recent_actions = data.get("recent_actions", [])
        state.favorite_commands = data.get("favorite_commands", [])
        
        return state
    
    def reset(self) -> None:
        """Reset state to defaults."""
        if self.path.exists():
            self.path.unlink()
