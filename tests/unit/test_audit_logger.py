"""
Unit tests for AuditLogger consumer and AuditLogManager.

Tests audit log consumer, query API, and export functionality.

Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7
"""

import asyncio
import json
import pytest
from unittest.mock import Mock, AsyncMock, patch, MagicMock
from datetime import datetime, timedelta
from uuid import uuid4, UUID

from caracal.kafka.auditLogger import AuditLoggerConsumer
from caracal.kafka.consumer import KafkaMessage
from caracal.core.audit import AuditLogManager
from caracal.db.models import AuditLog


class TestAuditLoggerConsumer:
    """Test suite for AuditLoggerConsumer."""
    
    def test_consumer_initialization(self):
        """Test audit logger consumer initializes correctly."""
        # Mock database connection manager
        mock_connection_manager = MagicMock()
        
        consumer = AuditLoggerConsumer(
            brokers=["localhost:9092"],
            security_protocol="PLAINTEXT",
            db_connection_manager=mock_connection_manager
        )
        
        assert consumer.brokers == ["localhost:9092"]
        assert consumer.topics == AuditLoggerConsumer.AUDIT_TOPICS
        assert consumer.consumer_group == "audit-logger-group"
        assert len(consumer.topics) == 4
        assert "caracal.metering.events" in consumer.topics
        assert "caracal.policy.decisions" in consumer.topics
        assert "caracal.agent.lifecycle" in consumer.topics
        assert "caracal.policy.changes" in consumer.topics
    
    @pytest.mark.asyncio
    async def test_process_metering_event(self):
        """Test processing metering event."""
        # Mock database connection manager
        mock_session = MagicMock()
        mock_connection_manager = MagicMock()
        mock_connection_manager.session_scope.return_value.__enter__ = Mock(return_value=mock_session)
        mock_connection_manager.session_scope.return_value.__exit__ = Mock(return_value=False)
        
        consumer = AuditLoggerConsumer(
            brokers=["localhost:9092"],
            db_connection_manager=mock_connection_manager
        )
        
        # Create test event
        agent_id = uuid4()
        event_data = {
            "event_id": str(uuid4()),
            "event_type": "metering",
            "agent_id": str(agent_id),
            "timestamp": datetime.utcnow().isoformat(),
            "resource_type": "api_call",
            "cost": 0.01,
            "metadata": {
                "correlation_id": "test-correlation-123"
            }
        }
        
        message = KafkaMessage(
            topic="caracal.metering.events",
            partition=0,
            offset=100,
            key=str(agent_id).encode('utf-8'),
            value=json.dumps(event_data).encode('utf-8'),
            timestamp=int(datetime.utcnow().timestamp() * 1000)
        )
        
        # Process message
        await consumer.process_message(message)
        
        # Verify audit log was created
        mock_session.add.assert_called_once()
        audit_log = mock_session.add.call_args[0][0]
        
        assert isinstance(audit_log, AuditLog)
        assert audit_log.event_id == event_data["event_id"]
        assert audit_log.event_type == "metering"
        assert audit_log.topic == "caracal.metering.events"
        assert audit_log.partition == 0
        assert audit_log.offset == 100
        assert audit_log.agent_id == agent_id
        assert audit_log.correlation_id == "test-correlation-123"
        assert audit_log.event_data == event_data
    
    @pytest.mark.asyncio
    async def test_process_policy_decision_event(self):
        """Test processing policy decision event."""
        # Mock database connection manager
        mock_session = MagicMock()
        mock_connection_manager = MagicMock()
        mock_connection_manager.session_scope.return_value.__enter__ = Mock(return_value=mock_session)
        mock_connection_manager.session_scope.return_value.__exit__ = Mock(return_value=False)
        
        consumer = AuditLoggerConsumer(
            brokers=["localhost:9092"],
            db_connection_manager=mock_connection_manager
        )
        
        # Create test event
        agent_id = uuid4()
        event_data = {
            "event_id": str(uuid4()),
            "event_type": "policy_decision",
            "agent_id": str(agent_id),
            "timestamp": datetime.utcnow().isoformat(),
            "decision": "allow",
            "policy_id": str(uuid4())
        }
        
        message = KafkaMessage(
            topic="caracal.policy.decisions",
            partition=1,
            offset=50,
            key=str(agent_id).encode('utf-8'),
            value=json.dumps(event_data).encode('utf-8'),
            timestamp=int(datetime.utcnow().timestamp() * 1000),
            headers={"correlation_id": b"header-correlation-456"}
        )
        
        # Process message
        await consumer.process_message(message)
        
        # Verify audit log was created
        mock_session.add.assert_called_once()
        audit_log = mock_session.add.call_args[0][0]
        
        assert audit_log.event_type == "policy_decision"
        assert audit_log.topic == "caracal.policy.decisions"
        assert audit_log.correlation_id == "header-correlation-456"
    
    @pytest.mark.asyncio
    async def test_process_event_without_agent_id(self):
        """Test processing event without agent_id."""
        # Mock database connection manager
        mock_session = MagicMock()
        mock_connection_manager = MagicMock()
        mock_connection_manager.session_scope.return_value.__enter__ = Mock(return_value=mock_session)
        mock_connection_manager.session_scope.return_value.__exit__ = Mock(return_value=False)
        
        consumer = AuditLoggerConsumer(
            brokers=["localhost:9092"],
            db_connection_manager=mock_connection_manager
        )
        
        # Create test event without agent_id
        event_data = {
            "event_id": str(uuid4()),
            "event_type": "system_event",
            "timestamp": datetime.utcnow().isoformat(),
            "message": "System started"
        }
        
        message = KafkaMessage(
            topic="caracal.agent.lifecycle",
            partition=0,
            offset=1,
            key=None,
            value=json.dumps(event_data).encode('utf-8'),
            timestamp=int(datetime.utcnow().timestamp() * 1000)
        )
        
        # Process message
        await consumer.process_message(message)
        
        # Verify audit log was created with None agent_id
        audit_log = mock_session.add.call_args[0][0]
        assert audit_log.agent_id is None


class TestAuditLogManager:
    """Test suite for AuditLogManager."""
    
    def test_manager_initialization(self):
        """Test audit log manager initializes correctly."""
        # Mock connection manager
        mock_connection_manager = MagicMock()
        manager = AuditLogManager(db_connection_manager=mock_connection_manager)
        assert manager.db_connection_manager is not None
    
    def test_query_audit_logs_by_agent(self):
        """Test querying audit logs by agent ID."""
        # Mock connection manager
        mock_connection_manager = MagicMock()
        manager = AuditLogManager(db_connection_manager=mock_connection_manager)
        
        agent_id = uuid4()
        
        # Mock database session
        mock_session = MagicMock()
        mock_query = MagicMock()
        mock_session.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.order_by.return_value = mock_query
        mock_query.limit.return_value = mock_query
        mock_query.offset.return_value = mock_query
        mock_query.all.return_value = []
        
        mock_connection_manager.session_scope.return_value.__enter__ = Mock(return_value=mock_session)
        mock_connection_manager.session_scope.return_value.__exit__ = Mock(return_value=False)
        
        # Query logs
        results = manager.query_audit_logs(agent_id=agent_id)
        
        # Verify query was executed
        mock_session.query.assert_called_once_with(AuditLog)
        mock_query.filter.assert_called_once()
        mock_query.order_by.assert_called_once()
        assert results == []
    
    def test_query_audit_logs_by_time_range(self):
        """Test querying audit logs by time range."""
        # Mock connection manager
        mock_connection_manager = MagicMock()
        manager = AuditLogManager(db_connection_manager=mock_connection_manager)
        
        start_time = datetime.utcnow() - timedelta(days=7)
        end_time = datetime.utcnow()
        
        # Mock database session
        mock_session = MagicMock()
        mock_query = MagicMock()
        mock_session.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.order_by.return_value = mock_query
        mock_query.limit.return_value = mock_query
        mock_query.offset.return_value = mock_query
        mock_query.all.return_value = []
        
        mock_connection_manager.session_scope.return_value.__enter__ = Mock(return_value=mock_session)
        mock_connection_manager.session_scope.return_value.__exit__ = Mock(return_value=False)
        
        # Query logs
        results = manager.query_audit_logs(
            start_time=start_time,
            end_time=end_time
        )
        
        # Verify query was executed with time filters
        mock_query.filter.assert_called_once()
        assert results == []
    
    def test_export_json(self):
        """Test exporting audit logs as JSON."""
        # Mock connection manager
        mock_connection_manager = MagicMock()
        manager = AuditLogManager(db_connection_manager=mock_connection_manager)
        
        # Create mock audit logs
        agent_id = uuid4()
        mock_log = AuditLog(
            log_id=1,
            event_id="test-event-1",
            event_type="metering",
            topic="caracal.metering.events",
            partition=0,
            offset=100,
            event_timestamp=datetime.utcnow(),
            logged_at=datetime.utcnow(),
            agent_id=agent_id,
            correlation_id="test-correlation",
            event_data={"test": "data"}
        )
        
        # Mock query_audit_logs
        manager.query_audit_logs = Mock(return_value=[mock_log])
        
        # Export as JSON
        json_output = manager.export_json(agent_id=agent_id)
        
        # Verify JSON structure
        data = json.loads(json_output)
        assert len(data) == 1
        assert data[0]["log_id"] == 1
        assert data[0]["event_id"] == "test-event-1"
        assert data[0]["event_type"] == "metering"
        assert data[0]["agent_id"] == str(agent_id)
        assert data[0]["correlation_id"] == "test-correlation"
        assert data[0]["event_data"] == {"test": "data"}
    
    def test_export_csv(self):
        """Test exporting audit logs as CSV."""
        # Mock connection manager
        mock_connection_manager = MagicMock()
        manager = AuditLogManager(db_connection_manager=mock_connection_manager)
        
        # Create mock audit logs
        agent_id = uuid4()
        mock_log = AuditLog(
            log_id=1,
            event_id="test-event-1",
            event_type="metering",
            topic="caracal.metering.events",
            partition=0,
            offset=100,
            event_timestamp=datetime.utcnow(),
            logged_at=datetime.utcnow(),
            agent_id=agent_id,
            correlation_id="test-correlation",
            event_data={"test": "data"}
        )
        
        # Mock query_audit_logs
        manager.query_audit_logs = Mock(return_value=[mock_log])
        
        # Export as CSV
        csv_output = manager.export_csv(agent_id=agent_id)
        
        # Verify CSV structure
        lines = csv_output.strip().split('\n')
        assert len(lines) == 2  # Header + 1 data row
        
        # Check header
        header = lines[0]
        assert "log_id" in header
        assert "event_id" in header
        assert "event_type" in header
        assert "agent_id" in header
        
        # Check data row
        data_row = lines[1]
        assert "test-event-1" in data_row
        assert "metering" in data_row
    
    def test_export_syslog(self):
        """Test exporting audit logs as SYSLOG."""
        # Mock connection manager
        mock_connection_manager = MagicMock()
        manager = AuditLogManager(db_connection_manager=mock_connection_manager)
        
        # Create mock audit logs
        agent_id = uuid4()
        event_timestamp = datetime.utcnow()
        mock_log = AuditLog(
            log_id=1,
            event_id="test-event-1",
            event_type="metering",
            topic="caracal.metering.events",
            partition=0,
            offset=100,
            event_timestamp=event_timestamp,
            logged_at=datetime.utcnow(),
            agent_id=agent_id,
            correlation_id="test-correlation",
            event_data={"test": "data"}
        )
        
        # Mock query_audit_logs
        manager.query_audit_logs = Mock(return_value=[mock_log])
        
        # Export as SYSLOG
        syslog_output = manager.export_syslog(agent_id=agent_id)
        
        # Verify SYSLOG format
        lines = syslog_output.strip().split('\n')
        assert len(lines) == 1
        
        syslog_line = lines[0]
        # Check priority (facility 16 * 8 + severity 6 = 134)
        assert syslog_line.startswith("<134>1")
        # Check structured data
        assert "caracal@32473" in syslog_line
        assert 'log_id="1"' in syslog_line
        assert 'event_id="test-event-1"' in syslog_line
        assert 'event_type="metering"' in syslog_line
        assert f'agent_id="{agent_id}"' in syslog_line
        assert 'correlation_id="test-correlation"' in syslog_line
    
    def test_archive_old_logs_no_logs(self):
        """Test archiving when no old logs exist."""
        # Mock connection manager
        mock_connection_manager = MagicMock()
        manager = AuditLogManager(db_connection_manager=mock_connection_manager)
        
        # Mock database session
        mock_session = MagicMock()
        mock_query = MagicMock()
        mock_session.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.count.return_value = 0
        
        mock_connection_manager.session_scope.return_value.__enter__ = Mock(return_value=mock_session)
        mock_connection_manager.session_scope.return_value.__exit__ = Mock(return_value=False)
        
        # Archive old logs
        result = manager.archive_old_logs(retention_days=2555)
        
        # Verify result
        assert result["status"] == "no_logs_to_archive"
        assert result["logs_to_archive"] == 0
        assert result["retention_days"] == 2555
    
    def test_archive_old_logs_with_logs(self):
        """Test archiving when old logs exist."""
        # Mock connection manager
        mock_connection_manager = MagicMock()
        manager = AuditLogManager(db_connection_manager=mock_connection_manager)
        
        # Create mock old logs
        old_timestamp = datetime.utcnow() - timedelta(days=3000)
        mock_oldest = AuditLog(
            log_id=1,
            event_id="old-event-1",
            event_type="metering",
            topic="caracal.metering.events",
            partition=0,
            offset=1,
            event_timestamp=old_timestamp,
            logged_at=old_timestamp,
            agent_id=uuid4(),
            correlation_id=None,
            event_data={}
        )
        
        # Mock database session
        mock_session = MagicMock()
        mock_query = MagicMock()
        mock_session.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.count.return_value = 100
        mock_query.order_by.return_value = mock_query
        mock_query.first.return_value = mock_oldest
        
        mock_connection_manager.session_scope.return_value.__enter__ = Mock(return_value=mock_session)
        mock_connection_manager.session_scope.return_value.__exit__ = Mock(return_value=False)
        
        # Archive old logs
        result = manager.archive_old_logs(retention_days=2555)
        
        # Verify result
        assert result["status"] == "logs_identified_for_archival"
        assert result["logs_to_archive"] == 100
        assert result["retention_days"] == 2555
        assert "recommended_action" in result
    
    def test_get_retention_stats(self):
        """Test getting retention statistics."""
        # Mock connection manager
        mock_connection_manager = MagicMock()
        manager = AuditLogManager(db_connection_manager=mock_connection_manager)
        
        # Mock database session
        mock_session = MagicMock()
        mock_query = MagicMock()
        mock_session.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.count.side_effect = [1000, 900, 100]  # total, active, archival
        mock_query.order_by.return_value = mock_query
        
        oldest_log = AuditLog(
            log_id=1,
            event_id="oldest",
            event_type="metering",
            topic="test",
            partition=0,
            offset=1,
            event_timestamp=datetime.utcnow() - timedelta(days=3000),
            logged_at=datetime.utcnow(),
            agent_id=uuid4(),
            correlation_id=None,
            event_data={}
        )
        
        newest_log = AuditLog(
            log_id=1000,
            event_id="newest",
            event_type="metering",
            topic="test",
            partition=0,
            offset=1000,
            event_timestamp=datetime.utcnow(),
            logged_at=datetime.utcnow(),
            agent_id=uuid4(),
            correlation_id=None,
            event_data={}
        )
        
        mock_query.first.side_effect = [oldest_log, newest_log]
        
        mock_connection_manager.session_scope.return_value.__enter__ = Mock(return_value=mock_session)
        mock_connection_manager.session_scope.return_value.__exit__ = Mock(return_value=False)
        
        # Get retention stats
        stats = manager.get_retention_stats()
        
        # Verify stats
        assert stats["total_logs"] == 1000
        assert stats["active_logs"] == 900
        assert stats["archival_logs"] == 100
        assert stats["retention_days"] == 2555
        assert "cutoff_date" in stats
        assert "oldest_log_timestamp" in stats
        assert "newest_log_timestamp" in stats


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
