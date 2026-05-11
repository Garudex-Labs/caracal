"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

vendor-portal MCP-shaped server: minimal JSON-RPC 2.0 over framed TCP.
Mirrors the tool-discovery and tool-call shape of the MCP wire protocol so
client code can target an MCP transport without pulling the full SDK.
"""
from __future__ import annotations

import asyncio
import json
import os
import struct

from _mock import cases
from _mock.faults import evaluate
from _mock.faults.engine import profile_for


TOOLS = [
    {
        "name": "vendor.get_profile",
        "description": "Fetch a vendor profile by id from the vendor portal.",
        "inputSchema": {"type": "object", "properties": {"vendor_id": {"type": "string"}}, "required": ["vendor_id"]},
        "_action": "get_vendor_profile",
    },
    {
        "name": "vendor.get_contract_terms",
        "description": "Return contract pricing/terms for a vendor.",
        "inputSchema": {"type": "object", "properties": {"vendor_id": {"type": "string"}}, "required": ["vendor_id"]},
        "_action": "get_contract_terms",
    },
    {
        "name": "vendor.register",
        "description": "Register a new vendor in the portal.",
        "inputSchema": {"type": "object"},
        "_action": "register_vendor",
    },
]
_ACTION_BY_NAME = {t["name"]: t["_action"] for t in TOOLS}


async def _read_message(reader: asyncio.StreamReader) -> dict | None:
    header = await reader.readexactly(4)
    (length,) = struct.unpack(">I", header)
    body = await reader.readexactly(length)
    return json.loads(body.decode())


async def _write_message(writer: asyncio.StreamWriter, msg: dict) -> None:
    body = json.dumps(msg).encode()
    writer.write(struct.pack(">I", len(body)) + body)
    await writer.drain()


def _result(req_id, result) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def _error(req_id, code: int, message: str, data=None) -> dict:
    err = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    return {"jsonrpc": "2.0", "id": req_id, "error": err}


async def _handle(req: dict) -> dict:
    req_id = req.get("id")
    method = req.get("method")
    params = req.get("params") or {}

    if method == "initialize":
        return _result(req_id, {"protocolVersion": "0.1", "serverInfo": {"name": "vendor-portal.mock", "version": "0.1.0"}})
    if method == "tools/list":
        return _result(req_id, {"tools": [
            {k: v for k, v in t.items() if not k.startswith("_")} for t in TOOLS
        ]})
    if method == "tools/call":
        name = params.get("name")
        args = params.get("arguments") or {}
        action = _ACTION_BY_NAME.get(name)
        if action is None:
            return _error(req_id, -32601, f"unknown tool: {name}")
        token = (params.get("auth") or {}).get("token") or args.get("_auth_token")
        if not token:
            return _error(req_id, 401, "missing auth token")
        decision = evaluate("vendor-portal", action, args, attempt=0, api_key=token)
        if decision.delay_s:
            await asyncio.sleep(decision.delay_s)
        if decision.rate_limited:
            return _error(req_id, 429, f"rate limited; retry in {decision.retry_after_s}s")
        if decision.error_status:
            return _error(req_id, decision.error_status,
                          decision.error_body.get("error", "error"),
                          data=decision.error_body)
        result = cases.resolve("vendor-portal", action, args)
        return _result(req_id, {"content": [{"type": "json", "data": result}]})

    return _error(req_id, -32601, f"unknown method: {method}")


async def _client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while True:
            try:
                req = await _read_message(reader)
            except asyncio.IncompleteReadError:
                return
            if req is None:
                return
            resp = await _handle(req)
            await _write_message(writer, resp)
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass


async def serve(host: str = "0.0.0.0", port: int = 7800) -> None:
    profile_for("vendor-portal")
    server = await asyncio.start_server(_client, host, port)
    print(f"[mock] vendor-portal MCP listening on {host}:{port}", flush=True)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(serve(os.getenv("LYNX_MCP_HOST", "0.0.0.0"), int(os.getenv("LYNX_MCP_PORT", "7800"))))
