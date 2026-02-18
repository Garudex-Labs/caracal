"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Replay protection for Gateway Proxy.

Implements request replay protection using:
- Nonce cache with TTL for preventing duplicate requests
- Timestamp validation with 5-minute window

Requirements: 1.7, 2.5, 2.6
"""

import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional, Set

from cachetools import TTLCache

from caracal.logging_config import get_logger

logger = get_logger(__name__)


@dataclass
class ReplayProtectionConfig:
    """
    Configuration for replay protection.
    
    Attributes:
        nonce_cache_ttl: Time-to-live for nonce cache in seconds (default: 300 = 5 minutes)
        nonce_cache_size: Maximum number of nonces to cache (default: 100000)
        timestamp_window_seconds: Maximum age of timestamps in seconds (default: 300 = 5 minutes)
        enable_nonce_validation: Enable nonce-based replay protection (default: True)
        enable_timestamp_validation: Enable timestamp-based replay protection (default: True)
    """
    nonce_cache_ttl: int = 300  # 5 minutes
    nonce_cache_size: int = 100000
    timestamp_window_seconds: int = 300  # 5 minutes
    enable_nonce_validation: bool = True
    enable_timestamp_validation: bool = True


@dataclass
class ReplayCheckResult:
    """
    Result of replay protection check.
    
    Attributes:
        allowed: Whether the request is allowed (not a replay)
        reason: Reason for denial (if not allowed)
        nonce_validated: Whether nonce validation was performed
        timestamp_validated: Whether timestamp validation was performed
    """
    allowed: bool
    reason: Optional[str] = None
    nonce_validated: bool = False
    timestamp_validated: bool = False


class ReplayProtection:
    """
    Replay protection service for gateway proxy.
    
    Prevents request replay attacks using:
    - Nonce cache: Tracks used nonces with automatic expiration
    - Timestamp validation: Rejects requests older than configured window
    
    Implements fail-closed security: all errors result in request denial.
    
    Requirements: 1.7, 2.5, 2.6
    """
    
    def __init__(self, config: Optional[ReplayProtectionConfig] = None):
        """
        Initialize ReplayProtection.
        
        Args:
            config: ReplayProtectionConfig (uses defaults if not provided)
        """
        self.config = config or ReplayProtectionConfig()
        
        # Initialize nonce cache with TTL
        self._nonce_cache: TTLCache = TTLCache(
            maxsize=self.config.nonce_cache_size,
            ttl=self.config.nonce_cache_ttl
        )
        
        # Statistics
        self._nonce_checks = 0
        self._nonce_replays_blocked = 0
        self._timestamp_checks = 0
        self._timestamp_replays_blocked = 0
        
        logger.info(
            f"Initialized ReplayProtection with nonce_ttl={self.config.nonce_cache_ttl}s, "
            f"cache_size={self.config.nonce_cache_size}, "
            f"timestamp_window={self.config.timestamp_window_seconds}s"
        )
    
    async def check_nonce(self, nonce: str) -> ReplayCheckResult:
        """
        Verify that nonce has not been used previously.
        
        Process:
        1. Check if nonce exists in cache
        2. If exists, reject as replay
        3. If not exists, add to cache and allow
        
        Args:
            nonce: Unique nonce string from request
            
        Returns:
            ReplayCheckResult indicating if request is allowed
            
        Requirements: 2.5
        """
        if not self.config.enable_nonce_validation:
            return ReplayCheckResult(
                allowed=True,
                nonce_validated=False,
                timestamp_validated=False
            )
        
        try:
            self._nonce_checks += 1
            
            # Check if nonce already exists in cache
            if nonce in self._nonce_cache:
                self._nonce_replays_blocked += 1
                logger.warning(f"Replay attack detected: nonce already used: {nonce[:16]}...")
                return ReplayCheckResult(
                    allowed=False,
                    reason=f"Nonce already used: {nonce[:16]}...",
                    nonce_validated=True,
                    timestamp_validated=False
                )
            
            # Add nonce to cache (value doesn't matter, we just track existence)
            self._nonce_cache[nonce] = True
            
            logger.debug(f"Nonce validated and cached: {nonce[:16]}...")
            return ReplayCheckResult(
                allowed=True,
                nonce_validated=True,
                timestamp_validated=False
            )
            
        except Exception as e:
            logger.error(f"Nonce validation error: {e}", exc_info=True)
            # Fail closed: deny on error
            return ReplayCheckResult(
                allowed=False,
                reason=f"Nonce validation error: {e}",
                nonce_validated=True,
                timestamp_validated=False
            )
    
    async def check_timestamp(self, timestamp: int) -> ReplayCheckResult:
        """
        Verify that request timestamp is within acceptable window.
        
        Process:
        1. Get current time
        2. Calculate age of request
        3. Reject if older than configured window (default: 5 minutes)
        
        Args:
            timestamp: Unix timestamp (seconds since epoch) from request
            
        Returns:
            ReplayCheckResult indicating if request is allowed
            
        Requirements: 2.6
        """
        if not self.config.enable_timestamp_validation:
            return ReplayCheckResult(
                allowed=True,
                nonce_validated=False,
                timestamp_validated=False
            )
        
        try:
            self._timestamp_checks += 1
            
            # Get current time
            current_time = int(time.time())
            
            # Calculate age of request
            age_seconds = current_time - timestamp
            
            # Check if timestamp is too old
            if age_seconds > self.config.timestamp_window_seconds:
                self._timestamp_replays_blocked += 1
                logger.warning(
                    f"Replay attack detected: timestamp too old: "
                    f"age={age_seconds}s, max={self.config.timestamp_window_seconds}s"
                )
                return ReplayCheckResult(
                    allowed=False,
                    reason=f"Timestamp too old: {age_seconds}s (max: {self.config.timestamp_window_seconds}s)",
                    nonce_validated=False,
                    timestamp_validated=True
                )
            
            # Check if timestamp is in the future (clock skew tolerance: 60 seconds)
            if age_seconds < -60:
                logger.warning(
                    f"Replay attack detected: timestamp in future: "
                    f"age={age_seconds}s"
                )
                return ReplayCheckResult(
                    allowed=False,
                    reason=f"Timestamp in future: {age_seconds}s",
                    nonce_validated=False,
                    timestamp_validated=True
                )
            
            logger.debug(f"Timestamp validated: age={age_seconds}s")
            return ReplayCheckResult(
                allowed=True,
                nonce_validated=False,
                timestamp_validated=True
            )
            
        except Exception as e:
            logger.error(f"Timestamp validation error: {e}", exc_info=True)
            # Fail closed: deny on error
            return ReplayCheckResult(
                allowed=False,
                reason=f"Timestamp validation error: {e}",
                nonce_validated=False,
                timestamp_validated=True
            )
    
    async def check_request(
        self,
        nonce: Optional[str] = None,
        timestamp: Optional[int] = None
    ) -> ReplayCheckResult:
        """
        Perform complete replay protection check.
        
        Validates both nonce and timestamp if provided.
        At least one must be provided for replay protection.
        
        Args:
            nonce: Optional nonce string from request
            timestamp: Optional Unix timestamp from request
            
        Returns:
            ReplayCheckResult indicating if request is allowed
        """
        # Track which validations were performed
        nonce_validated = False
        timestamp_validated = False
        
        # Check nonce if provided
        if nonce and self.config.enable_nonce_validation:
            nonce_result = await self.check_nonce(nonce)
            nonce_validated = True
            
            if not nonce_result.allowed:
                return nonce_result
        
        # Check timestamp if provided
        if timestamp and self.config.enable_timestamp_validation:
            timestamp_result = await self.check_timestamp(timestamp)
            timestamp_validated = True
            
            if not timestamp_result.allowed:
                return timestamp_result
        
        # If neither nonce nor timestamp provided, log warning but allow
        # (replay protection is optional per request)
        if not nonce_validated and not timestamp_validated:
            logger.debug("No replay protection performed: neither nonce nor timestamp provided")
        
        return ReplayCheckResult(
            allowed=True,
            nonce_validated=nonce_validated,
            timestamp_validated=timestamp_validated
        )
    
    def get_stats(self) -> dict:
        """
        Get replay protection statistics.
        
        Returns:
            Dictionary with statistics:
            - nonce_checks: Total nonce validations performed
            - nonce_replays_blocked: Number of replay attacks blocked by nonce
            - timestamp_checks: Total timestamp validations performed
            - timestamp_replays_blocked: Number of replay attacks blocked by timestamp
            - nonce_cache_size: Current number of cached nonces
            - nonce_cache_max_size: Maximum cache capacity
        """
        return {
            "nonce_checks": self._nonce_checks,
            "nonce_replays_blocked": self._nonce_replays_blocked,
            "timestamp_checks": self._timestamp_checks,
            "timestamp_replays_blocked": self._timestamp_replays_blocked,
            "nonce_cache_size": len(self._nonce_cache),
            "nonce_cache_max_size": self.config.nonce_cache_size,
        }
    
    def clear_cache(self) -> None:
        """
        Clear the nonce cache.
        
        Use cases:
        - Testing
        - System maintenance
        - Cache corruption recovery
        """
        self._nonce_cache.clear()
        logger.info("Cleared nonce cache")
