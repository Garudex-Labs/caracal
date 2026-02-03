"""
Automatic key rotation scheduler for Merkle signing keys.

This module provides automatic key rotation based on configured intervals.
Key rotation is performed in the background and logged for audit purposes.
"""

import asyncio
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from caracal.config.settings import MerkleConfig
from caracal.logging_config import get_logger
from caracal.merkle.key_management import KeyManager

logger = get_logger(__name__)


class KeyRotationScheduler:
    """
    Schedules and performs automatic key rotation for Merkle signing keys.
    
    The scheduler runs in the background and rotates keys based on the
    configured rotation interval. All rotation operations are logged for
    audit purposes.
    
    Example:
        >>> from caracal.merkle.key_rotation_scheduler import KeyRotationScheduler
        >>> from caracal.config.settings import MerkleConfig
        >>> 
        >>> config = MerkleConfig(
        ...     key_rotation_enabled=True,
        ...     key_rotation_days=90,
        ...     private_key_path="/etc/caracal/keys/merkle-signing-key.pem",
        ...     key_encryption_passphrase="secure_passphrase"
        ... )
        >>> 
        >>> scheduler = KeyRotationScheduler(config)
        >>> await scheduler.start()
    """
    
    def __init__(
        self,
        config: MerkleConfig,
        audit_log_path: Optional[str] = None,
    ):
        """
        Initialize key rotation scheduler.
        
        Args:
            config: Merkle configuration with rotation settings
            audit_log_path: Optional path to audit log file
        """
        self.config = config
        self.key_manager = KeyManager(audit_log_path=audit_log_path)
        self.running = False
        self._task: Optional[asyncio.Task] = None
        
        logger.info(
            f"Key rotation scheduler initialized "
            f"(enabled: {config.key_rotation_enabled}, "
            f"interval: {config.key_rotation_days} days)"
        )
    
    async def start(self) -> None:
        """
        Start the key rotation scheduler.
        
        The scheduler runs in the background and checks for key rotation
        at regular intervals. If a key is older than the configured rotation
        interval, it will be automatically rotated.
        """
        if not self.config.key_rotation_enabled:
            logger.info("Key rotation is disabled, scheduler will not start")
            return
        
        if self.running:
            logger.warning("Key rotation scheduler is already running")
            return
        
        self.running = True
        self._task = asyncio.create_task(self._rotation_loop())
        logger.info("Key rotation scheduler started")
    
    async def stop(self) -> None:
        """
        Stop the key rotation scheduler.
        
        Cancels the background task and waits for it to complete.
        """
        if not self.running:
            logger.warning("Key rotation scheduler is not running")
            return
        
        self.running = False
        
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        
        logger.info("Key rotation scheduler stopped")
    
    async def _rotation_loop(self) -> None:
        """
        Background loop that checks for key rotation.
        
        Runs continuously while the scheduler is active, checking for
        key rotation at regular intervals (daily).
        """
        while self.running:
            try:
                # Check if key needs rotation
                if await self._should_rotate_key():
                    logger.info("Key rotation required, performing rotation...")
                    await self._perform_rotation()
                else:
                    logger.debug("Key rotation not required")
                
                # Sleep for 24 hours before next check
                await asyncio.sleep(86400)  # 24 hours
                
            except asyncio.CancelledError:
                logger.info("Key rotation loop cancelled")
                break
            except Exception as e:
                logger.error(f"Error in key rotation loop: {e}", exc_info=True)
                # Sleep for 1 hour before retrying
                await asyncio.sleep(3600)
    
    async def _should_rotate_key(self) -> bool:
        """
        Check if key should be rotated based on age.
        
        Returns:
            True if key should be rotated, False otherwise
        """
        key_path = Path(self.config.private_key_path).expanduser()
        
        # Check if key exists
        if not key_path.exists():
            logger.warning(f"Private key not found: {key_path}")
            return False
        
        # Get key file modification time
        key_mtime = datetime.fromtimestamp(key_path.stat().st_mtime)
        key_age = datetime.now() - key_mtime
        
        # Check if key is older than rotation interval
        rotation_interval = timedelta(days=self.config.key_rotation_days)
        
        if key_age >= rotation_interval:
            logger.info(
                f"Key is {key_age.days} days old, rotation interval is "
                f"{self.config.key_rotation_days} days"
            )
            return True
        
        logger.debug(
            f"Key is {key_age.days} days old, rotation not required "
            f"(interval: {self.config.key_rotation_days} days)"
        )
        return False
    
    async def _perform_rotation(self) -> None:
        """
        Perform key rotation.
        
        Generates a new key pair and backs up the old key.
        """
        old_key_path = Path(self.config.private_key_path).expanduser()
        
        # Generate new key paths with timestamp
        timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
        new_key_path = old_key_path.parent / f"{old_key_path.stem}.new_{timestamp}{old_key_path.suffix}"
        new_public_key_path = old_key_path.parent / f"{old_key_path.stem}.new_{timestamp}.pub"
        
        try:
            # Rotate key
            self.key_manager.rotate_key(
                str(old_key_path),
                str(new_key_path),
                str(new_public_key_path),
                passphrase=self.config.key_encryption_passphrase,
                backup_old_key=True,
            )
            
            # Rename new key to replace old key
            new_key_path.rename(old_key_path)
            
            # Update public key path
            public_key_path = old_key_path.parent / f"{old_key_path.stem}.pub"
            new_public_key_path.rename(public_key_path)
            
            logger.info(f"Key rotation completed successfully: {old_key_path}")
            
        except Exception as e:
            logger.error(f"Key rotation failed: {e}", exc_info=True)
            raise
    
    async def force_rotation(self) -> None:
        """
        Force immediate key rotation regardless of age.
        
        This method can be called manually to rotate keys on demand.
        """
        logger.info("Forcing immediate key rotation")
        await self._perform_rotation()


async def start_key_rotation_scheduler(
    config: MerkleConfig,
    audit_log_path: Optional[str] = None,
) -> KeyRotationScheduler:
    """
    Convenience function to start key rotation scheduler.
    
    Args:
        config: Merkle configuration with rotation settings
        audit_log_path: Optional path to audit log file
    
    Returns:
        KeyRotationScheduler instance
    
    Example:
        >>> from caracal.merkle.key_rotation_scheduler import start_key_rotation_scheduler
        >>> from caracal.config.settings import load_config
        >>> 
        >>> config = load_config()
        >>> scheduler = await start_key_rotation_scheduler(
        ...     config.merkle,
        ...     audit_log_path="/var/log/caracal/key_operations.log"
        ... )
    """
    scheduler = KeyRotationScheduler(config, audit_log_path=audit_log_path)
    await scheduler.start()
    return scheduler
