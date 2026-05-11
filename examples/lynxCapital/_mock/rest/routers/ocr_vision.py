"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

ocr-vision: 202 + webhook callback when extraction completes.
"""
from _mock.rest.routers.job_provider import build

router = build(
    "ocr-vision",
    prefix="v1/documents",
    sync_actions=[],
    job_actions=[("extract_invoice", "ocr.extract.completed")],
    write_actions=["extract_invoice"],
)
