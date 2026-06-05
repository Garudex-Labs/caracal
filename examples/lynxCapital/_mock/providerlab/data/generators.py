"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Deterministic seeded data generators that build large, related, evolving entity sets for each provider without external dependencies.
"""
from __future__ import annotations

import hashlib
import random
import uuid
from datetime import date, datetime, time, timedelta, timezone

_LEGAL = ("Holdings", "Industries", "Systems", "Logistics", "Components", "Partners",
          "Networks", "Capital", "Trading", "Labs", "Group", "Solutions", "Foods",
          "Materials", "Robotics", "Analytics", "Freight", "Ventures")
_ROOTS = ("Northwind", "Contoso", "Aerolux", "Meridian", "Vertex", "Apex", "Axiom",
          "Helios", "Cobalt", "Granite", "Sequoia", "Onyx", "Cinder", "Marigold",
          "Tamarind", "Borealis", "Solstice", "Kestrel", "Driftwood", "Lattice",
          "Quill", "Saffron", "Verde", "Indigo", "Crimson", "Harbor", "Cedar")
_FIRST = ("Dana", "Priya", "Marco", "Lena", "Hassan", "Yuki", "Sofia", "Diego",
          "Amara", "Noah", "Ingrid", "Tariq", "Mei", "Lucas", "Farah", "Oskar")
_LAST = ("Whitfield", "Okafor", "Bianchi", "Novak", "Haddad", "Tanaka", "Reyes",
         "Lindqvist", "Khan", "Bauer", "Costa", "Adeyemi", "Wu", "Sorensen")
_COUNTRIES = (("US", "USD"), ("GB", "GBP"), ("DE", "EUR"), ("FR", "EUR"),
              ("BR", "BRL"), ("SG", "SGD"), ("JP", "JPY"), ("CA", "CAD"))
_TERMS = ("NET15", "NET30", "NET45", "NET60")
_EPOCH = date(2026, 1, 1)

_BANK_SUBTYPES = ("CurrentAccount", "CurrentAccount", "Savings", "Loan")
_ACCOUNT_PRODUCTS = {
    "CurrentAccount": "Halcyon Business Current",
    "Savings": "Halcyon Business Reserve",
    "Loan": "Halcyon Working Capital Facility",
}
_PURPOSES = ("Operating", "Reserve", "Payroll", "Tax", "FX Settlement", "Escrow")
_BIC_BY_COUNTRY = {
    "GB": "HLCYGB2LXXX", "DE": "HLCYDEFFXXX", "FR": "HLCYFRPPXXX",
    "US": "HLCYUS33XXX", "BR": "HLCYBRSPXXX", "SG": "HLCYSGSGXXX",
    "JP": "HLCYJPJTXXX", "CA": "HLCYCATTXXX",
}
_MERCHANT_CATEGORIES = (
    ("5734", "Computer Software Stores"), ("7372", "Computer Programming Services"),
    ("4214", "Freight Carriers and Trucking"), ("5045", "Computers and Peripherals"),
    ("7311", "Advertising Services"), ("6513", "Real Estate Agents and Rentals"),
    ("4900", "Utilities"), ("5111", "Office Supplies and Printing"),
    ("8931", "Accounting and Bookkeeping"), ("5946", "Wholesale Industrial Supplies"),
)
_BANK_TXN_CODES = (
    ("PMT", "FasterPaymentsOut"), ("DD", "DirectDebit"), ("STO", "StandingOrder"),
    ("TFR", "InternalTransfer"), ("INT", "InterestCredit"), ("FEE", "ServiceCharge"),
    ("CARD", "CardPayment"), ("WIRE", "WireTransfer"), ("SEPA", "SepaCreditTransfer"),
)


def _rng(*parts: object) -> random.Random:
    key = ":".join(str(p) for p in parts)
    digest = hashlib.sha256(key.encode()).hexdigest()
    return random.Random(int(digest[:16], 16))


def _company(rng: random.Random) -> str:
    return f"{rng.choice(_ROOTS)} {rng.choice(_LEGAL)}"


def _person(rng: random.Random) -> str:
    return f"{rng.choice(_FIRST)} {rng.choice(_LAST)}"


def _slug(name: str) -> str:
    return "".join(c for c in name.lower() if c.isalnum() or c == " ").replace(" ", "-")


def _day(rng: random.Random, lo: int, hi: int) -> str:
    return (_EPOCH + timedelta(days=rng.randint(lo, hi))).isoformat()


def _instant(rng: random.Random, lo: int, hi: int) -> str:
    """An ISO-8601 UTC timestamp offset from the epoch by a day range."""
    moment = datetime.combine(_EPOCH + timedelta(days=rng.randint(lo, hi)), time.min, timezone.utc)
    moment += timedelta(seconds=rng.randint(0, 86_399))
    return moment.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _iban(rng: random.Random, country: str, account_number: str) -> str:
    check = f"{rng.randint(2, 98):02d}"
    bank = "HLCY"
    body = "".join(rng.choice("0123456789") for _ in range(8))
    return f"{country}{check}{bank}{body}{account_number}"


def vendors(seed: str, count: int) -> list[dict]:
    """Vendor / supplier master records with country, currency, terms, and tax id."""
    out = []
    for i in range(1, count + 1):
        rng = _rng(seed, "vendor", i)
        name = _company(rng)
        country, currency = rng.choice(_COUNTRIES)
        out.append({
            "id": f"VEND-{i:05d}",
            "name": name,
            "slug": _slug(name),
            "country": country,
            "currency": currency,
            "taxId": f"{country}{rng.randint(10**8, 10**9 - 1)}",
            "paymentTerms": rng.choice(_TERMS),
            "status": "active" if rng.random() > 0.08 else "on_hold",
            "riskTier": rng.choice(("low", "low", "medium", "high")),
            "createdAt": _day(rng, -540, -30),
        })
    return out


def contacts(seed: str, count: int) -> list[dict]:
    out = []
    stages = ("lead", "qualified", "customer", "vendor", "churned")
    for i in range(1, count + 1):
        rng = _rng(seed, "contact", i)
        name = _person(rng)
        company = _company(rng)
        out.append({
            "id": f"CONT-{i:05d}",
            "name": name,
            "email": f"{name.split()[0].lower()}@{_slug(company).split('-')[0]}.example",
            "company": company,
            "stage": rng.choice(stages),
            "ownerId": f"U-{rng.randint(1, 40)}",
            "createdAt": _day(rng, -400, -1),
        })
    return out


_BANK_ACCOUNT_PLAN = (
    ("US", "USD", "CurrentAccount", "Operating"),
    ("DE", "EUR", "CurrentAccount", "Operating"),
    ("GB", "GBP", "CurrentAccount", "Operating"),
    ("SG", "SGD", "CurrentAccount", "Operating"),
    ("BR", "BRL", "CurrentAccount", "Operating"),
    ("US", "USD", "Savings", "Reserve"),
)


def bank_accounts(seed: str, count: int) -> list[dict]:
    """Open-banking business accounts with identification, servicer, and balances
    shaped after OBIE/Berlin Group account resources. The leading accounts cover
    the group's primary operating currencies; any extra accounts are randomized."""
    out = []
    for i in range(1, count + 1):
        rng = _rng(seed, "bank_account", i)
        if i <= len(_BANK_ACCOUNT_PLAN):
            country, currency, subtype, purpose = _BANK_ACCOUNT_PLAN[i - 1]
        else:
            country, currency = rng.choice(_COUNTRIES)
            subtype = rng.choice(_BANK_SUBTYPES)
            purpose = rng.choice(_PURPOSES)
        account_number = f"{rng.randint(10**7, 10**8 - 1)}"
        booked = round(rng.uniform(25_000, 4_500_000), 2)
        available = round(booked * rng.uniform(0.6, 0.99), 2)
        if subtype == "Loan":
            booked = -round(rng.uniform(50_000, 2_000_000), 2)
            available = 0.0
        identification: dict = {"name": "LynxCapital Group Ltd"}
        if country == "US":
            identification["scheme"] = "US.RoutingNumberAccountNumber"
            identification["routingNumber"] = f"{rng.randint(10**8, 10**9 - 1)}"
            identification["accountNumber"] = account_number
        elif country == "GB":
            identification["scheme"] = "UK.OBIE.SortCodeAccountNumber"
            identification["sortCode"] = f"{rng.randint(0, 99):02d}-{rng.randint(0, 99):02d}-{rng.randint(0, 99):02d}"
            identification["accountNumber"] = account_number
            identification["iban"] = _iban(rng, country, account_number)
        else:
            identification["scheme"] = "IBAN"
            identification["iban"] = _iban(rng, country, account_number)
            identification["accountNumber"] = account_number
        balances = {
            "available": available,
            "booked": booked,
            "currency": currency,
            "creditLimit": round(rng.choice((0, 50_000, 250_000)) * 1.0, 2),
            "asOf": _instant(rng, -1, 0),
        }
        planned = i <= len(_BANK_ACCOUNT_PLAN)
        status = "Enabled" if planned or rng.random() > 0.1 else "Disabled"
        out.append({
            "accountId": f"ACC-{i:04d}",
            "nickname": f"{purpose} {currency}",
            "accountType": "Business",
            "accountSubType": subtype,
            "product": _ACCOUNT_PRODUCTS[subtype],
            "status": status,
            "currency": currency,
            "country": country,
            "identification": identification,
            "servicer": {"scheme": "BICFI", "bic": _BIC_BY_COUNTRY.get(country, "HLCYGB2LXXX")},
            "openingDate": _day(rng, -1460, -200),
            "balances": balances,
        })
    return out


def accounts(seed: str, count: int) -> list[dict]:
    """Bank or ledger accounts with balances and currency."""
    out = []
    kinds = ("operating", "reserve", "payroll", "fx", "escrow")
    for i in range(1, count + 1):
        rng = _rng(seed, "account", i)
        country, currency = rng.choice(_COUNTRIES)
        out.append({
            "id": f"ACCT-{i:04d}",
            "name": f"{rng.choice(kinds).title()} {currency}",
            "kind": rng.choice(kinds),
            "currency": currency,
            "balance": round(rng.uniform(25_000, 4_500_000), 2),
            "available": 0.0,
            "status": "active",
        })
        out[-1]["available"] = round(out[-1]["balance"] * rng.uniform(0.6, 0.99), 2)
    return out


def bank_transactions(seed: str, accounts_index: dict[str, dict], count: int) -> list[dict]:
    """Open-banking transaction entries with credit/debit indicator, booking and
    value dates, merchant enrichment, and a running booked balance per account."""
    account_ids = list(accounts_index.keys())
    running = {aid: accounts_index[aid]["balances"]["booked"] for aid in account_ids}
    drafts: list[tuple[int, dict]] = []
    for i in range(1, count + 1):
        rng = _rng(seed, "bank_txn", i)
        account_id = rng.choice(account_ids)
        account = accounts_index[account_id]
        currency = account["currency"]
        indicator = "Credit" if rng.random() > 0.62 else "Debit"
        amount = round(rng.uniform(50, 250_000), 2)
        code, sub_code = rng.choice(_BANK_TXN_CODES)
        mcc, mcc_label = rng.choice(_MERCHANT_CATEGORIES)
        booking_day = rng.randint(-180, 0)
        status = "Pending" if booking_day == 0 and rng.random() < 0.5 else "Booked"
        counterparty = _company(rng)
        drafts.append((booking_day, {
            "transactionId": f"TXN-{i:06d}",
            "accountId": account_id,
            "creditDebitIndicator": indicator,
            "status": status,
            "amount": amount,
            "currency": currency,
            "bookingDateTime": _instant(rng, booking_day, booking_day),
            "valueDateTime": _instant(rng, booking_day, min(0, booking_day + 1)),
            "transactionReference": f"E2E-{rng.randint(10**9, 10**10 - 1)}",
            "bankTransactionCode": {"code": code, "subCode": sub_code},
            "proprietaryBankTransactionCode": code,
            "merchantName": counterparty,
            "merchantCategoryCode": mcc,
            "merchantCategory": mcc_label,
            "remittanceInformation": f"Invoice {rng.choice(_ROOTS)[:3].upper()}-{rng.randint(1000, 9999)}",
            "counterparty": {
                "name": counterparty,
                "accountIdentification": f"****{rng.randint(1000, 9999)}",
            },
        }))
    out = []
    for booking_day, txn in sorted(drafts, key=lambda d: d[0]):
        if txn["status"] == "Booked":
            signed = txn["amount"] if txn["creditDebitIndicator"] == "Credit" else -txn["amount"]
            running[txn["accountId"]] = round(running[txn["accountId"]] + signed, 2)
            txn["balanceAfter"] = {"amount": running[txn["accountId"]], "currency": txn["currency"]}
        out.append(txn)
    return out


def bank_statements(seed: str, accounts_index: dict[str, dict],
                    transactions: list[dict], periods: int = 3) -> list[dict]:
    """Periodic account statements summarizing booked activity per month."""
    out = []
    serial = 0
    by_account: dict[str, list[dict]] = {}
    for txn in transactions:
        by_account.setdefault(txn["accountId"], []).append(txn)
    for account_id, account in accounts_index.items():
        currency = account["currency"]
        closing = account["balances"]["booked"]
        for p in range(periods):
            serial += 1
            rng = _rng(seed, "statement", account_id, p)
            end = _EPOCH - timedelta(days=30 * p)
            start = end - timedelta(days=30)
            window = [
                t for t in by_account.get(account_id, [])
                if t["status"] == "Booked" and start.isoformat() <= t["bookingDateTime"][:10] < end.isoformat()
            ]
            credits = round(sum(t["amount"] for t in window if t["creditDebitIndicator"] == "Credit"), 2)
            debits = round(sum(t["amount"] for t in window if t["creditDebitIndicator"] == "Debit"), 2)
            opening = round(closing - credits + debits, 2)
            out.append({
                "statementId": f"STMT-{serial:05d}",
                "accountId": account_id,
                "type": "RegularPeriodic",
                "currency": currency,
                "startDateTime": f"{start.isoformat()}T00:00:00Z",
                "endDateTime": f"{end.isoformat()}T00:00:00Z",
                "creationDateTime": f"{end.isoformat()}T02:00:00Z",
                "openingBalance": opening,
                "closingBalance": closing,
                "totalCredits": credits,
                "totalDebits": debits,
                "creditCount": sum(1 for t in window if t["creditDebitIndicator"] == "Credit"),
                "debitCount": sum(1 for t in window if t["creditDebitIndicator"] == "Debit"),
                "transactionCount": len(window),
            })
            closing = opening
    return out


def invoices(seed: str, vendor_ids: list[str], count: int) -> list[dict]:
    out = []
    for i in range(1, count + 1):
        rng = _rng(seed, "invoice", i)
        currency = rng.choice(_COUNTRIES)[1]
        amount = round(rng.uniform(250, 180_000), 2)
        issued = _EPOCH + timedelta(days=rng.randint(-150, -5))
        out.append({
            "id": f"INV-{i:06d}",
            "vendorId": rng.choice(vendor_ids),
            "number": f"{rng.choice(_ROOTS)[:3].upper()}-{rng.randint(1000, 9999)}",
            "amount": amount,
            "currency": currency,
            "tax": round(amount * rng.choice((0.0, 0.07, 0.19, 0.0825)), 2),
            "issuedAt": issued.isoformat(),
            "dueAt": (issued + timedelta(days=rng.choice((15, 30, 45)))).isoformat(),
            "status": rng.choice(("open", "open", "matched", "paid", "disputed")),
        })
    return out


def users(seed: str, count: int) -> list[dict]:
    out = []
    roles = ("analyst", "controller", "treasurer", "approver", "auditor", "admin")
    for i in range(1, count + 1):
        rng = _rng(seed, "user", i)
        name = _person(rng)
        out.append({
            "id": f"U-{i}",
            "name": name,
            "email": f"{name.split()[0].lower()}.{name.split()[1].lower()}@lynxcapital.example",
            "role": rng.choice(roles),
            "active": rng.random() > 0.06,
            "groups": sorted({f"grp-{rng.choice(('finance','treasury','compliance','ap','ar'))}"
                              for _ in range(rng.randint(1, 3))}),
        })
    return out


def instruments(seed: str) -> list[dict]:
    pairs = ("USD/EUR", "USD/GBP", "USD/JPY", "USD/BRL", "USD/SGD", "EUR/GBP",
             "EUR/JPY", "GBP/JPY", "USD/CAD", "EUR/CHF")
    out = []
    for sym in pairs:
        rng = _rng(seed, "instrument", sym)
        out.append({
            "symbol": sym,
            "mid": round(rng.uniform(0.6, 160.0), 4),
            "spreadBps": rng.randint(2, 18),
            "venue": rng.choice(("LDN", "NYC", "SGP", "TKY")),
        })
    return out


def recipients(seed: str, count: int) -> list[dict]:
    out = []
    methods = ("bank", "wallet", "card")
    for i in range(1, count + 1):
        rng = _rng(seed, "recipient", i)
        country, currency = rng.choice(_COUNTRIES)
        out.append({
            "id": f"RCPT-{i:05d}",
            "name": _company(rng) if rng.random() > 0.4 else _person(rng),
            "country": country,
            "currency": currency,
            "method": rng.choice(methods),
            "verified": rng.random() > 0.15,
        })
    return out


_MERIDIAN_EPOCH = int(datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp())

# (brand, last4, funding, network) — shaped after the canonical test cards real
# card platforms publish so the wire surface looks like a live acceptance gateway.
_CARDS = (
    ("visa", "4242", "credit", "Visa"),
    ("visa", "4000", "debit", "Visa"),
    ("mastercard", "5555", "credit", "Mastercard"),
    ("mastercard", "2223", "debit", "Mastercard"),
    ("amex", "0005", "credit", "American Express"),
    ("discover", "1117", "credit", "Discover"),
)
_WALLETS = ("apple_pay", "google_pay", "link")
_DISPUTE_REASONS = ("fraudulent", "duplicate", "product_not_received",
                    "subscription_canceled", "credit_not_processed", "general")
_DISPUTE_NETWORK_CODE = {
    "fraudulent": "10.4", "duplicate": "12.6.1", "product_not_received": "13.1",
    "subscription_canceled": "13.2", "credit_not_processed": "13.6", "general": "13.7",
}
_REFUND_REASONS = ("requested_by_customer", "duplicate", "fraudulent")
_RISK_LEVELS = ("normal", "normal", "normal", "elevated", "highest")
_CHARGE_EVENT_TYPE = {
    "succeeded": "charge.succeeded",
    "failed": "charge.failed",
    "requires_capture": "charge.updated",
}


def _meridian_ts(rng: random.Random, lo_days: int, hi_days: int) -> int:
    """A unix timestamp offset back from the Meridian epoch by a day range."""
    return _MERIDIAN_EPOCH - rng.randint(lo_days, hi_days) * 86_400 - rng.randint(0, 86_399)


def _processing_fee(amount: float, currency: str) -> float:
    """Blended acceptance fee: 2.9% + a fixed minor-unit component, as US card
    platforms charge. Non-USD settlement adds a one-percent cross-border uplift."""
    rate = 0.029 if currency == "USD" else 0.039
    fixed = 0.30 if currency == "USD" else 0.25
    return round(amount * rate + fixed, 2)


def _card_payment_method(rng: random.Random) -> dict:
    brand, last4, funding, network = rng.choice(_CARDS)
    country, _ = rng.choice(_COUNTRIES)
    wallet = rng.choice(_WALLETS) if rng.random() < 0.25 else None
    return {
        "type": "card",
        "card": {
            "brand": brand,
            "last4": last4,
            "expMonth": rng.randint(1, 12),
            "expYear": 2027 + rng.randint(0, 4),
            "funding": funding,
            "network": network,
            "country": country,
            "fingerprint": f"fp_{_rng('fp', brand, last4, rng.random()).getrandbits(48):012x}",
            "threeDSecure": "authenticated" if rng.random() < 0.4 else "not_required",
            "wallet": wallet,
            "checks": {
                "cvcCheck": "pass",
                "addressLine1Check": rng.choice(("pass", "pass", "unchecked")),
                "addressPostalCodeCheck": rng.choice(("pass", "pass", "fail")),
            },
        },
    }


def _outcome(rng: random.Random, risk: str) -> dict:
    score = {"normal": rng.randint(2, 40), "elevated": rng.randint(60, 74),
             "highest": rng.randint(75, 95)}[risk]
    return {
        "networkStatus": "approved_by_network",
        "reason": None,
        "riskLevel": risk,
        "riskScore": score,
        "sellerMessage": "Payment complete.",
        "type": "authorized",
    }


def _new_charge(rng: random.Random, idx: int, currency: str, created: int) -> dict:
    amount = round(rng.uniform(18, 9800), 2)
    pm = _card_payment_method(rng)
    risk = rng.choice(_RISK_LEVELS)
    fee = _processing_fee(amount, currency)
    charge_id = f"ch_{rng.getrandbits(60):015x}"
    name = _person(rng)
    customer_no = rng.randint(10000, 99999)
    return {
        "id": charge_id,
        "chargeId": charge_id,
        "object": "charge",
        "amount": amount,
        "amountCaptured": amount,
        "amountRefunded": 0.0,
        "currency": currency,
        "status": "succeeded",
        "captured": True,
        "paid": True,
        "refunded": False,
        "disputed": False,
        "description": f"LynxCapital receivable {created}",
        "statementDescriptor": "MERIDIAN* LYNXCAPITAL",
        "source": f"tok_{pm['card']['brand']}",
        "paymentMethod": f"pm_{rng.getrandbits(56):014x}",
        "paymentMethodDetails": pm,
        "billingDetails": {
            "name": name,
            "email": f"{name.split()[0].lower()}.{name.split()[1].lower()}@payer.example",
            "phone": None,
            "address": {"country": pm["card"]["country"], "postalCode": f"{rng.randint(10000, 99999)}"},
        },
        "outcome": _outcome(rng, risk),
        "processingFee": fee,
        "net": round(amount - fee, 2),
        "balanceTransaction": f"txn_{rng.getrandbits(56):014x}",
        "receiptUrl": f"https://pay.meridianpay.test/receipts/{charge_id}",
        "customer": f"cus_{customer_no:08x}",
        "metadata": {"invoiceId": f"INV-{idx:05d}", "region": pm["card"]["country"]},
        "settlementId": None,
        "payoutId": None,
        "created": created,
        "livemode": False,
    }


def _new_refund(rng: random.Random, charge: dict, amount: float, created: int) -> dict:
    refund_id = f"re_{rng.getrandbits(60):015x}"
    return {
        "id": refund_id,
        "refundId": refund_id,
        "object": "refund",
        "amount": amount,
        "currency": charge["currency"],
        "chargeId": charge["chargeId"],
        "status": "succeeded",
        "reason": rng.choice(_REFUND_REASONS),
        "receiptNumber": f"{rng.randint(1000, 9999)}-{rng.randint(1000, 9999)}",
        "balanceTransaction": f"txn_{rng.getrandbits(56):014x}",
        "created": created,
        "metadata": {},
    }


def _new_dispute(rng: random.Random, charge: dict, created: int) -> dict:
    reason = rng.choice(_DISPUTE_REASONS)
    status = rng.choice(("warning_needs_response", "needs_response", "needs_response",
                         "under_review", "won", "lost"))
    has_evidence = status in ("under_review", "won", "lost")
    dispute_id = f"dp_{rng.getrandbits(60):015x}"
    return {
        "id": dispute_id,
        "disputeId": dispute_id,
        "object": "dispute",
        "amount": charge["amount"],
        "currency": charge["currency"],
        "chargeId": charge["chargeId"],
        "reason": reason,
        "status": status,
        "networkReasonCode": _DISPUTE_NETWORK_CODE[reason],
        "isChargeRefundable": status in ("warning_needs_response", "needs_response"),
        "evidenceDueBy": created + 21 * 86_400,
        "evidenceDetails": {
            "dueBy": created + 21 * 86_400,
            "hasEvidence": has_evidence,
            "submissionCount": 1 if has_evidence else 0,
            "pastDue": False,
        },
        "evidence": {},
        "balanceTransactions": [{
            "id": f"txn_{rng.getrandbits(56):014x}",
            "amount": -charge["amount"],
            "fee": 15.00,
            "type": "adjustment",
        }],
        "created": created,
        "metadata": {},
    }


def _event(rng: random.Random, kind: str, obj: dict, created: int) -> dict:
    return {
        "id": f"evt_{rng.getrandbits(60):015x}",
        "object": "event",
        "type": kind,
        "apiVersion": "2026-01-15",
        "created": created,
        "livemode": False,
        "pendingWebhooks": 0,
        "request": {"id": f"req_{rng.getrandbits(48):012x}", "idempotencyKey": None},
        "data": {"object": obj},
    }


def meridian_dataset(seed: str) -> dict[str, dict]:
    """Build a coherent payment-acceptance dataset: charges that settle into
    payouts via settlement batches, with refunds, disputes, and the event stream
    a real platform would have emitted as webhooks."""
    charges: dict[str, dict] = {}
    refunds: dict[str, dict] = {}
    disputes: dict[str, dict] = {}
    payouts: dict[str, dict] = {}
    settlements: dict[str, dict] = {}
    events: dict[str, dict] = {}

    for i in range(1, 71):
        rng = _rng(seed, "charge", i)
        currency = "USD" if rng.random() < 0.82 else rng.choice(("EUR", "GBP"))
        created = _meridian_ts(rng, 1, 75)
        charge = _new_charge(rng, i, currency, created)

        roll = rng.random()
        if roll < 0.07:
            charge.update(status="failed", captured=False, paid=False,
                          amountCaptured=0.0, net=0.0, processingFee=0.0,
                          balanceTransaction=None)
            charge["outcome"].update(networkStatus="declined_by_network", type="issuer_declined",
                                     reason="card_declined", sellerMessage="The bank declined this charge.")
            charge["source"] = "tok_chargeDeclined"
        elif roll < 0.10:
            charge.update(status="requires_capture", captured=False, paid=False,
                          amountCaptured=0.0)
            charge["outcome"]["type"] = "manual"
        events[charge["id"]] = _event(
            rng, _CHARGE_EVENT_TYPE.get(charge["status"], "charge.updated"),
            charge, created)
        charges[charge["chargeId"]] = charge

    succeeded = [c for c in charges.values() if c["status"] == "succeeded"]

    refundable = [c for c in succeeded if _rng(seed, "refund_pick", c["chargeId"]).random() < 0.18]
    for c in refundable:
        rng = _rng(seed, "refund", c["chargeId"])
        full = rng.random() < 0.6
        amount = c["amount"] if full else round(c["amount"] * rng.uniform(0.2, 0.7), 2)
        created = c["created"] + rng.randint(1, 10) * 86_400
        refund = _new_refund(rng, c, amount, created)
        refunds[refund["refundId"]] = refund
        c["amountRefunded"] = amount
        c["refunded"] = full
        c["status"] = "refunded" if full else "succeeded"
        events[refund["refundId"]] = _event(rng, "charge.refunded", refund, created)

    disputed = [c for c in succeeded if _rng(seed, "dispute_pick", c["chargeId"]).random() < 0.12][:8]
    for c in disputed:
        rng = _rng(seed, "dispute", c["chargeId"])
        created = c["created"] + rng.randint(2, 20) * 86_400
        dispute = _new_dispute(rng, c, created)
        disputes[dispute["disputeId"]] = dispute
        c["disputed"] = True
        events[dispute["disputeId"]] = _event(rng, "charge.dispute.created", dispute, created)

    usd_settled = sorted((c for c in succeeded if c["currency"] == "USD"),
                         key=lambda c: c["created"])
    batch_size = max(1, len(usd_settled) // 6)
    for b in range(0, len(usd_settled), batch_size):
        batch = usd_settled[b:b + batch_size]
        if not batch:
            continue
        idx = b // batch_size + 1
        rng = _rng(seed, "settlement", idx)
        gross = round(sum(c["amount"] for c in batch), 2)
        fee = round(sum(c["processingFee"] for c in batch), 2)
        refund_total = round(sum(c["amountRefunded"] for c in batch), 2)
        net = round(gross - fee - refund_total, 2)
        period_end = max(c["created"] for c in batch) + 2 * 86_400
        status = "paid" if idx <= 4 else rng.choice(("paid", "in_transit", "in_transit"))
        payout_id = f"po_{rng.getrandbits(60):015x}"
        settlement_id = f"st_{rng.getrandbits(56):014x}"
        arrival = period_end + 2 * 86_400
        method = "instant" if rng.random() < 0.2 else "standard"
        failure = None
        if idx == 6 and status != "paid":
            status = "failed"
            failure = "account_closed"
        payout = {
            "id": payout_id,
            "payoutId": payout_id,
            "object": "payout",
            "amount": net,
            "currency": "USD",
            "status": status,
            "type": "bank_account",
            "method": method,
            "destination": f"ba_{rng.getrandbits(48):012x}",
            "statementDescriptor": "MERIDIAN PAYOUT",
            "sourceType": "card",
            "automatic": True,
            "arrivalDate": arrival,
            "settlementId": settlement_id,
            "failureCode": failure,
            "failureMessage": "The bank account has been closed." if failure else None,
            "created": period_end,
            "metadata": {},
        }
        payouts[payout_id] = payout
        settlements[settlement_id] = {
            "id": settlement_id,
            "settlementId": settlement_id,
            "object": "settlement",
            "status": status,
            "currency": "USD",
            "grossAmount": gross,
            "feeAmount": fee,
            "refundAmount": refund_total,
            "netAmount": net,
            "chargeCount": len(batch),
            "refundCount": sum(1 for c in batch if c["amountRefunded"] > 0),
            "payoutId": payout_id,
            "periodStart": min(c["created"] for c in batch),
            "periodEnd": period_end,
            "reportUrl": f"https://pay.meridianpay.test/settlements/{settlement_id}/report.csv",
            "created": period_end,
        }
        for c in batch:
            c["settlementId"] = settlement_id
            c["payoutId"] = payout_id
        if status == "paid":
            events[payout_id] = _event(rng, "payout.paid", payout, arrival)
        elif status == "failed":
            events[payout_id] = _event(rng, "payout.failed", payout, arrival)

    return {
        "charges": charges,
        "refunds": refunds,
        "disputes": disputes,
        "payouts": payouts,
        "settlements": settlements,
        "events": events,
    }


# --------------------------------------------------------------------------- #
# Ironbark ERP — NetSuite / SAP S/4HANA / Dynamics 365 Finance flavored records
# --------------------------------------------------------------------------- #
_GL_CHART = (
    ("1000", "Operating Bank - USD", "Bank", "USD"),
    ("1010", "Operating Bank - EUR", "Bank", "EUR"),
    ("1100", "Accounts Receivable", "AcctRec", "USD"),
    ("1200", "Inventory", "OthCurrAsset", "USD"),
    ("1500", "Fixed Assets", "FixedAsset", "USD"),
    ("2000", "Accounts Payable", "AcctPay", "USD"),
    ("2100", "Accrued Expenses", "OthCurrLiab", "USD"),
    ("2200", "Sales Tax Payable", "OthCurrLiab", "USD"),
    ("3000", "Common Stock", "Equity", "USD"),
    ("3900", "Retained Earnings", "Equity", "USD"),
    ("4000", "Revenue", "Income", "USD"),
    ("5000", "Cost of Goods Sold", "COGS", "USD"),
    ("6000", "Payroll Expense", "Expense", "USD"),
    ("6100", "Facilities Expense", "Expense", "USD"),
    ("6200", "Software Subscriptions", "Expense", "USD"),
    ("6300", "Professional Fees", "Expense", "USD"),
)
_ERP_ITEMS = (
    ("Cloud compute", "6200"), ("Software licenses", "6200"),
    ("Professional services", "6300"), ("Office supplies", "6100"),
    ("Marketing services", "6300"), ("Networking hardware", "1500"),
    ("Inbound freight", "5000"), ("Facilities maintenance", "6100"),
    ("Managed security", "6300"), ("Data subscriptions", "6200"),
)
_VENDOR_CATEGORIES = ("Software", "Professional Services", "Facilities", "Logistics",
                      "Hardware", "Marketing", "Utilities", "Consulting")
_SUBSIDIARIES = ("LynxCapital : US", "LynxCapital : EMEA", "LynxCapital : APAC")
_DEPARTMENTS = ("Engineering", "Finance", "Operations", "Marketing", "Treasury", "Legal")
_CITY_BY_COUNTRY = {
    "US": "Austin", "GB": "London", "DE": "Berlin", "FR": "Paris",
    "BR": "Sao Paulo", "SG": "Singapore", "JP": "Tokyo", "CA": "Toronto",
}
_TAX_RATE_BY_COUNTRY = {
    "US": 0.0825, "GB": 0.20, "DE": 0.19, "FR": 0.20,
    "BR": 0.17, "SG": 0.09, "JP": 0.10, "CA": 0.13,
}
_LEGAL_SUFFIX = {"US": "Inc.", "CA": "Inc.", "GB": "Ltd.", "SG": "Pte. Ltd.",
                 "DE": "GmbH", "FR": "S.A.S.", "BR": "Ltda.", "JP": "K.K."}
_PO_STATUSES = ("pendingReceipt", "partiallyReceived", "pendingBilling",
                "fullyBilled", "closed")


def _term_days(term: str) -> int:
    return {"NET15": 15, "NET30": 30, "NET45": 45, "NET60": 60}.get(term, 30)


def _posting_period(iso_day: str) -> str:
    moment = date.fromisoformat(iso_day[:10])
    return moment.strftime("%b %Y")


def _erp_vendor(seed: str, i: int) -> dict:
    rng = _rng(seed, "erp_vendor", i)
    name = _company(rng)
    country, currency = rng.choice(_COUNTRIES)
    internal = 1000 + i
    status = rng.choices(("active", "inactive", "onHold"), weights=(86, 8, 6))[0]
    contact = _person(rng)
    return {
        "id": f"VEND-{internal:05d}",
        "internalId": str(internal),
        "entityId": f"V{internal:05d} {name}",
        "companyName": name,
        "legalName": f"{name} {_LEGAL_SUFFIX.get(country, 'Ltd.')}",
        "taxId": f"{country}{rng.randint(10 ** 8, 10 ** 9 - 1)}",
        "category": rng.choice(_VENDOR_CATEGORIES),
        "subsidiary": rng.choice(_SUBSIDIARIES),
        "currency": currency,
        "terms": rng.choice(_TERMS),
        "status": status,
        "isInactive": status == "inactive",
        "is1099Eligible": country == "US" and rng.random() < 0.3,
        "defaultPayablesAccount": "2000",
        "creditLimit": float(rng.choice((25_000, 50_000, 100_000, 250_000, 500_000))),
        "balancePrimary": 0.0,
        "primaryContact": {
            "name": contact,
            "email": f"{contact.split()[0].lower()}.{contact.split()[1].lower()}@{_slug(name).split('-')[0]}.example",
            "phone": f"+1-{rng.randint(200, 989)}-{rng.randint(200, 989)}-{rng.randint(1000, 9999)}",
        },
        "addressBook": [{
            "label": "Remit-To",
            "addr1": f"{rng.randint(10, 9999)} {rng.choice(_ROOTS)} {rng.choice(('Ave', 'St', 'Blvd', 'Way'))}",
            "city": _CITY_BY_COUNTRY.get(country, "Austin"),
            "zip": f"{rng.randint(10000, 99999)}",
            "country": country,
        }],
        "createdDate": _instant(rng, -720, -120),
        "lastModifiedDate": _instant(rng, -119, -1),
    }


def _po_lines(rng: random.Random) -> list[dict]:
    lines = []
    for n in range(1, rng.randint(1, 4) + 1):
        item, account = rng.choice(_ERP_ITEMS)
        quantity = rng.randint(1, 40)
        rate = round(rng.uniform(45, 5_200), 2)
        lines.append({
            "lineId": n,
            "item": item,
            "description": f"{item} — PO commitment",
            "account": account,
            "quantity": quantity,
            "quantityReceived": 0,
            "quantityBilled": 0,
            "rate": rate,
            "amount": round(quantity * rate, 2),
        })
    return lines


def _purchase_order(seed: str, idx: int, vendor: dict) -> dict:
    rng = _rng(seed, "po", idx)
    lines = _po_lines(rng)
    subtotal = round(sum(l["amount"] for l in lines), 2)
    rate = _TAX_RATE_BY_COUNTRY.get(vendor["addressBook"][0]["country"], 0.0)
    tax_total = round(subtotal * rate, 2)
    created = _instant(rng, -240, -10)
    status = rng.choices(_PO_STATUSES, weights=(28, 16, 22, 24, 10))[0]
    received_all = status in ("pendingBilling", "fullyBilled", "closed")
    billed_all = status in ("fullyBilled", "closed")
    for line in lines:
        line["quantityReceived"] = line["quantity"] if received_all else (
            line["quantity"] // 2 if status == "partiallyReceived" else 0)
        line["quantityBilled"] = line["quantity"] if billed_all else 0
    return {
        "id": f"PO-{idx:05d}",
        "tranId": f"PO-2026-{idx:05d}",
        "type": "purchaseOrder",
        "vendorId": vendor["id"],
        "vendorName": vendor["companyName"],
        "status": status,
        "approvalStatus": "approved" if status != "pendingReceipt" or rng.random() > 0.2 else "pendingApproval",
        "subsidiary": vendor["subsidiary"],
        "department": rng.choice(_DEPARTMENTS),
        "currency": vendor["currency"],
        "memo": f"Commitment to {vendor['companyName']}",
        "lines": lines,
        "subtotal": subtotal,
        "taxTotal": tax_total,
        "total": round(subtotal + tax_total, 2),
        "createdDate": created,
        "dueDate": _day(rng, -5, 60),
    }


def _bill_lines_from_po(po: dict) -> list[dict]:
    return [{
        "lineId": l["lineId"],
        "item": l["item"],
        "description": l["description"].replace("PO commitment", "vendor invoice"),
        "account": l["account"],
        "quantity": l["quantity"],
        "rate": l["rate"],
        "amount": l["amount"],
    } for l in po["lines"]]


def _vendor_bill(seed: str, idx: int, vendor: dict, po: dict | None) -> dict:
    rng = _rng(seed, "bill", idx)
    if po is not None:
        lines = _bill_lines_from_po(po)
        country = vendor["addressBook"][0]["country"]
    else:
        lines = _po_lines(rng)
        for line in lines:
            line.pop("quantityReceived", None)
            line.pop("quantityBilled", None)
        country = vendor["addressBook"][0]["country"]
    subtotal = round(sum(l["amount"] for l in lines), 2)
    tax_total = round(subtotal * _TAX_RATE_BY_COUNTRY.get(country, 0.0), 2)
    total = round(subtotal + tax_total, 2)
    created = _instant(rng, -150, -3)
    term_days = _term_days(vendor["terms"])
    due = (date.fromisoformat(created[:10]) + timedelta(days=term_days)).isoformat()
    status = rng.choices(("open", "paidInFull", "pendingApproval", "cancelled"),
                         weights=(50, 34, 12, 4))[0]
    amount_paid = total if status == "paidInFull" else (
        round(total * rng.uniform(0.2, 0.6), 2) if status == "open" and rng.random() < 0.25 else 0.0)
    return {
        "id": f"BILL-{idx:06d}",
        "tranId": f"VENDBILL-{idx:06d}",
        "type": "vendorBill",
        "vendorId": vendor["id"],
        "vendorName": vendor["companyName"],
        "referenceNumber": f"{vendor['companyName'][:3].upper()}-{rng.randint(10000, 99999)}",
        "purchaseOrderId": po["id"] if po else None,
        "status": status,
        "approvalStatus": "approved" if status != "pendingApproval" else "pendingApproval",
        "subsidiary": vendor["subsidiary"],
        "account": vendor["defaultPayablesAccount"],
        "currency": vendor["currency"],
        "terms": vendor["terms"],
        "lines": lines,
        "subtotal": subtotal,
        "taxTotal": tax_total,
        "total": total,
        "amountPaid": amount_paid,
        "amountRemaining": round(total - amount_paid, 2),
        "postingPeriod": _posting_period(created),
        "createdDate": created,
        "dueDate": due,
    }


def _journal_entry(seed: str, idx: int) -> dict:
    rng = _rng(seed, "je", idx)
    expense = rng.choice(("6000", "6100", "6200", "6300", "5000"))
    amount = round(rng.uniform(1_500, 120_000), 2)
    credit_account = rng.choice(("2000", "2100", "1000"))
    created = _instant(rng, -120, -2)
    lines = [
        {"line": 1, "account": expense, "debit": amount, "credit": 0.0,
         "memo": "Accrued cost", "department": rng.choice(_DEPARTMENTS)},
        {"line": 2, "account": credit_account, "debit": 0.0, "credit": amount,
         "memo": "Offset", "department": rng.choice(_DEPARTMENTS)},
    ]
    return {
        "id": f"JE-{idx:06d}",
        "tranId": f"JOURNAL-{idx:06d}",
        "type": "journalEntry",
        "subsidiary": rng.choice(_SUBSIDIARIES),
        "currency": "USD",
        "postingPeriod": _posting_period(created),
        "lines": lines,
        "totalDebit": amount,
        "totalCredit": amount,
        "status": "posted",
        "reversalOf": None,
        "createdDate": created,
    }


def ironbark_dataset(seed: str) -> dict[str, dict]:
    """Build a coherent ERP back office: a chart of accounts, vendor master,
    purchase orders that flow into vendor bills via three-way match, and posted
    journal entries — with vendor balances and the AP control account rolled up
    the way a real ledger keeps them."""
    accounts: dict[str, dict] = {}
    for number, name, acct_type, currency in _GL_CHART:
        accounts[f"ACCT-{number}"] = {
            "id": f"ACCT-{number}",
            "acctNumber": number,
            "acctName": name,
            "acctType": acct_type,
            "currency": currency,
            "subsidiary": "LynxCapital : Consolidated",
            "balance": 0.0,
            "isInactive": False,
        }

    vendors = {v["id"]: v for v in (_erp_vendor(seed, i) for i in range(1, 121))}
    active = [v for v in vendors.values() if v["status"] == "active"]

    purchase_orders: dict[str, dict] = {}
    for idx in range(1, 41):
        vendor = active[_rng(seed, "po_pick", idx).randrange(len(active))]
        po = _purchase_order(seed, idx, vendor)
        purchase_orders[po["id"]] = po

    bills: dict[str, dict] = {}
    po_list = list(purchase_orders.values())
    for idx in range(1, 61):
        rng = _rng(seed, "bill_pick", idx)
        linked = idx <= 30 and po_list
        po = po_list[rng.randrange(len(po_list))] if linked else None
        vendor = vendors[po["vendorId"]] if po else active[rng.randrange(len(active))]
        bill = _vendor_bill(seed, idx, vendor, po)
        bills[bill["id"]] = bill

    journal_entries: dict[str, dict] = {
        je["id"]: je for je in (_journal_entry(seed, i) for i in range(1, 31))
    }

    ap_outstanding = 0.0
    for bill in bills.values():
        if bill["status"] in ("open", "pendingApproval"):
            vendors[bill["vendorId"]]["balancePrimary"] = round(
                vendors[bill["vendorId"]]["balancePrimary"] + bill["amountRemaining"], 2)
            ap_outstanding += bill["amountRemaining"]
    accounts["ACCT-2000"]["balance"] = round(ap_outstanding, 2)

    return {
        "accounts": accounts,
        "vendors": vendors,
        "purchase_orders": purchase_orders,
        "bills": bills,
        "journal_entries": journal_entries,
        "matches": {},
    }


# --------------------------------------------------------------------------- #
# Cordoba FX — cross-border FX-as-a-service, modeled on Currencycloud and Wise.
# Mid-market reference, settlement, beneficiary, and payment shapes mirror the
# real wire format: snake_case fields and decimal-string monetary amounts.
# --------------------------------------------------------------------------- #
_CORDOBA_EPOCH = datetime(2026, 1, 1, tzinfo=timezone.utc)

# Mid-market reference: units of the quoted currency per 1 USD.
_FX_MID = {
    "USD": 1.0, "EUR": 0.92, "GBP": 0.79, "JPY": 156.4, "BRL": 5.08,
    "SGD": 1.35, "CAD": 1.37, "CHF": 0.89, "AUD": 1.52, "INR": 83.2, "MXN": 18.7,
}

# Spread charged over mid-market, in basis points, widening for thinner pairs.
_FX_SPREAD_BPS = {
    "EUR": 20, "GBP": 22, "CHF": 28, "CAD": 28, "SGD": 30, "AUD": 30,
    "JPY": 35, "MXN": 55, "INR": 60, "BRL": 75,
}

# Currencies whose minor unit is not 1/100.
_FX_ZERO_DECIMAL = {"JPY"}

# Country -> (currency, routing_code_type) for beneficiary bank coordinates.
_FX_BANK_ROUTING = {
    "US": ("USD", "aba"), "GB": ("GBP", "sort_code"), "DE": ("EUR", "iban"),
    "FR": ("EUR", "iban"), "BR": ("BRL", "bic_swift"), "SG": ("SGD", "bic_swift"),
    "JP": ("JPY", "bic_swift"), "CA": ("CAD", "bic_swift"), "IN": ("INR", "ifsc"),
    "MX": ("MXN", "clabe"), "AU": ("AUD", "bsb_code"),
}

# Per-currency minimum conversion size, in the sell currency.
_FX_MIN_CONVERSION = {"JPY": 1500.0, "INR": 800.0, "BRL": 60.0, "MXN": 200.0}

_CONVERSION_FLOW = ("awaiting_funds", "funds_sent", "funds_arrived", "trade_settled")
_PAYMENT_FLOW = ("ready_to_send", "submitted", "completed")


def fx_currencies() -> tuple[str, ...]:
    return tuple(_FX_MID)


def fx_supported(currency: str) -> bool:
    return currency in _FX_MID


def fx_minor_units(currency: str) -> int:
    return 0 if currency in _FX_ZERO_DECIMAL else 2


def fx_money(amount: float, currency: str) -> str:
    decimals = fx_minor_units(currency)
    return f"{round(float(amount), decimals):.{decimals}f}"


def fx_min_conversion(currency: str) -> float:
    return _FX_MIN_CONVERSION.get(currency, 100.0)


def fx_rate_str(rate: float) -> str:
    """Format a rate to six significant figures, as FX platforms publish them."""
    return f"{rate:.6g}"


def fx_mid_rate(sell: str, buy: str) -> float:
    """Mid-market units of buy currency per one unit of sell currency."""
    return _FX_MID[buy] / _FX_MID[sell]


def fx_spread(sell: str, buy: str) -> float:
    bps = max(_FX_SPREAD_BPS.get(buy, 15), _FX_SPREAD_BPS.get(sell, 15))
    return bps / 10_000.0


def fx_client_rate(sell: str, buy: str) -> float:
    """Client-facing rate: the spread leaves the client slightly fewer buy units."""
    return fx_mid_rate(sell, buy) * (1.0 - fx_spread(sell, buy))


def fx_next_status(current: str, kind: str) -> str:
    """Advance a conversion or payment one step along its settlement lifecycle."""
    flow = _CONVERSION_FLOW if kind == "conversion" else _PAYMENT_FLOW
    if current not in flow:
        return current
    return flow[min(flow.index(current) + 1, len(flow) - 1)]


def _fx_iso(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat()


def _fx_bic(rng: random.Random, country: str) -> str:
    bank = "".join(rng.choice("ABCDEFGHJKLMNPRSTUVWXYZ") for _ in range(4))
    branch = "".join(rng.choice("0123456789ABCDEFGHJKLMNPQRSTUVWXYZ") for _ in range(3))
    return f"{bank}{country}2L{branch}"


def _fx_routing(rng: random.Random, country: str) -> dict:
    """Local clearing coordinates shaped to the destination country's scheme."""
    _, routing_type = _FX_BANK_ROUTING.get(country, (None, "bic_swift"))
    account = "".join(rng.choice("0123456789") for _ in range(8))
    out: dict = {
        "account_number": account,
        "iban": None,
        "bic_swift": _fx_bic(rng, country),
        "routing_code_type_1": None,
        "routing_code_value_1": None,
        "bank_account_type": None,
    }
    if routing_type == "aba":
        out["routing_code_type_1"] = "aba"
        out["routing_code_value_1"] = "".join(rng.choice("0123456789") for _ in range(9))
        out["bank_account_type"] = rng.choice(("checking", "savings"))
    elif routing_type == "sort_code":
        out["routing_code_type_1"] = "sort_code"
        out["routing_code_value_1"] = "-".join(
            "".join(rng.choice("0123456789") for _ in range(2)) for _ in range(3))
    elif routing_type == "iban":
        check = f"{rng.randint(2, 98):02d}"
        body = "".join(rng.choice("0123456789") for _ in range(16))
        out["iban"] = f"{country}{check}{body}"
    elif routing_type == "ifsc":
        out["routing_code_type_1"] = "ifsc"
        bank = "".join(rng.choice("ABCDEFGHIJKLMNOPQRSTUVWXYZ") for _ in range(4))
        out["routing_code_value_1"] = f"{bank}0{rng.randint(100000, 999999)}"
    elif routing_type == "bsb_code":
        out["routing_code_type_1"] = "bsb_code"
        out["routing_code_value_1"] = "-".join(
            ("".join(rng.choice("0123456789") for _ in range(3)),
             "".join(rng.choice("0123456789") for _ in range(3))))
    elif routing_type == "clabe":
        out["account_number"] = "".join(rng.choice("0123456789") for _ in range(18))
    return out


def fx_beneficiary(seed: str, idx: int) -> dict:
    """A vendor settlement beneficiary with country-appropriate bank coordinates."""
    rng = _rng(seed, "beneficiary", idx)
    country = rng.choice(tuple(_FX_BANK_ROUTING))
    currency, _ = _FX_BANK_ROUTING[country]
    company = rng.random() > 0.3
    holder = _company(rng) if company else _person(rng)
    routing = _fx_routing(rng, country)
    payment_types = ["regular"]
    if country in ("US", "BR", "SG", "JP", "CA"):
        payment_types.append("priority")
    created = _CORDOBA_EPOCH - timedelta(days=rng.randint(20, 400))
    return {
        "id": str(uuid.UUID(int=rng.getrandbits(128), version=4)),
        "bank_account_holder_name": holder,
        "name": f"{holder} {currency} account",
        "beneficiary_entity_type": "company" if company else "individual",
        "beneficiary_company_name": holder if company else "",
        "beneficiary_first_name": "" if company else holder.split()[0],
        "beneficiary_last_name": "" if company else holder.split()[-1],
        "beneficiary_country": country,
        "beneficiary_address": [f"{rng.randint(1, 400)} {rng.choice(_ROOTS)} Street"],
        "beneficiary_city": rng.choice(("London", "Frankfurt", "Singapore", "Toronto",
                                        "Sao Paulo", "Tokyo", "Sydney", "Mumbai", "New York")),
        "currency": currency,
        "bank_country": country,
        "bank_name": f"{rng.choice(_ROOTS)} Bank",
        "account_number": routing["account_number"],
        "iban": routing["iban"],
        "bic_swift": routing["bic_swift"],
        "routing_code_type_1": routing["routing_code_type_1"],
        "routing_code_value_1": routing["routing_code_value_1"],
        "bank_account_type": routing["bank_account_type"],
        "payment_types": payment_types,
        "status": "enabled",
        "created_at": _fx_iso(created),
        "updated_at": _fx_iso(created),
    }


def _fx_short_ref(rng: random.Random, when: datetime) -> str:
    token = "".join(rng.choice("ABCDEFGHJKLMNPQRSTUVWXYZ0123456789") for _ in range(6))
    return f"{when:%Y%m%d}-{token}"


def cordoba_dataset(seed: str) -> dict[str, dict]:
    """Build a coherent FX book: per-currency balances, vendor beneficiaries, a
    history of conversions across the settlement lifecycle, and the cross-border
    payments those conversions funded — the trail a live FX platform would hold."""
    balances: dict[str, dict] = {}
    for currency in ("USD", "EUR", "GBP", "SGD", "BRL", "JPY"):
        rng = _rng(seed, "balance", currency)
        account_id = str(uuid.UUID(int=rng.getrandbits(128), version=4))
        amount = rng.uniform(40_000, 900_000) if currency != "JPY" else rng.uniform(3_000_000, 20_000_000)
        balances[currency] = {
            "id": str(uuid.UUID(int=rng.getrandbits(128), version=4)),
            "account_id": account_id,
            "currency": currency,
            "amount": fx_money(amount, currency),
            "created_at": _fx_iso(_CORDOBA_EPOCH - timedelta(days=400)),
            "updated_at": _fx_iso(_CORDOBA_EPOCH - timedelta(days=rng.randint(1, 20))),
        }

    beneficiaries: dict[str, dict] = {}
    for i in range(1, 25):
        ben = fx_beneficiary(seed, i)
        beneficiaries[ben["id"]] = ben
    beneficiary_list = list(beneficiaries.values())

    conversions: dict[str, dict] = {}
    payments: dict[str, dict] = {}
    sell_pool = ("USD", "USD", "USD", "GBP", "EUR")
    for i in range(1, 33):
        rng = _rng(seed, "conversion", i)
        ben = beneficiary_list[rng.randrange(len(beneficiary_list))]
        buy = ben["currency"]
        sell = rng.choice([s for s in sell_pool if s != buy] or ["USD"])
        booked = _CORDOBA_EPOCH - timedelta(days=rng.randint(1, 180))
        stage = rng.choices(range(4), weights=(1, 1, 1, 5))[0]
        status = _CONVERSION_FLOW[stage]
        buy_amount = rng.uniform(2_000, 250_000) if buy != "JPY" else rng.uniform(300_000, 9_000_000)
        client_rate = fx_client_rate(sell, buy)
        mid_rate = fx_mid_rate(sell, buy)
        sell_amount = buy_amount / client_rate
        settlement = booked + timedelta(days=2)
        conv = {
            "id": str(uuid.UUID(int=rng.getrandbits(128), version=4)),
            "short_reference": _fx_short_ref(rng, booked),
            "currency_pair": f"{buy}{sell}",
            "status": status,
            "buy_currency": buy,
            "sell_currency": sell,
            "client_buy_amount": fx_money(buy_amount, buy),
            "client_sell_amount": fx_money(sell_amount, sell),
            "fixed_side": "buy",
            "client_rate": fx_rate_str(client_rate),
            "mid_market_rate": fx_rate_str(mid_rate),
            "core_rate": fx_rate_str(client_rate),
            "settlement_date": _fx_iso(settlement),
            "conversion_date": _fx_iso(booked.replace(hour=0, minute=0, second=0)),
            "deposit_required": False,
            "deposit_amount": fx_money(0, sell),
            "deposit_currency": sell,
            "unique_request_id": None,
            "payment_ids": [],
            "created_at": _fx_iso(booked),
            "updated_at": _fx_iso(settlement if stage == 3 else booked),
        }
        conversions[conv["id"]] = conv

        if stage >= 2 and rng.random() < 0.8:
            prng = _rng(seed, "payment", i)
            priority = "priority" in ben["payment_types"] and prng.random() < 0.4
            pay_status = "completed" if stage == 3 else prng.choice(("submitted", "ready_to_send"))
            fee = 8.0 if priority else 0.0
            pay_date = settlement + timedelta(days=prng.randint(0, 2))
            payment = {
                "id": str(uuid.UUID(int=prng.getrandbits(128), version=4)),
                "short_reference": _fx_short_ref(prng, pay_date),
                "beneficiary_id": ben["id"],
                "conversion_id": conv["id"],
                "amount": conv["client_buy_amount"],
                "currency": buy,
                "status": pay_status,
                "payment_type": "priority" if priority else "regular",
                "charge_type": "shared",
                "reference": f"INV-{2026000 + i}",
                "reason": "vendor invoice settlement",
                "purpose_code": "GDDS",
                "payment_date": _fx_iso(pay_date.replace(hour=0, minute=0, second=0)),
                "payment_fee_amount": fx_money(fee, buy),
                "payment_fee_currency": buy,
                "transaction_id": str(uuid.UUID(int=prng.getrandbits(128), version=4)),
                "failure_reason": "",
                "created_at": _fx_iso(pay_date),
                "updated_at": _fx_iso(pay_date),
            }
            payments[payment["id"]] = payment
            conv["payment_ids"].append(payment["id"])

    settlement_accounts: dict[str, dict] = {}
    ssi = {
        "USD": ("Cordoba FX USD Settlement", "US", "CORDUS33XXX", None, "021000021"),
        "EUR": ("Cordoba FX EUR Settlement", "DE", "CORDDEFFXXX", "DE89370400440532013000", None),
        "GBP": ("Cordoba FX GBP Settlement", "GB", "CORDGB2LXXX", "GB29CORD60161331926819", "60-16-13"),
        "SGD": ("Cordoba FX SGD Settlement", "SG", "CORDSGSGXXX", None, None),
    }
    for currency, (holder, country, bic, iban, routing) in ssi.items():
        settlement_accounts[currency] = {
            "id": str(_rng(seed, "ssi", currency).getrandbits(48)),
            "currency": currency,
            "bank_account_holder_name": holder,
            "bank_name": "Cordoba FX Settlement Bank",
            "bank_country": country,
            "beneficiary_country": country,
            "bic_swift": bic,
            "iban": iban,
            "account_number": "".join(str((ord(c) % 10)) for c in currency * 3),
            "routing_code_type_1": "sort_code" if routing and "-" in routing else ("aba" if routing else None),
            "routing_code_value_1": routing,
        }

    return {
        "balances": balances,
        "beneficiaries": beneficiaries,
        "conversions": conversions,
        "payments": payments,
        "settlement_accounts": settlement_accounts,
    }


def index_by(records: list[dict], key: str = "id") -> dict[str, dict]:
    return {r[key]: r for r in records}
