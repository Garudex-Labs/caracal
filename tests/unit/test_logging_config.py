"""
Unit tests for structured logging configuration.
"""

import json
import logging
from pathlib import Path

import pytest
import structlog
from caracal.logging_config import (
    setup_logging,
    get_logger,
    set_correlation_id,
    clear_correlation_id,
    get_correlation_id,
    log_authentication_failure,
    log_database_query,
    log_delegation_token_validation,
)


class TestLoggingConfiguration:
    """Test structured logging configuration functionality."""
    
    def test_setup_logging_default(self):
        """Test setup_logging with default parameters."""
        setup_logging()
        
        logger = get_logger("test")
        # Logger can be BoundLogger or BoundLoggerLazyProxy (both are valid)
        assert hasattr(logger, 'info') and hasattr(logger, 'warning') and hasattr(logger, 'error')
    
    def test_setup_logging_with_level(self):
        """Test setup_logging with custom log level."""
        setup_logging(level="DEBUG")
        
        # Verify logging level is set
        root_logger = logging.getLogger()
        assert root_logger.level == logging.DEBUG
    
    def test_setup_logging_with_file(self, temp_dir: Path):
        """Test setup_logging with log file."""
        log_file = temp_dir / "test.log"
        setup_logging(level="INFO", log_file=log_file)
        
        logger = get_logger("test")
        logger.info("test_message", key="value")
        
        # Log file should be created
        assert log_file.exists()
        
        # Log file should contain the message
        log_content = log_file.read_text()
        assert "test_message" in log_content
    
    def test_setup_logging_json_format(self, temp_dir: Path):
        """Test setup_logging with JSON format."""
        log_file = temp_dir / "test.log"
        setup_logging(level="INFO", log_file=log_file, json_format=True)
        
        logger = get_logger("test")
        logger.info("test_message", key="value")
        
        # Read log file and verify JSON format
        log_content = log_file.read_text()
        log_lines = [line for line in log_content.strip().split("\n") if line]
        
        # Parse first log line as JSON
        log_entry = json.loads(log_lines[0])
        assert log_entry["event"] == "test_message"
        assert log_entry["key"] == "value"
        assert "timestamp" in log_entry
        assert "level" in log_entry
    
    def test_setup_logging_human_format(self, temp_dir: Path):
        """Test setup_logging with human-readable format."""
        log_file = temp_dir / "test.log"
        setup_logging(level="INFO", log_file=log_file, json_format=False)
        
        logger = get_logger("test")
        logger.info("test_message", key="value")
        
        # Log file should contain the message in human-readable format
        log_content = log_file.read_text()
        assert "test_message" in log_content
        assert "key" in log_content
    
    def test_get_logger(self):
        """Test get_logger returns logger with correct name."""
        setup_logging()
        logger = get_logger("test_module")
        
        # Logger can be BoundLogger or BoundLoggerLazyProxy (both are valid)
        assert hasattr(logger, 'info') and hasattr(logger, 'warning') and hasattr(logger, 'error')
    
    def test_correlation_id_management(self):
        """Test correlation ID context management."""
        # Initially no correlation ID
        assert get_correlation_id() is None
        
        # Set correlation ID
        correlation_id = set_correlation_id("test-correlation-id")
        assert correlation_id == "test-correlation-id"
        assert get_correlation_id() == "test-correlation-id"
        
        # Clear correlation ID
        clear_correlation_id()
        assert get_correlation_id() is None
    
    def test_correlation_id_auto_generation(self):
        """Test correlation ID auto-generation."""
        correlation_id = set_correlation_id()
        assert correlation_id is not None
        assert len(correlation_id) > 0
        assert get_correlation_id() == correlation_id
        
        clear_correlation_id()
    
    def test_correlation_id_in_logs(self, temp_dir: Path):
        """Test correlation ID appears in log output."""
        log_file = temp_dir / "test.log"
        setup_logging(level="INFO", log_file=log_file, json_format=True)
        
        logger = get_logger("test")
        
        # Set correlation ID and log
        set_correlation_id("test-correlation-123")
        logger.info("test_message")
        
        # Verify correlation ID in log
        log_content = log_file.read_text()
        log_entry = json.loads(log_content.strip().split("\n")[0])
        assert log_entry["correlation_id"] == "test-correlation-123"
        
        clear_correlation_id()
    
    def test_log_authentication_failure(self, temp_dir: Path):
        """Test log_authentication_failure."""
        log_file = temp_dir / "test.log"
        setup_logging(level="INFO", log_file=log_file, json_format=True)
        
        logger = get_logger("test")
        log_authentication_failure(
            logger,
            auth_method="jwt",
            agent_id="agent-123",
            reason="expired_token"
        )
        
        # Verify log entry
        log_content = log_file.read_text()
        log_entry = json.loads(log_content.strip().split("\n")[0])
        assert log_entry["event_type"] == "authentication_failure"
        assert log_entry["auth_method"] == "jwt"
        assert log_entry["agent_id"] == "agent-123"
        assert log_entry["reason"] == "expired_token"
        assert log_entry["level"] == "warning"
    
    def test_log_database_query(self, temp_dir: Path):
        """Test log_database_query."""
        log_file = temp_dir / "test.log"
        setup_logging(level="DEBUG", log_file=log_file, json_format=True)
        
        logger = get_logger("test")
        log_database_query(
            logger,
            operation="select",
            table="agent_identities",
            duration_ms=5.2
        )
        
        # Verify log entry
        log_content = log_file.read_text()
        log_entry = json.loads(log_content.strip().split("\n")[0])
        assert log_entry["event_type"] == "database_query"
        assert log_entry["operation"] == "select"
        assert log_entry["table"] == "agent_identities"
        assert log_entry["duration_ms"] == 5.2
        assert log_entry["level"] == "debug"
    
    def test_log_delegation_token_validation_success(self, temp_dir: Path):
        """Test log_delegation_token_validation for success."""
        log_file = temp_dir / "test.log"
        setup_logging(level="INFO", log_file=log_file, json_format=True)
        
        logger = get_logger("test")
        log_delegation_token_validation(
            logger,
            parent_agent_id="parent-123",
            child_agent_id="child-456",
            success=True
        )
        
        # Verify log entry
        log_content = log_file.read_text()
        log_entry = json.loads(log_content.strip().split("\n")[0])
        assert log_entry["event_type"] == "delegation_token_validation"
        assert log_entry["parent_agent_id"] == "parent-123"
        assert log_entry["child_agent_id"] == "child-456"
        assert log_entry["success"] is True
        assert log_entry["level"] == "info"
    
    def test_log_delegation_token_validation_failure(self, temp_dir: Path):
        """Test log_delegation_token_validation for failure."""
        log_file = temp_dir / "test.log"
        setup_logging(level="INFO", log_file=log_file, json_format=True)
        
        logger = get_logger("test")
        log_delegation_token_validation(
            logger,
            parent_agent_id="parent-123",
            child_agent_id="child-456",
            success=False,
            reason="invalid_signature"
        )
        
        # Verify log entry
        log_content = log_file.read_text()
        log_entry = json.loads(log_content.strip().split("\n")[0])
        assert log_entry["event_type"] == "delegation_token_validation"
        assert log_entry["parent_agent_id"] == "parent-123"
        assert log_entry["child_agent_id"] == "child-456"
        assert log_entry["success"] is False
        assert log_entry["reason"] == "invalid_signature"
        assert log_entry["level"] == "warning"
    
    def test_structured_logging_with_extra_fields(self, temp_dir: Path):
        """Test that extra fields are included in structured logs."""
        log_file = temp_dir / "test.log"
        setup_logging(level="INFO", log_file=log_file, json_format=True)
        
        logger = get_logger("test")
        logger.info("test_event", custom_field="custom_value", number=42)
        
        # Verify extra fields in log
        log_content = log_file.read_text()
        log_entry = json.loads(log_content.strip().split("\n")[0])
        assert log_entry["custom_field"] == "custom_value"
        assert log_entry["number"] == 42

