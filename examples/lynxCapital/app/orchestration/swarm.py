"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

LLM-driven orchestration with stages, replanning, long-lived workers, background dispatch, file-backed memory, streaming, compaction, and cancellation.
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
from app.agents.runner import AgentHandle, create_runner
from app.config import get_config
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
    _h.setFormatter(logging.Formatter("[%(asctime)s] %(name)s %(levelname)s %(message)s"))
    log.addHandler(_h)


REGION_IDS = ("US", "IN", "DE", "SG", "BR")
STAGE_BUDGET = 12
TOTAL_BUDGET = 60


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


def _emit_memory_snapshot(run_id: str, mem: AgentMemory) -> None:
    bus.publish(ev.memory_update(
        run_id=run_id,
        agent_id=mem.agent_id,
        tokens_used=mem.total_tokens(),
        tokens_limit=context_limit(mem.model),
        message_count=len(mem.messages),
        compactions=mem.compactions,
    ))


async def _maybe_compact(run_id: str, mem: AgentMemory, summarizer: ChatOpenAI) -> None:
    if not mem.should_compact():
        return
    before = mem.total_tokens()
    summary = await mem.compact(summarizer)
    if summary is None:
        return
    after = mem.total_tokens()
    bus.publish(ev.memory_compaction(
        run_id=run_id,
        agent_id=mem.agent_id,
        summary=summary,
        tokens_before=before,
        tokens_after=after,
    ))
    log.info(
        "memory_compaction agent=%s tokens=%d->%d chars=%d",
        mem.agent_id[:8], before, after, len(summary),
    )


async def _stream_assistant(run_id, agent_id, model_name, llm, messages) -> AIMessage:
    """Invoke the LLM, stream tokens, emit llm_call telemetry, return the
    accumulated AIMessage."""
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
        run_id=run_id, agent_id=agent_id, model=model_name,
        latency_ms=latency_ms, input_tokens=input_tokens, output_tokens=output_tokens,
        tool_calls=len(tool_calls), streamed_chars=streamed_chars,
    ))
    log.info(
        "llm_call agent=%s model=%s latency_ms=%d in_tok=%d out_tok=%d tool_calls=%d chars=%d",
        agent_id[:8], model_name, latency_ms, input_tokens, output_tokens,
        len(tool_calls), streamed_chars,
    )
    return AIMessage(content=text, tool_calls=tool_calls)


def _build_agent_builtins(run_id: str, agent_id: str, plans: RunPlanStore, files: RunFileStore,
                          board: RunBlackboard, region: str | None = None,
                          stage_state: dict | None = None,
                          worker_pool: WorkerPool | None = None):
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
        bus.publish(ev.plan_update(
            run_id=run_id, agent_id=agent_id,
            todos=plan.as_list(), revision=plan.revision,
        ))
        return json.dumps({"ok": True, "revision": plan.revision, "items": plan.as_list()})

    @tool
    def write_file(path: str, content: str) -> str:
        """Save content to a named file in this run's memory store. Use this to
        offload large intermediate results so they don't bloat your prompt."""
        f = files.write(agent_id, path, content)
        bus.publish(ev.file_write(run_id=run_id, agent_id=agent_id, path=f.path, size=f.size))
        return json.dumps({"path": f.path, "size": f.size})

    @tool
    def read_file(path: str) -> str:
        """Read a file previously saved with write_file. Returns the file's content."""
        f = files.read(path)
        if f is None:
            return json.dumps({"error": f"no file at {path!r}"})
        bus.publish(ev.file_read(run_id=run_id, agent_id=agent_id, path=f.path, size=f.size))
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
            bus.publish(ev.plan_update(
                run_id=run_id, agent_id=agent_id,
                todos=plan.as_list(), revision=plan.revision,
            ))
            return json.dumps({"ok": True, "revision": plan.revision, "reason": reason})

        out.extend([start_stage, complete_stage, replan])

    if worker_pool is not None:
        @tool
        def acquire_worker(role: str, scope: str) -> str:
            """Spawn a long-lived worker that stays alive across multiple tool
            calls. Returns the worker_id; use release_worker(worker_id, summary)
            when the delegated task is done."""
            w = worker_pool.acquire(role, scope)
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
        w = runner.spawn(role=role, scope=scope, parent=parent, layer=role, region=region)
        w.start()
        return w

    def _finish(w, result):
        w.end(result)
        w.terminate("completed")

    @tool
    def list_pending_invoices(limit: int = 3) -> str:
        """Return up to `limit` pending invoices in this region as JSON."""
        out = []
        for inv in region_invoices[:max(1, min(limit, 5))]:
            v = region_vendors.get(inv.vendor_id)
            rail = v.preferred_rails[0].value if v and v.preferred_rails else "WIRE"
            out.append({
                "invoice_id": inv.id, "vendor_id": inv.vendor_id,
                "amount": float(inv.amount_local), "currency": inv.currency,
                "preferred_rail": rail,
            })
        return json.dumps(out)

    @tool
    def extract_invoice_data(invoice_id: str) -> str:
        """OCR-extract invoice data. Spawns an invoice-intake worker."""
        w = _worker("invoice-intake", f"extract:{invoice_id}")
        try:
            return json.dumps(tool_fns.extract_invoice(run_id, w.id, invoice_id, f"doc-{invoice_id}"))
        finally:
            _finish(w, {"invoice_id": invoice_id})

    @tool
    def match_invoice_in_ledger(invoice_id: str, vendor_id: str, amount: float, currency: str) -> str:
        """Match an invoice against the ledger. Spawns a ledger-match worker."""
        w = _worker("ledger-match", f"match:{invoice_id}")
        try:
            return json.dumps(tool_fns.netsuite_match_invoice(run_id, w.id, vendor_id, invoice_id, float(amount), currency))
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
            return json.dumps(tool_fns.get_fx_rate(run_id, w.id, from_currency, to_currency))
        finally:
            _finish(w, {"from": from_currency, "to": to_currency})

    @tool
    def lookup_withholding_rate(currency: str) -> str:
        """Look up the withholding tax rate for this region + currency. Spawns a route-optimization worker."""
        w = _worker("route-optimization", f"withholding:{region}:{currency}")
        try:
            return json.dumps(tool_fns.get_withholding_rate(run_id, w.id, region, currency))
        finally:
            _finish(w, {"currency": currency})

    @tool
    def submit_payment(vendor_id: str, amount: float, currency: str, rail: str, reference: str) -> str:
        """Submit a payment to the banking provider. Spawns a payment-execution worker."""
        w = _worker("payment-execution", f"payment:{reference}")
        try:
            return json.dumps(tool_fns.submit_payment(run_id, w.id, vendor_id, float(amount), currency, rail, reference))
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
        list_pending_invoices, extract_invoice_data, match_invoice_in_ledger,
        check_vendor_compliance, lookup_fx_rate, lookup_withholding_rate,
        submit_payment, record_audit,
    ]


async def _turn_loop(run_id, agent, model_name, llm_with_tools, summarizer, mem, tool_map,
                      *, stage_budget: int, state: dict):
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
        ai_msg = await _stream_assistant(run_id, agent.id, model_name, llm_with_tools, mem.as_prompt())
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
                    bus.publish(ev.tool_result(
                        run_id, agent.id, name,
                        {"result": result_str[:400], "truncated": len(result_str) > 400},
                    ))
                    return tc, name, result_str
                except RunCancelled:
                    raise
                except Exception as exc:
                    last_exc = exc
                    attempt += 1
                    bus.publish(ev.tool_retry(run_id, agent.id, name, attempt, str(exc)[:200]))
                    if attempt >= 3:
                        break
                    await asyncio.sleep(0.1 * (2 ** (attempt - 1)))
            err = json.dumps({"error": f"tool {name!r} failed after {attempt} attempts: {last_exc}"})
            bus.publish(ev.tool_result(run_id, agent.id, name, {"result": err, "truncated": False}))
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


async def _drive_stages(run_id, agent, model_name, llm_with_tools, summarizer, mem, tool_map,
                         *, stage_budget: int = STAGE_BUDGET, total_budget: int = TOTAL_BUDGET):
    """Run successive stages until the LLM stops requesting tools or budgets
    are exhausted. Each call to complete_stage exits the inner turn loop so a
    new stage starts with a fresh budget."""
    state = {"total_used": 0, "tool_calls": 0, "stage_done": False, "current": None,
             "total_budget": total_budget}
    while state["total_used"] < total_budget:
        state["stage_done"] = False
        before = state["total_used"]
        await _turn_loop(
            run_id=run_id, agent=agent, model_name=model_name,
            llm_with_tools=llm_with_tools, summarizer=summarizer,
            mem=mem, tool_map=tool_map, stage_budget=stage_budget, state=state,
        )
        if not state["stage_done"]:
            break
        if state["total_used"] == before:
            break
    return state["tool_calls"]


async def _run_regional_orchestrator(run_id, runner, parent, memory_store, plans, files, board,
                                     parent_summary, region, focus, model_name, summarizer_model):
    cfg = get_config()
    region_meta = REGIONS.get(region)
    if region_meta is None:
        raise ValueError(f"Unknown region {region!r}")

    ro = runner.spawn(
        role="regional-orchestrator", scope=f"region:{region}",
        parent=parent, layer="regional-orchestrator", region=region,
    )
    ro.start()

    pool = WorkerPool(run_id, runner, ro)
    stage_state = {"current": None}
    try:
        tools = [
            *_build_agent_builtins(run_id, ro.id, plans, files, board, region=region,
                                    stage_state=stage_state, worker_pool=pool),
            *_build_regional_domain_tools(run_id, runner, ro, region),
        ]
        tool_map = {t.name: t for t in tools}

        llm = _make_llm(model_name, cfg.llm.temperature)
        llm_with_tools = llm.bind_tools(tools)
        summarizer = _make_llm(summarizer_model, 0.0)

        system_prompt = cfg.prompts.regionalOrchestrator.format(
            region=region, region_name=region_meta.name,
            currency=region_meta.currency,
            focus=focus or "process the pending batch end-to-end",
        )
        mem = memory_store.open(
            agent_id=ro.id,
            system=SystemMessage(content=system_prompt),
            seed_summary=parent_summary,
        )
        mem.append(HumanMessage(content=(
            f"Begin now. Your first turn MUST be a write_todos call "
            f"listing your specific planned steps for focus={focus!r}."
        )))
        _emit_memory_snapshot(run_id, mem)

        tool_calls = await _drive_stages(
            run_id=run_id, agent=ro, model_name=model_name,
            llm_with_tools=llm_with_tools, summarizer=summarizer,
            mem=mem, tool_map=tool_map,
        )
    finally:
        pool.drain("cancelled")

    result = {"region": region, "toolCalls": tool_calls}
    ro.end(result)
    ro.terminate("completed")
    return result


def _build_workflow_domain_tools(run_id, runner, parent, workflow_id):
    """Tools available to a Workflow Orchestrator. Each domain action spawns a
    short-lived worker so events carry per-action attribution."""

    def _worker(role: str, scope: str) -> AgentHandle:
        w = runner.spawn(role=role, scope=scope, parent=parent, layer=role, region=None)
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
            return json.dumps(tool_fns.refresh_vendor_compliance(run_id, w.id, vendor_id))
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
    def get_cash_position(region: str = "GLOBAL") -> str:
        """Return cash position for a region or globally if region omitted."""
        w = _worker("treasury", f"cash:{region}")
        try:
            return json.dumps(tool_fns.get_cash_position(run_id, w.id, region))
        finally:
            _finish(w, {"region": region})

    @tool
    def forecast_liquidity(horizon_days: int = 30) -> str:
        """Forecast inflow/outflow over a horizon (7, 30, or 90 days)."""
        w = _worker("treasury", f"forecast:{horizon_days}")
        try:
            return json.dumps(tool_fns.forecast_liquidity(run_id, w.id, int(horizon_days)))
        finally:
            _finish(w, {"horizon_days": horizon_days})

    @tool
    def place_fx_hedge(from_currency: str, to_currency: str, notional: float, tenor_days: int = 90) -> str:
        """Place a forward FX hedge."""
        w = _worker("treasury", f"hedge:{from_currency}->{to_currency}")
        try:
            return json.dumps(tool_fns.place_fx_hedge(
                run_id, w.id, from_currency, to_currency, float(notional), int(tenor_days)))
        finally:
            _finish(w, {"from": from_currency, "to": to_currency})

    @tool
    def transfer_funds(from_region: str, to_region: str, amount_usd: float) -> str:
        """Move cash between regional operating accounts."""
        w = _worker("treasury", f"transfer:{from_region}->{to_region}")
        try:
            return json.dumps(tool_fns.transfer_funds(
                run_id, w.id, from_region, to_region, float(amount_usd)))
        finally:
            _finish(w, {"from": from_region, "to": to_region})

    @tool
    def post_journal_entry(account_id: str, amount: float, currency: str, period: str) -> str:
        """Post a journal entry to the GL for a given period."""
        w = _worker("close", f"je:{account_id}")
        try:
            return json.dumps(tool_fns.post_journal_entry(
                run_id, w.id, account_id, float(amount), currency, period))
        finally:
            _finish(w, {"account_id": account_id})

    @tool
    def reconcile_account(account_id: str) -> str:
        """Reconcile a GL account against bank/sub-ledger balance."""
        w = _worker("close", f"recon:{account_id}")
        try:
            return json.dumps(tool_fns.reconcile_account(run_id, w.id, account_id))
        finally:
            _finish(w, {"account_id": account_id})

    @tool
    def compute_accrual(category: str, period: str) -> str:
        """Compute an accrual for a category in a period."""
        w = _worker("close", f"accrual:{category}")
        try:
            return json.dumps(tool_fns.compute_accrual(run_id, w.id, category, period))
        finally:
            _finish(w, {"category": category})

    @tool
    def close_period(period: str) -> str:
        """Close an accounting period (e.g. '2026-04')."""
        w = _worker("close", f"close:{period}")
        try:
            return json.dumps(tool_fns.close_period(run_id, w.id, period))
        finally:
            _finish(w, {"period": period})

    @tool
    def aml_monitor_transaction(vendor_id: str, amount: float, currency: str) -> str:
        """Run AML monitoring on a transaction."""
        w = _worker("compliance", f"aml:{vendor_id}")
        try:
            return json.dumps(tool_fns.aml_monitor_transaction(
                run_id, w.id, vendor_id, float(amount), currency))
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
    def prepare_regulatory_filing(filing_type: str, period: str) -> str:
        """Prepare a regulatory filing draft."""
        w = _worker("compliance", f"filing:{filing_type}")
        try:
            return json.dumps(tool_fns.prepare_regulatory_filing(
                run_id, w.id, filing_type, period))
        finally:
            _finish(w, {"filing_type": filing_type})

    @tool
    def attest_control(control_id: str) -> str:
        """Attest a SOX/internal control."""
        w = _worker("compliance", f"control:{control_id}")
        try:
            return json.dumps(tool_fns.attest_control(run_id, w.id, control_id))
        finally:
            _finish(w, {"control_id": control_id})

    @tool
    def issue_customer_invoice(customer_id: str, amount: float, currency: str) -> str:
        """Issue a customer invoice."""
        w = _worker("receivables", f"ar-issue:{customer_id}")
        try:
            return json.dumps(tool_fns.issue_customer_invoice(
                run_id, w.id, customer_id, float(amount), currency))
        finally:
            _finish(w, {"customer_id": customer_id})

    @tool
    def send_dunning_notice(customer_id: str, stage: int) -> str:
        """Send a dunning notice (stage 1=reminder, 2=second notice, 3=collections)."""
        w = _worker("receivables", f"ar-dun:{customer_id}")
        try:
            return json.dumps(tool_fns.send_dunning_notice(run_id, w.id, customer_id, int(stage)))
        finally:
            _finish(w, {"customer_id": customer_id})

    @tool
    def apply_customer_payment(invoice_id: str, amount: float) -> str:
        """Apply a received customer payment to an open invoice."""
        w = _worker("receivables", f"ar-apply:{invoice_id}")
        try:
            return json.dumps(tool_fns.apply_customer_payment(
                run_id, w.id, invoice_id, float(amount)))
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
        kyb_screen_vendor, register_vendor, refresh_vendor_compliance, get_contract_terms_for_vendor,
        get_cash_position, forecast_liquidity, place_fx_hedge, transfer_funds,
        post_journal_entry, reconcile_account, compute_accrual, close_period,
        aml_monitor_transaction, sanctions_screen_batch, prepare_regulatory_filing, attest_control,
        issue_customer_invoice, send_dunning_notice, apply_customer_payment, get_ar_aging,
        record_audit,
    ]


async def _run_workflow_orchestrator(run_id, runner, parent, memory_store, plans, files, board,
                                     parent_summary, workflow_id, label, focus,
                                     model_name, summarizer_model):
    cfg = get_config()

    wo = runner.spawn(
        role="workflow-orchestrator", scope=f"workflow:{workflow_id}",
        parent=parent, layer="workflow-orchestrator", region=None,
    )
    wo.start()

    pool = WorkerPool(run_id, runner, wo)
    stage_state = {"current": None}
    try:
        tools = [
            *_build_agent_builtins(run_id, wo.id, plans, files, board, region=None,
                                    stage_state=stage_state, worker_pool=pool),
            *_build_workflow_domain_tools(run_id, runner, wo, workflow_id),
        ]
        tool_map = {t.name: t for t in tools}

        llm = _make_llm(model_name, cfg.llm.temperature)
        llm_with_tools = llm.bind_tools(tools)
        summarizer = _make_llm(summarizer_model, 0.0)

        system_prompt = cfg.prompts.workflowOrchestrator.format(
            label=label, focus=focus or "complete the operational task end-to-end",
        )
        mem = memory_store.open(
            agent_id=wo.id,
            system=SystemMessage(content=system_prompt),
            seed_summary=parent_summary,
        )
        mem.append(HumanMessage(content=(
            f"Begin now. Your first turn MUST be a write_todos call "
            f"listing your specific planned steps for focus={focus!r}."
        )))
        _emit_memory_snapshot(run_id, mem)

        tool_calls = await _drive_stages(
            run_id=run_id, agent=wo, model_name=model_name,
            llm_with_tools=llm_with_tools, summarizer=summarizer,
            mem=mem, tool_map=tool_map,
        )
    finally:
        pool.drain("cancelled")

    result = {"workflow_id": workflow_id, "toolCalls": tool_calls}
    wo.end(result)
    wo.terminate("completed")
    return result


def _build_fc_domain_tools(run_id, runner, fc, memory_store, plans, files, board, model_name,
                            summarizer_model, dispatched_regions: list[str],
                            dispatched_workflows: list[str], jobs: JobRegistry):
    cfg = get_config()
    workflow_map = {w.id: w for w in cfg.workflows}

    @tool
    async def dispatch_region(region: str, focus: str = "") -> str:
        """Dispatch a Regional Orchestrator sub-agent. Returns IMMEDIATELY with
        a job_id; the orchestrator runs in the background. You MUST follow up
        with await_jobs([job_id, ...]) before relying on the result.
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
            run_id, runner, fc, memory_store, plans, files, board,
            parent_summary, r, focus or "", model_name, summarizer_model,
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
        a job_id; the orchestrator runs in the background. You MUST follow up
        with await_jobs([job_id, ...]) before relying on the result.
        workflow_id must be one of: vendorLifecycle, treasury, close,
        compliance, receivables."""
        wf = workflow_map.get(workflow_id.strip())
        if wf is None:
            return json.dumps({"error": f"unknown workflow {workflow_id!r}"})
        dispatched_workflows.append(wf.id)
        fc_mem = memory_store.get(fc.id)
        parent_summary = (fc_mem.seed_summary if fc_mem else "") or (
            f"Finance Control dispatched workflow {wf.id} with focus: {focus or wf.focus}."
        )
        coro = _run_workflow_orchestrator(
            run_id, runner, fc, memory_store, plans, files, board,
            parent_summary, wf.id, wf.label, focus or wf.focus,
            model_name, summarizer_model,
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
                payload = r.get("result") if r["status"] == "completed" else {"error": r.get("error")}
                bus.publish(ev.job_completed(
                    run_id, fc.id, r["job_id"], r["status"], payload or {},
                    kind=r.get("kind", ""), target=r.get("target", ""),
                ))
        return json.dumps(results)

    return [dispatch_region, dispatch_workflow, await_jobs]


async def run_swarm(run_id: str, prompt: str) -> None:
    cfg = get_config()
    model_name = settings.model
    summarizer_model = cfg.llm.summarizerModel or model_name
    cancellation.register(run_id)
    bus.publish(ev.run_start(run_id, prompt))
    bus.publish(ev.chat_user(run_id, prompt))
    log.info("run_swarm start run_id=%s model=%s prompt=%r", run_id, model_name, prompt[:120])

    runner = create_runner(run_id)
    memory_store = RunMemoryStore(run_id, model_name)
    plans = RunPlanStore(run_id)
    files = RunFileStore(run_id=run_id)
    board = RunBlackboard(run_id)
    jobs = JobRegistry(run_id)

    fc = runner.spawn(
        role="finance-control", scope="global", parent=None,
        layer="finance-control", region=None,
    )
    fc.start()

    pool = WorkerPool(run_id, runner, fc)
    stage_state = {"current": None}
    dispatched_regions: list[str] = []
    dispatched_workflows: list[str] = []
    tools = [
        *_build_agent_builtins(run_id, fc.id, plans, files, board,
                                stage_state=stage_state, worker_pool=pool),
        *_build_fc_domain_tools(run_id, runner, fc, memory_store, plans, files, board, model_name,
                                 summarizer_model, dispatched_regions, dispatched_workflows, jobs),
    ]
    tool_map = {t.name: t for t in tools}
    llm = _make_llm(model_name, cfg.llm.temperature)
    llm_with_tools = llm.bind_tools(tools)
    summarizer = _make_llm(summarizer_model, 0.0)

    session_memory.add_user(prompt, run_id)
    ctx = session_memory.context_block()

    mem = memory_store.open(fc.id, SystemMessage(content=cfg.prompts.financeControl))
    if ctx:
        mem.append(SystemMessage(content=f"[Session context — prior runs and conversation]\n{ctx}"))
    mem.append(HumanMessage(content=prompt))
    _emit_memory_snapshot(run_id, mem)

    run_errors: list[str] = []
    run_status = "completed"
    try:
        await _drive_stages(
            run_id=run_id, agent=fc, model_name=model_name,
            llm_with_tools=llm_with_tools, summarizer=summarizer,
            mem=mem, tool_map=tool_map,
        )
        drained = await jobs.drain(timeout_s=180.0)
        for r in drained:
            if r["status"] in ("completed", "failed"):
                payload = r.get("result") if r["status"] == "completed" else {"error": r.get("error")}
                bus.publish(ev.job_completed(
                    run_id, fc.id, r["job_id"], r["status"], payload or {},
                    kind=r.get("kind", ""), target=r.get("target", ""),
                ))
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
        pool.drain("failed")
        if not fc._terminated:
            fc.terminate("failed")
        bus.publish(ev.run_end(run_id, "failed"))
    finally:
        cancellation.clear(run_id)
        last_ai = next(
            (m for m in reversed(mem.messages) if isinstance(m, AIMessage) and m.content),
            None,
        )
        if last_ai:
            session_memory.add_assistant(str(last_ai.content), run_id)
        session_memory.record_run(RunRecord(
            run_id=run_id,
            prompt=prompt,
            status=run_status,
            regions=list(dispatched_regions),
            errors=run_errors,
        ))
