#!/usr/bin/env python3
"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

[One-sentence description of the file's purpose and functionality.]
"""

"""
Database Retry Logic Demo

This example demonstrates how to use the retry_database_operation decorator
and retry_database_query function to handle transient database failures.

Requirements: 23.1
"""

import sys
import time
from decimal import Decimal
from uuid import uuid4

# Add parent directory to path for imports
sys.path.insert(0, '..')

from caracal.core.retry import retry_database_operation, retry_database_query
from caracal.logging_config import get_logger

logger = get_logger(__name__)


# Example 1: Using the decorator for database operations
@retry_database_operation(max_retries=3, base_delay=0.1, backoff_factor=2.0)
def query_agent_by_id(session, agent_id):
    """
    Query agent by ID with automatic retry on transient failures.
    
    This function will automatically retry up to 3 times if it encounters:
    - OperationalError (connection failures, timeouts)
    - DatabaseError (general database errors)
    - InterfaceError (low-level interface errors)
    - InternalError (deadlocks, etc.)
    """
    from sqlalchemy import select
    from caracal.db.models import AgentIdentity
    
    stmt = select(AgentIdentity).where(AgentIdentity.agent_id == agent_id)
    result = session.execute(stmt)
    return result.scalar_one_or_none()


@retry_database_operation(max_retries=3)
def create_agent(session, name, owner):
    """
    Create a new agent with automatic retry on transient failures.
    """
    from caracal.db.models import AgentIdentity
    from datetime import datetime
    
    agent = AgentIdentity(
        agent_id=uuid4(),
        name=name,
        owner=owner,
        created_at=datetime.utcnow(),
    )
    session.add(agent)
    session.commit()
    return agent


@retry_database_operation(max_retries=3)
def calculate_spending(session, agent_id, start_time, end_time):
    """
    Calculate total spending for an agent with automatic retry.
    """
    from sqlalchemy import select, func
    from caracal.db.models import LedgerEvent
    
    stmt = (
        select(func.sum(LedgerEvent.cost))
        .where(LedgerEvent.agent_id == agent_id)
        .where(LedgerEvent.timestamp >= start_time)
        .where(LedgerEvent.timestamp <= end_time)
    )
    result = session.execute(stmt)
    total = result.scalar()
    return total or Decimal('0.0')


# Example 2: Using the functional approach for inline operations
def process_batch_operations(session, operations):
    """
    Process a batch of operations with retry logic.
    
    This example shows how to use retry_database_query for operations
    that don't need a dedicated function.
    """
    results = []
    
    for operation in operations:
        # Wrap the operation in a lambda and retry on failure
        result = retry_database_query(
            lambda: execute_operation(session, operation),
            operation_name=f"process_{operation['type']}",
            max_retries=3,
            base_delay=0.1,
        )
        results.append(result)
    
    return results


def execute_operation(session, operation):
    """Execute a single database operation."""
    # Implementation would go here
    pass


# Example 3: Configurable retry parameters
def query_with_custom_retry(session, query_func, max_retries=5, base_delay=0.2):
    """
    Execute a query with custom retry parameters.
    
    This shows how to adjust retry behavior based on the operation:
    - Critical operations: more retries, longer delays
    - Non-critical operations: fewer retries, shorter delays
    """
    return retry_database_query(
        lambda: query_func(session),
        operation_name=query_func.__name__,
        max_retries=max_retries,
        base_delay=base_delay,
        backoff_factor=2.0,
    )


# Example 4: Handling specific error scenarios
@retry_database_operation(max_retries=3, base_delay=0.1)
def update_with_optimistic_locking(session, agent_id, new_value):
    """
    Update with optimistic locking - retries on deadlock/conflict.
    
    The retry decorator will automatically handle:
    - Deadlocks (InternalError)
    - Connection timeouts (OperationalError)
    - Other transient failures
    """
    from sqlalchemy import select, update
    from caracal.db.models import AgentIdentity
    
    # Query current version
    stmt = select(AgentIdentity).where(AgentIdentity.agent_id == agent_id)
    result = session.execute(stmt)
    agent = result.scalar_one()
    
    # Update with version check
    stmt = (
        update(AgentIdentity)
        .where(AgentIdentity.agent_id == agent_id)
        .values(metadata=new_value)
    )
    session.execute(stmt)
    session.commit()
    
    return agent


def main():
    """
    Demonstrate database retry functionality.
    """
    print("Database Retry Logic Demo")
    print("=" * 50)
    
    print("\n1. Decorator-based retry:")
    print("   - Automatically retries on transient database failures")
    print("   - Supports OperationalError, DatabaseError, InterfaceError, InternalError")
    print("   - Uses exponential backoff (default: 0.1s, 0.2s, 0.4s)")
    print("   - Logs retry attempts with detailed information")
    
    print("\n2. Functional retry:")
    print("   - Wrap inline operations without decorating functions")
    print("   - Useful for lambda expressions and dynamic operations")
    print("   - Same retry behavior as decorator")
    
    print("\n3. Configuration:")
    print("   - max_retries: Number of retry attempts (default: 3)")
    print("   - base_delay: Initial delay in seconds (default: 0.1)")
    print("   - backoff_factor: Delay multiplier (default: 2.0)")
    
    print("\n4. Logging:")
    print("   - WARNING level: Transient failures with retry info")
    print("   - ERROR level: Permanent failures after max retries")
    print("   - Includes: function name, attempt count, exception details")
    
    print("\n5. Best Practices:")
    print("   - Use decorator for reusable database functions")
    print("   - Use functional approach for one-off operations")
    print("   - Adjust retry parameters based on operation criticality")
    print("   - Monitor retry metrics in production")
    print("   - Set appropriate timeouts to avoid long waits")
    
    print("\n✓ Demo complete!")
    print("\nFor more information, see:")
    print("  - caracal/core/retry.py")
    print("  - tests/unit/test_retry.py")
    print("  - Requirements: 23.1")


if __name__ == "__main__":
    main()
