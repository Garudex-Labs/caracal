"""
Unit tests for deployment mode management.

This module tests the ModeManager class and Mode enum.
"""
import os
import pytest
import tempfile
import toml
from datetime import datetime
from pathlib import Path
from unittest.mock import Mock, patch, MagicMock

from caracal.deployment.mode import Mode, ModeManager
from caracal.deployment.exceptions import (
    InvalidModeError,
    ModeConfigurationError,
    ModeDetectionError,
)


@pytest.mark.unit
class TestMode:
    """Test suite for Mode enum."""
    
    def test_mode_values(self):
        """Test Mode enum values."""
        assert Mode.DEVELOPMENT.value == "dev"
        assert Mode.USER.value == "user"
    
    def test_mode_is_dev(self):
        """Test Mode.is_dev property."""
        assert Mode.DEVELOPMENT.is_dev is True
        assert Mode.USER.is_dev is False
    
    def test_mode_is_user(self):
        """Test Mode.is_user property."""
        assert Mode.USER.is_user is True
        assert Mode.DEVELOPMENT.is_user is False


@pytest.mark.unit
class TestModeManager:
    """Test suite for ModeManager class."""
    
    def setup_method(self):
        """Set up test fixtures before each test method."""
        self.manager = ModeManager()
        # Clear cache before each test
        self.manager.clear_cache()
    
    def test_get_mode_from_environment_variable(self):
        """Test mode detection from environment variable."""
        with patch.dict(os.environ, {"CARACAL_MODE": "dev"}):
            # Clear cache to force re-detection
            self.manager.clear_cache()
            mode = self.manager.get_mode()
            assert mode == Mode.DEVELOPMENT
    
    def test_get_mode_from_environment_variable_user(self):
        """Test mode detection from environment variable for user mode."""
        with patch.dict(os.environ, {"CARACAL_MODE": "user"}):
            self.manager.clear_cache()
            mode = self.manager.get_mode()
            assert mode == Mode.USER
    
    def test_get_mode_invalid_environment_variable(self):
        """Test mode detection with invalid environment variable falls back to config."""
        with patch.dict(os.environ, {"CARACAL_MODE": "invalid"}):
            self.manager.clear_cache()
            # Should fall back to default mode
            mode = self.manager.get_mode()
            assert mode == Mode.USER  # Default mode
    
    def test_get_mode_from_config_file(self):
        """Test mode detection from configuration file."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_file = Path(tmpdir) / "config.toml"
            config_data = {"mode": {"current": "dev"}}
            with open(config_file, "w") as f:
                toml.dump(config_data, f)
            
            with patch.object(ModeManager, "CONFIG_FILE", config_file):
                with patch.dict(os.environ, {}, clear=True):
                    self.manager.clear_cache()
                    mode = self.manager.get_mode()
                    assert mode == Mode.DEVELOPMENT
    
    def test_get_mode_default(self):
        """Test mode detection falls back to default."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_file = Path(tmpdir) / "nonexistent.toml"
            
            with patch.object(ModeManager, "CONFIG_FILE", config_file):
                with patch.dict(os.environ, {}, clear=True):
                    self.manager.clear_cache()
                    mode = self.manager.get_mode()
                    assert mode == Mode.USER  # Default mode
    
    def test_get_mode_caching(self):
        """Test that mode detection result is cached."""
        with patch.dict(os.environ, {"CARACAL_MODE": "dev"}):
            self.manager.clear_cache()
            mode1 = self.manager.get_mode()
            
            # Change environment variable
            os.environ["CARACAL_MODE"] = "user"
            
            # Should still return cached value
            mode2 = self.manager.get_mode()
            assert mode1 == mode2 == Mode.DEVELOPMENT
    
    def test_clear_cache(self):
        """Test cache clearing."""
        with patch.dict(os.environ, {"CARACAL_MODE": "dev"}):
            self.manager.clear_cache()
            mode1 = self.manager.get_mode()
            assert mode1 == Mode.DEVELOPMENT
            
            # Change environment and clear cache
            os.environ["CARACAL_MODE"] = "user"
            self.manager.clear_cache()
            
            # Should detect new mode
            mode2 = self.manager.get_mode()
            assert mode2 == Mode.USER
    
    def test_set_mode_development(self):
        """Test setting mode to development."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_dir = Path(tmpdir)
            config_file = config_dir / "config.toml"
            
            with patch.object(ModeManager, "CONFIG_DIR", config_dir):
                with patch.object(ModeManager, "CONFIG_FILE", config_file):
                    self.manager.set_mode(Mode.DEVELOPMENT)
                    
                    # Verify file was created
                    assert config_file.exists()
                    
                    # Verify content
                    config = toml.load(config_file)
                    assert config["mode"]["current"] == "dev"
                    assert "updated_at" in config["mode"]
    
    def test_set_mode_user(self):
        """Test setting mode to user."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_dir = Path(tmpdir)
            config_file = config_dir / "config.toml"
            
            with patch.object(ModeManager, "CONFIG_DIR", config_dir):
                with patch.object(ModeManager, "CONFIG_FILE", config_file):
                    self.manager.set_mode(Mode.USER)
                    
                    # Verify content
                    config = toml.load(config_file)
                    assert config["mode"]["current"] == "user"
    
    def test_set_mode_invalid(self):
        """Test setting invalid mode raises error."""
        with pytest.raises(InvalidModeError):
            self.manager.set_mode("invalid")
    
    def test_set_mode_updates_cache(self):
        """Test that set_mode updates the cache."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_dir = Path(tmpdir)
            config_file = config_dir / "config.toml"
            
            with patch.object(ModeManager, "CONFIG_DIR", config_dir):
                with patch.object(ModeManager, "CONFIG_FILE", config_file):
                    with patch.dict(os.environ, {}, clear=True):
                        self.manager.set_mode(Mode.DEVELOPMENT)
                        
                        # get_mode should return the set mode without reading file
                        mode = self.manager.get_mode()
                        assert mode == Mode.DEVELOPMENT
    
    def test_is_dev_mode(self):
        """Test is_dev_mode method."""
        with patch.dict(os.environ, {"CARACAL_MODE": "dev"}):
            self.manager.clear_cache()
            assert self.manager.is_dev_mode() is True
            assert self.manager.is_user_mode() is False
    
    def test_is_user_mode(self):
        """Test is_user_mode method."""
        with patch.dict(os.environ, {"CARACAL_MODE": "user"}):
            self.manager.clear_cache()
            assert self.manager.is_user_mode() is True
            assert self.manager.is_dev_mode() is False
    
    def test_get_code_path_development(self):
        """Test get_code_path in development mode."""
        with patch.dict(os.environ, {"CARACAL_MODE": "dev"}):
            self.manager.clear_cache()
            code_path = self.manager.get_code_path()
            
            # Should return a Path object
            assert isinstance(code_path, Path)
            # Path should exist
            assert code_path.exists()
    
    def test_get_code_path_user(self):
        """Test get_code_path in user mode."""
        with patch.dict(os.environ, {"CARACAL_MODE": "user"}):
            self.manager.clear_cache()
            code_path = self.manager.get_code_path()
            
            # Should return a Path object
            assert isinstance(code_path, Path)
            # Path should exist
            assert code_path.exists()
    
    def test_config_file_permissions(self):
        """Test that config file has correct permissions."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_dir = Path(tmpdir)
            config_file = config_dir / "config.toml"
            
            with patch.object(ModeManager, "CONFIG_DIR", config_dir):
                with patch.object(ModeManager, "CONFIG_FILE", config_file):
                    self.manager.set_mode(Mode.DEVELOPMENT)
                    
                    # Check file permissions (0600 = owner read/write only)
                    stat_info = config_file.stat()
                    permissions = stat_info.st_mode & 0o777
                    assert permissions == 0o600
    
    def test_config_dir_permissions(self):
        """Test that config directory has correct permissions."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_dir = Path(tmpdir) / "caracal"
            config_file = config_dir / "config.toml"
            
            with patch.object(ModeManager, "CONFIG_DIR", config_dir):
                with patch.object(ModeManager, "CONFIG_FILE", config_file):
                    self.manager.set_mode(Mode.DEVELOPMENT)
                    
                    # Check directory permissions (0700 = owner read/write/execute only)
                    stat_info = config_dir.stat()
                    permissions = stat_info.st_mode & 0o777
                    assert permissions == 0o700
    
    def test_set_mode_preserves_existing_config(self):
        """Test that set_mode preserves other configuration values."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_dir = Path(tmpdir)
            config_file = config_dir / "config.toml"
            
            # Create initial config with other values
            initial_config = {
                "mode": {"current": "user"},
                "other_setting": {"value": "test"}
            }
            config_dir.mkdir(exist_ok=True)
            with open(config_file, "w") as f:
                toml.dump(initial_config, f)
            
            with patch.object(ModeManager, "CONFIG_DIR", config_dir):
                with patch.object(ModeManager, "CONFIG_FILE", config_file):
                    self.manager.set_mode(Mode.DEVELOPMENT)
                    
                    # Verify other settings preserved
                    config = toml.load(config_file)
                    assert config["mode"]["current"] == "dev"
                    assert config["other_setting"]["value"] == "test"
    
    def test_set_mode_handles_corrupted_config(self):
        """Test that set_mode handles corrupted config file."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_dir = Path(tmpdir)
            config_file = config_dir / "config.toml"
            
            # Create corrupted config file
            config_dir.mkdir(exist_ok=True)
            with open(config_file, "w") as f:
                f.write("invalid toml content {{{")
            
            with patch.object(ModeManager, "CONFIG_DIR", config_dir):
                with patch.object(ModeManager, "CONFIG_FILE", config_file):
                    # Should not raise exception, should create new config
                    self.manager.set_mode(Mode.DEVELOPMENT)
                    
                    # Verify new config was created
                    config = toml.load(config_file)
                    assert config["mode"]["current"] == "dev"
