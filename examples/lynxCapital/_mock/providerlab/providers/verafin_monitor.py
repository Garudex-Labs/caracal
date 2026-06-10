"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Verafin Monitor domain: transaction monitoring, alert investigation, BSA/AML regulatory filing, and control attestation under delegated Caracal mandates.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone

from _mock.providerlab import intelligence
from _mock.providerlab.data import generators as gen
from _mock.providerlab.providers import base
from _mock.providerlab.providers.base import Ctx, DomainError

ID = "verafin-monitor"

# Alert score banding and the investigation SLA (hours) each band carries.
_BANDS = (("critical", 80), ("high", 55), ("medium", 30), ("low", 0))
_SLA_HOURS = {"critical": 8, "high": 24, "medium": 72, "low": 168}

# Filing windows mandated by the BSA, counted from alert detection.
_FILING_DEADLINE_DAYS = {"SAR": 30, "CTR": 15}
_ALERT_DISPOSITIONS = ("false_positive", "cleared", "file_sar", "escalate")
_FILING_TYPES = ("SAR", "CTR")


def _ts(offset_seconds: int = 0) -> str:
    moment = datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)
    return moment.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _band(score: int) -> str:
    for name, floor in _BANDS:
        if score >= floor:
            return name
    return "low"


@base.seeder(ID)
def seed(state: base.State) -> None:
    ref = gen.verafin_reference(ID)
    state.tables["customers"] = dict(ref["customers"])
    state.tables["accounts"] = dict(ref["accounts"])
    state.tables["controls"] = dict(ref["controls"])
    state.tables["alerts"] = {}
    state.tables["cases"] = {}
    state.tables["filings"] = {}
    state.tables["attestations"] = {}
    state.tables["audit_events"] = {}
    state.scalars = {
        "typologies": ref["typologies"],
        "ctrThreshold": ref["ctrThreshold"],
        "sarThreshold": ref["sarThreshold"],
        "highRisk": set(ref["highRisk"]),
    }
    _seed_history(state)


def _meta(state: base.State) -> dict:
    return getattr(state, "scalars")


# --------------------------------------------------------------------------- #
# delegation + actor context
# --------------------------------------------------------------------------- #
def _actor(ctx: Ctx) -> str:
    return str(ctx.principal.get("principal") or "anonymous")


def _delegation(ctx: Ctx) -> dict:
    """Capture the verified delegation chain that authorized this action, so every
    sensitive monitoring and filing event is traceable to its delegated mandate."""
    p = ctx.principal
    return {
        "subject": p.get("principal"),
        "subjectType": p.get("subjectType"),
        "zone": p.get("zone"),
        "agentSessionId": p.get("agentSessionId"),
        "rootSessionId": p.get("rootSessionId"),
        "sessionId": p.get("sessionId"),
        "delegationEdgeId": p.get("delegationEdgeId"),
        "mandateId": p.get("mandateId"),
    }


# --------------------------------------------------------------------------- #
# tamper-evident audit trail (hash-chained per subject, bound to delegation)
# --------------------------------------------------------------------------- #
def _audit(
    state: base.State, subject: dict, kind: str, ctx: Ctx, details: dict
) -> dict:
    trail = subject.setdefault("auditTrail", [])
    prev = trail[-1]["hash"] if trail else "genesis"
    actor = _actor(ctx)
    delegation = _delegation(ctx)
    at = _ts()
    event_id = base.new_id("evt")
    edge = delegation.get("delegationEdgeId") or "none"
    digest = hashlib.sha256(
        f"{subject['_auditKey']}|{kind}|{actor}|{edge}|{at}|{prev}".encode()
    ).hexdigest()[:16]
    event = {
        "eventId": event_id,
        "subjectId": subject["_auditKey"],
        "type": kind,
        "actor": actor,
        "delegation": delegation,
        "at": at,
        "details": details,
        "prevHash": prev,
        "hash": digest,
    }
    trail.append(event)
    state.table("audit_events")[event_id] = event
    subject["updatedAt"] = at
    return event


def _audit_intact(subject_key: str, events: list[dict]) -> bool:
    prev = "genesis"
    for event in events:
        edge = (event.get("delegation") or {}).get("delegationEdgeId") or "none"
        digest = hashlib.sha256(
            f"{subject_key}|{event['type']}|{event['actor']}|{edge}|{event['at']}|{prev}".encode()
        ).hexdigest()[:16]
        if event.get("prevHash") != prev or event.get("hash") != digest:
            return False
        prev = event["hash"]
    return True


# --------------------------------------------------------------------------- #
# transaction scoring + typology detection
# --------------------------------------------------------------------------- #
def _score_transaction(state: base.State, txn: dict) -> tuple[int, list[dict]]:
    """Score a transaction against the typology rule set, returning a composite
    0-100 risk score and the contributing typology signals."""
    meta = _meta(state)
    amount = txn["amount"]
    customer = state.table("customers").get(txn.get("customerId") or "")
    account = state.table("accounts").get(txn.get("accountId") or "")
    rng = gen._rng(ID, "score", txn["transactionId"])
    signals: list[dict] = []

    ctr = meta["ctrThreshold"]
    if 0.85 * ctr <= amount < ctr and txn.get("channel") in ("cash", "wire", "ach"):
        signals.append(
            {
                "typology": "structuring",
                "weight": 38,
                "detail": f"amount {amount:.0f} sits just below the ${ctr:,} CTR threshold",
            }
        )
    if txn.get("channel") == "cash" and amount >= 0.5 * ctr:
        signals.append(
            {
                "typology": "cash_intensive",
                "weight": 24,
                "detail": "high-value cash activity",
            }
        )
    if amount >= 100_000:
        weight = 34 if amount >= 500_000 else 26
        signals.append(
            {
                "typology": "large_value",
                "weight": weight,
                "detail": f"large-value transaction of {amount:.0f}",
            }
        )
    if amount % 1000 == 0 and amount >= 10_000:
        signals.append(
            {
                "typology": "round_amount",
                "weight": 16,
                "detail": "round-amount value consistent with layering",
            }
        )

    country = txn.get("country") or (customer or {}).get("country")
    if country in meta["highRisk"]:
        signals.append(
            {
                "typology": "high_risk_geo",
                "weight": 28,
                "detail": f"counterparty jurisdiction {country} is high-risk",
            }
        )

    velocity = _recent_count(state, txn.get("accountId"), within_hours=24)
    if velocity >= 4:
        signals.append(
            {
                "typology": "velocity",
                "weight": 22,
                "detail": f"{velocity} transactions on the account within 24h",
            }
        )
    if (
        txn.get("channel") in ("wire", "crypto")
        and amount >= 0.7 * ctr
        and velocity >= 2
    ):
        signals.append(
            {
                "typology": "rapid_movement",
                "weight": 30,
                "detail": "rapid in/out movement consistent with pass-through",
            }
        )
    if account and account.get("status") == "dormant":
        signals.append(
            {
                "typology": "dormant_reactivation",
                "weight": 20,
                "detail": "activity on a dormant account",
            }
        )

    score = 0.0
    if signals:
        ordered = sorted((s["weight"] for s in signals), reverse=True)
        score = ordered[0] + sum(w * 0.6 for w in ordered[1:])
    if customer and customer.get("kycRiskRating") == "high":
        score += 18
        signals.append(
            {
                "typology": "high_risk_customer",
                "weight": 18,
                "detail": "customer carries a high KYC risk rating",
            }
        )
    score += rng.uniform(0, 6)
    return int(min(100, round(score))), signals


def _recent_count(state: base.State, account_id: str | None, within_hours: int) -> int:
    if not account_id:
        return 0
    cutoff = datetime.now(timezone.utc) - timedelta(hours=within_hours)
    count = 0
    for alert in state.table("alerts").values():
        if alert.get("accountId") != account_id:
            continue
        try:
            seen = datetime.fromisoformat(alert["detectedAt"].replace("Z", "+00:00"))
        except (KeyError, ValueError):
            continue
        if seen >= cutoff:
            count += 1
    return count


# --------------------------------------------------------------------------- #
# alert + case persistence
# --------------------------------------------------------------------------- #
def _open_alert(
    state: base.State, txn: dict, score: int, signals: list[dict], ctx: Ctx
) -> dict:
    band = _band(score)
    primary = max(signals, key=lambda s: s["weight"]) if signals else None
    detected = _ts()
    alert = {
        "alertId": base.new_id("alt"),
        "transactionId": txn["transactionId"],
        "customerId": txn.get("customerId"),
        "accountId": txn.get("accountId"),
        "amount": txn["amount"],
        "currency": txn.get("currency", "USD"),
        "channel": txn.get("channel"),
        "direction": txn.get("direction"),
        "counterparty": txn.get("counterparty"),
        "country": txn.get("country"),
        "typology": primary["typology"] if primary else "unspecified",
        "signals": signals,
        "riskScore": score,
        "riskBand": band,
        "priority": band,
        "status": "open",
        "queue": "aml_l1",
        "assignee": None,
        "disposition": None,
        "dispositionReason": None,
        "caseId": None,
        "filingId": None,
        "detectedAt": detected,
        "slaDueAt": _ts(_SLA_HOURS[band] * 3600),
        "createdAt": detected,
        "updatedAt": detected,
        "delegation": _delegation(ctx),
        "narrative": intelligence.narrative(
            "You are an AML investigator summarizing a monitoring alert in one sentence.",
            f"Transaction {txn['transactionId']} for {txn['amount']:.0f} {txn.get('currency', 'USD')} "
            f"triggered {primary['typology'] if primary else 'a monitoring rule'} at {band} risk.",
            f"Alert raised on transaction {txn['transactionId']} for "
            f"{primary['typology'] if primary else 'suspicious activity'} at {band} risk.",
        ),
        "_auditKey": None,
    }
    alert["_auditKey"] = alert["alertId"]
    state.table("alerts")[alert["alertId"]] = alert
    _audit(
        state,
        alert,
        "alert_opened",
        ctx,
        {"riskScore": score, "riskBand": band, "typology": alert["typology"]},
    )
    return alert


def _open_case(state: base.State, alert: dict, ctx: Ctx, reason: str) -> dict:
    created = _ts()
    case = {
        "caseId": base.new_id("case"),
        "title": f"{alert['typology']} investigation — {alert['transactionId']}",
        "customerId": alert.get("customerId"),
        "status": "open",
        "priority": alert["priority"],
        "queue": "aml_l2",
        "riskScore": alert["riskScore"],
        "riskBand": alert["riskBand"],
        "assignee": None,
        "alertIds": [alert["alertId"]],
        "filingIds": [],
        "disposition": None,
        "dispositionReason": None,
        "openedReason": reason,
        "slaDueAt": _ts(_SLA_HOURS[alert["priority"]] * 3600),
        "createdAt": created,
        "updatedAt": created,
        "resolvedAt": None,
        "resolvedBy": None,
        "delegation": _delegation(ctx),
        "_auditKey": None,
    }
    case["_auditKey"] = case["caseId"]
    state.table("cases")[case["caseId"]] = case
    alert["caseId"] = case["caseId"]
    _audit(
        state, case, "case_opened", ctx, {"reason": reason, "alertId": alert["alertId"]}
    )
    return case


# --------------------------------------------------------------------------- #
# regulatory filing lifecycle
# --------------------------------------------------------------------------- #
def _prepare_filing(state: base.State, alert: dict, filing_type: str, ctx: Ctx) -> dict:
    meta = _meta(state)
    customer = state.table("customers").get(alert.get("customerId") or "")
    deadline_days = _FILING_DEADLINE_DAYS[filing_type]
    detected = alert.get("detectedAt", _ts())
    deadline = (
        (
            datetime.fromisoformat(detected.replace("Z", "+00:00"))
            + timedelta(days=deadline_days)
        )
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )
    created = _ts()
    filing = {
        "filingId": base.new_id("fil"),
        "filingType": filing_type,
        "alertId": alert["alertId"],
        "caseId": alert.get("caseId"),
        "status": "draft",
        "regulator": "FinCEN",
        "form": "FinCEN SAR (111)" if filing_type == "SAR" else "FinCEN CTR (112)",
        "subject": {
            "customerId": alert.get("customerId"),
            "legalName": (customer or {}).get("legalName"),
            "country": (customer or {}).get("country"),
        },
        "amount": alert["amount"],
        "currency": alert.get("currency", "USD"),
        "suspiciousActivity": alert["typology"] if filing_type == "SAR" else None,
        "thresholdApplied": meta["sarThreshold"]
        if filing_type == "SAR"
        else meta["ctrThreshold"],
        "detectedAt": detected,
        "deadlineAt": deadline,
        "filedAt": None,
        "acknowledgedAt": None,
        "confirmationNumber": None,
        "bsaTrackingId": None,
        "lateFiling": None,
        "preparedBy": _actor(ctx),
        "createdAt": created,
        "updatedAt": created,
        "delegation": _delegation(ctx),
        "narrative": intelligence.narrative(
            "You are an AML investigator drafting a regulatory filing narrative in one sentence.",
            f"Draft a {filing_type} narrative for {filing_type} on alert {alert['alertId']} "
            f"({alert['typology']}, {alert['amount']:.0f} {alert.get('currency', 'USD')}).",
            f"{filing_type} {('documents suspicious ' + alert['typology'] + ' activity') if filing_type == 'SAR' else 'reports a reportable currency transaction'} "
            f"of {alert['amount']:.0f} {alert.get('currency', 'USD')} tied to alert {alert['alertId']}.",
        ),
        "_auditKey": None,
    }
    filing["_auditKey"] = filing["filingId"]
    state.table("filings")[filing["filingId"]] = filing
    alert["filingId"] = filing["filingId"]
    if alert.get("caseId"):
        case = state.table("cases").get(alert["caseId"])
        if case is not None:
            case["filingIds"].append(filing["filingId"])
    _audit(
        state,
        filing,
        "filing_prepared",
        ctx,
        {
            "filingType": filing_type,
            "alertId": alert["alertId"],
            "deadlineAt": deadline,
        },
    )
    return filing


def _submit_filing(state: base.State, filing: dict, ctx: Ctx) -> dict:
    rng = gen._rng(ID, "bsa", filing["filingId"])
    filed = _ts()
    late = filed > filing["deadlineAt"]
    filing["status"] = "acknowledged"
    filing["filedAt"] = filed
    filing["acknowledgedAt"] = filed
    filing["confirmationNumber"] = f"{rng.randint(10**13, 10**14 - 1)}"
    filing["bsaTrackingId"] = f"BSA-{rng.randint(10**8, 10**9 - 1)}"
    filing["lateFiling"] = late
    _audit(
        state,
        filing,
        "filing_submitted",
        ctx,
        {"confirmationNumber": filing["confirmationNumber"], "lateFiling": late},
    )
    return filing


# --------------------------------------------------------------------------- #
# seeded history
# --------------------------------------------------------------------------- #
class _SeedCtx:
    """A system principal used to attribute seeded history to an internal mandate."""

    def __init__(self, state: base.State):
        self.state = state
        self.principal = {
            "principal": "system@verafin",
            "subjectType": "application",
            "zone": "lynx-zone",
            "agentSessionId": "agent_seed",
            "rootSessionId": "root_seed",
            "sessionId": "sid_seed",
            "delegationEdgeId": "edge_seed",
            "mandateId": "seed",
        }


def _seed_history(state: base.State) -> None:
    rng = gen._rng(ID, "history")
    ctx = _SeedCtx(state)
    accounts = list(state.table("accounts").values())
    analysts = ("amelia.stone@verafin", "raj.patel@verafin", "nina.kovac@verafin")
    high_risk = list(_meta(state)["highRisk"])
    ctr = _meta(state)["ctrThreshold"]

    alerts: list[dict] = []
    for account in accounts:
        customer = state.table("customers").get(account["customerId"], {})
        for _ in range(rng.randint(2, 4)):
            channel = rng.choice(("wire", "ach", "cash", "card", "crypto"))
            amount = float(
                rng.choice(
                    (
                        rng.randint(2_000, 9_900),
                        rng.randint(9_000, 9_990),
                        rng.randint(50_000, 250_000),
                        rng.randint(250_000, 1_200_000),
                    )
                )
            )
            country = customer.get("country")
            if rng.random() < 0.3:
                country = rng.choice(high_risk)
            txn = {
                "transactionId": f"seed-{account['accountId']}-{rng.randint(1000, 9999)}",
                "amount": amount,
                "currency": account["currency"],
                "customerId": account["customerId"],
                "accountId": account["accountId"],
                "channel": channel,
                "direction": rng.choice(("inbound", "outbound")),
                "country": country,
                "counterparty": gen._company(rng),
            }
            score, signals = _score_transaction(state, txn)
            if score < 60:
                continue
            alerts.append(_open_alert(state, txn, score, signals, ctx))

    for idx, alert in enumerate(alerts):
        analyst = analysts[idx % len(analysts)]
        roll = rng.random()
        if alert["riskBand"] in ("high", "critical") and roll < 0.5:
            _set_assignee(state, alert, analyst, ctx)
            case = _open_case(state, alert, ctx, "Escalated from L1 triage.")
            cash_ctr = alert["amount"] >= ctr and alert["channel"] == "cash"
            filing = _prepare_filing(state, alert, "CTR" if cash_ctr else "SAR", ctx)
            if rng.random() < 0.7:
                _submit_filing(state, filing, ctx)
                _resolve_case(
                    state,
                    case,
                    "file_sar",
                    "Suspicious activity confirmed; regulatory filing submitted.",
                    ctx,
                )
                alert["status"] = "escalated"
        elif roll < 0.75:
            _set_assignee(state, alert, analyst, ctx)
            _resolve_alert(
                state,
                alert,
                "false_positive",
                "Secondary review cleared the alert against expected account activity.",
                ctx,
            )
        elif roll < 0.9:
            _set_assignee(state, alert, analyst, ctx)

    for control in list(state.table("controls").values()):
        if rng.random() < 0.7:
            _record_attestation(
                state,
                control,
                rng.choice(analysts),
                "2026-Q1",
                rng.choice(("effective", "effective", "effective", "deficient")),
                ctx,
            )


# --------------------------------------------------------------------------- #
# lifecycle helpers
# --------------------------------------------------------------------------- #
def _set_assignee(state: base.State, alert: dict, assignee: str, ctx: Ctx) -> None:
    alert["assignee"] = assignee
    alert["status"] = "in_review"
    _audit(state, alert, "alert_assigned", ctx, {"assignee": assignee})


def _resolve_alert(
    state: base.State, alert: dict, disposition: str, reason: str, ctx: Ctx
) -> None:
    alert["status"] = "resolved"
    alert["disposition"] = disposition
    alert["dispositionReason"] = reason
    _audit(
        state,
        alert,
        "alert_resolved",
        ctx,
        {"disposition": disposition, "reason": reason},
    )


def _resolve_case(
    state: base.State, case: dict, disposition: str, reason: str, ctx: Ctx
) -> None:
    case["status"] = "resolved"
    case["disposition"] = disposition
    case["dispositionReason"] = reason
    case["resolvedAt"] = _ts()
    case["resolvedBy"] = _actor(ctx)
    _audit(
        state,
        case,
        "case_resolved",
        ctx,
        {"disposition": disposition, "reason": reason},
    )


def _record_attestation(
    state: base.State,
    control: dict,
    attestor: str,
    period: str,
    effectiveness: str,
    ctx: Ctx,
) -> dict:
    at = _ts()
    status = "attested" if effectiveness == "effective" else "exception"
    attestation = {
        "attestationId": base.new_id("att"),
        "controlId": control["controlId"],
        "controlName": control["name"],
        "regulatoryCitation": control["regulatoryCitation"],
        "period": period,
        "attestor": attestor,
        "status": status,
        "effectiveness": effectiveness,
        "remediationDueAt": _ts(30 * 86400) if status == "exception" else None,
        "attestedAt": at,
        "createdAt": at,
        "updatedAt": at,
        "delegation": _delegation(ctx),
        "_auditKey": None,
    }
    attestation["_auditKey"] = attestation["attestationId"]
    state.table("attestations")[attestation["attestationId"]] = attestation
    control["lastAttestedAt"] = at
    control["effectiveness"] = effectiveness
    _audit(
        state,
        attestation,
        "control_attested",
        ctx,
        {"period": period, "effectiveness": effectiveness},
    )
    return attestation


def _public(record: dict) -> dict:
    """Strip internal bookkeeping keys before returning a record on the wire."""
    return {k: v for k, v in record.items() if not k.startswith("_")}


# --------------------------------------------------------------------------- #
# operations — monitoring
# --------------------------------------------------------------------------- #
@base.op(ID, "monitor_transaction")
def monitor_transaction(ctx: Ctx) -> dict:
    """Score a transaction against the monitoring rules; raise an alert when flagged."""
    ctx.require_scope("monitoring.run")
    ctx.require("transactionId", "amount")
    try:
        amount = float(ctx.payload["amount"])
    except (TypeError, ValueError):
        raise DomainError(422, "invalid_request", "amount must be numeric")
    if amount < 0:
        raise DomainError(422, "invalid_request", "amount must be non-negative")
    channel = ctx.get("channel")
    if channel is not None and channel not in gen.VERAFIN_CHANNELS:
        raise DomainError(
            422,
            "invalid_channel",
            f"channel must be one of {', '.join(gen.VERAFIN_CHANNELS)}",
        )
    txn = {
        "transactionId": str(ctx.payload["transactionId"]),
        "amount": amount,
        "currency": ctx.get("currency", "USD"),
        "customerId": ctx.get("customerId"),
        "accountId": ctx.get("accountId"),
        "channel": channel,
        "direction": ctx.get("direction"),
        "counterparty": ctx.get("counterparty"),
        "country": ctx.get("country"),
    }
    score, signals = _score_transaction(ctx.state, txn)
    band = _band(score)
    flagged = score >= 60
    ctr = _meta(ctx.state)["ctrThreshold"]
    result = {
        "transactionId": txn["transactionId"],
        "riskScore": score,
        "riskBand": band,
        "flagged": flagged,
        "signals": signals,
        "ctrReportable": txn["channel"] == "cash" and amount >= ctr,
        "evaluatedAt": _ts(),
    }
    if flagged:
        alert = _open_alert(ctx.state, txn, score, signals, ctx)
        result["alertId"] = alert["alertId"]
        result["recommendedAction"] = (
            "investigate" if band in ("high", "critical") else "review"
        )
    return result


@base.op(ID, "get_alert")
def get_alert(ctx: Ctx) -> dict:
    ctx.require_scope("alerts.read")
    ctx.require("alertId")
    alert = ctx.state.table("alerts").get(ctx.payload["alertId"])
    if alert is None:
        raise DomainError(404, "alert_not_found", ctx.payload["alertId"])
    return _public(alert)


@base.op(ID, "list_alerts")
def list_alerts(ctx: Ctx) -> dict:
    ctx.require_scope("alerts.read")
    items = [_public(a) for a in ctx.state.table("alerts").values()]
    if ctx.get("status"):
        items = [a for a in items if a["status"] == ctx.get("status")]
    if ctx.get("riskBand"):
        items = [a for a in items if a["riskBand"] == ctx.get("riskBand")]
    if ctx.get("typology"):
        items = [a for a in items if a["typology"] == ctx.get("typology")]
    if ctx.get("assignee"):
        items = [a for a in items if a.get("assignee") == ctx.get("assignee")]
    items.sort(key=lambda a: a["detectedAt"], reverse=True)
    return ctx.paginate(items)


@base.op(ID, "assign_alert")
def assign_alert(ctx: Ctx) -> dict:
    ctx.require_scope("cases.write")
    ctx.require("alertId", "assignee")
    alert = ctx.state.table("alerts").get(ctx.payload["alertId"])
    if alert is None:
        raise DomainError(404, "alert_not_found", ctx.payload["alertId"])
    if alert["status"] == "resolved":
        raise DomainError(409, "alert_resolved", "cannot assign a resolved alert")
    _set_assignee(ctx.state, alert, str(ctx.payload["assignee"]), ctx)
    return _public(alert)


@base.op(ID, "resolve_alert")
def resolve_alert(ctx: Ctx) -> dict:
    """Disposition an alert. A 'file_sar' or 'escalate' disposition opens an investigation case."""
    ctx.require_scope("cases.write")
    ctx.require("alertId", "disposition")
    alert = ctx.state.table("alerts").get(ctx.payload["alertId"])
    if alert is None:
        raise DomainError(404, "alert_not_found", ctx.payload["alertId"])
    disposition = ctx.payload["disposition"]
    if disposition not in _ALERT_DISPOSITIONS:
        raise DomainError(
            422,
            "invalid_disposition",
            f"disposition must be one of {', '.join(_ALERT_DISPOSITIONS)}",
        )
    if alert["status"] == "resolved":
        raise DomainError(409, "alert_resolved", "alert already resolved")
    reason = ctx.get("reason", "Disposition recorded by analyst.")
    if disposition in ("file_sar", "escalate"):
        case = alert.get("caseId") and ctx.state.table("cases").get(alert["caseId"])
        if not case:
            case = _open_case(
                ctx.state,
                alert,
                ctx,
                "Confirmed suspicious activity."
                if disposition == "file_sar"
                else "Escalated for enhanced investigation.",
            )
        _audit(ctx.state, alert, "alert_escalated", ctx, {"caseId": case["caseId"]})
        alert["status"] = "escalated"
        return {"alert": _public(alert), "caseId": case["caseId"]}
    _resolve_alert(ctx.state, alert, disposition, reason, ctx)
    return {"alert": _public(alert), "caseId": alert.get("caseId")}


# --------------------------------------------------------------------------- #
# operations — investigation cases
# --------------------------------------------------------------------------- #
@base.op(ID, "open_case")
def open_case(ctx: Ctx) -> dict:
    ctx.require_scope("cases.write")
    ctx.require("alertId")
    alert = ctx.state.table("alerts").get(ctx.payload["alertId"])
    if alert is None:
        raise DomainError(404, "alert_not_found", ctx.payload["alertId"])
    if alert.get("caseId"):
        return _public(ctx.state.table("cases")[alert["caseId"]])
    case = _open_case(
        ctx.state, alert, ctx, ctx.get("reason", "Manual investigation opened.")
    )
    return _public(case)


@base.op(ID, "get_case")
def get_case(ctx: Ctx) -> dict:
    ctx.require_scope("cases.read")
    ctx.require("caseId")
    case = ctx.state.table("cases").get(ctx.payload["caseId"])
    if case is None:
        raise DomainError(404, "case_not_found", ctx.payload["caseId"])
    return _public(case)


@base.op(ID, "list_cases")
def list_cases(ctx: Ctx) -> dict:
    ctx.require_scope("cases.read")
    items = [_public(c) for c in ctx.state.table("cases").values()]
    if ctx.get("status"):
        items = [c for c in items if c["status"] == ctx.get("status")]
    if ctx.get("priority"):
        items = [c for c in items if c["priority"] == ctx.get("priority")]
    if ctx.get("assignee"):
        items = [c for c in items if c.get("assignee") == ctx.get("assignee")]
    items.sort(key=lambda c: c["createdAt"], reverse=True)
    return ctx.paginate(items)


@base.op(ID, "add_case_note")
def add_case_note(ctx: Ctx) -> dict:
    ctx.require_scope("cases.write")
    ctx.require("caseId", "note")
    case = ctx.state.table("cases").get(ctx.payload["caseId"])
    if case is None:
        raise DomainError(404, "case_not_found", ctx.payload["caseId"])
    event = _audit(
        ctx.state, case, "note_added", ctx, {"note": str(ctx.payload["note"])}
    )
    return {"caseId": case["caseId"], "event": event}


@base.op(ID, "escalate_case")
def escalate_case(ctx: Ctx) -> dict:
    ctx.require_scope("cases.write")
    ctx.require("caseId")
    case = ctx.state.table("cases").get(ctx.payload["caseId"])
    if case is None:
        raise DomainError(404, "case_not_found", ctx.payload["caseId"])
    if case["status"] in ("resolved", "closed"):
        raise DomainError(409, "case_closed", "cannot escalate a closed case")
    case["status"] = "escalated"
    case["queue"] = ctx.get("queue", "aml_l3")
    case["priority"] = "critical"
    _audit(
        ctx.state,
        case,
        "case_escalated",
        ctx,
        {
            "queue": case["queue"],
            "reason": ctx.get("reason", "Manual escalation requested."),
        },
    )
    return _public(case)


@base.op(ID, "resolve_case")
def resolve_case(ctx: Ctx) -> dict:
    ctx.require_scope("cases.write")
    ctx.require("caseId", "disposition")
    case = ctx.state.table("cases").get(ctx.payload["caseId"])
    if case is None:
        raise DomainError(404, "case_not_found", ctx.payload["caseId"])
    if case["status"] in ("resolved", "closed"):
        raise DomainError(409, "already_resolved", "case already resolved")
    disposition = ctx.payload["disposition"]
    if disposition not in _ALERT_DISPOSITIONS:
        raise DomainError(
            422,
            "invalid_disposition",
            f"disposition must be one of {', '.join(_ALERT_DISPOSITIONS)}",
        )
    _resolve_case(
        ctx.state,
        case,
        disposition,
        ctx.get("reason", "Investigation closed by analyst."),
        ctx,
    )
    return _public(case)


# --------------------------------------------------------------------------- #
# operations — regulatory filings
# --------------------------------------------------------------------------- #
@base.op(ID, "prepare_filing")
def prepare_filing(ctx: Ctx) -> dict:
    """Assemble a SAR or CTR regulatory filing from an alert, with a regulator deadline."""
    ctx.require_scope("filings.write")
    ctx.require("alertId", "filingType")
    alert = ctx.state.table("alerts").get(ctx.payload["alertId"])
    if alert is None:
        raise DomainError(404, "alert_not_found", ctx.payload["alertId"])
    filing_type = ctx.payload["filingType"]
    if filing_type not in _FILING_TYPES:
        raise DomainError(422, "invalid_filing_type", "filingType must be SAR or CTR")
    if alert.get("filingId"):
        existing = ctx.state.table("filings").get(alert["filingId"])
        if existing and existing["status"] != "draft":
            raise DomainError(
                409, "filing_exists", f"alert already has filing {alert['filingId']}"
            )
    filing = _prepare_filing(ctx.state, alert, filing_type, ctx)
    return _public(filing)


@base.op(ID, "get_filing")
def get_filing(ctx: Ctx) -> dict:
    ctx.require_scope("filings.read")
    ctx.require("filingId")
    filing = ctx.state.table("filings").get(ctx.payload["filingId"])
    if filing is None:
        raise DomainError(404, "filing_not_found", ctx.payload["filingId"])
    return _public(filing)


@base.op(ID, "list_filings")
def list_filings(ctx: Ctx) -> dict:
    ctx.require_scope("filings.read")
    items = [_public(f) for f in ctx.state.table("filings").values()]
    if ctx.get("status"):
        items = [f for f in items if f["status"] == ctx.get("status")]
    if ctx.get("filingType"):
        items = [f for f in items if f["filingType"] == ctx.get("filingType")]
    items.sort(key=lambda f: f["createdAt"], reverse=True)
    return ctx.paginate(items)


@base.op(ID, "submit_filing")
def submit_filing(ctx: Ctx) -> dict:
    """Submit a prepared filing to FinCEN, returning a BSA confirmation number."""
    ctx.require_scope("filings.submit")
    ctx.require("filingId")
    filing = ctx.state.table("filings").get(ctx.payload["filingId"])
    if filing is None:
        raise DomainError(404, "filing_not_found", ctx.payload["filingId"])
    if filing["status"] != "draft":
        raise DomainError(
            409,
            "filing_not_submittable",
            f"filing is {filing['status']!r}, not 'draft'",
        )
    if filing["filingType"] == "SAR" and not filing.get("suspiciousActivity"):
        raise DomainError(
            422,
            "incomplete_filing",
            "SAR requires a suspicious-activity classification",
        )
    if not filing["subject"].get("customerId"):
        raise DomainError(
            422, "incomplete_filing", "filing requires an identified subject"
        )
    _submit_filing(ctx.state, filing, ctx)
    return _public(filing)


# --------------------------------------------------------------------------- #
# operations — controls + attestation
# --------------------------------------------------------------------------- #
@base.op(ID, "list_controls")
def list_controls(ctx: Ctx) -> dict:
    ctx.require_scope("monitoring.read")
    return {"controls": list(ctx.state.table("controls").values())}


@base.op(ID, "attest_control")
def attest_control(ctx: Ctx) -> dict:
    """Record a control attestation for a regulatory or internal control."""
    ctx.require_scope("attestations.write")
    ctx.require("controlId", "attestor")
    control = ctx.state.table("controls").get(ctx.payload["controlId"])
    if control is None:
        raise DomainError(404, "control_not_found", ctx.payload["controlId"])
    effectiveness = ctx.get("effectiveness", "effective")
    if effectiveness not in ("effective", "deficient"):
        raise DomainError(
            422,
            "invalid_effectiveness",
            "effectiveness must be 'effective' or 'deficient'",
        )
    attestation = _record_attestation(
        ctx.state,
        control,
        str(ctx.payload["attestor"]),
        ctx.get("period", "2026-Q2"),
        effectiveness,
        ctx,
    )
    return _public(attestation)


@base.op(ID, "get_attestation")
def get_attestation(ctx: Ctx) -> dict:
    ctx.require_scope("monitoring.read")
    ctx.require("attestationId")
    att = ctx.state.table("attestations").get(ctx.payload["attestationId"])
    if att is None:
        raise DomainError(404, "attestation_not_found", ctx.payload["attestationId"])
    return _public(att)


@base.op(ID, "list_attestations")
def list_attestations(ctx: Ctx) -> dict:
    ctx.require_scope("monitoring.read")
    items = [_public(a) for a in ctx.state.table("attestations").values()]
    if ctx.get("controlId"):
        items = [a for a in items if a["controlId"] == ctx.get("controlId")]
    if ctx.get("period"):
        items = [a for a in items if a["period"] == ctx.get("period")]
    items.sort(key=lambda a: a["attestedAt"], reverse=True)
    return ctx.paginate(items)


# --------------------------------------------------------------------------- #
# operations — audit + delegation traceability
# --------------------------------------------------------------------------- #
@base.op(ID, "get_audit_trail")
def get_audit_trail(ctx: Ctx) -> dict:
    """Return the hash-chained audit trail for an alert, case, or filing, with the
    delegation chain that authorized each event and a tamper-evidence check."""
    ctx.require_scope("cases.read")
    subject_id = ctx.get("caseId") or ctx.get("alertId") or ctx.get("filingId")
    if not subject_id:
        raise DomainError(
            422, "invalid_request", "provide caseId, alertId, or filingId"
        )
    subject = (
        ctx.state.table("cases").get(subject_id)
        or ctx.state.table("alerts").get(subject_id)
        or ctx.state.table("filings").get(subject_id)
    )
    if subject is None:
        raise DomainError(404, "subject_not_found", subject_id)
    events = subject.get("auditTrail", [])
    return {
        "subjectId": subject_id,
        "events": events,
        "eventCount": len(events),
        "chainIntact": _audit_intact(subject_id, events),
        "delegationChain": [e["delegation"] for e in events],
    }
