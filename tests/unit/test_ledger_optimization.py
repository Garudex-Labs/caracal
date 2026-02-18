"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for ledger query optimization features.

Tests materialized views, partition management, and related functionality.
"""

import pytest
from datetime import datetime, timedelta
from unittest.mock import Mock, MagicMock, patch
from sqlalchemy.orm import Session

from caracal.db.materialized_views import MaterializedViewManager
from caracal.db.partition_manager import PartitionManager
from caracal.exceptions import DatabaseError


class TestMaterializedViewManager:
    """Tests for MaterializedViewManager."""
    
    def test_init(self):
        """Test MaterializedViewManager initialization."""
        session = Mock(spec=Session)
        manager = MaterializedViewManager(session)
        
        assert manager.db_session == session
    
    def test_refresh_spending_by_agent_success(self):
        """Test successful refresh of spending_by_agent_mv."""
        session = Mock(spec=Session)
        manager = MaterializedViewManager(session)
        
        # Mock successful execution
        session.execute.return_value = None
        session.commit.return_value = None
        
        # Should not raise exception
        manager.refresh_spending_by_agent(concurrent=True)
        
        # Verify SQL was executed
        session.execute.assert_called_once()
        session.commit.assert_called_once()
    
    def test_refresh_spending_by_agent_failure(self):
        """Test failed refresh of spending_by_agent_mv."""
        session = Mock(spec=Session)
        manager = MaterializedViewManager(session)
        
        # Mock failed execution
        session.execute.side_effect = Exception("Database error")
        
        # Should raise DatabaseError
        with pytest.raises(DatabaseError):
            manager.refresh_spending_by_agent(concurrent=True)
        
        # Verify rollback was called
        session.rollback.assert_called_once()
    
    def test_refresh_spending_by_time_window_success(self):
        """Test successful refresh of spending_by_time_window_mv."""
        session = Mock(spec=Session)
        manager = MaterializedViewManager(session)
        
        # Mock successful execution
        session.execute.return_value = None
        session.commit.return_value = None
        
        # Should not raise exception
        manager.refresh_spending_by_time_window(concurrent=False)
        
        # Verify SQL was executed
        session.execute.assert_called_once()
        session.commit.assert_called_once()
    
    def test_refresh_all_success(self):
        """Test successful refresh of all materialized views."""
        session = Mock(spec=Session)
        manager = MaterializedViewManager(session)
        
        # Mock successful execution
        session.execute.return_value = None
        session.commit.return_value = None
        
        # Should not raise exception
        manager.refresh_all(concurrent=True)
        
        # Verify both views were refreshed (2 execute calls, 2 commit calls)
        assert session.execute.call_count == 2
        assert session.commit.call_count == 2
    
    def test_get_view_refresh_time_success(self):
        """Test getting view refresh time."""
        session = Mock(spec=Session)
        manager = MaterializedViewManager(session)
        
        # Mock successful query
        refresh_time = datetime.utcnow()
        mock_result = Mock()
        mock_result.fetchone.return_value = (refresh_time,)
        session.execute.return_value = mock_result
        
        result = manager.get_view_refresh_time('spending_by_agent_mv')
        
        assert result == refresh_time
    
    def test_get_view_refresh_time_no_data(self):
        """Test getting view refresh time when view has no data."""
        session = Mock(spec=Session)
        manager = MaterializedViewManager(session)
        
        # Mock empty result
        mock_result = Mock()
        mock_result.fetchone.return_value = None
        session.execute.return_value = mock_result
        
        result = manager.get_view_refresh_time('spending_by_agent_mv')
        
        assert result is None


class TestPartitionManager:
    """Tests for PartitionManager."""
    
    def test_init(self):
        """Test PartitionManager initialization."""
        session = Mock(spec=Session)
        manager = PartitionManager(session)
        
        assert manager.db_session == session
    
    def test_create_partition_success(self):
        """Test successful partition creation."""
        session = Mock(spec=Session)
        manager = PartitionManager(session)
        
        # Mock partition doesn't exist
        mock_result = Mock()
        mock_result.scalar.return_value = False
        session.execute.return_value = mock_result
        session.commit.return_value = None
        
        partition_name = manager.create_partition(2026, 2, if_not_exists=True)
        
        assert partition_name == "ledger_events_y2026m02"
        session.commit.assert_called_once()
    
    def test_create_partition_already_exists(self):
        """Test partition creation when partition already exists."""
        session = Mock(spec=Session)
        manager = PartitionManager(session)
        
        # Mock partition exists
        mock_result = Mock()
        mock_result.scalar.return_value = True
        session.execute.return_value = mock_result
        
        partition_name = manager.create_partition(2026, 2, if_not_exists=True)
        
        assert partition_name == "ledger_events_y2026m02"
        # Commit should not be called since partition exists
        session.commit.assert_not_called()
    
    def test_create_partition_invalid_month(self):
        """Test partition creation with invalid month."""
        session = Mock(spec=Session)
        manager = PartitionManager(session)
        
        # Should raise ValueError for invalid month
        with pytest.raises(ValueError):
            manager.create_partition(2026, 13, if_not_exists=True)
        
        with pytest.raises(ValueError):
            manager.create_partition(2026, 0, if_not_exists=True)
    
    def test_create_partition_failure(self):
        """Test failed partition creation."""
        session = Mock(spec=Session)
        manager = PartitionManager(session)
        
        # Mock partition doesn't exist
        mock_result = Mock()
        mock_result.scalar.return_value = False
        session.execute.side_effect = [mock_result, Exception("Database error")]
        
        # Should raise DatabaseError
        with pytest.raises(DatabaseError):
            manager.create_partition(2026, 2, if_not_exists=True)
        
        # Verify rollback was called
        session.rollback.assert_called_once()
    
    def test_create_upcoming_partitions_success(self):
        """Test successful creation of upcoming partitions."""
        session = Mock(spec=Session)
        manager = PartitionManager(session)
        
        # Mock partition doesn't exist for all months
        mock_result = Mock()
        mock_result.scalar.return_value = False
        session.execute.return_value = mock_result
        session.commit.return_value = None
        
        partitions = manager.create_upcoming_partitions(months_ahead=2)
        
        # Should create 3 partitions (current month + 2 ahead)
        assert len(partitions) == 3
        assert all(p.startswith("ledger_events_y") for p in partitions)
    
    def test_list_partitions_success(self):
        """Test successful partition listing."""
        session = Mock(spec=Session)
        manager = PartitionManager(session)
        
        # Mock partition list
        mock_result = Mock()
        mock_result.fetchall.return_value = [
            ("ledger_events_y2026m01", "FOR VALUES FROM ('2026-01-01') TO ('2026-02-01')"),
            ("ledger_events_y2026m02", "FOR VALUES FROM ('2026-02-01') TO ('2026-03-01')"),
        ]
        session.execute.return_value = mock_result
        
        partitions = manager.list_partitions()
        
        assert len(partitions) == 2
        assert partitions[0][0] == "ledger_events_y2026m01"
        assert partitions[1][0] == "ledger_events_y2026m02"
    
    def test_get_partition_size_success(self):
        """Test getting partition size."""
        session = Mock(spec=Session)
        manager = PartitionManager(session)
        
        # Mock size query
        mock_result = Mock()
        mock_result.scalar.return_value = 1024 * 1024  # 1 MB
        session.execute.return_value = mock_result
        
        size = manager.get_partition_size("ledger_events_y2026m01")
        
        assert size == 1024 * 1024
    
    def test_get_partition_row_count_success(self):
        """Test getting partition row count."""
        session = Mock(spec=Session)
        manager = PartitionManager(session)
        
        # Mock count query
        mock_result = Mock()
        mock_result.scalar.return_value = 1000
        session.execute.return_value = mock_result
        
        count = manager.get_partition_row_count("ledger_events_y2026m01")
        
        assert count == 1000
    
    def test_detach_partition_success(self):
        """Test successful partition detachment."""
        session = Mock(spec=Session)
        manager = PartitionManager(session)
        
        # Mock successful detach
        session.execute.return_value = None
        session.commit.return_value = None
        
        # Should not raise exception
        manager.detach_partition("ledger_events_y2025m01")
        
        session.execute.assert_called_once()
        session.commit.assert_called_once()
    
    def test_detach_partition_failure(self):
        """Test failed partition detachment."""
        session = Mock(spec=Session)
        manager = PartitionManager(session)
        
        # Mock failed detach
        session.execute.side_effect = Exception("Database error")
        
        # Should raise DatabaseError
        with pytest.raises(DatabaseError):
            manager.detach_partition("ledger_events_y2025m01")
        
        # Verify rollback was called
        session.rollback.assert_called_once()
    
    def test_archive_old_partitions_dry_run(self):
        """Test archiving old partitions in dry run mode."""
        session = Mock(spec=Session)
        manager = PartitionManager(session)
        
        # Mock partition list with old partitions
        cutoff_date = datetime.utcnow() - timedelta(days=365)
        old_partition_end = cutoff_date - timedelta(days=30)
        
        with patch.object(manager, 'list_partitions') as mock_list:
            mock_list.return_value = [
                ("ledger_events_y2025m01", datetime(2025, 1, 1), old_partition_end),
                ("ledger_events_y2026m01", datetime(2026, 1, 1), datetime(2026, 2, 1)),
            ]
            
            archived = manager.archive_old_partitions(months_to_keep=12, dry_run=True)
            
            # Should identify old partition but not detach it
            assert len(archived) == 1
            assert archived[0] == "ledger_events_y2025m01"
            
            # Detach should not be called in dry run
            session.execute.assert_not_called()
    
    def test_archive_old_partitions_success(self):
        """Test successful archiving of old partitions."""
        session = Mock(spec=Session)
        manager = PartitionManager(session)
        
        # Mock partition list with old partitions
        cutoff_date = datetime.utcnow() - timedelta(days=365)
        old_partition_end = cutoff_date - timedelta(days=30)
        
        with patch.object(manager, 'list_partitions') as mock_list:
            with patch.object(manager, 'detach_partition') as mock_detach:
                mock_list.return_value = [
                    ("ledger_events_y2025m01", datetime(2025, 1, 1), old_partition_end),
                ]
                
                archived = manager.archive_old_partitions(months_to_keep=12, dry_run=False)
                
                # Should detach old partition
                assert len(archived) == 1
                assert archived[0] == "ledger_events_y2025m01"
                mock_detach.assert_called_once_with("ledger_events_y2025m01")


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
