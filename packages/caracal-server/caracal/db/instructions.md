---
description: Apply when adding, editing, or reviewing database models, migrations, or connection management.
applyTo: packages/caracal-server/caracal/db/**
---

## Purpose
PostgreSQL ORM models, Alembic migrations, and connection pool management.

## Rules
- All ORM models are SQLAlchemy `DeclarativeBase` subclasses defined in `models.py`.
- Connection management lives in `connection.py` only; no direct engine creation elsewhere.
- Every schema change requires a new Alembic migration in `migrations/versions/`.
- Migration files are auto-generated with `alembic revision --autogenerate`; never hand-edit column definitions.
- UUID primary keys for all tables except ledger event tables (BIGSERIAL).

## Constraints
- Forbidden: SQLite or in-memory backends in production paths.
- Forbidden: raw SQL strings outside migration files.
- Forbidden: adding new tables without a corresponding migration.
- File names in `migrations/versions/`: auto-generated Alembic format only.
- Model class names: `PascalCase` matching the table concept (e.g., `Principal`, `ExecutionMandate`).

## Imports
- Models import from `sqlalchemy` and `caracal.exceptions` only.
- `connection.py` imports from `caracal.config.settings`; never from `core/` or `cli/`.

## Error Handling
- Connection failures raise `DatabaseConnectionError` from `caracal.exceptions`.
- Schema version mismatches raise `SchemaMigrationError` on startup.
- Never suppress `sqlalchemy.exc` exceptions; wrap and re-raise as typed errors.
