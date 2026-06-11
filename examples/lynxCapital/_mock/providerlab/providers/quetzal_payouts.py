"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Quetzal Payouts domain: global recipient onboarding with KYC, FX-aware payout quotes, single and batch disbursement, settlement funding, and balances.
"""
from __future__ import annotations

from _mock.providerlab.data import generators as gen
from _mock.providerlab.providers import base
from _mock.providerlab.providers.base import Ctx, DomainError

ID = "quetzal-payouts"

# Mid-market units of each currency per one USD. Cross rates are derived from
# this table the way a payout platform prices a corridor off a single base.
_MID = {
    "USD": 1.0, "EUR": 0.92, "GBP": 0.79, "JPY": 156.4, "BRL": 5.08,
    "SGD": 1.35, "CAD": 1.36, "AUD": 1.52, "MXN": 17.1, "INR": 83.2,
}
_ZERO_DECIMAL = {"JPY"}

# Platform markup applied to the mid rate, in basis points per corridor leg.
_MARKUP_BPS = 35

# Per-payout limits in the source currency (USD-equivalent floor/ceiling).
_MIN_PAYOUT_USD = 1.0
_MAX_PAYOUT_USD = 2_000_000.0

_METHODS = ("bank_transfer", "wallet", "card", "cash_pickup")
_METHOD_ALIASES = {"bank": "bank_transfer", "bank_account": "bank_transfer",
                   "ach": "bank_transfer", "wire": "bank_transfer", "swift": "bank_transfer"}

# Delivery service-level by method, in hours, as corridor SLAs are published.
_DELIVERY_HOURS = {"bank_transfer": 48, "wallet": 0, "card": 24, "cash_pickup": 1}

# ISO-20022-style purpose codes mapped from the business reason.
_PURPOSE_CODES = {
    "supplier": "SUPP", "vendor": "SUPP", "invoice": "SUPP", "goods": "GDDS",
    "services": "SCVE", "salary": "SALA", "payroll": "SALA", "refund": "RFND",
}

_PAYOUT_FLOW = ("processing", "in_transit", "paid")


def _norm_method(value: str) -> str:
    method = str(value or "bank_transfer").lower()
    method = _METHOD_ALIASES.get(method, method)
    if method not in _METHODS:
        raise DomainError(422, "invalid_method", f"unsupported payout method {value!r}")
    return method


def _supported(currency: str) -> str:
    code = str(currency or "").upper()
    if code not in _MID:
        raise DomainError(422, "unsupported_currency", f"currency {currency!r} is not supported")
    return code


def _minor_units(currency: str) -> int:
    return 0 if currency in _ZERO_DECIMAL else 2


def _money(amount: float, currency: str) -> float:
    return round(float(amount), _minor_units(currency))


def _rate(source: str, target: str) -> float:
    """Client rate for a corridor: the mid cross rate less the platform markup."""
    mid = _MID[target] / _MID[source]
    return round(mid * (1.0 - _MARKUP_BPS / 10_000.0), 6)


def _purpose_code(purpose: str) -> str:
    key = str(purpose or "").lower()
    for token, code in _PURPOSE_CODES.items():
        if token in key:
            return code
    return "OTHR"


def _fee(amount: float, currency: str, method: str) -> dict:
    """Blended payout fee: a percentage component plus a fixed corridor charge,
    with a correspondent-bank surcharge on bank rails into non-USD currencies."""
    pct = 0.005 if method == "wallet" else 0.009
    processing = _money(amount * pct, currency)
    fixed = {"USD": 0.50, "EUR": 0.45, "GBP": 0.40, "JPY": 60.0}.get(currency, 0.50)
    breakdown = [
        {"type": "processing", "amount": processing, "currency": currency},
        {"type": "fixed", "amount": _money(fixed, currency), "currency": currency},
    ]
    if method == "bank_transfer" and currency != "USD":
        breakdown.append({"type": "correspondent", "amount": _money(3.0, currency),
                          "currency": currency})
    total = _money(sum(line["amount"] for line in breakdown), currency)
    return {"total": total, "breakdown": breakdown}


def _delivery(method: str, created: int) -> dict:
    hours = _DELIVERY_HOURS[method]
    return {"deliveryEstimateHours": hours, "estimatedDelivery": created + hours * 3600}


# --------------------------------------------------------------------------- #
# seed data
# --------------------------------------------------------------------------- #
def _recipient(seed: str, i: int) -> dict:
    rng = gen._rng(seed, "quetzal-recipient", i)
    country, currency = rng.choice(gen._COUNTRIES)
    is_business = rng.random() > 0.45
    name = gen._company(rng) if is_business else gen._person(rng)
    method = rng.choice(_METHODS)
    routing = gen._fx_routing(rng, country)
    created = base.now() - rng.randint(5, 540) * 86_400
    status = rng.choices(("verified", "pending", "unverified", "rejected"),
                         weights=(74, 12, 9, 5))[0]
    slug = gen._slug(name).split("-")[0] or "recipient"
    record = {
        "id": f"rcp_{rng.getrandbits(48):012x}",
        "object": "recipient",
        "type": "business" if is_business else "individual",
        "name": name,
        "email": f"payments@{slug}.example" if is_business else f"{slug}@example.com",
        "country": country,
        "currency": currency,
        "payoutMethod": method,
        "status": status,
        "verified": status == "verified",
        "address": {
            "line1": f"{rng.randint(10, 9999)} {gen._company(rng).split()[0]} Street",
            "city": gen._CITY_BY_COUNTRY.get(country, "Metropolis"),
            "postalCode": f"{rng.randint(10000, 99999)}",
            "country": country,
        },
        "createdAt": created,
        "updatedAt": created,
    }
    if method == "bank_transfer":
        record["bankAccount"] = {
            "accountHolderName": name,
            "bankName": f"{country} National Bank",
            "country": country,
            "currency": currency,
            "accountNumber": routing["account_number"],
            "iban": routing["iban"],
            "bic": routing["bic_swift"],
            "routingCodeType": routing["routing_code_type_1"],
            "routingCodeValue": routing["routing_code_value_1"],
        }
    elif method == "wallet":
        record["wallet"] = {"provider": rng.choice(("quetzal_wallet", "alipay", "paytm")),
                            "handle": f"{slug}@wallet"}
    elif method == "card":
        record["card"] = {"network": rng.choice(("Visa", "Mastercard")),
                          "last4": f"{rng.randint(0, 9999):04d}"}
    else:
        record["cashPickup"] = {"network": rng.choice(("RIA", "MoneyGram")),
                                "location": gen._CITY_BY_COUNTRY.get(country, "Metropolis")}
    return record


def _seed_payout(seed: str, i: int, recipients: list[dict]) -> dict:
    rng = gen._rng(seed, "quetzal-payout", i)
    rec = recipients[rng.randrange(len(recipients))]
    source = "USD"
    target = rec["currency"]
    src_amount = _money(rng.uniform(250, 48_000), source)
    rate = _rate(source, target)
    method = rec["payoutMethod"]
    fee = _fee(src_amount, source, method)
    created = base.now() - rng.randint(0, 120) * 86_400
    status = rng.choices(("paid", "in_transit", "processing", "failed", "returned"),
                         weights=(64, 12, 10, 8, 6))[0]
    purpose = rng.choice(("supplier invoice", "services", "goods", "payroll"))
    delivery = _delivery(method, created)
    payout = {
        "id": f"po_{rng.getrandbits(48):012x}",
        "object": "payout",
        "recipientId": rec["id"],
        "recipientName": rec["name"],
        "sourceCurrency": source,
        "sourceAmount": src_amount,
        "targetCurrency": target,
        "targetAmount": _money(src_amount * rate, target),
        "rate": rate,
        "fee": fee["total"],
        "feeCurrency": source,
        "method": method,
        "reference": f"INV-{rng.randint(10000, 99999)}",
        "purpose": purpose,
        "purposeCode": _purpose_code(purpose),
        "status": status,
        "failureReason": None,
        "estimatedDelivery": delivery["estimatedDelivery"],
        "createdAt": created,
        "updatedAt": created,
        "statusHistory": [{"status": status, "at": created}],
        "batchId": None,
    }
    if status == "failed":
        payout["failureReason"] = rng.choice(
            ("recipient_account_closed", "invalid_bank_details", "compliance_hold"))
    elif status == "returned":
        payout["failureReason"] = "bank_returned_funds"
    return payout


def _seed_settlement(seed: str, i: int) -> dict:
    rng = gen._rng(seed, "quetzal-settlement", i)
    currency = rng.choice(("USD", "USD", "EUR", "GBP"))
    funded = base.now() - i * 7 * 86_400 - rng.randint(0, 6) * 86_400
    amount = _money(rng.uniform(80_000, 900_000), currency)
    return {
        "id": f"set_{rng.getrandbits(48):012x}",
        "object": "settlement",
        "currency": currency,
        "amount": amount,
        "payoutCount": rng.randint(20, 400),
        "fundingSource": f"{currency} operating account",
        "status": "funded" if i > 0 else "pending",
        "periodStart": funded - 7 * 86_400,
        "periodEnd": funded,
        "settledAt": funded if i > 0 else None,
    }


@base.seeder(ID)
def seed(state: base.State) -> None:
    recipients = [_recipient(ID, i) for i in range(1, 121)]
    state.tables["recipients"] = gen.index_by(recipients)
    payouts = [_seed_payout(ID, i, recipients) for i in range(1, 61)]
    state.tables["payouts"] = gen.index_by(payouts, key="id")
    state.tables["batches"] = {}
    state.tables["quotes"] = {}
    settlements = [_seed_settlement(ID, i) for i in range(0, 12)]
    state.tables["settlements"] = gen.index_by(settlements, key="id")
    state.tables["balances"] = {
        cur: {"currency": cur, "available": amt, "reserved": 0.0, "object": "balance"}
        for cur, amt in (("USD", 5_000_000.0), ("EUR", 1_400_000.0),
                         ("GBP", 820_000.0), ("SGD", 600_000.0))
    }
    state.tables["idempotency"] = {}


# --------------------------------------------------------------------------- #
# recipients
# --------------------------------------------------------------------------- #
@base.op(ID, "create_recipient")
def create_recipient(ctx: Ctx) -> dict:
    """Onboard a payout recipient; new recipients start unverified pending KYC."""
    ctx.require("name", "currency")
    currency = _supported(ctx.payload["currency"])
    method = _norm_method(ctx.get("payoutMethod") or ctx.get("method") or "bank_transfer")

    idem = ctx.get("idempotencyKey")
    keys = ctx.state.table("idempotency")
    recipients = ctx.state.table("recipients")
    if idem and idem in keys:
        return recipients[keys[idem]]

    now = base.now()
    country = ctx.get("country", "US")
    rid = base.new_id("rcp")
    rec = {
        "id": rid,
        "object": "recipient",
        "type": ctx.get("type", "business"),
        "name": ctx.payload["name"],
        "email": ctx.get("email"),
        "country": country,
        "currency": currency,
        "payoutMethod": method,
        "status": "unverified",
        "verified": False,
        "address": ctx.get("address"),
        "createdAt": now,
        "updatedAt": now,
    }
    if method == "bank_transfer" and ctx.get("bankAccount"):
        rec["bankAccount"] = ctx.get("bankAccount")
    recipients[rid] = rec
    if idem:
        keys[idem] = rid
    return rec


@base.op(ID, "get_recipient")
def get_recipient(ctx: Ctx) -> dict:
    ctx.require("recipientId")
    rec = ctx.state.table("recipients").get(ctx.payload["recipientId"])
    if rec is None:
        raise DomainError(404, "recipient_not_found", ctx.payload["recipientId"])
    return rec


@base.op(ID, "list_recipients")
def list_recipients(ctx: Ctx) -> dict:
    items = list(ctx.state.table("recipients").values())
    status = ctx.get("status")
    if status:
        items = [r for r in items if r["status"] == status]
    country = ctx.get("country")
    if country:
        items = [r for r in items if r["country"] == country]
    items.sort(key=lambda r: r["createdAt"], reverse=True)
    return ctx.paginate(items)


@base.op(ID, "verify_recipient")
def verify_recipient(ctx: Ctx) -> dict:
    """Run KYC on a recipient and move it to verified so payouts can be released."""
    ctx.require("recipientId")
    rec = ctx.state.table("recipients").get(ctx.payload["recipientId"])
    if rec is None:
        raise DomainError(404, "recipient_not_found", ctx.payload["recipientId"])
    if rec["status"] == "rejected":
        raise DomainError(422, "recipient_rejected", "recipient failed verification and cannot be reinstated")
    rec["status"] = "verified"
    rec["verified"] = True
    rec["updatedAt"] = base.now()
    return rec


# --------------------------------------------------------------------------- #
# quotes
# --------------------------------------------------------------------------- #
@base.op(ID, "get_quote")
def get_quote(ctx: Ctx) -> dict:
    """Price an FX corridor with rate, fee, delivery estimate, and a rate lock."""
    ctx.require("sourceCurrency", "targetCurrency")
    source = _supported(ctx.payload["sourceCurrency"])
    target = _supported(ctx.payload["targetCurrency"])
    method = _norm_method(ctx.get("payoutMethod") or "bank_transfer")
    rate = _rate(source, target)

    if ctx.get("targetAmount") not in (None, ""):
        target_amount = _money(ctx.payload["targetAmount"], target)
        source_amount = _money(target_amount / rate, source)
    else:
        ctx.require("amount")
        source_amount = _money(ctx.payload["amount"], source)
        target_amount = _money(source_amount * rate, target)

    if source_amount <= 0:
        raise DomainError(422, "invalid_amount", "amount must be positive")

    fee = _fee(source_amount, source, method)
    now = base.now()
    delivery = _delivery(method, now)
    quote = {
        "id": base.new_id("qt"),
        "quoteId": base.new_id("qt"),
        "object": "quote",
        "sourceCurrency": source,
        "targetCurrency": target,
        "sourceAmount": source_amount,
        "targetAmount": target_amount,
        "rate": rate,
        "midRate": round(_MID[target] / _MID[source], 6),
        "markupBps": _MARKUP_BPS,
        "fee": fee["total"],
        "feeBreakdown": fee["breakdown"],
        "totalCost": _money(source_amount + fee["total"], source),
        "payoutMethod": method,
        "deliveryEstimateHours": delivery["deliveryEstimateHours"],
        "estimatedDelivery": delivery["estimatedDelivery"],
        "rateExpiresAt": now + 1800,
        "createdAt": now,
    }
    ctx.state.table("quotes")[quote["quoteId"]] = quote
    return quote


# --------------------------------------------------------------------------- #
# payouts
# --------------------------------------------------------------------------- #
def _advance(payout: dict) -> dict:
    """Move a live payout one step along its delivery lifecycle on each read."""
    status = payout["status"]
    if status in _PAYOUT_FLOW and status != _PAYOUT_FLOW[-1]:
        payout["status"] = _PAYOUT_FLOW[_PAYOUT_FLOW.index(status) + 1]
        now = base.now()
        payout["updatedAt"] = now
        payout["statusHistory"].append({"status": payout["status"], "at": now})
    return payout


@base.op(ID, "create_payout")
def create_payout(ctx: Ctx) -> dict:
    """Release a payout to a verified recipient, pricing the corridor and debiting balance."""
    ctx.require("recipientId", "amount")
    rec = ctx.state.table("recipients").get(ctx.payload["recipientId"])
    if rec is None:
        raise DomainError(404, "recipient_not_found", ctx.payload["recipientId"])
    if not rec["verified"]:
        raise DomainError(403, "recipient_unverified", "recipient must be verified before payout")

    idem = ctx.get("idempotencyKey")
    keys = ctx.state.table("idempotency")
    payouts = ctx.state.table("payouts")
    if idem and idem in keys:
        return payouts[keys[idem]]

    source = _supported(ctx.get("currency") or ctx.get("sourceCurrency") or "USD")
    try:
        source_amount = _money(ctx.payload["amount"], source)
    except (TypeError, ValueError):
        raise DomainError(422, "invalid_amount", "amount must be a number")
    usd_value = source_amount / _MID[source]
    if usd_value < _MIN_PAYOUT_USD:
        raise DomainError(422, "amount_too_small", "payout is below the minimum size")
    if usd_value > _MAX_PAYOUT_USD:
        raise DomainError(422, "amount_exceeds_limit", "payout exceeds the per-transaction limit")

    balances = ctx.state.table("balances")
    balance = balances.get(source)
    if balance is not None and source_amount > balance["available"]:
        raise DomainError(402, "insufficient_funds",
                          f"insufficient {source} balance to fund this payout")

    target = rec["currency"]
    method = rec["payoutMethod"]
    rate = _rate(source, target)
    fee = _fee(source_amount, source, method)
    purpose = ctx.get("purpose", "supplier invoice")
    now = base.now()
    delivery = _delivery(method, now)
    payout_id = base.new_id("po")
    payout = {
        "id": payout_id,
        "payoutId": payout_id,
        "object": "payout",
        "recipientId": rec["id"],
        "recipientName": rec["name"],
        "sourceCurrency": source,
        "sourceAmount": source_amount,
        "targetCurrency": target,
        "targetAmount": _money(source_amount * rate, target),
        "rate": rate,
        "fee": fee["total"],
        "feeCurrency": source,
        "feeBreakdown": fee["breakdown"],
        "method": method,
        "reference": ctx.get("reference", payout_id),
        "purpose": purpose,
        "purposeCode": _purpose_code(purpose),
        "quoteId": ctx.get("quoteId"),
        "status": "processing",
        "failureReason": None,
        "deliveryEstimateHours": delivery["deliveryEstimateHours"],
        "estimatedDelivery": delivery["estimatedDelivery"],
        "createdAt": now,
        "updatedAt": now,
        "statusHistory": [{"status": "processing", "at": now}],
        "batchId": None,
    }
    if balance is not None:
        balance["available"] = _money(balance["available"] - source_amount, source)
        balance["reserved"] = _money(balance["reserved"] + source_amount, source)
    payouts[payout_id] = payout
    if idem:
        keys[idem] = payout_id
    return payout


@base.op(ID, "get_payout")
def get_payout(ctx: Ctx) -> dict:
    """Fetch a payout and advance its tracked delivery status."""
    ctx.require("payoutId")
    payout = ctx.state.table("payouts").get(ctx.payload["payoutId"])
    if payout is None:
        raise DomainError(404, "payout_not_found", ctx.payload["payoutId"])
    return _advance(payout)


@base.op(ID, "list_payouts")
def list_payouts(ctx: Ctx) -> dict:
    items = list(ctx.state.table("payouts").values())
    status = ctx.get("status")
    if status:
        items = [p for p in items if p["status"] == status]
    recipient_id = ctx.get("recipientId")
    if recipient_id:
        items = [p for p in items if p["recipientId"] == recipient_id]
    items.sort(key=lambda p: p["createdAt"], reverse=True)
    return ctx.paginate(items)


@base.op(ID, "cancel_payout")
def cancel_payout(ctx: Ctx) -> dict:
    """Cancel a payout before it leaves the platform and release the reserved funds."""
    ctx.require("payoutId")
    payout = ctx.state.table("payouts").get(ctx.payload["payoutId"])
    if payout is None:
        raise DomainError(404, "payout_not_found", ctx.payload["payoutId"])
    if payout["status"] != "processing":
        raise DomainError(409, "payout_not_cancelable",
                          f"payout in status {payout['status']!r} can no longer be canceled")
    now = base.now()
    payout["status"] = "canceled"
    payout["updatedAt"] = now
    payout["statusHistory"].append({"status": "canceled", "at": now})
    balance = ctx.state.table("balances").get(payout["sourceCurrency"])
    if balance is not None:
        amount = payout["sourceAmount"]
        balance["reserved"] = _money(balance["reserved"] - amount, payout["sourceCurrency"])
        balance["available"] = _money(balance["available"] + amount, payout["sourceCurrency"])
    return payout


# --------------------------------------------------------------------------- #
# batches
# --------------------------------------------------------------------------- #
@base.op(ID, "create_batch")
def create_batch(ctx: Ctx) -> dict:
    """Submit a mass-payout batch; accepted items become child payouts, funded asynchronously."""
    items = ctx.get("items") or []
    if not items:
        raise DomainError(422, "empty_batch", "batch requires at least one item")

    idem = ctx.get("idempotencyKey")
    keys = ctx.state.table("idempotency")
    batches = ctx.state.table("batches")
    if idem and idem in keys:
        return batches[keys[idem]]

    recipients = ctx.state.table("recipients")
    payouts = ctx.state.table("payouts")
    now = base.now()
    batch_id = base.new_id("bat")
    source = _supported(ctx.get("sourceCurrency", "USD"))
    line_items: list[dict] = []
    accepted = rejected = 0
    total = 0.0

    for item in items:
        amount = item.get("amount")
        rec = recipients.get(item.get("recipientId"))
        line = {"recipientId": item.get("recipientId"), "amount": amount,
                "currency": item.get("currency", source)}
        if rec is None:
            line.update(status="rejected", reason="recipient_not_found")
            rejected += 1
        elif not rec["verified"]:
            line.update(status="rejected", reason="recipient_unverified")
            rejected += 1
        else:
            rate = _rate(source, rec["currency"])
            payout_id = base.new_id("po")
            payouts[payout_id] = {
                "id": payout_id, "payoutId": payout_id, "object": "payout",
                "recipientId": rec["id"], "recipientName": rec["name"],
                "sourceCurrency": source, "sourceAmount": _money(amount, source),
                "targetCurrency": rec["currency"],
                "targetAmount": _money(float(amount) * rate, rec["currency"]),
                "rate": rate, "method": rec["payoutMethod"],
                "reference": item.get("reference", payout_id),
                "status": "processing", "failureReason": None,
                "createdAt": now, "updatedAt": now,
                "statusHistory": [{"status": "processing", "at": now}],
                "batchId": batch_id,
            }
            line.update(status="accepted", payoutId=payout_id)
            accepted += 1
            total += float(amount or 0)
        line_items.append(line)

    batch = {
        "id": batch_id,
        "batchId": batch_id,
        "object": "batch",
        "status": "processing",
        "fundingStatus": "pending",
        "sourceCurrency": source,
        "totalItems": len(items),
        "acceptedCount": accepted,
        "rejectedCount": rejected,
        "totalAmount": _money(total, source),
        "items": line_items,
        "createdAt": now,
        "completedAt": None,
    }
    batches[batch_id] = batch
    if idem:
        keys[idem] = batch_id
    return batch


@base.op(ID, "get_batch")
def get_batch(ctx: Ctx) -> dict:
    """Fetch a batch; a processing batch settles to its completed disposition on read."""
    ctx.require("batchId")
    batch = ctx.state.table("batches").get(ctx.payload["batchId"])
    if batch is None:
        raise DomainError(404, "batch_not_found", ctx.payload["batchId"])
    if batch["status"] == "processing":
        if batch["acceptedCount"] == 0:
            batch["status"] = "failed"
        elif batch["rejectedCount"] > 0:
            batch["status"] = "partially_completed"
        else:
            batch["status"] = "completed"
        batch["fundingStatus"] = "funded" if batch["acceptedCount"] else "pending"
        batch["completedAt"] = base.now()
    return batch


@base.op(ID, "list_batches")
def list_batches(ctx: Ctx) -> dict:
    items = list(ctx.state.table("batches").values())
    status = ctx.get("status")
    if status:
        items = [b for b in items if b["status"] == status]
    items.sort(key=lambda b: b["createdAt"], reverse=True)
    return ctx.paginate(items)


# --------------------------------------------------------------------------- #
# settlements + balances
# --------------------------------------------------------------------------- #
@base.op(ID, "list_settlements")
def list_settlements(ctx: Ctx) -> dict:
    items = list(ctx.state.table("settlements").values())
    status = ctx.get("status")
    if status:
        items = [s for s in items if s["status"] == status]
    items.sort(key=lambda s: s["periodEnd"], reverse=True)
    return ctx.paginate(items, size_default=10)


@base.op(ID, "get_balance")
def get_balance(ctx: Ctx) -> dict:
    """Report available and reserved funding balances per settlement currency."""
    currency = ctx.get("currency")
    balances = ctx.state.table("balances")
    if currency:
        code = _supported(currency)
        row = balances.get(code)
        if row is None:
            return {"object": "balance", "currency": code, "available": 0.0, "reserved": 0.0}
        return row
    return {"object": "balance_list",
            "balances": [balances[c] for c in sorted(balances)]}
