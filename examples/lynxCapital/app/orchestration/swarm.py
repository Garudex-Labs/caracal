"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

LLM-driven orchestration: streams Finance Control reasoning and spawns
regional sub-swarms only when the model decides to dispatch them.
"""
from __future__ import annotations

import asyncio
import json
from uuid import uuid4

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI

from app.agents import tools as tool_fns
from app.agents.runner import AgentHandle, AgentRunner, create_runner
from app.config import get_config
from app.core.dataset import INVOICES, VENDORS
from app.events import types as ev
from app.events.bus import bus


_WORKER_LAYERS = (
    ("invoice-intake", 3),
    ("ledger-match", 2),
    ("policy-check", 2),
    ("route-optimization", 1),
)


async def _run_region(run_id: str, runner: AgentRunner, parent: AgentHandle, region: str) -> dict:
    ro = runner.spawn(
        role="regional-orchestrator",
        scope=f"region:{region}",
        parent=parent,
        layer="regional-orchestrator",
        region=region,
    )
    ro.start()
    await asyncio.sleep(0.05)

    invoices = [inv for inv in INVOICES if inv.region == region]
    vendors = [v for v in VENDORS.values() if v.region == region]
    processed = 0
    matched = 0
    checked = 0

    for layer, count in _WORKER_LAYERS:
        for i in range(count):
            worker = runner.spawn(
                role=layer,
                scope=f"{layer}:{region}:{i}",
                parent=ro,
                layer=layer,
                region=region,
            )
            worker.start()
            await asyncio.sleep(0.04)

            if layer == "invoice-intake" and i < len(invoices):
                inv = invoices[i]
                tool_fns.extract_invoice(run_id, worker.id, inv.id, f"doc-{inv.id}")
                processed += 1
            elif layer == "ledger-match" and i < len(invoices):
                inv = invoices[i]
                tool_fns.netsuite_match_invoice(
                    run_id, worker.id, inv.vendor_id, inv.id,
                    float(inv.amount_usd), inv.currency,
                )
                matched += 1
            elif layer == "policy-check" and i < len(vendors):
                tool_fns.check_vendor(run_id, worker.id, vendors[i].id)
                checked += 1
            elif layer == "route-optimization":
                currency = invoices[0].currency if invoices else "USD"
                if currency != "USD":
                    tool_fns.get_fx_rate(run_id, worker.id, "USD", currency)
                tool_fns.get_withholding_rate(run_id, worker.id, region, currency)

            worker.end()
            worker.terminate("completed")
            await asyncio.sleep(0.02)

    for inv in invoices[:3]:
        vendor = VENDORS.get(inv.vendor_id)
        if not vendor:
            continue
        pay = runner.spawn(
            role="payment-execution",
            scope=f"payment:{region}:{inv.id}",
            parent=ro,
            layer="payment-execution",
            region=region,
        )
        pay.start()
        await asyncio.sleep(0.03)
        rail = vendor.preferred_rails[0].value if vendor.preferred_rails else "WIRE"
        tool_fns.submit_payment(
            run_id, pay.id, vendor.id,
            float(inv.amount_local), inv.currency, rail, f"ref-{inv.id}",
        )
        pay.end()
        pay.terminate("completed")
        await asyncio.sleep(0.02)

    audit = runner.spawn(
        role="audit", scope=f"audit:{region}", parent=ro,
        layer="audit", region=region,
    )
    audit.start()
    await asyncio.sleep(0.03)
    bus.publish(ev.audit_record(run_id, audit.id, {"region": region, "processed": processed}))
    audit.end()
    audit.terminate("completed")

    ro.end({"region": region, "processed": processed, "matched": matched, "checked": checked})
    ro.terminate("completed")

    return {
        "region": region,
        "invoicesProcessed": processed,
        "ledgerMatched": matched,
        "policyChecked": checked,
        "paymentsSubmitted": min(3, len(invoices)),
    }


SYSTEM_PROMPT = """You are the Finance Control agent for Lynx Capital, an autonomous financial execution layer.
You coordinate a global weekly payout cycle across five regions: US, IN, DE, SG, BR.
When the user asks you to run the cycle, dispatch each region individually using the dispatch_region tool.
Dispatch all five regions in sequence. Explain briefly what you are doing as you go.
After all regions complete, summarize the overall result: total invoices processed, total payments submitted, and any notable regional detail.
Be concise. Write like an operator, not a marketer. No emojis."""


def _make_llm(cfg):
    return ChatOpenAI(model=cfg.llm.model, temperature=cfg.llm.temperature, streaming=True)


def _build_tools(run_id: str, runner: AgentRunner, fc_handle: AgentHandle, loop: asyncio.AbstractEventLoop):
    @tool
    def dispatch_region(region: str) -> str:
        """Dispatch the payout sub-swarm for one region. region must be one of: US, IN, DE, SG, BR."""
        region = region.upper().strip()
        future = asyncio.run_coroutine_threadsafe(
            _run_region(run_id, runner, fc_handle, region), loop,
        )
        result = future.result()
        return json.dumps(result)

    return [dispatch_region]


async def _stream_assistant(run_id: str, fc_id: str, llm, messages: list) -> AIMessage:
    message_id = str(uuid4())
    full: AIMessage | None = None
    async for chunk in llm.astream(messages):
        if chunk.content:
            bus.publish(ev.chat_token(run_id, fc_id, message_id, str(chunk.content)))
        full = chunk if full is None else full + chunk
    text = full.content if full and isinstance(full.content, str) else ""
    bus.publish(ev.chat_message(run_id, fc_id, message_id, text))
    return AIMessage(
        content=text,
        tool_calls=list(getattr(full, "tool_calls", []) or []),
    )


async def run_swarm(run_id: str, prompt: str) -> None:
    cfg = get_config()
    bus.publish(ev.run_start(run_id, prompt))
    bus.publish(ev.chat_user(run_id, prompt))

    runner = create_runner(run_id, cfg.swarm.llmBackedCap)
    fc = runner.spawn(
        role="finance-control", scope="global", parent=None,
        layer="finance-control", region=None,
    )
    fc.start()

    loop = asyncio.get_running_loop()
    tools = _build_tools(run_id, runner, fc, loop)
    llm = _make_llm(cfg)
    llm_with_tools = llm.bind_tools(tools)
    tool_map = {t.name: t for t in tools}

    messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=prompt)]

    try:
        for _ in range(10):
            ai_msg = await _stream_assistant(run_id, fc.id, llm_with_tools, messages)
            messages.append(ai_msg)
            if not ai_msg.tool_calls:
                break
            for tc in ai_msg.tool_calls:
                name = tc["name"]
                args = tc["args"]
                bus.publish(ev.tool_call(run_id, fc.id, name, args))
                fn = tool_map[name]
                result = await asyncio.to_thread(fn.invoke, args)
                bus.publish(ev.tool_result(run_id, fc.id, name, {"result": result}))
                messages.append(ToolMessage(content=str(result), tool_call_id=tc["id"]))

        fc.end({"status": "completed"})
        fc.terminate("completed")
        bus.publish(ev.run_end(run_id, "completed"))
    except Exception as exc:
        bus.publish(ev.error(run_id, str(exc), fc.id))
        if not fc._terminated:
            fc.terminate("failed")
        bus.publish(ev.run_end(run_id, "failed"))
