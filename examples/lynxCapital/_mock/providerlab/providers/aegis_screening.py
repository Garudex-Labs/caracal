"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Aegis Screening domain: sanctions, PEP, and adverse-media screening, KYB entity verification, risk scoring, case management, and ongoing monitoring.
"""

from __future__ import annotations

import hashlib
import time
from datetime import datetime, timedelta, timezone

from _mock.providerlab import intelligence
from _mock.providerlab.data import generators as gen
from _mock.providerlab.providers import base
from _mock.providerlab.providers.base import Ctx, DomainError

ID = "aegis-screening"

# Program weights drive the composite 0-100 risk score; sanctions dominate, with
# politically-exposed-person and adverse-media signals contributing less.
_PROGRAM_WEIGHT = {
    "SANCTIONS": 60,
    "LAW_ENFORCEMENT": 45,
    "PEP": 25,
    "ADVERSE_MEDIA": 18,
}
_BANDS = (("critical", 75), ("high", 50), ("medium", 25), ("low", 0))
_SLA_HOURS = {"critical": 4, "high": 24, "medium": 72, "low": 168}
_DISPOSITIONS = ("false_positive", "true_match", "no_match", "escalate")


def _ts(offset_seconds: int = 0) -> str:
    moment = datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)
    return moment.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _norm(value: str) -> str:
    return " ".join(str(value or "").lower().split())


def _tokens(value: str) -> set[str]:
    drop = {
        "llc",
        "ltd",
        "inc",
        "co",
        "corp",
        "ooo",
        "gmbh",
        "plc",
        "sa",
        "ag",
        "the",
        "and",
    }
    return {
        t
        for t in _norm(value).replace(".", "").replace(",", "").split()
        if t and t not in drop
    }


@base.seeder(ID)
def seed(state: base.State) -> None:
    ref = gen.aegis_reference(ID)
    state.tables["watchlists"] = dict(ref["watchlists"])
    entities: dict[str, dict] = {}
    for rec in ref["sanctioned"]:
        entities[rec["entityId"]] = dict(rec)
    for rec in ref["businesses"]:
        entities[rec["entityId"]] = dict(rec)
    state.tables["entities"] = entities
    state.tables["screenings"] = {}
    state.tables["watchlist_hits"] = {}
    state.tables["cases"] = {}
    state.tables["audit_events"] = {}
    state.tables["monitors"] = {}
    _seed_history(state)


# --------------------------------------------------------------------------- #
# matching, scoring, decisioning
# --------------------------------------------------------------------------- #
def _watchlist_subjects(state: base.State) -> list[dict]:
    return [
        e for e in state.table("entities").values() if e.get("source") == "watchlist"
    ]


def _match(state: base.State, name: str, etype: str, country: str | None) -> list[dict]:
    """Resolve a subject against the watchlist index, returning ranked candidate hits."""
    target = _tokens(name)
    target_norm = _norm(name)
    hits: list[dict] = []
    for subject in _watchlist_subjects(state):
        names = [subject["legalName"], *subject.get("aliases", [])]
        best = 0.0
        match_type = None
        for candidate in names:
            if _norm(candidate) == target_norm:
                best, match_type = 1.0, "exact"
                break
            cand_tokens = _tokens(candidate)
            if not cand_tokens or not target:
                continue
            jaccard = len(target & cand_tokens) / len(target | cand_tokens)
            if jaccard > best:
                best = jaccard
                match_type = "fuzzy"
        if match_type == "exact" or best >= 0.5:
            score = round(best if match_type == "exact" else 0.74 + best * 0.2, 2)
            hits.append(_hit(subject, match_type or "fuzzy", min(score, 0.99)))

    if not hits:
        rng = gen._rng(ID, "noise", _norm(name))
        if rng.random() < 0.12:
            subject = rng.choice(_watchlist_subjects(state))
            if "ADVERSE_MEDIA" in subject.get("programs", []) or "PEP" in subject.get(
                "programs", []
            ):
                hits.append(_hit(subject, "fuzzy", round(rng.uniform(0.74, 0.84), 2)))
    hits.sort(key=lambda h: h["matchScore"], reverse=True)
    return hits


def _hit(subject: dict, match_type: str, score: float) -> dict:
    return {
        "matchedEntityId": subject["entityId"],
        "matchedName": subject["legalName"],
        "matchType": match_type,
        "matchScore": score,
        "entityType": subject["type"],
        "programs": list(subject.get("programs", [])),
        "watchlists": list(subject.get("watchlists", [])),
        "aliases": list(subject.get("aliases", [])),
        "country": subject.get("country"),
        "sanctionType": subject.get("sanctionType"),
        "dateOfBirth": subject.get("dateOfBirth"),
        "falsePositiveProbability": round(
            max(0.02, 1 - score) * (0.4 if match_type == "exact" else 0.8), 2
        ),
    }


def _band(score: float) -> str:
    for name, floor in _BANDS:
        if score >= floor:
            return name
    return "low"


def _risk(
    hits: list[dict], country: str | None, entity_status: str | None
) -> tuple[int, str, list[dict]]:
    factors: list[dict] = []
    contributions: list[float] = []
    for hit in hits:
        weight = max((_PROGRAM_WEIGHT.get(p, 10) for p in hit["programs"]), default=10)
        weight *= 1.0 if hit["matchType"] == "exact" else 0.6
        contributions.append(weight)
        factors.append(
            {
                "factor": "watchlist_match",
                "list": hit["watchlists"][0] if hit["watchlists"] else None,
                "matchType": hit["matchType"],
                "weight": round(weight, 1),
            }
        )
    contributions.sort(reverse=True)
    score = contributions[0] if contributions else 0.0
    score += sum(c * 0.4 for c in contributions[1:])
    if country in gen.AEGIS_HIGH_RISK:
        score += 15
        factors.append(
            {"factor": "high_risk_jurisdiction", "country": country, "weight": 15}
        )
    if entity_status == "dissolved":
        score += 20
        factors.append({"factor": "dissolved_entity", "weight": 20})
    score = int(min(100, round(score)))
    return score, _band(score), factors


def _decision(hits: list[dict], band: str) -> tuple[str, str]:
    blocking = any(
        "SANCTIONS" in h["programs"] and h["matchType"] == "exact" for h in hits
    )
    if blocking or band == "critical":
        return "block", "reject_and_escalate_edd"
    if hits or band in ("high", "medium"):
        return "review", "manual_review"
    return "clear", "approve"


# --------------------------------------------------------------------------- #
# persistence helpers
# --------------------------------------------------------------------------- #
def _audit(state: base.State, case: dict, kind: str, actor: str, details: dict) -> dict:
    """Append a tamper-evident audit event, hash-chained to the case's prior event."""
    prev = case["auditTrail"][-1]["hash"] if case["auditTrail"] else "genesis"
    at = _ts()
    event_id = base.new_id("evt")
    digest = hashlib.sha256(
        f"{case['caseId']}|{kind}|{actor}|{at}|{prev}".encode()
    ).hexdigest()[:16]
    event = {
        "eventId": event_id,
        "caseId": case["caseId"],
        "type": kind,
        "actor": actor,
        "at": at,
        "details": details,
        "prevHash": prev,
        "hash": digest,
    }
    case["auditTrail"].append(event)
    state.table("audit_events")[event_id] = event
    return event


def _open_case(
    state: base.State, screening: dict, hits: list[dict], actor: str
) -> dict:
    band = screening["riskBand"]
    priority = {"critical": "critical", "high": "high", "medium": "medium"}.get(
        band, "low"
    )
    created = _ts()
    case = {
        "caseId": base.new_id("case"),
        "screeningId": screening["screeningId"],
        "entityId": screening.get("entityId"),
        "subjectName": screening["subject"]["name"],
        "subjectType": screening["subject"]["type"],
        "status": "open",
        "priority": priority,
        "queue": "sanctions_l1"
        if any("SANCTIONS" in h["programs"] for h in hits)
        else "aml_l1",
        "riskScore": screening["riskScore"],
        "riskBand": band,
        "assignee": None,
        "slaDueAt": _ts(_SLA_HOURS[priority] * 3600),
        "hits": [
            {
                "hitId": h["hitId"],
                "list": h.get("watchlists", []),
                "matchedName": h["matchedName"],
                "matchScore": h["matchScore"],
                "matchType": h["matchType"],
            }
            for h in hits
        ],
        "disposition": None,
        "dispositionReason": None,
        "auditTrail": [],
        "createdAt": created,
        "updatedAt": created,
        "resolvedAt": None,
        "resolvedBy": None,
        "summary": intelligence.narrative(
            "You are a sanctions and AML analyst. Summarize the screening alert in one sentence.",
            f"Subject {screening['subject']['name']} produced {len(hits)} watchlist match(es) "
            f"at {band} risk against "
            f"{', '.join(sorted({w for h in hits for w in h.get('watchlists', [])})) or 'screening lists'}.",
            f"Potential {band}-risk match for {screening['subject']['name']} "
            f"against {hits[0]['watchlists'][0] if hits and hits[0]['watchlists'] else 'a screening list'}.",
        ),
    }
    state.table("cases")[case["caseId"]] = case
    _audit(
        state, case, "case_opened", actor, {"riskBand": band, "matchCount": len(hits)}
    )
    return case


def _persist_screen(
    state: base.State,
    subject: dict,
    screen_type: str,
    actor: str,
    entity_id: str | None = None,
) -> dict:
    start = time.time()
    raw_hits = _match(state, subject["name"], subject["type"], subject.get("country"))
    screening_id = base.new_id("scr")
    stored_hits: list[dict] = []
    for raw in raw_hits:
        raw["hitId"] = base.new_id("hit")
        raw["screeningId"] = screening_id
        raw["status"] = "pending"
        state.table("watchlist_hits")[raw["hitId"]] = raw
        stored_hits.append(raw)
    status_for_risk = None
    if entity_id:
        entity = state.table("entities").get(entity_id)
        status_for_risk = entity.get("status") if entity else None
    score, band, factors = _risk(stored_hits, subject.get("country"), status_for_risk)
    decision, recommended = _decision(stored_hits, band)
    screened_lists = sorted(
        {w for h in stored_hits for w in h.get("watchlists", [])}
    ) or list(state.table("watchlists"))
    screening = {
        "screeningId": screening_id,
        "requestId": base.new_id("req"),
        "type": screen_type,
        "subject": subject,
        "entityId": entity_id,
        "screenedLists": screened_lists,
        "matchCount": len(stored_hits),
        "matches": [h["hitId"] for h in stored_hits],
        "riskScore": score,
        "riskBand": band,
        "riskFactors": factors,
        "decision": decision,
        "recommendedAction": recommended,
        "status": "completed",
        "screenedBy": actor,
        "createdAt": _ts(),
        "completedAt": _ts(),
        "processingMs": max(1, int((time.time() - start) * 1000)),
        "caseId": None,
    }
    state.table("screenings")[screening_id] = screening
    if decision != "clear":
        case = _open_case(state, screening, stored_hits, actor)
        screening["caseId"] = case["caseId"]
    return screening


# --------------------------------------------------------------------------- #
# seeded history
# --------------------------------------------------------------------------- #
def _seed_history(state: base.State) -> None:
    rng = gen._rng(ID, "history")
    for entity in _watchlist_subjects(state):
        _persist_screen(
            state,
            {
                "name": entity["legalName"],
                "type": entity["type"],
                "country": entity["country"],
            },
            "sanctions",
            "system@aegis",
        )
    for entity in list(state.table("entities").values()):
        if entity.get("source") == "registry":
            _verify_entity(state, entity, "system@aegis")
    clean = (
        "Harbor Freight Partners",
        "Cedar Analytics",
        "Marigold Foods",
        "Driftwood Logistics",
        "Quill Components",
        "Saffron Trading",
    )
    for name in clean:
        _persist_screen(
            state,
            {"name": name, "type": "organization", "country": "US"},
            "sanctions",
            "system@aegis",
        )

    cases = list(state.table("cases").values())
    analysts = ("amelia.stone@aegis", "raj.patel@aegis", "nina.kovac@aegis")
    for idx, case in enumerate(cases):
        roll = rng.random()
        if roll < 0.34:
            _assign(state, case, analysts[idx % len(analysts)], "system@aegis")
        elif roll < 0.55:
            analyst = analysts[idx % len(analysts)]
            _assign(state, case, analyst, "system@aegis")
            _resolve(
                state,
                case,
                "false_positive",
                "Secondary identifiers cleared the alert.",
                analyst,
            )
        elif roll < 0.68 and case["riskBand"] in ("high", "critical"):
            _escalate(
                state,
                case,
                "edd_l2",
                "Strong sanctions match requires enhanced due diligence.",
                analysts[idx % len(analysts)],
            )

    registry = [
        e for e in state.table("entities").values() if e.get("source") == "registry"
    ]
    for entity in registry[:5]:
        _create_monitor(state, entity, rng.choice(("daily", "weekly")), "system@aegis")


# --------------------------------------------------------------------------- #
# case lifecycle helpers
# --------------------------------------------------------------------------- #
def _assign(state: base.State, case: dict, assignee: str, actor: str) -> None:
    case["assignee"] = assignee
    case["status"] = "in_review"
    case["updatedAt"] = _ts()
    _audit(state, case, "case_assigned", actor, {"assignee": assignee})


def _escalate(
    state: base.State, case: dict, queue: str, reason: str, actor: str
) -> None:
    case["status"] = "escalated"
    case["queue"] = queue
    case["priority"] = "critical"
    case["updatedAt"] = _ts()
    _audit(state, case, "case_escalated", actor, {"queue": queue, "reason": reason})


def _resolve(
    state: base.State, case: dict, disposition: str, reason: str, actor: str
) -> None:
    case["status"] = "resolved"
    case["disposition"] = disposition
    case["dispositionReason"] = reason
    case["resolvedAt"] = _ts()
    case["resolvedBy"] = actor
    case["updatedAt"] = _ts()
    for hit_ref in case["hits"]:
        hit = state.table("watchlist_hits").get(hit_ref["hitId"])
        if hit:
            hit["status"] = (
                "cleared"
                if disposition in ("false_positive", "no_match")
                else "confirmed"
            )
    _audit(
        state,
        case,
        "case_resolved",
        actor,
        {"disposition": disposition, "reason": reason},
    )


def _create_monitor(
    state: base.State, entity: dict, frequency: str, actor: str
) -> dict:
    interval = {"realtime": 0, "daily": 86_400, "weekly": 604_800}.get(
        frequency, 86_400
    )
    monitor = {
        "monitorId": base.new_id("mon"),
        "entityId": entity["entityId"],
        "subjectName": entity["legalName"],
        "subjectType": entity["type"],
        "frequency": frequency,
        "status": "active",
        "createdBy": actor,
        "createdAt": _ts(),
        "lastRunAt": _ts(),
        "nextRunAt": _ts(interval),
        "lastDecision": entity.get("lastDecision", "clear"),
        "hitCount": 0,
    }
    state.table("monitors")[monitor["monitorId"]] = monitor
    return monitor


def _verify_entity(state: base.State, entity: dict, actor: str) -> dict:
    """Run a KYB verification pass over a registry entity and its beneficial owners."""
    screening = _persist_screen(
        state,
        {
            "name": entity["legalName"],
            "type": "organization",
            "country": entity["country"],
        },
        "kyb",
        actor,
        entity_id=entity["entityId"],
    )
    owner_flags = []
    for owner in entity.get("beneficialOwners", []):
        owner_hits = _match(state, owner["name"], "individual", owner.get("country"))
        owner["screeningResult"] = "hit" if owner_hits else "clear"
        owner["isPep"] = owner.get("isPep") or any(
            "PEP" in h["programs"] for h in owner_hits
        )
        if owner_hits or owner["isPep"]:
            owner_flags.append(owner["name"])
    blocking = screening["decision"] == "block"
    if entity["status"] == "dissolved" or blocking:
        verification = "failed"
    elif screening["decision"] == "review" or owner_flags:
        verification = "manual_review"
    else:
        verification = "verified"
    entity["verificationStatus"] = verification
    entity["riskScore"] = screening["riskScore"]
    entity["riskBand"] = screening["riskBand"]
    entity["lastDecision"] = screening["decision"]
    entity["lastScreenedAt"] = _ts()
    entity["lastScreeningId"] = screening["screeningId"]
    entity["flaggedOwners"] = owner_flags
    screening["verificationStatus"] = verification
    return screening


# --------------------------------------------------------------------------- #
# operations
# --------------------------------------------------------------------------- #
@base.op(ID, "screen_party")
def screen_party(ctx: Ctx) -> dict:
    """Screen an individual or organization against sanctions, PEP, and adverse-media lists."""
    ctx.require_scope("screening.run")
    ctx.require("name")
    subject = {
        "name": str(ctx.payload["name"]),
        "type": ctx.get("type", "organization"),
        "country": ctx.get("country"),
    }
    if ctx.get("dateOfBirth"):
        subject["dateOfBirth"] = ctx.get("dateOfBirth")
    if ctx.get("identifiers"):
        subject["identifiers"] = ctx.get("identifiers")
    return _persist_screen(ctx.state, subject, "sanctions", _actor(ctx))


@base.op(ID, "verify_business")
def verify_business(ctx: Ctx) -> dict:
    """Run KYB verification: resolve a business entity and screen it and its beneficial owners."""
    ctx.require_scope("screening.run")
    ctx.require("legalName")
    legal = str(ctx.payload["legalName"])
    country = ctx.get("country", "US")
    entity = _resolve_entity(ctx.state, legal, country, ctx.payload)
    screening = _verify_entity(ctx.state, entity, _actor(ctx))
    return {
        "entity": entity,
        "verificationStatus": entity["verificationStatus"],
        "decision": screening["decision"],
        "riskScore": entity["riskScore"],
        "riskBand": entity["riskBand"],
        "flaggedOwners": entity.get("flaggedOwners", []),
        "screeningId": screening["screeningId"],
        "caseId": screening.get("caseId"),
    }


@base.op(ID, "screen_batch")
def screen_batch(ctx: Ctx) -> dict:
    """Screen a list of parties in one request, returning per-item decisions and a summary."""
    ctx.require_scope("screening.run")
    parties = ctx.get("parties")
    batch_id = ctx.get("batchId")
    if not parties:
        if not batch_id:
            raise DomainError(422, "invalid_request", "provide 'parties' or 'batchId'")
        parties = _batch_parties(ctx.state, str(batch_id))
    if not isinstance(parties, list) or not parties:
        raise DomainError(422, "invalid_request", "'parties' must be a non-empty list")
    actor = _actor(ctx)
    results = []
    counts = {"clear": 0, "review": 0, "block": 0}
    for party in parties:
        subject = _party_subject(party)
        screening = _persist_screen(ctx.state, subject, "batch_item", actor)
        counts[screening["decision"]] = counts.get(screening["decision"], 0) + 1
        results.append(
            {
                "name": subject["name"],
                "decision": screening["decision"],
                "riskBand": screening["riskBand"],
                "matchCount": screening["matchCount"],
                "screeningId": screening["screeningId"],
                "caseId": screening.get("caseId"),
            }
        )
    return {
        "batchId": batch_id or base.new_id("batch"),
        "submitted": len(results),
        "summary": counts,
        "results": results,
        "completedAt": _ts(),
    }


@base.op(ID, "rescreen_entity")
def rescreen_entity(ctx: Ctx) -> dict:
    """Re-run screening for a known entity against current lists (ongoing monitoring)."""
    ctx.require_scope("screening.run")
    ctx.require("entityId")
    entity = ctx.state.table("entities").get(ctx.payload["entityId"])
    if entity is None:
        raise DomainError(404, "entity_not_found", ctx.payload["entityId"])
    previous = entity.get("lastDecision")
    if entity.get("source") == "registry":
        screening = _verify_entity(ctx.state, entity, _actor(ctx))
    else:
        screening = _persist_screen(
            ctx.state,
            {
                "name": entity["legalName"],
                "type": entity["type"],
                "country": entity.get("country"),
            },
            "rescreen",
            _actor(ctx),
            entity_id=entity["entityId"],
        )
        entity["lastDecision"] = screening["decision"]
    return {
        "entityId": entity["entityId"],
        "previousDecision": previous,
        "decision": screening["decision"],
        "riskBand": screening["riskBand"],
        "changed": previous != screening["decision"],
        "screeningId": screening["screeningId"],
        "caseId": screening.get("caseId"),
    }


@base.op(ID, "get_screening")
def get_screening(ctx: Ctx) -> dict:
    ctx.require_scope("screening.read")
    ctx.require("screeningId")
    rec = ctx.state.table("screenings").get(ctx.payload["screeningId"])
    if rec is None:
        raise DomainError(404, "screening_not_found", ctx.payload["screeningId"])
    return rec


@base.op(ID, "list_screenings")
def list_screenings(ctx: Ctx) -> dict:
    ctx.require_scope("screening.read")
    items = list(ctx.state.table("screenings").values())
    if ctx.get("decision"):
        items = [s for s in items if s["decision"] == ctx.get("decision")]
    if ctx.get("type"):
        items = [s for s in items if s["type"] == ctx.get("type")]
    if ctx.get("riskBand"):
        items = [s for s in items if s["riskBand"] == ctx.get("riskBand")]
    items.sort(key=lambda s: s["createdAt"], reverse=True)
    return ctx.paginate(items)


@base.op(ID, "get_entity")
def get_entity(ctx: Ctx) -> dict:
    ctx.require_scope("screening.read")
    ctx.require("entityId")
    rec = ctx.state.table("entities").get(ctx.payload["entityId"])
    if rec is None:
        raise DomainError(404, "entity_not_found", ctx.payload["entityId"])
    return rec


@base.op(ID, "get_watchlist_hit")
def get_watchlist_hit(ctx: Ctx) -> dict:
    ctx.require_scope("screening.read")
    ctx.require("hitId")
    rec = ctx.state.table("watchlist_hits").get(ctx.payload["hitId"])
    if rec is None:
        raise DomainError(404, "hit_not_found", ctx.payload["hitId"])
    return rec


@base.op(ID, "list_watchlists")
def list_watchlists(ctx: Ctx) -> dict:
    ctx.require_scope("screening.read")
    return {"watchlists": list(ctx.state.table("watchlists").values())}


@base.op(ID, "get_case")
def get_case(ctx: Ctx) -> dict:
    ctx.require_scope("cases.read")
    ctx.require("caseId")
    rec = ctx.state.table("cases").get(ctx.payload["caseId"])
    if rec is None:
        raise DomainError(404, "case_not_found", ctx.payload["caseId"])
    return rec


@base.op(ID, "list_cases")
def list_cases(ctx: Ctx) -> dict:
    ctx.require_scope("cases.read")
    items = list(ctx.state.table("cases").values())
    if ctx.get("status"):
        items = [c for c in items if c["status"] == ctx.get("status")]
    if ctx.get("priority"):
        items = [c for c in items if c["priority"] == ctx.get("priority")]
    if ctx.get("assignee"):
        items = [c for c in items if c.get("assignee") == ctx.get("assignee")]
    items.sort(key=lambda c: c["createdAt"], reverse=True)
    return ctx.paginate(items)


@base.op(ID, "get_audit_trail")
def get_audit_trail(ctx: Ctx) -> dict:
    ctx.require_scope("cases.read")
    ctx.require("caseId")
    case = ctx.state.table("cases").get(ctx.payload["caseId"])
    if case is None:
        raise DomainError(404, "case_not_found", ctx.payload["caseId"])
    events = case["auditTrail"]
    return {
        "caseId": case["caseId"],
        "events": events,
        "eventCount": len(events),
        "chainIntact": _audit_intact(case["caseId"], events),
    }


@base.op(ID, "assign_case")
def assign_case(ctx: Ctx) -> dict:
    ctx.require_scope("cases.write")
    ctx.require("caseId", "assignee")
    case = ctx.state.table("cases").get(ctx.payload["caseId"])
    if case is None:
        raise DomainError(404, "case_not_found", ctx.payload["caseId"])
    if case["status"] in ("resolved", "closed"):
        raise DomainError(409, "case_closed", "cannot assign a closed case")
    _assign(ctx.state, case, str(ctx.payload["assignee"]), _actor(ctx))
    return case


@base.op(ID, "add_case_note")
def add_case_note(ctx: Ctx) -> dict:
    ctx.require_scope("cases.write")
    ctx.require("caseId", "note")
    case = ctx.state.table("cases").get(ctx.payload["caseId"])
    if case is None:
        raise DomainError(404, "case_not_found", ctx.payload["caseId"])
    event = _audit(
        ctx.state, case, "note_added", _actor(ctx), {"note": str(ctx.payload["note"])}
    )
    case["updatedAt"] = _ts()
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
    _escalate(
        ctx.state,
        case,
        ctx.get("queue", "edd_l2"),
        ctx.get("reason", "Manual escalation requested."),
        _actor(ctx),
    )
    return case


@base.op(ID, "resolve_case")
def resolve_case(ctx: Ctx) -> dict:
    ctx.require_scope("cases.write")
    ctx.require("caseId", "disposition")
    case = ctx.state.table("cases").get(ctx.payload["caseId"])
    if case is None:
        raise DomainError(404, "case_not_found", ctx.payload["caseId"])
    disposition = ctx.payload["disposition"]
    if disposition not in _DISPOSITIONS:
        raise DomainError(
            422,
            "invalid_disposition",
            f"disposition must be one of {', '.join(_DISPOSITIONS)}",
        )
    if case["status"] in ("resolved", "closed"):
        raise DomainError(409, "already_resolved", "case already resolved")
    if disposition == "escalate":
        _escalate(
            ctx.state,
            case,
            ctx.get("queue", "edd_l2"),
            ctx.get("reason", "Escalated on disposition."),
            _actor(ctx),
        )
        return case
    _resolve(
        ctx.state,
        case,
        disposition,
        ctx.get("reason", "Disposition recorded by analyst."),
        _actor(ctx),
    )
    return case


@base.op(ID, "create_monitor")
def create_monitor(ctx: Ctx) -> dict:
    ctx.require_scope("monitoring.write")
    ctx.require("entityId")
    entity = ctx.state.table("entities").get(ctx.payload["entityId"])
    if entity is None:
        raise DomainError(404, "entity_not_found", ctx.payload["entityId"])
    frequency = ctx.get("frequency", "daily")
    if frequency not in ("realtime", "daily", "weekly"):
        raise DomainError(
            422, "invalid_frequency", "frequency must be realtime, daily, or weekly"
        )
    return _create_monitor(ctx.state, entity, frequency, _actor(ctx))


@base.op(ID, "get_monitor")
def get_monitor(ctx: Ctx) -> dict:
    ctx.require_scope("screening.read")
    ctx.require("monitorId")
    rec = ctx.state.table("monitors").get(ctx.payload["monitorId"])
    if rec is None:
        raise DomainError(404, "monitor_not_found", ctx.payload["monitorId"])
    return rec


@base.op(ID, "list_monitors")
def list_monitors(ctx: Ctx) -> dict:
    ctx.require_scope("screening.read")
    items = list(ctx.state.table("monitors").values())
    if ctx.get("status"):
        items = [m for m in items if m["status"] == ctx.get("status")]
    items.sort(key=lambda m: m["createdAt"], reverse=True)
    return ctx.paginate(items)


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #
def _actor(ctx: Ctx) -> str:
    return str(ctx.principal.get("principal") or "anonymous")


def _party_subject(party) -> dict:
    if isinstance(party, str):
        return {"name": party, "type": "organization", "country": None}
    if isinstance(party, dict) and party.get("name"):
        return {
            "name": str(party["name"]),
            "type": party.get("type", "organization"),
            "country": party.get("country"),
        }
    raise DomainError(
        422, "invalid_request", "each party must be a name or an object with 'name'"
    )


def _batch_parties(state: base.State, batch_id: str) -> list[dict]:
    """Synthesize a deterministic counterparty batch for a named screening run."""
    rng = gen._rng(ID, "batch", batch_id)
    pool = [e["legalName"] for e in state.table("entities").values()]
    sample = rng.sample(pool, min(len(pool), rng.randint(4, 8)))
    return [{"name": name, "type": "organization", "country": None} for name in sample]


def _resolve_entity(state: base.State, legal: str, country: str, payload: dict) -> dict:
    target = _norm(legal)
    for entity in state.table("entities").values():
        if _norm(entity["legalName"]) == target:
            return entity
    rng = gen._rng(ID, "resolve", target)
    entity = {
        "entityId": base.new_id("ent"),
        "legalName": legal,
        "type": "organization",
        "country": country,
        "registrationNumber": payload.get("registrationNumber")
        or gen._aegis_registration(rng, country),
        "incorporationDate": payload.get("incorporationDate"),
        "registeredAddress": payload.get("registeredAddress", {}),
        "industryCode": payload.get("industryCode"),
        "status": "active",
        "beneficialOwners": payload.get("beneficialOwners", []),
        "directors": payload.get("directors", []),
        "aliases": [],
        "watchlists": [],
        "programs": [],
        "verificationStatus": "unverified",
        "source": "registry",
    }
    state.table("entities")[entity["entityId"]] = entity
    return entity


def _audit_intact(case_id: str, events: list[dict]) -> bool:
    prev = "genesis"
    for event in events:
        digest = hashlib.sha256(
            f"{case_id}|{event['type']}|{event['actor']}|{event['at']}|{prev}".encode()
        ).hexdigest()[:16]
        if event.get("prevHash") != prev or event.get("hash") != digest:
            return False
        prev = event["hash"]
    return True
