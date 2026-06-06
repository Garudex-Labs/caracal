"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Relay Automation domain: mandate-guarded MCP workflow platform with DAG executions, queue concurrency, signals, retries, and a hash-chained execution audit trail.
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone

from _mock.providerlab.data import generators as gen
from _mock.providerlab.providers import base
from _mock.providerlab.providers.base import Ctx, DomainError

ID = "relay-automation"

WORKFLOWS_READ = "relay.workflows.read"
EXECUTIONS_READ = "relay.executions.read"
EXECUTIONS_WRITE = "relay.executions.write"

_TERMINAL = ("succeeded", "failed", "cancelled", "timed_out")
_ACTIVE = ("queued", "running", "waiting_signal", "retrying")

# Per-execution outcome bands drawn from a deterministic RNG. Most runs succeed;
# the rest model the failure modes a real automation platform surfaces.
_OUTCOME_BANDS = (("success", 0.60), ("transient", 0.78), ("failure", 0.90), ("timeout", 1.0))

# Workflow definitions model finance-operations automations as step DAGs. Each
# step is a typed task; `approval` steps pause the run for a human signal.
_WORKFLOWS: tuple[dict, ...] = (
    {
        "id": "ap_invoice_close",
        "name": "AP Invoice Close",
        "description": "Match, tax-determine, approve, and post a batch of accounts-payable invoices to the ledger.",
        "version": 7,
        "triggerTypes": ["api", "schedule"],
        "schedule": "0 18 * * 1-5",
        "queue": "ap-batch",
        "concurrencyLimit": 2,
        "priority": "normal",
        "timeoutSeconds": 3600,
        "retryPolicy": {"maxAttempts": 3, "backoff": "exponential",
                        "retryableErrors": ["ledger_unavailable", "match_timeout"]},
        "tags": ["accounts-payable", "ledger", "batch"],
        "owner": "ap-automation@lynx.example",
        "steps": [
            {"id": "fetch_invoices", "name": "Fetch pending invoices", "type": "task",
             "action": "ironbark-erp.list_bills", "retryable": True, "timeoutSeconds": 120},
            {"id": "three_way_match", "name": "Three-way match", "type": "task",
             "action": "ironbark-erp.match_invoice", "retryable": True, "timeoutSeconds": 300},
            {"id": "tax_determination", "name": "Determine tax", "type": "task",
             "action": "sabre-tax.calculate_tax", "retryable": True, "timeoutSeconds": 120},
            {"id": "controller_approval", "name": "Controller approval", "type": "approval",
             "action": "human.approve", "retryable": False, "timeoutSeconds": 86400},
            {"id": "post_to_ledger", "name": "Post to ledger", "type": "task",
             "action": "slate-ledger.post_entry", "retryable": True, "timeoutSeconds": 180},
            {"id": "notify_team", "name": "Notify AP team", "type": "notification",
             "action": "vela-notify.send_message", "retryable": False, "timeoutSeconds": 60},
        ],
    },
    {
        "id": "vendor_onboarding",
        "name": "Vendor Onboarding",
        "description": "Create a vendor, screen it, verify banking, collect documents, and activate on approval.",
        "version": 5,
        "triggerTypes": ["api", "event"],
        "schedule": None,
        "queue": "onboarding",
        "concurrencyLimit": 4,
        "priority": "normal",
        "timeoutSeconds": 7200,
        "retryPolicy": {"maxAttempts": 2, "backoff": "fixed",
                        "retryableErrors": ["screening_timeout"]},
        "tags": ["vendor", "kyb", "onboarding"],
        "owner": "vendor-ops@lynx.example",
        "steps": [
            {"id": "create_record", "name": "Create vendor record", "type": "task",
             "action": "atlas-vendor.register_vendor", "retryable": True, "timeoutSeconds": 60},
            {"id": "kyb_screening", "name": "KYB / sanctions screening", "type": "task",
             "action": "aegis-screening.verify_business", "retryable": True, "timeoutSeconds": 300},
            {"id": "banking_verification", "name": "Verify banking", "type": "task",
             "action": "atlas-vendor.verify_vendor_banking", "retryable": True, "timeoutSeconds": 180},
            {"id": "document_collection", "name": "Collect documents", "type": "task",
             "action": "atlas-vendor.submit_vendor_document", "retryable": True, "timeoutSeconds": 120},
            {"id": "onboarding_approval", "name": "Procurement approval", "type": "approval",
             "action": "human.approve", "retryable": False, "timeoutSeconds": 86400},
            {"id": "activation", "name": "Activate vendor", "type": "task",
             "action": "atlas-vendor.set_vendor_status", "retryable": True, "timeoutSeconds": 60},
        ],
    },
    {
        "id": "statement_reconciliation",
        "name": "Statement Reconciliation",
        "description": "Import a bank statement, normalize lines, and reconcile against the ledger with an exception report.",
        "version": 11,
        "triggerTypes": ["schedule"],
        "schedule": "0 6 * * *",
        "queue": "recon",
        "concurrencyLimit": 3,
        "priority": "high",
        "timeoutSeconds": 1800,
        "retryPolicy": {"maxAttempts": 4, "backoff": "exponential",
                        "retryableErrors": ["match_timeout", "ledger_unavailable"]},
        "tags": ["reconciliation", "treasury", "scheduled"],
        "owner": "treasury-ops@lynx.example",
        "steps": [
            {"id": "import_statement", "name": "Import statement", "type": "task",
             "action": "halcyon-bank.get_statement", "retryable": True, "timeoutSeconds": 120},
            {"id": "normalize_lines", "name": "Normalize lines", "type": "task",
             "action": "relay.transform", "retryable": True, "timeoutSeconds": 90},
            {"id": "match_transactions", "name": "Match transactions", "type": "task",
             "action": "slate-ledger.reconcile_account", "retryable": True, "timeoutSeconds": 600},
            {"id": "exception_report", "name": "Build exception report", "type": "task",
             "action": "relay.report", "retryable": False, "timeoutSeconds": 120},
        ],
    },
    {
        "id": "payout_release",
        "name": "Payout Release",
        "description": "Validate a disbursement batch, lock FX, hold for compliance approval, release funds, and confirm settlement.",
        "version": 9,
        "triggerTypes": ["api"],
        "schedule": None,
        "queue": "payments",
        "concurrencyLimit": 1,
        "priority": "critical",
        "timeoutSeconds": 5400,
        "retryPolicy": {"maxAttempts": 3, "backoff": "exponential",
                        "retryableErrors": ["settlement_pending", "rail_unavailable"]},
        "tags": ["payments", "payout", "treasury"],
        "owner": "payments-ops@lynx.example",
        "steps": [
            {"id": "validate_batch", "name": "Validate batch", "type": "task",
             "action": "quetzal-payouts.create_batch", "retryable": True, "timeoutSeconds": 120},
            {"id": "fx_lock", "name": "Lock FX rate", "type": "task",
             "action": "cordoba-fx.create_conversion", "retryable": True, "timeoutSeconds": 90},
            {"id": "compliance_hold", "name": "Compliance release approval", "type": "approval",
             "action": "human.approve", "retryable": False, "timeoutSeconds": 172800},
            {"id": "release_funds", "name": "Release funds", "type": "task",
             "action": "quetzal-payouts.create_payout", "retryable": True, "timeoutSeconds": 300},
            {"id": "settlement_callback", "name": "Confirm settlement", "type": "task",
             "action": "quetzal-payouts.get_payout", "retryable": True, "timeoutSeconds": 600},
        ],
    },
    {
        "id": "period_close",
        "name": "Financial Period Close",
        "description": "Post accruals and intercompany entries, revalue FX, run the trial balance, and lock the accounting period.",
        "version": 4,
        "triggerTypes": ["api", "schedule"],
        "schedule": "0 2 1 * *",
        "queue": "close",
        "concurrencyLimit": 1,
        "priority": "high",
        "timeoutSeconds": 10800,
        "retryPolicy": {"maxAttempts": 2, "backoff": "fixed",
                        "retryableErrors": ["ledger_unavailable"]},
        "tags": ["close", "ledger", "accounting"],
        "owner": "controller@lynx.example",
        "steps": [
            {"id": "post_accruals", "name": "Post accruals", "type": "task",
             "action": "slate-ledger.create_accrual", "retryable": True, "timeoutSeconds": 300},
            {"id": "intercompany", "name": "Intercompany entries", "type": "task",
             "action": "slate-ledger.post_entry", "retryable": True, "timeoutSeconds": 300},
            {"id": "fx_revaluation", "name": "FX revaluation", "type": "task",
             "action": "cordoba-fx.get_quote", "retryable": True, "timeoutSeconds": 240},
            {"id": "trial_balance", "name": "Trial balance", "type": "task",
             "action": "slate-ledger.trial_balance", "retryable": True, "timeoutSeconds": 600},
            {"id": "lock_period", "name": "Lock period", "type": "task",
             "action": "slate-ledger.close_period", "retryable": False, "timeoutSeconds": 120},
        ],
    },
    {
        "id": "dunning_cycle",
        "name": "Dunning Cycle",
        "description": "Select overdue receivables, segment by aging, send reminder notices, and schedule collection follow-ups.",
        "version": 6,
        "triggerTypes": ["schedule", "api"],
        "schedule": "0 9 * * 1",
        "queue": "collections",
        "concurrencyLimit": 5,
        "priority": "low",
        "timeoutSeconds": 1200,
        "retryPolicy": {"maxAttempts": 3, "backoff": "exponential",
                        "retryableErrors": ["notify_throttled"]},
        "tags": ["collections", "receivables", "scheduled"],
        "owner": "ar-ops@lynx.example",
        "steps": [
            {"id": "select_overdue", "name": "Select overdue invoices", "type": "task",
             "action": "core-billing.get_ar_aging", "retryable": True, "timeoutSeconds": 120},
            {"id": "segment", "name": "Segment by aging", "type": "decision",
             "action": "relay.branch", "retryable": False, "timeoutSeconds": 30},
            {"id": "send_notices", "name": "Send dunning notices", "type": "notification",
             "action": "vela-notify.send_batch", "retryable": True, "timeoutSeconds": 180},
            {"id": "schedule_followups", "name": "Schedule follow-ups", "type": "task",
             "action": "core-billing.run_dunning_cycle", "retryable": True, "timeoutSeconds": 90},
        ],
    },
)

_WORKFLOW_INDEX = {w["id"]: w for w in _WORKFLOWS}
_QUEUES = {w["queue"]: w["concurrencyLimit"] for w in _WORKFLOWS}


# --------------------------------------------------------------------------- #
# time + identity helpers
# --------------------------------------------------------------------------- #
def _ts(offset_seconds: int = 0) -> str:
    moment = datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)
    return moment.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _trigger(ctx: Ctx) -> dict:
    """Capture the mandate principal so every run is traceable to the Caracal
    subject, session lineage, and delegation edge that dispatched it."""
    p = ctx.principal
    return {
        "type": "api",
        "subject": p.get("principal") or "anonymous",
        "subjectType": p.get("subjectType") or "application",
        "zone": p.get("zone"),
        "sessionId": p.get("sessionId"),
        "rootSessionId": p.get("rootSessionId"),
        "agentSessionId": p.get("agentSessionId"),
        "delegationEdgeId": p.get("delegationEdgeId"),
        "mandateId": p.get("mandateId"),
    }


def _system_trigger(subject: str, kind: str) -> dict:
    return {"type": kind, "subject": subject, "subjectType": "application", "zone": "lynx-zone",
            "sessionId": None, "rootSessionId": None, "agentSessionId": None,
            "delegationEdgeId": None, "mandateId": None}


# --------------------------------------------------------------------------- #
# audit (hash-chained, per execution)
# --------------------------------------------------------------------------- #
def _audit(execution: dict, kind: str, actor: str, details: dict, at: str | None = None) -> dict:
    prev = execution["auditTrail"][-1]["hash"] if execution["auditTrail"] else "genesis"
    when = at or _ts()
    digest = hashlib.sha256(
        f"{execution['executionId']}|{kind}|{actor}|{when}|{prev}".encode()).hexdigest()[:16]
    event = {"eventId": base.new_id("evt"), "executionId": execution["executionId"],
             "type": kind, "actor": actor, "at": when, "details": details,
             "prevHash": prev, "hash": digest}
    execution["auditTrail"].append(event)
    return event


def _chain_intact(execution: dict) -> bool:
    prev = "genesis"
    for event in execution["auditTrail"]:
        digest = hashlib.sha256(
            f"{execution['executionId']}|{event['type']}|{event['actor']}|{event['at']}|{prev}"
            .encode()).hexdigest()[:16]
        if digest != event["hash"]:
            return False
        prev = event["hash"]
    return True


# --------------------------------------------------------------------------- #
# seeding
# --------------------------------------------------------------------------- #
@base.seeder(ID)
def seed(state: base.State) -> None:
    state.tables["workflows"] = {w["id"]: dict(w) for w in _WORKFLOWS}
    state.tables["executions"] = {}
    state.tables["audit_events"] = {}
    state.tables["idempotency"] = {}
    state.tables["queues"] = {q: {"queue": q, "concurrencyLimit": limit}
                              for q, limit in _QUEUES.items()}
    _seed_history(state)


def _seed_history(state: base.State) -> None:
    """Replay a realistic backlog of executions across every terminal and active
    state. Tight queues are drained to terminal states so live dispatch can run;
    roomy queues keep a few in-flight and parked-on-approval executions."""
    actors = ("scheduler@relay", "ap-automation@lynx.example", "treasury-ops@lynx.example",
              "payments-ops@lynx.example")
    for wf in _WORKFLOWS:
        roomy = wf["concurrencyLimit"] >= 3
        for n in range(1, 9):
            rng = gen._rng(ID, "history", wf["id"], n)
            actor = rng.choice(actors)
            kind = "schedule" if wf["schedule"] and rng.random() < 0.7 else "api"
            age = rng.randint(1, 45) * 3600
            ex = _new_execution(
                state, wf, input_payload={"period": "2026-05", "batchSize": rng.randint(8, 240)},
                trigger=_system_trigger(actor, kind), idempotency_key=None,
                priority=wf["priority"], created_offset=-age,
            )
            stop = rng.random()
            if not roomy or stop < 0.78:
                _run_to_completion(state, ex, auto_signal=True, rng=rng)
            elif stop < 0.90:
                _run_to_completion(state, ex, auto_signal=False, rng=rng)  # may park on approval
            else:
                _advance(state, ex)  # leave mid-flight

    # Guarantee one execution parked on a human-approval signal for the active surface.
    showcase = _new_execution(
        state, _WORKFLOW_INDEX["vendor_onboarding"],
        input_payload={"vendor": "Northwind Robotics", "country": "US"},
        trigger=_system_trigger("vendor-ops@lynx.example", "api"),
        idempotency_key=None, priority="normal", created_offset=-5400,
    )
    showcase["_outcome"] = "success"
    showcase["_faultStep"] = None
    for _ in range(len(showcase["steps"])):
        if showcase["status"] == "waiting_signal":
            break
        _advance(state, showcase)


def _run_to_completion(state: base.State, ex: dict, *, auto_signal: bool, rng) -> None:
    guard = 0
    while ex["status"] in _ACTIVE and guard < 40:
        guard += 1
        if ex["status"] == "waiting_signal":
            if not auto_signal:
                return
            _apply_signal(state, ex, "approve",
                          rng.choice(("controller@lynx.example", "cfo@lynx.example")),
                          "Approved per delegated authority.")
            continue
        if ex["status"] == "failed" and ex["attempt"] < ex["maxAttempts"] and rng.random() < 0.6:
            _apply_retry(state, ex, "scheduler@relay")
            continue
        _advance(state, ex)


# --------------------------------------------------------------------------- #
# execution lifecycle
# --------------------------------------------------------------------------- #
def _plan_outcome(execution_id: str) -> str:
    roll = gen._rng(ID, "outcome", execution_id).random()
    for label, ceiling in _OUTCOME_BANDS:
        if roll < ceiling:
            return label
    return "success"


def _queue_running(state: base.State, queue: str) -> int:
    return sum(1 for e in state.table("executions").values()
               if e["queue"] == queue and e["status"] in ("running", "waiting_signal", "retrying"))


def _new_execution(state: base.State, wf: dict, *, input_payload: dict, trigger: dict,
                   idempotency_key: str | None, priority: str, created_offset: int = 0) -> dict:
    exec_id = base.new_id("exec")
    outcome = _plan_outcome(exec_id)
    steps = [{"stepId": s["id"], "name": s["name"], "type": s["type"], "action": s["action"],
              "status": "pending", "attempt": 0, "startedAt": None, "finishedAt": None,
              "durationMs": None, "output": None, "error": None}
             for s in wf["steps"]]
    retryable_idx = [i for i, s in enumerate(wf["steps"]) if s["retryable"]]
    long_idx = max(range(len(wf["steps"])),
                   key=lambda i: wf["steps"][i].get("timeoutSeconds", 0))
    rng = gen._rng(ID, "plan", exec_id)
    fault_step = (rng.choice(retryable_idx) if outcome == "transient" and retryable_idx
                  else len(wf["steps"]) - 1 if outcome == "failure"
                  else long_idx if outcome == "timeout" else None)
    created = _ts(created_offset)
    limit = wf["concurrencyLimit"]
    queued = _queue_running(state, wf["queue"]) >= limit
    execution = {
        "executionId": exec_id,
        "workflowId": wf["id"],
        "workflowName": wf["name"],
        "workflowVersion": wf["version"],
        "status": "queued" if queued else "running",
        "priority": priority,
        "queue": wf["queue"],
        "input": input_payload,
        "output": None,
        "error": None,
        "attempt": 1,
        "maxAttempts": wf["retryPolicy"]["maxAttempts"],
        "currentStep": None,
        "steps": steps,
        "correlationId": base.new_id("corr"),
        "idempotencyKey": idempotency_key,
        "trigger": trigger,
        "metrics": {"totalSteps": len(steps), "completedSteps": 0, "retries": 0, "durationMs": 0},
        "_outcome": outcome,
        "_faultStep": fault_step,
        "_clock": created_offset,
        "scheduledAt": created,
        "startedAt": None if queued else created,
        "finishedAt": None,
        "updatedAt": created,
        "slaDueAt": _ts(created_offset + wf["timeoutSeconds"]),
        "expiresAt": _ts(created_offset + wf["timeoutSeconds"]),
        "auditTrail": [],
    }
    state.table("executions")[exec_id] = execution
    _audit(execution, "execution_queued", trigger["subject"],
           {"workflowId": wf["id"], "queue": wf["queue"], "priority": priority}, at=created)
    if not queued:
        _audit(execution, "execution_started", trigger["subject"],
               {"attempt": 1, "outcome": outcome}, at=created)
    if idempotency_key:
        state.table("idempotency")[f"{wf['id']}:{idempotency_key}"] = exec_id
    return execution


def _wf_step(execution: dict, index: int) -> dict:
    return _WORKFLOW_INDEX[execution["workflowId"]]["steps"][index]


def _advance(state: base.State, execution: dict) -> dict:
    """Advance a running execution by one step, honoring approvals, faults, and timeouts."""
    if execution["status"] == "queued":
        wf = _WORKFLOW_INDEX[execution["workflowId"]]
        if _queue_running(state, execution["queue"]) >= wf["concurrencyLimit"]:
            return execution
        execution["status"] = "running"
        execution["startedAt"] = _ts(execution["_clock"])
        execution["updatedAt"] = execution["startedAt"]
        _audit(execution, "execution_started", execution["trigger"]["subject"],
               {"attempt": execution["attempt"], "outcome": execution["_outcome"]})
    if execution["status"] != "running":
        return execution

    steps = execution["steps"]
    idx = next((i for i, s in enumerate(steps) if s["status"] in ("pending", "retrying")), None)
    if idx is None:
        return _finish_success(execution)

    spec = _wf_step(execution, idx)
    step = steps[idx]
    execution["currentStep"] = step["stepId"]
    rng = gen._rng(ID, "step", execution["executionId"], idx, execution["attempt"])
    duration = rng.randint(800, spec.get("timeoutSeconds", 120) * 80)
    execution["_clock"] += max(1, duration // 1000)
    at = _ts(execution["_clock"])

    if step["status"] == "pending":
        step["startedAt"] = at
    step["attempt"] += 1

    if spec["type"] == "approval":
        execution["status"] = "waiting_signal"
        execution["updatedAt"] = at
        _audit(execution, "approval_requested", "relay",
               {"step": step["stepId"], "approver": "controller"}, at=at)
        return execution

    if idx == execution["_faultStep"]:
        return _fail_step(execution, idx, at)

    step["status"] = "completed"
    step["finishedAt"] = at
    step["durationMs"] = duration
    step["output"] = {"ref": base.new_id(step["stepId"][:6] or "step")}
    execution["metrics"]["completedSteps"] += 1
    execution["updatedAt"] = at
    _audit(execution, "step_completed", "relay",
           {"step": step["stepId"], "durationMs": duration}, at=at)

    if all(s["status"] == "completed" for s in steps):
        return _finish_success(execution)
    return execution


def _fail_step(execution: dict, idx: int, at: str) -> dict:
    spec = _wf_step(execution, idx)
    step = execution["steps"][idx]
    outcome = execution["_outcome"]
    if outcome == "timeout":
        step["status"] = "timed_out"
        step["finishedAt"] = at
        step["error"] = {"code": "step_timeout",
                         "message": f"step exceeded {spec['timeoutSeconds']}s budget"}
        execution["status"] = "timed_out"
        execution["error"] = {"code": "execution_timeout", "step": step["stepId"],
                              "message": "workflow exceeded its timeout budget"}
        _audit(execution, "execution_timed_out", "relay",
               {"step": step["stepId"], "timeoutSeconds": spec["timeoutSeconds"]}, at=at)
    else:
        code = "ledger_unavailable" if outcome == "transient" else "validation_failed"
        retryable = outcome == "transient"
        step["status"] = "failed"
        step["finishedAt"] = at
        step["error"] = {"code": code, "retryable": retryable,
                         "message": f"{step['name']} failed: {code}"}
        execution["status"] = "failed"
        execution["error"] = {"code": code, "step": step["stepId"], "retryable": retryable,
                              "message": step["error"]["message"]}
        _audit(execution, "step_failed", "relay",
               {"step": step["stepId"], "code": code, "retryable": retryable}, at=at)
    execution["finishedAt"] = at
    execution["updatedAt"] = at
    return execution


def _finish_success(execution: dict) -> dict:
    at = _ts(execution["_clock"])
    execution["status"] = "succeeded"
    execution["currentStep"] = None
    execution["finishedAt"] = at
    execution["updatedAt"] = at
    execution["output"] = {
        "result": "completed",
        "artifacts": [{"stepId": s["stepId"], "ref": (s["output"] or {}).get("ref")}
                      for s in execution["steps"] if s.get("output")],
        "completedSteps": execution["metrics"]["completedSteps"],
    }
    started = execution.get("startedAt") or execution["scheduledAt"]
    execution["metrics"]["durationMs"] = max(0, execution["_clock"] - _offset_of(execution, started)) * 1000
    _audit(execution, "execution_succeeded", "relay",
           {"completedSteps": execution["metrics"]["completedSteps"]}, at=at)
    return execution


def _offset_of(execution: dict, iso: str) -> int:
    base_iso = execution["scheduledAt"]
    try:
        a = datetime.fromisoformat(base_iso.replace("Z", "+00:00"))
        b = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return int((b - a).total_seconds()) + execution["_clock"]
    except ValueError:
        return execution["_clock"]


def _apply_signal(state: base.State, execution: dict, decision: str, actor: str, note: str | None) -> dict:
    if execution["status"] != "waiting_signal":
        raise DomainError(409, "not_waiting", "execution is not waiting for a signal")
    idx = next(i for i, s in enumerate(execution["steps"]) if s["status"] == "pending")
    step = execution["steps"][idx]
    at = _ts(execution["_clock"])
    if decision == "approve":
        step["status"] = "completed"
        step["finishedAt"] = at
        step["output"] = {"decision": "approved", "approver": actor, "note": note}
        execution["metrics"]["completedSteps"] += 1
        execution["status"] = "running"
        execution["updatedAt"] = at
        _audit(execution, "approval_granted", actor, {"step": step["stepId"], "note": note}, at=at)
        if all(s["status"] == "completed" for s in execution["steps"]):
            _finish_success(execution)
    else:
        step["status"] = "rejected"
        step["finishedAt"] = at
        step["output"] = {"decision": "rejected", "approver": actor, "note": note}
        execution["status"] = "cancelled"
        execution["finishedAt"] = at
        execution["updatedAt"] = at
        execution["error"] = {"code": "approval_rejected", "step": step["stepId"], "message": note}
        _audit(execution, "approval_rejected", actor, {"step": step["stepId"], "note": note}, at=at)
    return execution


def _apply_retry(state: base.State, execution: dict, actor: str) -> dict:
    if execution["status"] not in ("failed", "timed_out"):
        raise DomainError(409, "not_retryable", "only failed or timed-out executions can be retried")
    if execution["attempt"] >= execution["maxAttempts"]:
        raise DomainError(409, "retries_exhausted",
                          f"execution reached its {execution['maxAttempts']}-attempt limit")
    execution["attempt"] += 1
    execution["metrics"]["retries"] += 1
    execution["error"] = None
    execution["_outcome"] = "success"
    execution["_faultStep"] = None
    for step in execution["steps"]:
        if step["status"] in ("failed", "timed_out"):
            step["status"] = "pending"
            step["error"] = None
            step["startedAt"] = None
            step["finishedAt"] = None
    execution["status"] = "running"
    at = _ts(execution["_clock"])
    execution["startedAt"] = execution["startedAt"] or at
    execution["finishedAt"] = None
    execution["updatedAt"] = at
    _audit(execution, "execution_retried", actor, {"attempt": execution["attempt"]}, at=at)
    return execution


# --------------------------------------------------------------------------- #
# projections
# --------------------------------------------------------------------------- #
def _workflow_summary(state: base.State, wf: dict) -> dict:
    runs = [e for e in state.table("executions").values() if e["workflowId"] == wf["id"]]
    finished = [e for e in runs if e["status"] in _TERMINAL]
    succeeded = sum(1 for e in finished if e["status"] == "succeeded")
    last = max((e["updatedAt"] for e in runs), default=None)
    return {
        "id": wf["id"], "name": wf["name"], "description": wf["description"],
        "version": wf["version"], "status": "enabled", "queue": wf["queue"],
        "priority": wf["priority"], "triggerTypes": wf["triggerTypes"],
        "schedule": wf["schedule"], "stepCount": len(wf["steps"]), "tags": wf["tags"],
        "owner": wf["owner"],
        "stats": {"totalRuns": len(runs),
                  "successRate": round(succeeded / len(finished), 3) if finished else None,
                  "activeRuns": sum(1 for e in runs if e["status"] in _ACTIVE),
                  "lastRunAt": last},
    }


def _execution_summary(ex: dict) -> dict:
    return {
        "executionId": ex["executionId"], "workflowId": ex["workflowId"],
        "workflowName": ex["workflowName"], "status": ex["status"],
        "priority": ex["priority"], "queue": ex["queue"], "attempt": ex["attempt"],
        "currentStep": ex["currentStep"], "correlationId": ex["correlationId"],
        "subject": ex["trigger"]["subject"], "createdAt": ex["scheduledAt"],
        "startedAt": ex["startedAt"], "finishedAt": ex["finishedAt"],
        "updatedAt": ex["updatedAt"],
        "progress": {"completed": ex["metrics"]["completedSteps"],
                     "total": ex["metrics"]["totalSteps"]},
    }


def _public(ex: dict) -> dict:
    """Strip simulation-internal keys from an execution before returning it."""
    return {k: v for k, v in ex.items() if not k.startswith("_") and k != "auditTrail"}


def _get_execution(ctx: Ctx) -> dict:
    ctx.require("executionId")
    ex = ctx.state.table("executions").get(ctx.payload["executionId"])
    if ex is None:
        raise DomainError(404, "execution_not_found", ctx.payload["executionId"])
    return ex


def _get_workflow(ctx: Ctx) -> dict:
    ctx.require("workflowId")
    wf = _WORKFLOW_INDEX.get(ctx.payload["workflowId"])
    if wf is None:
        raise DomainError(404, "workflow_not_found", ctx.payload["workflowId"])
    return wf


# --------------------------------------------------------------------------- #
# schema fragments
# --------------------------------------------------------------------------- #
_PAGE_PROPS = {
    "page": {"type": "integer", "minimum": 1, "default": 1},
    "pageSize": {"type": "integer", "minimum": 1, "maximum": 100, "default": 25}}
_EXEC_REF = {"type": "object", "properties": {
    "executionId": {"type": "string", "description": "Execution identifier, e.g. exec_3f2a1b9c4d5e"}},
    "required": ["executionId"]}
_EXEC_OUTPUT = {"type": "object", "properties": {
    "executionId": {"type": "string"}, "workflowId": {"type": "string"},
    "status": {"type": "string", "enum": list(_TERMINAL + _ACTIVE)},
    "attempt": {"type": "integer"}, "currentStep": {"type": ["string", "null"]}},
    "required": ["executionId", "status"]}


# --------------------------------------------------------------------------- #
# tools: workflow catalog
# --------------------------------------------------------------------------- #
@base.op(
    ID, "list_workflows",
    title="List workflows",
    description="List automation workflow definitions with run statistics, optionally "
                "filtered by queue, tag, or trigger type.",
    input_schema={"type": "object", "properties": {
        "queue": {"type": "string"},
        "tag": {"type": "string"},
        "triggerType": {"type": "string", "enum": ["api", "schedule", "event"]},
        "page": _PAGE_PROPS["page"], "pageSize": _PAGE_PROPS["pageSize"]}},
    annotations={"readOnlyHint": True, "idempotentHint": True})
def list_workflows(ctx: Ctx) -> dict:
    ctx.require_scope(WORKFLOWS_READ)
    queue, tag, trigger = ctx.get("queue"), ctx.get("tag"), ctx.get("triggerType")
    items = []
    for wf in _WORKFLOWS:
        if queue and wf["queue"] != queue:
            continue
        if tag and tag not in wf["tags"]:
            continue
        if trigger and trigger not in wf["triggerTypes"]:
            continue
        items.append(_workflow_summary(ctx.state, wf))
    return ctx.paginate(items)


@base.op(
    ID, "get_workflow",
    title="Get workflow definition",
    description="Retrieve a workflow's full definition: step DAG, schedule, queue, "
                "concurrency, retry policy, and run statistics.",
    input_schema={"type": "object", "properties": {
        "workflowId": {"type": "string", "description": "Workflow identifier, e.g. ap_invoice_close"}},
        "required": ["workflowId"]},
    annotations={"readOnlyHint": True, "idempotentHint": True})
def get_workflow(ctx: Ctx) -> dict:
    ctx.require_scope(WORKFLOWS_READ)
    wf = _get_workflow(ctx)
    definition = {k: v for k, v in wf.items()}
    definition["stats"] = _workflow_summary(ctx.state, wf)["stats"]
    return definition


# --------------------------------------------------------------------------- #
# tools: execution lifecycle
# --------------------------------------------------------------------------- #
@base.op(
    ID, "start_execution",
    title="Start workflow execution",
    description="Dispatch a workflow as an asynchronous execution. Returns immediately "
                "with a queued or running execution; poll get_execution for progress. "
                "Reusing an idempotencyKey returns the original execution.",
    input_schema={"type": "object", "properties": {
        "workflowId": {"type": "string"},
        "input": {"type": "object", "description": "Workflow input payload"},
        "idempotencyKey": {"type": "string", "description": "De-duplicates retried dispatches"},
        "priority": {"type": "string", "enum": ["low", "normal", "high", "critical"]},
        "correlationId": {"type": "string"}},
        "required": ["workflowId"]},
    output_schema=_EXEC_OUTPUT,
    annotations={"readOnlyHint": False, "idempotentHint": True})
def start_execution(ctx: Ctx) -> dict:
    ctx.require_scope(EXECUTIONS_WRITE)
    wf = _get_workflow(ctx)
    key = ctx.get("idempotencyKey")
    if key:
        existing = ctx.state.table("idempotency").get(f"{wf['id']}:{key}")
        if existing:
            ex = ctx.state.table("executions")[existing]
            return {**_public(ex), "idempotentReplay": True}
    payload = ctx.get("input") or {}
    if not isinstance(payload, dict):
        raise DomainError(422, "invalid_request", "input must be an object")
    ex = _new_execution(ctx.state, wf, input_payload=payload, trigger=_trigger(ctx),
                        idempotency_key=key, priority=ctx.get("priority", wf["priority"]))
    if ctx.get("correlationId"):
        ex["correlationId"] = ctx.payload["correlationId"]
    return _public(ex)


@base.op(
    ID, "get_execution",
    title="Get execution status",
    description="Fetch an execution's current state. Each call advances a running "
                "execution by one step, modeling a long-running asynchronous job.",
    input_schema=_EXEC_REF, output_schema=_EXEC_OUTPUT,
    annotations={"readOnlyHint": False, "idempotentHint": False})
def get_execution(ctx: Ctx) -> dict:
    ctx.require_scope(EXECUTIONS_READ)
    ex = _get_execution(ctx)
    if ex["status"] in ("queued", "running"):
        _advance(ctx.state, ex)
    return _public(ex)


@base.op(
    ID, "list_executions",
    title="List executions",
    description="List workflow executions, optionally filtered by workflow, status, or queue.",
    input_schema={"type": "object", "properties": {
        "workflowId": {"type": "string"},
        "status": {"type": "string", "enum": list(_TERMINAL + _ACTIVE)},
        "queue": {"type": "string"},
        "page": _PAGE_PROPS["page"], "pageSize": _PAGE_PROPS["pageSize"]}},
    annotations={"readOnlyHint": True, "idempotentHint": True})
def list_executions(ctx: Ctx) -> dict:
    ctx.require_scope(EXECUTIONS_READ)
    wf_id, status, queue = ctx.get("workflowId"), ctx.get("status"), ctx.get("queue")
    items = []
    for ex in ctx.state.table("executions").values():
        if wf_id and ex["workflowId"] != wf_id:
            continue
        if status and ex["status"] != status:
            continue
        if queue and ex["queue"] != queue:
            continue
        items.append(_execution_summary(ex))
    items.sort(key=lambda e: e["updatedAt"], reverse=True)
    return ctx.paginate(items)


@base.op(
    ID, "get_execution_logs",
    title="Get execution logs",
    description="Return the per-step execution log: status, attempts, durations, and errors.",
    input_schema=_EXEC_REF,
    annotations={"readOnlyHint": True, "idempotentHint": True})
def get_execution_logs(ctx: Ctx) -> dict:
    ctx.require_scope(EXECUTIONS_READ)
    ex = _get_execution(ctx)
    lines = []
    for s in ex["steps"]:
        lines.append({"stepId": s["stepId"], "name": s["name"], "type": s["type"],
                      "status": s["status"], "attempt": s["attempt"],
                      "startedAt": s["startedAt"], "finishedAt": s["finishedAt"],
                      "durationMs": s["durationMs"], "error": s["error"]})
    return {"executionId": ex["executionId"], "workflowId": ex["workflowId"],
            "status": ex["status"], "steps": lines}


@base.op(
    ID, "get_execution_result",
    title="Get execution result",
    description="Return the output and artifacts of a finished execution, or its current "
                "disposition if it has not completed.",
    input_schema=_EXEC_REF,
    annotations={"readOnlyHint": True, "idempotentHint": True})
def get_execution_result(ctx: Ctx) -> dict:
    ctx.require_scope(EXECUTIONS_READ)
    ex = _get_execution(ctx)
    return {"executionId": ex["executionId"], "workflowId": ex["workflowId"],
            "status": ex["status"], "output": ex["output"], "error": ex["error"],
            "finishedAt": ex["finishedAt"], "metrics": ex["metrics"]}


@base.op(
    ID, "signal_execution",
    title="Signal execution",
    description="Send a signal to an execution paused on an approval step. Approve to "
                "resume the run; reject to cancel it.",
    input_schema={"type": "object", "properties": {
        "executionId": {"type": "string"},
        "signal": {"type": "string", "enum": ["approve", "reject"]},
        "note": {"type": "string"}},
        "required": ["executionId", "signal"]},
    output_schema=_EXEC_OUTPUT,
    annotations={"readOnlyHint": False, "idempotentHint": False})
def signal_execution(ctx: Ctx) -> dict:
    ctx.require_scope(EXECUTIONS_WRITE)
    ctx.require("signal")
    decision = ctx.payload["signal"]
    if decision not in ("approve", "reject"):
        raise DomainError(422, "invalid_signal", "signal must be 'approve' or 'reject'")
    ex = _get_execution(ctx)
    _apply_signal(ctx.state, ex, decision, str(ctx.principal.get("principal") or "operator"),
                  ctx.get("note"))
    return _public(ex)


@base.op(
    ID, "retry_execution",
    title="Retry execution",
    description="Retry a failed or timed-out execution from its failed step under the "
                "workflow's retry policy.",
    input_schema=_EXEC_REF, output_schema=_EXEC_OUTPUT,
    annotations={"readOnlyHint": False, "idempotentHint": False})
def retry_execution(ctx: Ctx) -> dict:
    ctx.require_scope(EXECUTIONS_WRITE)
    ex = _get_execution(ctx)
    _apply_retry(ctx.state, ex, str(ctx.principal.get("principal") or "operator"))
    return _public(ex)


@base.op(
    ID, "cancel_execution",
    title="Cancel execution",
    description="Cancel an active execution. Terminal executions cannot be cancelled.",
    input_schema={"type": "object", "properties": {
        "executionId": {"type": "string"}, "reason": {"type": "string"}},
        "required": ["executionId"]},
    output_schema=_EXEC_OUTPUT,
    annotations={"readOnlyHint": False, "idempotentHint": True, "destructiveHint": True})
def cancel_execution(ctx: Ctx) -> dict:
    ctx.require_scope(EXECUTIONS_WRITE)
    ex = _get_execution(ctx)
    if ex["status"] in _TERMINAL:
        raise DomainError(409, "execution_terminal", f"execution already {ex['status']}")
    at = _ts(ex["_clock"])
    ex["status"] = "cancelled"
    ex["finishedAt"] = at
    ex["updatedAt"] = at
    ex["error"] = {"code": "cancelled", "message": ctx.get("reason", "cancelled by operator")}
    for s in ex["steps"]:
        if s["status"] in ("pending", "retrying"):
            s["status"] = "skipped"
    _audit(ex, "execution_cancelled", str(ctx.principal.get("principal") or "operator"),
           {"reason": ctx.get("reason")}, at=at)
    return _public(ex)


@base.op(
    ID, "get_execution_audit",
    title="Get execution audit trail",
    description="Return the hash-chained audit trail for an execution, including the "
                "mandate subject and delegation lineage that triggered it.",
    input_schema=_EXEC_REF,
    annotations={"readOnlyHint": True, "idempotentHint": True})
def get_execution_audit(ctx: Ctx) -> dict:
    ctx.require_scope(EXECUTIONS_READ)
    ex = _get_execution(ctx)
    return {"executionId": ex["executionId"], "workflowId": ex["workflowId"],
            "trigger": ex["trigger"], "events": ex["auditTrail"],
            "chainIntact": _chain_intact(ex)}


# --------------------------------------------------------------------------- #
# tools: queues
# --------------------------------------------------------------------------- #
@base.op(
    ID, "list_queues",
    title="List queues",
    description="List execution queues with their depth, in-flight count, and concurrency limit.",
    input_schema={"type": "object", "properties": {}},
    annotations={"readOnlyHint": True, "idempotentHint": True})
def list_queues(ctx: Ctx) -> dict:
    return {"items": [_queue_state(ctx.state, q) for q in _QUEUES]}


@base.op(
    ID, "get_queue",
    title="Get queue status",
    description="Return depth, in-flight executions, and concurrency for one queue.",
    input_schema={"type": "object", "properties": {
        "queue": {"type": "string"}}, "required": ["queue"]},
    annotations={"readOnlyHint": True, "idempotentHint": True})
def get_queue(ctx: Ctx) -> dict:
    ctx.require("queue")
    q = ctx.payload["queue"]
    if q not in _QUEUES:
        raise DomainError(404, "queue_not_found", q)
    return _queue_state(ctx.state, q)


def _queue_state(state: base.State, queue: str) -> dict:
    runs = [e for e in state.table("executions").values() if e["queue"] == queue]
    return {
        "queue": queue,
        "concurrencyLimit": _QUEUES[queue],
        "running": sum(1 for e in runs if e["status"] in ("running", "retrying")),
        "waiting": sum(1 for e in runs if e["status"] == "waiting_signal"),
        "queued": sum(1 for e in runs if e["status"] == "queued"),
        "workflows": [w["id"] for w in _WORKFLOWS if w["queue"] == queue],
    }


# --------------------------------------------------------------------------- #
# MCP resources (discovery surface)
# --------------------------------------------------------------------------- #
@base.resource(ID, uri="relay://workflows/catalog", name="Workflow catalog",
               description="Every workflow definition with queue, schedule, and run counts.")
def _res_catalog(ctx: Ctx) -> dict:
    return {"total": len(_WORKFLOWS),
            "items": [_workflow_summary(ctx.state, w) for w in _WORKFLOWS]}


@base.resource(ID, uri="relay://executions/active", name="Active executions",
               description="Executions that are queued, running, or waiting on a signal.")
def _res_active(ctx: Ctx) -> dict:
    active = [_execution_summary(e) for e in ctx.state.table("executions").values()
              if e["status"] in _ACTIVE]
    active.sort(key=lambda e: e["updatedAt"], reverse=True)
    return {"total": len(active), "items": active[:50]}


@base.resource(ID, uri="relay://queues/status", name="Queue status",
               description="Depth and concurrency utilization across every execution queue.")
def _res_queues(ctx: Ctx) -> dict:
    return {"items": [_queue_state(ctx.state, q) for q in _QUEUES]}
