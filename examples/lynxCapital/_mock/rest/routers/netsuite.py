"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

netsuite REST router: sync vendor reads, async match_invoice and payment status jobs.
"""
from _mock.rest.routers.job_provider import build

router = build(
    "netsuite",
    prefix="services/rest/v1",
    sync_actions=["get_vendor_record", "get_payment_status"],
    job_actions=[("match_invoice", "netsuite.match.completed")],
    write_actions=["match_invoice"],
)
