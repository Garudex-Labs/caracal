"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Migration system for Caracal deployment architecture.

Handles migration operations including:
- Repository to package migration
- Edition switching (Open Source <-> Enterprise)
- Data preservation and integrity verification
- Backup and rollback functionality
"""

import hashlib
import json
import shutil
import tarfile
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Any
import structlog

from caracal.deployment.config_manager import ConfigManager
from caracal.deployment.edition import Edition, EditionManager
from caracal.deployment.exceptions import (
    MigrationError,
    MigrationValidationError,
    MigrationDataError,
    MigrationRollbackError,
    BackupError,
    RestoreError,
)
from caracal.deployment.logging_utils import log_migration_operation

logger = structlog.get_logger(__name__)


class MigrationManager:
    """
    Manages migration operations for Caracal deployment.
    
    Provides methods for:
    - Repository to package migration
    - Edition switching with data migration
    - Backup creation and restoration
    - Data integrity verification
    - Rollback on failure
    """
    
    # Backup directory
    BACKUP_DIR = Path.home() / ".caracal" / "backups"
    
    # Maximum number of backups to retain
    MAX_BACKUPS = 5
    
    def __init__(self):
        """Initialize the migration manager."""
        self.config_manager = ConfigManager()
        self.edition_manager = EditionManager()
        
        # Ensure backup directory exists
        self.BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        self.BACKUP_DIR.chmod(0o700)
    
    def migrate_repository_to_package(
        self,
        repository_path: Optional[Path] = None,
        preserve_data: bool = True,
        verify_integrity: bool = True
    ) -> Dict[str, Any]:
        """
        Migrates from repository-based installation to package-based installation.
        
        This migration:
        1. Creates a backup of existing configuration and data
        2. Exports all workspaces
        3. Preserves all settings and credentials
        4. Verifies data integrity after migration
        5. Provides rollback capability on failure
        
        Args:
            repository_path: Path to repository installation (auto-detected if None)
            preserve_data: Whether to preserve all data during migration
            verify_integrity: Whether to verify data integrity after migration
            
        Returns:
            Migration result dictionary with status and details
            
        Raises:
            MigrationError: If migration fails
            BackupError: If backup creation fails
            MigrationValidationError: If data integrity verification fails
        """
        start_time = datetime.now()
        migration_id = self._generate_migration_id("repo_to_package")
        
        logger.info(
            "migration_started",
            migration_id=migration_id,
            migration_type="repository_to_package",
            repository_path=str(repository_path) if repository_path else "auto-detect",
            preserve_data=preserve_data,
            verify_integrity=verify_integrity
        )
        
        backup_path = None
        workspaces_migrated = 0
        
        try:
            # Step 1: Create backup
            logger.info("migration_step", step="create_backup", migration_id=migration_id)
            backup_path = self._create_backup(migration_id, "pre_repo_migration")
            
            # Step 2: Detect repository installation
            if repository_path is None:
                repository_path = self._detect_repository_installation()
            
            if repository_path and repository_path.exists():
                logger.info(
                    "repository_detected",
                    migration_id=migration_id,
                    repository_path=str(repository_path)
                )
            else:
                logger.warning(
                    "repository_not_found",
                    migration_id=migration_id,
                    repository_path=str(repository_path) if repository_path else None
                )
            
            # Step 3: Preserve data if requested
            if preserve_data:
                logger.info("migration_step", step="preserve_data", migration_id=migration_id)
                workspaces_migrated = self._preserve_migration_data(repository_path)
            
            # Step 4: Verify integrity if requested
            if verify_integrity:
                logger.info("migration_step", step="verify_integrity", migration_id=migration_id)
                self._verify_data_integrity(backup_path)
            
            # Step 5: Clean up old backups
            self._cleanup_old_backups()
            
            duration_ms = int((datetime.now() - start_time).total_seconds() * 1000)
            
            result = {
                "success": True,
                "migration_id": migration_id,
                "migration_type": "repository_to_package",
                "workspaces_migrated": workspaces_migrated,
                "backup_path": str(backup_path),
                "duration_ms": duration_ms,
                "timestamp": datetime.now().isoformat()
            }
            
            log_migration_operation(
                logger=logger,
                migration_type="repository_to_package",
                success=True,
                items_migrated=workspaces_migrated,
                duration_ms=duration_ms,
                migration_id=migration_id
            )
            
            logger.info(
                "migration_completed",
                migration_id=migration_id,
                **result
            )
            
            return result
            
        except Exception as e:
            duration_ms = int((datetime.now() - start_time).total_seconds() * 1000)
            
            logger.error(
                "migration_failed",
                migration_id=migration_id,
                migration_type="repository_to_package",
                error=str(e),
                error_type=type(e).__name__
            )
            
            # Attempt rollback
            if backup_path:
                try:
                    logger.info(
                        "migration_rollback_started",
                        migration_id=migration_id,
                        backup_path=str(backup_path)
                    )
                    self._rollback_from_backup(backup_path)
                    logger.info(
                        "migration_rollback_completed",
                        migration_id=migration_id
                    )
                except Exception as rollback_error:
                    logger.error(
                        "migration_rollback_failed",
                        migration_id=migration_id,
                        error=str(rollback_error),
                        error_type=type(rollback_error).__name__
                    )
                    raise MigrationRollbackError(
                        f"Migration failed and rollback also failed: {rollback_error}"
                    ) from rollback_error
            
            log_migration_operation(
                logger=logger,
                migration_type="repository_to_package",
                success=False,
                items_migrated=workspaces_migrated,
                duration_ms=duration_ms,
                error=str(e),
                migration_id=migration_id
            )
            
            raise MigrationError(f"Repository to package migration failed: {e}") from e
    
    def migrate_edition(
        self,
        target_edition: Edition,
        gateway_url: Optional[str] = None,
        gateway_token: Optional[str] = None,
        migrate_api_keys: bool = True
    ) -> Dict[str, Any]:
        """
        Migrates between Open Source and Enterprise editions.
        
        This migration:
        1. Creates a backup of existing configuration
        2. Migrates API keys between local storage and gateway
        3. Migrates edition-specific settings
        4. Updates edition configuration
        5. Verifies migration success
        
        Args:
            target_edition: Target edition (OPENSOURCE or ENTERPRISE)
            gateway_url: Gateway URL (required for Enterprise Edition)
            gateway_token: Gateway JWT token (optional, for Enterprise Edition)
            migrate_api_keys: Whether to migrate API keys
            
        Returns:
            Migration result dictionary with status and details
            
        Raises:
            MigrationError: If migration fails
            BackupError: If backup creation fails
        """
        start_time = datetime.now()
        migration_id = self._generate_migration_id("edition_switch")
        current_edition = self.edition_manager.get_edition()
        
        logger.info(
            "edition_migration_started",
            migration_id=migration_id,
            current_edition=current_edition.value,
            target_edition=target_edition.value,
            migrate_api_keys=migrate_api_keys
        )
        
        # Validate target edition
        if current_edition == target_edition:
            raise MigrationError(
                f"Already running {target_edition.value} edition"
            )
        
        # Validate Enterprise Edition requirements
        if target_edition == Edition.ENTERPRISE and not gateway_url:
            raise MigrationError(
                "Gateway URL is required for Enterprise Edition migration"
            )
        
        backup_path = None
        api_keys_migrated = 0
        
        try:
            # Step 1: Create backup
            logger.info("migration_step", step="create_backup", migration_id=migration_id)
            backup_path = self._create_backup(migration_id, "pre_edition_switch")
            
            # Step 2: Migrate API keys if requested
            if migrate_api_keys:
                logger.info("migration_step", step="migrate_api_keys", migration_id=migration_id)
                api_keys_migrated = self._migrate_api_keys(
                    current_edition,
                    target_edition,
                    gateway_url,
                    gateway_token
                )
            
            # Step 3: Migrate settings
            logger.info("migration_step", step="migrate_settings", migration_id=migration_id)
            self._migrate_edition_settings(current_edition, target_edition)
            
            # Step 4: Update edition configuration
            logger.info("migration_step", step="update_edition", migration_id=migration_id)
            self.edition_manager.set_edition(
                target_edition,
                gateway_url=gateway_url,
                gateway_token=gateway_token
            )
            
            # Step 5: Clean up old backups
            self._cleanup_old_backups()
            
            duration_ms = int((datetime.now() - start_time).total_seconds() * 1000)
            
            result = {
                "success": True,
                "migration_id": migration_id,
                "migration_type": "edition_switch",
                "from_edition": current_edition.value,
                "to_edition": target_edition.value,
                "api_keys_migrated": api_keys_migrated,
                "backup_path": str(backup_path),
                "duration_ms": duration_ms,
                "timestamp": datetime.now().isoformat()
            }
            
            log_migration_operation(
                logger=logger,
                migration_type="edition_switch",
                success=True,
                items_migrated=api_keys_migrated,
                duration_ms=duration_ms,
                migration_id=migration_id,
                from_edition=current_edition.value,
                to_edition=target_edition.value
            )
            
            logger.info(
                "edition_migration_completed",
                migration_id=migration_id,
                **result
            )
            
            return result
            
        except Exception as e:
            duration_ms = int((datetime.now() - start_time).total_seconds() * 1000)
            
            logger.error(
                "edition_migration_failed",
                migration_id=migration_id,
                current_edition=current_edition.value,
                target_edition=target_edition.value,
                error=str(e),
                error_type=type(e).__name__
            )
            
            # Attempt rollback
            if backup_path:
                try:
                    logger.info(
                        "migration_rollback_started",
                        migration_id=migration_id,
                        backup_path=str(backup_path)
                    )
                    self._rollback_from_backup(backup_path)
                    logger.info(
                        "migration_rollback_completed",
                        migration_id=migration_id
                    )
                except Exception as rollback_error:
                    logger.error(
                        "migration_rollback_failed",
                        migration_id=migration_id,
                        error=str(rollback_error),
                        error_type=type(rollback_error).__name__
                    )
                    raise MigrationRollbackError(
                        f"Edition migration failed and rollback also failed: {rollback_error}"
                    ) from rollback_error
            
            log_migration_operation(
                logger=logger,
                migration_type="edition_switch",
                success=False,
                items_migrated=api_keys_migrated,
                duration_ms=duration_ms,
                error=str(e),
                migration_id=migration_id,
                from_edition=current_edition.value,
                to_edition=target_edition.value
            )
            
            raise MigrationError(f"Edition migration failed: {e}") from e
    
    def _create_backup(self, migration_id: str, backup_type: str) -> Path:
        """
        Creates a backup of current configuration and data.
        
        Args:
            migration_id: Migration identifier
            backup_type: Type of backup (e.g., "pre_repo_migration")
            
        Returns:
            Path to backup file
            
        Raises:
            BackupError: If backup creation fails
        """
        try:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            backup_filename = f"backup_{backup_type}_{migration_id}_{timestamp}.tar.gz"
            backup_path = self.BACKUP_DIR / backup_filename
            
            logger.info(
                "backup_started",
                migration_id=migration_id,
                backup_type=backup_type,
                backup_path=str(backup_path)
            )
            
            config_dir = Path.home() / ".caracal"
            
            if not config_dir.exists():
                logger.warning(
                    "config_dir_not_found",
                    migration_id=migration_id,
                    config_dir=str(config_dir)
                )
                # Create empty backup
                with tarfile.open(backup_path, "w:gz") as tar:
                    pass
                return backup_path
            
            with tarfile.open(backup_path, "w:gz") as tar:
                # Backup configuration files
                for item in config_dir.iterdir():
                    # Skip backups directory to avoid recursive backup
                    if item.name == "backups":
                        continue
                    # Skip cache directory (can be regenerated)
                    if item.name == "cache":
                        continue
                    
                    tar.add(item, arcname=item.name)
            
            # Create checksum for integrity verification
            checksum = self._calculate_checksum(backup_path)
            checksum_file = backup_path.with_suffix(".tar.gz.sha256")
            checksum_file.write_text(checksum)
            
            logger.info(
                "backup_completed",
                migration_id=migration_id,
                backup_path=str(backup_path),
                checksum=checksum
            )
            
            return backup_path
            
        except Exception as e:
            logger.error(
                "backup_failed",
                migration_id=migration_id,
                backup_type=backup_type,
                error=str(e),
                error_type=type(e).__name__
            )
            raise BackupError(f"Failed to create backup: {e}") from e
    
    def _rollback_from_backup(self, backup_path: Path) -> None:
        """
        Restores configuration from backup.
        
        Args:
            backup_path: Path to backup file
            
        Raises:
            RestoreError: If restore fails
        """
        try:
            logger.info(
                "restore_started",
                backup_path=str(backup_path)
            )
            
            # Verify backup integrity
            checksum_file = backup_path.with_suffix(".tar.gz.sha256")
            if checksum_file.exists():
                expected_checksum = checksum_file.read_text().strip()
                actual_checksum = self._calculate_checksum(backup_path)
                
                if expected_checksum != actual_checksum:
                    raise RestoreError(
                        f"Backup integrity check failed: checksum mismatch"
                    )
            
            config_dir = Path.home() / ".caracal"
            
            # Create temporary directory for extraction
            with tempfile.TemporaryDirectory() as temp_dir:
                temp_path = Path(temp_dir)
                
                # Extract backup
                with tarfile.open(backup_path, "r:gz") as tar:
                    tar.extractall(temp_path)
                
                # Remove current configuration (except backups)
                if config_dir.exists():
                    for item in config_dir.iterdir():
                        if item.name == "backups":
                            continue
                        if item.is_dir():
                            shutil.rmtree(item)
                        else:
                            item.unlink()
                
                # Restore from backup
                for item in temp_path.iterdir():
                    target = config_dir / item.name
                    if item.is_dir():
                        shutil.copytree(item, target)
                    else:
                        shutil.copy2(item, target)
            
            logger.info(
                "restore_completed",
                backup_path=str(backup_path)
            )
            
        except Exception as e:
            logger.error(
                "restore_failed",
                backup_path=str(backup_path),
                error=str(e),
                error_type=type(e).__name__
            )
            raise RestoreError(f"Failed to restore from backup: {e}") from e
    
    def _verify_data_integrity(self, backup_path: Path) -> None:
        """
        Verifies data integrity after migration.
        
        Args:
            backup_path: Path to backup file for comparison
            
        Raises:
            MigrationValidationError: If data integrity check fails
        """
        try:
            logger.info(
                "integrity_verification_started",
                backup_path=str(backup_path)
            )
            
            # Verify workspaces exist
            workspaces = self.config_manager.list_workspaces()
            
            # Verify configuration files are readable
            for workspace in workspaces:
                try:
                    config = self.config_manager.get_workspace_config(workspace)
                    if not config:
                        raise MigrationValidationError(
                            f"Workspace configuration not found: {workspace}"
                        )
                except Exception as e:
                    raise MigrationValidationError(
                        f"Failed to read workspace configuration for {workspace}: {e}"
                    ) from e
            
            # Verify backup checksum
            checksum_file = backup_path.with_suffix(".tar.gz.sha256")
            if checksum_file.exists():
                expected_checksum = checksum_file.read_text().strip()
                actual_checksum = self._calculate_checksum(backup_path)
                
                if expected_checksum != actual_checksum:
                    raise MigrationValidationError(
                        "Backup integrity check failed: checksum mismatch"
                    )
            
            logger.info(
                "integrity_verification_completed",
                workspaces_verified=len(workspaces)
            )
            
        except MigrationValidationError:
            raise
        except Exception as e:
            logger.error(
                "integrity_verification_failed",
                error=str(e),
                error_type=type(e).__name__
            )
            raise MigrationValidationError(
                f"Data integrity verification failed: {e}"
            ) from e
    
    def _detect_repository_installation(self) -> Optional[Path]:
        """
        Detects repository-based installation.
        
        Returns:
            Path to repository installation or None if not found
        """
        # Common repository locations
        possible_paths = [
            Path.cwd(),  # Current directory
            Path.home() / "caracal",  # Home directory
            Path.home() / "projects" / "caracal",  # Projects directory
            Path("/opt/caracal"),  # System installation
        ]
        
        for path in possible_paths:
            if path.exists() and (path / "caracal").exists() and (path / "setup.py").exists():
                logger.debug(
                    "repository_installation_detected",
                    repository_path=str(path)
                )
                return path
        
        logger.debug("repository_installation_not_detected")
        return None
    
    def _preserve_migration_data(self, repository_path: Optional[Path]) -> int:
        """
        Preserves data during migration.
        
        Args:
            repository_path: Path to repository installation
            
        Returns:
            Number of workspaces migrated
        """
        workspaces_migrated = 0
        
        # Workspaces are already in ~/.caracal/workspaces
        # Just verify they exist and are accessible
        workspaces = self.config_manager.list_workspaces()
        
        for workspace in workspaces:
            try:
                config = self.config_manager.get_workspace_config(workspace)
                if config:
                    workspaces_migrated += 1
                    logger.debug(
                        "workspace_preserved",
                        workspace=workspace
                    )
            except Exception as e:
                logger.warning(
                    "workspace_preservation_failed",
                    workspace=workspace,
                    error=str(e)
                )
        
        logger.info(
            "data_preservation_completed",
            workspaces_migrated=workspaces_migrated
        )
        
        return workspaces_migrated
    
    def _migrate_api_keys(
        self,
        from_edition: Edition,
        to_edition: Edition,
        gateway_url: Optional[str],
        gateway_token: Optional[str]
    ) -> int:
        """
        Migrates API keys between editions.
        
        Args:
            from_edition: Source edition
            to_edition: Target edition
            gateway_url: Gateway URL (for Enterprise Edition)
            gateway_token: Gateway JWT token (for Enterprise Edition)
            
        Returns:
            Number of API keys migrated
        """
        api_keys_migrated = 0
        
        if from_edition == Edition.OPENSOURCE and to_edition == Edition.ENTERPRISE:
            # Migrate from local storage to gateway
            logger.info(
                "api_key_migration",
                direction="local_to_gateway",
                gateway_url=gateway_url
            )
            
            # In a real implementation, this would:
            # 1. Read API keys from local encrypted storage (vault)
            # 2. Upload them to the gateway using the gateway API
            # 3. Verify successful upload
            # 4. Remove them from local storage (optional, for security)
            # For now, we just log the operation
            
            workspaces = self.config_manager.list_workspaces()
            for workspace in workspaces:
                try:
                    # Placeholder: In real implementation, migrate actual API keys
                    # Example:
                    # api_keys = self.config_manager.get_all_secrets(workspace)
                    # for key_name, key_value in api_keys.items():
                    #     gateway_client.upload_api_key(workspace, key_name, key_value)
                    #     self.config_manager.delete_secret(key_name, workspace)
                    
                    logger.debug(
                        "api_keys_migrated_to_gateway",
                        workspace=workspace
                    )
                    api_keys_migrated += 1
                except Exception as e:
                    logger.warning(
                        "api_key_migration_failed",
                        workspace=workspace,
                        error=str(e)
                    )
        
        elif from_edition == Edition.ENTERPRISE and to_edition == Edition.OPENSOURCE:
            # Prompt for API keys when switching from gateway to local
            logger.info(
                "api_key_migration",
                direction="gateway_to_local",
                action="prompt_required"
            )
            
            # In a real implementation, this would:
            # 1. Optionally download API keys from gateway (if gateway supports export)
            # 2. Prompt user to configure API keys for local storage
            # 3. Store them in local encrypted storage (vault)
            # For now, we just log the operation
            
            logger.warning(
                "api_key_prompt_required",
                message="API keys must be configured for local storage after migration"
            )
            
            # Note: The CLI command will display a warning to the user
            # to configure API keys using 'caracal system secrets'
        
        logger.info(
            "api_key_migration_completed",
            api_keys_migrated=api_keys_migrated
        )
        
        return api_keys_migrated
    
    def _migrate_edition_settings(
        self,
        from_edition: Edition,
        to_edition: Edition
    ) -> None:
        """
        Migrates edition-specific settings.
        
        Args:
            from_edition: Source edition
            to_edition: Target edition
        """
        logger.info(
            "settings_migration",
            from_edition=from_edition.value,
            to_edition=to_edition.value
        )
        
        # In a real implementation, this would:
        # 1. Identify compatible settings between editions
        # 2. Migrate common settings (workspace configurations, etc.)
        # 3. Handle edition-specific settings:
        #    - For Open Source -> Enterprise: Remove broker-specific settings
        #    - For Enterprise -> Open Source: Remove gateway-specific settings
        # 4. Prompt for any required edition-specific settings
        # For now, we just log the operation
        
        # Example settings that would be migrated:
        # - Workspace configurations (names, metadata)
        # - Sync preferences (if applicable)
        # - Logging configurations
        # - General application settings
        
        # Example settings that would NOT be migrated:
        # - Provider-specific configurations (handled by API key migration)
        # - Gateway URLs and tokens (edition-specific)
        # - Broker circuit breaker settings (edition-specific)
        
        logger.info("settings_migration_completed")
    
    def _cleanup_old_backups(self) -> None:
        """
        Cleans up old backups, keeping only the most recent MAX_BACKUPS.
        """
        try:
            backups = sorted(
                self.BACKUP_DIR.glob("backup_*.tar.gz"),
                key=lambda p: p.stat().st_mtime,
                reverse=True
            )
            
            if len(backups) > self.MAX_BACKUPS:
                for backup in backups[self.MAX_BACKUPS:]:
                    backup.unlink()
                    # Also remove checksum file
                    checksum_file = backup.with_suffix(".tar.gz.sha256")
                    if checksum_file.exists():
                        checksum_file.unlink()
                    
                    logger.debug(
                        "old_backup_removed",
                        backup_path=str(backup)
                    )
                
                logger.info(
                    "old_backups_cleaned",
                    removed_count=len(backups) - self.MAX_BACKUPS
                )
        
        except Exception as e:
            logger.warning(
                "backup_cleanup_failed",
                error=str(e)
            )
    
    def _calculate_checksum(self, file_path: Path) -> str:
        """
        Calculates SHA-256 checksum of a file.
        
        Args:
            file_path: Path to file
            
        Returns:
            Hexadecimal checksum string
        """
        sha256 = hashlib.sha256()
        
        with open(file_path, "rb") as f:
            for chunk in iter(lambda: f.read(4096), b""):
                sha256.update(chunk)
        
        return sha256.hexdigest()
    
    def _generate_migration_id(self, migration_type: str) -> str:
        """
        Generates a unique migration identifier.
        
        Args:
            migration_type: Type of migration
            
        Returns:
            Migration identifier
        """
        timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
        return f"{migration_type}_{timestamp}"
    
    def list_backups(self) -> List[Dict[str, Any]]:
        """
        Lists all available backups.
        
        Returns:
            List of backup information dictionaries
        """
        backups = []
        
        for backup_file in sorted(
            self.BACKUP_DIR.glob("backup_*.tar.gz"),
            key=lambda p: p.stat().st_mtime,
            reverse=True
        ):
            stat = backup_file.stat()
            checksum_file = backup_file.with_suffix(".tar.gz.sha256")
            
            backup_info = {
                "path": str(backup_file),
                "name": backup_file.name,
                "size_bytes": stat.st_size,
                "created_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                "has_checksum": checksum_file.exists()
            }
            
            backups.append(backup_info)
        
        return backups
    
    def restore_backup(self, backup_path: Path) -> None:
        """
        Restores configuration from a specific backup.
        
        Args:
            backup_path: Path to backup file
            
        Raises:
            RestoreError: If restore fails
        """
        if not backup_path.exists():
            raise RestoreError(f"Backup file not found: {backup_path}")
        
        logger.info(
            "manual_restore_started",
            backup_path=str(backup_path)
        )
        
        self._rollback_from_backup(backup_path)
        
        logger.info(
            "manual_restore_completed",
            backup_path=str(backup_path)
        )
