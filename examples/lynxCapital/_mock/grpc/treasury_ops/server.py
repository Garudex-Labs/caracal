"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

treasury-ops gRPC mock server: deterministic responses backed by case files,
mirroring the latency/error/auth profile applied to REST providers.
"""
from __future__ import annotations

import asyncio
import json
import os

import grpc

from _mock import cases
from _mock.faults import evaluate
from _mock.faults.engine import profile_for
from _mock.grpc.treasury_ops import treasury_pb2 as pb2
from _mock.grpc.treasury_ops import treasury_pb2_grpc as pb2_grpc
from _mock.webhooks import deliver


_STATUS_MAP = {
    401: grpc.StatusCode.UNAUTHENTICATED,
    403: grpc.StatusCode.PERMISSION_DENIED,
    404: grpc.StatusCode.NOT_FOUND,
    409: grpc.StatusCode.ABORTED,
    429: grpc.StatusCode.RESOURCE_EXHAUSTED,
    500: grpc.StatusCode.INTERNAL,
    502: grpc.StatusCode.UNAVAILABLE,
    503: grpc.StatusCode.UNAVAILABLE,
    504: grpc.StatusCode.DEADLINE_EXCEEDED,
}


async def _apply_faults(action: str, payload: dict, context: grpc.aio.ServicerContext) -> str:
    profile = profile_for("treasury-ops")
    header = profile["auth"]["header"].lower()
    metadata = dict(context.invocation_metadata() or [])
    token = metadata.get(header, "")
    if not token:
        await context.abort(grpc.StatusCode.UNAUTHENTICATED, "missing token")
    decision = evaluate("treasury-ops", action, payload, attempt=0, api_key=token)
    if decision.delay_s:
        await asyncio.sleep(decision.delay_s)
    if decision.rate_limited:
        await context.abort(grpc.StatusCode.RESOURCE_EXHAUSTED,
                            f"rate limited; retry in {decision.retry_after_s}s")
    if decision.error_status:
        code = _STATUS_MAP.get(decision.error_status, grpc.StatusCode.UNKNOWN)
        await context.abort(code, json.dumps(decision.error_body))
    return token


class TreasuryOps(pb2_grpc.TreasuryOpsServicer):
    async def GetCashPosition(self, request, context):
        payload = {"entity_id": request.entity_id}
        await _apply_faults("get_cash_position", payload, context)
        return pb2.CashPositionResponse(json=json.dumps(cases.resolve("treasury-ops", "get_cash_position", payload)))

    async def ForecastLiquidity(self, request, context):
        payload = {"entity_id": request.entity_id, "horizon_days": request.horizon_days}
        await _apply_faults("forecast_liquidity", payload, context)
        return pb2.ForecastResponse(json=json.dumps(cases.resolve("treasury-ops", "forecast_liquidity", payload)))

    async def PlaceFxHedge(self, request, context):
        payload = {"pair": request.pair, "notional": request.notional, "tenor": request.tenor}
        await _apply_faults("place_fx_hedge", payload, context)
        result = cases.resolve("treasury-ops", "place_fx_hedge", payload)
        deliver("treasury-ops", "treasury.hedge.executed", result, delay_s=0.6)
        return pb2.FxHedgeResponse(json=json.dumps(result))

    async def TransferFunds(self, request, context):
        payload = {
            "from_account": request.from_account, "to_account": request.to_account,
            "amount": request.amount, "currency": request.currency,
            "idempotency_key": request.idempotency_key,
        }
        await _apply_faults("transfer_funds", payload, context)
        result = cases.resolve("treasury-ops", "transfer_funds", payload)
        deliver("treasury-ops", "treasury.transfer.completed", result, delay_s=0.4)
        return pb2.TransferResponse(json=json.dumps(result))


async def serve(addr: str = "0.0.0.0:50051") -> None:
    server = grpc.aio.server()
    pb2_grpc.add_TreasuryOpsServicer_to_server(TreasuryOps(), server)
    server.add_insecure_port(addr)
    await server.start()
    print(f"[mock] treasury-ops gRPC listening on {addr}", flush=True)
    await server.wait_for_termination()


if __name__ == "__main__":
    asyncio.run(serve(os.getenv("LYNX_GRPC_TREASURY_ADDR", "0.0.0.0:50051")))
