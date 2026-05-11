"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

sap-erp REST router: queue/job-based posting with backpressure.
"""
from _mock.rest.routers.job_provider import build

router = build(
    "sap-erp",
    prefix="sap/opu/odata/sap",
    sync_actions=["get_vendor_record"],
    job_actions=[("match_invoice", "sap.match.completed"),
                 ("post_payment_confirmation", "sap.payment.confirmed")],
    write_actions=["match_invoice", "post_payment_confirmation"],
)
