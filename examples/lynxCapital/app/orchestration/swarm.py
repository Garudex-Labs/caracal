"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

LLM-driven orchestration: DeepAgents-style planning (write_todos), file-backed
externalized memory, streaming prose reasoning, token-aware compaction,
cooperative cancellation, and runtime model selection.
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


FC_SYSTEM_PROMPT = """You are Finance Control, the orchestration assistant for Lynx Capital.

Lynx Capital runs a multi-region payment and payout platform. You have access to regional data and can dispatch Regional Orchestrator agents to process payouts across five regions: US, IN, DE, SG, BR.

HOW YOU DECIDE WHAT TO DO
Read the user's message carefully and respond to what was actually asked.

- If the message is a general question (about the platform, about a concept, asking for information), answer it directly in plain prose. Do not call any tools unless the question requires data you must look up.
- If the message requests a payout run, invoice processing, or regional dispatch, follow the plan-then-act loop below.
- If the message is ambiguous, answer conversationally and ask a clarifying question rather than launching a payout run.
- If the message is a follow-up like "what happened", "why did it fail", "show last run", or similar, answer from the session context provided below your system prompt. Reference the actual run IDs, statuses, regions, and errors from that context. Do not invent information.

PAYOUT CYCLE WORKFLOW (only when the user actually asks for it)
1. FIRST TURN: call write_todos with a concrete list of steps specific to what was requested. Mark the first step in_progress. Do not call domain tools on the first turn.
2. EACH FOLLOWING TURN: write one short prose sentence stating what you are about to do, then call the next tool. After a result comes back, write one sentence interpreting it, then update write_todos or call the next domain tool.
3. DOMAIN TOOLS:
   - dispatch_region(region, focus): hand off to a Regional Orchestrator. Use exactly: US, IN, DE, SG, BR.
   - write_file(path, content), read_file(path), ls_files(): offload large results or pass context forward.
4. FINAL TURN: mark all todos completed via write_todos, then output one short paragraph summarizing what was processed. Do not call tools on the final turn.

Only dispatch the regions the user asked about. If the user says "US only", dispatch only US. If no specific regions are mentioned in a payout request, dispatch all five.

PARTIAL AUTHORIZATION
A tool result may contain {"denied": true, "reason": "..."}. This means Caracal blocked that specific action. When this happens:
- Do NOT stop the entire run. Continue dispatching other regions.
- Note the denial in your final summary: which region was blocked and why.
- If ALL regions return denials, summarize the policy blocks clearly.
- Treat a partial result (some regions succeeded, some denied) as a partial success.

MEMORY
If session context is injected above the user message, it contains a summary of previous runs and recent conversation turns. Use it to answer follow-up questions accurately. If no prior runs exist, say so clearly rather than fabricating results.

Be concise, plain prose, no emojis, no marketing language."""


REGIONAL_SYSTEM_TEMPLATE = """You are the Regional Orchestrator agent for the {region} region ({region_name}, currency {currency}) at Lynx Capital.

Your ONLY job is to complete exactly what is described in this focus — nothing more: {focus}

HOW YOU WORK
You decide your own approach. No procedure is given.

1. FIRST TURN: call write_todos with the specific steps YOU decide are needed to complete this focus. Do not copy a template - think about what this specific focus actually requires. Mark the first step in_progress. Do not call any other tool on the first turn.

2. EACH FOLLOWING TURN: write ONE short prose sentence about what you are about to do and why, then call the next tool. After a tool returns, write ONE short sentence interpreting the result, then either update write_todos or call the next tool.

3. DOMAIN TOOLS available to you (pick what you need, in the order YOU decide):
   - list_pending_invoices(limit): inspect pending invoices
   - extract_invoice_data(invoice_id): OCR extract invoice data
   - match_invoice_in_ledger(invoice_id, vendor_id, amount, currency): reconcile against ERP
   - check_vendor_compliance(vendor_id): run compliance screening
   - lookup_fx_rate(from_currency, to_currency), lookup_withholding_rate(currency): tax/fx lookups
   - submit_payment(vendor_id, amount, currency, rail, reference): execute payment
   - record_audit(summary): seal an audit entry (call this at most once, at the end)
   - write_file, read_file, ls_files: offload large intermediate results

4. FINAL TURN: mark all todos completed via write_todos, then output ONE short status sentence. Do not call more tools.

PAYMENT EXECUTION RULES (only when your focus explicitly involves payment, settlement, or disbursement)
- If your focus includes payment: list_pending_invoices returns all fields you need: vendor_id, amount, currency, preferred_rail. You can call submit_payment directly — no OCR, ERP, or compliance required.
- If your focus is extraction, archiving, compliance screening, FX lookup, or other non-payment tasks: do NOT call submit_payment. Record what was attempted, what was denied, and stop.
- Use invoice_id as the reference value when submitting payment.

PARTIAL AUTHORIZATION
If a tool returns {{"denied": true, "reason": "..."}}, Caracal blocked that specific action. When this happens:
- Immediately skip that step and call the NEXT tool in your plan. Do not pause or summarize.
- A denial on extract_invoice_data, match_invoice_in_ledger, check_vendor_compliance, lookup_fx_rate, or lookup_withholding_rate NEVER blocks submit_payment — but only if payment is part of your focus.
- After all pre-payment steps (whether they succeeded or were denied), attempt submit_payment for each vendor if payment was requested in your focus.
- Only mark a payment as blocked if submit_payment itself returns {{"denied": true}}.
- Never retry a denied tool in the same run.
- Record all denials and outcomes in record_audit at the end.

Real services are executed; you are not simulating. Be concise, plain prose, no emojis."""


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


def _build_agent_builtins(run_id: str, agent_id: str, plans: RunPlanStore, files: RunFileStore):
    """Planning + file tools scoped to one agent_id so events carry correct attribution."""

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

    return [write_todos, write_file, read_file, ls_files]


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
    """Run the assistant turn loop for one agent. Publishes tool_call / tool_result
    for every invocation. Returns number of tool calls executed."""
    tool_calls_total = 0
    for _turn in range(max_turns):
        _check_cancel(run_id)
        await _maybe_compact(run_id, mem, summarizer)
        ai_msg = await _stream_assistant(run_id, agent.id, model_name, llm_with_tools, mem.as_prompt())
        mem.append(ai_msg)
        _emit_memory_snapshot(run_id, mem)
        if not ai_msg.tool_calls:
            break
        for tc in ai_msg.tool_calls:
            _check_cancel(run_id)
            name = tc["name"]
            args = tc["args"]
            fn = tool_map.get(name)
            if fn is None:
                mem.append(ToolMessage(content=f"Unknown tool: {name}", tool_call_id=tc["id"]))
                continue
            bus.publish(ev.tool_call(run_id, agent.id, name, args))
            try:
                result = await asyncio.to_thread(fn.invoke, args)
                result_str = str(result)
                bus.publish(ev.tool_result(
                    run_id, agent.id, name,
                    {"result": result_str[:400], "truncated": len(result_str) > 400},
                ))
            except PermissionError as exc:
                result_str = json.dumps({"denied": True, "tool": name, "reason": str(exc)})
                bus.publish(ev.caracal_enforce(run_id, agent.id, name, "deny", str(exc)))
            tool_calls_total += 1
            mem.append(ToolMessage(content=result_str, tool_call_id=tc["id"]))
        _emit_memory_snapshot(run_id, mem)
    return tool_calls_total


# ---------- Regional orchestrator ----------


async def _run_regional_orchestrator(run_id, runner, parent, memory_store, plans, files,
                                     parent_summary, region, focus, model_name):
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
        *_build_agent_builtins(run_id, ro.id, plans, files),
        *_build_regional_domain_tools(run_id, runner, ro, region),
    ]
    tool_map = {t.name: t for t in tools}

    llm = _make_llm(model_name, cfg.llm.temperature)
    llm_with_tools = llm.bind_tools(tools)
    summarizer = _make_llm(model_name, 0.0)

    system_prompt = REGIONAL_SYSTEM_TEMPLATE.format(
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


def _build_fc_domain_tools(run_id, runner, fc, memory_store, plans, files, loop, model_name,
                            dispatched_regions: list[str]):
    @tool
    def dispatch_region(region: str, focus: str = "") -> str:
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
        future = asyncio.run_coroutine_threadsafe(
            _run_regional_orchestrator(
                run_id, runner, fc, memory_store, plans, files,
                parent_summary, r, focus or "", model_name,
            ),
            loop,
        )
        try:
            return json.dumps(future.result())
        except PermissionError:
            raise
        except Exception as exc:
            return json.dumps({"error": str(exc), "region": r, "toolCalls": 0})

    return [dispatch_region]


# ---------- Top-level entry ----------


async def run_swarm(run_id: str, prompt: str) -> None:
    cfg = get_config()
    model_name = settings.model
    cancellation.register(run_id)
    bus.publish(ev.run_start(run_id, prompt))
    bus.publish(ev.chat_user(run_id, prompt))
    log.info("run_swarm start run_id=%s model=%s prompt=%r", run_id, model_name, prompt[:120])

    runner = create_runner(run_id)
    memory_store = RunMemoryStore(run_id, model_name)
    plans = RunPlanStore(run_id)
    files = RunFileStore(run_id=run_id)

    fc = runner.spawn(
        role="finance-control", scope="global", parent=None,
        layer="finance-control", region=None,
    )
    fc.start()

    loop = asyncio.get_running_loop()
    dispatched_regions: list[str] = []
    tools = [
        *_build_agent_builtins(run_id, fc.id, plans, files),
        *_build_fc_domain_tools(run_id, runner, fc, memory_store, plans, files, loop, model_name,
                                 dispatched_regions),
    ]
    tool_map = {t.name: t for t in tools}
    llm = _make_llm(model_name, cfg.llm.temperature)
    llm_with_tools = llm.bind_tools(tools)
    summarizer = _make_llm(model_name, 0.0)

    session_memory.add_user(prompt, run_id)
    ctx = session_memory.context_block()

    mem = memory_store.open(fc.id, SystemMessage(content=FC_SYSTEM_PROMPT))
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
    except PermissionError as exc:
        run_status = "denied"
        run_errors.append(str(exc))
        log.warning("run_swarm denied run_id=%s reason=%s", run_id, exc)
        bus.publish(ev.error(run_id, str(exc), fc.id))
        if not fc._terminated:
            fc.terminate("denied")
        bus.publish(ev.run_end(run_id, "denied"))
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
