"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tax-rules SDK shim. Caches rule snapshots locally and exposes withholding
and tax-id validation helpers.
"""
from .client import TaxClient, TaxError, WithholdingResult, TaxIdValidation

__all__ = ["TaxClient", "TaxError", "WithholdingResult", "TaxIdValidation"]
