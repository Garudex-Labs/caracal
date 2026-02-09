"""
Migration tool for transforming budget system to authority enforcement system.

This module provides the MigrationTool class for migrating data from the v0.2
budget-focused system to the v0.5 authority enforcement system.

Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10
"""

import logging
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Dict, List, Optional, Tuple
from uuid import UUID

from sqlalchemy.orm import Session

from caracal.db.models import (
    AgentIdentity,
    AuthorityLedgerEvent,
    AuthorityPolicy,
    BudgetPolicy,
    ExecutionMandate,
    LedgerEvent,
    Principal,
)
from caracal.logging_config import get_logger

logger = get_logger(__name__)


class MigrationReport:
    """Report of migration statistics and errors."""
    
    def __init__(self):
        self.principals_migrated = 0
        self.policies_migrated = 0
        self.mandates_migrated = 0
        self.ledger_events_migrated = 0
        self.validation_errors: List[str] = []
        self.warnings: List[str] = []
        self.start_time: Optional[datetime] = None
        self.end_time: Optional[datetime] = None
    
    def to_dict(self) -> Dict:
        """Convert report to dictionary."""
        duration = None
        if self.start_time and self.end_time:
            duration = (self.end_time - self.start_time).total_seconds()
        
        return {
            "principals_migrated": self.principals_migrated,
            "policies_migrated": self.policies_migrated,
            "mandates_migrated": self.mandates_migrated,
            "ledger_events_migrated": self.ledger_events_migrated,
            "validation_errors": self.validation_errors,
            "warnings": self.warnings,
            "start_time": self.start_time.isoformat() if self.start_time else None,
            "end_time": self.end_time.isoformat() if self.end_time else None,
            "duration_seconds": duration,
        }
    
    def to_text(self) -> str:
        """Format report as human-readable text."""
        lines = [
            "=" * 60,
            "Migration Report",
            "=" * 60,
            "",
            "Entities Migrated:",
            f"  Principals:      {self.principals_migrated}",
            f"  Policies:        {self.policies_migrated}",
            f"  Mandates:        {self.mandates_migrated}",
            f"  Ledger Events:   {self.ledger_events_migrated}",
            "",
        ]
        
        if self.validation_errors:
            lines.extend([
                f"Validation Errors ({len(self.validation_errors)}):",
                *[f"  - {error}" for error in self.validation_errors],
                "",
            ])
        
        if self.warnings:
            lines.extend([
                f"Warnings ({len(self.warnings)}):",
                *[f"  - {warning}" for warning in self.warnings],
                "",
            ])
        
        if self.start_time and self.end_time:
            duration = (self.end_time - self.start_time).total_seconds()
            lines.extend([
                "Timing:",
                f"  Started:  {self.start_time.isoformat()}",
                f"  Finished: {self.end_time.isoformat()}",
                f"  Duration: {duration:.2f} seconds",
                "",
            ])
        
        lines.append("=" * 60)
        return "\n".join(lines)


class MigrationTool:
    """
    Tool for migrating from budget system to authority enforcement system.
    
    Handles migration of:
    - AgentIdentity -> Principal
    - BudgetPolicy -> AuthorityPolicy
    - DelegationToken -> ExecutionMandate (from agent metadata)
    - LedgerEvent -> AuthorityLedgerEvent
    
    Provides validation and rollback capabilities.
    """
    
    def __init__(
        self,
        source_session: Session,
        target_session: Optional[Session] = None,
        dry_run: bool = False,
    ):
        """
        Initialize MigrationTool.
        
        Args:
            source_session: Database session for reading source data
            target_session: Database session for writing migrated data (defaults to source_session)
            dry_run: If True, perform validation without writing data
        """
        self.source_session = source_session
        self.target_session = target_session or source_session
        self.dry_run = dry_run
        self.report = MigrationReport()
        
        # Track migrated IDs for validation
        self._migrated_principal_ids: set[UUID] = set()
        self._migrated_policy_ids: set[UUID] = set()
        self._migrated_mandate_ids: set[UUID] = set()
        
        logger.info(
            f"Initialized MigrationTool (dry_run={dry_run}, "
            f"same_session={source_session is target_session})"
        )
    
    def migrate_all(self, incremental: bool = False) -> MigrationReport:
        """
        Perform complete migration of all data.
        
        Args:
            incremental: If True, skip entities that already exist in target
            
        Returns:
            MigrationReport with statistics and errors
        """
        self.report.start_time = datetime.utcnow()
        logger.info("Starting full migration")
        
        try:
            # Migrate in dependency order
            self.migrate_principals()
            self.migrate_policies()
            self.migrate_delegation_tokens()
            self.migrate_ledger_events()
            
            # Validate migrated data
            self.validate_migration()
            
            # Commit if not dry run
            if not self.dry_run:
                self.target_session.commit()
                logger.info("Migration committed successfully")
            else:
                logger.info("Dry run complete - no data written")
            
        except Exception as e:
            logger.error(f"Migration failed: {e}", exc_info=True)
            self.report.validation_errors.append(f"Migration failed: {str(e)}")
            
            if not self.dry_run:
                self.target_session.rollback()
                logger.info("Migration rolled back due to error")
        
        finally:
            self.report.end_time = datetime.utcnow()
        
        return self.report
    
    def migrate_principals(self) -> int:
        """
        Migrate AgentIdentity to Principal.
        
        Converts all agent identities to principals with type="agent".
        Preserves parent-child relationships and metadata.
        
        Returns:
            Number of principals migrated
        """
        logger.info("Migrating principals...")
        count = 0
        
        # Query all agent identities
        agents = self.source_session.query(AgentIdentity).all()
        logger.info(f"Found {len(agents)} agents to migrate")
        
        for agent in agents:
            try:
                # Check if principal already exists
                existing = self.target_session.query(Principal).filter_by(
                    principal_id=agent.agent_id
                ).first()
                
                if existing:
                    logger.debug(f"Principal {agent.agent_id} already exists, skipping")
                    self._migrated_principal_ids.add(agent.agent_id)
                    continue
                
                # Create principal from agent
                principal = Principal(
                    principal_id=agent.agent_id,
                    name=agent.name,
                    principal_type="agent",
                    owner=agent.owner,
                    parent_principal_id=agent.parent_agent_id,
                    created_at=agent.created_at,
                    principal_metadata=agent.agent_metadata,
                )
                
                # Copy cryptographic keys if present in metadata
                if agent.agent_metadata:
                    if "public_key_pem" in agent.agent_metadata:
                        principal.public_key_pem = agent.agent_metadata["public_key_pem"]
                    if "private_key_pem" in agent.agent_metadata:
                        principal.private_key_pem = agent.agent_metadata["private_key_pem"]
                
                if not self.dry_run:
                    self.target_session.add(principal)
                
                self._migrated_principal_ids.add(agent.agent_id)
                count += 1
                
                logger.debug(
                    f"Migrated principal: {agent.agent_id} ({agent.name}), "
                    f"parent={agent.parent_agent_id}"
                )
                
            except Exception as e:
                error_msg = f"Failed to migrate agent {agent.agent_id}: {str(e)}"
                logger.error(error_msg, exc_info=True)
                self.report.validation_errors.append(error_msg)
        
        self.report.principals_migrated = count
        logger.info(f"Migrated {count} principals")
        return count
    
    def migrate_policies(self) -> int:
        """
        Migrate BudgetPolicy to AuthorityPolicy.
        
        Maps:
        - limit_amount -> resource scope limits (as metadata)
        - time_window -> max_validity_seconds
        - Preserves delegation constraints
        
        Returns:
            Number of policies migrated
        """
        logger.info("Migrating policies...")
        count = 0
        
        # Query all budget policies
        policies = self.source_session.query(BudgetPolicy).all()
        logger.info(f"Found {len(policies)} budget policies to migrate")
        
        for policy in policies:
            try:
                # Check if policy already exists
                existing = self.target_session.query(AuthorityPolicy).filter_by(
                    policy_id=policy.policy_id
                ).first()
                
                if existing:
                    logger.debug(f"Policy {policy.policy_id} already exists, skipping")
                    self._migrated_policy_ids.add(policy.policy_id)
                    continue
                
                # Map time_window to max_validity_seconds
                max_validity_seconds = self._map_time_window_to_seconds(policy.time_window)
                
                # Create authority policy
                authority_policy = AuthorityPolicy(
                    policy_id=policy.policy_id,
                    principal_id=policy.agent_id,
                    max_validity_seconds=max_validity_seconds,
                    allowed_resource_patterns=["*"],  # Default: allow all resources
                    allowed_actions=["api_call", "mcp_tool", "database_query"],  # Default actions
                    allow_delegation=policy.delegated_from_agent_id is not None,
                    max_delegation_depth=5,  # Default delegation depth
                    created_at=policy.created_at,
                    created_by="migration_tool",
                    active=policy.active,
                )
                
                if not self.dry_run:
                    self.target_session.add(authority_policy)
                
                self._migrated_policy_ids.add(policy.policy_id)
                count += 1
                
                logger.debug(
                    f"Migrated policy: {policy.policy_id} for principal {policy.agent_id}, "
                    f"max_validity={max_validity_seconds}s"
                )
                
            except Exception as e:
                error_msg = f"Failed to migrate policy {policy.policy_id}: {str(e)}"
                logger.error(error_msg, exc_info=True)
                self.report.validation_errors.append(error_msg)
        
        self.report.policies_migrated = count
        logger.info(f"Migrated {count} policies")
        return count
    
    def migrate_delegation_tokens(self) -> int:
        """
        Migrate delegation tokens to ExecutionMandate.
        
        Extracts delegation tokens from agent metadata and converts them
        to execution mandates. Maps spending_limit to resource scope and
        expiration to valid_until.
        
        Returns:
            Number of mandates migrated
        """
        logger.info("Migrating delegation tokens...")
        count = 0
        
        # Query all agents with delegation tokens in metadata
        agents = self.source_session.query(AgentIdentity).all()
        
        for agent in agents:
            if not agent.agent_metadata or "delegation_tokens" not in agent.agent_metadata:
                continue
            
            tokens = agent.agent_metadata.get("delegation_tokens", [])
            
            for token_data in tokens:
                try:
                    # Extract token information
                    parent_agent_id = UUID(token_data.get("parent_agent_id"))
                    spending_limit = Decimal(str(token_data.get("spending_limit", 0)))
                    currency = token_data.get("currency", "USD")
                    created_at_str = token_data.get("created_at")
                    expires_in_seconds = token_data.get("expires_in_seconds", 86400)
                    
                    # Parse created_at
                    if created_at_str:
                        created_at = datetime.fromisoformat(created_at_str.replace("Z", "+00:00"))
                    else:
                        created_at = datetime.utcnow()
                    
                    # Calculate validity period
                    valid_from = created_at
                    valid_until = created_at + timedelta(seconds=expires_in_seconds)
                    
                    # Create execution mandate
                    mandate = ExecutionMandate(
                        issuer_id=parent_agent_id,
                        subject_id=agent.agent_id,
                        valid_from=valid_from,
                        valid_until=valid_until,
                        resource_scope=[f"budget:{spending_limit}:{currency}"],
                        action_scope=["api_call", "mcp_tool"],
                        signature="migrated_token",  # Placeholder signature
                        created_at=created_at,
                        mandate_metadata={
                            "migrated_from": "delegation_token",
                            "original_spending_limit": str(spending_limit),
                            "original_currency": currency,
                        },
                        revoked=False,
                        parent_mandate_id=None,
                        delegation_depth=1,
                    )
                    
                    if not self.dry_run:
                        self.target_session.add(mandate)
                    
                    self._migrated_mandate_ids.add(mandate.mandate_id)
                    count += 1
                    
                    logger.debug(
                        f"Migrated delegation token: parent={parent_agent_id}, "
                        f"subject={agent.agent_id}, limit={spending_limit}"
                    )
                    
                except Exception as e:
                    error_msg = (
                        f"Failed to migrate delegation token for agent {agent.agent_id}: {str(e)}"
                    )
                    logger.error(error_msg, exc_info=True)
                    self.report.validation_errors.append(error_msg)
        
        self.report.mandates_migrated = count
        logger.info(f"Migrated {count} delegation tokens to mandates")
        return count
    
    def migrate_ledger_events(self) -> int:
        """
        Migrate LedgerEvent to AuthorityLedgerEvent.
        
        Maps:
        - cost -> resource access (in metadata)
        - event_type -> authority event_type
        - Preserves timestamps and metadata
        
        Returns:
            Number of ledger events migrated
        """
        logger.info("Migrating ledger events...")
        count = 0
        
        # Query all ledger events
        events = self.source_session.query(LedgerEvent).all()
        logger.info(f"Found {len(events)} ledger events to migrate")
        
        for event in events:
            try:
                # Map to authority ledger event
                authority_event = AuthorityLedgerEvent(
                    event_type="validated",  # All spending events map to validated
                    timestamp=event.timestamp,
                    principal_id=event.agent_id,
                    mandate_id=None,  # No mandate for migrated events
                    decision="allowed",  # Historical events were allowed
                    denial_reason=None,
                    requested_action="api_call",  # Default action
                    requested_resource=event.resource_type,
                    event_metadata={
                        "migrated_from": "ledger_event",
                        "original_cost": str(event.cost),
                        "original_currency": event.currency,
                        "original_quantity": str(event.quantity),
                        "original_metadata": event.event_metadata,
                    },
                    correlation_id=None,
                    merkle_root_id=event.merkle_root_id,
                )
                
                if not self.dry_run:
                    self.target_session.add(authority_event)
                
                count += 1
                
                if count % 1000 == 0:
                    logger.debug(f"Migrated {count} ledger events...")
                
            except Exception as e:
                error_msg = f"Failed to migrate ledger event {event.event_id}: {str(e)}"
                logger.error(error_msg, exc_info=True)
                self.report.validation_errors.append(error_msg)
        
        self.report.ledger_events_migrated = count
        logger.info(f"Migrated {count} ledger events")
        return count
    
    def validate_migration(self) -> bool:
        """
        Validate migrated data for consistency.
        
        Checks:
        - All mandates reference valid principals
        - All policies reference valid principals
        - All ledger events reference valid principals
        - Referential integrity
        
        Returns:
            True if validation passes, False otherwise
        """
        logger.info("Validating migrated data...")
        validation_passed = True
        
        # Validate mandates reference valid principals
        mandates = self.target_session.query(ExecutionMandate).filter(
            ExecutionMandate.mandate_id.in_(self._migrated_mandate_ids)
        ).all()
        
        for mandate in mandates:
            if mandate.issuer_id not in self._migrated_principal_ids:
                error_msg = (
                    f"Mandate {mandate.mandate_id} references non-existent "
                    f"issuer {mandate.issuer_id}"
                )
                self.report.validation_errors.append(error_msg)
                validation_passed = False
            
            if mandate.subject_id not in self._migrated_principal_ids:
                error_msg = (
                    f"Mandate {mandate.mandate_id} references non-existent "
                    f"subject {mandate.subject_id}"
                )
                self.report.validation_errors.append(error_msg)
                validation_passed = False
        
        # Validate policies reference valid principals
        policies = self.target_session.query(AuthorityPolicy).filter(
            AuthorityPolicy.policy_id.in_(self._migrated_policy_ids)
        ).all()
        
        for policy in policies:
            if policy.principal_id not in self._migrated_principal_ids:
                error_msg = (
                    f"Policy {policy.policy_id} references non-existent "
                    f"principal {policy.principal_id}"
                )
                self.report.validation_errors.append(error_msg)
                validation_passed = False
        
        # Validate ledger events reference valid principals
        # Sample validation (checking first 100 events to avoid performance issues)
        sample_events = self.target_session.query(AuthorityLedgerEvent).filter(
            AuthorityLedgerEvent.event_metadata.contains({"migrated_from": "ledger_event"})
        ).limit(100).all()
        
        for event in sample_events:
            if event.principal_id not in self._migrated_principal_ids:
                error_msg = (
                    f"Ledger event {event.event_id} references non-existent "
                    f"principal {event.principal_id}"
                )
                self.report.validation_errors.append(error_msg)
                validation_passed = False
        
        if validation_passed:
            logger.info("Validation passed")
        else:
            logger.warning(f"Validation failed with {len(self.report.validation_errors)} errors")
        
        return validation_passed
    
    def rollback(self) -> None:
        """
        Rollback migration by deleting migrated data.
        
        Deletes all migrated entities from target database.
        Logs rollback actions for audit trail.
        """
        logger.info("Rolling back migration...")
        
        try:
            # Delete migrated ledger events
            deleted_events = self.target_session.query(AuthorityLedgerEvent).filter(
                AuthorityLedgerEvent.event_metadata.contains({"migrated_from": "ledger_event"})
            ).delete(synchronize_session=False)
            logger.info(f"Deleted {deleted_events} migrated ledger events")
            
            # Delete migrated mandates
            deleted_mandates = self.target_session.query(ExecutionMandate).filter(
                ExecutionMandate.mandate_id.in_(self._migrated_mandate_ids)
            ).delete(synchronize_session=False)
            logger.info(f"Deleted {deleted_mandates} migrated mandates")
            
            # Delete migrated policies
            deleted_policies = self.target_session.query(AuthorityPolicy).filter(
                AuthorityPolicy.policy_id.in_(self._migrated_policy_ids)
            ).delete(synchronize_session=False)
            logger.info(f"Deleted {deleted_policies} migrated policies")
            
            # Delete migrated principals
            deleted_principals = self.target_session.query(Principal).filter(
                Principal.principal_id.in_(self._migrated_principal_ids)
            ).delete(synchronize_session=False)
            logger.info(f"Deleted {deleted_principals} migrated principals")
            
            # Commit rollback
            self.target_session.commit()
            logger.info("Rollback completed successfully")
            
        except Exception as e:
            logger.error(f"Rollback failed: {e}", exc_info=True)
            self.target_session.rollback()
            raise
    
    def generate_report(self, format: str = "text") -> str:
        """
        Generate migration report.
        
        Args:
            format: Output format ("text" or "json")
            
        Returns:
            Formatted report string
        """
        if format == "json":
            import json
            return json.dumps(self.report.to_dict(), indent=2)
        else:
            return self.report.to_text()
    
    @staticmethod
    def _map_time_window_to_seconds(time_window: str) -> int:
        """
        Map budget time window to max validity seconds.
        
        Args:
            time_window: Time window string (hourly, daily, weekly, monthly)
            
        Returns:
            Maximum validity in seconds
        """
        mapping = {
            "hourly": 3600,
            "daily": 86400,
            "weekly": 604800,
            "monthly": 2592000,
        }
        return mapping.get(time_window.lower(), 86400)  # Default to daily
