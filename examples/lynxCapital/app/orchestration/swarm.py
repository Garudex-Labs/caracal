"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

LLM-driven orchestration with DeepAgents-style planning, file-backed memory, streaming, compaction, and cancellation.
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
from app.core.memory import AgentMemory, RunMemoryStore, context_limit
from app.core.plans import RunPlanStore
from app.core.session_memory import RunRecord, session_memory
from app.core.settings import settings
from app.events import types as ev
from app.events.bus import bus

log = logging.getLogger("lynx.swarm")
log.setLevel(logging.INFO)
if not log.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("[%(asctime)s] %(name)s %(levelname)s %(message)s"))
    log.addHandler(_h)


REGION_IDS = ("US", "IN", "DE", "SG", "BR")


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


# ---------- DeepAgents built-ins: planning + files ----------


def _build_agent_builtins(run_id: str, agent_id: str, plans: RunPlanStore, files: RunFileStore,
                          board: RunBlackboard, region: str | None = None):
    """Planning, file, and blackboard tools scoped to one agent_id so events
    carry correct attribution."""

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

    return [write_todos, write_file, read_file, ls_files, post_finding, read_findings]


# ---------- Regional domain tools ----------


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


# ---------- Turn loop ----------


async def _turn_loop(run_id, agent, model_name, llm_with_tools, summarizer, mem, tool_map, max_turns):
    """Run the assistant turn loop for one agent. Independent tool calls in a
    single turn are executed concurrently, with bounded retries on transient
    exceptions. Returns total tool calls executed."""
    tool_calls_total = 0
    for _turn in range(max_turns):
        _check_cancel(run_id)
        await _maybe_compact(run_id, mem, summarizer)
        ai_msg = await _stream_assistant(run_id, agent.id, model_name, llm_with_tools, mem.as_prompt())
        mem.append(ai_msg)
        _emit_memory_snapshot(run_id, mem)
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
                tool_calls_total += 1
        _emit_memory_snapshot(run_id, mem)
    return tool_calls_total


# ---------- Regional orchestrator ----------


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

    tools = [
        *_build_agent_builtins(run_id, ro.id, plans, files, board, region=region),
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

    tool_calls = await _turn_loop(
        run_id=run_id, agent=ro, model_name=model_name,
        llm_with_tools=llm_with_tools, summarizer=summarizer,
        mem=mem, tool_map=tool_map, max_turns=16,
    )

    result = {"region": region, "toolCalls": tool_calls}
    ro.end(result)
    ro.terminate("completed")
    return result


# ---------- Finance Control tools ----------


def _build_fc_domain_tools(run_id, runner, fc, memory_store, plans, files, board, model_name,
                            summarizer_model, dispatched_regions: list[str]):
    @tool
    async def dispatch_region(region: str, focus: str = "") -> str:
        """Dispatch a Regional Orchestrator sub-agent to process one region.
        region must be one of: US, IN, DE, SG, BR. `focus` is a short sentence
        describing the intent for this dispatch."""
        r = region.upper().strip()
        if r not in REGION_IDS:
            return json.dumps({"error": f"unknown region {region!r}"})
        dispatched_regions.append(r)
        fc_mem = memory_store.get(fc.id)
        parent_summary = (fc_mem.seed_summary if fc_mem else "") or (
            f"Finance Control dispatched region {r} with focus: {focus or '(none)'}."
        )
        try:
            result = await _run_regional_orchestrator(
                run_id, runner, fc, memory_store, plans, files, board,
                parent_summary, r, focus or "", model_name, summarizer_model,
            )
            return json.dumps(result)
        except Exception as exc:
            return json.dumps({"error": str(exc), "region": r, "toolCalls": 0})

    return [dispatch_region]


# ---------- Top-level entry ----------


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

    fc = runner.spawn(
        role="finance-control", scope="global", parent=None,
        layer="finance-control", region=None,
    )
    fc.start()

    dispatched_regions: list[str] = []
    tools = [
        *_build_agent_builtins(run_id, fc.id, plans, files, board),
        *_build_fc_domain_tools(run_id, runner, fc, memory_store, plans, files, board, model_name,
                                 summarizer_model, dispatched_regions),
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
        await _turn_loop(
            run_id=run_id, agent=fc, model_name=model_name,
            llm_with_tools=llm_with_tools, summarizer=summarizer,
            mem=mem, tool_map=tool_map, max_turns=14,
        )
        fc.end({"status": "completed"})
        fc.terminate("completed")
        bus.publish(ev.run_end(run_id, "completed"))
        log.info("run_swarm end run_id=%s status=completed", run_id)
    except RunCancelled:
        run_status = "cancelled"
        log.info("run_swarm cancelled run_id=%s", run_id)
        bus.publish(ev.run_cancelled(run_id))
        if not fc._terminated:
            fc.terminate("cancelled")
        bus.publish(ev.run_end(run_id, "cancelled"))
    except Exception as exc:
        run_status = "failed"
        run_errors.append(str(exc))
        log.exception("run_swarm failed run_id=%s", run_id)
        bus.publish(ev.error(run_id, str(exc), fc.id))
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
