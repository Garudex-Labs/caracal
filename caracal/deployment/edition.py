"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Edition management for Caracal deployment architecture.

Handles detection and management of editions (Open Source vs Enterprise).
"""

import os
import toml
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Optional, Union
import structlog

from caracal.deployment.exceptions import (
    InvalidEditionError,
    EditionConfigurationError,
    EditionDetectionError,
)
from caracal.storage.layout import resolve_caracal_home

logger = structlog.get_logger(__name__)


class Edition(str, Enum):
    """Edition enumeration."""
    OPENSOURCE = "opensource"
    ENTERPRISE = "enterprise"

    @property
    def is_enterprise(self) -> bool:
        """Return True when edition is enterprise."""
        return self == Edition.ENTERPRISE

    @property
    def is_opensource(self) -> bool:
        """Return True when edition is open source."""
        return self == Edition.OPENSOURCE


class EditionManager:
    """
    Manages edition detection and configuration.
    
    Provides methods to detect, set, and query the current edition.
    Auto-detects edition based on available components.
    
    Edition detection follows a fallback chain:
    1. Configuration file (~/.caracal/config.toml)
    2. Auto-detection based on available components
    3. Default edition (OPENSOURCE)
    
    The edition configuration is stored in ~/.caracal/config.toml and cached
    in memory to avoid repeated file I/O operations.
    """
    
    # Configuration directory and file paths
    CONFIG_DIR = resolve_caracal_home()
    CONFIG_FILE = CONFIG_DIR / "config.toml"
    
    # Default edition when no configuration is found
    DEFAULT_EDITION = Edition.OPENSOURCE
    
    def __init__(self):
        """Initialize the edition manager with cached edition detection."""
        self._cached_edition: Optional[Edition] = None
        self._cache_timestamp: Optional[datetime] = None
    
    def get_edition(self) -> Edition:
        """
        Returns current edition (OPENSOURCE or ENTERPRISE).
        
          Edition detection is policy-driven and auto-derived from runtime state:
          1. Enterprise connectivity indicators (gateway URL)
          2. Default edition (OPENSOURCE)
        
        The result is cached to avoid repeated file I/O.
        
        Returns:
            Current edition
            
        Raises:
            EditionDetectionError: If edition detection fails
        """
        # Return cached edition if available
        if self._cached_edition is not None:
            return self._cached_edition
        
        try:
            # Auto-detect based on connectivity and runtime indicators.
            edition = self._auto_detect_edition()
            self._assert_execution_exclusivity(edition)
            self._cached_edition = edition
            self._cache_timestamp = datetime.now()
            logger.debug(
                "edition_auto_detected",
                edition=edition.value
            )
            return edition
            
        except Exception as e:
            logger.error(
                "edition_detection_failed",
                error=str(e),
                error_type=type(e).__name__
            )
            raise EditionDetectionError(f"Failed to detect edition: {e}") from e
    
    def _auto_detect_edition(self) -> Edition:
        """
        Auto-detects edition based on available components.

        Detection logic:
        - If gateway URL is configured, assume Enterprise Edition
        - Otherwise, default to Open Source Edition

        Returns:
            Detected edition
        """
        # Check for gateway URL in configuration
        if self.CONFIG_FILE.exists():
            try:
                config = toml.load(self.CONFIG_FILE)
                gateway_url = config.get("edition", {}).get("gateway_url")
                if gateway_url:
                    logger.debug(
                        "edition_detected_gateway_url",
                        gateway_url=gateway_url
                    )
                    return Edition.ENTERPRISE
            except (toml.TomlDecodeError, OSError):
                pass

        # Check for enterprise connectivity environment variables.
        if os.environ.get("CARACAL_ENTERPRISE_URL") or os.environ.get("CARACAL_GATEWAY_URL"):
            logger.debug(
                "edition_detected_env_var",
                env_var="CARACAL_ENTERPRISE_URL"
            )
            return Edition.ENTERPRISE
        
        # Default to Open Source Edition
        logger.debug(
            "edition_using_default",
            edition=self.DEFAULT_EDITION.value,
            reason="no_enterprise_indicators"
        )
        return self.DEFAULT_EDITION

    def _resolve_gateway_url(self) -> Optional[str]:
        """Resolve effective gateway URL from config or environment."""
        return (
            self.get_gateway_url()
            or os.environ.get("CARACAL_ENTERPRISE_URL")
            or os.environ.get("CARACAL_GATEWAY_ENDPOINT")
            or os.environ.get("CARACAL_GATEWAY_URL")
        )

    def _has_local_provider_registry_entries(self) -> bool:
        """Return True when any workspace has local broker provider entries."""
        try:
            from caracal.deployment.config_manager import ConfigManager
            from caracal.provider.workspace import load_workspace_provider_registry

            cfg_mgr = ConfigManager()
            for workspace in cfg_mgr.list_workspaces():
                try:
                    providers = load_workspace_provider_registry(cfg_mgr, workspace)
                except Exception:
                    continue
                if providers:
                    return True
        except Exception:
            logger.debug("edition_provider_registry_detection_failed", exc_info=True)
        return False

    def _assert_execution_exclusivity(self, detected_edition: Edition) -> None:
        """Reject mixed broker+gateway execution indicators in hard-cut mode."""
        gateway_url = self._resolve_gateway_url()
        local_provider_registry_present = self._has_local_provider_registry_entries()

        if gateway_url and local_provider_registry_present:
            raise EditionConfigurationError(
                "Execution exclusivity violation: gateway URL and local provider registry are both configured. "
                "Use gateway-only enterprise execution or broker-only OSS execution, never both."
            )

        if detected_edition == Edition.ENTERPRISE and not gateway_url:
            raise EditionConfigurationError(
                "Enterprise execution requires a gateway URL (CARACAL_ENTERPRISE_URL/CARACAL_GATEWAY_ENDPOINT/CARACAL_GATEWAY_URL). "
                "Broker fallback is forbidden in hard-cut mode."
            )
    
    def set_edition(self, edition: Edition, gateway_url: Optional[str] = None, 
                    gateway_token: Optional[str] = None) -> None:
        """
        Sets edition and updates configuration.
        
        This method persists the edition to the configuration file and updates
        the in-memory cache.
        
        Args:
            edition: Edition to set
            gateway_url: Gateway URL (required for Enterprise Edition)
            gateway_token: Gateway JWT token (optional, for Enterprise Edition)
            
        Raises:
            InvalidEditionError: If edition is not a valid Edition enum value
            EditionConfigurationError: If configuration update fails or required
                                      parameters are missing
        """
        # Validate edition
        if not isinstance(edition, Edition):
            raise InvalidEditionError(
                f"Invalid edition: {edition}. Must be Edition.OPENSOURCE or Edition.ENTERPRISE"
            )
        
        # Validate Enterprise Edition requirements
        if edition == Edition.ENTERPRISE and not gateway_url:
            raise EditionConfigurationError(
                "Gateway URL is required for Enterprise Edition"
            )
        
        try:
            # Ensure configuration directory exists
            self.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
            
            # Set directory permissions to 0700 (owner read/write/execute only)
            self.CONFIG_DIR.chmod(0o700)
            
            # Load existing configuration or create new one
            config = {}
            if self.CONFIG_FILE.exists():
                try:
                    config = toml.load(self.CONFIG_FILE)
                except toml.TomlDecodeError as e:
                    logger.warning(
                        "config_file_corrupted",
                        config_file=str(self.CONFIG_FILE),
                        error=str(e),
                        action="creating_new_config"
                    )
                    config = {}
            
            # Update edition configuration
            if "edition" not in config:
                config["edition"] = {}
            
            config["edition"]["current"] = edition.value
            config["edition"]["updated_at"] = datetime.now().isoformat()
            
            # Store gateway configuration for Enterprise Edition
            if edition == Edition.ENTERPRISE:
                config["edition"]["gateway_url"] = gateway_url
                if gateway_token:
                    config["edition"]["gateway_token"] = gateway_token
            else:
                # Remove gateway configuration for Open Source Edition
                config["edition"].pop("gateway_url", None)
                config["edition"].pop("gateway_token", None)
            
            # Write configuration to file atomically
            # Write to temp file first, then rename for atomicity
            temp_file = self.CONFIG_FILE.with_suffix(".tmp")
            try:
                with open(temp_file, "w") as f:
                    toml.dump(config, f)
                
                # Set file permissions to 0600 (owner read/write only)
                temp_file.chmod(0o600)
                
                # Atomic rename
                temp_file.replace(self.CONFIG_FILE)
                
                # Update cache
                self._cached_edition = edition
                self._cache_timestamp = datetime.now()
                
                logger.info(
                    "edition_updated",
                    edition=edition.value,
                    config_file=str(self.CONFIG_FILE),
                    has_gateway_url=gateway_url is not None
                )
                
            finally:
                # Clean up temp file if it still exists
                if temp_file.exists():
                    temp_file.unlink()
                    
        except OSError as e:
            logger.error(
                "edition_configuration_failed",
                edition=edition.value,
                config_file=str(self.CONFIG_FILE),
                error=str(e)
            )
            raise EditionConfigurationError(
                f"Failed to update edition configuration: {e}"
            ) from e
    
    def is_enterprise(self) -> bool:
        """
        Returns True if enterprise edition.
        
        Returns:
            True if enterprise edition, False otherwise
        """
        return self.get_edition() == Edition.ENTERPRISE
    
    def is_opensource(self) -> bool:
        """
        Returns True if open-source edition.
        
        Returns:
            True if open-source edition, False otherwise
        """
        return self.get_edition() == Edition.OPENSOURCE
    
    def get_provider_client(self) -> Union["Broker", "GatewayClient"]:
        """
        Returns appropriate client (Broker or Gateway).
        
        Factory method that returns the appropriate provider client based on
        the current edition:
        - Open Source Edition: Returns Broker instance
        - Enterprise Edition: Returns GatewayClient instance
        
        Returns:
            Provider client instance (Broker or GatewayClient)
            
        Raises:
            EditionDetectionError: If edition detection fails
        """
        from caracal.deployment.broker import Broker
        from caracal.deployment.gateway_client import GatewayClient
        
        edition = self.get_edition()
        self._assert_execution_exclusivity(edition)
        
        if edition == Edition.ENTERPRISE:
            gateway_url = self._resolve_gateway_url()
            if not gateway_url:
                raise EditionConfigurationError(
                    "Enterprise URL is required for Enterprise provider client"
                )
            logger.debug(
                "provider_client_created",
                edition=edition.value,
                client_type="GatewayClient"
            )
            return GatewayClient(gateway_url=gateway_url)
        else:
            logger.debug(
                "provider_client_created",
                edition=edition.value,
                client_type="Broker"
            )
            return Broker()
    
    def get_gateway_url(self) -> Optional[str]:
        """
        Returns the configured gateway URL for Enterprise Edition.
        
        Returns:
            Gateway URL if configured, None otherwise
        """
        if self.CONFIG_FILE.exists():
            try:
                config = toml.load(self.CONFIG_FILE)
                return config.get("edition", {}).get("gateway_url")
            except (toml.TomlDecodeError, OSError) as e:
                logger.warning(
                    "failed_to_read_gateway_url",
                    config_file=str(self.CONFIG_FILE),
                    error=str(e)
                )
        return None
    
    def get_gateway_token(self) -> Optional[str]:
        """
        Returns the configured gateway JWT token for Enterprise Edition.
        
        Returns:
            Gateway token if configured, None otherwise
        """
        if self.CONFIG_FILE.exists():
            try:
                config = toml.load(self.CONFIG_FILE)
                return config.get("edition", {}).get("gateway_token")
            except (toml.TomlDecodeError, OSError) as e:
                logger.warning(
                    "failed_to_read_gateway_token",
                    config_file=str(self.CONFIG_FILE),
                    error=str(e)
                )
        return None
    
    def clear_cache(self) -> None:
        """
        Clears the cached edition detection result.
        
        This forces the next get_edition() call to re-detect the edition.
        Useful for testing or when configuration changes externally.
        """
        self._cached_edition = None
        self._cache_timestamp = None
        logger.debug("edition_cache_cleared")
