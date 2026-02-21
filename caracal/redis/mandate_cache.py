"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Redis mandate cache for authority enforcement performance optimization.

Provides caching of frequently validated mandates with TTL management
and automatic invalidation on revocation.

"""

import json
from datetime import datetime
from typing import Optional
from uuid import UUID

from caracal.redis.client import RedisClient
from caracal.db.models import ExecutionMandate
from caracal.logging_config import get_logger

logger = get_logger(__name__)


class RedisMandateCache:
    """
    Redis-based mandate cache for performance optimization.
    
    Provides:
    - Caching of frequently validated mandates
    - TTL based on mandate validity period
    - Automatic invalidation on revocation
    - Serialization/deserialization of mandate objects
    
    """
    
    # Key prefixes
    PREFIX_MANDATE = "caracal:mandate"
    PREFIX_VALIDATION_COUNT = "caracal:mandate:validation_count"
    
    def __init__(self, redis_client: RedisClient):
        """
        Initialize mandate cache.
        
        Args:
            redis_client: RedisClient instance
        """
        self.redis = redis_client
        logger.info("RedisMandateCache initialized")
    
    def _serialize_mandate(self, mandate: ExecutionMandate) -> str:
        """
        Serialize mandate to JSON string for caching.
        
        Args:
            mandate: ExecutionMandate object
        
        Returns:
            JSON string representation
        """
        mandate_dict = {
            "mandate_id": str(mandate.mandate_id),
            "issuer_id": str(mandate.issuer_id),
            "subject_id": str(mandate.subject_id),
            "valid_from": mandate.valid_from.isoformat(),
            "valid_until": mandate.valid_until.isoformat(),
            "resource_scope": mandate.resource_scope,
            "action_scope": mandate.action_scope,
            "signature": mandate.signature,
            "created_at": mandate.created_at.isoformat(),
            "metadata": mandate.metadata,
            "revoked": mandate.revoked,
            "revoked_at": mandate.revoked_at.isoformat() if mandate.revoked_at else None,
            "revocation_reason": mandate.revocation_reason,
            "parent_mandate_id": str(mandate.parent_mandate_id) if mandate.parent_mandate_id else None,
            "delegation_depth": mandate.delegation_depth,
            "intent_hash": mandate.intent_hash
        }
        return json.dumps(mandate_dict)
    
    def _deserialize_mandate(self, mandate_json: str) -> dict:
        """
        Deserialize mandate from JSON string.
        
        Args:
            mandate_json: JSON string representation
        
        Returns:
            Dictionary with mandate data
        """
        mandate_dict = json.loads(mandate_json)
        
        # Convert ISO format strings back to datetime objects
        mandate_dict["valid_from"] = datetime.fromisoformat(mandate_dict["valid_from"])
        mandate_dict["valid_until"] = datetime.fromisoformat(mandate_dict["valid_until"])
        mandate_dict["created_at"] = datetime.fromisoformat(mandate_dict["created_at"])
        
        if mandate_dict["revoked_at"]:
            mandate_dict["revoked_at"] = datetime.fromisoformat(mandate_dict["revoked_at"])
        
        # Convert UUID strings back to UUID objects
        mandate_dict["mandate_id"] = UUID(mandate_dict["mandate_id"])
        mandate_dict["issuer_id"] = UUID(mandate_dict["issuer_id"])
        mandate_dict["subject_id"] = UUID(mandate_dict["subject_id"])
        
        if mandate_dict["parent_mandate_id"]:
            mandate_dict["parent_mandate_id"] = UUID(mandate_dict["parent_mandate_id"])
        
        return mandate_dict
    
    def _calculate_ttl(self, mandate: ExecutionMandate) -> int:
        """
        Calculate TTL for mandate cache based on validity period.
        
        TTL is set to the remaining time until mandate expiration,
        ensuring cached mandates are automatically removed when they expire.
        
        Args:
            mandate: ExecutionMandate object
        
        Returns:
            TTL in seconds (minimum 1 second)
        """
        current_time = datetime.utcnow()
        remaining_seconds = int((mandate.valid_until - current_time).total_seconds())
        
        # Ensure TTL is at least 1 second
        return max(1, remaining_seconds)
    
    def cache_mandate(self, mandate: ExecutionMandate) -> None:
        """
        Cache mandate with TTL based on validity period.
        
        Args:
            mandate: ExecutionMandate object to cache
        
        """
        try:
            mandate_key = f"{self.PREFIX_MANDATE}:{mandate.mandate_id}"
            mandate_json = self._serialize_mandate(mandate)
            ttl_seconds = self._calculate_ttl(mandate)
            
            # Store mandate with TTL
            self.redis.set(mandate_key, mandate_json, ex=ttl_seconds)
            
            logger.debug(
                f"Cached mandate {mandate.mandate_id} with TTL={ttl_seconds}s"
            )
        
        except Exception as e:
            logger.error(
                f"Failed to cache mandate {mandate.mandate_id}: {e}",
                exc_info=True
            )
            # Don't raise - cache failures shouldn't break the application
    
    def get_cached_mandate(self, mandate_id: UUID) -> Optional[dict]:
        """
        Get cached mandate by ID.
        
        Args:
            mandate_id: Mandate identifier
        
        Returns:
            Dictionary with mandate data if cached, None otherwise
        
        """
        try:
            mandate_key = f"{self.PREFIX_MANDATE}:{mandate_id}"
            mandate_json = self.redis.get(mandate_key)
            
            if mandate_json is None:
                logger.debug(f"Cache miss for mandate {mandate_id}")
                return None
            
            mandate_dict = self._deserialize_mandate(mandate_json)
            
            # Increment validation count for monitoring
            count_key = f"{self.PREFIX_VALIDATION_COUNT}:{mandate_id}"
            self.redis.incr(count_key)
            
            logger.debug(f"Cache hit for mandate {mandate_id}")
            return mandate_dict
        
        except Exception as e:
            logger.error(
                f"Failed to get cached mandate {mandate_id}: {e}",
                exc_info=True
            )
            return None
    
    def invalidate_mandate(self, mandate_id: UUID) -> None:
        """
        Invalidate cached mandate (e.g., on revocation).
        
        Args:
            mandate_id: Mandate identifier
        
        """
        try:
            mandate_key = f"{self.PREFIX_MANDATE}:{mandate_id}"
            count_key = f"{self.PREFIX_VALIDATION_COUNT}:{mandate_id}"
            
            # Delete both mandate and validation count
            deleted = self.redis.delete(mandate_key, count_key)
            
            if deleted > 0:
                logger.info(f"Invalidated cache for mandate {mandate_id}")
            else:
                logger.debug(f"Cache invalidation called for non-cached mandate {mandate_id}")
        
        except Exception as e:
            logger.error(
                f"Failed to invalidate cached mandate {mandate_id}: {e}",
                exc_info=True
            )
    
    def invalidate_mandates_by_subject(self, subject_id: UUID) -> int:
        """
        Invalidate all cached mandates for a subject.
        
        Useful when a principal's authority policy changes or when
        cascading revocations occur.
        
        Args:
            subject_id: Subject principal identifier
        
        Returns:
            Number of mandates invalidated
        
        """
        try:
            # Note: This requires scanning keys, which is expensive
            # In production, consider maintaining a subject->mandate mapping
            pattern = f"{self.PREFIX_MANDATE}:*"
            
            # Get all mandate keys
            # Note: SCAN is more efficient than KEYS for large datasets
            cursor = 0
            invalidated_count = 0
            
            while True:
                # Use SCAN to iterate through keys
                cursor, keys = self.redis._client.scan(
                    cursor=cursor,
                    match=pattern,
                    count=100
                )
                
                # Check each mandate to see if it belongs to the subject
                for key in keys:
                    try:
                        mandate_json = self.redis.get(key)
                        if mandate_json:
                            mandate_dict = json.loads(mandate_json)
                            if mandate_dict.get("subject_id") == str(subject_id):
                                mandate_id = UUID(mandate_dict["mandate_id"])
                                self.invalidate_mandate(mandate_id)
                                invalidated_count += 1
                    except Exception as e:
                        logger.warning(f"Failed to check mandate in key {key}: {e}")
                
                # Break if we've scanned all keys
                if cursor == 0:
                    break
            
            logger.info(
                f"Invalidated {invalidated_count} cached mandates for subject {subject_id}"
            )
            return invalidated_count
        
        except Exception as e:
            logger.error(
                f"Failed to invalidate mandates for subject {subject_id}: {e}",
                exc_info=True
            )
            return 0
    
    def get_validation_count(self, mandate_id: UUID) -> int:
        """
        Get validation count for a mandate (for monitoring).
        
        Args:
            mandate_id: Mandate identifier
        
        Returns:
            Number of times mandate was validated from cache
        """
        try:
            count_key = f"{self.PREFIX_VALIDATION_COUNT}:{mandate_id}"
            value = self.redis.get(count_key)
            
            if value is None:
                return 0
            
            return int(value)
        
        except Exception as e:
            logger.error(
                f"Failed to get validation count for mandate {mandate_id}: {e}",
                exc_info=True
            )
            return 0
    
    def clear_all_mandates(self) -> None:
        """
        Clear all cached mandates.
        
        Use cases:
        - System maintenance
        - Cache corruption recovery
        - Testing
        """
        try:
            # Delete all mandate keys
            pattern = f"{self.PREFIX_MANDATE}:*"
            cursor = 0
            deleted_count = 0
            
            while True:
                cursor, keys = self.redis._client.scan(
                    cursor=cursor,
                    match=pattern,
                    count=100
                )
                
                if keys:
                    deleted = self.redis.delete(*keys)
                    deleted_count += deleted
                
                if cursor == 0:
                    break
            
            # Delete all validation count keys
            pattern = f"{self.PREFIX_VALIDATION_COUNT}:*"
            cursor = 0
            
            while True:
                cursor, keys = self.redis._client.scan(
                    cursor=cursor,
                    match=pattern,
                    count=100
                )
                
                if keys:
                    self.redis.delete(*keys)
                
                if cursor == 0:
                    break
            
            logger.info(f"Cleared all cached mandates ({deleted_count} entries)")
        
        except Exception as e:
            logger.error(
                f"Failed to clear all cached mandates: {e}",
                exc_info=True
            )
