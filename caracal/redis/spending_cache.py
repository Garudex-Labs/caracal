"""
Redis spending cache for Caracal Core v0.3.

Provides real-time spending cache with time-range queries and TTL management.

Requirements: 20.3, 20.4, 16.4
"""

from datetime import datetime, timedelta
from decimal import Decimal
from typing import Optional, Dict, List, Tuple
from uuid import UUID

from caracal.redis.client import RedisClient
from caracal.logging_config import get_logger

logger = get_logger(__name__)


class RedisSpendingCache:
    """
    Redis-based spending cache for real-time metrics.
    
    Provides:
    - Real-time spending totals per agent
    - Time-range spending queries using sorted sets
    - Spending trend calculation (hourly, daily, weekly)
    - TTL management (24 hours default)
    
    Requirements: 20.3, 20.4, 16.4
    """
    
    # Key prefixes
    PREFIX_SPENDING_TOTAL = "caracal:spending:total"
    PREFIX_SPENDING_EVENTS = "caracal:spending:events"
    PREFIX_SPENDING_TREND = "caracal:spending:trend"
    PREFIX_EVENT_COUNT = "caracal:events:count"
    
    # Default TTL (24 hours)
    DEFAULT_TTL_SECONDS = 86400
    
    def __init__(self, redis_client: RedisClient, ttl_seconds: int = DEFAULT_TTL_SECONDS):
        """
        Initialize spending cache.
        
        Args:
            redis_client: RedisClient instance
            ttl_seconds: TTL for cached entries in seconds (default: 24 hours)
        """
        self.redis = redis_client
        self.ttl_seconds = ttl_seconds
        
        logger.info(f"RedisSpendingCache initialized with TTL={ttl_seconds}s")
    
    def update_spending(
        self,
        agent_id: str,
        cost: Decimal,
        timestamp: datetime,
        event_id: str
    ) -> None:
        """
        Update spending for agent.
        
        Stores:
        - Total spending (incremented)
        - Event in sorted set (score = timestamp)
        - Event count
        
        Args:
            agent_id: Agent identifier
            cost: Cost to add
            timestamp: Event timestamp
            event_id: Event identifier
            
        Requirements: 20.3, 20.4
        """
        try:
            # Update total spending
            total_key = f"{self.PREFIX_SPENDING_TOTAL}:{agent_id}"
            self.redis.incrbyfloat(total_key, float(cost))
            self.redis.expire(total_key, self.ttl_seconds)
            
            # Add event to sorted set (score = Unix timestamp)
            events_key = f"{self.PREFIX_SPENDING_EVENTS}:{agent_id}"
            score = timestamp.timestamp()
            member = f"{event_id}:{float(cost)}"
            self.redis.zadd(events_key, {member: score})
            self.redis.expire(events_key, self.ttl_seconds)
            
            # Increment event count
            count_key = f"{self.PREFIX_EVENT_COUNT}:{agent_id}"
            self.redis.incr(count_key)
            self.redis.expire(count_key, self.ttl_seconds)
            
            logger.debug(
                f"Updated spending cache: agent_id={agent_id}, cost={cost}, "
                f"timestamp={timestamp}, event_id={event_id}"
            )
        
        except Exception as e:
            logger.error(
                f"Failed to update spending cache for agent {agent_id}: {e}",
                exc_info=True
            )
            # Don't raise - cache failures shouldn't break the consumer
    
    def get_total_spending(self, agent_id: str) -> Optional[Decimal]:
        """
        Get total spending for agent.
        
        Args:
            agent_id: Agent identifier
            
        Returns:
            Total spending as Decimal, or None if not cached
            
        Requirements: 20.3, 20.4
        """
        try:
            total_key = f"{self.PREFIX_SPENDING_TOTAL}:{agent_id}"
            value = self.redis.get(total_key)
            
            if value is None:
                return None
            
            return Decimal(value)
        
        except Exception as e:
            logger.error(
                f"Failed to get total spending for agent {agent_id}: {e}",
                exc_info=True
            )
            return None
    
    def get_spending_in_range(
        self,
        agent_id: str,
        start_time: datetime,
        end_time: datetime
    ) -> Decimal:
        """
        Get spending for agent in time range.
        
        Queries sorted set by score (timestamp) range.
        
        Args:
            agent_id: Agent identifier
            start_time: Start of time range
            end_time: End of time range
            
        Returns:
            Total spending in range as Decimal
            
        Requirements: 20.3, 20.4
        """
        try:
            events_key = f"{self.PREFIX_SPENDING_EVENTS}:{agent_id}"
            
            # Query sorted set by score range
            min_score = start_time.timestamp()
            max_score = end_time.timestamp()
            
            events = self.redis.zrangebyscore(
                events_key,
                min_score,
                max_score,
                withscores=False
            )
            
            # Sum costs from events
            total = Decimal(0)
            for event in events:
                # Event format: "event_id:cost"
                parts = event.split(':', 1)
                if len(parts) == 2:
                    cost = Decimal(parts[1])
                    total += cost
            
            logger.debug(
                f"Got spending in range: agent_id={agent_id}, "
                f"start={start_time}, end={end_time}, total={total}"
            )
            
            return total
        
        except Exception as e:
            logger.error(
                f"Failed to get spending in range for agent {agent_id}: {e}",
                exc_info=True
            )
            return Decimal(0)
    
    def get_event_count(self, agent_id: str) -> int:
        """
        Get event count for agent.
        
        Args:
            agent_id: Agent identifier
            
        Returns:
            Event count
        """
        try:
            count_key = f"{self.PREFIX_EVENT_COUNT}:{agent_id}"
            value = self.redis.get(count_key)
            
            if value is None:
                return 0
            
            return int(value)
        
        except Exception as e:
            logger.error(
                f"Failed to get event count for agent {agent_id}: {e}",
                exc_info=True
            )
            return 0
    
    def store_spending_trend(
        self,
        agent_id: str,
        window: str,
        timestamp: datetime,
        spending: Decimal
    ) -> None:
        """
        Store spending trend for agent.
        
        Args:
            agent_id: Agent identifier
            window: Time window ('hourly', 'daily', 'weekly')
            timestamp: Trend timestamp
            spending: Spending amount
            
        Requirements: 16.4
        """
        try:
            trend_key = f"{self.PREFIX_SPENDING_TREND}:{agent_id}:{window}"
            score = timestamp.timestamp()
            member = f"{timestamp.isoformat()}:{float(spending)}"
            
            self.redis.zadd(trend_key, {member: score})
            self.redis.expire(trend_key, self.ttl_seconds)
            
            logger.debug(
                f"Stored spending trend: agent_id={agent_id}, window={window}, "
                f"timestamp={timestamp}, spending={spending}"
            )
        
        except Exception as e:
            logger.error(
                f"Failed to store spending trend for agent {agent_id}: {e}",
                exc_info=True
            )
    
    def get_spending_trend(
        self,
        agent_id: str,
        window: str,
        start_time: datetime,
        end_time: datetime
    ) -> List[Tuple[datetime, Decimal]]:
        """
        Get spending trend for agent in time range.
        
        Args:
            agent_id: Agent identifier
            window: Time window ('hourly', 'daily', 'weekly')
            start_time: Start of time range
            end_time: End of time range
            
        Returns:
            List of (timestamp, spending) tuples
            
        Requirements: 16.4
        """
        try:
            trend_key = f"{self.PREFIX_SPENDING_TREND}:{agent_id}:{window}"
            
            # Query sorted set by score range
            min_score = start_time.timestamp()
            max_score = end_time.timestamp()
            
            trends = self.redis.zrangebyscore(
                trend_key,
                min_score,
                max_score,
                withscores=False
            )
            
            # Parse trends
            result = []
            for trend in trends:
                # Trend format: "timestamp:spending"
                parts = trend.split(':', 1)
                if len(parts) == 2:
                    ts = datetime.fromisoformat(parts[0])
                    spending = Decimal(parts[1])
                    result.append((ts, spending))
            
            logger.debug(
                f"Got spending trend: agent_id={agent_id}, window={window}, "
                f"start={start_time}, end={end_time}, count={len(result)}"
            )
            
            return result
        
        except Exception as e:
            logger.error(
                f"Failed to get spending trend for agent {agent_id}: {e}",
                exc_info=True
            )
            return []
    
    def cleanup_old_events(self, agent_id: str, before: datetime) -> int:
        """
        Remove events older than specified time.
        
        Args:
            agent_id: Agent identifier
            before: Remove events before this time
            
        Returns:
            Number of events removed
        """
        try:
            events_key = f"{self.PREFIX_SPENDING_EVENTS}:{agent_id}"
            max_score = before.timestamp()
            
            removed = self.redis.zremrangebyscore(events_key, 0, max_score)
            
            logger.debug(
                f"Cleaned up old events: agent_id={agent_id}, "
                f"before={before}, removed={removed}"
            )
            
            return removed
        
        except Exception as e:
            logger.error(
                f"Failed to cleanup old events for agent {agent_id}: {e}",
                exc_info=True
            )
            return 0
    
    def clear_agent_cache(self, agent_id: str) -> None:
        """
        Clear all cached data for agent.
        
        Args:
            agent_id: Agent identifier
        """
        try:
            # Delete all keys for agent
            keys_to_delete = [
                f"{self.PREFIX_SPENDING_TOTAL}:{agent_id}",
                f"{self.PREFIX_SPENDING_EVENTS}:{agent_id}",
                f"{self.PREFIX_EVENT_COUNT}:{agent_id}",
                f"{self.PREFIX_SPENDING_TREND}:{agent_id}:hourly",
                f"{self.PREFIX_SPENDING_TREND}:{agent_id}:daily",
                f"{self.PREFIX_SPENDING_TREND}:{agent_id}:weekly",
            ]
            
            self.redis.delete(*keys_to_delete)
            
            logger.info(f"Cleared cache for agent {agent_id}")
        
        except Exception as e:
            logger.error(
                f"Failed to clear cache for agent {agent_id}: {e}",
                exc_info=True
            )
