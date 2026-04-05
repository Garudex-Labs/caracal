#!/usr/bin/env python3
"""Capture migration-safety baseline data for hard-cut execution.

The output includes:
- database connectivity and schema metadata
- existence and row counts for impacted tables
- rollback asset availability (backup/restore scripts)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError


DEFAULT_IMPACTED_TABLES: tuple[str, ...] = (
    "sync_operations",
    "sync_conflicts",
    "sync_metadata",
    "principal_key_custody",
    "principal_key_custody_local",
    "principal_key_custody_awskms",
)

SAFE_TABLE_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


@dataclass(frozen=True)
class RollbackAsset:
    name: str
    path: Path


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _default_output_path() -> Path:
    return _repo_root() / ".github" / "hardcut" / "migration-safety-baseline.json"


def _resolve_database_url(explicit_url: str | None) -> tuple[str | None, str]:
    if explicit_url:
        return explicit_url, "--database-url"

    env_order = (
        "DATABASE_URL",
        "CARACAL_DATABASE_URL",
    )
    for key in env_order:
        value = (os.getenv(key) or "").strip()
        if value:
            return value, key
    return None, "none"


def _validate_table_name(name: str) -> str:
    if not SAFE_TABLE_NAME_RE.match(name):
        raise ValueError(f"Invalid table name: {name!r}")
    return name


def _query_scalar(engine: Engine, sql: str, params: dict[str, Any] | None = None) -> Any:
    with engine.connect() as conn:
        result = conn.execute(text(sql), params or {})
        return result.scalar()


def _fetch_schema_metadata(engine: Engine) -> dict[str, Any]:
    metadata: dict[str, Any] = {}
    metadata["database_name"] = _query_scalar(engine, "SELECT current_database()")
    metadata["server_version"] = _query_scalar(engine, "SELECT version()")

    alembic_table_exists = bool(
        _query_scalar(
            engine,
            """
            SELECT EXISTS (
                SELECT 1
                FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'alembic_version'
            )
            """,
        )
    )
    metadata["alembic_version_table_exists"] = alembic_table_exists
    metadata["alembic_head"] = (
        _query_scalar(engine, "SELECT version_num FROM alembic_version LIMIT 1")
        if alembic_table_exists
        else None
    )
    metadata["public_table_count"] = int(
        _query_scalar(
            engine,
            """
            SELECT COUNT(*)
            FROM information_schema.tables
            WHERE table_schema = 'public'
            """,
        )
        or 0
    )
    return metadata


def _fetch_table_baseline(engine: Engine, table_names: list[str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with engine.connect() as conn:
        for table_name in table_names:
            safe_name = _validate_table_name(table_name)
            exists = bool(
                conn.execute(
                    text(
                        """
                        SELECT EXISTS (
                            SELECT 1
                            FROM information_schema.tables
                            WHERE table_schema = 'public' AND table_name = :table_name
                        )
                        """
                    ),
                    {"table_name": safe_name},
                ).scalar()
            )

            row_count: int | None = None
            if exists:
                row_count = int(conn.execute(text(f"SELECT COUNT(*) FROM public.{safe_name}")).scalar() or 0)

            rows.append(
                {
                    "table": safe_name,
                    "exists": exists,
                    "row_count": row_count,
                }
            )
    return rows


def _rollback_assets() -> list[RollbackAsset]:
    root = _repo_root()
    return [
        RollbackAsset("backup_script", root / "scripts" / "backup-postgresql.sh"),
        RollbackAsset("restore_script", root / "scripts" / "restore-postgresql.sh"),
    ]


def _rollback_asset_report() -> dict[str, Any]:
    report: dict[str, Any] = {}
    for asset in _rollback_assets():
        report[asset.name] = {
            "path": str(asset.path),
            "exists": asset.path.exists(),
            "is_executable": os.access(asset.path, os.X_OK) if asset.path.exists() else False,
        }
    report["all_assets_present"] = all(item["exists"] for item in report.values() if isinstance(item, dict))
    return report


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--database-url",
        default=None,
        help="PostgreSQL URL. Defaults to DATABASE_URL or CARACAL_DATABASE_URL.",
    )
    parser.add_argument(
        "--table",
        action="append",
        default=None,
        help="Impacted table name to include. Can be provided multiple times.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=_default_output_path(),
        help="Output path for migration safety baseline JSON.",
    )
    parser.add_argument(
        "--allow-missing-db",
        action="store_true",
        help="Write report even if DB URL is missing or unreachable.",
    )
    return parser.parse_args(argv)


def _build_report_base(db_source: str, table_names: list[str]) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "database_url_source": db_source,
        "database": {
            "connected": False,
            "error": None,
            "metadata": {},
        },
        "impacted_tables": [
            {
                "table": table,
                "exists": None,
                "row_count": None,
            }
            for table in table_names
        ],
        "rollback_assets": _rollback_asset_report(),
    }


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    table_names = args.table if args.table else list(DEFAULT_IMPACTED_TABLES)
    table_names = [_validate_table_name(name) for name in table_names]

    db_url, db_source = _resolve_database_url(args.database_url)
    report = _build_report_base(db_source=db_source, table_names=table_names)

    if not db_url:
        report["database"]["error"] = "No PostgreSQL URL provided."
        if not args.allow_missing_db:
            print("No PostgreSQL URL found. Set DATABASE_URL/CARACAL_DATABASE_URL or pass --database-url.", file=sys.stderr)
            return 2
    else:
        try:
            engine = create_engine(db_url, pool_pre_ping=True)
            report["database"]["metadata"] = _fetch_schema_metadata(engine)
            report["impacted_tables"] = _fetch_table_baseline(engine, table_names)
            report["database"]["connected"] = True
        except (SQLAlchemyError, OSError, ValueError) as exc:
            report["database"]["error"] = str(exc)
            if not args.allow_missing_db:
                print(f"Database baseline capture failed: {exc}", file=sys.stderr)
                return 3

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    print(f"Migration safety baseline written to {args.output}")
    print(
        "Database connected: "
        f"{report['database']['connected']} | "
        f"Rollback assets present: {report['rollback_assets']['all_assets_present']}"
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
