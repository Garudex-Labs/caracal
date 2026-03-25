"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Mode management for Caracal deployment architecture.

Handles detection and management of installation modes (Development vs User).
"""

from enum import Enum
from pathlib import Path
from typing import Optional


class Mode(str, Enum):
    """Installation mode enumeration."""
    DEVELOPMENT = "dev"
    USER = "user"


class ModeManager:
    """
    Manages installation mode detection and configuration.
    
    Provides methods to detect, set, and query the current installation mode.
    Mode detection follows a fallback chain: environment variable → config file → default.
    """
    
    def __init__(self):
        """Initialize the mode manager."""
        pass
    
    def get_mode(self) -> Mode:
        """
        Returns current installation mode (DEV or USER).
        
        Returns:
            Current installation mode
        """
        raise NotImplementedError("To be implemented in task 2.1")
    
    def set_mode(self, mode: Mode) -> None:
        """
        Sets installation mode and updates configuration.
        
        Args:
            mode: Installation mode to set
        """
        raise NotImplementedError("To be implemented in task 2.1")
    
    def is_dev_mode(self) -> bool:
        """
        Returns True if in development mode.
        
        Returns:
            True if in development mode, False otherwise
        """
        raise NotImplementedError("To be implemented in task 2.1")
    
    def is_user_mode(self) -> bool:
        """
        Returns True if in user mode.
        
        Returns:
            True if in user mode, False otherwise
        """
        raise NotImplementedError("To be implemented in task 2.1")
    
    def get_code_path(self) -> Path:
        """
        Returns path to code based on mode.
        
        Returns:
            Path to code directory
        """
        raise NotImplementedError("To be implemented in task 2.1")
