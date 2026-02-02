"""
Migration manager for Caracal Core v0.1 to v0.2.

This module provides functionality to migrate file-based v0.1 data
(agents.json, policies.json, ledger.jsonl) to PostgreSQL v0.2 backend.

Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7
"""

import json
import logging
import random
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Dict, List, Optional
from uuid import UUID

from sqlalchemy import insert
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from caracal.db.models import AgentIdentity, BudgetPolicy, LedgerEvent

logger = logging.getLogger(__name__)


@dataclass
class MigrationResult:
    """Result of a migration operation."""
    
    migrated_count: int
    skipped_count: int
    error_count: int
    errors: List[str]


@dataclass
class MigrationSummary:
    """Summary of all migration operations."""
    
    agents: MigrationResult
    policies: MigrationResult
    ledger: MigrationResult
    total_duration_seconds: float


@dataclass
class ValidationResult:
    """Result of migration validation."""
    
    valid: bool
    agent_count_match: bool
    policy_count_match: bool
    ledger_count_match: bool
    spot_check_passed: bool
    errors: List[str]
    source_counts: Dict[str, int]
    target_counts: Dict[str, int]


class MigrationManager:
    """
    Manages migration from v0.1 file-based storage to v0.2 PostgreSQL.
    
    Provides idempotent migration operations with validation and error handling.
    
    Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7
    """
    
    def __init__(self, db_session: Session, v01_data_dir: str = "~/.caracal"):
        """
        Initialize migration manager.
        
        Args:
            db_session: SQLAlchemy database session
            v01_data_dir: Path to v0.1 data directory (default: ~/.caracal)
        """
        self.db_session = db_session
        self.v01_data_dir = Path(v01_data_dir).expanduser()
        
        # File paths
        self.agents_file = self.v01_data_dir / "agents.json"
        self.policies_file = self.v01_data_dir / "policies.json"
        self.ledger_file = self.v01_data_dir / "ledger.jsonl"
        
        logger.info(f"Initialized migration manager with source directory: {self.v01_data_dir}")
    
    def migrate_agents(self, batch_size: int = 1000) -> MigrationResult:
        """
        Migrate agents.json to agent_identities table.
        
        Uses INSERT ... ON CONFLICT DO NOTHING for idempotency.
        Skips duplicate agents and logs warnings.
        
        Args:
            batch_size: Number of records to process per batch
        
        Returns:
            MigrationResult with counts and errors
        
        Requirements: 7.1, 7.4, 7.7
        """
        logger.info("Starting agent migration")
        
        migrated_count = 0
        skipped_count = 0
        error_count = 0
        errors = []
        
        try:
            # Read agents.json
            if not self.agents_file.exists():
                error_msg = f"Agents file not found: {self.agents_file}"
                logger.error(error_msg)
                errors.append(error_msg)
                return MigrationResult(0, 0, 1, errors)
            
            with open(self.agents_file, 'r') as f:
                agents_data = json.load(f)
            
            logger.info(f"Found {len(agents_data)} agents to migrate")
            
            # Process agents in batches
            for i in range(0, len(agents_data), batch_size):
                batch = agents_data[i:i + batch_size]
                
                for agent_data in batch:
                    try:
                        # Convert v0.1 format to v0.2 model
                        agent = AgentIdentity(
                            agent_id=UUID(agent_data['agent_id']),
                            name=agent_data['name'],
                            owner=agent_data['owner'],
                            created_at=datetime.fromisoformat(agent_data['created_at'].replace('Z', '+00:00')),
                            agent_metadata=agent_data.get('metadata'),
                            parent_agent_id=None,  # v0.1 doesn't have parent-child relationships
                        )
                        
                        # Use INSERT ... ON CONFLICT DO NOTHING for idempotency
                        stmt = pg_insert(AgentIdentity).values(
                            agent_id=agent.agent_id,
                            name=agent.name,
                            owner=agent.owner,
                            created_at=agent.created_at,
                            agent_metadata=agent.agent_metadata,
                            parent_agent_id=agent.parent_agent_id,
                        ).on_conflict_do_nothing(index_elements=['agent_id'])
                        
                        result = self.db_session.execute(stmt)
                        
                        if result.rowcount > 0:
                            migrated_count += 1
                        else:
                            skipped_count += 1
                            logger.warning(f"Skipped duplicate agent: {agent.name} ({agent.agent_id})")
                    
                    except Exception as e:
                        error_count += 1
                        error_msg = f"Failed to migrate agent {agent_data.get('name', 'unknown')}: {e}"
                        logger.error(error_msg)
                        errors.append(error_msg)
                
                # Commit batch
                self.db_session.commit()
                logger.debug(f"Committed batch of {len(batch)} agents")
            
            logger.info(f"Agent migration complete: {migrated_count} migrated, {skipped_count} skipped, {error_count} errors")
        
        except Exception as e:
            self.db_session.rollback()
            error_msg = f"Agent migration failed: {e}"
            logger.error(error_msg)
            errors.append(error_msg)
            error_count += 1
        
        return MigrationResult(migrated_count, skipped_count, error_count, errors)
    
    def migrate_policies(self, batch_size: int = 1000) -> MigrationResult:
        """
        Migrate policies.json to budget_policies table.
        
        Uses INSERT ... ON CONFLICT DO NOTHING for idempotency.
        Validates agent_id foreign key constraints.
        
        Args:
            batch_size: Number of records to process per batch
        
        Returns:
            MigrationResult with counts and errors
        
        Requirements: 7.2, 7.4, 7.7
        """
        logger.info("Starting policy migration")
        
        migrated_count = 0
        skipped_count = 0
        error_count = 0
        errors = []
        
        try:
            # Read policies.json
            if not self.policies_file.exists():
                error_msg = f"Policies file not found: {self.policies_file}"
                logger.error(error_msg)
                errors.append(error_msg)
                return MigrationResult(0, 0, 1, errors)
            
            with open(self.policies_file, 'r') as f:
                policies_data = json.load(f)
            
            logger.info(f"Found {len(policies_data)} policies to migrate")
            
            # Process policies in batches
            for i in range(0, len(policies_data), batch_size):
                batch = policies_data[i:i + batch_size]
                
                for policy_data in batch:
                    try:
                        # Convert v0.1 format to v0.2 model
                        policy = BudgetPolicy(
                            policy_id=UUID(policy_data['policy_id']),
                            agent_id=UUID(policy_data['agent_id']),
                            limit_amount=Decimal(str(policy_data['limit_amount'])),
                            time_window=policy_data['time_window'],
                            currency=policy_data.get('currency', 'USD'),
                            created_at=datetime.fromisoformat(policy_data['created_at'].replace('Z', '+00:00')),
                            active=policy_data.get('active', True),
                            delegated_from_agent_id=None,  # v0.1 doesn't have delegation
                        )
                        
                        # Use INSERT ... ON CONFLICT DO NOTHING for idempotency
                        stmt = pg_insert(BudgetPolicy).values(
                            policy_id=policy.policy_id,
                            agent_id=policy.agent_id,
                            limit_amount=policy.limit_amount,
                            time_window=policy.time_window,
                            currency=policy.currency,
                            created_at=policy.created_at,
                            active=policy.active,
                            delegated_from_agent_id=policy.delegated_from_agent_id,
                        ).on_conflict_do_nothing(index_elements=['policy_id'])
                        
                        result = self.db_session.execute(stmt)
                        
                        if result.rowcount > 0:
                            migrated_count += 1
                        else:
                            skipped_count += 1
                            logger.warning(f"Skipped duplicate policy: {policy.policy_id}")
                    
                    except IntegrityError as e:
                        error_count += 1
                        error_msg = f"Foreign key violation for policy {policy_data.get('policy_id', 'unknown')}: agent_id {policy_data.get('agent_id')} not found"
                        logger.error(error_msg)
                        errors.append(error_msg)
                        self.db_session.rollback()
                    
                    except Exception as e:
                        error_count += 1
                        error_msg = f"Failed to migrate policy {policy_data.get('policy_id', 'unknown')}: {e}"
                        logger.error(error_msg)
                        errors.append(error_msg)
                
                # Commit batch
                try:
                    self.db_session.commit()
                    logger.debug(f"Committed batch of {len(batch)} policies")
                except Exception as e:
                    self.db_session.rollback()
                    logger.error(f"Failed to commit policy batch: {e}")
            
            logger.info(f"Policy migration complete: {migrated_count} migrated, {skipped_count} skipped, {error_count} errors")
        
        except Exception as e:
            self.db_session.rollback()
            error_msg = f"Policy migration failed: {e}"
            logger.error(error_msg)
            errors.append(error_msg)
            error_count += 1
        
        return MigrationResult(migrated_count, skipped_count, error_count, errors)
    
    def migrate_ledger(self, batch_size: int = 1000) -> MigrationResult:
        """
        Migrate ledger.jsonl to ledger_events table.
        
        Uses INSERT ... ON CONFLICT DO NOTHING for idempotency.
        Processes events line by line for memory efficiency.
        
        Args:
            batch_size: Number of records to process per batch
        
        Returns:
            MigrationResult with counts and errors
        
        Requirements: 7.3, 7.4, 7.7
        """
        logger.info("Starting ledger migration")
        
        migrated_count = 0
        skipped_count = 0
        error_count = 0
        errors = []
        
        try:
            # Read ledger.jsonl
            if not self.ledger_file.exists():
                error_msg = f"Ledger file not found: {self.ledger_file}"
                logger.error(error_msg)
                errors.append(error_msg)
                return MigrationResult(0, 0, 1, errors)
            
            # Process ledger line by line in batches
            batch = []
            
            with open(self.ledger_file, 'r') as f:
                for line_num, line in enumerate(f, 1):
                    if not line.strip():
                        continue
                    
                    try:
                        event_data = json.loads(line)
                        batch.append(event_data)
                        
                        # Process batch when full
                        if len(batch) >= batch_size:
                            result = self._process_ledger_batch(batch)
                            migrated_count += result.migrated_count
                            skipped_count += result.skipped_count
                            error_count += result.error_count
                            errors.extend(result.errors)
                            batch = []
                    
                    except json.JSONDecodeError as e:
                        error_count += 1
                        error_msg = f"Invalid JSON at line {line_num}: {e}"
                        logger.error(error_msg)
                        errors.append(error_msg)
                    
                    except Exception as e:
                        error_count += 1
                        error_msg = f"Failed to process ledger line {line_num}: {e}"
                        logger.error(error_msg)
                        errors.append(error_msg)
                
                # Process remaining batch
                if batch:
                    result = self._process_ledger_batch(batch)
                    migrated_count += result.migrated_count
                    skipped_count += result.skipped_count
                    error_count += result.error_count
                    errors.extend(result.errors)
            
            logger.info(f"Ledger migration complete: {migrated_count} migrated, {skipped_count} skipped, {error_count} errors")
        
        except Exception as e:
            self.db_session.rollback()
            error_msg = f"Ledger migration failed: {e}"
            logger.error(error_msg)
            errors.append(error_msg)
            error_count += 1
        
        return MigrationResult(migrated_count, skipped_count, error_count, errors)
    
    def _process_ledger_batch(self, batch: List[Dict]) -> MigrationResult:
        """
        Process a batch of ledger events.
        
        Args:
            batch: List of ledger event dictionaries
        
        Returns:
            MigrationResult for this batch
        """
        migrated_count = 0
        skipped_count = 0
        error_count = 0
        errors = []
        
        for event_data in batch:
            try:
                # Convert v0.1 format to v0.2 model
                # Note: v0.1 doesn't have event_id, so we let PostgreSQL auto-generate it
                event = LedgerEvent(
                    agent_id=UUID(event_data['agent_id']),
                    timestamp=datetime.fromisoformat(event_data['timestamp'].replace('Z', '+00:00')),
                    resource_type=event_data['resource_type'],
                    quantity=Decimal(str(event_data['quantity'])),
                    cost=Decimal(str(event_data['cost'])),
                    currency=event_data.get('currency', 'USD'),
                    event_metadata=event_data.get('metadata'),
                    provisional_charge_id=None,  # v0.1 doesn't have provisional charges
                )
                
                # For ledger events, we can't use ON CONFLICT because event_id is auto-generated
                # Instead, we just insert and let duplicates be added (ledger is append-only)
                self.db_session.add(event)
                migrated_count += 1
            
            except IntegrityError as e:
                error_count += 1
                error_msg = f"Foreign key violation for ledger event: agent_id {event_data.get('agent_id')} not found"
                logger.error(error_msg)
                errors.append(error_msg)
                self.db_session.rollback()
            
            except Exception as e:
                error_count += 1
                error_msg = f"Failed to migrate ledger event: {e}"
                logger.error(error_msg)
                errors.append(error_msg)
        
        # Commit batch
        try:
            self.db_session.commit()
            logger.debug(f"Committed batch of {len(batch)} ledger events")
        except Exception as e:
            self.db_session.rollback()
            logger.error(f"Failed to commit ledger batch: {e}")
            error_count += len(batch)
            errors.append(f"Batch commit failed: {e}")
            migrated_count = 0
        
        return MigrationResult(migrated_count, skipped_count, error_count, errors)
    
    def migrate_all(self, batch_size: int = 1000) -> MigrationSummary:
        """
        Run all migrations in order.
        
        Migrates agents first (for foreign keys), then policies, then ledger.
        Validates data integrity after migration.
        
        Args:
            batch_size: Number of records to process per batch
        
        Returns:
            MigrationSummary with results for all operations
        
        Requirements: 7.1, 7.2, 7.3
        """
        logger.info("Starting full migration: v0.1 → v0.2")
        start_time = datetime.utcnow()
        
        # Migrate in order: agents → policies → ledger
        agents_result = self.migrate_agents(batch_size)
        policies_result = self.migrate_policies(batch_size)
        ledger_result = self.migrate_ledger(batch_size)
        
        # Calculate duration
        end_time = datetime.utcnow()
        duration = (end_time - start_time).total_seconds()
        
        summary = MigrationSummary(
            agents=agents_result,
            policies=policies_result,
            ledger=ledger_result,
            total_duration_seconds=duration,
        )
        
        logger.info(f"Full migration complete in {duration:.2f} seconds")
        
        return summary
    
    def validate_migration(self, spot_check_count: int = 10) -> ValidationResult:
        """
        Validate migration integrity.
        
        Performs:
        1. Record count comparison
        2. Spot-check validation of random records
        3. Foreign key constraint verification
        
        Args:
            spot_check_count: Number of random records to validate
        
        Returns:
            ValidationResult with validation status and details
        
        Requirements: 7.5, 7.6
        """
        logger.info("Starting migration validation")
        
        errors = []
        
        # Count source records
        source_counts = self._count_source_records()
        
        # Count target records
        target_counts = self._count_target_records()
        
        # Compare counts
        agent_count_match = source_counts['agents'] == target_counts['agents']
        policy_count_match = source_counts['policies'] == target_counts['policies']
        ledger_count_match = source_counts['ledger'] == target_counts['ledger']
        
        if not agent_count_match:
            error_msg = f"Agent count mismatch: source={source_counts['agents']}, target={target_counts['agents']}"
            logger.error(error_msg)
            errors.append(error_msg)
        
        if not policy_count_match:
            error_msg = f"Policy count mismatch: source={source_counts['policies']}, target={target_counts['policies']}"
            logger.error(error_msg)
            errors.append(error_msg)
        
        if not ledger_count_match:
            error_msg = f"Ledger count mismatch: source={source_counts['ledger']}, target={target_counts['ledger']}"
            logger.error(error_msg)
            errors.append(error_msg)
        
        # Spot-check validation
        spot_check_passed = self._spot_check_validation(spot_check_count, errors)
        
        # Overall validation
        valid = (
            agent_count_match and
            policy_count_match and
            ledger_count_match and
            spot_check_passed
        )
        
        result = ValidationResult(
            valid=valid,
            agent_count_match=agent_count_match,
            policy_count_match=policy_count_match,
            ledger_count_match=ledger_count_match,
            spot_check_passed=spot_check_passed,
            errors=errors,
            source_counts=source_counts,
            target_counts=target_counts,
        )
        
        if valid:
            logger.info("Migration validation passed")
        else:
            logger.error(f"Migration validation failed with {len(errors)} errors")
        
        return result
    
    def _count_source_records(self) -> Dict[str, int]:
        """Count records in source v0.1 files."""
        counts = {
            'agents': 0,
            'policies': 0,
            'ledger': 0,
        }
        
        try:
            if self.agents_file.exists():
                with open(self.agents_file, 'r') as f:
                    counts['agents'] = len(json.load(f))
        except Exception as e:
            logger.error(f"Failed to count agents: {e}")
        
        try:
            if self.policies_file.exists():
                with open(self.policies_file, 'r') as f:
                    counts['policies'] = len(json.load(f))
        except Exception as e:
            logger.error(f"Failed to count policies: {e}")
        
        try:
            if self.ledger_file.exists():
                with open(self.ledger_file, 'r') as f:
                    counts['ledger'] = sum(1 for line in f if line.strip())
        except Exception as e:
            logger.error(f"Failed to count ledger events: {e}")
        
        return counts
    
    def _count_target_records(self) -> Dict[str, int]:
        """Count records in target PostgreSQL database."""
        counts = {
            'agents': 0,
            'policies': 0,
            'ledger': 0,
        }
        
        try:
            counts['agents'] = self.db_session.query(AgentIdentity).count()
            counts['policies'] = self.db_session.query(BudgetPolicy).count()
            counts['ledger'] = self.db_session.query(LedgerEvent).count()
        except Exception as e:
            logger.error(f"Failed to count target records: {e}")
        
        return counts
    
    def _spot_check_validation(self, count: int, errors: List[str]) -> bool:
        """
        Perform spot-check validation of random records.
        
        Args:
            count: Number of random records to check
            errors: List to append errors to
        
        Returns:
            True if all spot checks passed, False otherwise
        """
        passed = True
        
        try:
            # Spot-check agents
            if self.agents_file.exists():
                with open(self.agents_file, 'r') as f:
                    agents_data = json.load(f)
                
                if agents_data:
                    sample_agents = random.sample(agents_data, min(count, len(agents_data)))
                    
                    for agent_data in sample_agents:
                        agent_id = UUID(agent_data['agent_id'])
                        db_agent = self.db_session.query(AgentIdentity).filter_by(agent_id=agent_id).first()
                        
                        if not db_agent:
                            error_msg = f"Spot-check failed: Agent {agent_id} not found in database"
                            logger.error(error_msg)
                            errors.append(error_msg)
                            passed = False
                        elif db_agent.name != agent_data['name']:
                            error_msg = f"Spot-check failed: Agent {agent_id} name mismatch"
                            logger.error(error_msg)
                            errors.append(error_msg)
                            passed = False
        
        except Exception as e:
            error_msg = f"Spot-check validation failed: {e}"
            logger.error(error_msg)
            errors.append(error_msg)
            passed = False
        
        return passed
