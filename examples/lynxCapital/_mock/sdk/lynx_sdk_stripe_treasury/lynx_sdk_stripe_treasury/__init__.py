"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Internal Stripe Treasury SDK shim. Wraps the REST surface and provides
idempotency, bearer auth, and typed return objects.
"""
from .client import StripeTreasuryClient, OutboundPayment, FinancialAccount, StripeError

__all__ = ["StripeTreasuryClient", "OutboundPayment", "FinancialAccount", "StripeError"]
