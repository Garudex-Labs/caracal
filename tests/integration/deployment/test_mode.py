"""
Integration tests for deployment mode.

Tests the integration of deployment mode switching and mode-specific behavior.
"""
import pytest
import os
import tempfile
from pathlib import Path

from caracal.deployment.mode import Mode, ModeManager
from caracal.deployment.exceptions import InvalidModeError, ModeConfigurationError


@pytest.mark.integration
class TestDeploymentModeIntegration:
    """Test deployment mode integration."""
    
    def test_switching_between_deployment_modes(self, tmp_path):
        """Test switching between deployment modes."""
        # Arrange: Create a temporary config directory
        config_dir = tmp_path / ".caracal"
        config_dir.mkdir()
        config_file = config_dir / "config.toml"
        
        # Patch the config paths
        original_config_dir = ModeManager.CONFIG_DIR
        original_config_file = ModeManager.CONFIG_FILE
        
        try:
            ModeManager.CONFIG_DIR = config_dir
            ModeManager.CONFIG_FILE = config_file
            
            manager = ModeManager()
            
            # Act: Switch to development mode
            manager.set_mode(Mode.DEVELOPMENT)
            mode1 = manager.get_mode()
            
            # Switch to user mode
            manager.clear_cache()
            manager.set_mode(Mode.USER)
            mode2 = manager.get_mode()
            
            # Switch back to development mode
            manager.clear_cache()
            manager.set_mode(Mode.DEVELOPMENT)
            mode3 = manager.get_mode()
            
            # Assert: Mode switches should work correctly
            assert mode1 == Mode.DEVELOPMENT
            assert mode2 == Mode.USER
            assert mode3 == Mode.DEVELOPMENT
            
            # Verify config file was updated
            assert config_file.exists()
            
        finally:
            # Restore original paths
            ModeManager.CONFIG_DIR = original_config_dir
            ModeManager.CONFIG_FILE = original_config_file
    
    def test_mode_specific_behavior(self, tmp_path):
        """Test mode-specific behavior."""
        # Arrange: Create a temporary config directory
        config_dir = tmp_path / ".caracal"
        config_dir.mkdir()
        config_file = config_dir / "config.toml"
        
        # Patch the config paths
        original_config_dir = ModeManager.CONFIG_DIR
        original_config_file = ModeManager.CONFIG_FILE
        
        try:
            ModeManager.CONFIG_DIR = config_dir
            ModeManager.CONFIG_FILE = config_file
            
            manager = ModeManager()
            
            # Act: Set to development mode
            manager.set_mode(Mode.DEVELOPMENT)
            
            # Assert: Development mode behavior
            assert manager.is_dev_mode() is True
            assert manager.is_user_mode() is False
            assert manager.get_mode().is_dev is True
            
            # Act: Switch to user mode
            manager.clear_cache()
            manager.set_mode(Mode.USER)
            
            # Assert: User mode behavior
            assert manager.is_dev_mode() is False
            assert manager.is_user_mode() is True
            assert manager.get_mode().is_user is True
            
        finally:
            # Restore original paths
            ModeManager.CONFIG_DIR = original_config_dir
            ModeManager.CONFIG_FILE = original_config_file
    
    def test_configuration_changes(self, tmp_path):
        """Test configuration changes."""
        # Arrange: Create a temporary config directory
        config_dir = tmp_path / ".caracal"
        config_dir.mkdir()
        config_file = config_dir / "config.toml"
        
        # Patch the config paths
        original_config_dir = ModeManager.CONFIG_DIR
        original_config_file = ModeManager.CONFIG_FILE
        
        try:
            ModeManager.CONFIG_DIR = config_dir
            ModeManager.CONFIG_FILE = config_file
            
            manager = ModeManager()
            
            # Act: Set mode and verify it persists
            manager.set_mode(Mode.DEVELOPMENT)
            
            # Create a new manager instance (simulates restart)
            manager2 = ModeManager()
            mode = manager2.get_mode()
            
            # Assert: Mode should persist across instances
            assert mode == Mode.DEVELOPMENT
            
            # Act: Change mode
            manager2.set_mode(Mode.USER)
            
            # Create another new manager instance
            manager3 = ModeManager()
            mode2 = manager3.get_mode()
            
            # Assert: New mode should persist
            assert mode2 == Mode.USER
            
        finally:
            # Restore original paths
            ModeManager.CONFIG_DIR = original_config_dir
            ModeManager.CONFIG_FILE = original_config_file
    
    def test_environment_variable_override(self, tmp_path):
        """Test environment variable override."""
        # Arrange: Create a temporary config directory
        config_dir = tmp_path / ".caracal"
        config_dir.mkdir()
        config_file = config_dir / "config.toml"
        
        # Patch the config paths
        original_config_dir = ModeManager.CONFIG_DIR
        original_config_file = ModeManager.CONFIG_FILE
        original_env = os.environ.get(ModeManager.ENV_VAR_NAME)
        
        try:
            ModeManager.CONFIG_DIR = config_dir
            ModeManager.CONFIG_FILE = config_file
            
            manager = ModeManager()
            
            # Set config to USER mode
            manager.set_mode(Mode.USER)
            
            # Act: Override with environment variable
            os.environ[ModeManager.ENV_VAR_NAME] = "dev"
            manager.clear_cache()
            mode = manager.get_mode()
            
            # Assert: Environment variable should override config
            assert mode == Mode.DEVELOPMENT
            
            # Act: Remove environment variable
            del os.environ[ModeManager.ENV_VAR_NAME]
            manager.clear_cache()
            mode2 = manager.get_mode()
            
            # Assert: Should fall back to config
            assert mode2 == Mode.USER
            
        finally:
            # Restore original paths and environment
            ModeManager.CONFIG_DIR = original_config_dir
            ModeManager.CONFIG_FILE = original_config_file
            if original_env is not None:
                os.environ[ModeManager.ENV_VAR_NAME] = original_env
            elif ModeManager.ENV_VAR_NAME in os.environ:
                del os.environ[ModeManager.ENV_VAR_NAME]
    
    def test_invalid_mode_handling(self, tmp_path):
        """Test invalid mode handling."""
        # Arrange: Create a temporary config directory
        config_dir = tmp_path / ".caracal"
        config_dir.mkdir()
        
        # Patch the config paths
        original_config_dir = ModeManager.CONFIG_DIR
        original_config_file = ModeManager.CONFIG_FILE
        
        try:
            ModeManager.CONFIG_DIR = config_dir
            ModeManager.CONFIG_FILE = config_dir / "config.toml"
            
            manager = ModeManager()
            
            # Act & Assert: Try to set invalid mode
            with pytest.raises(InvalidModeError):
                manager.set_mode("invalid_mode")
            
        finally:
            # Restore original paths
            ModeManager.CONFIG_DIR = original_config_dir
            ModeManager.CONFIG_FILE = original_config_file
