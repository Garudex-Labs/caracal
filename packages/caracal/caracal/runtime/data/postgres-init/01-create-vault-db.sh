#!/bin/bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Postgres init script that provisions a separate database for the Infisical vault sidecar.
# Runs once when the postgres data volume is first initialized.

set -e

VAULT_DB="${CARACAL_VAULT_DB_NAME:-caracal_vault}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE DATABASE "${VAULT_DB}";
    GRANT ALL PRIVILEGES ON DATABASE "${VAULT_DB}" TO "$POSTGRES_USER";
EOSQL
