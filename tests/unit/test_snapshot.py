"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for snapshot management.

Tests the SnapshotManager, SnapshotScheduler, and RecoveryManager classes.
"""

import pytest
from datetime import datetime, timedelta
from decimal import Decimal
from uuid import uuid4

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from caracal.db.models import Base, LedgerSnapshot, LedgerEvent, MerkleRoot, AgentIdentity
from caracal.merkle.snapshot import SnapshotManager, SnapshotData, RecoveryResult
from caracal.merkle.recovery import RecoveryManager


@pytest.fixture
def db_session():
    """Create an in-memory SQLite database for testing."""
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session
    session.close()


@pytest.fixture
def sample_agent(db_session):
    """Create a sample agent for testing."""
    agent = AgentIdentity(
        agent_id=uuid4(),
        name="test-agent",
        owner="test@example.com",
    )
    db_session.add(agent)
    db_session.commit()
    return agent


@pytest.fixture
def sample_events(db_session, sample_agent):
    """Create sample ledger events for testing."""
    events = []
    for i in range(10):
        event = LedgerEvent(
            event_id=i + 1,  # Explicit event_id for SQLite compatibility
            agent_id=sample_agent.agent_id,
            timestamp=datetime.utcnow() - timedelta(hours=10-i),
            resource_type="test.resource",
            quantity=Decimal("1.0"),
        )
        db_session.add(event)
        events.append(event)
    
    db_session.commit()
    return events


@pytest.fixture
def sample_merkle_root(db_session):
    """Create a sample Merkle root for testing."""
    root = MerkleRoot(
        root_id=uuid4(),
        batch_id=uuid4(),
        merkle_root="a" * 64,
        signature="b" * 128,
        event_count=10,
        first_event_id=1,
        last_event_id=10,
    )
    db_session.add(root)
    db_session.commit()
    return root


class TestSnapshotManager:
    """Test SnapshotManager functionality."""

    def test_create_snapshot(self, db_session, sample_events, sample_merkle_root):
        """Test creating a snapshot."""
        manager = SnapshotManager(db_session=db_session)
        
        snapshot = manager.create_snapshot()
        
        assert snapshot is not None
        assert snapshot.snapshot_id is not None
        assert snapshot.total_events == len(sample_events)
        assert snapshot.merkle_root == sample_merkle_root.merkle_root
        assert snapshot.snapshot_data is not None
        
        # Verify snapshot is persisted
        db_session.refresh(snapshot)
        assert snapshot.snapshot_id is not None

    def test_create_snapshot_empty_ledger(self, db_session):
        """Test creating a snapshot with empty ledger."""
        manager = SnapshotManager(db_session=db_session)
        
        snapshot = manager.create_snapshot()
        
        assert snapshot is not None
        assert snapshot.total_events == 0
        assert snapshot.snapshot_data is not None

    def test_load_snapshot(self, db_session, sample_events, sample_merkle_root):
        """Test loading a snapshot."""
        manager = SnapshotManager(db_session=db_session)
        
        # Create snapshot
        created_snapshot = manager.create_snapshot()
        
        # Load snapshot
        snapshot_data = manager.load_snapshot(created_snapshot.snapshot_id)
        
        assert snapshot_data is not None
        assert isinstance(snapshot_data, SnapshotData)
        assert snapshot_data.total_events == len(sample_events)
        assert snapshot_data.merkle_root == sample_merkle_root.merkle_root

    def test_load_nonexistent_snapshot(self, db_session):
        """Test loading a nonexistent snapshot."""
        manager = SnapshotManager(db_session=db_session)
        
        with pytest.raises(ValueError, match="not found"):
            manager.load_snapshot(uuid4())

    def test_list_snapshots(self, db_session, sample_events):
        """Test listing snapshots."""
        manager = SnapshotManager(db_session=db_session)
        
        # Create multiple snapshots
        snapshot1 = manager.create_snapshot()
        snapshot2 = manager.create_snapshot()
        
        # List snapshots
        snapshots = manager.list_snapshots(limit=10)
        
        assert len(snapshots) == 2
        # Should be ordered by created_at desc (newest first)
        assert snapshots[0].snapshot_id == snapshot2.snapshot_id
        assert snapshots[1].snapshot_id == snapshot1.snapshot_id

    def test_list_snapshots_with_limit(self, db_session, sample_events):
        """Test listing snapshots with limit."""
        manager = SnapshotManager(db_session=db_session)
        
        # Create multiple snapshots
        for _ in range(5):
            manager.create_snapshot()
        
        # List with limit
        snapshots = manager.list_snapshots(limit=3)
        
        assert len(snapshots) == 3

    def test_cleanup_old_snapshots(self, db_session, sample_events):
        """Test cleaning up old snapshots."""
        manager = SnapshotManager(db_session=db_session)
        
        # Create old snapshot
        old_snapshot = LedgerSnapshot(
            snapshot_id=uuid4(),
            snapshot_timestamp=datetime.utcnow() - timedelta(days=100),
            total_events=0,
            merkle_root="",
            snapshot_data={},
            created_at=datetime.utcnow() - timedelta(days=100),
        )
        db_session.add(old_snapshot)
        db_session.commit()
        
        # Create recent snapshot
        recent_snapshot = manager.create_snapshot()
        
        # Cleanup with 90 day retention
        deleted_count = manager.cleanup_old_snapshots(retention_days=90)
        
        assert deleted_count == 1
        
        # Verify old snapshot is deleted
        snapshots = manager.list_snapshots(limit=10)
        assert len(snapshots) == 1
        assert snapshots[0].snapshot_id == recent_snapshot.snapshot_id

    def test_get_latest_snapshot(self, db_session, sample_events):
        """Test getting the latest snapshot."""
        manager = SnapshotManager(db_session=db_session)
        
        # No snapshots initially
        latest = manager.get_latest_snapshot()
        assert latest is None
        
        # Create snapshots
        snapshot1 = manager.create_snapshot()
        snapshot2 = manager.create_snapshot()
        
        # Get latest
        latest = manager.get_latest_snapshot()
        assert latest is not None
        assert latest.snapshot_id == snapshot2.snapshot_id

    def test_recover_from_snapshot(self, db_session, sample_events, sample_merkle_root):
        """Test recovering from a snapshot."""
        manager = SnapshotManager(db_session=db_session)
        
        # Create snapshot
        snapshot = manager.create_snapshot()
        
        # Recover from snapshot
        result = manager.recover_from_snapshot(snapshot.snapshot_id)
        
        assert result is not None
        assert isinstance(result, RecoveryResult)
        assert result.snapshot_id == snapshot.snapshot_id
        assert result.snapshot_timestamp == snapshot.snapshot_timestamp


class TestRecoveryManager:
    """Test RecoveryManager functionality."""

    def test_recover_from_latest_snapshot(self, db_session, sample_events, sample_merkle_root):
        """Test recovering from the latest snapshot."""
        snapshot_manager = SnapshotManager(db_session=db_session)
        recovery_manager = RecoveryManager(
            db_session=db_session,
            snapshot_manager=snapshot_manager,
        )
        
        # Create snapshot
        snapshot = snapshot_manager.create_snapshot()
        
        # Recover from latest
        result = recovery_manager.recover_from_latest_snapshot()
        
        assert result is not None
        assert result.snapshot_id == snapshot.snapshot_id

    def test_recover_from_latest_no_snapshots(self, db_session):
        """Test recovering when no snapshots exist."""
        snapshot_manager = SnapshotManager(db_session=db_session)
        recovery_manager = RecoveryManager(
            db_session=db_session,
            snapshot_manager=snapshot_manager,
        )
        
        with pytest.raises(ValueError, match="No snapshots available"):
            recovery_manager.recover_from_latest_snapshot()

    def test_get_recovery_status(self, db_session, sample_events, sample_merkle_root):
        """Test getting recovery status."""
        snapshot_manager = SnapshotManager(db_session=db_session)
        recovery_manager = RecoveryManager(
            db_session=db_session,
            snapshot_manager=snapshot_manager,
        )
        
        # No snapshots initially
        status = recovery_manager.get_recovery_status()
        assert status["snapshot_available"] is False
        
        # Create snapshot
        snapshot = snapshot_manager.create_snapshot()
        
        # Get status
        status = recovery_manager.get_recovery_status()
        assert status["snapshot_available"] is True
        assert status["latest_snapshot_id"] == str(snapshot.snapshot_id)
        assert status["snapshot_events"] == len(sample_events)

    def test_replay_events_after_timestamp(self, db_session, sample_events):
        """Test replaying events after a timestamp."""
        snapshot_manager = SnapshotManager(db_session=db_session)
        recovery_manager = RecoveryManager(
            db_session=db_session,
            snapshot_manager=snapshot_manager,
        )
        
        # Get timestamp in the middle of events
        middle_timestamp = sample_events[5].timestamp
        
        # Replay events after timestamp
        replayed_events = recovery_manager._replay_events_after_timestamp(middle_timestamp)
        
        # Should get events after the middle timestamp
        assert len(replayed_events) > 0
        assert len(replayed_events) < len(sample_events)


class TestSnapshotData:
    """Test SnapshotData dataclass."""

    def test_snapshot_data_creation(self):
        """Test creating SnapshotData."""
        data = SnapshotData(
            total_events=10,
            merkle_root="a" * 64,
            snapshot_timestamp=datetime.utcnow(),
        )
        
        assert data.total_events == 10
        assert data.merkle_root == "a" * 64
        assert isinstance(data.snapshot_timestamp, datetime)


class TestRecoveryResult:
    """Test RecoveryResult dataclass."""

    def test_recovery_result_creation(self):
        """Test creating RecoveryResult."""
        snapshot_id = uuid4()
        timestamp = datetime.utcnow()
        
        result = RecoveryResult(
            snapshot_id=snapshot_id,
            snapshot_timestamp=timestamp,
            agents_restored=5,
            replay_from_timestamp=timestamp,
        )
        
        assert result.snapshot_id == snapshot_id
        assert result.snapshot_timestamp == timestamp
        assert result.agents_restored == 5
        assert result.replay_from_timestamp == timestamp
