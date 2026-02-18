"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Policy Cache Demonstration

This script demonstrates the PolicyCache functionality for degraded mode operation:
- Cache initialization
- Policy caching with TTL
- Cache hits and misses
- Explicit invalidation
- Cache statistics
"""

import asyncio
from decimal import Decimal
from datetime import datetime

from caracal.gateway.cache import PolicyCache, PolicyCacheConfig
from caracal.core.policy import BudgetPolicy


async def main():
    """Demonstrate policy cache functionality."""
    
    print("=" * 60)
    print("Policy Cache Demonstration")
    print("=" * 60)
    print()
    
    # 1. Initialize cache
    print("1. Initializing PolicyCache with TTL=60s, max_size=100")
    config = PolicyCacheConfig(
        ttl_seconds=60,
        max_size=100,
        eviction_policy="LRU",
        invalidation_enabled=True
    )
    cache = PolicyCache(config)
    print(f"   ✓ Cache initialized")
    print()
    
    # 2. Create sample policies
    print("2. Creating sample policies")
    policy1 = BudgetPolicy(
        policy_id="policy-001",
        agent_id="agent-001",
        limit_amount="100.00",
        time_window="daily",
        currency="USD",
        created_at=datetime.utcnow().isoformat() + "Z",
        active=True
    )
    
    policy2 = BudgetPolicy(
        policy_id="policy-002",
        agent_id="agent-002",
        limit_amount="200.00",
        time_window="daily",
        currency="USD",
        created_at=datetime.utcnow().isoformat() + "Z",
        active=True
    )
    print(f"   ✓ Created policy for agent-001 (limit: $100)")
    print(f"   ✓ Created policy for agent-002 (limit: $200)")
    print()
    
    # 3. Cache policies
    print("3. Caching policies")
    await cache.put("agent-001", policy1)
    await cache.put("agent-002", policy2)
    print(f"   ✓ Cached policy for agent-001")
    print(f"   ✓ Cached policy for agent-002")
    print()
    
    # 4. Cache hits
    print("4. Testing cache hits")
    cached1 = await cache.get("agent-001")
    cached2 = await cache.get("agent-002")
    print(f"   ✓ Cache hit for agent-001: limit=${cached1.policy.limit_amount}")
    print(f"   ✓ Cache hit for agent-002: limit=${cached2.policy.limit_amount}")
    print()
    
    # 5. Cache miss
    print("5. Testing cache miss")
    cached3 = await cache.get("agent-003")
    print(f"   ✓ Cache miss for agent-003: {cached3}")
    print()
    
    # 6. Cache statistics
    print("6. Cache statistics")
    stats = cache.get_stats()
    print(f"   Hit count: {stats.hit_count}")
    print(f"   Miss count: {stats.miss_count}")
    print(f"   Hit rate: {stats.hit_rate:.1f}%")
    print(f"   Cache size: {stats.size}/{stats.max_size}")
    print(f"   Evictions: {stats.eviction_count}")
    print(f"   Invalidations: {stats.invalidation_count}")
    print()
    
    # 7. Explicit invalidation
    print("7. Testing explicit invalidation")
    await cache.invalidate("agent-001")
    print(f"   ✓ Invalidated cache for agent-001")
    
    cached1_after = await cache.get("agent-001")
    print(f"   ✓ Cache miss after invalidation: {cached1_after}")
    print()
    
    # 8. Pattern invalidation
    print("8. Testing pattern invalidation")
    
    # Add more policies with pattern
    await cache.put("parent-agent-1", policy1)
    await cache.put("parent-agent-2", policy1)
    await cache.put("child-agent-1", policy2)
    print(f"   ✓ Cached policies for parent-agent-1, parent-agent-2, child-agent-1")
    
    count = await cache.invalidate_pattern("parent-*")
    print(f"   ✓ Invalidated {count} policies matching 'parent-*'")
    
    # Verify
    parent1 = await cache.get("parent-agent-1")
    child1 = await cache.get("child-agent-1")
    print(f"   ✓ parent-agent-1 after pattern invalidation: {parent1}")
    print(f"   ✓ child-agent-1 still cached: {child1 is not None}")
    print()
    
    # 9. Final statistics
    print("9. Final cache statistics")
    final_stats = cache.get_stats()
    print(f"   Hit count: {final_stats.hit_count}")
    print(f"   Miss count: {final_stats.miss_count}")
    print(f"   Hit rate: {final_stats.hit_rate:.1f}%")
    print(f"   Cache size: {final_stats.size}/{final_stats.max_size}")
    print(f"   Evictions: {final_stats.eviction_count}")
    print(f"   Invalidations: {final_stats.invalidation_count}")
    print()
    
    # 10. Degraded mode simulation
    print("10. Simulating degraded mode operation")
    print("    Scenario: Policy service is unavailable, using cached policy")
    
    # Cache a policy
    await cache.put("agent-degraded", policy1)
    print(f"   ✓ Cached policy for agent-degraded")
    
    # Simulate policy service failure - use cached policy
    cached_policy = await cache.get("agent-degraded")
    if cached_policy:
        cache_age = (datetime.utcnow() - cached_policy.cached_at).total_seconds()
        print(f"   ✓ Using cached policy (age: {cache_age:.1f}s)")
        print(f"   ✓ Policy limit: ${cached_policy.policy.limit_amount}")
        print(f"   ⚠ Degraded mode: Policy evaluated using cached data")
    else:
        print(f"   ✗ No cached policy available - would fail closed")
    print()
    
    print("=" * 60)
    print("Demonstration Complete")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
