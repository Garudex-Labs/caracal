"""add_sync_state_tables

Revision ID: 59649602ab02
Revises: 9bc013f8f3a6
Create Date: 2026-03-25 16:06:00.459408

"""
from typing import Sequence, Union



# revision identifiers, used by Alembic.
revision: str = '59649602ab02'
down_revision: Union[str, Sequence[str], None] = '9bc013f8f3a6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
