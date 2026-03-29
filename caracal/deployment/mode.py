"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Mode management for Caracal deployment architecture.

Handles detection and management of installation modes (Development vs User).
"""

import os
import sys
import toml
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Optional
import structlog

from caracal.deployment.exceptions import (
    InvalidModeError,
    ModeConfigurationError,
    ModeDetectionError,
)
from caracal.storage.layout import resolve_caracal_home

logger = structlog.get_logger(__name__)


class Mode(str, Enum):
    """Installation mode enumeration."""
    DEVELOPMENT = "dev"
    USER = "user"

    @property
    def is_dev(self) -> bool:
        """Return True when mode is development."""
        return self == Mode.DEVELOPMENT

    @property
    def is_user(self) -> bool:
        """Return True when mode is user."""
        return self == Mode.USER


class ModeManager:
    """
    Manages installation mode detection and configuration.
    
    Provides methods to detect, set, and query the current installation mode.
    Mode detection follows a fallback chain: environment variable → config file → default.
    
    The mode configuration is stored in ~/.caracal/config.toml and cached in memory
    to avoid repeated file I/O operations.
    """
    
    # Environment variable name for mode override
    ENV_VAR_NAME = "CARACAL_MODE"
    
    # Configuration directory and file paths
    CONFIG_DIR = resolve_caracal_home()
    CONFIG_FILE = CONFIG_DIR / "config.toml"
    
    # Default mode when no configuration is found
    DEFAULT_MODE = Mode.USER
    
    def __init__(self):
        """Initialize the mode manager with cached mode detection."""
        self._cached_mode: Optional[Mode] = None
        self._cache_timestamp: Optional[datetime] = None
    
    def get_mode(self) -> Mode:
        """
        Returns current installation mode (DEV or USER).
        
        Mode detection follows a fallback chain:
        1. Environment variable (CARACAL_MODE)
        2. Configuration file (~/.caracal/config.toml)
        3. Default mode (USER)
        
        The result is cached to avoid repeated file I/O.
        
        Returns:
            Current installation mode
            
        Raises:
            ModeDetectionError: If mode detection fails
        """
        # Return cached mode if available
        if self._cached_mode is not None:
            return self._cached_mode
        
        try:
            # Step 1: Check environment variable
            env_mode = os.environ.get(self.ENV_VAR_NAME)
            if env_mode:
                try:
                    mode = Mode(env_mode.lower())
                    self._cached_mode = mode
                    self._cache_timestamp = datetime.now()
                    logger.debug(
                        "mode_detected_from_env",
                        mode=mode.value,
                        env_var=self.ENV_VAR_NAME
                    )
                    return mode
                except ValueError:
                    logger.warning(
                        "invalid_mode_in_env",
                        env_var=self.ENV_VAR_NAME,
                        value=env_mode,
                        valid_modes=[m.value for m in Mode]
                    )
            
            # Step 2: Check configuration file
            if self.CONFIG_FILE.exists():
                try:
                    config = toml.load(self.CONFIG_FILE)
                    mode_str = config.get("mode", {}).get("current")
                    if mode_str:
                        try:
                            mode = Mode(mode_str.lower())
                            self._cached_mode = mode
                            self._cache_timestamp = datetime.now()
                            logger.debug(
                                "mode_detected_from_config",
                                mode=mode.value,
                                config_file=str(self.CONFIG_FILE)
                            )
                            return mode
                        except ValueError:
                            logger.warning(
                                "invalid_mode_in_config",
                                config_file=str(self.CONFIG_FILE),
                                value=mode_str,
                                valid_modes=[m.value for m in Mode]
                            )
                except (toml.TomlDecodeError, OSError) as e:
                    logger.warning(
                        "config_file_read_error",
                        config_file=str(self.CONFIG_FILE),
                        error=str(e)
                    )
            
            # Step 3: Use default mode
            mode = self.DEFAULT_MODE
            self._cached_mode = mode
            self._cache_timestamp = datetime.now()
            logger.debug(
                "mode_using_default",
                mode=mode.value,
                reason="no_env_var_or_config"
            )
            return mode
            
        except Exception as e:
            logger.error(
                "mode_detection_failed",
                error=str(e),
                error_type=type(e).__name__
            )
            raise ModeDetectionError(f"Failed to detect installation mode: {e}") from e
    
    def set_mode(self, mode: Mode) -> None:
        """
        Sets installation mode and updates configuration.
        
        This method persists the mode to the configuration file and updates
        the in-memory cache.
        
        Args:
            mode: Installation mode to set
            
        Raises:
            InvalidModeError: If mode is not a valid Mode enum value
            ModeConfigurationError: If configuration update fails
        """
        # Validate mode
        if not isinstance(mode, Mode):
            raise InvalidModeError(f"Invalid mode: {mode}. Must be Mode.DEVELOPMENT or Mode.USER")
        
        try:
            # Ensure configuration directory exists
            self.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
            
            # Set directory permissions to 0700 (owner read/write/execute only)
            self.CONFIG_DIR.chmod(0o700)
            
            # Load existing configuration or create new one
            config = {}
            if self.CONFIG_FILE.exists():
                try:
                    config = toml.load(self.CONFIG_FILE)
                except toml.TomlDecodeError as e:
                    logger.warning(
                        "config_file_corrupted",
                        config_file=str(self.CONFIG_FILE),
                        error=str(e),
                        action="creating_new_config"
                    )
                    config = {}
            
            # Update mode configuration
            if "mode" not in config:
                config["mode"] = {}
            
            config["mode"]["current"] = mode.value
            config["mode"]["updated_at"] = datetime.now().isoformat()
            
            # Write configuration to file atomically
            # Write to temp file first, then rename for atomicity
            temp_file = self.CONFIG_FILE.with_suffix(".tmp")
            try:
                with open(temp_file, "w") as f:
                    toml.dump(config, f)
                
                # Set file permissions to 0600 (owner read/write only)
                temp_file.chmod(0o600)
                
                # Atomic rename
                temp_file.replace(self.CONFIG_FILE)
                
                # Update cache
                self._cached_mode = mode
                self._cache_timestamp = datetime.now()
                
                logger.info(
                    "mode_updated",
                    mode=mode.value,
                    config_file=str(self.CONFIG_FILE)
                )
                
            finally:
                # Clean up temp file if it still exists
                if temp_file.exists():
                    temp_file.unlink()
                    
        except OSError as e:
            logger.error(
                "mode_configuration_failed",
                mode=mode.value,
                config_file=str(self.CONFIG_FILE),
                error=str(e)
            )
            raise ModeConfigurationError(
                f"Failed to update mode configuration: {e}"
            ) from e
    
    def is_dev_mode(self) -> bool:
        """
        Returns True if in development mode.
        
        Returns:
            True if in development mode, False otherwise
        """
        return self.get_mode() == Mode.DEVELOPMENT
    
    def is_user_mode(self) -> bool:
        """
        Returns True if in user mode.
        
        Returns:
            True if in user mode, False otherwise
        """
        return self.get_mode() == Mode.USER
    
    def get_code_path(self) -> Path:
        """
        Returns path to code based on mode.
        
        In Development mode, returns the local repository directory.
        In User mode, returns the installed package location.
        
        Returns:
            Path to code directory
        """
        mode = self.get_mode()
        
        if mode == Mode.DEVELOPMENT:
            # In development mode, use the repository directory
            # Find the caracal package directory by walking up from this file
            current_file = Path(__file__).resolve()
            # Walk up to find the repository root (contains pyproject.toml)
            for parent in current_file.parents:
                if (parent / "pyproject.toml").exists():
                    code_path = parent / "caracal"
                    logger.debug(
                        "code_path_resolved",
                        mode=mode.value,
                        path=str(code_path)
                    )
                    return code_path
            
            # Fallback: use the caracal package directory
            code_path = current_file.parent.parent
            logger.debug(
                "code_path_resolved_fallback",
                mode=mode.value,
                path=str(code_path)
            )
            return code_path
        else:
            # In user mode, use the installed package location
            # Get the caracal package location from sys.modules
            import caracal
            code_path = Path(caracal.__file__).parent
            logger.debug(
                "code_path_resolved",
                mode=mode.value,
                path=str(code_path)
            )
            return code_path
    
    def clear_cache(self) -> None:
        """
        Clears the cached mode detection result.
        
        This forces the next get_mode() call to re-detect the mode.
        Useful for testing or when configuration changes externally.
        """
        self._cached_mode = None
        self._cache_timestamp = None
        logger.debug("mode_cache_cleared")
