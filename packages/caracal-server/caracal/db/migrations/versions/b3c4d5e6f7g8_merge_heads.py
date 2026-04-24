"""Merge divergent heads: main chain and sync_state branch.

Revision ID: b3c4d5e6f7g8
Revises: a1b2c3d4e5f6, 59649602ab02
Create Date: 2026-04-23 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'b3c4d5e6f7g8'
down_revision: Union[str, Sequence[str], None] = ('a1b2c3d4e5f6', '59649602ab02')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
