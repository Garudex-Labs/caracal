"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Database management commands for Caracal Core.

Provides CLI commands for database initialization, migrations, and status checks.

"""

import logging
import sys
from pathlib import Path

import click
from alembic import command
from alembic.config import Config
from sqlalchemy import text

from caracal.cli.context import pass_context
from caracal.db import (
    Base,
    DatabaseConfig,
    DatabaseConnectionManager,
    SchemaVersionManager,
)

logger = logging.getLogger(__name__)


def get_database_config_from_context(ctx) -> DatabaseConfig:
    """
    Extract database configuration from CLI context.
    
    Args:
        ctx: CLI context with loaded configuration
    
    Returns:
        DatabaseConfig instance
    
    Raises:
        click.ClickException: If database configuration is missing or invalid
    """
    if not hasattr(ctx.config, 'database'):
        raise click.ClickException(
            "Database configuration not found in config file. "
            "Please add a 'database' section with connection details."
        )
    
    db_config = ctx.config.database
    
    # Extract configuration with defaults
    return DatabaseConfig(
        type=getattr(db_config, 'type', 'postgres'),
        host=getattr(db_config, 'host', 'localhost'),
        port=getattr(db_config, 'port', 5432),
        database=getattr(db_config, 'database', 'caracal'),
        user=getattr(db_config, 'user', 'caracal'),
        password=getattr(db_config, 'password', ''),
        file_path=getattr(db_config, 'file_path', ''),
        pool_size=getattr(db_config, 'pool_size', 10),
        max_overflow=getattr(db_config, 'max_overflow', 5),
        pool_timeout=getattr(db_config, 'pool_timeout', 30),
        pool_recycle=getattr(db_config, 'pool_recycle', 3600),
        echo=getattr(db_config, 'echo', False),
    )


def get_alembic_config() -> Config:
    """
    Get Alembic configuration.
    
    Returns:
        Alembic Config instance
    """
    # Look for alembic.ini in the Caracal package directory
    alembic_ini_path = Path(__file__).parent.parent.parent / "alembic.ini"
    
    if not alembic_ini_path.exists():
        raise click.ClickException(
            f"Alembic configuration not found at {alembic_ini_path}. "
            "Please ensure alembic.ini exists in the Caracal root directory."
        )
    
    return Config(str(alembic_ini_path))


@click.command(name='init-db')
@pass_context
def init_db(ctx):
    """
    Initialize the database schema.
    
    Creates all tables defined in SQLAlchemy models if they don't exist.
    This is equivalent to running all migrations to create the initial schema.
    
    """
    try:
        click.echo("Initializing database schema...")
        
        # Get database configuration
        db_config = get_database_config_from_context(ctx)
        
        # Create connection manager
        db_manager = DatabaseConnectionManager(db_config)
        db_manager.initialize()
        
        # Check database connectivity
        if not db_manager.health_check():
            raise click.ClickException(
                f"Cannot connect to database at {db_config.host}:{db_config.port}. "
                "Please ensure PostgreSQL is running and credentials are correct."
            )
        
        click.echo(f"✓ Connected to database: {db_config.database}")
        
        # Create all tables using SQLAlchemy
        Base.metadata.create_all(db_manager._engine)
        
        click.echo("✓ Database tables created successfully")
        
        # Initialize Alembic version table
        alembic_config = get_alembic_config()
        
        # Override database URL in alembic config
        alembic_config.set_main_option(
            "sqlalchemy.url",
            db_config.get_connection_url()
        )
        
        # Stamp the database with the current head revision
        command.stamp(alembic_config, "head")
        
        click.echo("✓ Alembic version table initialized")
        
        # Display schema info
        schema_manager = SchemaVersionManager(db_manager._engine, str(alembic_config.config_file_name))
        schema_info = schema_manager.get_schema_info()
        
        click.echo("\nDatabase schema initialized successfully!")
        click.echo(f"  Current revision: {schema_info['current_revision']}")
        click.echo(f"  Head revision: {schema_info['head_revision']}")
        
        # Close connection
        db_manager.close()
        
    except click.ClickException:
        raise
    except Exception as e:
        logger.error(f"Failed to initialize database: {e}", exc_info=True)
        raise click.ClickException(f"Database initialization failed: {e}")


@click.command(name='migrate')
@click.argument('direction', type=click.Choice(['up', 'down'], case_sensitive=False))
@click.option(
    '--revision',
    '-r',
    default=None,
    help='Target revision (default: head for up, -1 for down)',
)
@click.option(
    '--sql',
    is_flag=True,
    help='Generate SQL instead of executing migrations',
)
@pass_context
def migrate(ctx, direction: str, revision: str, sql: bool):
    """
    Run database migrations.
    
    DIRECTION: 'up' to apply migrations, 'down' to rollback migrations
    
    Examples:
        caracal db migrate up              # Apply all pending migrations
        caracal db migrate up -r abc123    # Migrate to specific revision
        caracal db migrate down            # Rollback one migration
        caracal db migrate down -r base    # Rollback all migrations
        caracal db migrate up --sql        # Generate SQL without executing
    
    """
    try:
        # Get database configuration
        db_config = get_database_config_from_context(ctx)
        
        # Get Alembic configuration
        alembic_config = get_alembic_config()
        
        # Override database URL in alembic config
        alembic_config.set_main_option(
            "sqlalchemy.url",
            db_config.get_connection_url()
        )
        
        # Determine target revision
        if direction.lower() == 'up':
            target = revision if revision else 'head'
            action = "Applying"
        else:  # down
            target = revision if revision else '-1'
            action = "Rolling back"
        
        if sql:
            click.echo(f"Generating SQL for migration to {target}...")
            if direction.lower() == 'up':
                command.upgrade(alembic_config, target, sql=True)
            else:
                command.downgrade(alembic_config, target, sql=True)
        else:
            click.echo(f"{action} migrations to {target}...")
            
            # Create connection manager to check connectivity
            db_manager = DatabaseConnectionManager(db_config)
            db_manager.initialize()
            
            if not db_manager.health_check():
                raise click.ClickException(
                    f"Cannot connect to database at {db_config.host}:{db_config.port}"
                )
            
            # Get current schema info before migration
            schema_manager = SchemaVersionManager(db_manager._engine, str(alembic_config.config_file_name))
            before_info = schema_manager.get_schema_info()
            
            click.echo(f"  Current revision: {before_info['current_revision']}")
            
            # Run migration
            if direction.lower() == 'up':
                command.upgrade(alembic_config, target)
            else:
                command.downgrade(alembic_config, target)
            
            # Get schema info after migration
            after_info = schema_manager.get_schema_info()
            
            click.echo(f"✓ Migration completed successfully")
            click.echo(f"  New revision: {after_info['current_revision']}")
            
            if after_info['pending_migrations']:
                click.echo(f"\n⚠ {len(after_info['pending_migrations'])} pending migration(s) remaining")
            else:
                click.echo("\n✓ Database schema is up to date")
            
            # Close connection
            db_manager.close()
        
    except click.ClickException:
        raise
    except Exception as e:
        logger.error(f"Migration failed: {e}", exc_info=True)
        raise click.ClickException(f"Migration failed: {e}")


@click.command(name='status')
@click.option(
    '--verbose',
    '-v',
    is_flag=True,
    help='Show detailed migration history',
)
@pass_context
def db_status(ctx, verbose: bool):
    """
    Show database schema status.
    
    Displays current schema version, pending migrations, and database connectivity.
    
    """
    try:
        # Get database configuration
        db_config = get_database_config_from_context(ctx)
        
        click.echo("Database Status")
        click.echo("=" * 60)
        
        # Display connection info
        click.echo(f"\nConnection:")
        click.echo(f"  Host: {db_config.host}:{db_config.port}")
        click.echo(f"  Database: {db_config.database}")
        click.echo(f"  User: {db_config.user}")
        
        # Create connection manager
        db_manager = DatabaseConnectionManager(db_config)
        db_manager.initialize()
        
        # Check connectivity
        is_healthy = db_manager.health_check()
        status_icon = "✓" if is_healthy else "✗"
        status_text = "Connected" if is_healthy else "Disconnected"
        click.echo(f"  Status: {status_icon} {status_text}")
        
        if not is_healthy:
            click.echo("\n⚠ Cannot connect to database. Please check connection settings.")
            db_manager.close()
            sys.exit(1)
        
        # Get pool status
        pool_status = db_manager.get_pool_status()
        click.echo(f"\nConnection Pool:")
        click.echo(f"  Pool size: {pool_status['size']}")
        click.echo(f"  Checked in: {pool_status['checked_in']}")
        click.echo(f"  Checked out: {pool_status['checked_out']}")
        click.echo(f"  Overflow: {pool_status['overflow']}")
        
        # Get Alembic configuration
        alembic_config = get_alembic_config()
        
        # Override database URL
        alembic_config.set_main_option(
            "sqlalchemy.url",
            db_config.get_connection_url()
        )
        
        # Get schema version info
        schema_manager = SchemaVersionManager(db_manager._engine, str(alembic_config.config_file_name))
        schema_info = schema_manager.get_schema_info()
        
        click.echo(f"\nSchema Version:")
        click.echo(f"  Current: {schema_info['current_revision'] or 'None (no migrations applied)'}")
        click.echo(f"  Head: {schema_info['head_revision']}")
        
        if schema_info['is_up_to_date']:
            click.echo(f"  Status: ✓ Up to date")
        else:
            click.echo(f"  Status: ⚠ Outdated ({len(schema_info['pending_migrations'])} pending)")
        
        # Show pending migrations
        if schema_info['pending_migrations']:
            click.echo(f"\nPending Migrations:")
            for rev in schema_info['pending_migrations']:
                click.echo(f"  - {rev}")
            click.echo(f"\nRun 'caracal db migrate up' to apply pending migrations.")
        
        # Show migration history if verbose
        if verbose:
            click.echo(f"\nMigration History:")
            try:
                # Get migration history from Alembic
                from alembic.script import ScriptDirectory
                script = ScriptDirectory.from_config(alembic_config)
                
                # Get all revisions
                for rev in script.walk_revisions():
                    is_current = rev.revision == schema_info['current_revision']
                    marker = "→" if is_current else " "
                    click.echo(f"  {marker} {rev.revision[:12]} - {rev.doc}")
                    
            except Exception as e:
                click.echo(f"  Error retrieving migration history: {e}")
        
        # Check table existence
        click.echo(f"\nDatabase Tables:")
        try:
            with db_manager._engine.connect() as conn:
                result = conn.execute(text("""
                    SELECT table_name 
                    FROM information_schema.tables 
                    WHERE table_schema = 'public' 
                    ORDER BY table_name
                """))
                tables = [row[0] for row in result]
                
                if tables:
                    for table in tables:
                        click.echo(f"  ✓ {table}")
                else:
                    click.echo("  No tables found. Run 'caracal db init-db' to create schema.")
        except Exception as e:
            click.echo(f"  Error checking tables: {e}")
        
        # Close connection
        db_manager.close()
        
    except click.ClickException:
        raise
    except Exception as e:
        logger.error(f"Failed to get database status: {e}", exc_info=True)
        raise click.ClickException(f"Failed to get database status: {e}")
