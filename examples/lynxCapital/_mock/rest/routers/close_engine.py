"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

close-engine: long batch jobs with progress webhooks.
"""
from _mock.rest.routers.job_provider import build

router = build(
    "close-engine",
    prefix="v1/close",
    sync_actions=[],
    job_actions=[
        ("post_journal_entry",  "close.journal.posted"),
        ("reconcile_account",   "close.reconcile.completed"),
        ("compute_accrual",     "close.accrual.computed"),
        ("close_period",        "close.period.completed"),
    ],
    write_actions=["post_journal_entry", "reconcile_account", "compute_accrual", "close_period"],
)
