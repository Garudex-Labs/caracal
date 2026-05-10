"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

compliance-nexus watchlist delta stream over gRPC server-streaming.
"""
from __future__ import annotations

import asyncio
import os
import time
from hashlib import sha256

import grpc

from _mock.faults.engine import profile_for
from _mock.grpc.compliance_stream import compliance_pb2 as pb2
from _mock.grpc.compliance_stream import compliance_pb2_grpc as pb2_grpc


_COUNTRIES = ["IR", "KP", "RU", "SY", "VE", "MM", "CU"]
_REASONS = ["sanctions_match", "pep_update", "watchlist_added", "watchlist_removed"]


def _delta(cursor: int, lists: list[str]) -> pb2.WatchlistDelta:
    h = sha256(f"{cursor}|{','.join(lists)}".encode()).hexdigest()
    return pb2.WatchlistDelta(
        cursor=str(cursor),
        list_name=lists[int(h[:2], 16) % len(lists)],
        action="upsert" if int(h[2], 16) % 2 == 0 else "remove",
        entity_id=f"ENT-{h[3:11].upper()}",
        country=_COUNTRIES[int(h[11:13], 16) % len(_COUNTRIES)],
        reason=_REASONS[int(h[13], 16) % len(_REASONS)],
        ts=str(time.time()),
    )


class ComplianceFeed(pb2_grpc.ComplianceFeedServicer):
    async def StreamWatchlistDeltas(self, request, context):
        profile = profile_for("compliance-nexus")
        header = profile["auth"]["header"].lower()
        token = dict(context.invocation_metadata() or []).get(header, "")
        if not token:
            await context.abort(grpc.StatusCode.UNAUTHENTICATED, "missing token")
        cursor = int(request.cursor) if request.cursor.isdigit() else 0
        lists = list(request.lists) or ["OFAC", "UN", "EU"]
        while True:
            if context.cancelled():
                return
            yield _delta(cursor, lists)
            cursor += 1
            await asyncio.sleep(0.5)


async def serve(addr: str = "0.0.0.0:50052") -> None:
    server = grpc.aio.server()
    pb2_grpc.add_ComplianceFeedServicer_to_server(ComplianceFeed(), server)
    server.add_insecure_port(addr)
    await server.start()
    print(f"[mock] compliance-nexus stream gRPC on {addr}", flush=True)
    await server.wait_for_termination()


if __name__ == "__main__":
    asyncio.run(serve(os.getenv("LYNX_GRPC_COMPLIANCE_ADDR", "0.0.0.0:50052")))
