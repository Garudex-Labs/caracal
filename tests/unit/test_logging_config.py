"""
Unit tests for logging configuration.
"""

import logging
from pathlib import Path

import pytest
from caracal.logging_config import setup_logging, get_logger


class TestLoggingConfiguration:
    """Test logging configuration functionality."""
    
    def test_setup_logging_default(self):
        """Test setup_logging with default parameters."""
        setup_logging()
        
        logger = logging.getLogger("caracal")
        assert logger.level == logging.INFO
        assert len(logger.handlers) > 0
    
    def test_setup_logging_with_level(self):
        """Test setup_logging with custom log level."""
        setup_logging(level="DEBUG")
        
        logger = logging.getLogger("caracal")
        assert logger.level == logging.DEBUG
    
    def test_setup_logging_with_file(self, temp_dir: Path):
        """Test setup_logging with log file."""
        log_file = temp_dir / "test.log"
        setup_logging(level="INFO", log_file=log_file)
        
        logger = logging.getLogger("caracal")
        
        # Should have both stdout and file handlers
        assert len(logger.handlers) == 2
        
        # Log file should be created
        assert log_file.exists()
    
    def test_setup_logging_with_custom_format(self):
        """Test setup_logging with custom format."""
        custom_format = "%(levelname)s - %(message)s"
        setup_logging(log_format=custom_format)
        
        logger = logging.getLogger("caracal")
        assert len(logger.handlers) > 0
    
    def test_get_logger(self):
        """Test get_logger returns logger with correct name."""
        logger = get_logger("test_module")
        
        assert logger.name == "caracal.test_module"
        assert isinstance(logger, logging.Logger)
    
    def test_logging_output(self, temp_dir: Path, caplog):
        """Test that logging actually writes messages."""
        log_file = temp_dir / "test.log"
        setup_logging(level="INFO", log_file=log_file)
        
        logger = get_logger("test")
        
        with caplog.at_level(logging.INFO):
            logger.info("Test message")
        
        assert "Test message" in caplog.text
        
        # Check file also contains the message
        log_content = log_file.read_text()
        assert "Test message" in log_content
