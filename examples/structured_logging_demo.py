#!/usr/bin/env python
"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs


"""

"""
Demo of structured logging in Caracal Core.

This example demonstrates how to use the structured logging features
including JSON format, correlation IDs, and convenience logging functions.
"""

import tempfile
from pathlib import Path
from caracal.logging_config import (
    setup_logging,
    get_logger,
    set_correlation_id,
    clear_correlation_id,
    log_budget_decision,
    log_authentication_failure,
    log_database_query,
    log_delegation_token_validation,
)


def main():
    """Run structured logging demo."""
    
    # Setup logging with JSON format for production
    with tempfile.TemporaryDirectory() as tmpdir:
        log_file = Path(tmpdir) / "caracal.log"
        setup_logging(level="INFO", log_file=log_file, json_format=True)
        
        logger = get_logger("demo")
        
        print("=" * 60)
        print("Structured Logging Demo")
        print("=" * 60)
        print(f"\nLog file: {log_file}\n")
        
        # Example 1: Basic structured logging
        print("1. Basic structured logging with custom fields:")
        logger.info("application_started", version="1.0.0", environment="production")
        
        # Example 2: Using correlation IDs for request tracing
        print("2. Using correlation IDs for request tracing:")
        correlation_id = set_correlation_id("req-12345")
        logger.info("request_received", method="POST", path="/api/agents")
        logger.info("processing_request", step="authentication")
        logger.info("processing_request", step="policy_check")
        logger.info("request_completed", status=200, duration_ms=45.2)
        clear_correlation_id()
        
        # Example 3: Budget decision logging
        print("3. Budget decision logging:")
        log_budget_decision(
            logger,
            agent_id="agent-550e8400",
            decision="allow",
            remaining_budget="95.50",
            provisional_charge_id="charge-abc123",
            reason="Within daily budget limit"
        )
        
        log_budget_decision(
            logger,
            agent_id="agent-deadbeef",
            decision="deny",
            reason="Insufficient budget: need 10.00, available 5.00"
        )
        
        # Example 4: Authentication failure logging
        print("4. Authentication failure logging:")
        log_authentication_failure(
            logger,
            auth_method="jwt",
            agent_id="agent-badtoken",
            reason="expired_token",
            token_expiry="2024-01-15T10:00:00Z"
        )
        
        # Example 5: Database query logging
        print("5. Database query logging:")
        log_database_query(
            logger,
            operation="select",
            table="agent_identities",
            duration_ms=5.2,
            rows_returned=1
        )
        
        log_database_query(
            logger,
            operation="insert",
            table="ledger_events",
            duration_ms=12.8,
            rows_affected=1
        )
        
        # Example 6: Delegation token validation logging
        print("6. Delegation token validation logging:")
        log_delegation_token_validation(
            logger,
            parent_agent_id="parent-123",
            child_agent_id="child-456",
            success=True,
            spending_limit="100.00"
        )
        
        log_delegation_token_validation(
            logger,
            parent_agent_id="parent-789",
            child_agent_id="child-abc",
            success=False,
            reason="invalid_signature"
        )
        
        # Show log file contents
        print("\n" + "=" * 60)
        print("Log file contents (JSON format):")
        print("=" * 60)
        print(log_file.read_text())
        
        print("\n" + "=" * 60)
        print("Demo completed successfully!")
        print("=" * 60)
        print("\nKey features demonstrated:")
        print("  ✓ JSON format for log aggregation")
        print("  ✓ Correlation IDs for request tracing")
        print("  ✓ Structured fields for filtering and analysis")
        print("  ✓ Convenience functions for common log patterns")
        print("  ✓ Budget decision logging (Requirement 22.2)")
        print("  ✓ Authentication failure logging (Requirement 22.2)")
        print("  ✓ Database query logging (Requirement 22.3)")
        print("  ✓ Delegation token validation logging (Requirement 22.4)")
        print("  ✓ Correlation IDs for tracing (Requirement 22.7)")


if __name__ == "__main__":
    main()
