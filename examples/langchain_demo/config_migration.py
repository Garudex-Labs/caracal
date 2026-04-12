"""
Configuration Migration Utilities

Provides utilities for migrating configuration files between versions,
ensuring backward compatibility and smooth upgrades.
"""

import json
import shutil
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional


@dataclass
class MigrationResult:
    """Result of a configuration migration."""
    success: bool
    version_from: str
    version_to: str
    changes_made: List[str]
    warnings: List[str]
    errors: List[str]
    backup_path: Optional[Path] = None


class ConfigMigration:
    """Base class for configuration migrations."""
    
    from_version: str
    to_version: str
    
    def migrate(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """
        Migrate configuration from one version to another.
        
        Args:
            config: Configuration dictionary to migrate
            
        Returns:
            Migrated configuration dictionary
        """
        raise NotImplementedError
    
    def get_changes(self) -> List[str]:
        """
        Get list of changes made by this migration.
        
        Returns:
            List of change descriptions
        """
        raise NotImplementedError


class MigrationV1ToV2(ConfigMigration):
    """
    Migration from v1 (basic config) to v2 (enhanced config).
    
    Adds new configuration sections:
    - scenario
    - ui
    - logging
    - mock_system
    - agent
    """
    
    from_version = "1.0"
    to_version = "2.0"
    
    def migrate(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """Migrate v1 config to v2."""
        migrated = config.copy()
        
        # Add scenario section if missing
        if "scenario" not in migrated:
            migrated["scenario"] = {
                "default_scenario": "default",
                "scenarios_path": None,
                "auto_load": True
            }
        
        # Add ui section if missing
        if "ui" not in migrated:
            migrated["ui"] = {
                "host": "127.0.0.1",
                "port": 8000,
                "enable_websocket": True,
                "websocket_ping_interval": 30,
                "max_message_history": 1000,
                "enable_logs_panel": True,
                "enable_tool_panel": True,
                "enable_caracal_panel": True
            }
        
        # Add logging section if missing
        if "logging" not in migrated:
            migrated["logging"] = {
                "level": "INFO",
                "format": "detailed",
                "log_to_file": False,
                "log_file_path": None,
                "max_file_size_mb": 10,
                "backup_count": 3
            }
        
        # Add mock_system section if missing
        if "mock_system" not in migrated:
            migrated["mock_system"] = {
                "enabled": True,
                "config_path": None,
                "cache_responses": True,
                "simulate_delays": True,
                "default_llm_provider": "openai"
            }
        
        # Add agent section if missing
        if "agent" not in migrated:
            migrated["agent"] = {
                "max_iterations": 10,
                "timeout_seconds": 300,
                "enable_sub_agents": True,
                "max_delegation_depth": 3
            }
        
        # Add version marker
        migrated["_config_version"] = self.to_version
        
        return migrated
    
    def get_changes(self) -> List[str]:
        """Get list of changes made by this migration."""
        return [
            "Added 'scenario' section with default scenario configuration",
            "Added 'ui' section with web interface settings",
            "Added 'logging' section with logging configuration",
            "Added 'mock_system' section with mock system settings",
            "Added 'agent' section with agent behavior configuration",
            "Added '_config_version' field to track configuration version"
        ]


class ConfigMigrator:
    """
    Manages configuration migrations between versions.
    
    Provides utilities to:
    - Detect configuration version
    - Apply migrations sequentially
    - Create backups before migration
    - Validate migrated configuration
    """
    
    # Registry of available migrations
    MIGRATIONS: List[ConfigMigration] = [
        MigrationV1ToV2()
    ]
    
    @staticmethod
    def detect_version(config: Dict[str, Any]) -> str:
        """
        Detect the version of a configuration.
        
        Args:
            config: Configuration dictionary
            
        Returns:
            Version string (e.g., "1.0", "2.0")
        """
        # Check for explicit version marker
        if "_config_version" in config:
            return config["_config_version"]
        
        # Detect version based on structure
        # v2 has scenario, ui, logging, mock_system, agent sections
        v2_sections = {"scenario", "ui", "logging", "mock_system", "agent"}
        if any(section in config for section in v2_sections):
            return "2.0"
        
        # Default to v1
        return "1.0"
    
    @staticmethod
    def get_latest_version() -> str:
        """
        Get the latest configuration version.
        
        Returns:
            Latest version string
        """
        if not ConfigMigrator.MIGRATIONS:
            return "1.0"
        return ConfigMigrator.MIGRATIONS[-1].to_version
    
    @staticmethod
    def needs_migration(config: Dict[str, Any]) -> bool:
        """
        Check if a configuration needs migration.
        
        Args:
            config: Configuration dictionary
            
        Returns:
            True if migration is needed
        """
        current_version = ConfigMigrator.detect_version(config)
        latest_version = ConfigMigrator.get_latest_version()
        return current_version != latest_version
    
    @staticmethod
    def create_backup(config_path: Path) -> Path:
        """
        Create a backup of a configuration file.
        
        Args:
            config_path: Path to configuration file
            
        Returns:
            Path to backup file
        """
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_path = config_path.parent / f"{config_path.stem}.backup.{timestamp}{config_path.suffix}"
        shutil.copy2(config_path, backup_path)
        return backup_path
    
    @staticmethod
    def migrate_config(
        config: Dict[str, Any],
        target_version: Optional[str] = None
    ) -> MigrationResult:
        """
        Migrate a configuration to a target version.
        
        Args:
            config: Configuration dictionary to migrate
            target_version: Target version (latest if None)
            
        Returns:
            MigrationResult with migration details
        """
        current_version = ConfigMigrator.detect_version(config)
        target_version = target_version or ConfigMigrator.get_latest_version()
        
        if current_version == target_version:
            return MigrationResult(
                success=True,
                version_from=current_version,
                version_to=target_version,
                changes_made=[],
                warnings=["Configuration is already at target version"],
                errors=[]
            )
        
        # Find applicable migrations
        applicable_migrations = []
        for migration in ConfigMigrator.MIGRATIONS:
            if migration.from_version == current_version:
                applicable_migrations.append(migration)
                current_version = migration.to_version
                if current_version == target_version:
                    break
        
        if not applicable_migrations:
            return MigrationResult(
                success=False,
                version_from=ConfigMigrator.detect_version(config),
                version_to=target_version,
                changes_made=[],
                warnings=[],
                errors=[f"No migration path found from {ConfigMigrator.detect_version(config)} to {target_version}"]
            )
        
        # Apply migrations sequentially
        migrated_config = config.copy()
        all_changes = []
        warnings = []
        
        try:
            for migration in applicable_migrations:
                migrated_config = migration.migrate(migrated_config)
                all_changes.extend(migration.get_changes())
        except Exception as e:
            return MigrationResult(
                success=False,
                version_from=ConfigMigrator.detect_version(config),
                version_to=target_version,
                changes_made=all_changes,
                warnings=warnings,
                errors=[f"Migration failed: {e}"]
            )
        
        return MigrationResult(
            success=True,
            version_from=ConfigMigrator.detect_version(config),
            version_to=target_version,
            changes_made=all_changes,
            warnings=warnings,
            errors=[]
        )
    
    @staticmethod
    def migrate_file(
        config_path: Path,
        target_version: Optional[str] = None,
        create_backup: bool = True,
        in_place: bool = True
    ) -> MigrationResult:
        """
        Migrate a configuration file.
        
        Args:
            config_path: Path to configuration file
            target_version: Target version (latest if None)
            create_backup: Whether to create a backup before migration
            in_place: Whether to update the file in place
            
        Returns:
            MigrationResult with migration details
        """
        if not config_path.exists():
            return MigrationResult(
                success=False,
                version_from="unknown",
                version_to=target_version or "unknown",
                changes_made=[],
                warnings=[],
                errors=[f"Configuration file not found: {config_path}"]
            )
        
        # Load configuration
        try:
            with open(config_path, 'r', encoding='utf-8') as f:
                config = json.load(f)
        except json.JSONDecodeError as e:
            return MigrationResult(
                success=False,
                version_from="unknown",
                version_to=target_version or "unknown",
                changes_made=[],
                warnings=[],
                errors=[f"Invalid JSON in configuration file: {e}"]
            )
        except IOError as e:
            return MigrationResult(
                success=False,
                version_from="unknown",
                version_to=target_version or "unknown",
                changes_made=[],
                warnings=[],
                errors=[f"Failed to read configuration file: {e}"]
            )
        
        # Create backup if requested
        backup_path = None
        if create_backup:
            try:
                backup_path = ConfigMigrator.create_backup(config_path)
            except Exception as e:
                return MigrationResult(
                    success=False,
                    version_from=ConfigMigrator.detect_version(config),
                    version_to=target_version or "unknown",
                    changes_made=[],
                    warnings=[],
                    errors=[f"Failed to create backup: {e}"],
                    backup_path=None
                )
        
        # Migrate configuration
        result = ConfigMigrator.migrate_config(config, target_version)
        result.backup_path = backup_path
        
        if not result.success:
            return result
        
        # Write migrated configuration if in_place
        if in_place:
            try:
                migrated_config = ConfigMigrator.migrate_config(config, target_version)
                if migrated_config.success:
                    # Get the migrated config from the result
                    final_config = config.copy()
                    for migration in ConfigMigrator.MIGRATIONS:
                        if migration.from_version == ConfigMigrator.detect_version(final_config):
                            final_config = migration.migrate(final_config)
                            if ConfigMigrator.detect_version(final_config) == result.version_to:
                                break
                    
                    with open(config_path, 'w', encoding='utf-8') as f:
                        json.dump(final_config, f, indent=2, ensure_ascii=False)
                        f.write('\n')  # Add trailing newline
            except Exception as e:
                result.success = False
                result.errors.append(f"Failed to write migrated configuration: {e}")
        
        return result


def migrate_config_interactive(config_path: Path) -> None:
    """
    Interactively migrate a configuration file with user prompts.
    
    Args:
        config_path: Path to configuration file
    """
    print(f"Configuration Migration Tool")
    print(f"=" * 50)
    print(f"Config file: {config_path}")
    print()
    
    if not config_path.exists():
        print(f"Error: Configuration file not found: {config_path}")
        return
    
    # Load and detect version
    try:
        with open(config_path, 'r', encoding='utf-8') as f:
            config = json.load(f)
    except Exception as e:
        print(f"Error: Failed to load configuration: {e}")
        return
    
    current_version = ConfigMigrator.detect_version(config)
    latest_version = ConfigMigrator.get_latest_version()
    
    print(f"Current version: {current_version}")
    print(f"Latest version: {latest_version}")
    print()
    
    if current_version == latest_version:
        print("Configuration is already at the latest version.")
        return
    
    print("Migration is available.")
    print()
    
    # Show what will change
    result = ConfigMigrator.migrate_config(config, latest_version)
    if result.changes_made:
        print("Changes that will be made:")
        for i, change in enumerate(result.changes_made, 1):
            print(f"  {i}. {change}")
        print()
    
    # Confirm migration
    response = input("Proceed with migration? (y/n): ").strip().lower()
    if response != 'y':
        print("Migration cancelled.")
        return
    
    # Perform migration
    print()
    print("Migrating configuration...")
    result = ConfigMigrator.migrate_file(
        config_path,
        target_version=latest_version,
        create_backup=True,
        in_place=True
    )
    
    if result.success:
        print(f"✓ Migration successful!")
        print(f"  Version: {result.version_from} → {result.version_to}")
        if result.backup_path:
            print(f"  Backup: {result.backup_path}")
        print()
        print("Changes made:")
        for change in result.changes_made:
            print(f"  • {change}")
    else:
        print(f"✗ Migration failed!")
        for error in result.errors:
            print(f"  Error: {error}")
        if result.backup_path:
            print(f"  Backup available at: {result.backup_path}")


if __name__ == "__main__":
    import sys
    
    if len(sys.argv) > 1:
        config_path = Path(sys.argv[1])
    else:
        # Use default config path
        from runtime_config import resolve_config_path
        config_path = resolve_config_path()
    
    migrate_config_interactive(config_path)
