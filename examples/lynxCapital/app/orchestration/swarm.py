"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

LLM-driven orchestration with stages, replanning, long-lived workers, background dispatch, file-backed memory, streaming, compaction, and cancellation.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import weakref
from uuid import uuid4

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI

from app.agents import tools as tool_fns
from app.agents.runner import AgentHandle, create_runner
from app.config import get_config
from app.core.approvals import approvals
from app.core.blackboard import RunBlackboard
from app.core.cancellation import cancellation
from app.core.dataset import INVOICES, REGIONS, VENDORS
from app.core.files import RunFileStore
from app.core.jobs import JobRegistry
from app.core.memory import AgentMemory, RunMemoryStore, context_limit
from app.core.plans import RunPlanStore
from app.core.session_memory import RunRecord, session_memory
from app.core.settings import settings
from app.core.workers import WorkerPool
from app.events import types as ev
from app.events.bus import bus

log = logging.getLogger("lynx.swarm")
log.setLevel(logging.INFO)
if not log.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(
        logging.Formatter("[%(asctime)s] %(name)s %(levelname)s %(message)s")
    )
    log.addHandler(_h)


REGION_IDS = ("US", "IN", "DE", "SG", "BR")
STAGE_BUDGET = 12
TOTAL_BUDGET = 60

# Bound concurrent in-flight LLM streams so a wide swarm cannot open an
# unbounded number of simultaneous model connections.
LLM_CONCURRENCY = max(1, int(os.environ.get("LYNX_MAX_CONCURRENT_LLM", "4")))
_llm_semaphores: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore]" = weakref.WeakKeyDictionary()


def _llm_semaphore() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    sem = _llm_semaphores.get(loop)
    if sem is None:
        sem = asyncio.Semaphore(LLM_CONCURRENCY)
        _llm_semaphores[loop] = sem
    return sem


class RunCancelled(Exception):
    """Raised when a run is cancelled cooperatively."""


def _make_llm(model: str, temperature: float = 0.1) -> ChatOpenAI:
    """Factory for a streaming ChatOpenAI. Swapped out by tests via monkeypatch."""
    return ChatOpenAI(
        model=model,
        temperature=temperature,
        streaming=True,
        stream_usage=True,
    )


def _check_cancel(run_id: str) -> None:
    if cancellation.is_cancelled(run_id):
        raise RunCancelled()


async def _require_approval(
    run_id: str, agent_id: str, action: str, detail: dict
) -> dict | None:
    """Block an irreversible action on a human decision when approvals are
    enabled. Returns None to proceed, or a denial result to return instead."""
    if not approvals.required():
        return None
    request_id, pending = await approvals.request(run_id, action)
    bus.publish(ev.approval_required(run_id, agent_id, request_id, action, detail))
    decision = await approvals.wait(run_id, request_id, pending)
    bus.publish(
        ev.approval_resolved(
            run_id, agent_id, request_id, decision.approved, decision.reason
        )
    )
    if decision.approved:
        return None
    return {"status": "denied", "action": action, "reason": decision.reason, **detail}


def _emit_memory_snapshot(run_id: str, mem: AgentMemory) -> None:
    bus.publish(
        ev.memory_update(
            run_id=run_id,
            agent_id=mem.agent_id,
            tokens_used=mem.total_tokens(),
            tokens_limit=context_limit(mem.model),
            message_count=len(mem.messages),
            compactions=mem.compactions,
        )
    )


async def _maybe_compact(run_id: str, mem: AgentMemory, summarizer: ChatOpenAI) -> None:
    if not mem.should_compact():
        return
    before = mem.total_tokens()
    summary = await mem.compact(summarizer)
    if summary is None:
        return
    after = mem.total_tokens()
    bus.publish(
        ev.memory_compaction(
            run_id=run_id,
            agent_id=mem.agent_id,
            summary=summary,
            tokens_before=before,
            tokens_after=after,
        )
    )
    log.info(
        "memory_compaction agent=%s tokens=%d->%d chars=%d",
        mem.agent_id[:8],
        before,
        after,
        len(summary),
    )


async def _stream_assistant(run_id, agent_id, model_name, llm, messages) -> AIMessage:
    """Invoke the LLM, stream tokens, emit llm_call telemetry, return the
    accumulated AIMessage."""
    message_id = str(uuid4())
    t0 = time.time()
    full: AIMessage | None = None
    streamed_chars = 0

    async with _llm_semaphore():
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
    bus.publish(
        ev.llm_call(
            run_id=run_id,
            agent_id=agent_id,
            model=model_name,
            latency_ms=latency_ms,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            tool_calls=len(tool_calls),
            streamed_chars=streamed_chars,
        )
    )
    log.info(
        "llm_call agent=%s model=%s latency_ms=%d in_tok=%d out_tok=%d tool_calls=%d chars=%d",
        agent_id[:8],
        model_name,
        latency_ms,
        input_tokens,
        output_tokens,
        len(tool_calls),
        streamed_chars,
    )
    return AIMessage(content=text, tool_calls=tool_calls)


def _build_agent_builtins(
    run_id: str,
    agent_id: str,
    plans: RunPlanStore,
    files: RunFileStore,
    board: RunBlackboard,
    region: str | None = None,
    stage_state: dict | None = None,
    worker_pool: WorkerPool | None = None,
):
    """Planning, file, blackboard, stage, and worker tools scoped to one
    agent_id so events carry correct attribution. stage_state and worker_pool
    are only provided for orchestrators."""

    @tool
    def write_todos(todos: list) -> str:
        """Create or replace your task plan. Each element is an object with
        'content' (string) and 'status' (one of: pending, in_progress, completed).
        Example: [{"content": "Dispatch US region", "status": "in_progress"},
                  {"content": "Dispatch DE region", "status": "pending"}]
        Call at the start to lay out your plan, then call again as you progress."""
        if isinstance(todos, dict):
            todos = todos.get("items", todos.get("todos", []))
        plan = plans.write(agent_id, todos)
        bus.publish(
            ev.plan_update(
                run_id=run_id,
                agent_id=agent_id,
                todos=plan.as_list(),
                revision=plan.revision,
            )
        )
        return json.dumps(
            {"ok": True, "revision": plan.revision, "items": plan.as_list()}
        )

    @tool
    def write_file(path: str, content: str) -> str:
        """Save content to a named file in this run's memory store. Use this to
        offload large intermediate results so they don't bloat your prompt."""
        f = files.write(agent_id, path, content)
        bus.publish(
            ev.file_write(run_id=run_id, agent_id=agent_id, path=f.path, size=f.size)
        )
        return json.dumps({"path": f.path, "size": f.size})

    @tool
    def read_file(path: str) -> str:
        """Read a file previously saved with write_file. Returns the file's content."""
        f = files.read(path)
        if f is None:
            return json.dumps({"error": f"no file at {path!r}"})
        bus.publish(
            ev.file_read(run_id=run_id, agent_id=agent_id, path=f.path, size=f.size)
        )
        return f.content

    @tool
    def ls_files() -> str:
        """List all files in this run's memory store."""
        return json.dumps(files.ls())

    @tool
    def post_finding(kind: str, content: str) -> str:
        """Post a short finding to the run's shared blackboard so other agents
        can read it. `kind` is a short tag like 'risk', 'fx', 'compliance',
        'summary'. `content` is one or two sentences."""
        f = board.post(agent_id, region, kind, content[:600])
        bus.publish(ev.blackboard_post(run_id, agent_id, region, f.kind, f.content))
        return json.dumps({"ok": True, "ts": f.ts})

    @tool
    def read_findings(kind: str = "", region_filter: str = "", limit: int = 10) -> str:
        """Read recent findings from the shared blackboard. Filter by `kind`
        (e.g. 'risk') or `region_filter` ('US', 'IN', 'DE', 'SG', 'BR'). Returns
        a JSON list ordered oldest-first."""
        items = board.read(kind=kind or None, region=region_filter or None, limit=limit)
        return json.dumps([f.as_dict() for f in items])

    out = [write_todos, write_file, read_file, ls_files, post_finding, read_findings]

    if stage_state is not None:

        @tool
        def start_stage(name: str, intent: str) -> str:
            """Declare the start of a stage. `name` is a short stage id
            (e.g. 'extract', 'reconcile'); `intent` is one sentence on what
            this stage will accomplish."""
            stage_state["current"] = name
            bus.publish(ev.stage_start(run_id, agent_id, name, intent))
            return json.dumps({"ok": True, "stage": name})

        @tool
        def complete_stage(name: str, summary: str) -> str:
            """End the current stage. Posts a 'stage' finding to the
            blackboard with the summary and exits the current turn loop so a
            fresh budget begins on the next stage."""
            board.post(agent_id, region, "stage", f"{name}: {summary[:500]}")
            bus.publish(ev.stage_end(run_id, agent_id, name, summary))
            stage_state["stage_done"] = True
            stage_state["current"] = None
            return json.dumps({"ok": True, "stage": name})

        @tool
        def replan(reason: str, todos: list) -> str:
            """Replace the plan when stage outcomes invalidate it. `reason` is
            one sentence describing why; `todos` is the new task list (same
            shape as write_todos)."""
            if isinstance(todos, dict):
                todos = todos.get("items", todos.get("todos", []))
            plan = plans.write(agent_id, todos)
            bus.publish(ev.replan(run_id, agent_id, reason, plan.revision))
            bus.publish(
                ev.plan_update(
                    run_id=run_id,
                    agent_id=agent_id,
                    todos=plan.as_list(),
                    revision=plan.revision,
                )
            )
            return json.dumps({"ok": True, "revision": plan.revision, "reason": reason})

        out.extend([start_stage, complete_stage, replan])

    if worker_pool is not None:

        @tool
        def acquire_worker(role: str, scope: str) -> str:
            """Spawn a long-lived worker that stays alive across multiple tool
            calls. Returns the worker_id; use release_worker(worker_id, summary)
            when the delegated task is done."""
            try:
                w = worker_pool.acquire(role, scope)
            except (ValueError, RuntimeError, KeyError) as exc:
                return json.dumps({"error": str(exc), "role": role})
            return json.dumps({"worker_id": w.id, "role": role, "scope": scope})

        @tool
        def release_worker(worker_id: str, summary: str) -> str:
            """End and terminate a worker previously created with
            acquire_worker. `summary` records what the worker accomplished."""
            ok = worker_pool.release(worker_id, {"summary": summary[:400]})
            return json.dumps({"ok": ok, "worker_id": worker_id})

        out.extend([acquire_worker, release_worker])

    return out


def _build_regional_domain_tools(run_id, runner, parent, region):
    """Dynamically-spawned worker tools for a region."""
    region_invoices = [inv for inv in INVOICES if inv.region == region]
    region_vendors = {v.id: v for v in VENDORS.values() if v.region == region}

    def _worker(role: str, scope: str) -> AgentHandle:
        w = runner.spawn(
            role=role, scope=scope, parent=parent, layer=role, region=region
        )
        w.start()
        return w

    async def _aworker(role: str, scope: str) -> AgentHandle:
        w = await runner.aspawn(
            role=role, scope=scope, parent=parent, layer=role, region=region
        )
        w.start()
        return w

    def _finish(w, result):
        w.end(result)
        w.terminate("completed")

    @tool
    def list_pending_invoices(limit: int = 3) -> str:
        """Return up to `limit` pending invoices in this region as JSON."""
        out = []
        for inv in region_invoices[: max(1, min(limit, 5))]:
            v = region_vendors.get(inv.vendor_id)
            rail = v.preferred_rails[0].value if v and v.preferred_rails else "WIRE"
            out.append(
                {
                    "invoice_id": inv.id,
                    "vendor_id": inv.vendor_id,
                    "amount": float(inv.amount_local),
                    "currency": inv.currency,
                    "preferred_rail": rail,
                }
            )
        return json.dumps(out)

    @tool
    def extract_invoice_data(invoice_id: str) -> str:
        """OCR-extract invoice data. Spawns an invoice-intake worker."""
        w = _worker("invoice-intake", f"extract:{invoice_id}")
        try:
            return json.dumps(
                tool_fns.extract_invoice(run_id, w.id, invoice_id, f"{invoice_id}.pdf")
            )
        finally:
            _finish(w, {"invoice_id": invoice_id})

    @tool
    def match_invoice_in_ledger(
        invoice_id: str, vendor_id: str, amount: float, currency: str, erp: str = "auto"
    ) -> str:
        """Match an invoice against the vendor's ledger. `erp` selects the
        accounting back end ('ironbark', 'tallyhall', or 'auto' to route by the
        vendor's bookkeeping system). Spawns a ledger-match worker."""
        w = _worker("ledger-match", f"match:{invoice_id}")
        try:
            return json.dumps(
                tool_fns.match_invoice(
                    run_id, w.id, vendor_id, invoice_id, float(amount), currency, erp
                )
            )
        finally:
            _finish(w, {"invoice_id": invoice_id})

    @tool
    def check_vendor_compliance(vendor_id: str) -> str:
        """Run compliance screening on a vendor. Spawns a policy-check worker."""
        w = _worker("policy-check", f"compliance:{vendor_id}")
        try:
            return json.dumps(tool_fns.check_vendor(run_id, w.id, vendor_id))
        finally:
            _finish(w, {"vendor_id": vendor_id})

    @tool
    def lookup_fx_rate(from_currency: str, to_currency: str) -> str:
        """Look up an FX rate. Spawns a route-optimization worker."""
        w = _worker("route-optimization", f"fx:{from_currency}->{to_currency}")
        try:
            return json.dumps(
                tool_fns.get_fx_rate(run_id, w.id, from_currency, to_currency)
            )
        finally:
            _finish(w, {"from": from_currency, "to": to_currency})

    @tool
    def lookup_withholding_rate(currency: str) -> str:
        """Look up the withholding tax rate for this region + currency. Spawns a route-optimization worker."""
        w = _worker("route-optimization", f"withholding:{region}:{currency}")
        try:
            return json.dumps(
                tool_fns.get_withholding_rate(run_id, w.id, region, currency)
            )
        finally:
            _finish(w, {"currency": currency})

    @tool
    def lookup_market_rate(symbol: str) -> str:
        """Fetch a live mid-market FX snapshot (e.g. 'USD/EUR') from the market
        data feed to sanity-check the booked rate. Spawns a route-optimization worker."""
        w = _worker("route-optimization", f"mkt:{symbol}")
        try:
            return json.dumps(tool_fns.get_market_snapshot(run_id, w.id, symbol))
        finally:
            _finish(w, {"symbol": symbol})

    @tool
    def lookup_reference_rate(symbol: str) -> str:
        """Fetch the official end-of-day reference fixing for an FX pair (e.g. 'USD/EUR')
        from the market data feed to value or audit a booked rate against the published
        settlement rate. Spawns a route-optimization worker."""
        w = _worker("route-optimization", f"ref:{symbol}")
        try:
            return json.dumps(tool_fns.get_reference_rate(run_id, w.id, symbol))
        finally:
            _finish(w, {"symbol": symbol})

    @tool
    async def submit_payment(
        vendor_id: str, amount: float, currency: str, rail: str, reference: str
    ) -> str:
        """Submit a payment to the rail-appropriate provider. Spawns a payment-execution worker."""
        denied = await _require_approval(
            run_id,
            parent.id,
            "submit_payment",
            {
                "vendor_id": vendor_id,
                "amount": float(amount),
                "currency": currency,
                "rail": rail,
                "reference": reference,
            },
        )
        if denied:
            return json.dumps(denied)
        w = await _aworker("payment-execution", f"payment:{reference}")
        try:
            result = await asyncio.to_thread(
                tool_fns.submit_payment,
                run_id,
                w.id,
                vendor_id,
                float(amount),
                currency,
                rail,
                reference,
            )
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

    @tool
    def call_partner(provider_id: str, operation: str, payload_json: str = "{}") -> str:
        """Call an external partner provider over its real auth surface.

        Use for third-party services beyond the core flow: meridian-pay/quetzal-payouts/halcyon-bank
        (payments, payouts, open banking), inkwell-ocr (document extraction), slate-ledger (journals),
        vela-notify (transactional email/SMS, templates, delivery tracking, suppressions, webhooks), cordoba-fx (fx quotes/conversions/settlement payments), ironbark-erp/tallyhall-books (vendors/bills),
        beacon-crm (CRM accounts/contacts/deal pipeline/activities), core-billing (internal AR: customers/invoices/payments/dunning/collections/aging), lumen-identity (directory),
        atlas-vendor (vendor MDM/onboarding/verification/compliance/contracts over MCP),
        sabre-tax, pulse-market (market data: instruments, quotes, OHLC bars, end-of-day reference fixings, streaming subscriptions), junction-procure (procure-to-pay: suppliers, commodity catalog, cost-center budgets, tiered requisition approvals, purchase orders, goods receipts),
        relay-automation, aegis-screening, and verafin-monitor.
        Every call routes through the Caracal Gateway under the worker's own narrowed mandate.
        `payload_json` is a JSON object string of operation arguments. Spawns a partner-integration worker.
        """
        try:
            payload = json.loads(payload_json) if payload_json else {}
        except json.JSONDecodeError:
            return json.dumps(
                {
                    "error": "invalid_payload",
                    "message": "payload_json must be a JSON object",
                }
            )
        if not isinstance(payload, dict):
            return json.dumps(
                {
                    "error": "invalid_payload",
                    "message": "payload_json must be a JSON object",
                }
            )
        w = _worker("partner-integration", f"partner:{provider_id}:{operation}")
        try:
            return json.dumps(
                tool_fns.partner_operation(
                    run_id, w.id, provider_id, operation, payload
                )
            )
        finally:
            _finish(w, {"provider_id": provider_id, "operation": operation})

    return [
        list_pending_invoices,
        extract_invoice_data,
        match_invoice_in_ledger,
        check_vendor_compliance,
        lookup_fx_rate,
        lookup_withholding_rate,
        lookup_market_rate,
        lookup_reference_rate,
        submit_payment,
        record_audit,
        call_partner,
    ]


async def _turn_loop(
    run_id,
    agent,
    model_name,
    llm_with_tools,
    summarizer,
    mem,
    tool_map,
    *,
    stage_budget: int,
    state: dict,
):
    """Run the assistant turn loop for one agent stage. Independent tool calls
    in a single turn are executed concurrently, with bounded retries on
    transient exceptions. Honors stage_budget and state['total_used'] /
    state['stage_done'] / state['total_budget']. Increments state['tool_calls']."""
    total_budget = state.get("total_budget", TOTAL_BUDGET)
    for _ in range(stage_budget):
        if state["total_used"] >= total_budget:
            break
        if state.get("stage_done"):
            break
        _check_cancel(run_id)
        await _maybe_compact(run_id, mem, summarizer)
        ai_msg = await _stream_assistant(
            run_id, agent.id, model_name, llm_with_tools, mem.as_prompt()
        )
        mem.append(ai_msg)
        _emit_memory_snapshot(run_id, mem)
        state["total_used"] += 1
        if not ai_msg.tool_calls:
            break

        async def _exec(tc):
            _check_cancel(run_id)
            name = tc["name"]
            args = tc["args"]
            fn = tool_map.get(name)
            if fn is None:
                return tc, None, json.dumps({"error": f"unknown tool {name!r}"})
            bus.publish(ev.tool_call(run_id, agent.id, name, args))
            attempt = 0
            last_exc: Exception | None = None
            while attempt < 3:
                try:
                    result = await fn.ainvoke(args)
                    result_str = str(result)
                    bus.publish(
                        ev.tool_result(
                            run_id,
                            agent.id,
                            name,
                            {
                                "result": result_str[:400],
                                "truncated": len(result_str) > 400,
                            },
                        )
                    )
                    return tc, name, result_str
                except RunCancelled:
                    raise
                except Exception as exc:
                    last_exc = exc
                    attempt += 1
                    detail = str(exc)
                    body = getattr(getattr(exc, "response", None), "text", "")
                    if body:
                        detail = f"{detail} :: {body}"
                    bus.publish(
                        ev.tool_retry(run_id, agent.id, name, attempt, detail[:400])
                    )
                    if attempt >= 3:
                        break
                    await asyncio.sleep(0.1 * (2 ** (attempt - 1)))
            err = json.dumps(
                {"error": f"tool {name!r} failed after {attempt} attempts: {last_exc}"}
            )
            bus.publish(
                ev.tool_result(
                    run_id, agent.id, name, {"result": err, "truncated": False}
                )
            )
            return tc, name, err

        results = await asyncio.gather(*[_exec(tc) for tc in ai_msg.tool_calls])
        for tc, name, result_str in results:
            mem.append(ToolMessage(content=result_str, tool_call_id=tc["id"]))
            if name is not None:
                state["tool_calls"] = state.get("tool_calls", 0) + 1
        _emit_memory_snapshot(run_id, mem)
        if state.get("stage_done"):
            break
    return state.get("tool_calls", 0)


async def _drive_stages(
    run_id,
    agent,
    model_name,
    llm_with_tools,
    summarizer,
    mem,
    tool_map,
    *,
    stage_budget: int = STAGE_BUDGET,
    total_budget: int = TOTAL_BUDGET,
):
    """Run successive stages until the LLM stops requesting tools or budgets
    are exhausted. Each call to complete_stage exits the inner turn loop so a
    new stage starts with a fresh budget."""
    state = {
        "total_used": 0,
        "tool_calls": 0,
        "stage_done": False,
        "current": None,
        "total_budget": total_budget,
    }
    while state["total_used"] < total_budget:
        state["stage_done"] = False
        before = state["total_used"]
        await _turn_loop(
            run_id=run_id,
            agent=agent,
            model_name=model_name,
            llm_with_tools=llm_with_tools,
            summarizer=summarizer,
            mem=mem,
            tool_map=tool_map,
            stage_budget=stage_budget,
            state=state,
        )
        if not state["stage_done"]:
            break
        if state["total_used"] == before:
            break
    return state["tool_calls"]


async def _run_regional_orchestrator(
    run_id,
    runner,
    parent,
    memory_store,
    plans,
    files,
    board,
    parent_summary,
    region,
    focus,
    model_name,
    summarizer_model,
):
    cfg = get_config()
    region_meta = REGIONS.get(region)
    if region_meta is None:
        raise ValueError(f"Unknown region {region!r}")

    ro = await runner.aspawn(
        role="regional-orchestrator",
        scope=f"region:{region}",
        parent=parent,
        layer="regional-orchestrator",
        region=region,
    )
    ro.start()

    pool = WorkerPool(run_id, runner, ro)
    stage_state = {"current": None}
    try:
        tools = [
            *_build_agent_builtins(
                run_id,
                ro.id,
                plans,
                files,
                board,
                region=region,
                stage_state=stage_state,
                worker_pool=pool,
            ),
            *_build_regional_domain_tools(run_id, runner, ro, region),
        ]
        tool_map = {t.name: t for t in tools}

        llm = _make_llm(model_name, cfg.llm.temperature)
        llm_with_tools = llm.bind_tools(tools)
        summarizer = _make_llm(summarizer_model, 0.0)

        system_prompt = cfg.prompts.regionalOrchestrator.format(
            region=region,
            region_name=region_meta.name,
            currency=region_meta.currency,
            focus=focus or "process the pending batch end-to-end",
        )
        mem = memory_store.open(
            agent_id=ro.id,
            system=SystemMessage(content=system_prompt),
            seed_summary=parent_summary,
        )
        mem.append(
            HumanMessage(
                content=(
                    f"Begin now. Your first turn MUST be a write_todos call "
                    f"listing your specific planned steps for focus={focus!r}."
                )
            )
        )
        _emit_memory_snapshot(run_id, mem)

        tool_calls = await _drive_stages(
            run_id=run_id,
            agent=ro,
            model_name=model_name,
            llm_with_tools=llm_with_tools,
            summarizer=summarizer,
            mem=mem,
            tool_map=tool_map,
        )
    except (RunCancelled, asyncio.CancelledError):
        if not ro._terminated:
            ro.terminate("cancelled")
        raise
    except Exception:
        if not ro._terminated:
            ro.terminate("failed")
        raise
    finally:
        pool.drain("cancelled")

    result = {"region": region, "toolCalls": tool_calls}
    ro.end(result)
    ro.terminate("completed")
    return result


def _build_workflow_domain_tools(run_id, runner, parent, workflow_id):
    """Tools available to a Workflow Orchestrator. Each domain action spawns a
    short-lived worker so events carry per-action attribution."""

    def _worker(role: str, scope: str, customer_id: str | None = None) -> AgentHandle:
        w = runner.spawn(
            role=role,
            scope=scope,
            parent=parent,
            layer=role,
            region=None,
            customer_id=customer_id,
        )
        w.start()
        return w

    def _finish(w, result):
        w.end(result)
        w.terminate("completed")

    @tool
    def kyb_screen_vendor(vendor_id: str) -> str:
        """Run KYB (know-your-business) screening on a prospective vendor."""
        w = _worker("vendor-lifecycle", f"kyb:{vendor_id}")
        try:
            return json.dumps(tool_fns.kyb_screen_vendor(run_id, w.id, vendor_id))
        finally:
            _finish(w, {"vendor_id": vendor_id})

    @tool
    def register_vendor(vendor_id: str) -> str:
        """Register a screened vendor in the vendor master."""
        w = _worker("vendor-lifecycle", f"register:{vendor_id}")
        try:
            return json.dumps(tool_fns.register_vendor(run_id, w.id, vendor_id))
        finally:
            _finish(w, {"vendor_id": vendor_id})

    @tool
    def refresh_vendor_compliance(vendor_id: str) -> str:
        """Refresh ongoing compliance state for an existing vendor."""
        w = _worker("vendor-lifecycle", f"refresh:{vendor_id}")
        try:
            return json.dumps(
                tool_fns.refresh_vendor_compliance(run_id, w.id, vendor_id)
            )
        finally:
            _finish(w, {"vendor_id": vendor_id})

    @tool
    def get_contract_terms_for_vendor(vendor_id: str) -> str:
        """Retrieve current contract terms for a vendor."""
        w = _worker("vendor-lifecycle", f"contract:{vendor_id}")
        try:
            return json.dumps(tool_fns.get_contract_terms(run_id, w.id, vendor_id))
        finally:
            _finish(w, {"vendor_id": vendor_id})

    @tool
    def get_vendor_onboarding_status(vendor_id: str) -> str:
        """Return the onboarding case and checklist progress for a vendor."""
        w = _worker("vendor-lifecycle", f"onboarding:{vendor_id}")
        try:
            return json.dumps(
                tool_fns.get_vendor_onboarding_status(run_id, w.id, vendor_id)
            )
        finally:
            _finish(w, {"vendor_id": vendor_id})

    @tool
    def advance_vendor_onboarding(
        vendor_id: str, step: str, outcome: str = "pass"
    ) -> str:
        """Advance one onboarding checklist step (profile, tax, kyb, banking, documents,
        approval) for a vendor; the vendor activates once every step clears."""
        w = _worker("vendor-lifecycle", f"onboard-step:{vendor_id}:{step}")
        try:
            return json.dumps(
                tool_fns.advance_vendor_onboarding(
                    run_id, w.id, vendor_id, step, outcome
                )
            )
        finally:
            _finish(w, {"vendor_id": vendor_id})

    @tool
    def verify_vendor_banking(vendor_id: str, account_number: str = "") -> str:
        """Run micro-deposit bank verification for a vendor before enabling payments."""
        w = _worker("vendor-lifecycle", f"banking:{vendor_id}")
        try:
            return json.dumps(
                tool_fns.verify_vendor_banking(run_id, w.id, vendor_id, account_number)
            )
        finally:
            _finish(w, {"vendor_id": vendor_id})

    @tool
    def get_cash_position(region: str = "GLOBAL") -> str:
        """Return cash position for a region or globally if region omitted."""
        w = _worker("treasury", f"cash:{region}")
        try:
            return json.dumps(tool_fns.get_cash_position(run_id, w.id, region))
        finally:
            _finish(w, {"region": region})

    @tool
    def get_treasury_summary() -> str:
        """Group cash summary across every currency, converted to USD. Use this
        for a single consolidated view before deciding where to sweep or hedge."""
        w = _worker("treasury", "summary")
        try:
            return json.dumps(tool_fns.get_treasury_summary(run_id, w.id))
        finally:
            _finish(w, {})

    @tool
    def forecast_liquidity(horizon_days: int = 30, scenario: str = "base") -> str:
        """Forecast inflow/outflow over a horizon (7, 30, or 90 days) under a
        scenario (base, optimistic, or stress)."""
        w = _worker("treasury", f"forecast:{horizon_days}:{scenario}")
        try:
            return json.dumps(
                tool_fns.forecast_liquidity(run_id, w.id, int(horizon_days), scenario)
            )
        finally:
            _finish(w, {"horizon_days": horizon_days, "scenario": scenario})

    @tool
    def get_fx_exposure(currency: str) -> str:
        """Return the net FX exposure for a currency, with the hedged and unhedged
        amounts and 1-day value-at-risk. Use this to size a hedge before placing it."""
        w = _worker("treasury", f"exposure:{currency}")
        try:
            return json.dumps(tool_fns.get_fx_exposure(run_id, w.id, currency))
        finally:
            _finish(w, {"currency": currency})

    @tool
    def place_fx_hedge(
        from_currency: str, to_currency: str, notional: float, tenor_days: int = 90
    ) -> str:
        """Place a forward FX hedge."""
        w = _worker("treasury", f"hedge:{from_currency}->{to_currency}")
        try:
            return json.dumps(
                tool_fns.place_fx_hedge(
                    run_id,
                    w.id,
                    from_currency,
                    to_currency,
                    float(notional),
                    int(tenor_days),
                )
            )
        finally:
            _finish(w, {"from": from_currency, "to": to_currency})

    @tool
    async def transfer_funds(
        from_region: str, to_region: str, amount_usd: float
    ) -> str:
        """Move cash between regional operating accounts."""
        denied = await _require_approval(
            run_id,
            parent.id,
            "transfer_funds",
            {
                "from_region": from_region,
                "to_region": to_region,
                "amount_usd": float(amount_usd),
            },
        )
        if denied:
            return json.dumps(denied)
        w = _worker("treasury", f"transfer:{from_region}->{to_region}")
        try:
            return json.dumps(
                tool_fns.transfer_funds(
                    run_id, w.id, from_region, to_region, float(amount_usd)
                )
            )
        finally:
            _finish(w, {"from": from_region, "to": to_region})

    @tool
    def list_ledger_accounts(account_type: str = "") -> str:
        """List the Slate Ledger chart of accounts, optionally filtered by type
        (asset, liability, equity, income, expense). Use this to discover the
        account numbers to post against before a close journal."""
        w = _worker("close", f"accounts:{account_type or 'all'}")
        try:
            return json.dumps(tool_fns.list_ledger_accounts(run_id, w.id, account_type))
        finally:
            _finish(w, {"type": account_type})

    @tool
    async def post_journal_entry(
        account_id: str, amount: float, currency: str, period: str
    ) -> str:
        """Post a journal entry to the GL for a given period."""
        denied = await _require_approval(
            run_id,
            parent.id,
            "post_journal_entry",
            {
                "account_id": account_id,
                "amount": float(amount),
                "currency": currency,
                "period": period,
            },
        )
        if denied:
            return json.dumps(denied)
        w = _worker("close", f"je:{account_id}")
        try:
            return json.dumps(
                tool_fns.post_journal_entry(
                    run_id, w.id, account_id, float(amount), currency, period
                )
            )
        finally:
            _finish(w, {"account_id": account_id})

    @tool
    def reconcile_account(account_id: str) -> str:
        """Reconcile a GL account against its bank/sub-ledger statement. Opens an
        asynchronous reconciliation job and returns the settled result with any
        outstanding items and exceptions."""
        w = _worker("close", f"recon:{account_id}")
        try:
            return json.dumps(tool_fns.reconcile_account(run_id, w.id, account_id))
        finally:
            _finish(w, {"account_id": account_id})

    @tool
    def compute_accrual(category: str, period: str) -> str:
        """Create a recurring accrual schedule for a category in a period."""
        w = _worker("close", f"accrual:{category}")
        try:
            return json.dumps(tool_fns.compute_accrual(run_id, w.id, category, period))
        finally:
            _finish(w, {"category": category})

    @tool
    def get_trial_balance(period: str) -> str:
        """Pull the trial balance for a period and confirm debits equal credits
        before attempting to close it."""
        w = _worker("close", f"tb:{period}")
        try:
            return json.dumps(tool_fns.get_trial_balance(run_id, w.id, period))
        finally:
            _finish(w, {"period": period})

    @tool
    def close_period(period: str) -> str:
        """Close an accounting period (e.g. '2026-04'). The ledger gates the
        close on a balanced trial balance and completed reconciliations."""
        w = _worker("close", f"close:{period}")
        try:
            return json.dumps(tool_fns.close_period(run_id, w.id, period))
        finally:
            _finish(w, {"period": period})

    @tool
    def aml_monitor_transaction(
        vendor_id: str, amount: float, currency: str, channel: str = "wire"
    ) -> str:
        """Run AML transaction monitoring. Returns a risk score and, when flagged,
        an alertId to investigate. `channel` is one of wire/ach/cash/card/crypto/check."""
        w = _worker("compliance", f"aml:{vendor_id}")
        try:
            return json.dumps(
                tool_fns.aml_monitor_transaction(
                    run_id, w.id, vendor_id, float(amount), currency, channel
                )
            )
        finally:
            _finish(w, {"vendor_id": vendor_id})

    @tool
    def sanctions_screen_batch(batch_id: str) -> str:
        """Run a batch sanctions screen."""
        w = _worker("compliance", f"sanctions:{batch_id}")
        try:
            return json.dumps(tool_fns.sanctions_screen_batch(run_id, w.id, batch_id))
        finally:
            _finish(w, {"batch_id": batch_id})

    @tool
    def prepare_regulatory_filing(filing_type: str, alert_id: str) -> str:
        """Prepare a SAR or CTR filing draft from a monitoring alert. `filing_type`
        is 'SAR' or 'CTR'; `alert_id` is the alertId returned by aml_monitor_transaction.
        Returns a filingId and the regulator deadline."""
        w = _worker("compliance", f"filing:{filing_type}")
        try:
            return json.dumps(
                tool_fns.prepare_regulatory_filing(run_id, w.id, filing_type, alert_id)
            )
        finally:
            _finish(w, {"filing_type": filing_type})

    @tool
    def submit_regulatory_filing(filing_id: str) -> str:
        """Submit a prepared SAR/CTR filing to FinCEN. `filing_id` is the filingId
        from prepare_regulatory_filing. Returns the BSA confirmation number."""
        w = _worker("compliance", f"submit:{filing_id}")
        try:
            return json.dumps(
                tool_fns.submit_regulatory_filing(run_id, w.id, filing_id)
            )
        finally:
            _finish(w, {"filing_id": filing_id})

    @tool
    def attest_control(control_id: str, effectiveness: str = "effective") -> str:
        """Attest a BSA/AML or internal control. `effectiveness` is 'effective' or 'deficient'."""
        w = _worker("compliance", f"control:{control_id}")
        try:
            return json.dumps(
                tool_fns.attest_control(run_id, w.id, control_id, effectiveness)
            )
        finally:
            _finish(w, {"control_id": control_id})

    @tool
    def issue_customer_invoice(customer_id: str, amount: float, currency: str) -> str:
        """Issue a customer invoice."""
        w = _worker("receivables", f"ar-issue:{customer_id}", customer_id=customer_id)
        try:
            return json.dumps(
                tool_fns.issue_customer_invoice(
                    run_id, w.id, customer_id, float(amount), currency
                )
            )
        finally:
            _finish(w, {"customer_id": customer_id})

    @tool
    def send_dunning_notice(customer_id: str, stage: int, invoice_id: str = "") -> str:
        """Send a dunning notice (stage 1=reminder, 2=second notice, 3=collections).
        Pass invoice_id to record the dunning action against that invoice in Core Billing."""
        w = _worker("receivables", f"ar-dun:{customer_id}", customer_id=customer_id)
        try:
            return json.dumps(
                tool_fns.send_dunning_notice(
                    run_id, w.id, customer_id, int(stage), invoice_id or None
                )
            )
        finally:
            _finish(w, {"customer_id": customer_id})

    @tool
    def run_dunning_cycle(min_days_past_due: int = 1, customer_id: str = "") -> str:
        """Sweep overdue receivables in Core Billing and escalate dunning by policy."""
        w = _worker(
            "receivables",
            f"ar-cycle:{customer_id or 'all'}",
            customer_id=customer_id or None,
        )
        try:
            return json.dumps(
                tool_fns.run_dunning_cycle(
                    run_id, w.id, int(min_days_past_due), customer_id or None
                )
            )
        finally:
            _finish(w, {"customer_id": customer_id})

    @tool
    def send_remittance_advice(
        vendor_id: str, amount: float, currency: str, reference: str
    ) -> str:
        """Email a vendor a remittance advice confirming a payment was sent."""
        w = _worker("payments", f"remit:{reference}")
        try:
            return json.dumps(
                tool_fns.send_remittance_advice(
                    run_id, w.id, vendor_id, float(amount), currency, reference
                )
            )
        finally:
            _finish(w, {"vendor_id": vendor_id, "reference": reference})

    @tool
    def send_payment_confirmation(
        payee_id: str,
        amount: float,
        currency: str,
        reference: str,
        channel: str = "email",
    ) -> str:
        """Notify a payee that their payment was confirmed, by email or SMS."""
        w = _worker("payments", f"payconf:{reference}")
        try:
            return json.dumps(
                tool_fns.send_payment_confirmation(
                    run_id, w.id, payee_id, float(amount), currency, reference, channel
                )
            )
        finally:
            _finish(w, {"payee_id": payee_id, "reference": reference})

    @tool
    def track_message_delivery(message_id: str) -> str:
        """Check the delivery status and event timeline of a sent notification."""
        w = _worker("receivables", f"track:{message_id}")
        try:
            return json.dumps(tool_fns.track_message_delivery(run_id, w.id, message_id))
        finally:
            _finish(w, {"message_id": message_id})

    @tool
    def apply_customer_payment(invoice_id: str, amount: float) -> str:
        """Apply a received customer payment to an open invoice."""
        w = _worker("receivables", f"ar-apply:{invoice_id}")
        try:
            return json.dumps(
                tool_fns.apply_customer_payment(run_id, w.id, invoice_id, float(amount))
            )
        finally:
            _finish(w, {"invoice_id": invoice_id})

    @tool
    def get_ar_aging(region: str = "GLOBAL") -> str:
        """Return AR aging buckets for a region."""
        w = _worker("receivables", f"ar-aging:{region}")
        try:
            return json.dumps(tool_fns.get_ar_aging(run_id, w.id, region))
        finally:
            _finish(w, {"region": region})

    @tool
    def get_ar_summary() -> str:
        """Return the receivables dashboard: total/overdue AR, DSO, disputes, write-offs, and collections."""
        w = _worker("receivables", "ar-summary")
        try:
            return json.dumps(tool_fns.get_ar_summary(run_id, w.id))
        finally:
            _finish(w, {})

    @tool
    def get_customer_account(customer_id: str) -> str:
        """Return a customer's billing profile, credit terms, AR balance, and aging."""
        w = _worker("receivables", f"ar-cust:{customer_id}", customer_id=customer_id)
        try:
            return json.dumps(tool_fns.get_customer_account(run_id, w.id, customer_id))
        finally:
            _finish(w, {"customer_id": customer_id})

    @tool
    def list_customer_invoices(customer_id: str, overdue: bool = False) -> str:
        """List a customer's invoices, optionally only those overdue."""
        w = _worker("receivables", f"ar-inv:{customer_id}", customer_id=customer_id)
        try:
            return json.dumps(
                tool_fns.list_customer_invoices(
                    run_id, w.id, customer_id, bool(overdue)
                )
            )
        finally:
            _finish(w, {"customer_id": customer_id})

    @tool
    def record_customer_payment(
        customer_id: str, amount: float, reference: str = ""
    ) -> str:
        """Record a customer remittance and apply it across open invoices oldest-first."""
        w = _worker("receivables", f"ar-remit:{customer_id}", customer_id=customer_id)
        try:
            return json.dumps(
                tool_fns.record_customer_payment(
                    run_id, w.id, customer_id, float(amount), reference or None
                )
            )
        finally:
            _finish(w, {"customer_id": customer_id})

    @tool
    def write_off_invoice(invoice_id: str, reason: str = "bad_debt") -> str:
        """Write off an uncollectible invoice as bad debt."""
        w = _worker("receivables", f"ar-writeoff:{invoice_id}")
        try:
            return json.dumps(
                tool_fns.write_off_invoice(run_id, w.id, invoice_id, reason)
            )
        finally:
            _finish(w, {"invoice_id": invoice_id})

    @tool
    def open_collection_case(customer_id: str) -> str:
        """Open a collections case for a customer's severely overdue invoices."""
        w = _worker("receivables", f"ar-collect:{customer_id}")
        try:
            return json.dumps(tool_fns.open_collection_case(run_id, w.id, customer_id))
        finally:
            _finish(w, {"customer_id": customer_id})

    @tool
    def get_department_budget(department: str) -> str:
        """Check remaining budget for a department before raising a requisition."""
        w = _worker("vendor-lifecycle", f"budget:{department}")
        try:
            return json.dumps(tool_fns.get_budget(run_id, w.id, department))
        finally:
            _finish(w, {"department": department})

    @tool
    def raise_requisition(department: str, amount: float, description: str) -> str:
        """Raise a purchase requisition for a department."""
        w = _worker("vendor-lifecycle", f"req:{department}")
        try:
            return json.dumps(
                tool_fns.create_requisition(
                    run_id, w.id, department, float(amount), description
                )
            )
        finally:
            _finish(w, {"department": department})

    @tool
    def approve_requisition(requisition_id: str) -> str:
        """Approve a pending purchase requisition."""
        w = _worker("vendor-lifecycle", f"req-approve:{requisition_id}")
        try:
            return json.dumps(
                tool_fns.approve_requisition(run_id, w.id, requisition_id)
            )
        finally:
            _finish(w, {"requisition_id": requisition_id})

    @tool
    async def raise_purchase_order(requisition_id: str, vendor_id: str) -> str:
        """Convert an approved requisition into a purchase order against a vendor."""
        denied = await _require_approval(
            run_id,
            parent.id,
            "raise_purchase_order",
            {"requisition_id": requisition_id, "vendor_id": vendor_id},
        )
        if denied:
            return json.dumps(denied)
        w = _worker("vendor-lifecycle", f"po:{requisition_id}")
        try:
            return json.dumps(
                tool_fns.create_purchase_order(run_id, w.id, requisition_id, vendor_id)
            )
        finally:
            _finish(w, {"requisition_id": requisition_id})

    @tool
    def list_procurement_suppliers(status: str = "active") -> str:
        """List approved suppliers in the procurement supplier master before raising a PO."""
        w = _worker("vendor-lifecycle", f"suppliers:{status}")
        try:
            return json.dumps(tool_fns.procurement_list_suppliers(run_id, w.id, status))
        finally:
            _finish(w, {"status": status})

    @tool
    def get_requisition_approvals(requisition_id: str) -> str:
        """Inspect the approval chain and decision status of a requisition."""
        w = _worker("vendor-lifecycle", f"approvals:{requisition_id}")
        try:
            return json.dumps(tool_fns.get_approval_chain(run_id, w.id, requisition_id))
        finally:
            _finish(w, {"requisition_id": requisition_id})

    @tool
    def reject_requisition(requisition_id: str, reason: str = "") -> str:
        """Reject a requisition that is awaiting approval."""
        w = _worker("vendor-lifecycle", f"req-reject:{requisition_id}")
        try:
            return json.dumps(
                tool_fns.reject_requisition(
                    run_id, w.id, requisition_id, reason or None
                )
            )
        finally:
            _finish(w, {"requisition_id": requisition_id})

    @tool
    def receive_purchase_order(po_id: str) -> str:
        """Record a goods receipt that closes out a purchase order and its budget commitment."""
        w = _worker("vendor-lifecycle", f"grn:{po_id}")
        try:
            return json.dumps(tool_fns.receive_purchase_order(run_id, w.id, po_id))
        finally:
            _finish(w, {"po_id": po_id})

    @tool
    def get_supplier_contact(contact_id: str) -> str:
        """Look up a supplier contact record in the CRM."""
        w = _worker("vendor-lifecycle", f"crm:{contact_id}")
        try:
            return json.dumps(tool_fns.get_supplier_contact(run_id, w.id, contact_id))
        finally:
            _finish(w, {"contact_id": contact_id})

    @tool
    def get_supplier_account(account_id: str) -> str:
        """Look up a supplier account (company) record in the CRM."""
        w = _worker("vendor-lifecycle", f"crm-account:{account_id}")
        try:
            return json.dumps(tool_fns.get_supplier_account(run_id, w.id, account_id))
        finally:
            _finish(w, {"account_id": account_id})

    @tool
    def list_supplier_contacts(account_id: str) -> str:
        """List the CRM contacts (buying committee) attached to a supplier account."""
        w = _worker("vendor-lifecycle", f"crm-contacts:{account_id}")
        try:
            return json.dumps(tool_fns.list_supplier_contacts(run_id, w.id, account_id))
        finally:
            _finish(w, {"account_id": account_id})

    @tool
    def list_supplier_deals(account_id: str) -> str:
        """List the open deals in the CRM pipeline for a supplier account."""
        w = _worker("vendor-lifecycle", f"crm-deals:{account_id}")
        try:
            return json.dumps(tool_fns.list_supplier_deals(run_id, w.id, account_id))
        finally:
            _finish(w, {"account_id": account_id})

    @tool
    def advance_supplier_deal(deal_id: str, stage: str) -> str:
        """Advance a CRM deal to a new pipeline stage (prospect, qualified, proposal, negotiation, won, lost)."""
        w = _worker("vendor-lifecycle", f"crm-deal-stage:{deal_id}")
        try:
            return json.dumps(
                tool_fns.advance_supplier_deal(run_id, w.id, deal_id, stage)
            )
        finally:
            _finish(w, {"deal_id": deal_id})

    @tool
    def log_supplier_activity(contact_id: str, activity_type: str) -> str:
        """Record a supplier interaction (call, email, meeting, note, task) against a CRM contact."""
        w = _worker("vendor-lifecycle", f"crm-log:{contact_id}")
        try:
            return json.dumps(
                tool_fns.log_supplier_activity(run_id, w.id, contact_id, activity_type)
            )
        finally:
            _finish(w, {"contact_id": contact_id})

    @tool
    def add_supplier_note(contact_id: str, body: str) -> str:
        """Attach a free-text note to a CRM contact for the relationship record."""
        w = _worker("vendor-lifecycle", f"crm-note:{contact_id}")
        try:
            return json.dumps(
                tool_fns.add_supplier_note(run_id, w.id, contact_id, body)
            )
        finally:
            _finish(w, {"contact_id": contact_id})

    @tool
    def list_approver_groups() -> str:
        """List internal approver groups from the identity directory for routing approvals."""
        w = _worker("compliance", "identity:groups")
        try:
            return json.dumps(tool_fns.list_approver_groups(run_id, w.id))
        finally:
            _finish(w, {"scope": "groups"})

    @tool
    def resolve_approver_chain(user_id: str) -> str:
        """Resolve a requester's management chain from the identity directory to route an approval.

        `user_id` accepts an employee id, username, or work email. Returns the ordered
        manager chain used to find an authorised approver above the requester.
        """
        w = _worker("compliance", f"identity:chain:{user_id}")
        try:
            return json.dumps(tool_fns.resolve_approver_chain(run_id, w.id, user_id))
        finally:
            _finish(w, {"user_id": user_id})

    @tool
    def check_user_access(user_id: str) -> str:
        """Resolve a user's effective roles and permissions for a segregation-of-duties check.

        `user_id` accepts an employee id, username, or work email. Returns the union of
        permissions granted by the user's directly assigned roles and group-derived roles.
        """
        w = _worker("compliance", f"identity:access:{user_id}")
        try:
            return json.dumps(tool_fns.check_user_access(run_id, w.id, user_id))
        finally:
            _finish(w, {"user_id": user_id})

    @tool
    def record_audit(summary: str) -> str:
        """Record a final audit entry for this workflow."""
        w = _worker("audit", f"audit:workflow:{workflow_id}")
        record = {"workflow_id": workflow_id, "summary": summary}
        try:
            bus.publish(ev.audit_record(run_id, w.id, record))
            return json.dumps({"ok": True})
        finally:
            _finish(w, record)

    return [
        kyb_screen_vendor,
        register_vendor,
        refresh_vendor_compliance,
        get_contract_terms_for_vendor,
        get_vendor_onboarding_status,
        advance_vendor_onboarding,
        verify_vendor_banking,
        get_cash_position,
        get_treasury_summary,
        forecast_liquidity,
        get_fx_exposure,
        place_fx_hedge,
        transfer_funds,
        post_journal_entry,
        list_ledger_accounts,
        reconcile_account,
        compute_accrual,
        get_trial_balance,
        close_period,
        aml_monitor_transaction,
        sanctions_screen_batch,
        prepare_regulatory_filing,
        submit_regulatory_filing,
        attest_control,
        issue_customer_invoice,
        send_dunning_notice,
        run_dunning_cycle,
        apply_customer_payment,
        record_customer_payment,
        get_ar_aging,
        get_ar_summary,
        get_customer_account,
        list_customer_invoices,
        write_off_invoice,
        open_collection_case,
        send_remittance_advice,
        send_payment_confirmation,
        track_message_delivery,
        get_department_budget,
        raise_requisition,
        approve_requisition,
        raise_purchase_order,
        list_procurement_suppliers,
        get_requisition_approvals,
        reject_requisition,
        receive_purchase_order,
        get_supplier_contact,
        get_supplier_account,
        list_supplier_contacts,
        list_supplier_deals,
        advance_supplier_deal,
        log_supplier_activity,
        add_supplier_note,
        list_approver_groups,
        resolve_approver_chain,
        check_user_access,
        record_audit,
    ]


async def _run_workflow_orchestrator(
    run_id,
    runner,
    parent,
    memory_store,
    plans,
    files,
    board,
    parent_summary,
    workflow_id,
    label,
    focus,
    model_name,
    summarizer_model,
):
    cfg = get_config()

    wo = await runner.aspawn(
        role="workflow-orchestrator",
        scope=f"workflow:{workflow_id}",
        parent=parent,
        layer="workflow-orchestrator",
        region=None,
    )
    wo.start()

    pool = WorkerPool(run_id, runner, wo)
    stage_state = {"current": None}
    try:
        tools = [
            *_build_agent_builtins(
                run_id,
                wo.id,
                plans,
                files,
                board,
                region=None,
                stage_state=stage_state,
                worker_pool=pool,
            ),
            *_build_workflow_domain_tools(run_id, runner, wo, workflow_id),
        ]
        tool_map = {t.name: t for t in tools}

        llm = _make_llm(model_name, cfg.llm.temperature)
        llm_with_tools = llm.bind_tools(tools)
        summarizer = _make_llm(summarizer_model, 0.0)

        system_prompt = cfg.prompts.workflowOrchestrator.format(
            label=label,
            focus=focus or "complete the operational task end-to-end",
        )
        mem = memory_store.open(
            agent_id=wo.id,
            system=SystemMessage(content=system_prompt),
            seed_summary=parent_summary,
        )
        mem.append(
            HumanMessage(
                content=(
                    f"Begin now. Your first turn MUST be a write_todos call "
                    f"listing your specific planned steps for focus={focus!r}."
                )
            )
        )
        _emit_memory_snapshot(run_id, mem)

        tool_calls = await _drive_stages(
            run_id=run_id,
            agent=wo,
            model_name=model_name,
            llm_with_tools=llm_with_tools,
            summarizer=summarizer,
            mem=mem,
            tool_map=tool_map,
        )
    except (RunCancelled, asyncio.CancelledError):
        if not wo._terminated:
            wo.terminate("cancelled")
        raise
    except Exception:
        if not wo._terminated:
            wo.terminate("failed")
        raise
    finally:
        pool.drain("cancelled")

    result = {"workflow_id": workflow_id, "toolCalls": tool_calls}
    wo.end(result)
    wo.terminate("completed")
    return result


def _build_fc_domain_tools(
    run_id,
    runner,
    fc,
    memory_store,
    plans,
    files,
    board,
    model_name,
    summarizer_model,
    dispatched_regions: list[str],
    dispatched_workflows: list[str],
    jobs: JobRegistry,
):
    cfg = get_config()
    workflow_map = {w.id: w for w in cfg.workflows}

    @tool
    async def dispatch_region(region: str, focus: str = "") -> str:
        """Dispatch a Regional Orchestrator sub-agent. Returns IMMEDIATELY with
        a job_id; the orchestrator runs in the background. Call await_jobs with
        that job id (and any others you started this turn) before using outcomes.
        region must be one of: US, IN, DE, SG, BR."""
        r = region.upper().strip()
        if r not in REGION_IDS:
            return json.dumps({"error": f"unknown region {region!r}"})
        dispatched_regions.append(r)
        fc_mem = memory_store.get(fc.id)
        parent_summary = (fc_mem.seed_summary if fc_mem else "") or (
            f"Finance Control dispatched region {r} with focus: {focus or '(none)'}."
        )
        coro = _run_regional_orchestrator(
            run_id,
            runner,
            fc,
            memory_store,
            plans,
            files,
            board,
            parent_summary,
            r,
            focus or "",
            model_name,
            summarizer_model,
        )
        try:
            job_id = jobs.start(coro, kind="region", target=r)
        except RuntimeError as exc:
            coro.close()
            return json.dumps({"error": str(exc), "region": r})
        bus.publish(ev.job_started(run_id, fc.id, job_id, "region", r))
        return json.dumps({"job_id": job_id, "kind": "region", "target": r})

    @tool
    async def dispatch_workflow(workflow_id: str, focus: str = "") -> str:
        """Dispatch a Workflow Orchestrator sub-agent. Returns IMMEDIATELY with
        a job_id; the orchestrator runs in the background. Call await_jobs with
        that job id (and any others you started this turn) before using outcomes.
        workflow_id must be one of: vendorLifecycle, treasury, close,
        compliance, receivables, procurement."""
        wf = workflow_map.get(workflow_id.strip())
        if wf is None:
            return json.dumps({"error": f"unknown workflow {workflow_id!r}"})
        dispatched_workflows.append(wf.id)
        fc_mem = memory_store.get(fc.id)
        parent_summary = (fc_mem.seed_summary if fc_mem else "") or (
            f"Finance Control dispatched workflow {wf.id} with focus: {focus or wf.focus}."
        )
        coro = _run_workflow_orchestrator(
            run_id,
            runner,
            fc,
            memory_store,
            plans,
            files,
            board,
            parent_summary,
            wf.id,
            wf.label,
            focus or wf.focus,
            model_name,
            summarizer_model,
        )
        try:
            job_id = jobs.start(coro, kind="workflow", target=wf.id)
        except RuntimeError as exc:
            coro.close()
            return json.dumps({"error": str(exc), "workflow_id": wf.id})
        bus.publish(ev.job_started(run_id, fc.id, job_id, "workflow", wf.id))
        return json.dumps({"job_id": job_id, "kind": "workflow", "target": wf.id})

    @tool
    async def await_jobs(job_ids: list[str], timeout_s: float = 120.0) -> str:
        """Wait for the listed job_ids until they complete or timeout. Returns
        a JSON array of {job_id, kind, target, status, result|error}. Status is
        'completed', 'failed', or 'pending' (timed out)."""
        if isinstance(job_ids, str):
            job_ids = [job_ids]
        results = await jobs.await_many(list(job_ids), float(timeout_s))
        for r in results:
            if r["status"] in ("completed", "failed"):
                payload = (
                    r.get("result")
                    if r["status"] == "completed"
                    else {"error": r.get("error")}
                )
                bus.publish(
                    ev.job_completed(
                        run_id,
                        fc.id,
                        r["job_id"],
                        r["status"],
                        payload or {},
                        kind=r.get("kind", ""),
                        target=r.get("target", ""),
                    )
                )
        return json.dumps(results)

    return [dispatch_region, dispatch_workflow, await_jobs]


async def run_swarm(run_id: str, prompt: str) -> None:
    cfg = get_config()
    model_name = settings.model
    summarizer_model = cfg.llm.summarizerModel or model_name
    cancellation.register(run_id)
    bus.publish(ev.run_start(run_id, prompt))
    bus.publish(ev.chat_user(run_id, prompt))
    log.info(
        "run_swarm start run_id=%s model=%s prompt=%r", run_id, model_name, prompt[:120]
    )

    runner = create_runner(run_id)
    memory_store = RunMemoryStore(run_id, model_name)
    plans = RunPlanStore(run_id)
    files = RunFileStore(run_id=run_id)
    board = RunBlackboard(run_id)
    jobs = JobRegistry(run_id)

    try:
        fc = await runner.aspawn(
            role="finance-control",
            scope="global",
            parent=None,
            layer="finance-control",
            region=None,
        )
    except Exception as exc:
        log.exception("run_swarm spawn failed run_id=%s", run_id)
        bus.publish(ev.error(run_id, str(exc)))
        bus.publish(ev.run_end(run_id, "failed"))
        cancellation.clear(run_id)
        await runner.aclose()
        session_memory.record_run(
            RunRecord(
                run_id=run_id,
                prompt=prompt,
                status="failed",
                regions=[],
                errors=[str(exc)],
            )
        )
        return
    fc.start()

    pool = WorkerPool(run_id, runner, fc)
    stage_state = {"current": None}
    dispatched_regions: list[str] = []
    dispatched_workflows: list[str] = []
    tools = [
        *_build_agent_builtins(
            run_id,
            fc.id,
            plans,
            files,
            board,
            stage_state=stage_state,
            worker_pool=pool,
        ),
        *_build_fc_domain_tools(
            run_id,
            runner,
            fc,
            memory_store,
            plans,
            files,
            board,
            model_name,
            summarizer_model,
            dispatched_regions,
            dispatched_workflows,
            jobs,
        ),
    ]
    tool_map = {t.name: t for t in tools}
    llm = _make_llm(model_name, cfg.llm.temperature)
    llm_with_tools = llm.bind_tools(tools)
    summarizer = _make_llm(summarizer_model, 0.0)

    session_memory.add_user(prompt, run_id)
    ctx = session_memory.context_block(prompt)

    mem = memory_store.open(fc.id, SystemMessage(content=cfg.prompts.financeControl))
    if ctx:
        mem.append(
            SystemMessage(
                content=f"[Session context: prior runs and conversation]\n{ctx}"
            )
        )
    mem.append(HumanMessage(content=prompt))
    _emit_memory_snapshot(run_id, mem)

    run_errors: list[str] = []
    run_status = "completed"
    try:
        await _drive_stages(
            run_id=run_id,
            agent=fc,
            model_name=model_name,
            llm_with_tools=llm_with_tools,
            summarizer=summarizer,
            mem=mem,
            tool_map=tool_map,
        )
        drained = await jobs.drain(timeout_s=180.0)
        for r in drained:
            if r["status"] in ("completed", "failed"):
                payload = (
                    r.get("result")
                    if r["status"] == "completed"
                    else {"error": r.get("error")}
                )
                bus.publish(
                    ev.job_completed(
                        run_id,
                        fc.id,
                        r["job_id"],
                        r["status"],
                        payload or {},
                        kind=r.get("kind", ""),
                        target=r.get("target", ""),
                    )
                )
        await jobs.cancel_pending()
        pool.drain("completed")
        fc.end({"status": "completed"})
        fc.terminate("completed")
        bus.publish(ev.run_end(run_id, "completed"))
        log.info("run_swarm end run_id=%s status=completed", run_id)
    except RunCancelled:
        run_status = "cancelled"
        log.info("run_swarm cancelled run_id=%s", run_id)
        bus.publish(ev.run_cancelled(run_id))
        await jobs.drain(timeout_s=5.0)
        await jobs.cancel_pending()
        pool.drain("cancelled")
        if not fc._terminated:
            fc.terminate("cancelled")
        bus.publish(ev.run_end(run_id, "cancelled"))
    except Exception as exc:
        run_status = "failed"
        run_errors.append(str(exc))
        log.exception("run_swarm failed run_id=%s", run_id)
        bus.publish(ev.error(run_id, str(exc), fc.id))
        await jobs.drain(timeout_s=5.0)
        await jobs.cancel_pending()
        pool.drain("failed")
        if not fc._terminated:
            fc.terminate("failed")
        bus.publish(ev.run_end(run_id, "failed"))
    finally:
        cancellation.clear(run_id)
        # Retire every Caracal session the run opened (workers, orchestrators, roots).
        await runner.aclose()
        last_ai = next(
            (
                m
                for m in reversed(mem.messages)
                if isinstance(m, AIMessage) and m.content
            ),
            None,
        )
        if last_ai:
            session_memory.add_assistant(str(last_ai.content), run_id)
        session_memory.record_run(
            RunRecord(
                run_id=run_id,
                prompt=prompt,
                status=run_status,
                regions=list(dispatched_regions),
                errors=run_errors,
            )
        )
