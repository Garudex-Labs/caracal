"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Domain types for the Lynx Capital financial execution system.
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import Literal

from pydantic import BaseModel


class Rail(str, Enum):
    ACH = "ACH"
    WIRE = "WIRE"
    SEPA = "SEPA"
    SWIFT = "SWIFT"
    NEFT = "NEFT"
    RTGS = "RTGS"
    PAYNOW = "PAYNOW"
    PIX = "PIX"


class Region(BaseModel):
    id: str
    name: str
    currency: str
    rails: list[Rail]


class Vendor(BaseModel):
    id: str
    name: str
    region: str
    currency: str
    category: str
    preferred_rails: list[Rail]
    payment_terms_days: int
    max_fee_pct: float
    bank_account: str


class Invoice(BaseModel):
    id: str
    vendor_id: str
    region: str
    currency: str
    amount_local: Decimal
    amount_usd: Decimal
    issued_date: date
    due_date: date
    description: str
    status: Literal["pending", "matched", "approved", "routed", "paid", "excepted"]


class PayoutPlan(BaseModel):
    id: str
    run_id: str
    region: str
    vendor_id: str
    invoice_ids: list[str]
    rail: Rail
    amount_local: Decimal
    amount_usd: Decimal
    fee_pct: float
    scheduled_at: datetime


class PaymentTicket(BaseModel):
    id: str
    run_id: str
    invoice_id: str
    vendor_id: str
    region: str
    amount_local: Decimal
    currency: str
    amount_usd: Decimal
    rail: Rail
    window_start: datetime
    window_end: datetime
    status: Literal["pending", "submitted", "posted", "failed", "denied"]


class LedgerEntry(BaseModel):
    id: str
    invoice_id: str
    vendor_id: str
    erp_ref: str
    erp_amount: Decimal
    currency: str
    matched: bool
    variance: Decimal
    matched_at: datetime | None = None


class PolicyDecision(BaseModel):
    invoice_id: str
    passed: bool
    checks: list[str]
    failures: list[str]
    flags: list[str]
