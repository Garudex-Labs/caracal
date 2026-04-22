"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs


"""

from logging.config import fileConfig
import os
from pathlib import Path

from sqlalchemy import engine_from_config
from sqlalchemy import pool

from alembic import context

# Import our models for autogenerate support
from caracal.db.models import Base
from caracal.runtime.hardcut_preflight import assert_migration_hardcut
from caracal.storage.layout import resolve_caracal_home

# this is the Alembic Config object, which provides
# access to the values within the .ini file in use.
config = context.config

# Interpret the config file for Python logging.
# This line sets up loggers basically.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# add your model's MetaData object here
# for 'autogenerate' support
target_metadata = Base.metadata

# Support environment variable for database URL
# This allows overriding the alembic.ini setting
database_url = os.environ.get("CARACAL_DATABASE_URL")
if database_url:
    # Alembic's underlying ConfigParser treats '%' as interpolation markers.
    config.set_main_option("sqlalchemy.url", database_url.replace("%", "%%"))

_config_file_path = Path(config.config_file_name) if config.config_file_name else None
assert_migration_hardcut(
    database_urls={
        "CARACAL_DATABASE_URL": os.environ.get("CARACAL_DATABASE_URL"),
        "DATABASE_URL": os.environ.get("DATABASE_URL"),
        "sqlalchemy.url": config.get_main_option("sqlalchemy.url"),
    },
    config_paths=[_config_file_path] if _config_file_path is not None else None,
    env_vars=os.environ,
    state_roots=[resolve_caracal_home(require_explicit=False)],
)

# other values from the config, defined by the needs of env.py,
# can be acquired:
# my_important_option = config.get_main_option("my_important_option")
# ... etc.


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode.

    This configures the context with just a URL
    and not an Engine, though an Engine is acceptable
    here as well.  By skipping the Engine creation
    we don't even need a DBAPI to be available.

    Calls to context.execute() here emit the given string to the
    script output.

    """
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode.

    In this scenario we need to create an Engine
    and associate a connection with the context.

    """
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection, target_metadata=target_metadata
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
