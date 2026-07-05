"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Halcyon Bank domain: open-banking accounts, balances, transactions, beneficiaries, standing orders, direct debits, scheduled payments, payment initiation, funds confirmation, and statements.
"""

from __future__ import annotations

import time

from _mock.providerlab.data import generators as gen
from _mock.providerlab.providers import base
from _mock.providerlab.providers.base import Ctx, DomainError

ID = "halcyon-bank"

_RAIL_SCHEMES = {
    "ACH": "US.ACH",
    "RTP": "US.RTP",
    "WIRE": "SWIFT.WIRE",
    "SEPA": "EU.SEPA.CT",
    "PAYNOW": "SG.PAYNOW",
    "PIX": "BR.PIX",
    "NEFT": "IN.NEFT",
    "RTGS": "IN.RTGS",
    "FASTERPAYMENTS": "UK.OBIE.FPS",
}
_DOMESTIC_RAILS = {
    "ACH",
    "RTP",
    "FASTERPAYMENTS",
    "SEPA",
    "PAYNOW",
    "PIX",
    "NEFT",
    "RTGS",
}
_TERMINAL = {"AcceptedCreditSettlementCompleted", "Rejected"}
_PAYMENT_CONTEXT_CODES = {
    "BillingGoodsAndServicesInAdvance",
    "BillingGoodsAndServicesInArrears",
    "EcommerceMerchantInitiatedPayment",
    "FaceToFacePointOfSale",
    "TransferToSelf",
    "TransferToThirdParty",
}
_DUAL_AUTH_THRESHOLD = 250_000.0


def _iso(epoch: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def _account_or_404(ctx: Ctx, account_id: str) -> dict:
    acct = ctx.state.table("accounts").get(account_id)
    if acct is None:
        raise DomainError(
            404,
            "account_not_found",
            account_id,
            {"obieErrorCode": "UK.OBIE.Resource.NotFound", "path": "accountId"},
        )
    return acct


@base.seeder(ID)
def seed(state: base.State) -> None:
    accts = gen.bank_accounts(ID, 6)
    accounts = gen.index_by(accts, key="accountId")
    state.tables["accounts"] = accounts
    txns = gen.bank_transactions(ID, accounts, 400)
    state.tables["transactions"] = gen.index_by(txns, key="transactionId")
    state.tables["statements"] = gen.index_by(
        gen.bank_statements(ID, accounts, txns), key="statementId"
    )
    state.tables["balances"] = {
        aid: gen.bank_balances(acct) for aid, acct in accounts.items()
    }
    state.tables["beneficiaries"] = gen.index_by(
        gen.bank_beneficiaries(ID, accounts), key="beneficiaryId"
    )
    state.tables["standing_orders"] = gen.index_by(
        gen.bank_standing_orders(ID, accounts), key="standingOrderId"
    )
    state.tables["direct_debits"] = gen.index_by(
        gen.bank_direct_debits(ID, accounts), key="directDebitId"
    )
    state.tables["scheduled_payments"] = gen.index_by(
        gen.bank_scheduled_payments(ID, accounts), key="scheduledPaymentId"
    )
    state.tables["payments"] = {}


@base.op(ID, "list_accounts")
def list_accounts(ctx: Ctx) -> dict:
    ctx.require_scope("accounts")
    items = list(ctx.state.table("accounts").values())
    status = ctx.get("status")
    if status:
        items = [a for a in items if a["status"].lower() == str(status).lower()]
    return ctx.paginate(items, size_default=10)


@base.op(ID, "get_account")
def get_account(ctx: Ctx) -> dict:
    ctx.require_scope("accounts")
    ctx.require("accountId")
    return _account_or_404(ctx, ctx.payload["accountId"])


@base.op(ID, "get_balances")
def get_balances(ctx: Ctx) -> dict:
    ctx.require_scope("balances")
    ctx.require("accountId")
    account_id = ctx.payload["accountId"]
    _account_or_404(ctx, account_id)
    balances = ctx.state.table("balances").get(account_id, [])
    return {"accountId": account_id, "balances": balances}


@base.op(ID, "list_transactions")
def list_transactions(ctx: Ctx) -> dict:
    ctx.require_scope("transactions")
    account_id = ctx.get("accountId")
    if account_id and account_id not in ctx.state.table("accounts"):
        raise DomainError(
            404,
            "account_not_found",
            account_id,
            {"obieErrorCode": "UK.OBIE.Resource.NotFound", "path": "accountId"},
        )
    txns = list(ctx.state.table("transactions").values())
    if account_id:
        txns = [t for t in txns if t["accountId"] == account_id]
    indicator = ctx.get("creditDebitIndicator")
    if indicator:
        txns = [
            t
            for t in txns
            if t["creditDebitIndicator"].lower() == str(indicator).lower()
        ]
    status = ctx.get("status")
    if status:
        txns = [t for t in txns if t["status"].lower() == str(status).lower()]
    from_date, to_date = ctx.get("fromBookingDateTime"), ctx.get("toBookingDateTime")
    if from_date:
        txns = [t for t in txns if t["bookingDateTime"] >= str(from_date)]
    if to_date:
        txns = [t for t in txns if t["bookingDateTime"] <= str(to_date)]
    txns = sorted(txns, key=lambda t: t["bookingDateTime"], reverse=True)
    return ctx.paginate(txns)


@base.op(ID, "list_beneficiaries")
def list_beneficiaries(ctx: Ctx) -> dict:
    ctx.require_scope("beneficiaries")
    account_id = ctx.get("accountId")
    if account_id and account_id not in ctx.state.table("accounts"):
        raise DomainError(
            404,
            "account_not_found",
            account_id,
            {"obieErrorCode": "UK.OBIE.Resource.NotFound", "path": "accountId"},
        )
    items = list(ctx.state.table("beneficiaries").values())
    if account_id:
        items = [b for b in items if b["accountId"] == account_id]
    return ctx.paginate(items)


@base.op(ID, "list_standing_orders")
def list_standing_orders(ctx: Ctx) -> dict:
    ctx.require_scope("standing_orders")
    account_id = ctx.get("accountId")
    if account_id and account_id not in ctx.state.table("accounts"):
        raise DomainError(
            404,
            "account_not_found",
            account_id,
            {"obieErrorCode": "UK.OBIE.Resource.NotFound", "path": "accountId"},
        )
    items = list(ctx.state.table("standing_orders").values())
    if account_id:
        items = [s for s in items if s["accountId"] == account_id]
    return ctx.paginate(items)


@base.op(ID, "list_direct_debits")
def list_direct_debits(ctx: Ctx) -> dict:
    ctx.require_scope("direct_debits")
    account_id = ctx.get("accountId")
    if account_id and account_id not in ctx.state.table("accounts"):
        raise DomainError(
            404,
            "account_not_found",
            account_id,
            {"obieErrorCode": "UK.OBIE.Resource.NotFound", "path": "accountId"},
        )
    items = list(ctx.state.table("direct_debits").values())
    if account_id:
        items = [d for d in items if d["accountId"] == account_id]
    return ctx.paginate(items)


@base.op(ID, "list_scheduled_payments")
def list_scheduled_payments(ctx: Ctx) -> dict:
    ctx.require_scope("accounts")
    account_id = ctx.get("accountId")
    if account_id and account_id not in ctx.state.table("accounts"):
        raise DomainError(
            404,
            "account_not_found",
            account_id,
            {"obieErrorCode": "UK.OBIE.Resource.NotFound", "path": "accountId"},
        )
    items = list(ctx.state.table("scheduled_payments").values())
    if account_id:
        items = [s for s in items if s["accountId"] == account_id]
    return ctx.paginate(items)


@base.op(ID, "confirm_funds")
def confirm_funds(ctx: Ctx) -> dict:
    """Confirmation of Funds (CBPII): a yes/no check that an account holds at least
    the requested amount, without moving money."""
    ctx.require_scope("fundsconfirmations")
    ctx.require("accountId", "amount")
    acct = _account_or_404(ctx, ctx.payload["accountId"])
    try:
        amount = round(float(ctx.payload["amount"]), 2)
    except (TypeError, ValueError):
        raise DomainError(
            422,
            "invalid_amount",
            "amount must be a number",
            {"obieErrorCode": "UK.OBIE.Field.Invalid", "path": "amount"},
        )
    currency = ctx.get("currency", acct["currency"])
    now = base.now()
    return {
        "fundsConfirmationId": base.new_id("fc"),
        "accountId": acct["accountId"],
        "fundsAvailable": amount <= acct["balances"]["available"],
        "reference": ctx.get("reference", ""),
        "instructedAmount": {"amount": amount, "currency": currency},
        "createdDateTime": _iso(now),
    }


@base.op(ID, "initiate_payment")
def initiate_payment(ctx: Ctx) -> dict:
    ctx.require_scope("payments")
    ctx.require("fromAccount", "amount", "creditor")
    acct = _account_or_404(ctx, ctx.payload["fromAccount"])
    if acct["status"] != "Enabled":
        raise DomainError(
            409,
            "account_not_enabled",
            "debtor account is not enabled for payments",
            {"obieErrorCode": "UK.OBIE.Rules.ResourceAlreadyExists"},
        )
    try:
        amount = round(float(ctx.payload["amount"]), 2)
    except (TypeError, ValueError):
        raise DomainError(
            422,
            "invalid_amount",
            "amount must be a number",
            {
                "obieErrorCode": "UK.OBIE.Field.Invalid",
                "path": "instructedAmount.amount",
            },
        )
    if amount <= 0:
        raise DomainError(
            422,
            "invalid_amount",
            "amount must be positive",
            {
                "obieErrorCode": "UK.OBIE.Field.Invalid",
                "path": "instructedAmount.amount",
            },
        )
    currency = ctx.get("currency", acct["currency"])
    if currency != acct["currency"]:
        raise DomainError(
            422,
            "currency_mismatch",
            f"account currency {acct['currency']} does not match {currency}",
            {
                "obieErrorCode": "UK.OBIE.Unsupported.Currency",
                "path": "instructedAmount.currency",
            },
        )
    context_code = ctx.get("paymentContextCode", "TransferToThirdParty")
    if context_code not in _PAYMENT_CONTEXT_CODES:
        raise DomainError(
            422,
            "invalid_payment_context",
            f"unsupported PaymentContextCode {context_code!r}",
            {
                "obieErrorCode": "UK.OBIE.Field.Invalid",
                "path": "risk.paymentContextCode",
            },
        )
    if amount > acct["balances"]["available"]:
        raise DomainError(
            402,
            "insufficient_funds",
            "amount exceeds available balance",
            {"obieErrorCode": "UK.OBIE.Rules.FailsControlParameters"},
        )

    idem = ctx.get("idempotencyKey")
    payments = ctx.state.table("payments")
    if idem and idem in payments:
        return payments[idem]

    rail = str(ctx.get("rail") or "FasterPayments")
    rail_key = rail.upper()
    domestic = rail_key in _DOMESTIC_RAILS
    now = base.now()
    scheduled = ctx.get("requestedExecutionDateTime")
    acct["balances"]["available"] = round(acct["balances"]["available"] - amount, 2)

    charges = []
    if not domestic:
        charges.append(
            {
                "chargeBearer": "BorneByDebtor",
                "type": "UK.OBIE.CHAPSOut",
                "amount": {
                    "amount": round(amount * 0.001 + 12.0, 2),
                    "currency": currency,
                },
            }
        )

    status = "Pending" if scheduled else "AcceptedSettlementInProcess"
    payment = {
        "paymentId": base.new_id("pmt"),
        "consentId": base.new_id("pmtcon"),
        "consentStatus": "Authorised",
        "status": status,
        "paymentType": "DomesticPayment" if domestic else "InternationalPayment",
        "rail": rail,
        "localInstrument": _RAIL_SCHEMES.get(rail_key, "UK.OBIE.FPS"),
        "instructionIdentification": base.new_id("instr"),
        "endToEndIdentification": ctx.get("endToEndId", base.new_id("e2e")),
        "debtorAccount": {
            "name": acct.get("accountHolderName", "LynxCapital Group Ltd"),
            "accountId": acct["accountId"],
            "identification": acct["identification"],
        },
        "creditorAccount": {
            "name": ctx.payload["creditor"],
            "identification": ctx.get("creditorAccount", ""),
        },
        "instructedAmount": {"amount": amount, "currency": currency},
        "remittanceInformation": {
            "unstructured": ctx.get("reference", ""),
            "reference": ctx.get("structuredReference", ctx.get("reference", "")),
        },
        "risk": {
            "paymentContextCode": context_code,
            "paymentPurposeCode": ctx.get("paymentPurposeCode", "BENE"),
        },
        "charges": charges,
        "createdDateTime": _iso(now),
        "statusUpdateDateTime": _iso(now),
        "expectedSettlementDateTime": _iso(now + 86400),
    }
    if scheduled:
        payment["requestedExecutionDateTime"] = scheduled
    if not domestic:
        payment["exchangeRateInformation"] = {
            "unitCurrency": currency,
            "exchangeRate": 1.0,
            "rateType": "Actual",
        }
    if amount >= _DUAL_AUTH_THRESHOLD:
        payment["multiAuthorisation"] = {
            "status": "AwaitingFurtherAuthorisation",
            "numberRequired": 2,
            "numberReceived": 1,
            "lastUpdateDateTime": _iso(now),
            "expirationDateTime": _iso(now + 7 * 86400),
        }
        payment["status"] = "Pending"

    payments[payment["paymentId"]] = payment
    if idem:
        payments[idem] = payment
    return payment


@base.op(ID, "get_payment")
def get_payment(ctx: Ctx) -> dict:
    ctx.require_scope("payments")
    ctx.require("paymentId")
    payment = ctx.state.table("payments").get(ctx.payload["paymentId"])
    if payment is None:
        raise DomainError(
            404,
            "payment_not_found",
            ctx.payload["paymentId"],
            {"obieErrorCode": "UK.OBIE.Resource.NotFound", "path": "paymentId"},
        )
    multi = payment.get("multiAuthorisation")
    if multi and multi["status"] == "AwaitingFurtherAuthorisation":
        multi["status"] = "Authorised"
        multi["numberReceived"] = multi["numberRequired"]
        multi["lastUpdateDateTime"] = _iso(base.now())
        payment["status"] = "AcceptedSettlementInProcess"
        payment["statusUpdateDateTime"] = _iso(base.now())
        return payment
    if payment["status"] not in _TERMINAL:
        payment["status"] = "AcceptedCreditSettlementCompleted"
        payment["consentStatus"] = "Consumed"
        payment["statusUpdateDateTime"] = _iso(base.now())
    return payment


@base.op(ID, "list_statements")
def list_statements(ctx: Ctx) -> dict:
    ctx.require_scope("statements")
    account_id = ctx.get("accountId")
    if account_id and account_id not in ctx.state.table("accounts"):
        raise DomainError(
            404,
            "account_not_found",
            account_id,
            {"obieErrorCode": "UK.OBIE.Resource.NotFound", "path": "accountId"},
        )
    statements = list(ctx.state.table("statements").values())
    if account_id:
        statements = [s for s in statements if s["accountId"] == account_id]
    statements = sorted(statements, key=lambda s: s["endDateTime"], reverse=True)
    return ctx.paginate(statements, size_default=12)


@base.op(ID, "get_statement")
def get_statement(ctx: Ctx) -> dict:
    ctx.require_scope("statements")
    ctx.require("accountId")
    account_id = ctx.payload["accountId"]
    _account_or_404(ctx, account_id)
    statements = sorted(
        (
            s
            for s in ctx.state.table("statements").values()
            if s["accountId"] == account_id
        ),
        key=lambda s: s["endDateTime"],
        reverse=True,
    )
    statement_id = ctx.get("statementId")
    if statement_id:
        match = next((s for s in statements if s["statementId"] == statement_id), None)
        if match is None:
            raise DomainError(
                404,
                "statement_not_found",
                statement_id,
                {"obieErrorCode": "UK.OBIE.Resource.NotFound", "path": "statementId"},
            )
        return match
    if not statements:
        raise DomainError(
            404,
            "statement_not_found",
            account_id,
            {"obieErrorCode": "UK.OBIE.Resource.NotFound", "path": "accountId"},
        )
    latest = statements[0]
    return {
        "accountId": account_id,
        "currency": latest["currency"],
        "latest": latest,
        "statements": statements,
    }
