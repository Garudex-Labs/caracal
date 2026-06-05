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


_FX_INSTRUMENTS: tuple[tuple, ...] = (
    # (symbol, base, quote, description, realistic_mid, pip_size, lot_size, min_trade, liquidity_tier)
    ("USD/EUR", "USD", "EUR", "US Dollar / Euro",            0.9241, 0.0001, 100_000, 1_000, "tier1"),
    ("USD/GBP", "USD", "GBP", "US Dollar / British Pound",   0.7892, 0.0001, 100_000, 1_000, "tier1"),
    ("USD/JPY", "USD", "JPY", "US Dollar / Japanese Yen",  149.62,  0.01,   100_000, 1_000, "tier1"),
    ("USD/BRL", "USD", "BRL", "US Dollar / Brazilian Real",   4.972, 0.0001, 100_000, 5_000, "tier2"),
    ("USD/SGD", "USD", "SGD", "US Dollar / Singapore Dollar", 1.341, 0.0001, 100_000, 1_000, "tier2"),
    ("EUR/GBP", "EUR", "GBP", "Euro / British Pound",         0.854, 0.0001, 100_000, 1_000, "tier1"),
    ("EUR/JPY", "EUR", "JPY", "Euro / Japanese Yen",        161.53,  0.01,   100_000, 1_000, "tier1"),
    ("GBP/JPY", "GBP", "JPY", "British Pound / Japanese Yen", 189.1, 0.01,  100_000, 1_000, "tier2"),
    ("USD/CAD", "USD", "CAD", "US Dollar / Canadian Dollar",  1.362, 0.0001, 100_000, 1_000, "tier1"),
    ("EUR/CHF", "EUR", "CHF", "Euro / Swiss Franc",           0.968, 0.0001, 100_000, 1_000, "tier2"),
    ("AUD/USD", "AUD", "USD", "Australian Dollar / US Dollar", 0.646, 0.0001, 100_000, 1_000, "tier2"),
    ("NZD/USD", "NZD", "USD", "New Zealand Dollar / US Dollar", 0.601, 0.0001, 100_000, 1_000, "tier3"),
    ("USD/CHF", "USD", "CHF", "US Dollar / Swiss Franc",      0.895, 0.0001, 100_000, 1_000, "tier1"),
    ("EUR/USD", "EUR", "USD", "Euro / US Dollar",             1.082, 0.0001, 100_000, 1_000, "tier1"),
    ("GBP/USD", "GBP", "USD", "British Pound / US Dollar",   1.267, 0.0001, 100_000, 1_000, "tier1"),
)

_FX_VENUES: dict[str, str] = {
    "LDN": "London",
    "NYC": "New York",
    "SGP": "Singapore",
    "TKY": "Tokyo",
    "FRA": "Frankfurt",
    "SYD": "Sydney",
}

_TRADING_SESSIONS: dict[str, tuple[str, str]] = {
    "LDN": ("08:00", "17:00"),
    "NYC": ("13:00", "22:00"),
    "SGP": ("00:00", "09:00"),
    "TKY": ("00:00", "09:00"),
    "FRA": ("07:00", "15:30"),
    "SYD": ("22:00", "07:00"),
}


def instruments(seed: str) -> list[dict]:
    out = []
    for sym, base, quote, description, nominal_mid, pip_size, lot_size, min_trade, liq_tier in _FX_INSTRUMENTS:
        rng = _rng(seed, "instrument", sym)
        # Apply a small deterministic perturbation to the nominal mid so the
        # seeded price reflects live-ish variation without changing on every run.
        perturbation = rng.uniform(-0.012, 0.012)
        mid = round(nominal_mid * (1.0 + perturbation), 4 if pip_size == 0.0001 else 2)
        spread_bps = rng.randint(2, 18)
        venue_code = rng.choice(("LDN", "NYC", "SGP", "TKY", "FRA", "SYD"))
        # Derive a realistic day range centered on mid.
        day_range_pct = rng.uniform(0.003, 0.012)
        day_open = round(mid * (1.0 + rng.uniform(-day_range_pct / 2, day_range_pct / 2)),
                         4 if pip_size == 0.0001 else 2)
        day_low = round(min(mid, day_open) * (1.0 - rng.uniform(0.001, day_range_pct / 2)),
                        4 if pip_size == 0.0001 else 2)
        day_high = round(max(mid, day_open) * (1.0 + rng.uniform(0.001, day_range_pct / 2)),
                         4 if pip_size == 0.0001 else 2)
        prev_close = round(mid * (1.0 + rng.uniform(-day_range_pct, day_range_pct)),
                           4 if pip_size == 0.0001 else 2)
        session_open, session_close = _TRADING_SESSIONS[venue_code]
        out.append({
            "symbol": sym,
            "base": base,
            "quote": quote,
            "description": description,
            "type": "fx",
            "assetClass": "FX",
            "exchange": "OTC",
            "venue": venue_code,
            "venueName": _FX_VENUES[venue_code],
            "tradingHours": f"{session_open}-{session_close} UTC",
            "tradingDays": "Mon-Fri",
            "liquidityTier": liq_tier,
            "pipSize": pip_size,
            "lotSize": lot_size,
            "minTradeSize": min_trade,
            "mid": mid,
            "spreadBps": spread_bps,
            "dayOpen": day_open,
            "dayHigh": day_high,
            "dayLow": day_low,
            "prevClose": prev_close,
            "change": round(mid - prev_close, 4 if pip_size == 0.0001 else 2),
            "changePct": round((mid - prev_close) / prev_close * 100, 4),
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


# --------------------------------------------------------------------------- #
# Slate Ledger — general-ledger and financial-close platform, flavored after
# Sage Intacct, NetSuite, BlackLine, and FloQast. Accounts carry a normal
# balance; journals are double-entry with an entry type and source; periods
# follow a fiscal calendar with a soft/hard close; reconciliations match a
# statement against the GL the way a close platform does.
# --------------------------------------------------------------------------- #

# Chart of accounts: (number, name, type, subtype, normalBalance).
_SLATE_CHART = (
    ("1000", "Cash - Operating USD", "asset", "bank", "debit"),
    ("1010", "Cash - Operating EUR", "asset", "bank", "debit"),
    ("1020", "Cash - Payroll", "asset", "bank", "debit"),
    ("1100", "Accounts Receivable", "asset", "accounts_receivable", "debit"),
    ("1200", "Prepaid Expenses", "asset", "other_current_asset", "debit"),
    ("1210", "Prepaid Insurance", "asset", "other_current_asset", "debit"),
    ("1500", "Fixed Assets", "asset", "fixed_asset", "debit"),
    ("1510", "Accumulated Depreciation", "asset", "fixed_asset", "credit"),
    ("2000", "Accounts Payable", "liability", "accounts_payable", "credit"),
    ("2100", "Accrued Liabilities", "liability", "other_current_liability", "credit"),
    ("2110", "Accrued Payroll", "liability", "other_current_liability", "credit"),
    ("2200", "Sales Tax Payable", "liability", "other_current_liability", "credit"),
    ("2300", "Deferred Revenue", "liability", "other_current_liability", "credit"),
    ("3000", "Common Stock", "equity", "equity", "credit"),
    ("3900", "Retained Earnings", "equity", "equity", "credit"),
    ("4000", "Subscription Revenue", "income", "income", "credit"),
    ("4100", "Services Revenue", "income", "income", "credit"),
    ("5000", "Cost of Revenue", "expense", "cost_of_goods_sold", "debit"),
    ("6000", "Salaries & Wages", "expense", "expense", "debit"),
    ("6100", "Facilities & Rent", "expense", "expense", "debit"),
    ("6200", "Software Subscriptions", "expense", "expense", "debit"),
    ("6300", "Professional Fees", "expense", "expense", "debit"),
    ("6400", "Depreciation Expense", "expense", "expense", "debit"),
    ("6900", "Insurance Expense", "expense", "expense", "debit"),
)

# Recurring accrual templates a close team carries period to period.
_SLATE_ACCRUAL_TEMPLATES = (
    ("Cloud infrastructure", "6200", "2100"),
    ("External audit fees", "6300", "2100"),
    ("Annual insurance", "6900", "1210"),
    ("Bonus accrual", "6000", "2110"),
)

# Standard close checklist, mirroring a FloQast/BlackLine task list.
_SLATE_CLOSE_TASKS = (
    "Post recurring accruals",
    "Reconcile cash accounts",
    "Reconcile accounts payable",
    "Review trial balance",
    "Sub-ledger cutoff",
)


def _slate_period_id(d: date) -> str:
    return d.strftime("%Y-%m")


def slate_dataset(seed: str) -> dict[str, dict]:
    """Build a coherent general ledger: a chart of accounts with running
    balances, posted double-entry journals across a fiscal calendar, monthly
    periods with a close checklist, reconciliations with matched and
    outstanding items, and recurring accrual schedules."""
    accounts: dict[str, dict] = {}
    for number, name, acct_type, subtype, normal in _SLATE_CHART:
        accounts[number] = {
            "accountId": number,
            "accountNo": number,
            "name": name,
            "type": acct_type,
            "subtype": subtype,
            "normalBalance": normal,
            "currency": "EUR" if number == "1010" else "USD",
            "status": "active",
            "isControlAccount": number in ("1100", "2000"),
            "balance": 0.0,
        }

    expense_accounts = [n for n, _, t, _, _ in _SLATE_CHART if t == "expense"]
    revenue_accounts = [n for n, _, t, _, _ in _SLATE_CHART if t == "income"]

    periods: dict[str, dict] = {}
    month_first_days = [date(2025, 11, 1), date(2025, 12, 1)] + [
        date(2026, m, 1) for m in range(1, 13)
    ]
    for first in month_first_days:
        pid = _slate_period_id(first)
        closed = first.year == 2025
        periods[pid] = {
            "periodId": pid,
            "name": first.strftime("%B %Y"),
            "fiscalYear": first.year,
            "startDate": first.isoformat(),
            "status": "closed" if closed else "open",
            "checklist": [
                {"task": t, "status": "complete" if closed else "pending", "owner": "Finance"}
                for t in _SLATE_CLOSE_TASKS
            ],
            "closedAt": _instant(_rng(seed, "close", pid), -40, -30) if closed else None,
            "closedBy": "controller@slate-ledger.test" if closed else None,
        }

    entries: dict[str, dict] = {}
    seq = 0

    def _post(rng: random.Random, period_id: str, entry_type: str, source: str,
              description: str, raw_lines: list[tuple[str, float, float]]) -> dict:
        nonlocal seq
        seq += 1
        lines = []
        total_debit = total_credit = 0.0
        for ln, (acct, debit, credit) in enumerate(raw_lines, start=1):
            debit = round(debit, 2)
            credit = round(credit, 2)
            total_debit += debit
            total_credit += credit
            lines.append({
                "lineNo": ln, "accountNo": acct, "accountName": accounts[acct]["name"],
                "debit": debit, "credit": credit,
                "department": rng.choice(_DEPARTMENTS),
                "memo": description,
            })
            normal = accounts[acct]["normalBalance"]
            delta = (debit - credit) if normal == "debit" else (credit - debit)
            accounts[acct]["balance"] = round(accounts[acct]["balance"] + delta, 2)
        jid = f"JE-{period_id.replace('-', '')}-{seq:04d}"
        entry = {
            "journalId": jid,
            "entryNo": f"GL{seq:06d}",
            "type": entry_type,
            "source": source,
            "period": period_id,
            "currency": "USD",
            "description": description,
            "reference": f"REF-{rng.randint(10000, 99999)}",
            "lines": lines,
            "totalDebit": round(total_debit, 2),
            "totalCredit": round(total_credit, 2),
            "status": "posted",
            "reversalOf": None,
            "reversedBy": None,
            "postedBy": "gl-bot@slate-ledger.test",
            "postedAt": _instant(rng, -120, -1),
        }
        entries[jid] = entry
        return entry

    posted_periods = [p for p in periods if periods[p]["status"] == "open"][:3] or list(periods)[:3]
    for pid in posted_periods:
        rng = _rng(seed, "journals", pid)
        for _ in range(rng.randint(6, 9)):
            amount = round(rng.uniform(2_500, 180_000), 2)
            kind = rng.random()
            if kind < 0.45:
                expense = rng.choice(expense_accounts)
                _post(rng, pid, "standard", "subledger", "Vendor expense recognition",
                      [(expense, amount, 0.0), ("2000", 0.0, amount)])
            elif kind < 0.75:
                revenue = rng.choice(revenue_accounts)
                _post(rng, pid, "standard", "subledger", "Customer billing",
                      [("1100", amount, 0.0), (revenue, 0.0, amount)])
            elif kind < 0.9:
                expense = rng.choice(expense_accounts)
                _post(rng, pid, "accrual", "recurring", "Month-end accrual",
                      [(expense, amount, 0.0), ("2100", 0.0, amount)])
            else:
                _post(rng, pid, "adjustment", "manual", "Reclassification adjustment",
                      [("6300", amount, 0.0), ("6200", 0.0, amount)])

    reconciliations: dict[str, dict] = {}
    recon_targets = (("1000", 0.0), ("1010", 0.0), ("1020", 142.50), ("2000", 0.0))
    for idx, (acct, residual) in enumerate(recon_targets, start=1):
        rng = _rng(seed, "recon", acct)
        gl_balance = accounts[acct]["balance"]
        statement_balance = round(gl_balance + residual, 2)
        outstanding = []
        if residual:
            outstanding.append({
                "itemId": f"OS-{idx:03d}", "type": "deposit_in_transit",
                "amount": residual, "memo": "Late deposit not yet on statement",
            })
        rid = f"REC-2026-{idx:04d}"
        reconciliations[rid] = {
            "reconciliationId": rid,
            "accountNo": acct,
            "accountName": accounts[acct]["name"],
            "period": posted_periods[0],
            "glBalance": gl_balance,
            "statementBalance": statement_balance,
            "outstandingItems": outstanding,
            "outstandingTotal": round(residual, 2),
            "adjustedBalance": round(statement_balance - residual, 2),
            "difference": round(statement_balance - residual - gl_balance, 2),
            "status": "balanced" if not residual else "exception",
            "preparedBy": "staff-accountant@slate-ledger.test",
            "reconciledAt": _instant(rng, -20, -2),
        }

    accruals: dict[str, dict] = {}
    for idx, (name, expense_acct, liability_acct) in enumerate(_SLATE_ACCRUAL_TEMPLATES, start=1):
        rng = _rng(seed, "accrual", name)
        total = round(rng.uniform(24_000, 180_000), 2)
        periods_count = rng.choice((3, 6, 12))
        aid = f"ACR-2026-{idx:04d}"
        accruals[aid] = {
            "accrualId": aid,
            "description": name,
            "expenseAccount": expense_acct,
            "liabilityAccount": liability_acct,
            "totalAmount": total,
            "periods": periods_count,
            "perPeriod": round(total / periods_count, 2),
            "postedPeriods": rng.randint(0, periods_count - 1),
            "currency": "USD",
            "status": "active",
            "createdAt": _instant(rng, -90, -40),
        }

    return {
        "accounts": accounts,
        "entries": entries,
        "periods": periods,
        "reconciliations": reconciliations,
        "accruals": accruals,
    }


# --------------------------------------------------------------------------- #
# Tallyhall Books — SMB accounting modeled on QuickBooks Online. Entities carry
# QBO wire shapes: numeric string Id, SyncToken, MetaData, *Ref{value,name}
# pointers, Line[] with DetailType, TotalAmt/Balance money, and a realmId company
# file. Money is the home currency unless a transaction carries its own
# CurrencyRef, mirroring QBO multicurrency company files.
# --------------------------------------------------------------------------- #
_QBO_REALM = "9341734250293847"
_QBO_HOME_CCY = "USD"
_QBO_CCY_NAME = {
    "USD": "United States Dollar", "GBP": "British Pound Sterling", "EUR": "Euro",
    "BRL": "Brazilian Real", "SGD": "Singapore Dollar", "JPY": "Japanese Yen",
    "CAD": "Canadian Dollar",
}
_QBO_TERMS = {"NET15": ("Net 15", 15), "NET30": ("Net 30", 30),
              "NET45": ("Net 45", 45), "NET60": ("Net 60", 60)}
_QBO_CHART = (
    ("1000", "Checking", "Bank", "Checking", "Asset"),
    ("1010", "Savings", "Bank", "Savings", "Asset"),
    ("1200", "Accounts Receivable (A/R)", "Accounts Receivable", "AccountsReceivable", "Asset"),
    ("1300", "Undeposited Funds", "Other Current Asset", "UndepositedFunds", "Asset"),
    ("1400", "Inventory Asset", "Other Current Asset", "Inventory", "Asset"),
    ("1500", "Prepaid Expenses", "Other Current Asset", "PrepaidExpenses", "Asset"),
    ("1700", "Furniture & Equipment", "Fixed Asset", "FurnitureAndFixtures", "Asset"),
    ("2000", "Accounts Payable (A/P)", "Accounts Payable", "AccountsPayable", "Liability"),
    ("2100", "Mastercard", "Credit Card", "CreditCard", "Liability"),
    ("2200", "Sales Tax Payable", "Other Current Liability", "SalesTaxPayable", "Liability"),
    ("3000", "Opening Balance Equity", "Equity", "OpeningBalanceEquity", "Equity"),
    ("3900", "Retained Earnings", "Equity", "RetainedEarnings", "Equity"),
    ("4000", "Sales of Product Income", "Income", "SalesOfProductIncome", "Revenue"),
    ("4100", "Services", "Income", "ServiceFeeIncome", "Revenue"),
    ("5000", "Cost of Goods Sold", "Cost of Goods Sold", "SuppliesMaterialsCogs", "Expense"),
    ("6000", "Advertising & Marketing", "Expense", "AdvertisingPromotional", "Expense"),
    ("6100", "Rent & Lease", "Expense", "RentOrLeaseOfBuildings", "Expense"),
    ("6200", "Office Supplies & Software", "Expense", "OfficeGeneralAdministrativeExpenses", "Expense"),
    ("6300", "Legal & Professional Fees", "Expense", "LegalProfessionalFees", "Expense"),
    ("6400", "Utilities", "Expense", "Utilities", "Expense"),
    ("6500", "Travel", "Expense", "Travel", "Expense"),
)
_QBO_EXPENSE_ACCTS = ("5000", "6000", "6100", "6200", "6300", "6400", "6500")
_QBO_ITEMS = (
    ("Bookkeeping", "Service", "4100", 75.0),
    ("Advisory Hours", "Service", "4100", 180.0),
    ("Payroll Run", "Service", "4100", 45.0),
    ("Tax Filing", "Service", "4100", 350.0),
    ("Software Seat", "Service", "4000", 28.0),
    ("Onboarding Package", "Service", "4000", 1200.0),
    ("Hardware Kit", "Inventory", "4000", 640.0),
    ("Support Plan", "Service", "4000", 99.0),
)
_QBO_PAY_METHODS = ("Cash", "Check", "Credit Card")


def _qbo_money(currency: str) -> str:
    return "0" if currency == "JPY" else "2"


def _qbo_round(amount: float, currency: str) -> float:
    return float(round(amount)) if currency == "JPY" else round(amount, 2)


def _ccy_ref(currency: str) -> dict:
    return {"value": currency, "name": _QBO_CCY_NAME.get(currency, currency)}


def _qbo_meta(rng: random.Random, lo: int, hi: int) -> dict:
    created = _instant(rng, lo, hi)
    return {"CreateTime": created, "LastUpdatedTime": created}


def _qbo_addr(rng: random.Random, country: str, idx: int) -> dict:
    return {
        "Line1": f"{rng.randint(50, 9900)} {rng.choice(_ROOTS)} {rng.choice(('Ave', 'St', 'Blvd', 'Way'))}",
        "City": _CITY_BY_COUNTRY.get(country, "Austin"),
        "CountrySubDivisionCode": rng.choice(("TX", "CA", "NY", "WA", "IL")),
        "PostalCode": f"{rng.randint(10_000, 99_999)}",
        "Country": country,
        "Id": str(idx),
    }


def _qbo_account(idx: int, row: tuple, rng: random.Random) -> dict:
    number, name, acct_type, sub_type, classification = row
    return {
        "Id": str(idx),
        "Name": name,
        "AcctNum": number,
        "FullyQualifiedName": name,
        "Active": True,
        "Classification": classification,
        "AccountType": acct_type,
        "AccountSubType": sub_type,
        "CurrentBalance": 0.0,
        "CurrentBalanceWithSubAccounts": 0.0,
        "CurrencyRef": _ccy_ref(_QBO_HOME_CCY),
        "SubAccount": False,
        "domain": "QBO",
        "sparse": False,
        "SyncToken": "0",
        "MetaData": _qbo_meta(rng, -1460, -900),
    }


def _qbo_vendor(seed: str, i: int) -> dict:
    rng = _rng(seed, "qbo_vendor", i)
    name = _company(rng)
    country, currency = rng.choice(_COUNTRIES)
    term = rng.choice(_TERMS)
    active = rng.random() > 0.1
    return {
        "Id": str(i),
        "DisplayName": name,
        "CompanyName": name,
        "PrintOnCheckName": name,
        "Active": active,
        "V4IDPseudonym": f"00203{rng.randint(10**7, 10**8 - 1)}",
        "Vendor1099": currency == "USD" and rng.random() > 0.6,
        "Balance": 0.0,
        "AcctNum": f"V-{1000 + i}",
        "TaxIdentifier": f"{country}{rng.randint(10**8, 10**9 - 1)}",
        "PrimaryEmailAddr": {"Address": f"ap@{_slug(name).split('-')[0]}.example"},
        "PrimaryPhone": {"FreeFormNumber": f"+1 ({rng.randint(200, 989)}) {rng.randint(200, 999)}-{rng.randint(1000, 9999)}"},
        "WebAddr": {"URI": f"https://{_slug(name).split('-')[0]}.example"},
        "BillAddr": _qbo_addr(rng, country, i),
        "TermRef": {"value": str(_TERMS.index(term) + 1), "name": _QBO_TERMS[term][0]},
        "CurrencyRef": _ccy_ref(currency),
        "domain": "QBO",
        "sparse": False,
        "SyncToken": "0",
        "MetaData": _qbo_meta(rng, -540, -60),
    }


def _qbo_customer(seed: str, i: int) -> dict:
    rng = _rng(seed, "qbo_customer", i)
    name = _company(rng)
    country, currency = rng.choice(_COUNTRIES)
    person = _person(rng)
    given, family = person.split()
    active = rng.random() > 0.08
    return {
        "Id": str(i),
        "DisplayName": name,
        "CompanyName": name,
        "GivenName": given,
        "FamilyName": family,
        "FullyQualifiedName": name,
        "Active": active,
        "Taxable": currency == "USD",
        "Balance": 0.0,
        "BalanceWithJobs": 0.0,
        "PrimaryEmailAddr": {"Address": f"{given.lower()}@{_slug(name).split('-')[0]}.example"},
        "PrimaryPhone": {"FreeFormNumber": f"+1 ({rng.randint(200, 989)}) {rng.randint(200, 999)}-{rng.randint(1000, 9999)}"},
        "BillAddr": _qbo_addr(rng, country, i),
        "ShipAddr": _qbo_addr(rng, country, i + 500),
        "PreferredDeliveryMethod": rng.choice(("Email", "Print", "None")),
        "CurrencyRef": _ccy_ref(currency),
        "domain": "QBO",
        "sparse": False,
        "SyncToken": "0",
        "MetaData": _qbo_meta(rng, -500, -30),
    }


def _qbo_item(idx: int, row: tuple, acct_by_num: dict, rng: random.Random) -> dict:
    name, kind, income_num, price = row
    income = acct_by_num[income_num]
    item = {
        "Id": str(idx),
        "Name": name,
        "FullyQualifiedName": name,
        "Active": True,
        "Type": kind,
        "UnitPrice": price,
        "Taxable": True,
        "IncomeAccountRef": {"value": income["Id"], "name": income["Name"]},
        "domain": "QBO",
        "sparse": False,
        "SyncToken": "0",
        "MetaData": _qbo_meta(rng, -700, -200),
    }
    if kind == "Inventory":
        item["TrackQtyOnHand"] = True
        item["QtyOnHand"] = rng.randint(5, 200)
        item["AssetAccountRef"] = {"value": acct_by_num["1400"]["Id"], "name": acct_by_num["1400"]["Name"]}
        item["ExpenseAccountRef"] = {"value": acct_by_num["5000"]["Id"], "name": acct_by_num["5000"]["Name"]}
    return item


def _qbo_bill(seed: str, idx: int, vendor: dict, acct_by_num: dict) -> dict:
    rng = _rng(seed, "qbo_bill", idx)
    currency = vendor["CurrencyRef"]["value"]
    ap = acct_by_num["2000"]
    term = next((t for t in _TERMS if _QBO_TERMS[t][0] == vendor["TermRef"]["name"]), "NET30")
    issued = _EPOCH + timedelta(days=rng.randint(-150, -3))
    due = issued + timedelta(days=_QBO_TERMS[term][1])
    n_lines = rng.randint(1, 3)
    lines, subtotal = [], 0.0
    for ln in range(1, n_lines + 1):
        acct = acct_by_num[rng.choice(_QBO_EXPENSE_ACCTS)]
        amount = _qbo_round(rng.uniform(120, 14_000), currency)
        subtotal += amount
        lines.append({
            "Id": str(ln),
            "Description": f"{acct['Name']} — {vendor['DisplayName']}",
            "Amount": amount,
            "DetailType": "AccountBasedExpenseLineDetail",
            "AccountBasedExpenseLineDetail": {
                "AccountRef": {"value": acct["Id"], "name": acct["Name"]},
                "BillableStatus": "NotBillable",
                "TaxCodeRef": {"value": "NON"},
            },
        })
    total = _qbo_round(subtotal, currency)
    paid = rng.random() > 0.55
    bill = {
        "Id": str(1000 + idx),
        "DocNumber": f"{vendor['DisplayName'][:3].upper()}-{rng.randint(1000, 9999)}",
        "VendorRef": {"value": vendor["Id"], "name": vendor["DisplayName"]},
        "APAccountRef": {"value": ap["Id"], "name": ap["Name"]},
        "SalesTermRef": {"value": str(_TERMS.index(term) + 1), "name": _QBO_TERMS[term][0]},
        "TxnDate": issued.isoformat(),
        "DueDate": due.isoformat(),
        "CurrencyRef": _ccy_ref(currency),
        "Line": lines,
        "TotalAmt": total,
        "Balance": 0.0 if paid else total,
        "PrivateNote": "",
        "LinkedTxn": [],
        "domain": "QBO",
        "sparse": False,
        "SyncToken": "0",
        "MetaData": _qbo_meta(rng, -150, -3),
    }
    if currency != _QBO_HOME_CCY:
        bill["ExchangeRate"] = round(rng.uniform(0.65, 1.45), 6)
    return bill


def _qbo_invoice(seed: str, idx: int, customer: dict, items: list[dict], acct_by_num: dict) -> dict:
    rng = _rng(seed, "qbo_invoice", idx)
    currency = customer["CurrencyRef"]["value"]
    ar = acct_by_num["1200"]
    issued = _EPOCH + timedelta(days=rng.randint(-120, -2))
    due = issued + timedelta(days=rng.choice((15, 30, 30, 45)))
    n_lines = rng.randint(1, 3)
    lines, subtotal = [], 0.0
    for ln in range(1, n_lines + 1):
        item = rng.choice(items)
        qty = rng.randint(1, 12)
        rate = _qbo_round(item["UnitPrice"] * rng.uniform(0.9, 1.2), currency)
        amount = _qbo_round(qty * rate, currency)
        subtotal += amount
        lines.append({
            "Id": str(ln),
            "LineNum": ln,
            "Description": item["Name"],
            "Amount": amount,
            "DetailType": "SalesItemLineDetail",
            "SalesItemLineDetail": {
                "ItemRef": {"value": item["Id"], "name": item["Name"]},
                "Qty": qty,
                "UnitPrice": rate,
                "TaxCodeRef": {"value": "TAX" if customer["Taxable"] else "NON"},
            },
        })
    tax = _qbo_round(subtotal * (0.0825 if customer["Taxable"] else 0.0), currency)
    total = _qbo_round(subtotal + tax, currency)
    roll = rng.random()
    paid = roll > 0.5
    partial = not paid and roll > 0.3
    balance = 0.0 if paid else (_qbo_round(total * 0.5, currency) if partial else total)
    summary_line = {
        "Amount": _qbo_round(subtotal, currency),
        "DetailType": "SubTotalLineDetail",
        "SubTotalLineDetail": {},
    }
    invoice = {
        "Id": str(2000 + idx),
        "DocNumber": f"INV-{1000 + idx}",
        "CustomerRef": {"value": customer["Id"], "name": customer["DisplayName"]},
        "ARAccountRef": {"value": ar["Id"], "name": ar["Name"]},
        "TxnDate": issued.isoformat(),
        "DueDate": due.isoformat(),
        "CurrencyRef": _ccy_ref(currency),
        "Line": lines + [summary_line],
        "TxnTaxDetail": {"TotalTax": tax},
        "TotalAmt": total,
        "Balance": balance,
        "HomeBalance": balance if currency == _QBO_HOME_CCY else _qbo_round(balance * 1.0, _QBO_HOME_CCY),
        "EmailStatus": "EmailSent" if rng.random() > 0.3 else "NeedToSend",
        "BillEmail": customer["PrimaryEmailAddr"],
        "AllowOnlineCreditCardPayment": True,
        "PrivateNote": "",
        "LinkedTxn": [],
        "domain": "QBO",
        "sparse": False,
        "SyncToken": "0",
        "MetaData": _qbo_meta(rng, -120, -2),
    }
    if currency != _QBO_HOME_CCY:
        invoice["ExchangeRate"] = round(rng.uniform(0.65, 1.45), 6)
    return invoice


def _qbo_expense(seed: str, idx: int, vendor: dict, acct_by_num: dict) -> dict:
    rng = _rng(seed, "qbo_expense", idx)
    currency = vendor["CurrencyRef"]["value"]
    pay_type = rng.choice(("Cash", "Check", "CreditCard"))
    funding = acct_by_num["2100"] if pay_type == "CreditCard" else acct_by_num["1000"]
    acct = acct_by_num[rng.choice(_QBO_EXPENSE_ACCTS)]
    amount = _qbo_round(rng.uniform(30, 4_500), currency)
    issued = _EPOCH + timedelta(days=rng.randint(-90, -1))
    return {
        "Id": str(3000 + idx),
        "PaymentType": pay_type,
        "DocNumber": f"EXP-{1000 + idx}",
        "AccountRef": {"value": funding["Id"], "name": funding["Name"]},
        "EntityRef": {"value": vendor["Id"], "name": vendor["DisplayName"], "type": "Vendor"},
        "TxnDate": issued.isoformat(),
        "CurrencyRef": _ccy_ref(currency),
        "TotalAmt": amount,
        "Credit": False,
        "Line": [{
            "Id": "1",
            "Amount": amount,
            "Description": f"{acct['Name']} — {vendor['DisplayName']}",
            "DetailType": "AccountBasedExpenseLineDetail",
            "AccountBasedExpenseLineDetail": {
                "AccountRef": {"value": acct["Id"], "name": acct["Name"]},
                "BillableStatus": "NotBillable",
                "TaxCodeRef": {"value": "NON"},
            },
        }],
        "domain": "QBO",
        "sparse": False,
        "SyncToken": "0",
        "MetaData": _qbo_meta(rng, -90, -1),
    }


def _qbo_journal(seed: str, idx: int, acct_by_num: dict) -> dict:
    rng = _rng(seed, "qbo_journal", idx)
    debit_acct = acct_by_num[rng.choice(_QBO_EXPENSE_ACCTS)]
    credit_acct = acct_by_num[rng.choice(("1000", "2100", "2200"))]
    amount = _qbo_round(rng.uniform(200, 9_000), _QBO_HOME_CCY)
    issued = _EPOCH + timedelta(days=rng.randint(-100, -1))
    return {
        "Id": str(4000 + idx),
        "DocNumber": f"JE-{1000 + idx}",
        "TxnDate": issued.isoformat(),
        "Adjustment": rng.random() > 0.8,
        "CurrencyRef": _ccy_ref(_QBO_HOME_CCY),
        "Line": [
            {"Id": "0", "Description": "Accrual", "Amount": amount,
             "DetailType": "JournalEntryLineDetail",
             "JournalEntryLineDetail": {"PostingType": "Debit",
                                        "AccountRef": {"value": debit_acct["Id"], "name": debit_acct["Name"]}}},
            {"Id": "1", "Description": "Accrual", "Amount": amount,
             "DetailType": "JournalEntryLineDetail",
             "JournalEntryLineDetail": {"PostingType": "Credit",
                                        "AccountRef": {"value": credit_acct["Id"], "name": credit_acct["Name"]}}},
        ],
        "TotalAmt": amount,
        "domain": "QBO",
        "sparse": False,
        "SyncToken": "0",
        "MetaData": _qbo_meta(rng, -100, -1),
    }


def quickbooks_company(seed: str) -> dict:
    """The QBO CompanyInfo entity describing the connected company file."""
    rng = _rng(seed, "qbo_company")
    return {
        "Id": "1",
        "CompanyName": "LynxCapital Retail LLC",
        "LegalName": "LynxCapital Retail, LLC",
        "CompanyAddr": _qbo_addr(rng, "US", 1),
        "CustomerCommunicationAddr": _qbo_addr(rng, "US", 1),
        "LegalAddr": _qbo_addr(rng, "US", 1),
        "Country": "US",
        "Email": {"Address": "books@lynxcapital.example"},
        "WebAddr": {"URI": "https://lynxcapital.example"},
        "SupportedLanguages": "en",
        "FiscalYearStartMonth": "January",
        "CompanyStartDate": (_EPOCH - timedelta(days=1825)).isoformat(),
        "MultiCurrencyEnabled": True,
        "HomeCurrency": _ccy_ref(_QBO_HOME_CCY),
        "realmId": _QBO_REALM,
        "domain": "QBO",
        "sparse": False,
        "SyncToken": "4",
        "MetaData": _qbo_meta(rng, -1825, -1800),
    }


def quickbooks_dataset(seed: str) -> dict[str, dict]:
    """Build a coherent QuickBooks Online company file: chart of accounts, vendor
    and customer lists, items, vendor bills and customer invoices (some open, some
    paid), cash expenses, posted journal entries, and the payments that link them —
    with the A/P, A/R, and bank control accounts rolled up the way QBO keeps them."""
    accounts = {}
    acct_by_num = {}
    for idx, row in enumerate(_QBO_CHART, start=1):
        rng = _rng(seed, "qbo_account", idx)
        acct = _qbo_account(idx, row, rng)
        accounts[acct["Id"]] = acct
        acct_by_num[acct["AcctNum"]] = acct

    vendors = {v["Id"]: v for v in (_qbo_vendor(seed, i) for i in range(1, 61))}
    customers = {c["Id"]: c for c in (_qbo_customer(seed, i) for i in range(1, 41))}
    items = [_qbo_item(i, row, acct_by_num, _rng(seed, "qbo_item", i))
             for i, row in enumerate(_QBO_ITEMS, start=1)]
    item_index = {it["Id"]: it for it in items}

    active_vendors = [v for v in vendors.values() if v["Active"]]
    active_customers = [c for c in customers.values() if c["Active"]]

    bills = {}
    for idx in range(1, 51):
        vendor = active_vendors[_rng(seed, "qbo_bill_pick", idx).randrange(len(active_vendors))]
        bill = _qbo_bill(seed, idx, vendor, acct_by_num)
        bills[bill["Id"]] = bill

    invoices = {}
    for idx in range(1, 51):
        customer = active_customers[_rng(seed, "qbo_inv_pick", idx).randrange(len(active_customers))]
        invoice = _qbo_invoice(seed, idx, customer, items, acct_by_num)
        invoices[invoice["Id"]] = invoice

    expenses = {}
    for idx in range(1, 31):
        vendor = active_vendors[_rng(seed, "qbo_exp_pick", idx).randrange(len(active_vendors))]
        expense = _qbo_expense(seed, idx, vendor, acct_by_num)
        expenses[expense["Id"]] = expense

    journal_entries = {je["Id"]: je for je in (_qbo_journal(seed, i, acct_by_num)
                                               for i in range(1, 21))}

    payments, bill_payments = _qbo_seed_payments(seed, bills, invoices, vendors,
                                                 customers, acct_by_num)

    _qbo_roll_balances(accounts, acct_by_num, vendors, customers, bills, invoices, expenses)

    return {
        "company": {"1": quickbooks_company(seed)},
        "accounts": accounts,
        "vendors": vendors,
        "customers": customers,
        "items": item_index,
        "bills": bills,
        "invoices": invoices,
        "expenses": expenses,
        "journal_entries": journal_entries,
        "payments": payments,
        "bill_payments": bill_payments,
    }


def _qbo_seed_payments(seed, bills, invoices, vendors, customers, acct_by_num):
    """Create the BillPayment and customer Payment records that settle the seeded
    paid bills and invoices, and wire their LinkedTxn pointers both ways."""
    payments, bill_payments = {}, {}
    bank = acct_by_num["1000"]
    undeposited = acct_by_num["1300"]
    pid = bpid = 0
    for bill in bills.values():
        if bill["Balance"] == 0.0:
            bpid += 1
            currency = bill["CurrencyRef"]["value"]
            bp = {
                "Id": str(6000 + bpid),
                "VendorRef": bill["VendorRef"],
                "PayType": "Check",
                "TxnDate": bill["DueDate"],
                "CurrencyRef": _ccy_ref(currency),
                "TotalAmt": bill["TotalAmt"],
                "CheckPayment": {"BankAccountRef": {"value": bank["Id"], "name": bank["Name"]}},
                "Line": [{"Amount": bill["TotalAmt"],
                          "LinkedTxn": [{"TxnId": bill["Id"], "TxnType": "Bill"}]}],
                "domain": "QBO", "sparse": False, "SyncToken": "0",
                "MetaData": {"CreateTime": bill["DueDate"] + "T17:00:00Z",
                             "LastUpdatedTime": bill["DueDate"] + "T17:00:00Z"},
            }
            bill_payments[bp["Id"]] = bp
            bill["LinkedTxn"] = [{"TxnId": bp["Id"], "TxnType": "BillPayment"}]
    for inv in invoices.values():
        applied = inv["TotalAmt"] - inv["Balance"]
        if applied > 0:
            pid += 1
            currency = inv["CurrencyRef"]["value"]
            pay = {
                "Id": str(5000 + pid),
                "CustomerRef": inv["CustomerRef"],
                "TxnDate": inv["DueDate"],
                "CurrencyRef": _ccy_ref(currency),
                "TotalAmt": _qbo_round(applied, currency),
                "UnappliedAmt": 0.0,
                "DepositToAccountRef": {"value": undeposited["Id"], "name": undeposited["Name"]},
                "Line": [{"Amount": _qbo_round(applied, currency),
                          "LinkedTxn": [{"TxnId": inv["Id"], "TxnType": "Invoice"}]}],
                "domain": "QBO", "sparse": False, "SyncToken": "0",
                "MetaData": {"CreateTime": inv["DueDate"] + "T12:00:00Z",
                             "LastUpdatedTime": inv["DueDate"] + "T12:00:00Z"},
            }
            payments[pay["Id"]] = pay
            inv["LinkedTxn"] = [{"TxnId": pay["Id"], "TxnType": "Payment"}]
    return payments, bill_payments


def _qbo_roll_balances(accounts, acct_by_num, vendors, customers, bills, invoices, expenses):
    """Roll open bills into vendor balances and the A/P control account, open
    invoices into customer balances and A/R, and post seeded activity to the bank,
    income, and expense accounts so the trial balance and reports reconcile."""
    ap = acct_by_num["2000"]["Id"]
    ar = acct_by_num["1200"]["Id"]
    bank = acct_by_num["1000"]["Id"]
    cc = acct_by_num["2100"]["Id"]

    for bill in bills.values():
        if bill["Balance"] > 0:
            vendors[bill["VendorRef"]["value"]]["Balance"] = round(
                vendors[bill["VendorRef"]["value"]]["Balance"] + bill["Balance"], 2)
            accounts[ap]["CurrentBalance"] = round(accounts[ap]["CurrentBalance"] + bill["Balance"], 2)
        for line in bill["Line"]:
            detail = line.get("AccountBasedExpenseLineDetail")
            if detail:
                acct_id = detail["AccountRef"]["value"]
                accounts[acct_id]["CurrentBalance"] = round(
                    accounts[acct_id]["CurrentBalance"] + line["Amount"], 2)

    for inv in invoices.values():
        if inv["Balance"] > 0:
            customers[inv["CustomerRef"]["value"]]["Balance"] = round(
                customers[inv["CustomerRef"]["value"]]["Balance"] + inv["Balance"], 2)
            customers[inv["CustomerRef"]["value"]]["BalanceWithJobs"] = customers[inv["CustomerRef"]["value"]]["Balance"]
            accounts[ar]["CurrentBalance"] = round(accounts[ar]["CurrentBalance"] + inv["Balance"], 2)
        income = acct_by_num["4000"]["Id"]
        for line in inv["Line"]:
            if line.get("DetailType") == "SalesItemLineDetail":
                accounts[income]["CurrentBalance"] = round(
                    accounts[income]["CurrentBalance"] + line["Amount"], 2)

    for expense in expenses.values():
        funding = expense["AccountRef"]["value"]
        accounts[funding]["CurrentBalance"] = round(accounts[funding]["CurrentBalance"] - expense["TotalAmt"], 2)
        for line in expense["Line"]:
            detail = line.get("AccountBasedExpenseLineDetail")
            if detail:
                acct_id = detail["AccountRef"]["value"]
                accounts[acct_id]["CurrentBalance"] = round(
                    accounts[acct_id]["CurrentBalance"] + line["Amount"], 2)

    accounts[bank]["CurrentBalance"] = round(accounts[bank]["CurrentBalance"] + 1_250_000.0, 2)
    accounts[cc]["CurrentBalance"] = round(accounts[cc]["CurrentBalance"] + 38_500.0, 2)
    for acct in accounts.values():
        acct["CurrentBalanceWithSubAccounts"] = acct["CurrentBalance"]


# --------------------------------------------------------------------------- #
# Inkwell OCR — document AI / invoice capture
# --------------------------------------------------------------------------- #
_INKWELL_ENGINE = "inkwell-vision-3"
_INKWELL_API_VERSION = "2026-02-01"
_INKWELL_REVIEW_THRESHOLD = 0.85
_INKWELL_FIELD_THRESHOLD = 0.70

# Image and document types a real capture engine ingests, mapped to the MIME a
# client would send. A name without a known extension is treated as a sniffed PDF.
_INKWELL_MIME = {
    "pdf": "application/pdf", "png": "image/png", "jpg": "image/jpeg",
    "jpeg": "image/jpeg", "tif": "image/tiff", "tiff": "image/tiff",
    "webp": "image/webp", "heic": "image/heic", "bmp": "image/bmp", "gif": "image/gif",
}

_INKWELL_MODELS = (
    ("invoice", "Invoice", "Accounts-payable invoices: supplier, totals, taxes, and line items.", "invoice-2026.02", 0.971),
    ("receipt", "Receipt", "Expense receipts: merchant, payment method, tip, and totals.", "receipt-2026.01", 0.958),
    ("credit_note", "Credit Note", "Supplier credit notes and memos carrying negative balances.", "invoice-2026.02", 0.962),
    ("purchase_order", "Purchase Order", "Outbound purchase orders with ordered line items.", "po-2025.11", 0.949),
    ("bank_statement", "Bank Statement", "Statements with opening and closing balances and transactions.", "statement-2025.09", 0.933),
    ("w9", "Form W-9", "US taxpayer identification request forms.", "usforms-2025.07", 0.981),
)
_INKWELL_MODEL_VERSION = {m[0]: m[3] for m in _INKWELL_MODELS}

_INKWELL_LINE_DESCS = (
    "Managed cloud hosting", "Professional services", "Software license — annual",
    "Freight and logistics", "Hardware components", "Consulting retainer",
    "Data processing fees", "Maintenance and support", "Marketing services",
    "Office supplies", "Network bandwidth", "Audit services", "Field installation",
)
_INKWELL_RETAIL_ITEMS = (
    "Coffee", "Sandwich", "Printer paper", "USB-C cable", "Taxi fare",
    "Parking", "Hotel night", "Lunch", "Stationery", "Toner cartridge",
)
_INKWELL_PAY_METHODS = ("VISA", "MASTERCARD", "AMEX", "CASH", "CORPORATE CARD")


def inkwell_mime(file_name: str) -> str | None:
    """Resolve the MIME a real client would send, or None for an unsupported type."""
    name = str(file_name or "").strip().lower()
    if "." not in name:
        return "application/pdf"
    return _INKWELL_MIME.get(name.rsplit(".", 1)[1])


def inkwell_models() -> dict[str, dict]:
    """The extraction models Inkwell publishes, keyed by model id."""
    out: dict[str, dict] = {}
    supported_mimes = sorted(set(_INKWELL_MIME.values()))
    for model_id, name, desc, version, avg in _INKWELL_MODELS:
        out[model_id] = {
            "modelId": model_id,
            "object": "model",
            "name": name,
            "description": desc,
            "version": version,
            "status": "ga",
            "engine": _INKWELL_ENGINE,
            "avgConfidence": avg,
            "supportedLocales": ["en-US", "en-GB", "de-DE", "fr-FR", "pt-BR"],
            "supportedMimeTypes": supported_mimes,
            "maxPages": 50,
            "releasedAt": "2026-01-15T00:00:00Z",
        }
    return out


def _inkwell_outcome(file_name: str, model: str) -> dict:
    """Map a document's name onto the lifecycle outcome a real engine would reach."""
    name = str(file_name or "").lower()

    def has(*tokens: str) -> bool:
        return any(t in name for t in tokens)

    if has("corrupt", "damaged", "unreadable", "truncated"):
        return {"status": "failed", "errorCode": "unreadable_document",
                "errorMessage": "The file could not be decoded; it appears corrupt or truncated."}
    if has("encrypted", "password", "protected", "locked"):
        return {"status": "failed", "errorCode": "password_protected",
                "errorMessage": "The document is password protected and cannot be opened."}
    if has("blank", "empty"):
        return {"status": "failed", "errorCode": "no_content_detected",
                "errorMessage": "No machine-readable content was detected in the document."}

    document_type = model
    if has("receipt"):
        document_type = "receipt"
    elif has("creditnote", "credit_note", "credit-note", "creditmemo"):
        document_type = "credit_note"
    degraded = has("scan", "photo", "handwritten", "lowres", "low-res", "fax", "skewed")
    return {"status": "extracted", "documentType": document_type, "degraded": degraded}


def _inkwell_box(rng: random.Random) -> list[float]:
    return [round(rng.uniform(0.05, 0.55), 4), round(rng.uniform(0.04, 0.92), 4),
            round(rng.uniform(0.12, 0.38), 4), round(rng.uniform(0.012, 0.03), 4)]


def _inkwell_field(rng: random.Random, value, page: int, base_conf: float) -> dict:
    conf = round(min(0.999, max(0.30, rng.gauss(base_conf, 0.025))), 3)
    return {"value": value, "confidence": conf, "page": page, "boundingBox": _inkwell_box(rng)}


def _inkwell_invoice(rng: random.Random, document_type: str, page_count: int, base_conf: float) -> dict:
    country, currency = rng.choice(_COUNTRIES)
    last_page = max(1, page_count)
    sign = -1 if document_type == "credit_note" else 1
    line_items, subtotal = [], 0.0
    for _ in range(rng.randint(1, 6)):
        qty = rng.choice((1, 1, 2, 3, 5, 10, 12, 24))
        unit = round(rng.uniform(18.0, 4200.0), 2)
        amount = round(sign * qty * unit, 2)
        subtotal = round(subtotal + amount, 2)
        line_items.append({
            "description": rng.choice(_INKWELL_LINE_DESCS),
            "productCode": f"SKU-{rng.randint(1000, 9999)}",
            "quantity": qty,
            "unitPrice": unit,
            "amount": amount,
            "confidence": round(min(0.999, max(0.40, rng.gauss(base_conf, 0.04))), 3),
        })
    tax_rate = rng.choice((0.0, 0.05, 0.07, 0.0825, 0.19, 0.20))
    tax_amount = round(subtotal * tax_rate, 2)
    total = round(subtotal + tax_amount, 2)

    issued = _EPOCH + timedelta(days=rng.randint(-120, -3))
    term_days = rng.choice((15, 30, 45, 60))
    due = issued + timedelta(days=term_days)
    prefix = rng.choice(("INV", "BILL", "AP", "CN" if document_type == "credit_note" else "INV"))
    supplier = _company(rng)
    account = "".join(rng.choice("0123456789") for _ in range(8))

    fields = {
        "supplierName": _inkwell_field(rng, supplier, 1, base_conf),
        "supplierTaxId": _inkwell_field(rng, f"{rng.randint(10, 99)}-{rng.randint(10**6, 10**7 - 1)}", 1, base_conf),
        "supplierVatNumber": _inkwell_field(rng, f"{country}{rng.randint(10**8, 10**9 - 1)}", 1, base_conf),
        "supplierAddress": _inkwell_field(rng, f"{rng.randint(1, 9999)} {rng.choice(_ROOTS)} Ave, {country}", 1, base_conf),
        "supplierIban": _inkwell_field(rng, _iban(rng, country, account), last_page, base_conf),
        "customerName": _inkwell_field(rng, "LynxCapital Holdings", 1, base_conf),
        "customerAddress": _inkwell_field(rng, "200 Lynx Plaza, New York, US", 1, base_conf),
        "invoiceNumber": _inkwell_field(rng, f"{prefix}-{issued.year}-{rng.randint(1000, 9999)}", 1, base_conf),
        "purchaseOrderNumber": _inkwell_field(rng, f"PO-{rng.randint(100000, 999999)}", 1, base_conf),
        "invoiceDate": _inkwell_field(rng, issued.isoformat(), 1, base_conf),
        "dueDate": _inkwell_field(rng, due.isoformat(), 1, base_conf),
        "paymentTerms": _inkwell_field(rng, f"NET{term_days}", 1, base_conf),
        "currency": _inkwell_field(rng, currency, last_page, base_conf),
        "subtotal": _inkwell_field(rng, subtotal, last_page, base_conf),
        "taxAmount": _inkwell_field(rng, tax_amount, last_page, base_conf),
        "totalAmount": _inkwell_field(rng, total, last_page, base_conf),
        "amountDue": _inkwell_field(rng, total, last_page, base_conf),
    }
    taxes = [{"code": "VAT" if tax_rate else "EXEMPT", "rate": tax_rate,
              "base": subtotal, "amount": tax_amount}]
    locale = {"language": "en", "country": country, "currency": currency}
    return {"locale": locale, "fields": fields, "lineItems": line_items, "taxes": taxes}


def _inkwell_receipt(rng: random.Random, page_count: int, base_conf: float) -> dict:
    country, currency = rng.choice(_COUNTRIES)
    line_items, subtotal = [], 0.0
    for _ in range(rng.randint(1, 5)):
        qty = rng.choice((1, 1, 1, 2, 3))
        unit = round(rng.uniform(2.5, 240.0), 2)
        amount = round(qty * unit, 2)
        subtotal = round(subtotal + amount, 2)
        line_items.append({
            "description": rng.choice(_INKWELL_RETAIL_ITEMS),
            "quantity": qty, "unitPrice": unit, "amount": amount,
            "confidence": round(min(0.999, max(0.40, rng.gauss(base_conf, 0.05))), 3),
        })
    tax_rate = rng.choice((0.0, 0.07, 0.0825, 0.20))
    tax_amount = round(subtotal * tax_rate, 2)
    tip = round(subtotal * rng.choice((0.0, 0.0, 0.1, 0.15, 0.18)), 2)
    total = round(subtotal + tax_amount + tip, 2)
    method = rng.choice(_INKWELL_PAY_METHODS)
    purchased = _EPOCH + timedelta(days=rng.randint(-90, -1))

    fields = {
        "merchantName": _inkwell_field(rng, _company(rng), 1, base_conf),
        "merchantAddress": _inkwell_field(rng, f"{rng.randint(1, 999)} {rng.choice(_ROOTS)} St, {country}", 1, base_conf),
        "transactionDate": _inkwell_field(rng, purchased.isoformat(), 1, base_conf),
        "transactionTime": _inkwell_field(rng, f"{rng.randint(7, 21):02d}:{rng.randint(0, 59):02d}", 1, base_conf),
        "paymentMethod": _inkwell_field(rng, method, 1, base_conf),
        "cardLast4": _inkwell_field(rng, "" if method == "CASH" else f"{rng.randint(0, 9999):04d}", 1, base_conf),
        "currency": _inkwell_field(rng, currency, 1, base_conf),
        "subtotal": _inkwell_field(rng, subtotal, 1, base_conf),
        "taxAmount": _inkwell_field(rng, tax_amount, 1, base_conf),
        "tip": _inkwell_field(rng, tip, 1, base_conf),
        "totalAmount": _inkwell_field(rng, total, 1, base_conf),
    }
    taxes = [{"code": "SALES_TAX" if tax_rate else "EXEMPT", "rate": tax_rate,
              "base": subtotal, "amount": tax_amount}]
    locale = {"language": "en", "country": country, "currency": currency}
    return {"locale": locale, "fields": fields, "lineItems": line_items, "taxes": taxes}


def inkwell_extraction(doc: dict) -> dict:
    """Build the deterministic extraction a document-AI engine returns for a document."""
    rng = _rng("inkwell-ocr", "extract", doc["documentId"], doc["fileName"])
    outcome = _inkwell_outcome(doc["fileName"], doc.get("model", "invoice"))
    base = {
        "documentId": doc["documentId"],
        "object": "extraction",
        "model": doc.get("model", "invoice"),
        "modelVersion": doc.get("modelVersion", _INKWELL_MODEL_VERSION["invoice"]),
        "apiVersion": _INKWELL_API_VERSION,
        "engine": _INKWELL_ENGINE,
        "pageCount": doc.get("pageCount", 1),
        "processingMs": rng.randint(640, 4200),
    }

    if outcome["status"] == "failed":
        base.update({
            "status": "failed", "documentType": "unknown", "confidence": 0.0,
            "needsReview": True, "reviewReasons": [outcome["errorCode"]],
            "error": {"code": outcome["errorCode"], "message": outcome["errorMessage"]},
            "locale": None, "fields": {}, "lineItems": [], "taxes": [],
        })
        return base

    document_type = outcome["documentType"]
    degraded = outcome["degraded"]
    base_conf = rng.uniform(0.62, 0.78) if degraded else rng.uniform(0.90, 0.985)
    body = (_inkwell_receipt(rng, base["pageCount"], base_conf) if document_type == "receipt"
            else _inkwell_invoice(rng, document_type, base["pageCount"], base_conf))

    fields = body["fields"]
    confs = [f["confidence"] for f in fields.values()]
    overall = round(sum(confs) / len(confs), 3) if confs else 0.0
    reasons: list[str] = []
    if overall < _INKWELL_REVIEW_THRESHOLD:
        reasons.append("low_overall_confidence")
    low = sorted(k for k, f in fields.items() if f["confidence"] < _INKWELL_FIELD_THRESHOLD)
    if low:
        reasons.append("low_field_confidence:" + ",".join(low))
    if degraded:
        reasons.append("image_quality_degraded")

    base.update({
        "status": "needs_review" if reasons else "extracted",
        "documentType": document_type,
        "locale": body["locale"],
        "confidence": overall,
        "needsReview": bool(reasons),
        "reviewReasons": reasons,
        "fields": fields,
        "lineItems": body["lineItems"],
        "taxes": body["taxes"],
    })
    return base


def _inkwell_document(seed: str, idx: int, model: str, file_name: str) -> dict:
    rng = _rng(seed, "doc", idx)
    mime = inkwell_mime(file_name) or "application/pdf"
    doc_id = "doc_%012x" % rng.getrandbits(48)
    created = _instant(rng, -120, -1)
    return {
        "documentId": doc_id,
        "object": "document",
        "fileName": file_name,
        "mimeType": mime,
        "sizeBytes": rng.randint(48_000, 5_200_000),
        "sha256": hashlib.sha256(f"{doc_id}:{file_name}".encode()).hexdigest(),
        "pageCount": rng.choice((1, 1, 1, 2, 2, 3, 5)),
        "model": model,
        "modelVersion": _INKWELL_MODEL_VERSION[model],
        "documentType": None,
        "status": "processing",
        "source": "api_upload",
        "reference": None,
        "callbackUrl": None,
        "createdAt": created,
        "completedAt": None,
        "confidence": None,
    }


def inkwell_dataset(seed: str) -> dict[str, dict]:
    """Build a coherent capture history: documents that have been extracted,
    flagged for review, or failed, alongside the published extraction models."""
    documents: dict[str, dict] = {}
    extractions: dict[str, dict] = {}
    variants = (
        ("invoice", "invoice-{n}.pdf"),
        ("invoice", "vendor-bill-{n}.pdf"),
        ("invoice", "scan-invoice-{n}.jpg"),
        ("receipt", "receipt-{n}.png"),
        ("credit_note", "credit-note-{n}.pdf"),
        ("invoice", "encrypted-invoice-{n}.pdf"),
        ("invoice", "corrupt-scan-{n}.tiff"),
        ("invoice", "invoice-{n}.pdf"),
    )
    for i in range(1, 41):
        model, pattern = variants[i % len(variants)]
        doc = _inkwell_document(seed, i, model, pattern.format(n=2026000 + i))
        if i % 11 == 0:
            documents[doc["documentId"]] = doc
            continue
        extraction = inkwell_extraction(doc)
        doc["status"] = extraction["status"]
        doc["documentType"] = extraction["documentType"]
        doc["confidence"] = extraction["confidence"]
        doc["completedAt"] = doc["createdAt"]
        documents[doc["documentId"]] = doc
        extractions[doc["documentId"]] = extraction
    return {"documents": documents, "extractions": extractions, "models": inkwell_models()}


def index_by(records: list[dict], key: str = "id") -> dict[str, dict]:
    return {r[key]: r for r in records}


# --------------------------------------------------------------------------- #
# Aegis Screening — sanctions / AML / KYB reference data
# --------------------------------------------------------------------------- #
_AEGIS_WATCHLISTS = (
    ("ofac-sdn", "OFAC SDN", "US Treasury OFAC", "sanctions", "US"),
    ("ofac-consolidated", "OFAC Consolidated (Non-SDN)", "US Treasury OFAC", "sanctions", "US"),
    ("eu-consolidated", "EU Consolidated Sanctions List", "European Union", "sanctions", "EU"),
    ("un-sc", "UN Security Council Consolidated List", "United Nations", "sanctions", "Global"),
    ("uk-ofsi", "UK OFSI Consolidated List", "HM Treasury", "sanctions", "GB"),
    ("bis-dpl", "BIS Denied Persons List", "US BIS", "sanctions", "US"),
    ("pep-global", "Global PEP Database", "Aegis Intelligence", "pep", "Global"),
    ("adverse-media", "Adverse Media Index", "Aegis Media Intelligence", "adverse_media", "Global"),
    ("interpol-red", "Interpol Red Notices", "Interpol", "law_enforcement", "Global"),
)

# High-risk and sanctioned jurisdictions weighted up by the risk model.
_AEGIS_HIGH_RISK = ("IR", "KP", "SY", "RU", "BY", "CU", "VE", "MM")

# Deterministic fictional watchlist subjects for the simulated ecosystem. Each
# screening that resolves to one of these produces a true exact/strong match.
_AEGIS_SANCTIONED = (
    ("Oblast Holdings LLC", "organization", "RU", ("ofac-sdn", "eu-consolidated"),
     ("SANCTIONS",), "BLOCKING", ("Oblast Group", "OOO Oblast")),
    ("Rubicon Maritime Trading", "organization", "IR", ("ofac-sdn", "un-sc"),
     ("SANCTIONS",), "BLOCKING", ("Rubicon Shipping",)),
    ("Crimson Star Logistics", "organization", "KP", ("un-sc", "ofac-sdn"),
     ("SANCTIONS",), "BLOCKING", ("Crimson Star Co",)),
    ("Pyotr Vasiliev", "individual", "RU", ("ofac-sdn", "uk-ofsi"),
     ("SANCTIONS", "PEP"), "BLOCKING", ("P. Vasiliev", "Pyotr Vasilyev")),
    ("Damascus Freight Forwarders", "organization", "SY", ("eu-consolidated", "ofac-sdn"),
     ("SANCTIONS",), "BLOCKING", ()),
    ("Aurelio Mancuso", "individual", "VE", ("ofac-sdn",),
     ("SANCTIONS", "ADVERSE_MEDIA"), "BLOCKING", ("A. Mancuso",)),
    ("Minsk Industrial Combine", "organization", "BY", ("eu-consolidated", "uk-ofsi"),
     ("SANCTIONS",), "SECTORAL", ()),
    ("Helena Brandt", "individual", "DE", ("pep-global",),
     ("PEP",), None, ("H. Brandt",)),
    ("Tobias Lindqvist", "individual", "SE", ("pep-global", "adverse-media"),
     ("PEP", "ADVERSE_MEDIA"), None, ()),
    ("Cobalt Reach Ventures", "organization", "VG", ("adverse-media",),
     ("ADVERSE_MEDIA",), None, ("Cobalt Reach",)),
)


def _aegis_registration(rng: random.Random, country: str) -> str:
    return f"{country}-{rng.randint(100000, 999999)}"


def aegis_reference(seed: str) -> dict:
    """Build the watchlist catalogue, the resolvable watchlist-subject index, and a
    set of clean resolvable business entities the screening engine matches against."""
    watchlists: dict[str, dict] = {}
    for lid, name, source, kind, juris in _AEGIS_WATCHLISTS:
        rng = _rng(seed, "wl", lid)
        watchlists[lid] = {
            "listId": lid, "name": name, "source": source, "type": kind,
            "jurisdiction": juris, "recordCount": rng.randint(1800, 41000),
            "lastUpdatedAt": _instant(rng, 1, 30), "refreshFrequency": "daily",
        }

    sanctioned: list[dict] = []
    for idx, (name, etype, country, lists, programs, stype, aliases) in enumerate(_AEGIS_SANCTIONED):
        rng = _rng(seed, "sanctioned", idx)
        record = {
            "entityId": f"ent_wl_{idx:04d}",
            "legalName": name, "type": etype, "country": country,
            "aliases": list(aliases), "watchlists": list(lists),
            "programs": list(programs), "sanctionType": stype,
            "listedAt": _day(rng, -900, -120), "source": "watchlist",
            "verificationStatus": "watchlisted", "status": "active",
        }
        if etype == "individual":
            record["dateOfBirth"] = _day(rng, -22000, -12000)
        else:
            record["incorporationDate"] = _day(rng, -7000, -1500)
            record["registrationNumber"] = _aegis_registration(rng, country)
        sanctioned.append(record)

    businesses: list[dict] = []
    for i in range(12):
        rng = _rng(seed, "kyb_entity", i)
        country, _ = rng.choice(_COUNTRIES)
        legal = _company(rng)
        dissolved = rng.random() < 0.12
        owners = []
        remaining = 100
        for o in range(rng.randint(1, 3)):
            share = remaining if o == rng.randint(0, 2) else rng.randint(15, 60)
            share = min(share, remaining)
            remaining -= share
            owners.append({
                "name": _person(rng), "ownershipPercent": share,
                "country": rng.choice(_COUNTRIES)[0],
                "isPep": rng.random() < 0.08, "verified": rng.random() < 0.85,
            })
            if remaining <= 0:
                break
        businesses.append({
            "entityId": f"ent_biz_{i:04d}",
            "legalName": legal, "type": "organization", "country": country,
            "registrationNumber": _aegis_registration(rng, country),
            "incorporationDate": _day(rng, -6000, -400),
            "registeredAddress": {
                "line1": f"{rng.randint(1, 400)} {rng.choice(_ROOTS)} Street",
                "city": rng.choice(_ROOTS), "country": country,
                "postalCode": f"{rng.randint(10000, 99999)}",
            },
            "industryCode": rng.choice(_MERCHANT_CATEGORIES)[0],
            "status": "dissolved" if dissolved else "active",
            "beneficialOwners": owners,
            "directors": [{"name": _person(rng), "role": "Director"} for _ in range(rng.randint(1, 2))],
            "aliases": [], "watchlists": [], "programs": [],
            "verificationStatus": "unverified", "source": "registry",
        })

    return {"watchlists": watchlists, "sanctioned": sanctioned, "businesses": businesses}

