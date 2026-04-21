"""
Unit tests for Audit Log Management functionality.

This module tests the AuditReference and AuditLogManager classes.
"""
import pytest
import hashlib
from datetime import datetime, timedelta
from uuid import uuid4
from unittest.mock import Mock

from caracal.core.audit import (
    AuditReference,
    AuditLogManager
)
from caracal.db.models import AuditLog


@pytest.mark.unit
class TestAuditReference:
    """Test suite for AuditReference dataclass."""
    
    def test_audit_reference_creation(self):
        """Test audit reference creation with valid data."""
        ref = AuditReference(
            audit_id="test-audit-123",
            location="s3://bucket/audit.json",
            hash="abc123",
            hash_algorithm="SHA-256"
        )
        assert ref.audit_id == "test-audit-123"
        assert ref.location == "s3://bucket/audit.json"
        assert ref.hash == "abc123"
        assert ref.hash_algorithm == "SHA-256"
        assert ref.timestamp is not None
    
    def test_audit_reference_validation_empty_id(self):
        """Test audit reference validation rejects empty ID."""
        with pytest.raises(ValueError) as exc_info:
            AuditReference(audit_id="")
        
        assert "audit_id" in str(exc_info.value).lower()
    
    def test_verify_hash_sha256(self):
        """Test hash verification with SHA-256."""
        content = b"test audit data"
        expected_hash = hashlib.sha256(content).hexdigest()
        
        ref = AuditReference(
            audit_id="test-audit",
            hash=expected_hash,
            hash_algorithm="SHA-256"
        )
        result = ref.verify_hash(content)
        assert result is True
    
    def test_verify_hash_mismatch(self):
        """Test hash verification fails with mismatched content."""
        content = b"test audit data"
        wrong_hash = "wrong_hash_value"
        
        ref = AuditReference(
            audit_id="test-audit",
            hash=wrong_hash,
            hash_algorithm="SHA-256"
        )
        result = ref.verify_hash(content)
        assert result is False
    
    def test_verify_hash_sha3(self):
        """Test hash verification with SHA3-256."""
        content = b"test audit data"
        expected_hash = hashlib.sha3_256(content).hexdigest()
        
        ref = AuditReference(
            audit_id="test-audit",
            hash=expected_hash,
            hash_algorithm="SHA3-256"
        )
        result = ref.verify_hash(content)
        assert result is True
    
    def test_verify_hash_unsupported_algorithm(self):
        """Test hash verification with unsupported algorithm raises error."""
        ref = AuditReference(
            audit_id="test-audit",
            hash="abc123",
            hash_algorithm="MD5"
        )
        with pytest.raises(ValueError) as exc_info:
            ref.verify_hash(b"test data")
        
        assert "unsupported" in str(exc_info.value).lower()
    
    def test_verify_chain_first_entry(self):
        """Test chain verification for first entry (no previous hash)."""
        ref = AuditReference(
            audit_id="test-audit",
            hash="abc123",
            previous_hash=None
        )
        result = ref.verify_chain(None)
        assert result is True
    
    def test_verify_chain_valid(self):
        """Test chain verification with valid previous reference."""
        prev_ref = AuditReference(
            audit_id="prev-audit",
            hash="prev_hash_123"
        )
        
        current_ref = AuditReference(
            audit_id="current-audit",
            hash="current_hash_456",
            previous_hash="prev_hash_123"
        )
        result = current_ref.verify_chain(prev_ref)
        assert result is True
    
    def test_verify_chain_invalid(self):
        """Test chain verification with invalid previous reference."""
        prev_ref = AuditReference(
            audit_id="prev-audit",
            hash="prev_hash_123"
        )
        
        current_ref = AuditReference(
            audit_id="current-audit",
            hash="current_hash_456",
            previous_hash="wrong_hash"
        )
        result = current_ref.verify_chain(prev_ref)
        assert result is False
    
    def test_to_dict(self):
        """Test audit reference serialization to dictionary."""
        timestamp = datetime.utcnow()
        ref = AuditReference(
            audit_id="test-audit",
            location="s3://bucket/audit.json",
            hash="abc123",
            timestamp=timestamp,
            entry_count=5
        )
        result = ref.to_dict()
        assert result["audit_id"] == "test-audit"
        assert result["location"] == "s3://bucket/audit.json"
        assert result["hash"] == "abc123"
        assert result["entry_count"] == 5
    
    def test_from_dict(self):
        """Test audit reference deserialization from dictionary."""
        data = {
            "audit_id": "test-audit",
            "location": "s3://bucket/audit.json",
            "hash": "abc123",
            "hash_algorithm": "SHA-256",
            "timestamp": "2024-01-01T00:00:00",
            "entry_count": 5
        }
        ref = AuditReference.from_dict(data)
        assert ref.audit_id == "test-audit"
        assert ref.location == "s3://bucket/audit.json"
        assert ref.hash == "abc123"
        assert ref.entry_count == 5

@pytest.mark.unit
class TestAuditLogManager:
    """Test suite for AuditLogManager class."""
    
    def setup_method(self):
        """Set up test fixtures before each test method."""
        self.mock_db_manager = Mock()
        self.mock_session = Mock()
        self.mock_db_manager.session_scope.return_value.__enter__ = Mock(return_value=self.mock_session)
        self.mock_db_manager.session_scope.return_value.__exit__ = Mock(return_value=False)
        self.manager = AuditLogManager(self.mock_db_manager)
    
    def test_query_audit_logs_no_filters(self):
        """Test querying audit logs without filters."""
        mock_logs = [
            AuditLog(
                log_id=1,
                event_id="event-1",
                event_type="mandate.created",
                topic="mandates",
                partition=0,
                offset=100,
                event_timestamp=datetime.utcnow(),
                logged_at=datetime.utcnow(),
                event_data={}
            )
        ]
        
        mock_query = Mock()
        mock_query.filter.return_value = mock_query
        mock_query.order_by.return_value = mock_query
        mock_query.limit.return_value = mock_query
        mock_query.offset.return_value = mock_query
        mock_query.all.return_value = mock_logs
        
        self.mock_session.query.return_value = mock_query
        results = self.manager.query_audit_logs()
        assert len(results) == 1
        assert results[0].event_id == "event-1"
    
    def test_query_audit_logs_with_principal_filter(self):
        """Test querying audit logs filtered by principal ID."""
        principal_id = uuid4()
        mock_query = Mock()
        mock_query.filter.return_value = mock_query
        mock_query.order_by.return_value = mock_query
        mock_query.limit.return_value = mock_query
        mock_query.offset.return_value = mock_query
        mock_query.all.return_value = []
        
        self.mock_session.query.return_value = mock_query
        results = self.manager.query_audit_logs(principal_id=principal_id)
        mock_query.filter.assert_called()
    
    def test_query_audit_logs_with_time_range(self):
        """Test querying audit logs with time range filter."""
        start_time = datetime.utcnow() - timedelta(days=1)
        end_time = datetime.utcnow()
        
        mock_query = Mock()
        mock_query.filter.return_value = mock_query
        mock_query.order_by.return_value = mock_query
        mock_query.limit.return_value = mock_query
        mock_query.offset.return_value = mock_query
        mock_query.all.return_value = []
        
        self.mock_session.query.return_value = mock_query
        results = self.manager.query_audit_logs(
            start_time=start_time,
            end_time=end_time
        )
        mock_query.filter.assert_called()
    
    def test_export_json(self):
        """Test exporting audit logs as JSON."""
        mock_logs = [
            AuditLog(
                log_id=1,
                event_id="event-1",
                event_type="mandate.created",
                topic="mandates",
                partition=0,
                offset=100,
                event_timestamp=datetime.utcnow(),
                logged_at=datetime.utcnow(),
                principal_id=uuid4(),
                correlation_id="corr-123",
                event_data={"key": "value"}
            )
        ]
        
        mock_query = Mock()
        mock_query.filter.return_value = mock_query
        mock_query.order_by.return_value = mock_query
        mock_query.limit.return_value = mock_query
        mock_query.offset.return_value = mock_query
        mock_query.all.return_value = mock_logs
        
        self.mock_session.query.return_value = mock_query
        json_output = self.manager.export_json()
        assert "event-1" in json_output
        assert "mandate.created" in json_output
        assert "key" in json_output
    
    def test_export_csv(self):
        """Test exporting audit logs as CSV."""
        mock_logs = [
            AuditLog(
                log_id=1,
                event_id="event-1",
                event_type="mandate.created",
                topic="mandates",
                partition=0,
                offset=100,
                event_timestamp=datetime.utcnow(),
                logged_at=datetime.utcnow(),
                event_data={}
            )
        ]
        
        mock_query = Mock()
        mock_query.filter.return_value = mock_query
        mock_query.order_by.return_value = mock_query
        mock_query.limit.return_value = mock_query
        mock_query.offset.return_value = mock_query
        mock_query.all.return_value = mock_logs
        
        self.mock_session.query.return_value = mock_query
        csv_output = self.manager.export_csv()
        assert "log_id" in csv_output  # Header
        assert "event-1" in csv_output
        assert "mandate.created" in csv_output
    
    def test_export_syslog(self):
        """Test exporting audit logs in SYSLOG format."""
        mock_logs = [
            AuditLog(
                log_id=1,
                event_id="event-1",
                event_type="mandate.created",
                topic="mandates",
                partition=0,
                offset=100,
                event_timestamp=datetime.utcnow(),
                logged_at=datetime.utcnow(),
                event_data={}
            )
        ]
        
        mock_query = Mock()
        mock_query.filter.return_value = mock_query
        mock_query.order_by.return_value = mock_query
        mock_query.limit.return_value = mock_query
        mock_query.offset.return_value = mock_query
        mock_query.all.return_value = mock_logs
        
        self.mock_session.query.return_value = mock_query
        syslog_output = self.manager.export_syslog()
        assert "caracal" in syslog_output.lower()
        assert "event-1" in syslog_output
    
    def test_get_retention_stats(self):
        """Test getting retention statistics."""
        self.mock_session.query.return_value.count.return_value = 100
        self.mock_session.query.return_value.filter.return_value.count.return_value = 80
        
        oldest_log = AuditLog(
            log_id=1,
            event_id="oldest",
            event_type="test",
            topic="test",
            partition=0,
            offset=0,
            event_timestamp=datetime.utcnow() - timedelta(days=3000),
            logged_at=datetime.utcnow()
        )
        newest_log = AuditLog(
            log_id=100,
            event_id="newest",
            event_type="test",
            topic="test",
            partition=0,
            offset=100,
            event_timestamp=datetime.utcnow(),
            logged_at=datetime.utcnow()
        )
        
        mock_query = Mock()
        mock_query.order_by.return_value.first.side_effect = [oldest_log, newest_log]
        self.mock_session.query.return_value = mock_query
        stats = self.manager.get_retention_stats()
        assert "total_logs" in stats
        assert "retention_days" in stats
