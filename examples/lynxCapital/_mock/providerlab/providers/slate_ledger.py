"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Slate Ledger domain: double-entry journal posting with maker-checker approval, chart of accounts, bank and sub-ledger reconciliation, recurring accruals, trial balance, and soft/hard fiscal-period close.
"""
from __future__ import annotations

from datetime import datetime, timezone

from _mock.providerlab.data import generators as gen
from _mock.providerlab.providers import base
from _mock.providerlab.providers.base import Ctx, DomainError

ID = "slate-ledger"

_READ = {"readOnlyHint": True}


@base.seeder(ID)
def seed(state: base.State) -> None:
    for name, table in gen.slate_dataset(ID).items():
        state.tables[name] = table


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _iso(ts: int | None = None) -> str:
    moment = datetime.fromtimestamp(ts if ts is not None else base.now(), tz=timezone.utc)
    return moment.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _actor(ctx: Ctx, field: str = "postedBy") -> str:
    """Resolve the user a write is attributed to: an explicit override, else the
    authenticated token principal, the way a GL stamps every posting with an actor."""
    override = ctx.get(field)
    if override:
        return str(override)
    principal = ctx.principal.get("principal")
    return f"{principal}@slate-ledger.test" if principal else "api-token@slate-ledger.test"


def _account(ctx: Ctx, account_no: str) -> dict:
    accounts = ctx.state.table("accounts")
    acct = accounts.get(str(account_no)) or accounts.get(str(account_no).removeprefix("ACCT-"))
    if acct is None:
        raise DomainError(404, "account_not_found", str(account_no))
    return acct


def _open_periods(ctx: Ctx) -> list[str]:
    return sorted(p for p, row in ctx.state.table("periods").items() if row["status"] == "open")


def _require_open_period(ctx: Ctx, period: str | None) -> tuple[str, dict]:
    period = period or (_open_periods(ctx)[0] if _open_periods(ctx) else None)
    pr = ctx.state.table("periods").get(period)
    if pr is None:
        raise DomainError(404, "period_not_found", str(period))
    if pr["status"] != "open":
        raise DomainError(409, "period_closed", f"period {period} is {pr['status']}")
    return period, pr


def _apply_balance(acct: dict, debit: float, credit: float) -> None:
    delta = (debit - credit) if acct["normalBalance"] == "debit" else (credit - debit)
    acct["balance"] = round(acct["balance"] + delta, 2)


def _apply_entry(ctx: Ctx, lines: list[dict]) -> None:
    accounts = ctx.state.table("accounts")
    for line in lines:
        if line.get("accountName") is not None and line["accountNo"] in accounts:
            acct = accounts[line["accountNo"]]
            _apply_balance(acct, line["debit"], line["credit"])
            acct["updatedAt"] = _iso()


def _normalize_lines(ctx: Ctx, lines: list[dict], entry_no: str) -> tuple[list[dict], float, float]:
    accounts = ctx.state.table("accounts")
    normalized: list[dict] = []
    debit = credit = 0.0
    for n, line in enumerate(lines, start=1):
        account_no = str(line.get("accountNo") or line.get("account") or "")
        acct = None
        if account_no:
            acct = accounts.get(account_no) or accounts.get(account_no.removeprefix("ACCT-"))
            if acct is None:
                raise DomainError(422, "invalid_account", f"account {account_no} is not in the chart")
            if acct["status"] != "active":
                raise DomainError(422, "inactive_account", f"account {account_no} is not active")
        d = round(float(line.get("debit", 0) or 0), 2)
        c = round(float(line.get("credit", 0) or 0), 2)
        if d < 0 or c < 0:
            raise DomainError(422, "invalid_amount", "debit and credit must be non-negative")
        if d and c:
            raise DomainError(422, "invalid_line", f"line {n} cannot have both a debit and a credit")
        debit += d
        credit += c
        normalized.append({
            "lineId": f"{entry_no}-{n}", "lineNo": n,
            "accountNo": acct["accountNo"] if acct else account_no,
            "accountName": acct["name"] if acct else None,
            "accountType": acct["type"] if acct else None,
            "debit": d, "credit": c,
            "department": line.get("department"), "memo": line.get("memo", ""),
        })
    return normalized, round(debit, 2), round(credit, 2)


# --------------------------------------------------------------------------- #
# Chart of accounts
# --------------------------------------------------------------------------- #
@base.op(ID, "list_accounts", title="List accounts", annotations=_READ)
def list_accounts(ctx: Ctx) -> dict:
    """List the chart of accounts, filterable by type or status, sorted by number."""
    items = list(ctx.state.table("accounts").values())
    acct_type = ctx.get("type")
    if acct_type:
        items = [a for a in items if a["type"] == acct_type]
    status = ctx.get("status")
    if status:
        items = [a for a in items if a["status"] == status]
    items.sort(key=lambda a: a["accountNo"])
    return ctx.paginate(items, size_default=25)


@base.op(ID, "get_account", title="Get account", annotations=_READ)
def get_account(ctx: Ctx) -> dict:
    """Fetch one account by number, including its running balance and classification."""
    ctx.require("accountId")
    return _account(ctx, ctx.payload["accountId"])


# --------------------------------------------------------------------------- #
# Journal entries (double-entry)
# --------------------------------------------------------------------------- #
@base.op(ID, "post_entry", title="Post journal entry")
def post_entry(ctx: Ctx) -> dict:
    """Post a balanced double-entry journal into an open period. Debits must equal
    credits; pass `status: "draft"` (or `requireApproval`) to route it through
    maker-checker approval before it hits the ledger. Honors `idempotencyKey`."""
    idem = ctx.get("idempotencyKey")
    if idem:
        prior = ctx.state.table("idempotency").get(str(idem))
        if prior:
            return ctx.state.table("entries")[prior]

    lines = ctx.get("lines") or []
    if len(lines) < 2:
        raise DomainError(422, "unbalanced", "entry requires at least two lines")

    entry_no = base.new_id("gl")
    normalized, debit, credit = _normalize_lines(ctx, lines, entry_no)
    if debit != credit:
        raise DomainError(422, "unbalanced", f"debit {debit} != credit {credit}")
    if debit == 0:
        raise DomainError(422, "zero_value", "entry total must be non-zero")

    period, _pr = _require_open_period(ctx, ctx.get("period"))

    draft = str(ctx.get("status", "")).lower() == "draft" or bool(ctx.get("requireApproval"))
    now = _iso()
    entries = ctx.state.table("entries")
    seq = len([e for e in entries if e.startswith(f"JE-{period.replace('-', '')}")]) + 1
    journal_id = f"JE-{period.replace('-', '')}-{seq:04d}"
    entry = {
        "journalId": journal_id,
        "entryNo": entry_no,
        "type": ctx.get("type", "standard"),
        "source": ctx.get("source", "manual"),
        "period": period,
        "currency": ctx.get("currency", "USD"),
        "exchangeRate": round(float(ctx.get("exchangeRate", 1.0)), 6),
        "reportingCurrency": ctx.get("reportingCurrency", "USD"),
        "description": ctx.get("description", "Manual journal entry"),
        "reference": ctx.get("reference"),
        "externalId": ctx.get("externalId"),
        "tags": list(ctx.get("tags", [])),
        "attachments": list(ctx.get("attachments", [])),
        "lines": normalized,
        "totalDebit": debit,
        "totalCredit": credit,
        "status": "pending_approval" if draft else "posted",
        "approvalStatus": "pending" if draft else "not_required",
        "approvedBy": None,
        "reversalOf": None,
        "reversedBy": None,
        "postedBy": None if draft else _actor(ctx),
        "postedAt": None if draft else now,
        "createdBy": _actor(ctx, "createdBy"),
        "createdAt": now,
        "updatedAt": now,
    }
    if not draft:
        _apply_entry(ctx, normalized)
    entries[journal_id] = entry
    if idem:
        ctx.state.table("idempotency")[str(idem)] = journal_id
    return entry


@base.op(ID, "approve_entry", title="Approve journal entry")
def approve_entry(ctx: Ctx) -> dict:
    """Approve a draft journal entry through maker-checker control, posting it into
    its period and updating account balances."""
    ctx.require("entryId")
    entry = ctx.state.table("entries").get(ctx.payload["entryId"])
    if entry is None:
        raise DomainError(404, "entry_not_found", ctx.payload["entryId"])
    if entry["status"] != "pending_approval":
        raise DomainError(409, "not_pending", f"entry {entry['journalId']} is {entry['status']}")
    _require_open_period(ctx, entry["period"])
    approver = _actor(ctx, "approvedBy")
    if approver == entry.get("createdBy"):
        raise DomainError(409, "self_approval", "an entry cannot be approved by its preparer")
    _apply_entry(ctx, entry["lines"])
    now = _iso()
    entry.update({
        "status": "posted", "approvalStatus": "approved", "approvedBy": approver,
        "postedBy": approver, "postedAt": now, "updatedAt": now,
    })
    return entry


@base.op(ID, "get_entry", title="Get journal entry", annotations=_READ)
def get_entry(ctx: Ctx) -> dict:
    """Fetch one journal entry by its journal id."""
    ctx.require("entryId")
    entry = ctx.state.table("entries").get(ctx.payload["entryId"])
    if entry is None:
        raise DomainError(404, "entry_not_found", ctx.payload["entryId"])
    return entry


@base.op(ID, "list_entries", title="List journal entries", annotations=_READ)
def list_entries(ctx: Ctx) -> dict:
    """List journal entries, filterable by period, type, status, or source."""
    items = list(ctx.state.table("entries").values())
    for field in ("period", "type", "status", "source"):
        value = ctx.get(field)
        if value:
            items = [e for e in items if e.get(field) == value]
    items.sort(key=lambda e: e["journalId"], reverse=True)
    return ctx.paginate(items, size_default=20)


@base.op(ID, "reverse_entry", title="Reverse journal entry")
def reverse_entry(ctx: Ctx) -> dict:
    """Post a reversing journal that swaps the debits and credits of a posted entry,
    backing it out of an open period."""
    ctx.require("entryId")
    entries = ctx.state.table("entries")
    original = entries.get(ctx.payload["entryId"])
    if original is None:
        raise DomainError(404, "entry_not_found", ctx.payload["entryId"])
    if original["status"] != "posted":
        raise DomainError(409, "not_posted", "only posted entries can be reversed")
    if original["reversedBy"]:
        raise DomainError(409, "already_reversed",
                          f"entry {original['journalId']} was reversed by {original['reversedBy']}")
    period, _pr = _require_open_period(ctx, ctx.get("period") or original["period"])

    entry_no = base.new_id("gl")
    swapped = []
    for n, line in enumerate(original["lines"], start=1):
        swapped.append({**line, "lineId": f"{entry_no}-{n}",
                        "debit": line["credit"], "credit": line["debit"]})
    _apply_entry(ctx, swapped)
    seq = len(entries) + 1
    journal_id = f"JE-{period.replace('-', '')}-R{seq:04d}"
    now = _iso()
    reversal = {
        "journalId": journal_id,
        "entryNo": entry_no,
        "type": "reversal",
        "source": "manual",
        "period": period,
        "currency": original["currency"],
        "exchangeRate": original["exchangeRate"],
        "reportingCurrency": original["reportingCurrency"],
        "description": f"Reversal of {original['journalId']}",
        "reference": original.get("reference"),
        "externalId": original.get("externalId"),
        "tags": ["reversal"],
        "attachments": [],
        "lines": swapped,
        "totalDebit": original["totalCredit"],
        "totalCredit": original["totalDebit"],
        "status": "posted",
        "approvalStatus": "not_required",
        "approvedBy": None,
        "reversalOf": original["journalId"],
        "reversedBy": None,
        "postedBy": _actor(ctx),
        "postedAt": now,
        "createdBy": _actor(ctx, "createdBy"),
        "createdAt": now,
        "updatedAt": now,
    }
    entries[journal_id] = reversal
    original["reversedBy"] = journal_id
    original["updatedAt"] = now
    return reversal


# --------------------------------------------------------------------------- #
# Reconciliation — asynchronous statement match with maker-checker review
# --------------------------------------------------------------------------- #
@base.op(ID, "reconcile_account", title="Open account reconciliation")
def reconcile_account(ctx: Ctx) -> dict:
    """Open a reconciliation that matches a bank or sub-ledger statement against the
    GL balance. The job is created here and settled by a follow-up call to
    get_reconciliation, the way a close platform queues matching for review."""
    ctx.require("accountId")
    acct = _account(ctx, ctx.payload["accountId"])
    gl_balance = acct["balance"]
    statement_balance = round(float(ctx.get("statementBalance", gl_balance)), 2)
    period = ctx.get("period") or (_open_periods(ctx)[0] if _open_periods(ctx) else None)
    rid = base.new_id("rec")
    rec = {
        "reconciliationId": rid,
        "accountNo": acct["accountNo"],
        "accountName": acct["name"],
        "reconciliationType": gen._SLATE_RECON_TYPE.get(acct["subtype"], "balance_sheet"),
        "frequency": ctx.get("frequency", "monthly"),
        "period": period,
        "glBalance": gl_balance,
        "statementBalance": statement_balance,
        "outstandingItems": ctx.get("outstandingItems", []),
        "matchedItems": ctx.get("matchedItems", []),
        "tolerance": round(float(ctx.get("tolerance", 1.00)), 2),
        "status": "in_progress",
        "reviewStatus": "pending_review",
        "jobId": base.new_id("job"),
        "preparedBy": _actor(ctx, "preparedBy"),
        "reviewedBy": None,
        "submittedAt": _iso(),
    }
    ctx.state.table("reconciliations")[rid] = rec
    return rec


@base.op(ID, "get_reconciliation", title="Get reconciliation", annotations=_READ)
def get_reconciliation(ctx: Ctx) -> dict:
    """Fetch a reconciliation, settling an in-progress match into a balanced result
    or a tolerance exception with its reconciling difference."""
    ctx.require("reconciliationId")
    rec = ctx.state.table("reconciliations").get(ctx.payload["reconciliationId"])
    if rec is None:
        raise DomainError(404, "reconciliation_not_found", ctx.payload["reconciliationId"])
    if rec["status"] == "in_progress":
        outstanding_total = round(sum(float(i.get("amount", 0)) for i in rec["outstandingItems"]), 2)
        rec["outstandingTotal"] = outstanding_total
        rec["matchedTotal"] = round(sum(float(i.get("amount", 0)) for i in rec["matchedItems"]), 2)
        rec["adjustedBalance"] = round(rec["statementBalance"] - outstanding_total, 2)
        rec["difference"] = round(rec["adjustedBalance"] - rec["glBalance"], 2)
        rec["withinTolerance"] = abs(rec["difference"]) <= rec["tolerance"]
        rec["status"] = "balanced" if rec["withinTolerance"] else "exception"
        rec["reviewStatus"] = "reviewed" if rec["withinTolerance"] else "pending_review"
        rec["reviewedBy"] = "controller@slate-ledger.test" if rec["withinTolerance"] else None
        rec["reconciledAt"] = _iso()
        acct = ctx.state.table("accounts").get(rec["accountNo"])
        if acct is not None:
            acct["lastReconciledAt"] = rec["reconciledAt"]
    return rec


@base.op(ID, "list_reconciliations", title="List reconciliations", annotations=_READ)
def list_reconciliations(ctx: Ctx) -> dict:
    """List reconciliations, filterable by period, status, or account."""
    items = list(ctx.state.table("reconciliations").values())
    for field, key in (("period", "period"), ("status", "status"), ("accountId", "accountNo")):
        value = ctx.get(field)
        if value:
            items = [r for r in items if r.get(key) == value]
    items.sort(key=lambda r: r["reconciliationId"], reverse=True)
    return ctx.paginate(items, size_default=25)


# --------------------------------------------------------------------------- #
# Recurring accruals
# --------------------------------------------------------------------------- #
@base.op(ID, "create_accrual", title="Create accrual schedule")
def create_accrual(ctx: Ctx) -> dict:
    """Create a recurring accrual schedule that amortizes a total over a number of
    periods, debiting an expense account and crediting a liability."""
    ctx.require("amount", "periods")
    amount = round(float(ctx.payload["amount"]), 2)
    periods = int(ctx.payload["periods"])
    if periods <= 0:
        raise DomainError(422, "invalid_periods", "periods must be positive")
    if amount <= 0:
        raise DomainError(422, "invalid_amount", "amount must be positive")
    accounts = ctx.state.table("accounts")
    expense_acct = ctx.get("expenseAccount", "6300")
    liability_acct = ctx.get("liabilityAccount", "2100")
    start_period = ctx.get("period") or (_open_periods(ctx)[0] if _open_periods(ctx) else None)
    per_period = round(amount / periods, 2)
    now = _iso()
    accrual = {
        "accrualId": base.new_id("acr"),
        "description": ctx.get("description", ctx.get("category", "Accrued expense")),
        "expenseAccount": expense_acct,
        "expenseAccountName": accounts.get(expense_acct, {}).get("name"),
        "liabilityAccount": liability_acct,
        "liabilityAccountName": accounts.get(liability_acct, {}).get("name"),
        "totalAmount": amount,
        "periods": periods,
        "perPeriod": per_period,
        "postedPeriods": 0,
        "remainingPeriods": periods,
        "remainingAmount": amount,
        "frequency": ctx.get("frequency", "monthly"),
        "currency": ctx.get("currency", "USD"),
        "startPeriod": start_period,
        "nextPostPeriod": start_period,
        "status": "active",
        "createdAt": now,
        "updatedAt": now,
    }
    ctx.state.table("accruals")[accrual["accrualId"]] = accrual
    return accrual


@base.op(ID, "list_accruals", title="List accrual schedules", annotations=_READ)
def list_accruals(ctx: Ctx) -> dict:
    """List recurring accrual schedules, filterable by status."""
    items = list(ctx.state.table("accruals").values())
    status = ctx.get("status")
    if status:
        items = [a for a in items if a["status"] == status]
    items.sort(key=lambda a: a["accrualId"])
    return ctx.paginate(items, size_default=25)


@base.op(ID, "get_accrual", title="Get accrual schedule", annotations=_READ)
def get_accrual(ctx: Ctx) -> dict:
    """Fetch one accrual schedule by id, with its amortization progress."""
    ctx.require("accrualId")
    accrual = ctx.state.table("accruals").get(ctx.payload["accrualId"])
    if accrual is None:
        raise DomainError(404, "accrual_not_found", ctx.payload["accrualId"])
    return accrual


@base.op(ID, "post_accrual", title="Post accrual period")
def post_accrual(ctx: Ctx) -> dict:
    """Post one period's portion of an accrual schedule to the GL, debiting the
    expense and crediting the liability, then advancing the schedule."""
    ctx.require("accrualId")
    accrual = ctx.state.table("accruals").get(ctx.payload["accrualId"])
    if accrual is None:
        raise DomainError(404, "accrual_not_found", ctx.payload["accrualId"])
    if accrual["status"] != "active" or accrual["remainingPeriods"] <= 0:
        raise DomainError(409, "accrual_complete", "accrual schedule is fully posted")
    period, _pr = _require_open_period(ctx, ctx.get("period") or accrual["nextPostPeriod"])
    amount = accrual["perPeriod"]
    sub = Ctx(ctx.provider, ctx.state, ctx.op, {
        "period": period, "type": "accrual", "source": "recurring",
        "description": f"Accrual: {accrual['description']}",
        "reference": accrual["accrualId"],
        "lines": [
            {"accountNo": accrual["expenseAccount"], "debit": amount, "memo": accrual["description"]},
            {"accountNo": accrual["liabilityAccount"], "credit": amount, "memo": accrual["description"]},
        ],
    }, ctx.principal)
    entry = post_entry(sub)
    accrual["postedPeriods"] += 1
    accrual["remainingPeriods"] = accrual["periods"] - accrual["postedPeriods"]
    accrual["remainingAmount"] = round(accrual["totalAmount"] - amount * accrual["postedPeriods"], 2)
    accrual["status"] = "completed" if accrual["remainingPeriods"] <= 0 else "active"
    accrual["updatedAt"] = _iso()
    return {"accrual": accrual, "entry": entry}


# --------------------------------------------------------------------------- #
# Trial balance and period close
# --------------------------------------------------------------------------- #
def _trial_balance(ctx: Ctx, period: str | None) -> dict:
    totals: dict[str, dict] = {}
    for entry in ctx.state.table("entries").values():
        if entry["status"] != "posted":
            continue
        if period and entry["period"] != period:
            continue
        for line in entry["lines"]:
            if line["accountName"] is None:
                continue
            row = totals.setdefault(line["accountNo"], {
                "accountNo": line["accountNo"], "accountName": line["accountName"],
                "debit": 0.0, "credit": 0.0,
            })
            row["debit"] = round(row["debit"] + line["debit"], 2)
            row["credit"] = round(row["credit"] + line["credit"], 2)
    rows = sorted(totals.values(), key=lambda r: r["accountNo"])
    total_debit = round(sum(r["debit"] for r in rows), 2)
    total_credit = round(sum(r["credit"] for r in rows), 2)
    return {
        "period": period,
        "rows": rows,
        "totalDebit": total_debit,
        "totalCredit": total_credit,
        "balanced": abs(total_debit - total_credit) < 0.01,
    }


@base.op(ID, "trial_balance", title="Trial balance", annotations=_READ)
def trial_balance(ctx: Ctx) -> dict:
    """Aggregate posted debits and credits per account for a period and confirm the
    ledger ties out before close."""
    return _trial_balance(ctx, ctx.get("period"))


@base.op(ID, "list_periods", title="List periods", annotations=_READ)
def list_periods(ctx: Ctx) -> dict:
    """List fiscal periods and their close status."""
    items = sorted(ctx.state.table("periods").values(), key=lambda p: p["periodId"])
    status = ctx.get("status")
    if status:
        items = [p for p in items if p["status"] == status]
    return {"items": items, "total": len(items)}


@base.op(ID, "get_period", title="Get period", annotations=_READ)
def get_period(ctx: Ctx) -> dict:
    """Fetch one fiscal period, including its close checklist."""
    ctx.require("period")
    pr = ctx.state.table("periods").get(ctx.payload["period"])
    if pr is None:
        raise DomainError(404, "period_not_found", ctx.payload["period"])
    return pr


@base.op(ID, "close_period", title="Close period")
def close_period(ctx: Ctx) -> dict:
    """Close a fiscal period, gating on a balanced trial balance and completed
    reconciliations. Pass `softClose: true` for a reversible soft close; a hard
    close locks the period against further posting."""
    ctx.require("period")
    period = ctx.payload["period"]
    pr = ctx.state.table("periods").get(period)
    if pr is None:
        raise DomainError(404, "period_not_found", period)
    if pr["status"] == "locked":
        raise DomainError(409, "period_locked", "period is locked and cannot be re-closed")
    if pr["status"] == "closed":
        raise DomainError(409, "already_closed", "period already closed")

    tb = _trial_balance(ctx, period)
    if not tb["balanced"]:
        raise DomainError(422, "trial_balance_unbalanced",
                          f"trial balance is out by {round(tb['totalDebit'] - tb['totalCredit'], 2)}")

    recs = [r for r in ctx.state.table("reconciliations").values() if r.get("period") == period]
    pending = [r["reconciliationId"] for r in recs if r["status"] == "in_progress"]
    if pending:
        raise DomainError(409, "reconciliations_incomplete",
                          f"{len(pending)} reconciliation(s) still in progress")
    drafts = [e["journalId"] for e in ctx.state.table("entries").values()
              if e["period"] == period and e["status"] == "pending_approval"]
    if drafts:
        raise DomainError(409, "entries_unapproved",
                          f"{len(drafts)} journal entry(ies) await approval")
    warnings = [{"reconciliationId": r["reconciliationId"], "accountNo": r["accountNo"],
                 "difference": r.get("difference")}
                for r in recs if r["status"] == "exception"]

    soft = bool(ctx.get("softClose"))
    closer = _actor(ctx, "closedBy")
    now = _iso()
    for task in pr["checklist"]:
        task["status"] = "complete"
        task["completedAt"] = now
        task["signOffBy"] = task["owner"]
    pr["status"] = "soft_closed" if soft else "closed"
    pr["closeType"] = "soft" if soft else "hard"
    pr["closedAt"] = now
    pr["closedBy"] = closer
    pr["trialBalance"] = {"totalDebit": tb["totalDebit"], "totalCredit": tb["totalCredit"]}
    pr["openExceptions"] = warnings
    return pr


@base.op(ID, "reopen_period", title="Reopen period")
def reopen_period(ctx: Ctx) -> dict:
    """Reopen a closed period for late adjustments. Soft-closed periods reopen
    freely; a hard close requires `force: true`; locked periods cannot be reopened."""
    ctx.require("period")
    period = ctx.payload["period"]
    pr = ctx.state.table("periods").get(period)
    if pr is None:
        raise DomainError(404, "period_not_found", period)
    if pr["status"] == "open":
        raise DomainError(409, "not_closed", f"period {period} is already open")
    if pr["status"] == "locked":
        raise DomainError(409, "period_locked", "locked periods cannot be reopened")
    if pr["status"] == "closed" and not ctx.get("force"):
        raise DomainError(409, "hard_close_locked",
                          "period is hard-closed; reopen requires force=true")
    now = _iso()
    for task in pr["checklist"]:
        task["status"] = "pending"
        task["completedAt"] = None
        task["signOffBy"] = None
    pr["status"] = "open"
    pr["closeType"] = None
    pr["closedAt"] = None
    pr["closedBy"] = None
    pr["reopenedAt"] = now
    pr["reopenedBy"] = _actor(ctx, "reopenedBy")
    return pr
