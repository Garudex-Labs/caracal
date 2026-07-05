"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Meridian Pay domain: card and wallet charge acceptance with refunds, disputes, settlements, payouts, balances, and the event stream.
"""

from __future__ import annotations

import hashlib
import json

from _mock.providerlab.data import generators as gen
from _mock.providerlab.providers import base
from _mock.providerlab.providers.base import Ctx, DomainError

ID = "meridian-pay"

_REQUIRES_ACTION_THRESHOLD = 75000.0

# An uncaptured authorization expires after this window, after which the held
# funds are released back to the cardholder, exactly as card networks require.
_CAPTURE_WINDOW = 7 * 86_400

# Fields that define a charge request. Two calls that carry the same idempotency
# key but differ on any of these are a client bug, and the platform rejects the
# replay rather than silently returning the first result.
_IDEMPOTENT_FIELDS = (
    "amount",
    "currency",
    "source",
    "capture",
    "customer",
    "description",
    "metadata",
)

# Canonical decline tokens, shaped after the test-card scheme real card platforms
# publish. Each maps to the gateway decline code and HTTP status a live charge
# attempt would return.
_DECLINE_TOKENS: dict[str, tuple[str, str]] = {
    "tok_chargedeclined": ("card_declined", "Your card was declined."),
    "tok_declined": ("card_declined", "Your card was declined."),
    "tok_chargedeclinedinsufficientfunds": (
        "insufficient_funds",
        "Your card has insufficient funds.",
    ),
    "tok_insufficientfunds": (
        "insufficient_funds",
        "Your card has insufficient funds.",
    ),
    "tok_chargedeclinedexpiredcard": ("expired_card", "Your card has expired."),
    "tok_expiredcard": ("expired_card", "Your card has expired."),
    "tok_chargedeclinedincorrectcvc": (
        "incorrect_cvc",
        "Your card's security code is incorrect.",
    ),
    "tok_chargedeclinedprocessingerror": (
        "processing_error",
        "An error occurred while processing your card.",
    ),
    "tok_chargedeclinedfraudulent": (
        "card_declined",
        "The payment was declined for suspected fraud.",
    ),
    "tok_radarblock": ("card_declined", "The payment was blocked by the risk engine."),
    "tok_chargecustomerfail": (
        "processing_error",
        "An error occurred while processing your card.",
    ),
}
_3DS_TOKENS = {"tok_threedsecurerequired", "tok_authenticationrequired"}

_CARD_BY_TOKEN = {
    "tok_visa": ("visa", "4242", "Visa"),
    "tok_visadebit": ("visa", "4000", "Visa"),
    "tok_mastercard": ("mastercard", "5555", "Mastercard"),
    "tok_amex": ("amex", "0005", "American Express"),
    "tok_discover": ("discover", "1117", "Discover"),
}


@base.seeder(ID)
def seed(state: base.State) -> None:
    for name, table in gen.meridian_dataset(ID).items():
        state.tables[name] = table
    state.tables.setdefault("idempotency", {})


def _norm(token: str) -> str:
    return str(token or "").strip().lower()


def _auth_code(seed: str) -> str:
    """The six-digit authorization code the issuer returns on an approval."""
    return f"{int(hashlib.sha1(seed.encode()).hexdigest(), 16) % 1_000_000:06d}"


def _fingerprint(payload: dict) -> str:
    """Stable hash of the request fields an idempotency key is bound to."""
    relevant = {k: payload.get(k) for k in _IDEMPOTENT_FIELDS}
    return hashlib.sha256(
        json.dumps(relevant, sort_keys=True, default=str).encode()
    ).hexdigest()


def _card_for(source: str) -> dict:
    brand, last4, network = _CARD_BY_TOKEN.get(_norm(source), ("visa", "4242", "Visa"))
    return {
        "type": "card",
        "card": {
            "brand": brand,
            "last4": last4,
            "expMonth": 11,
            "expYear": 2029,
            "funding": "credit",
            "network": network,
            "country": "US",
            "fingerprint": f"fp_{hashlib.sha1(f'{brand}{last4}'.encode()).hexdigest()[:16]}",
            "threeDSecure": "not_required",
            "wallet": None,
            "checks": {
                "cvcCheck": "pass",
                "addressLine1Check": "pass",
                "addressPostalCodeCheck": "pass",
            },
        },
    }


def _settled_view(ctx: Ctx) -> tuple[dict[str, float], dict[str, float]]:
    """Aggregate available (paid out) and pending net balances per currency."""
    available: dict[str, float] = {}
    pending: dict[str, float] = {}
    settlements = ctx.state.table("settlements")
    for charge in ctx.state.table("charges").values():
        if charge["status"] not in ("succeeded", "refunded"):
            continue
        currency = charge["currency"]
        net = round(charge.get("net", 0.0) - charge.get("amountRefunded", 0.0), 2)
        settlement = settlements.get(charge.get("settlementId"))
        bucket = available if settlement and settlement["status"] == "paid" else pending
        bucket[currency] = round(bucket.get(currency, 0.0) + net, 2)
    return available, pending


@base.op(ID, "create_charge")
def create_charge(ctx: Ctx) -> dict:
    ctx.require("amount", "currency", "source")
    try:
        amount = round(float(ctx.payload["amount"]), 2)
    except (TypeError, ValueError):
        raise DomainError(422, "invalid_amount", "amount must be a number")
    if amount <= 0:
        raise DomainError(422, "invalid_amount", "amount must be positive")

    idem = ctx.get("idempotencyKey")
    keys = ctx.state.table("idempotency")
    charges = ctx.state.table("charges")
    fingerprint = _fingerprint(ctx.payload)
    if idem and idem in keys:
        record = keys[idem]
        if record["fingerprint"] != fingerprint:
            raise DomainError(
                400,
                "idempotency_error",
                "Keys for idempotent requests can only be used with the same parameters "
                "they were first used with.",
            )
        return charges[record["chargeId"]]

    source = ctx.payload["source"]
    decline = _DECLINE_TOKENS.get(_norm(source))
    if decline:
        raise DomainError(402, decline[0], decline[1])

    currency = str(ctx.payload["currency"]).upper()
    capture = ctx.get("capture", True)
    needs_action = _norm(source) in _3DS_TOKENS or amount > _REQUIRES_ACTION_THRESHOLD
    fee = gen._processing_fee(amount, currency)
    pm = _card_for(source)
    charge_id = base.new_id("ch")
    created = base.now()

    if needs_action:
        status, captured, paid, captured_amount, net = (
            "requires_action",
            False,
            False,
            0.0,
            0.0,
        )
    elif not capture:
        status, captured, paid, captured_amount, net = (
            "requires_capture",
            False,
            False,
            0.0,
            0.0,
        )
    else:
        status, captured, paid, captured_amount, net = (
            "succeeded",
            True,
            True,
            amount,
            round(amount - fee, 2),
        )

    descriptor = ctx.get("statementDescriptor", "MERIDIAN* LYNXCAPITAL")
    suffix = ctx.get("statementDescriptorSuffix")
    charge = {
        "id": charge_id,
        "chargeId": charge_id,
        "object": "charge",
        "amount": amount,
        "amountCaptured": captured_amount,
        "amountRefunded": 0.0,
        "currency": currency,
        "status": status,
        "captured": captured,
        "paid": paid,
        "refunded": False,
        "disputed": False,
        "description": ctx.get("description", ""),
        "statementDescriptor": descriptor,
        "statementDescriptorSuffix": suffix,
        "calculatedStatementDescriptor": f"{descriptor} {suffix}".strip()
        if suffix
        else descriptor,
        "source": source,
        "paymentIntent": base.new_id("pi"),
        "paymentMethod": base.new_id("pm"),
        "paymentMethodDetails": pm,
        "authorizationCode": None if needs_action else _auth_code(charge_id),
        "billingDetails": ctx.get(
            "billingDetails",
            {"name": None, "email": None, "phone": None, "address": {}},
        ),
        "outcome": {
            "networkStatus": "approved_by_network",
            "reason": None,
            "riskLevel": "highest" if amount > _REQUIRES_ACTION_THRESHOLD else "normal",
            "riskScore": 78 if amount > _REQUIRES_ACTION_THRESHOLD else 24,
            "sellerMessage": "Payment requires authentication."
            if needs_action
            else "Payment complete.",
            "type": "manual" if status == "requires_capture" else "authorized",
            "networkDeclineCode": None,
        },
        "processingFee": 0.0 if status != "succeeded" else fee,
        "net": net,
        "balanceTransaction": base.new_id("txn") if status == "succeeded" else None,
        "failureCode": None,
        "failureMessage": None,
        "failureBalanceTransaction": None,
        "fraudDetails": {},
        "receiptEmail": ctx.get("receiptEmail"),
        "receiptNumber": None,
        "receiptUrl": f"https://pay.meridianpay.test/receipts/{charge_id}",
        "customer": ctx.get("customer"),
        "metadata": ctx.get("metadata", {}),
        "captureBefore": created + _CAPTURE_WINDOW
        if status == "requires_capture"
        else None,
        "settlementId": None,
        "payoutId": None,
        "created": created,
        "livemode": False,
    }
    if needs_action:
        charge["nextAction"] = {
            "type": "redirect_to_url",
            "redirectToUrl": {
                "url": f"https://pay.meridianpay.test/3ds/{charge_id}",
                "returnUrl": None,
            },
        }
    charges[charge_id] = charge
    if idem:
        keys[idem] = {"chargeId": charge_id, "fingerprint": fingerprint}
    return charge


@base.op(ID, "get_charge")
def get_charge(ctx: Ctx) -> dict:
    ctx.require("chargeId")
    charge = ctx.state.table("charges").get(ctx.payload["chargeId"])
    if charge is None:
        raise DomainError(
            404, "resource_missing", f"No such charge: {ctx.payload['chargeId']}"
        )
    return charge


@base.op(ID, "capture_charge")
def capture_charge(ctx: Ctx) -> dict:
    ctx.require("chargeId")
    charge = ctx.state.table("charges").get(ctx.payload["chargeId"])
    if charge is None:
        raise DomainError(
            404, "resource_missing", f"No such charge: {ctx.payload['chargeId']}"
        )
    if charge["status"] != "requires_capture":
        raise DomainError(
            409, "charge_already_captured", "charge is not awaiting capture"
        )
    amount = round(float(ctx.get("amountToCapture", charge["amount"])), 2)
    if amount <= 0 or amount > charge["amount"] + 1e-6:
        raise DomainError(
            422, "invalid_amount", "capture amount exceeds the authorized amount"
        )
    fee = gen._processing_fee(amount, charge["currency"])
    released = round(charge["amount"] - amount, 2)
    charge.update(
        status="succeeded",
        captured=True,
        paid=True,
        amountCaptured=amount,
        amountRefunded=released,
        processingFee=fee,
        net=round(amount - fee, 2),
        balanceTransaction=base.new_id("txn"),
        captureBefore=None,
    )
    charge["outcome"]["type"] = "authorized"
    return charge


@base.op(ID, "list_charges")
def list_charges(ctx: Ctx) -> dict:
    items = list(ctx.state.table("charges").values())
    status = ctx.get("status")
    if status:
        items = [c for c in items if c["status"] == status]
    customer = ctx.get("customer")
    if customer:
        items = [c for c in items if c.get("customer") == customer]
    items.sort(key=lambda c: c["created"], reverse=True)
    return ctx.paginate(items)


@base.op(ID, "refund_charge")
def refund_charge(ctx: Ctx) -> dict:
    ctx.require("chargeId")
    charge = ctx.state.table("charges").get(ctx.payload["chargeId"])
    if charge is None:
        raise DomainError(
            404, "resource_missing", f"No such charge: {ctx.payload['chargeId']}"
        )
    if charge["status"] not in ("succeeded", "refunded"):
        raise DomainError(
            400, "charge_not_refundable", "only captured charges can be refunded"
        )
    remaining = round(charge["amount"] - charge["amountRefunded"], 2)
    amount = round(float(ctx.get("amount", remaining)), 2)
    if amount <= 0 or amount > remaining + 1e-6:
        raise DomainError(
            422, "refund_exceeds_charge", "refund amount exceeds the remaining balance"
        )

    charge["amountRefunded"] = round(charge["amountRefunded"] + amount, 2)
    if charge["amountRefunded"] >= charge["amount"] - 1e-6:
        charge["status"] = "refunded"
        charge["refunded"] = True
    refund_id = base.new_id("re")
    refund = {
        "id": refund_id,
        "refundId": refund_id,
        "object": "refund",
        "amount": amount,
        "currency": charge["currency"],
        "chargeId": charge["chargeId"],
        "paymentIntent": charge.get("paymentIntent"),
        "status": "succeeded",
        "reason": ctx.get("reason", "requested_by_customer"),
        "receiptNumber": None,
        "balanceTransaction": base.new_id("txn"),
        "destinationDetails": {
            "card": {"type": "refund", "referenceStatus": "pending"},
            "type": "card",
        },
        "failureReason": None,
        "created": base.now(),
        "metadata": ctx.get("metadata", {}),
    }
    ctx.state.table("refunds")[refund_id] = refund
    return refund


@base.op(ID, "create_payout")
def create_payout(ctx: Ctx) -> dict:
    ctx.require("amount", "currency", "destination")
    try:
        amount = round(float(ctx.payload["amount"]), 2)
    except (TypeError, ValueError):
        raise DomainError(422, "invalid_amount", "amount must be a number")
    if amount < 1.0:
        raise DomainError(422, "amount_too_small", "minimum payout is 1.00")
    currency = str(ctx.payload["currency"]).upper()
    method = ctx.get("method", "standard")
    if method not in ("standard", "instant"):
        raise DomainError(422, "invalid_method", "method must be standard or instant")
    now = base.now()
    payout_id = base.new_id("po")
    payout = {
        "id": payout_id,
        "payoutId": payout_id,
        "object": "payout",
        "amount": amount,
        "currency": currency,
        "status": "in_transit",
        "type": "bank_account",
        "method": method,
        "destination": ctx.payload["destination"],
        "statementDescriptor": ctx.get("statementDescriptor", "MERIDIAN PAYOUT"),
        "sourceType": "card",
        "automatic": False,
        "balanceTransaction": base.new_id("txn"),
        "reconciliationStatus": "not_applicable",
        "arrivalDate": now + (0 if method == "instant" else 2 * 86_400),
        "settlementId": None,
        "failureCode": None,
        "failureMessage": None,
        "failureBalanceTransaction": None,
        "created": now,
        "metadata": ctx.get("metadata", {}),
    }
    ctx.state.table("payouts")[payout_id] = payout
    return payout


@base.op(ID, "get_payout")
def get_payout(ctx: Ctx) -> dict:
    ctx.require("payoutId")
    payout = ctx.state.table("payouts").get(ctx.payload["payoutId"])
    if payout is None:
        raise DomainError(
            404, "resource_missing", f"No such payout: {ctx.payload['payoutId']}"
        )
    if payout["status"] == "in_transit":
        payout["status"] = "paid"
    return payout


@base.op(ID, "get_balance")
def get_balance(ctx: Ctx) -> dict:
    available, pending = _settled_view(ctx)
    base_funds = {"USD": 184230.55, "EUR": 41200.00, "GBP": 22600.00}

    def rows(buckets: dict[str, float], floor: dict[str, float]) -> list[dict]:
        currencies = set(buckets) | set(floor)
        out = []
        for currency in sorted(currencies):
            amount = round(buckets.get(currency, 0.0) + floor.get(currency, 0.0), 2)
            out.append(
                {
                    "currency": currency,
                    "amount": amount,
                    "sourceTypes": {"card": amount},
                }
            )
        return out

    return {
        "object": "balance",
        "available": rows(available, base_funds),
        "pending": rows(pending, {}),
        "instantAvailable": rows(available, {}),
        "connectReserved": [],
        "livemode": False,
    }


@base.op(ID, "list_disputes")
def list_disputes(ctx: Ctx) -> dict:
    items = list(ctx.state.table("disputes").values())
    status = ctx.get("status")
    if status:
        items = [d for d in items if d["status"] == status]
    items.sort(key=lambda d: d["created"], reverse=True)
    return ctx.paginate(items, size_default=10)


@base.op(ID, "get_dispute")
def get_dispute(ctx: Ctx) -> dict:
    ctx.require("disputeId")
    dispute = ctx.state.table("disputes").get(ctx.payload["disputeId"])
    if dispute is None:
        raise DomainError(
            404, "resource_missing", f"No such dispute: {ctx.payload['disputeId']}"
        )
    return dispute


@base.op(ID, "submit_dispute_evidence")
def submit_dispute_evidence(ctx: Ctx) -> dict:
    ctx.require("disputeId")
    dispute = ctx.state.table("disputes").get(ctx.payload["disputeId"])
    if dispute is None:
        raise DomainError(
            404, "resource_missing", f"No such dispute: {ctx.payload['disputeId']}"
        )
    if dispute["status"] not in ("warning_needs_response", "needs_response"):
        raise DomainError(
            409,
            "dispute_not_open",
            "evidence can only be submitted while a response is required",
        )
    evidence = ctx.get("evidence", {})
    if not isinstance(evidence, dict) or not evidence:
        raise DomainError(422, "invalid_request", "evidence object is required")
    dispute["evidence"] = evidence
    dispute["status"] = "under_review"
    dispute["isChargeRefundable"] = False
    dispute["evidenceDetails"].update(
        hasEvidence=True,
        submissionCount=dispute["evidenceDetails"]["submissionCount"] + 1,
    )
    return dispute


@base.op(ID, "list_settlements")
def list_settlements(ctx: Ctx) -> dict:
    items = list(ctx.state.table("settlements").values())
    status = ctx.get("status")
    if status:
        items = [s for s in items if s["status"] == status]
    items.sort(key=lambda s: s["periodEnd"], reverse=True)
    return ctx.paginate(items, size_default=10)


@base.op(ID, "get_settlement")
def get_settlement(ctx: Ctx) -> dict:
    ctx.require("settlementId")
    settlement = ctx.state.table("settlements").get(ctx.payload["settlementId"])
    if settlement is None:
        raise DomainError(
            404,
            "resource_missing",
            f"No such settlement: {ctx.payload['settlementId']}",
        )
    return settlement


@base.op(ID, "list_events")
def list_events(ctx: Ctx) -> dict:
    items = list(ctx.state.table("events").values())
    event_type = ctx.get("type")
    if event_type:
        items = [e for e in items if e["type"] == event_type]
    items.sort(key=lambda e: e["created"], reverse=True)
    return ctx.paginate(items)
