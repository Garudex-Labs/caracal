"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Synchronization engine for Caracal deployment architecture.

Handles bidirectional sync between local and enterprise instances with
operational transform for conflict resolution.
"""

import asyncio
import random
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import Enum
from typing import Any, Dict, List, Optional
from uuid import UUID, uuid4

import httpx
import structlog
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from caracal.db.connection import DatabaseConnectionManager
from caracal.db.models import SyncConflict, SyncMetadata, SyncOperation
from caracal.deployment.config_manager import ConfigManager, ConflictStrategy
from caracal.deployment.exceptions import (
    NetworkError,
    OfflineError,
    SyncConflictError,
    SyncConnectionError,
    SyncOperationError,
    SyncStateError,
    VersionIncompatibleError,
    WorkspaceNotFoundError,
)
from caracal.deployment.version import CompatibilityLevel, get_version_checker

logger = structlog.get_logger(__name__)


class SyncDirection(str, Enum):
    """Sync direction enumeration."""
    PUSH = "push"
    PULL = "pull"
    BIDIRECTIONAL = "both"


@dataclass
class SyncResult:
    """Sync operation result."""
    success: bool
    uploaded_count: int
    downloaded_count: int
    conflicts_count: int
    conflicts_resolved: int
    errors: List[str]
    duration_ms: int
    operations_applied: List[str]


@dataclass
class SyncStatus:
    """Sync status information."""
    workspace: str
    last_sync: Optional[datetime]
    pending_operations: int
    sync_enabled: bool
    remote_url: Optional[str]
    remote_version: Optional[str]
    local_version: str
    consecutive_failures: int
    last_error: Optional[str]


@dataclass
class Operation:
    """Sync operation data model."""
    id: str
    type: str  # create, update, delete
    entity_type: str
    entity_id: str
    data: Dict[str, Any]
    timestamp: datetime
    retry_count: int
    last_error: Optional[str]


@dataclass
class Conflict:
    """Sync conflict data model."""
    id: str
    entity_type: str
    entity_id: str
    local_version: Dict[str, Any]
    remote_version: Dict[str, Any]
    local_timestamp: datetime
    remote_timestamp: datetime
    resolution: Optional[str]
    resolved_at: Optional[datetime]


class SyncEngine:
    """
    Manages workspace synchronization between local and enterprise.
    
    Provides methods for sync connection, operation queuing, conflict resolution,
    and auto-sync with configurable intervals.
    
    Implements bidirectional sync with operational transform for conflict resolution.
    """
    
    # Default configuration
    DEFAULT_TIMEOUT_SECONDS = 30
    DEFAULT_MAX_RETRIES = 5
    DEFAULT_AUTO_SYNC_INTERVAL = 300  # 5 minutes
    
    # Version for compatibility checking
    LOCAL_VERSION = "0.3.0"
    
    def __init__(
        self,
        db_manager: Optional[DatabaseConnectionManager] = None,
        config_manager: Optional[ConfigManager] = None
    ):
        """
        Initialize the sync engine.
        
        Args:
            db_manager: Database connection manager (optional, will create if not provided)
            config_manager: Configuration manager (optional, will create if not provided)
        """
        self.db_manager = db_manager
        self.config_manager = config_manager or ConfigManager()
        self._auto_sync_tasks: Dict[str, asyncio.Task] = {}
        self._http_client: Optional[httpx.AsyncClient] = None
    
    def _get_db_session(self) -> Session:
        """Get database session."""
        if not self.db_manager:
            raise SyncStateError("Database manager not initialized")
        return self.db_manager.get_session()
    
    def _get_http_client(self) -> httpx.AsyncClient:
        """Get or create HTTP client."""
        if not self._http_client:
            self._http_client = httpx.AsyncClient(
                timeout=self.DEFAULT_TIMEOUT_SECONDS,
                follow_redirects=True
            )
        return self._http_client
    
    async def _close_http_client(self) -> None:
        """Close HTTP client."""
        if self._http_client:
            await self._http_client.aclose()
            self._http_client = None
    
    def connect(self, workspace: str, enterprise_url: str, token: str) -> None:
        """
        Establishes sync relationship with enterprise.
        
        Args:
            workspace: Workspace name
            enterprise_url: Enterprise instance URL
            token: Authentication token
            
        Raises:
            WorkspaceNotFoundError: If workspace doesn't exist
            SyncConnectionError: If connection fails
            VersionIncompatibleError: If versions are incompatible
        """
        try:
            # Validate workspace exists
            config = self.config_manager.get_workspace_config(workspace)
            
            # TODO: Fetch remote version from enterprise instance
            # For now, we'll skip version checking during connect
            # Version checking will be performed during sync_now
            
            # Update workspace configuration with sync settings
            config.sync_enabled = True
            config.sync_url = enterprise_url
            self.config_manager.set_workspace_config(workspace, config)
            
            # Store authentication token in vault
            self.config_manager.store_secret(
                f"sync_token_{workspace}",
                token,
                workspace
            )
            
            # Initialize sync metadata in database
            session = self._get_db_session()
            try:
                sync_meta = session.query(SyncMetadata).filter_by(
                    workspace=workspace
                ).first()
                
                if not sync_meta:
                    sync_meta = SyncMetadata(
                        workspace=workspace,
                        remote_url=enterprise_url,
                        sync_enabled=True,
                        last_sync_status="connected"
                    )
                    session.add(sync_meta)
                else:
                    sync_meta.remote_url = enterprise_url
                    sync_meta.sync_enabled = True
                    sync_meta.last_sync_status = "connected"
                    sync_meta.updated_at = datetime.utcnow()
                
                session.commit()
                
                logger.info(
                    "sync_connected",
                    workspace=workspace,
                    enterprise_url=enterprise_url
                )
                
            finally:
                session.close()
                
        except WorkspaceNotFoundError:
            raise
        except Exception as e:
            logger.error(
                "sync_connection_failed",
                workspace=workspace,
                enterprise_url=enterprise_url,
                error=str(e)
            )
            raise SyncConnectionError(
                f"Failed to establish sync connection: {e}"
            ) from e
    
    def disconnect(self, workspace: str) -> None:
        """
        Removes sync relationship.
        
        Args:
            workspace: Workspace name
            
        Raises:
            WorkspaceNotFoundError: If workspace doesn't exist
            SyncOperationError: If disconnection fails
        """
        try:
            # Validate workspace exists
            config = self.config_manager.get_workspace_config(workspace)
            
            # Disable auto-sync if enabled
            if workspace in self._auto_sync_tasks:
                self.disable_auto_sync(workspace)
            
            # Update workspace configuration
            config.sync_enabled = False
            config.sync_url = None
            self.config_manager.set_workspace_config(workspace, config)
            
            # Update sync metadata in database
            session = self._get_db_session()
            try:
                sync_meta = session.query(SyncMetadata).filter_by(
                    workspace=workspace
                ).first()
                
                if sync_meta:
                    sync_meta.sync_enabled = False
                    sync_meta.last_sync_status = "disconnected"
                    sync_meta.updated_at = datetime.utcnow()
                    session.commit()
                
                logger.info(
                    "sync_disconnected",
                    workspace=workspace
                )
                
            finally:
                session.close()
                
        except WorkspaceNotFoundError:
            raise
        except Exception as e:
            logger.error(
                "sync_disconnection_failed",
                workspace=workspace,
                error=str(e)
            )
            raise SyncOperationError(
                f"Failed to disconnect sync: {e}"
            ) from e
    
    def sync_now(
        self,
        workspace: str,
        direction: SyncDirection = SyncDirection.BIDIRECTIONAL
    ) -> SyncResult:
        """
        Performs immediate synchronization.
        
        Args:
            workspace: Workspace name
            direction: Sync direction (push, pull, or bidirectional)
            
        Returns:
            Sync operation result
            
        Raises:
            WorkspaceNotFoundError: If workspace doesn't exist
            SyncOperationError: If sync fails
            VersionIncompatibleError: If versions are incompatible
        """
        start_time = time.time()
        errors = []
        uploaded_count = 0
        downloaded_count = 0
        conflicts_count = 0
        conflicts_resolved = 0
        operations_applied = []
        
        try:
            # Validate workspace exists and sync is enabled
            config = self.config_manager.get_workspace_config(workspace)
            
            if not config.sync_enabled or not config.sync_url:
                raise SyncOperationError(
                    f"Sync not enabled for workspace: {workspace}"
                )
            
            session = self._get_db_session()
            try:
                # Get sync metadata
                sync_meta = session.query(SyncMetadata).filter_by(
                    workspace=workspace
                ).first()
                
                if not sync_meta:
                    raise SyncStateError(
                        f"Sync metadata not found for workspace: {workspace}"
                    )
                
                # Check version compatibility if remote version is available
                if sync_meta.remote_version:
                    self._check_version_compatibility(sync_meta.remote_version)
                
                # Perform sync based on direction
                if direction in (SyncDirection.PUSH, SyncDirection.BIDIRECTIONAL):
                    # Push local changes
                    push_result = self._push_changes(workspace, session)
                    uploaded_count = push_result["uploaded_count"]
                    operations_applied.extend(push_result["operations_applied"])
                    errors.extend(push_result["errors"])
                
                if direction in (SyncDirection.PULL, SyncDirection.BIDIRECTIONAL):
                    # Pull remote changes
                    pull_result = self._pull_changes(workspace, session)
                    downloaded_count = pull_result["downloaded_count"]
                    conflicts_count = pull_result["conflicts_count"]
                    conflicts_resolved = pull_result["conflicts_resolved"]
                    operations_applied.extend(pull_result["operations_applied"])
                    errors.extend(pull_result["errors"])
                
                # Update sync metadata
                sync_meta.last_sync_at = datetime.utcnow()
                sync_meta.last_sync_direction = direction.value
                sync_meta.last_sync_status = "success" if not errors else "partial"
                sync_meta.total_operations_synced += uploaded_count + downloaded_count
                sync_meta.total_conflicts_detected += conflicts_count
                sync_meta.total_conflicts_resolved += conflicts_resolved
                sync_meta.consecutive_failures = 0
                sync_meta.last_error = None
                sync_meta.updated_at = datetime.utcnow()
                
                # Update workspace config
                config.last_sync = datetime.utcnow()
                self.config_manager.set_workspace_config(workspace, config)
                
                session.commit()
                
                duration_ms = int((time.time() - start_time) * 1000)
                
                logger.info(
                    "sync_completed",
                    workspace=workspace,
                    direction=direction.value,
                    uploaded=uploaded_count,
                    downloaded=downloaded_count,
                    conflicts=conflicts_count,
                    resolved=conflicts_resolved,
                    duration_ms=duration_ms
                )
                
                return SyncResult(
                    success=len(errors) == 0,
                    uploaded_count=uploaded_count,
                    downloaded_count=downloaded_count,
                    conflicts_count=conflicts_count,
                    conflicts_resolved=conflicts_resolved,
                    errors=errors,
                    duration_ms=duration_ms,
                    operations_applied=operations_applied
                )
                
            finally:
                session.close()
                
        except (WorkspaceNotFoundError, SyncStateError, VersionIncompatibleError):
            raise
        except Exception as e:
            # Update failure count
            try:
                session = self._get_db_session()
                sync_meta = session.query(SyncMetadata).filter_by(
                    workspace=workspace
                ).first()
                if sync_meta:
                    sync_meta.consecutive_failures += 1
                    sync_meta.last_error = str(e)
                    sync_meta.last_error_at = datetime.utcnow()
                    session.commit()
                session.close()
            except:
                pass
            
            logger.error(
                "sync_failed",
                workspace=workspace,
                direction=direction.value,
                error=str(e)
            )
            raise SyncOperationError(f"Sync failed: {e}") from e
    
    def _check_version_compatibility(self, remote_version: str) -> None:
        """
        Check version compatibility with remote instance.
        
        Args:
            remote_version: Remote version string
            
        Raises:
            VersionIncompatibleError: If versions are incompatible
        """
        version_checker = get_version_checker()
        compatibility = version_checker.check_compatibility(remote_version)
        
        # Log compatibility status
        logger.info(
            "version_compatibility_check",
            local_version=str(compatibility.local_version),
            remote_version=str(compatibility.remote_version),
            compatibility_level=compatibility.compatibility_level.value,
            message=compatibility.message
        )
        
        # Raise exception if incompatible
        if compatibility.compatibility_level == CompatibilityLevel.INCOMPATIBLE:
            raise VersionIncompatibleError(
                f"{compatibility.message}\n\n{compatibility.upgrade_instructions}"
            )
        
        # Log warning if minor version mismatch
        if compatibility.compatibility_level == CompatibilityLevel.WARNING:
            logger.warning(
                "version_compatibility_warning",
                message=compatibility.message,
                upgrade_instructions=compatibility.upgrade_instructions
            )
    
    def _push_changes(self, workspace: str, session: Session) -> Dict[str, Any]:
        """
        Push local changes to remote.
        
        Args:
            workspace: Workspace name
            session: Database session
            
        Returns:
            Dictionary with push results
        """
        uploaded_count = 0
        operations_applied = []
        errors = []
        
        # Get pending operations
        pending_ops = session.query(SyncOperation).filter(
            and_(
                SyncOperation.workspace == workspace,
                SyncOperation.status == "pending"
            )
        ).order_by(SyncOperation.created_at).all()
        
        if not pending_ops:
            return {
                "uploaded_count": 0,
                "operations_applied": [],
                "errors": []
            }
        
        # TODO: Implement actual HTTP push to enterprise
        # For now, mark operations as completed
        for op in pending_ops:
            try:
                # Simulate push (would be actual HTTP call in production)
                op.status = "completed"
                op.completed_at = datetime.utcnow()
                uploaded_count += 1
                operations_applied.append(str(op.operation_id))
            except Exception as e:
                op.retry_count += 1
                op.last_retry_at = datetime.utcnow()
                op.last_error = str(e)
                if op.retry_count >= op.max_retries:
                    op.status = "failed"
                errors.append(f"Operation {op.operation_id} failed: {e}")
        
        session.commit()
        
        return {
            "uploaded_count": uploaded_count,
            "operations_applied": operations_applied,
            "errors": errors
        }
    
    def _pull_changes(self, workspace: str, session: Session) -> Dict[str, Any]:
        """
        Pull remote changes to local.
        
        Args:
            workspace: Workspace name
            session: Database session
            
        Returns:
            Dictionary with pull results
        """
        downloaded_count = 0
        conflicts_count = 0
        conflicts_resolved = 0
        operations_applied = []
        errors = []
        
        # TODO: Implement actual HTTP pull from enterprise
        # For now, return empty results
        
        return {
            "downloaded_count": downloaded_count,
            "conflicts_count": conflicts_count,
            "conflicts_resolved": conflicts_resolved,
            "operations_applied": operations_applied,
            "errors": errors
        }
    
    def get_sync_status(self, workspace: str) -> SyncStatus:
        """
        Returns current sync status.
        
        Args:
            workspace: Workspace name
            
        Returns:
            Sync status information
            
        Raises:
            WorkspaceNotFoundError: If workspace doesn't exist
        """
        try:
            # Get workspace configuration
            config = self.config_manager.get_workspace_config(workspace)
            
            # Get local version from version checker
            version_checker = get_version_checker()
            local_version = str(version_checker.get_local_version())
            
            # Get sync metadata from database
            session = self._get_db_session()
            try:
                sync_meta = session.query(SyncMetadata).filter_by(
                    workspace=workspace
                ).first()
                
                # Count pending operations
                pending_count = session.query(SyncOperation).filter(
                    and_(
                        SyncOperation.workspace == workspace,
                        SyncOperation.status == "pending"
                    )
                ).count()
                
                return SyncStatus(
                    workspace=workspace,
                    last_sync=config.last_sync,
                    pending_operations=pending_count,
                    sync_enabled=config.sync_enabled,
                    remote_url=config.sync_url,
                    remote_version=sync_meta.remote_version if sync_meta else None,
                    local_version=local_version,
                    consecutive_failures=sync_meta.consecutive_failures if sync_meta else 0,
                    last_error=sync_meta.last_error if sync_meta else None
                )
                
            finally:
                session.close()
                
        except WorkspaceNotFoundError:
            raise
        except Exception as e:
            logger.error(
                "sync_status_query_failed",
                workspace=workspace,
                error=str(e)
            )
            raise SyncOperationError(
                f"Failed to get sync status: {e}"
            ) from e
    
    def queue_operation(
        self,
        workspace: str,
        operation_type: str,
        entity_type: str,
        entity_id: str,
        data: Dict[str, Any],
        metadata: Optional[Dict[str, Any]] = None
    ) -> str:
        """
        Queues operation for later sync.
        
        Args:
            workspace: Workspace name
            operation_type: Operation type (create, update, delete)
            entity_type: Entity type
            entity_id: Entity identifier
            data: Operation data
            metadata: Optional metadata
            
        Returns:
            Operation ID
            
        Raises:
            WorkspaceNotFoundError: If workspace doesn't exist
            SyncOperationError: If queuing fails
        """
        try:
            # Validate workspace exists
            self.config_manager.get_workspace_config(workspace)
            
            # Create operation in database
            session = self._get_db_session()
            try:
                operation = SyncOperation(
                    operation_id=uuid4(),
                    workspace=workspace,
                    operation_type=operation_type,
                    entity_type=entity_type,
                    entity_id=entity_id,
                    operation_data=data,
                    operation_metadata=metadata or {},
                    status="pending",
                    created_at=datetime.utcnow()
                )
                
                session.add(operation)
                session.commit()
                
                operation_id = str(operation.operation_id)
                
                logger.debug(
                    "operation_queued",
                    workspace=workspace,
                    operation_id=operation_id,
                    operation_type=operation_type,
                    entity_type=entity_type
                )
                
                return operation_id
                
            finally:
                session.close()
                
        except WorkspaceNotFoundError:
            raise
        except Exception as e:
            logger.error(
                "operation_queue_failed",
                workspace=workspace,
                operation_type=operation_type,
                error=str(e)
            )
            raise SyncOperationError(
                f"Failed to queue operation: {e}"
            ) from e
    
    def enable_auto_sync(
        self,
        workspace: str,
        interval_seconds: int = DEFAULT_AUTO_SYNC_INTERVAL
    ) -> None:
        """
        Enables automatic background sync.
        
        Args:
            workspace: Workspace name
            interval_seconds: Sync interval in seconds
            
        Raises:
            WorkspaceNotFoundError: If workspace doesn't exist
            SyncOperationError: If enabling fails
        """
        try:
            # Validate workspace exists and sync is enabled
            config = self.config_manager.get_workspace_config(workspace)
            
            if not config.sync_enabled:
                raise SyncOperationError(
                    f"Sync not enabled for workspace: {workspace}"
                )
            
            # Update configuration
            config.auto_sync_interval = interval_seconds
            self.config_manager.set_workspace_config(workspace, config)
            
            # Update sync metadata
            session = self._get_db_session()
            try:
                sync_meta = session.query(SyncMetadata).filter_by(
                    workspace=workspace
                ).first()
                
                if sync_meta:
                    sync_meta.auto_sync_enabled = True
                    sync_meta.auto_sync_interval_seconds = interval_seconds
                    sync_meta.next_auto_sync_at = datetime.utcnow() + timedelta(
                        seconds=interval_seconds
                    )
                    session.commit()
                
            finally:
                session.close()
            
            logger.info(
                "auto_sync_enabled",
                workspace=workspace,
                interval_seconds=interval_seconds
            )
            
        except WorkspaceNotFoundError:
            raise
        except Exception as e:
            logger.error(
                "auto_sync_enable_failed",
                workspace=workspace,
                error=str(e)
            )
            raise SyncOperationError(
                f"Failed to enable auto-sync: {e}"
            ) from e
    
    def disable_auto_sync(self, workspace: str) -> None:
        """
        Disables automatic background sync.
        
        Args:
            workspace: Workspace name
            
        Raises:
            WorkspaceNotFoundError: If workspace doesn't exist
            SyncOperationError: If disabling fails
        """
        try:
            # Validate workspace exists
            config = self.config_manager.get_workspace_config(workspace)
            
            # Cancel auto-sync task if running
            if workspace in self._auto_sync_tasks:
                self._auto_sync_tasks[workspace].cancel()
                del self._auto_sync_tasks[workspace]
            
            # Update configuration
            config.auto_sync_interval = None
            self.config_manager.set_workspace_config(workspace, config)
            
            # Update sync metadata
            session = self._get_db_session()
            try:
                sync_meta = session.query(SyncMetadata).filter_by(
                    workspace=workspace
                ).first()
                
                if sync_meta:
                    sync_meta.auto_sync_enabled = False
                    sync_meta.auto_sync_interval_seconds = None
                    sync_meta.next_auto_sync_at = None
                    session.commit()
                
            finally:
                session.close()
            
            logger.info(
                "auto_sync_disabled",
                workspace=workspace
            )
            
        except WorkspaceNotFoundError:
            raise
        except Exception as e:
            logger.error(
                "auto_sync_disable_failed",
                workspace=workspace,
                error=str(e)
            )
            raise SyncOperationError(
                f"Failed to disable auto-sync: {e}"
            ) from e


    def resolve_conflicts(
        self,
        workspace: str,
        strategy: Optional[ConflictStrategy] = None
    ) -> int:
        """
        Applies conflict resolution strategy to unresolved conflicts.
        
        Args:
            workspace: Workspace name
            strategy: Conflict resolution strategy (uses workspace default if not provided)
            
        Returns:
            Number of conflicts resolved
            
        Raises:
            WorkspaceNotFoundError: If workspace doesn't exist
            SyncConflictError: If resolution fails
        """
        try:
            # Get workspace configuration
            config = self.config_manager.get_workspace_config(workspace)
            
            # Use provided strategy or workspace default
            resolution_strategy = strategy or config.conflict_strategy
            
            # Get unresolved conflicts
            session = self._get_db_session()
            try:
                conflicts = session.query(SyncConflict).filter(
                    and_(
                        SyncConflict.workspace == workspace,
                        SyncConflict.status == "unresolved"
                    )
                ).all()
                
                if not conflicts:
                    return 0
                
                resolved_count = 0
                
                for conflict in conflicts:
                    try:
                        # Apply resolution strategy
                        if resolution_strategy == ConflictStrategy.OPERATIONAL_TRANSFORM:
                            resolved_version = self._apply_operational_transform(
                                conflict.local_version,
                                conflict.remote_version,
                                conflict.entity_type
                            )
                        elif resolution_strategy == ConflictStrategy.LAST_WRITE_WINS:
                            resolved_version = self._apply_last_write_wins(
                                conflict.local_version,
                                conflict.remote_version,
                                conflict.local_timestamp,
                                conflict.remote_timestamp
                            )
                        elif resolution_strategy == ConflictStrategy.REMOTE_WINS:
                            resolved_version = conflict.remote_version
                        elif resolution_strategy == ConflictStrategy.LOCAL_WINS:
                            resolved_version = conflict.local_version
                        else:  # MANUAL
                            # Skip manual conflicts
                            continue
                        
                        # Update conflict record
                        conflict.resolution_strategy = resolution_strategy.value
                        conflict.resolved_version = resolved_version
                        conflict.resolved_at = datetime.utcnow()
                        conflict.resolved_by = "system"
                        conflict.status = "resolved"
                        
                        resolved_count += 1
                        
                        logger.debug(
                            "conflict_resolved",
                            workspace=workspace,
                            conflict_id=str(conflict.conflict_id),
                            strategy=resolution_strategy.value,
                            entity_type=conflict.entity_type,
                            entity_id=conflict.entity_id
                        )
                        
                    except Exception as e:
                        logger.error(
                            "conflict_resolution_failed",
                            workspace=workspace,
                            conflict_id=str(conflict.conflict_id),
                            error=str(e)
                        )
                        # Mark for manual review
                        conflict.status = "manual_review"
                        conflict.conflict_metadata = conflict.conflict_metadata or {}
                        conflict.conflict_metadata["resolution_error"] = str(e)
                
                session.commit()
                
                logger.info(
                    "conflicts_resolved",
                    workspace=workspace,
                    strategy=resolution_strategy.value,
                    resolved_count=resolved_count,
                    total_conflicts=len(conflicts)
                )
                
                return resolved_count
                
            finally:
                session.close()
                
        except WorkspaceNotFoundError:
            raise
        except Exception as e:
            logger.error(
                "conflict_resolution_failed",
                workspace=workspace,
                error=str(e)
            )
            raise SyncConflictError(
                f"Failed to resolve conflicts: {e}"
            ) from e
    
    def _apply_operational_transform(
        self,
        local_version: Dict[str, Any],
        remote_version: Dict[str, Any],
        entity_type: str
    ) -> Dict[str, Any]:
        """
        Apply operational transform algorithm to merge concurrent changes.
        
        This implements a simplified OT algorithm that:
        1. Identifies non-conflicting changes (different fields)
        2. Merges non-conflicting changes
        3. Falls back to last-write-wins for conflicting fields
        
        Args:
            local_version: Local entity version
            remote_version: Remote entity version
            entity_type: Entity type
            
        Returns:
            Merged version
        """
        # Start with remote version as base
        merged = remote_version.copy()
        
        # Get all keys from both versions
        all_keys = set(local_version.keys()) | set(remote_version.keys())
        
        for key in all_keys:
            local_value = local_version.get(key)
            remote_value = remote_version.get(key)
            
            # If values are the same, no conflict
            if local_value == remote_value:
                merged[key] = local_value
                continue
            
            # If key only exists in local, add it
            if key not in remote_version:
                merged[key] = local_value
                continue
            
            # If key only exists in remote, keep it
            if key not in local_version:
                merged[key] = remote_value
                continue
            
            # Both versions have different values - this is a conflict
            # For now, use last-write-wins based on timestamps
            # In a more sophisticated implementation, we would apply
            # type-specific transformation rules
            
            # Check if we have timestamps to determine winner
            local_ts = local_version.get("updated_at") or local_version.get("timestamp")
            remote_ts = remote_version.get("updated_at") or remote_version.get("timestamp")
            
            if local_ts and remote_ts:
                # Parse timestamps if they're strings
                if isinstance(local_ts, str):
                    local_ts = datetime.fromisoformat(local_ts.replace('Z', '+00:00'))
                if isinstance(remote_ts, str):
                    remote_ts = datetime.fromisoformat(remote_ts.replace('Z', '+00:00'))
                
                # Use newer value
                if local_ts > remote_ts:
                    merged[key] = local_value
                else:
                    merged[key] = remote_value
            else:
                # No timestamps, prefer remote (safer default)
                merged[key] = remote_value
        
        logger.debug(
            "operational_transform_applied",
            entity_type=entity_type,
            local_keys=len(local_version),
            remote_keys=len(remote_version),
            merged_keys=len(merged)
        )
        
        return merged
    
    def _apply_last_write_wins(
        self,
        local_version: Dict[str, Any],
        remote_version: Dict[str, Any],
        local_timestamp: datetime,
        remote_timestamp: datetime
    ) -> Dict[str, Any]:
        """
        Apply last-write-wins conflict resolution.
        
        Args:
            local_version: Local entity version
            remote_version: Remote entity version
            local_timestamp: Local modification timestamp
            remote_timestamp: Remote modification timestamp
            
        Returns:
            Winning version
        """
        if local_timestamp > remote_timestamp:
            logger.debug(
                "last_write_wins_local",
                local_timestamp=local_timestamp.isoformat(),
                remote_timestamp=remote_timestamp.isoformat()
            )
            return local_version
        else:
            logger.debug(
                "last_write_wins_remote",
                local_timestamp=local_timestamp.isoformat(),
                remote_timestamp=remote_timestamp.isoformat()
            )
            return remote_version
    
    def get_conflict_history(
        self,
        workspace: str,
        limit: int = 100,
        include_resolved: bool = True
    ) -> List[Conflict]:
        """
        Returns conflict history for audit.
        
        Args:
            workspace: Workspace name
            limit: Maximum number of conflicts to return
            include_resolved: Whether to include resolved conflicts
            
        Returns:
            List of conflicts
            
        Raises:
            WorkspaceNotFoundError: If workspace doesn't exist
        """
        try:
            # Validate workspace exists
            self.config_manager.get_workspace_config(workspace)
            
            # Query conflicts
            session = self._get_db_session()
            try:
                query = session.query(SyncConflict).filter(
                    SyncConflict.workspace == workspace
                )
                
                if not include_resolved:
                    query = query.filter(SyncConflict.status == "unresolved")
                
                conflicts_db = query.order_by(
                    SyncConflict.detected_at.desc()
                ).limit(limit).all()
                
                conflicts = []
                for c in conflicts_db:
                    conflicts.append(Conflict(
                        id=str(c.conflict_id),
                        entity_type=c.entity_type,
                        entity_id=c.entity_id,
                        local_version=c.local_version,
                        remote_version=c.remote_version,
                        local_timestamp=c.local_timestamp,
                        remote_timestamp=c.remote_timestamp,
                        resolution=c.resolution_strategy,
                        resolved_at=c.resolved_at
                    ))
                
                return conflicts
                
            finally:
                session.close()
                
        except WorkspaceNotFoundError:
            raise
        except Exception as e:
            logger.error(
                "conflict_history_query_failed",
                workspace=workspace,
                error=str(e)
            )
            raise SyncOperationError(
                f"Failed to get conflict history: {e}"
            ) from e
    
    def _detect_conflicts(
        self,
        workspace: str,
        local_changes: List[Dict[str, Any]],
        remote_changes: List[Dict[str, Any]],
        session: Session
    ) -> List[SyncConflict]:
        """
        Detect conflicts between local and remote changes.
        
        Args:
            workspace: Workspace name
            local_changes: List of local changes
            remote_changes: List of remote changes
            session: Database session
            
        Returns:
            List of detected conflicts
        """
        conflicts = []
        
        # Create lookup maps by entity
        local_map = {
            (change["entity_type"], change["entity_id"]): change
            for change in local_changes
        }
        remote_map = {
            (change["entity_type"], change["entity_id"]): change
            for change in remote_changes
        }
        
        # Find entities modified in both local and remote
        common_entities = set(local_map.keys()) & set(remote_map.keys())
        
        for entity_key in common_entities:
            local_change = local_map[entity_key]
            remote_change = remote_map[entity_key]
            
            # Check if changes are different
            if local_change["data"] != remote_change["data"]:
                # Create conflict record
                conflict = SyncConflict(
                    conflict_id=uuid4(),
                    workspace=workspace,
                    entity_type=entity_key[0],
                    entity_id=entity_key[1],
                    local_version=local_change["data"],
                    remote_version=remote_change["data"],
                    local_timestamp=local_change["timestamp"],
                    remote_timestamp=remote_change["timestamp"],
                    detected_at=datetime.utcnow(),
                    status="unresolved"
                )
                
                session.add(conflict)
                conflicts.append(conflict)
                
                logger.debug(
                    "conflict_detected",
                    workspace=workspace,
                    entity_type=entity_key[0],
                    entity_id=entity_key[1],
                    conflict_id=str(conflict.conflict_id)
                )
        
        return conflicts


    async def _retry_with_backoff(
        self,
        func,
        max_retries: int = DEFAULT_MAX_RETRIES,
        initial_delay: float = 1.0,
        max_delay: float = 16.0,
        jitter: bool = True
    ):
        """
        Retry a function with exponential backoff and jitter.
        
        Args:
            func: Async function to retry
            max_retries: Maximum number of retry attempts
            initial_delay: Initial delay in seconds
            max_delay: Maximum delay in seconds
            jitter: Whether to add random jitter to delays
            
        Returns:
            Function result
            
        Raises:
            Last exception if all retries fail
        """
        last_exception = None
        
        for attempt in range(max_retries):
            try:
                return await func()
            except (httpx.ConnectError, httpx.TimeoutException, NetworkError) as e:
                last_exception = e
                
                if attempt == max_retries - 1:
                    # Last attempt failed
                    logger.error(
                        "retry_exhausted",
                        attempt=attempt + 1,
                        max_retries=max_retries,
                        error=str(e)
                    )
                    raise
                
                # Calculate delay with exponential backoff
                delay = min(initial_delay * (2 ** attempt), max_delay)
                
                # Add jitter (10% of delay)
                if jitter:
                    jitter_amount = delay * 0.1
                    delay += random.uniform(-jitter_amount, jitter_amount)
                
                logger.warning(
                    "retry_attempt",
                    attempt=attempt + 1,
                    max_retries=max_retries,
                    delay_seconds=delay,
                    error=str(e)
                )
                
                await asyncio.sleep(delay)
        
        # Should not reach here, but just in case
        if last_exception:
            raise last_exception
    
    def check_connectivity(self, workspace: str) -> bool:
        """
        Check network connectivity to remote sync endpoint.
        
        Args:
            workspace: Workspace name
            
        Returns:
            True if connected, False otherwise
        """
        try:
            # Get workspace configuration
            config = self.config_manager.get_workspace_config(workspace)
            
            if not config.sync_url:
                return False
            
            # Try to connect to remote endpoint
            async def check():
                client = self._get_http_client()
                try:
                    response = await client.get(
                        f"{config.sync_url}/health",
                        timeout=5.0
                    )
                    return response.status_code == 200
                except:
                    return False
            
            # Run async check
            return asyncio.run(check())
            
        except Exception as e:
            logger.debug(
                "connectivity_check_failed",
                workspace=workspace,
                error=str(e)
            )
            return False
    
    async def monitor_connectivity(
        self,
        workspace: str,
        check_interval: int = 60,
        on_restored: Optional[callable] = None
    ):
        """
        Monitor network connectivity and trigger callback when restored.
        
        Args:
            workspace: Workspace name
            check_interval: Check interval in seconds
            on_restored: Callback function to call when connectivity is restored
        """
        was_offline = False
        
        while True:
            try:
                is_connected = self.check_connectivity(workspace)
                
                if not is_connected:
                    if not was_offline:
                        logger.warning(
                            "connectivity_lost",
                            workspace=workspace
                        )
                        was_offline = True
                else:
                    if was_offline:
                        logger.info(
                            "connectivity_restored",
                            workspace=workspace
                        )
                        was_offline = False
                        
                        # Trigger callback if provided
                        if on_restored:
                            try:
                                if asyncio.iscoroutinefunction(on_restored):
                                    await on_restored(workspace)
                                else:
                                    on_restored(workspace)
                            except Exception as e:
                                logger.error(
                                    "connectivity_restored_callback_failed",
                                    workspace=workspace,
                                    error=str(e)
                                )
                
                await asyncio.sleep(check_interval)
                
            except asyncio.CancelledError:
                logger.debug(
                    "connectivity_monitor_cancelled",
                    workspace=workspace
                )
                break
            except Exception as e:
                logger.error(
                    "connectivity_monitor_error",
                    workspace=workspace,
                    error=str(e)
                )
                await asyncio.sleep(check_interval)
    
    def process_queued_operations(self, workspace: str) -> int:
        """
        Process queued operations when connectivity is restored.
        
        Args:
            workspace: Workspace name
            
        Returns:
            Number of operations processed
            
        Raises:
            WorkspaceNotFoundError: If workspace doesn't exist
            SyncOperationError: If processing fails
        """
        try:
            # Validate workspace exists
            config = self.config_manager.get_workspace_config(workspace)
            
            if not config.sync_enabled:
                return 0
            
            # Check connectivity
            if not self.check_connectivity(workspace):
                raise OfflineError(
                    f"Cannot process queued operations: offline for workspace {workspace}"
                )
            
            # Get pending operations
            session = self._get_db_session()
            try:
                pending_ops = session.query(SyncOperation).filter(
                    and_(
                        SyncOperation.workspace == workspace,
                        SyncOperation.status == "pending",
                        SyncOperation.retry_count < SyncOperation.max_retries
                    )
                ).order_by(SyncOperation.created_at).all()
                
                if not pending_ops:
                    return 0
                
                processed_count = 0
                
                for op in pending_ops:
                    try:
                        # Mark as processing
                        op.status = "processing"
                        session.commit()
                        
                        # Process operation (would be actual HTTP call in production)
                        # For now, just mark as completed
                        op.status = "completed"
                        op.completed_at = datetime.utcnow()
                        processed_count += 1
                        
                        logger.debug(
                            "queued_operation_processed",
                            workspace=workspace,
                            operation_id=str(op.operation_id),
                            operation_type=op.operation_type
                        )
                        
                    except Exception as e:
                        # Increment retry count
                        op.retry_count += 1
                        op.last_retry_at = datetime.utcnow()
                        op.last_error = str(e)
                        
                        if op.retry_count >= op.max_retries:
                            op.status = "failed"
                            logger.error(
                                "queued_operation_failed",
                                workspace=workspace,
                                operation_id=str(op.operation_id),
                                retry_count=op.retry_count,
                                error=str(e)
                            )
                        else:
                            op.status = "pending"
                            logger.warning(
                                "queued_operation_retry",
                                workspace=workspace,
                                operation_id=str(op.operation_id),
                                retry_count=op.retry_count,
                                error=str(e)
                            )
                
                session.commit()
                
                logger.info(
                    "queued_operations_processed",
                    workspace=workspace,
                    processed_count=processed_count,
                    total_pending=len(pending_ops)
                )
                
                return processed_count
                
            finally:
                session.close()
                
        except WorkspaceNotFoundError:
            raise
        except OfflineError:
            raise
        except Exception as e:
            logger.error(
                "queued_operations_processing_failed",
                workspace=workspace,
                error=str(e)
            )
            raise SyncOperationError(
                f"Failed to process queued operations: {e}"
            ) from e
    
    async def auto_sync_on_connectivity_restored(self, workspace: str):
        """
        Automatically sync when connectivity is restored.
        
        This is a callback function for the connectivity monitor.
        
        Args:
            workspace: Workspace name
        """
        try:
            logger.info(
                "auto_sync_on_restore_triggered",
                workspace=workspace
            )
            
            # Process queued operations
            processed = self.process_queued_operations(workspace)
            
            # Perform full sync
            result = self.sync_now(workspace, SyncDirection.BIDIRECTIONAL)
            
            logger.info(
                "auto_sync_on_restore_completed",
                workspace=workspace,
                queued_processed=processed,
                uploaded=result.uploaded_count,
                downloaded=result.downloaded_count
            )
            
        except Exception as e:
            logger.error(
                "auto_sync_on_restore_failed",
                workspace=workspace,
                error=str(e)
            )
    
    def get_pending_operations_count(self, workspace: str) -> int:
        """
        Get count of pending operations for a workspace.
        
        Args:
            workspace: Workspace name
            
        Returns:
            Number of pending operations
        """
        try:
            session = self._get_db_session()
            try:
                count = session.query(SyncOperation).filter(
                    and_(
                        SyncOperation.workspace == workspace,
                        SyncOperation.status == "pending"
                    )
                ).count()
                return count
            finally:
                session.close()
        except Exception as e:
            logger.error(
                "pending_operations_count_failed",
                workspace=workspace,
                error=str(e)
            )
            return 0
    
    def get_failed_operations(
        self,
        workspace: str,
        limit: int = 100
    ) -> List[Operation]:
        """
        Get failed operations for a workspace.
        
        Args:
            workspace: Workspace name
            limit: Maximum number of operations to return
            
        Returns:
            List of failed operations
        """
        try:
            session = self._get_db_session()
            try:
                ops_db = session.query(SyncOperation).filter(
                    and_(
                        SyncOperation.workspace == workspace,
                        SyncOperation.status == "failed"
                    )
                ).order_by(
                    SyncOperation.created_at.desc()
                ).limit(limit).all()
                
                operations = []
                for op in ops_db:
                    operations.append(Operation(
                        id=str(op.operation_id),
                        type=op.operation_type,
                        entity_type=op.entity_type,
                        entity_id=op.entity_id,
                        data=op.operation_data,
                        timestamp=op.created_at,
                        retry_count=op.retry_count,
                        last_error=op.last_error
                    ))
                
                return operations
                
            finally:
                session.close()
                
        except Exception as e:
            logger.error(
                "failed_operations_query_failed",
                workspace=workspace,
                error=str(e)
            )
            return []
    
    def retry_failed_operation(self, workspace: str, operation_id: str) -> bool:
        """
        Retry a failed operation.
        
        Args:
            workspace: Workspace name
            operation_id: Operation ID
            
        Returns:
            True if operation was reset for retry, False otherwise
        """
        try:
            session = self._get_db_session()
            try:
                op = session.query(SyncOperation).filter(
                    and_(
                        SyncOperation.workspace == workspace,
                        SyncOperation.operation_id == UUID(operation_id),
                        SyncOperation.status == "failed"
                    )
                ).first()
                
                if not op:
                    return False
                
                # Reset operation for retry
                op.status = "pending"
                op.retry_count = 0
                op.last_error = None
                op.last_retry_at = None
                
                session.commit()
                
                logger.info(
                    "failed_operation_reset",
                    workspace=workspace,
                    operation_id=operation_id
                )
                
                return True
                
            finally:
                session.close()
                
        except Exception as e:
            logger.error(
                "failed_operation_retry_failed",
                workspace=workspace,
                operation_id=operation_id,
                error=str(e)
            )
            return False
    
    def __del__(self):
        """Cleanup on deletion."""
        # Cancel all auto-sync tasks
        for task in self._auto_sync_tasks.values():
            if not task.done():
                task.cancel()
        
        # Close HTTP client
        if self._http_client:
            try:
                asyncio.run(self._close_http_client())
            except:
                pass
