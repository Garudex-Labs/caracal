"""
Resource Allowlist Manager for Caracal Core v0.3.

This module provides fine-grained access control through resource allowlists.
Agents can be restricted to specific resources using regex or glob patterns.

Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 18.6
"""

import fnmatch
import logging
import re
import time
from dataclasses import dataclass
from datetime import datetime
from typing import List, Optional, Dict, Tuple
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from caracal.db.models import ResourceAllowlist
from caracal.exceptions import ValidationError

logger = logging.getLogger(__name__)


@dataclass
class AllowlistDecision:
    """
    Result of an allowlist check.
    
    Attributes:
        allowed: Whether the resource is allowed
        reason: Human-readable explanation of the decision
        matched_pattern: The pattern that matched (if any)
    """
    allowed: bool
    reason: str
    matched_pattern: Optional[str] = None


@dataclass
class CachedAllowlistEntry:
    """
    Cached allowlist entry with compiled patterns.
    
    Attributes:
        allowlists: List of ResourceAllowlist objects
        compiled_patterns: Dict mapping pattern to compiled regex (for regex patterns only)
        cached_at: Timestamp when entry was cached
    """
    allowlists: List[ResourceAllowlist]
    compiled_patterns: Dict[str, re.Pattern]
    cached_at: float


class AllowlistManager:
    """
    Manages resource allowlists with regex and glob pattern matching.
    
    Provides methods to create, query, and check resource allowlists for agents.
    Supports both regex and glob pattern types with validation and caching.
    
    Requirements: 7.3, 7.4, 7.5, 7.6, 7.7, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 18.6
    """
    
    def __init__(self, db_session: Session, cache_ttl_seconds: int = 60):
        """
        Initialize AllowlistManager.
        
        Args:
            db_session: SQLAlchemy database session
            cache_ttl_seconds: TTL for cached allowlist entries (default: 60 seconds)
        """
        self.db_session = db_session
        self.cache_ttl_seconds = cache_ttl_seconds
        self._pattern_cache = {}  # Cache for compiled regex patterns (legacy)
        self._allowlist_cache: Dict[UUID, CachedAllowlistEntry] = {}  # Cache for agent allowlists
        
        # Cache statistics
        self._cache_hits = 0
        self._cache_misses = 0
        self._cache_invalidations = 0
    
    def create_allowlist(
        self,
        agent_id: UUID,
        resource_pattern: str,
        pattern_type: str
    ) -> ResourceAllowlist:
        """
        Create a new resource allowlist entry.
        
        Validates the pattern before creating the allowlist. For regex patterns,
        compiles the pattern to ensure it's valid. For glob patterns, performs
        basic validation.
        
        Args:
            agent_id: UUID of the agent
            resource_pattern: Pattern to match resources against
            pattern_type: Type of pattern ("regex" or "glob")
        
        Returns:
            Created ResourceAllowlist object
        
        Raises:
            ValidationError: If pattern_type is invalid or pattern is malformed
        
        Requirements: 7.1, 7.2, 8.3, 8.4
        """
        # Validate pattern type
        if pattern_type not in ("regex", "glob"):
            raise ValidationError(
                f"Invalid pattern_type: {pattern_type}. Must be 'regex' or 'glob'."
            )
        
        # Validate pattern
        self._validate_pattern(resource_pattern, pattern_type)
        
        # Create allowlist entry
        allowlist = ResourceAllowlist(
            agent_id=agent_id,
            resource_pattern=resource_pattern,
            pattern_type=pattern_type,
            created_at=datetime.utcnow(),
            active=True
        )
        
        self.db_session.add(allowlist)
        self.db_session.commit()
        self.db_session.refresh(allowlist)
        
        # Invalidate cache for this agent
        self.invalidate_cache(agent_id)
        
        logger.info(
            f"Created allowlist {allowlist.allowlist_id} for agent {agent_id}: "
            f"{pattern_type} pattern '{resource_pattern[:50]}...'"
        )
        
        return allowlist
    
    def check_resource(self, agent_id: UUID, resource_url: str) -> AllowlistDecision:
        """
        Check if a resource is allowed for an agent.
        
        Implements the following logic:
        1. Check cache for agent's allowlists
        2. If cache miss or expired, query database and cache results
        3. If no allowlists exist, return allowed (default allow)
        4. For each allowlist, test if the pattern matches
        5. If any pattern matches, return allowed
        6. If no patterns match, return denied
        
        Args:
            agent_id: UUID of the agent
            resource_url: URL of the resource to check
        
        Returns:
            AllowlistDecision with the result
        
        Requirements: 7.3, 7.4, 7.5, 7.6, 8.1, 8.2, 8.6, 18.6
        """
        # Check cache first
        cached_entry = self._get_cached_allowlists(agent_id)
        
        if cached_entry is None:
            # Cache miss - query database
            self._cache_misses += 1
            allowlists = self.list_allowlists(agent_id)
            
            # Compile regex patterns and cache
            compiled_patterns = {}
            for allowlist in allowlists:
                if allowlist.pattern_type == "regex":
                    try:
                        compiled_patterns[allowlist.resource_pattern] = re.compile(allowlist.resource_pattern)
                    except re.error as e:
                        logger.error(f"Failed to compile regex pattern '{allowlist.resource_pattern}': {e}")
            
            # Cache the entry
            cached_entry = CachedAllowlistEntry(
                allowlists=allowlists,
                compiled_patterns=compiled_patterns,
                cached_at=time.time()
            )
            self._allowlist_cache[agent_id] = cached_entry
            
            logger.debug(f"Cached {len(allowlists)} allowlist(s) for agent {agent_id}")
        else:
            self._cache_hits += 1
            allowlists = cached_entry.allowlists
        
        # Default allow if no allowlists configured
        if not allowlists:
            logger.debug(
                f"No allowlists configured for agent {agent_id}, allowing resource: {resource_url}"
            )
            return AllowlistDecision(
                allowed=True,
                reason="No allowlists configured (default allow)",
                matched_pattern=None
            )
        
        # Check each pattern using cached compiled patterns
        for allowlist in allowlists:
            if allowlist.pattern_type == "regex":
                # Use cached compiled pattern
                compiled_pattern = cached_entry.compiled_patterns.get(allowlist.resource_pattern)
                if compiled_pattern and compiled_pattern.match(resource_url):
                    logger.info(
                        f"Resource {resource_url} allowed for agent {agent_id}: "
                        f"matched regex pattern '{allowlist.resource_pattern[:50]}...'"
                    )
                    return AllowlistDecision(
                        allowed=True,
                        reason=f"Matched regex pattern",
                        matched_pattern=allowlist.resource_pattern
                    )
            elif allowlist.pattern_type == "glob":
                # Use fnmatch for glob patterns
                if fnmatch.fnmatch(resource_url, allowlist.resource_pattern):
                    logger.info(
                        f"Resource {resource_url} allowed for agent {agent_id}: "
                        f"matched glob pattern '{allowlist.resource_pattern[:50]}...'"
                    )
                    return AllowlistDecision(
                        allowed=True,
                        reason=f"Matched glob pattern",
                        matched_pattern=allowlist.resource_pattern
                    )
        
        # No patterns matched, deny
        logger.warning(
            f"Resource {resource_url} denied for agent {agent_id}: "
            f"no matching patterns in {len(allowlists)} allowlist(s)"
        )
        return AllowlistDecision(
            allowed=False,
            reason=f"Resource not in allowlist ({len(allowlists)} pattern(s) checked)",
            matched_pattern=None
        )
    
    def match_pattern(
        self,
        pattern: str,
        pattern_type: str,
        resource_url: str
    ) -> bool:
        """
        Match a resource URL against a pattern.
        
        For regex patterns, uses Python's re module with caching.
        For glob patterns, uses fnmatch module.
        
        Args:
            pattern: Pattern to match against
            pattern_type: Type of pattern ("regex" or "glob")
            resource_url: URL to test
        
        Returns:
            True if the pattern matches, False otherwise
        
        Requirements: 8.1, 8.2, 8.5
        """
        if pattern_type == "regex":
            return self._match_regex(pattern, resource_url)
        elif pattern_type == "glob":
            return self._match_glob(pattern, resource_url)
        else:
            logger.error(f"Invalid pattern_type: {pattern_type}")
            return False
    
    def list_allowlists(self, agent_id: UUID) -> List[ResourceAllowlist]:
        """
        List all active allowlists for an agent.
        
        Args:
            agent_id: UUID of the agent
        
        Returns:
            List of active ResourceAllowlist objects
        
        Requirements: 7.7
        """
        stmt = select(ResourceAllowlist).where(
            ResourceAllowlist.agent_id == agent_id,
            ResourceAllowlist.active == True
        )
        result = self.db_session.execute(stmt)
        return list(result.scalars().all())
    
    def deactivate_allowlist(self, allowlist_id: UUID) -> None:
        """
        Deactivate an allowlist (soft delete).
        
        Args:
            allowlist_id: UUID of the allowlist to deactivate
        
        Raises:
            ValueError: If allowlist not found
        
        Requirements: 7.7, 18.6
        """
        stmt = select(ResourceAllowlist).where(
            ResourceAllowlist.allowlist_id == allowlist_id
        )
        result = self.db_session.execute(stmt)
        allowlist = result.scalar_one_or_none()
        
        if not allowlist:
            raise ValueError(f"Allowlist {allowlist_id} not found")
        
        allowlist.active = False
        self.db_session.commit()
        
        # Invalidate cache for this agent
        self.invalidate_cache(allowlist.agent_id)
        
        logger.info(f"Deactivated allowlist {allowlist_id} for agent {allowlist.agent_id}")
    
    def invalidate_cache(self, agent_id: UUID) -> None:
        """
        Invalidate cached allowlists for an agent.
        
        Should be called when allowlists are created, modified, or deleted.
        
        Args:
            agent_id: UUID of the agent
        
        Requirements: 18.6
        """
        if agent_id in self._allowlist_cache:
            del self._allowlist_cache[agent_id]
            self._cache_invalidations += 1
            logger.debug(f"Invalidated allowlist cache for agent {agent_id}")
    
    def get_cache_stats(self) -> Dict[str, int]:
        """
        Get cache statistics.
        
        Returns:
            Dictionary with cache statistics
        """
        total_requests = self._cache_hits + self._cache_misses
        hit_rate = self._cache_hits / total_requests if total_requests > 0 else 0.0
        
        return {
            "cache_hits": self._cache_hits,
            "cache_misses": self._cache_misses,
            "cache_invalidations": self._cache_invalidations,
            "cache_size": len(self._allowlist_cache),
            "hit_rate": hit_rate
        }
    
    def _get_cached_allowlists(self, agent_id: UUID) -> Optional[CachedAllowlistEntry]:
        """
        Get cached allowlists for an agent if not expired.
        
        Args:
            agent_id: UUID of the agent
        
        Returns:
            CachedAllowlistEntry if found and not expired, None otherwise
        """
        if agent_id not in self._allowlist_cache:
            return None
        
        cached_entry = self._allowlist_cache[agent_id]
        age_seconds = time.time() - cached_entry.cached_at
        
        if age_seconds > self.cache_ttl_seconds:
            # Cache expired
            del self._allowlist_cache[agent_id]
            logger.debug(f"Allowlist cache expired for agent {agent_id} (age={age_seconds:.1f}s)")
            return None
        
        return cached_entry
    
    def _validate_pattern(self, pattern: str, pattern_type: str) -> None:
        """
        Validate a pattern at creation time.
        
        For regex patterns, attempts to compile the pattern.
        For glob patterns, performs basic validation.
        
        Args:
            pattern: Pattern to validate
            pattern_type: Type of pattern ("regex" or "glob")
        
        Raises:
            ValidationError: If pattern is invalid
        
        Requirements: 8.3, 8.4
        """
        if pattern_type == "regex":
            try:
                re.compile(pattern)
            except re.error as e:
                raise ValidationError(f"Invalid regex pattern: {e}")
        elif pattern_type == "glob":
            # Basic validation for glob patterns
            # fnmatch doesn't have a compile step, so we just check for obvious issues
            if not pattern:
                raise ValidationError("Glob pattern cannot be empty")
            # Test the pattern with a dummy string to ensure it's valid
            try:
                fnmatch.fnmatch("test", pattern)
            except Exception as e:
                raise ValidationError(f"Invalid glob pattern: {e}")
    
    def _match_regex(self, pattern: str, resource_url: str) -> bool:
        """
        Match a resource URL against a regex pattern with caching.
        
        Args:
            pattern: Regex pattern
            resource_url: URL to test
        
        Returns:
            True if the pattern matches, False otherwise
        
        Requirements: 8.1, 8.5
        """
        # Check cache
        if pattern not in self._pattern_cache:
            try:
                self._pattern_cache[pattern] = re.compile(pattern)
            except re.error as e:
                logger.error(f"Failed to compile regex pattern '{pattern}': {e}")
                return False
        
        compiled_pattern = self._pattern_cache[pattern]
        return bool(compiled_pattern.match(resource_url))
    
    def _match_glob(self, pattern: str, resource_url: str) -> bool:
        """
        Match a resource URL against a glob pattern.
        
        Args:
            pattern: Glob pattern
            resource_url: URL to test
        
        Returns:
            True if the pattern matches, False otherwise
        
        Requirements: 8.2
        """
        return fnmatch.fnmatch(resource_url, pattern)
