"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

LLM-driven orchestration: Finance Control and regional orchestrators each run
their own ChatOpenAI loop. All agent spawns and tool calls are downstream of
real LLM decisions. No scripted flows, no precomputed graphs.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from uuid import uuid4

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI

from app.agents import tools as tool_fns
from app.agents.runner import AgentHandle, AgentRunner, create_runner
from app.config import get_config
from app.core.dataset import INVOICES, REGIONS, VENDORS
from app.events import types as ev
from app.events.bus import bus

log = logging.getLogger("lynx.swarm")
log.setLevel(logging.INFO)
if not log.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("[%(asctime)s] %(name)s %(levelname)s %(message)s"))
    log.addHandler(_h)


REGION_IDS = ("US", "IN", "DE", "SG", "BR")


FC_SYSTEM_PROMPT = """You are the Finance Control agent for Lynx Capital, an autonomous financial execution platform.

You coordinate weekly payout cycles across five regions: US, IN, DE, SG, BR.

When the user gives you a task:
1. Decide which regions are relevant based on what they asked.
   - "run the weekly cycle" / "all regions" -> dispatch all five
   - a specific region mentioned -> dispatch only that one
   - multiple specific regions -> dispatch each one
2. For each selected region, call the dispatch_region tool with the region code and a short focus sentence.
3. When every region you chose is done, give a final one-paragraph summary of what was processed.

Be concise. Write like an operator. No emojis. No marketing language."""


REGIONAL_SYSTEM_TEMPLATE = """You are the Regional Orchestrator agent for the {region} region ({region_name}, currency {currency}) at Lynx Capital.

Your job right now: process a small batch of pending invoices end-to-end. Focus: {focus}

You have concrete tools. Every tool call you make executes a real operation against a downstream service and spawns a dedicated worker agent to handle it. Use the tools; do not simulate work in text.

Recommended procedure (you may adapt if something looks wrong):
1. Call list_pending_invoices to see what needs processing (keep the batch small: 2-3 invoices).
2. For each invoice:
   a. extract_invoice_data(invoice_id)
   b. match_invoice_in_ledger(invoice_id, vendor_id, amount, currency)
   c. check_vendor_compliance(vendor_id)
   d. submit_payment(vendor_id, amount, currency, rail, reference)
3. Once per region: lookup_withholding_rate(currency); and if the currency is not USD also lookup_fx_rate("USD", currency).
4. Finally: record_audit(summary) with a one-line summary string.
5. Return a short natural-language status when you are done. Do NOT call any more tools after the audit.

Be concise in any commentary. No emojis."""


def _make_llm(cfg):
    """Factory for a streaming ChatOpenAI. Swapped out by tests via monkeypatch."""
    return ChatOpenAI(
        model=cfg.llm.model,
        temperature=cfg.llm.temperature,
        streaming=True,
        stream_usage=True,
    )


async def _stream_assistant(
    run_id: str,
    agent_id: str,
    model_name: str,
    llm,
    messages: list,
) -> AIMessage:
    """Invoke the LLM, stream tokens into the chat event stream, emit an
    llm_call telemetry event, and return the accumulated AIMessage."""
    message_id = str(uuid4())
    t0 = time.time()
    full: AIMessage | None = None
    streamed_chars = 0

    async for chunk in llm.astream(messages):
        if chunk.content:
            text = str(chunk.content)
            streamed_chars += len(text)
            bus.publish(ev.chat_token(run_id, agent_id, message_id, text))
        full = chunk if full is None else full + chunk

    latency_ms = int((time.time() - t0) * 1000)
    text = full.content if full and isinstance(full.content, str) else ""
    tool_calls = list(getattr(full, "tool_calls", []) or [])
    usage = getattr(full, "usage_metadata", None) or {}
    input_tokens = int(usage.get("input_tokens", 0))
    output_tokens = int(usage.get("output_tokens", 0))

    bus.publish(ev.chat_message(run_id, agent_id, message_id, text))
    bus.publish(ev.llm_call(
        run_id=run_id,
        agent_id=agent_id,
        model=model_name,
        latency_ms=latency_ms,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        tool_calls=len(tool_calls),
        streamed_chars=streamed_chars,
    ))
    log.info(
        "llm_call agent=%s model=%s latency_ms=%d in_tok=%d out_tok=%d tool_calls=%d chars=%d",
        agent_id[:8], model_name, latency_ms, input_tokens, output_tokens,
        len(tool_calls), streamed_chars,
    )

    return AIMessage(content=text, tool_calls=tool_calls)


def _build_regional_tools(
    run_id: str,
    runner: AgentRunner,
    parent: AgentHandle,
    region: str,
):
    """Build the LangChain tool set available to a regional orchestrator.

    Each action tool dynamically spawns a worker agent, runs the real
    downstream tool_fn (which emits tool_call + service_call + service_result +
    tool_result events), and terminates the worker. The number and kind of
    workers spawned depends entirely on what the LLM decides to call.
    """
    region_invoices = [inv for inv in INVOICES if inv.region == region]
    region_vendors = {v.id: v for v in VENDORS.values() if v.region == region}

    def _worker(role: str, scope: str) -> AgentHandle:
        w = runner.spawn(role=role, scope=scope, parent=parent, layer=role, region=region)
        w.start()
        return w

    def _finish(w: AgentHandle, result: dict) -> None:
        w.end(result)
        w.terminate("completed")

    @tool
    def list_pending_invoices(limit: int = 3) -> str:
        """Return up to `limit` pending invoices in this region as JSON: invoice_id, vendor_id, amount, currency, preferred_rail."""
        out = []
        for inv in region_invoices[:max(1, min(limit, 5))]:
            v = region_vendors.get(inv.vendor_id)
            rail = v.preferred_rails[0].value if v and v.preferred_rails else "WIRE"
            out.append({
                "invoice_id": inv.id,
                "vendor_id": inv.vendor_id,
                "amount": float(inv.amount_local),
                "currency": inv.currency,
                "preferred_rail": rail,
            })
        return json.dumps(out)

    @tool
    def extract_invoice_data(invoice_id: str) -> str:
        """OCR-extract invoice data from a document. Spawns an invoice-intake worker."""
        w = _worker("invoice-intake", f"extract:{invoice_id}")
        try:
            result = tool_fns.extract_invoice(run_id, w.id, invoice_id, f"doc-{invoice_id}")
            return json.dumps(result)
        finally:
            _finish(w, {"invoice_id": invoice_id})

    @tool
    def match_invoice_in_ledger(invoice_id: str, vendor_id: str, amount: float, currency: str) -> str:
        """Match an invoice against the ledger. Spawns a ledger-match worker."""
        w = _worker("ledger-match", f"match:{invoice_id}")
        try:
            result = tool_fns.netsuite_match_invoice(run_id, w.id, vendor_id, invoice_id, float(amount), currency)
            return json.dumps(result)
        finally:
            _finish(w, {"invoice_id": invoice_id})

    @tool
    def check_vendor_compliance(vendor_id: str) -> str:
        """Run compliance screening on a vendor. Spawns a policy-check worker."""
        w = _worker("policy-check", f"compliance:{vendor_id}")
        try:
            result = tool_fns.check_vendor(run_id, w.id, vendor_id)
            return json.dumps(result)
        finally:
            _finish(w, {"vendor_id": vendor_id})

    @tool
    def lookup_fx_rate(from_currency: str, to_currency: str) -> str:
        """Look up an FX rate. Spawns a route-optimization worker."""
        w = _worker("route-optimization", f"fx:{from_currency}->{to_currency}")
        try:
            result = tool_fns.get_fx_rate(run_id, w.id, from_currency, to_currency)
            return json.dumps(result)
        finally:
            _finish(w, {"from": from_currency, "to": to_currency})

    @tool
    def lookup_withholding_rate(currency: str) -> str:
        """Look up the withholding tax rate for this region + currency. Spawns a route-optimization worker."""
        w = _worker("route-optimization", f"withholding:{region}:{currency}")
        try:
            result = tool_fns.get_withholding_rate(run_id, w.id, region, currency)
            return json.dumps(result)
        finally:
            _finish(w, {"currency": currency})

    @tool
    def submit_payment(vendor_id: str, amount: float, currency: str, rail: str, reference: str) -> str:
        """Submit a payment to the banking provider. Spawns a payment-execution worker."""
        w = _worker("payment-execution", f"payment:{reference}")
        try:
            result = tool_fns.submit_payment(run_id, w.id, vendor_id, float(amount), currency, rail, reference)
            return json.dumps(result)
        finally:
            _finish(w, {"reference": reference})

    @tool
    def record_audit(summary: str) -> str:
        """Record a final audit entry for this region. Spawns an audit worker."""
        w = _worker("audit", f"audit:{region}")
        record = {"region": region, "summary": summary}
        try:
            bus.publish(ev.audit_record(run_id, w.id, record))
            return json.dumps({"ok": True})
        finally:
            _finish(w, record)

    return [
        list_pending_invoices,
        extract_invoice_data,
        match_invoice_in_ledger,
        check_vendor_compliance,
        lookup_fx_rate,
        lookup_withholding_rate,
        submit_payment,
        record_audit,
    ]


async def _run_regional_orchestrator(
    run_id: str,
    runner: AgentRunner,
    parent: AgentHandle,
    region: str,
    focus: str,
) -> dict:
    cfg = get_config()
    region_meta = REGIONS.get(region)
    if region_meta is None:
        raise ValueError(f"Unknown region {region!r}")

    ro = runner.spawn(
        role="regional-orchestrator",
        scope=f"region:{region}",
        parent=parent,
        layer="regional-orchestrator",
        region=region,
    )
    ro.start()

    tools = _build_regional_tools(run_id, runner, ro, region)
    tool_map = {t.name: t for t in tools}

    llm = _make_llm(cfg)
    llm_with_tools = llm.bind_tools(tools)

    system_prompt = REGIONAL_SYSTEM_TEMPLATE.format(
        region=region,
        region_name=region_meta.name,
        currency=region_meta.currency,
        focus=focus or "process the pending batch end-to-end",
    )
    messages = [
        SystemMessage(content=system_prompt),
        HumanMessage(content=f"Begin processing the {region} batch now."),
    ]

    tool_call_count = 0
    turns = 0
    for _turn in range(12):
        turns += 1
        ai_msg = await _stream_assistant(run_id, ro.id, cfg.llm.model, llm_with_tools, messages)
        messages.append(ai_msg)
        if not ai_msg.tool_calls:
            break
        for tc in ai_msg.tool_calls:
            name = tc["name"]
            args = tc["args"]
            fn = tool_map.get(name)
            if fn is None:
                messages.append(ToolMessage(content=f"Unknown tool: {name}", tool_call_id=tc["id"]))
                continue
            result = await asyncio.to_thread(fn.invoke, args)
            tool_call_count += 1
            messages.append(ToolMessage(content=str(result), tool_call_id=tc["id"]))

    result = {"region": region, "toolCalls": tool_call_count, "turns": turns}
    ro.end(result)
    ro.terminate("completed")
    return result


def _build_top_tools(
    run_id: str,
    runner: AgentRunner,
    fc: AgentHandle,
    loop: asyncio.AbstractEventLoop,
):
    @tool
    def dispatch_region(region: str, focus: str = "") -> str:
        """Dispatch a regional orchestrator to process one region. region must be one of: US, IN, DE, SG, BR. `focus` is a short sentence describing the intent for this dispatch."""
        r = region.upper().strip()
        if r not in REGION_IDS:
            return json.dumps({"error": f"unknown region {region!r}"})
        future = asyncio.run_coroutine_threadsafe(
            _run_regional_orchestrator(run_id, runner, fc, r, focus or ""),
            loop,
        )
        return json.dumps(future.result())

    return [dispatch_region]


async def run_swarm(run_id: str, prompt: str) -> None:
    cfg = get_config()
    bus.publish(ev.run_start(run_id, prompt))
    bus.publish(ev.chat_user(run_id, prompt))
    log.info("run_swarm start run_id=%s prompt=%r", run_id, prompt[:120])

    runner = create_runner(run_id, cfg.swarm.llmBackedCap)
    fc = runner.spawn(
        role="finance-control", scope="global", parent=None,
        layer="finance-control", region=None,
    )
    fc.start()

    loop = asyncio.get_running_loop()
    tools = _build_top_tools(run_id, runner, fc, loop)
    tool_map = {t.name: t for t in tools}
    llm = _make_llm(cfg)
    llm_with_tools = llm.bind_tools(tools)

    messages = [
        SystemMessage(content=FC_SYSTEM_PROMPT),
        HumanMessage(content=prompt),
    ]

    try:
        for _turn in range(10):
            ai_msg = await _stream_assistant(run_id, fc.id, cfg.llm.model, llm_with_tools, messages)
            messages.append(ai_msg)
            if not ai_msg.tool_calls:
                break
            for tc in ai_msg.tool_calls:
                name = tc["name"]
                args = tc["args"]
                fn = tool_map.get(name)
                if fn is None:
                    messages.append(ToolMessage(content=f"Unknown tool: {name}", tool_call_id=tc["id"]))
                    continue
                bus.publish(ev.tool_call(run_id, fc.id, name, args))
                result = await asyncio.to_thread(fn.invoke, args)
                bus.publish(ev.tool_result(run_id, fc.id, name, {"result": result}))
                messages.append(ToolMessage(content=str(result), tool_call_id=tc["id"]))

        fc.end({"status": "completed"})
        fc.terminate("completed")
        bus.publish(ev.run_end(run_id, "completed"))
        log.info("run_swarm end run_id=%s status=completed", run_id)
    except Exception as exc:
        log.exception("run_swarm failed run_id=%s", run_id)
        bus.publish(ev.error(run_id, str(exc), fc.id))
        if not fc._terminated:
            fc.terminate("failed")
        bus.publish(ev.run_end(run_id, "failed"))
