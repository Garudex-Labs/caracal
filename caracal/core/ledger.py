"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

PostgreSQL-backed ledger management for Caracal Core.
"""

from dataclasses import asdict, dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional
from uuid import UUID

from caracal.db.models import LedgerEvent as LedgerEventModel
from caracal.exceptions import InvalidLedgerEventError, LedgerReadError, LedgerWriteError
from caracal.logging_config import get_logger

logger = get_logger(__name__)


@dataclass
class LedgerEvent:
    event_id: int
    principal_id: str
    timestamp: str
    resource_type: str
    quantity: str
    metadata: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        data = asdict(self)
        if data.get("metadata") is None:
            data.pop("metadata", None)
        return data

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "LedgerEvent":
        return cls(**data)


class LedgerWriter:
    """Append-only ledger writer backed by PostgreSQL ledger_events."""

    def __init__(self, session, backup_count: int = 3):
        self.session = session
        self.backup_count = backup_count

    def append_event(
        self,
        principal_id: str,
        resource_type: str,
        quantity: Decimal,
        metadata: Optional[Dict[str, Any]] = None,
        timestamp: Optional[datetime] = None,
    ) -> LedgerEvent:
        if not principal_id:
            raise InvalidLedgerEventError("principal_id cannot be empty")
        if not resource_type:
            raise InvalidLedgerEventError("resource_type cannot be empty")
        if quantity < 0:
            raise InvalidLedgerEventError(f"quantity must be non-negative, got {quantity}")

        try:
            principal_uuid = UUID(str(principal_id))
        except ValueError as exc:
            raise InvalidLedgerEventError(f"Invalid principal_id UUID: {principal_id}") from exc

        ts = timestamp or datetime.utcnow()
        row = LedgerEventModel(
            principal_id=principal_uuid,
            timestamp=ts,
            resource_type=resource_type,
            quantity=quantity,
            event_metadata=metadata,
        )

        try:
            self.session.add(row)
            self.session.flush()
            self.session.commit()
            return LedgerEvent(
                event_id=row.event_id,
                principal_id=str(row.principal_id),
                timestamp=row.timestamp.isoformat() + "Z",
                resource_type=row.resource_type,
                quantity=str(row.quantity),
                metadata=row.event_metadata,
            )
        except Exception as exc:
            self.session.rollback()
            logger.error("Failed to append event to PostgreSQL ledger", exc_info=True)
            raise LedgerWriteError(f"Failed to append event to PostgreSQL ledger: {exc}") from exc


class LedgerQuery:
    """Query facade over PostgreSQL ledger_events."""

    def __init__(self, session):
        self.session = session

    @staticmethod
    def _as_uuid(value: Optional[str]) -> Optional[UUID]:
        if not value:
            return None
        try:
            return UUID(value)
        except ValueError:
            return None

    def get_events(
        self,
        principal_id: Optional[str] = None,
        start_time: Optional[datetime] = None,
        end_time: Optional[datetime] = None,
        resource_type: Optional[str] = None,
    ) -> List[LedgerEvent]:
        try:
            query = self.session.query(LedgerEventModel)
            principal_uuid = self._as_uuid(principal_id)
            if principal_uuid:
                query = query.filter(LedgerEventModel.principal_id == principal_uuid)
            if start_time:
                query = query.filter(LedgerEventModel.timestamp >= start_time)
            if end_time:
                query = query.filter(LedgerEventModel.timestamp <= end_time)
            if resource_type:
                query = query.filter(LedgerEventModel.resource_type.ilike(f"%{resource_type}%"))

            rows = query.order_by(LedgerEventModel.event_id.asc()).all()
            return [
                LedgerEvent(
                    event_id=row.event_id,
                    principal_id=str(row.principal_id),
                    timestamp=row.timestamp.isoformat() + "Z",
                    resource_type=row.resource_type,
                    quantity=str(row.quantity),
                    metadata=row.event_metadata,
                )
                for row in rows
            ]
        except Exception as exc:
            raise LedgerReadError(f"Failed to query PostgreSQL ledger: {exc}") from exc

    def sum_usage(self, principal_id: str, start_time: Optional[datetime], end_time: Optional[datetime]) -> Decimal:
        events = self.get_events(principal_id=principal_id, start_time=start_time, end_time=end_time)
        total = Decimal("0")
        for event in events:
            total += Decimal(event.quantity)
        return total

    def aggregate_by_principal(self, start_time: datetime, end_time: datetime) -> Dict[str, Decimal]:
        events = self.get_events(start_time=start_time, end_time=end_time)
        totals: Dict[str, Decimal] = {}
        for event in events:
            totals[event.principal_id] = totals.get(event.principal_id, Decimal("0")) + Decimal(event.quantity)
        return totals

    def sum_usage_with_children(
        self,
        principal_id: str,
        start_time: datetime,
        end_time: datetime,
        principal_registry=None,
    ) -> Dict[str, Decimal]:
        # Delegation tree traversal has moved to SQL graph tables.
        return {principal_id: self.sum_usage(principal_id, start_time, end_time)}

    def get_usage_breakdown(
        self,
        principal_id: str,
        start_time: datetime,
        end_time: datetime,
        principal_registry=None,
    ) -> Dict[str, Any]:
        own_usage = self.sum_usage(principal_id, start_time, end_time)
        return {
            "principal_id": principal_id,
            "principal_name": principal_id,
            "usage": str(own_usage),
            "children": [],
            "total_with_children": str(own_usage),
        }
