"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Provider domain package whose imports register every provider's operations and seeders into the shared registries.
"""

from __future__ import annotations

from importlib import import_module

__all__ = [
    "aegis_screening",
    "atlas_vendor",
    "beacon_crm",
    "cordoba_fx",
    "core_billing",
    "halcyon_bank",
    "inkwell_ocr",
    "ironbark_erp",
    "junction_procure",
    "keystone_treasury",
    "lumen_identity",
    "meridian_pay",
    "pulse_market",
    "quetzal_payouts",
    "relay_automation",
    "sabre_tax",
    "slate_ledger",
    "tallyhall_books",
    "vela_notify",
    "verafin_monitor",
]

for module in __all__:
    import_module(f"{__name__}.{module}")
