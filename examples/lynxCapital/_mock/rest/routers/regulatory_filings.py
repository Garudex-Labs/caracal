"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

regulatory-filings: webhook-only ack; submission returns 202 and result arrives via hook.
"""
from _mock.rest.routers.job_provider import build

router = build(
    "regulatory-filings",
    prefix="v1/regulatory",
    sync_actions=[],
    job_actions=[
        ("aml_monitor_transaction",     "regulatory.aml.evaluated"),
        ("sanctions_screen_batch",      "regulatory.sanctions.completed"),
        ("prepare_regulatory_filing",   "regulatory.filing.prepared"),
        ("attest_control",              "regulatory.control.attested"),
    ],
    write_actions=["sanctions_screen_batch", "prepare_regulatory_filing", "attest_control"],
)
