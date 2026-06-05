"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Deterministic seeded data generators that build large, related, evolving entity sets for each provider without external dependencies.
"""
from __future__ import annotations

import hashlib
import random
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


def index_by(records: list[dict], key: str = "id") -> dict[str, dict]:
    return {r[key]: r for r in records}
