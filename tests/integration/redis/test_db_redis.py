"""
Integration tests for database-redis coordination.

Tests the integration between database operations and Redis caching,
ensuring cache invalidation and consistency.
"""
import pytest
from datetime import datetime, timedelta
from uuid import uuid4
from unittest.mock import Mock, MagicMock

from caracal.core.mandate import MandateManager
from caracal.core.authority import AuthorityEvaluator
from caracal.redis.mandate_cache import RedisMandateCache
from caracal.redis.client import RedisClient
from caracal.db.models import Principal, ExecutionMandate, AuthorityPolicy
from tests.fixtures.database import db_session, in_memory_db_engine


@pytest.fixture
def mock_redis_client():
    """Provide a mock Redis client for testing."""
    client = Mock(spec=RedisClient)
    client._client = MagicMock()
    client._client.scan = MagicMock(return_value=(0, []))
    
    # Mock storage
    storage = {}
    
    def mock_set(key, value, ex=None):
        storage[key] = value
        return True
    
    def mock_get(key):
        return storage.get(key)
    
    def mock_delete(*keys):
        count = 0
        for key in keys:
            if key in storage:
                del storage[key]
                count += 1
        return count
    
    def mock_incr(key):
        if key not in storage:
            storage[key] = "0"
        storage[key] = str(int(storage[key]) + 1)
        return int(storage[key])
    
    client.set = mock_set
    client.get = mock_get
    client.delete = mock_delete
    client.incr = mock_incr
    
    return client


@pytest.mark.integration
class TestDatabaseRedisIntegration:
    """Test database-redis integration."""
    
    def test_cache_invalidation_on_database_updates(self, db_session, mock_redis_client):
        """Test cache invalidation on database updates."""
        # Arrange: Create components with cache
        mandate_cache = RedisMandateCache(mock_redis_client)
        mandate_manager = MandateManager(db_session, mandate_cache=mandate_cache)
        
        # Create principals
        issuer_id = uuid4()
        issuer = Principal(
            principal_id=issuer_id,
            principal_name="test-issuer",
            principal_type="user",
            private_key_pem="-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgTest1234567890Test1234567890Test1234567890hRACBggg==\n-----END PRIVATE KEY-----",
            public_key_pem="-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAETest1234567890Test1234567890Test1234567890Test1234567890==\n-----END PUBLIC KEY-----"
        )
        db_session.add(issuer)
        
        policy = AuthorityPolicy(
            principal_id=issuer_id,
            allowed_resource_patterns=["test:*"],
            allowed_actions=["read", "write"],
            max_validity_seconds=3600,
            allow_delegation=False,
            max_network_distance=0,
            active=True
        )
        db_session.add(policy)
        
        subject_id = uuid4()
        subject = Principal(
            principal_id=subject_id,
            principal_name="test-subject",
            principal_type="agent"
        )
        db_session.add(subject)
        db_session.commit()
        
        # Issue mandate (should cache it)
        mandate = mandate_manager.issue_mandate(
            issuer_id=issuer_id,
            subject_id=subject_id,
            resource_scope=["test:resource"],
            action_scope=["read"],
            validity_seconds=3600
        )
        db_session.commit()
        
        # Cache the mandate
        mandate_cache.cache_mandate(mandate)
        
        # Verify it's cached
        cached_data = mandate_cache.get_cached_mandate(mandate.mandate_id)
        assert cached_data is not None
        assert cached_data["mandate_id"] == mandate.mandate_id
        
        # Act: Revoke mandate (should invalidate cache)
        mandate_manager.revoke_mandate(
            mandate_id=mandate.mandate_id,
            revoker_id=issuer_id,
            reason="Test cache invalidation",
            cascade=False
        )
        db_session.commit()
        
        # Assert: Cache should be invalidated
        cached_data_after = mandate_cache.get_cached_mandate(mandate.mandate_id)
        assert cached_data_after is None
    
    def test_cache_population_from_database(self, db_session, mock_redis_client):
        """Test cache population from database."""
        # Arrange: Create components
        mandate_cache = RedisMandateCache(mock_redis_client)
        evaluator = AuthorityEvaluator(db_session, mandate_cache=mandate_cache)
        mandate_manager = MandateManager(db_session)
        
        # Create principals
        issuer_id = uuid4()
        issuer = Principal(
            principal_id=issuer_id,
            principal_name="test-issuer",
            principal_type="user",
            private_key_pem="-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgTest1234567890Test1234567890Test1234567890hRACBggg==\n-----END PRIVATE KEY-----",
            public_key_pem="-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAETest1234567890Test1234567890Test1234567890Test1234567890==\n-----END PUBLIC KEY-----"
        )
        db_session.add(issuer)
        
        policy = AuthorityPolicy(
            principal_id=issuer_id,
            allowed_resource_patterns=["test:*"],
            allowed_actions=["read", "write"],
            max_validity_seconds=3600,
            allow_delegation=False,
            max_network_distance=0,
            active=True
        )
        db_session.add(policy)
        
        subject_id = uuid4()
        subject = Principal(
            principal_id=subject_id,
            principal_name="test-subject",
            principal_type="agent"
        )
        db_session.add(subject)
        db_session.commit()
        
        # Issue mandate (not cached initially)
        mandate = mandate_manager.issue_mandate(
            issuer_id=issuer_id,
            subject_id=subject_id,
            resource_scope=["test:resource"],
            action_scope=["read"],
            validity_seconds=3600
        )
        db_session.commit()
        
        # Verify not cached
        cached_data = mandate_cache.get_cached_mandate(mandate.mandate_id)
        assert cached_data is None
        
        # Act: Access mandate through evaluator (should populate cache)
        mandate_from_db = evaluator._get_mandate_with_cache(mandate.mandate_id)
        
        # Assert: Mandate should now be cached
        cached_data_after = mandate_cache.get_cached_mandate(mandate.mandate_id)
        assert cached_data_after is not None
        assert cached_data_after["mandate_id"] == mandate.mandate_id
    
    def test_cache_consistency(self, db_session, mock_redis_client):
        """Test cache consistency with database."""
        # Arrange: Create components
        mandate_cache = RedisMandateCache(mock_redis_client)
        mandate_manager = MandateManager(db_session, mandate_cache=mandate_cache)
        
        # Create principals
        issuer_id = uuid4()
        issuer = Principal(
            principal_id=issuer_id,
            principal_name="test-issuer",
            principal_type="user",
            private_key_pem="-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgTest1234567890Test1234567890Test1234567890hRACBggg==\n-----END PRIVATE KEY-----",
            public_key_pem="-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAETest1234567890Test1234567890Test1234567890Test1234567890==\n-----END PUBLIC KEY-----"
        )
        db_session.add(issuer)
        
        policy = AuthorityPolicy(
            principal_id=issuer_id,
            allowed_resource_patterns=["test:*"],
            allowed_actions=["read", "write"],
            max_validity_seconds=3600,
            allow_delegation=False,
            max_network_distance=0,
            active=True
        )
        db_session.add(policy)
        
        subject_id = uuid4()
        subject = Principal(
            principal_id=subject_id,
            principal_name="test-subject",
            principal_type="agent"
        )
        db_session.add(subject)
        db_session.commit()
        
        # Issue mandate
        mandate = mandate_manager.issue_mandate(
            issuer_id=issuer_id,
            subject_id=subject_id,
            resource_scope=["test:resource"],
            action_scope=["read"],
            validity_seconds=3600
        )
        db_session.commit()
        
        # Cache the mandate
        mandate_cache.cache_mandate(mandate)
        
        # Get from cache
        cached_data = mandate_cache.get_cached_mandate(mandate.mandate_id)
        
        # Get from database
        db_mandate = db_session.query(ExecutionMandate).filter(
            ExecutionMandate.mandate_id == mandate.mandate_id
        ).first()
        
        # Assert: Cache and database should be consistent
        assert cached_data is not None
        assert cached_data["mandate_id"] == db_mandate.mandate_id
        assert cached_data["subject_id"] == db_mandate.subject_id
        assert cached_data["issuer_id"] == db_mandate.issuer_id
        assert cached_data["resource_scope"] == db_mandate.resource_scope
        assert cached_data["action_scope"] == db_mandate.action_scope
        assert cached_data["revoked"] == db_mandate.revoked
