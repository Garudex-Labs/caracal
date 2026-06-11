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

_LEGAL = (
    "Holdings",
    "Industries",
    "Systems",
    "Logistics",
    "Components",
    "Partners",
    "Networks",
    "Capital",
    "Trading",
    "Labs",
    "Group",
    "Solutions",
    "Foods",
    "Materials",
    "Robotics",
    "Analytics",
    "Freight",
    "Ventures",
)
_ROOTS = (
    "Northwind",
    "Contoso",
    "Aerolux",
    "Meridian",
    "Vertex",
    "Apex",
    "Axiom",
    "Helios",
    "Cobalt",
    "Granite",
    "Sequoia",
    "Onyx",
    "Cinder",
    "Marigold",
    "Tamarind",
    "Borealis",
    "Solstice",
    "Kestrel",
    "Driftwood",
    "Lattice",
    "Quill",
    "Saffron",
    "Verde",
    "Indigo",
    "Crimson",
    "Harbor",
    "Cedar",
)
_FIRST = (
    "Dana",
    "Priya",
    "Marco",
    "Lena",
    "Hassan",
    "Yuki",
    "Sofia",
    "Diego",
    "Amara",
    "Noah",
    "Ingrid",
    "Tariq",
    "Mei",
    "Lucas",
    "Farah",
    "Oskar",
)
_LAST = (
    "Whitfield",
    "Okafor",
    "Bianchi",
    "Novak",
    "Haddad",
    "Tanaka",
    "Reyes",
    "Lindqvist",
    "Khan",
    "Bauer",
    "Costa",
    "Adeyemi",
    "Wu",
    "Sorensen",
)
_COUNTRIES = (
    ("US", "USD"),
    ("GB", "GBP"),
    ("DE", "EUR"),
    ("FR", "EUR"),
    ("BR", "BRL"),
    ("SG", "SGD"),
    ("JP", "JPY"),
    ("CA", "CAD"),
)
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
    "GB": "HLCYGB2LXXX",
    "DE": "HLCYDEFFXXX",
    "FR": "HLCYFRPPXXX",
    "US": "HLCYUS33XXX",
    "BR": "HLCYBRSPXXX",
    "SG": "HLCYSGSGXXX",
    "JP": "HLCYJPJTXXX",
    "CA": "HLCYCATTXXX",
}
_MERCHANT_CATEGORIES = (
    ("5734", "Computer Software Stores"),
    ("7372", "Computer Programming Services"),
    ("4214", "Freight Carriers and Trucking"),
    ("5045", "Computers and Peripherals"),
    ("7311", "Advertising Services"),
    ("6513", "Real Estate Agents and Rentals"),
    ("4900", "Utilities"),
    ("5111", "Office Supplies and Printing"),
    ("8931", "Accounting and Bookkeeping"),
    ("5946", "Wholesale Industrial Supplies"),
)
_BANK_TXN_CODES = (
    ("PMT", "FasterPaymentsOut"),
    ("DD", "DirectDebit"),
    ("STO", "StandingOrder"),
    ("TFR", "InternalTransfer"),
    ("INT", "InterestCredit"),
    ("FEE", "ServiceCharge"),
    ("CARD", "CardPayment"),
    ("WIRE", "WireTransfer"),
    ("SEPA", "SepaCreditTransfer"),
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
    moment = datetime.combine(
        _EPOCH + timedelta(days=rng.randint(lo, hi)), time.min, timezone.utc
    )
    moment += timedelta(seconds=rng.randint(0, 86_399))
    return moment.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _iban(rng: random.Random, country: str, account_number: str) -> str:
    check = f"{rng.randint(2, 98):02d}"
    bank = "HLCY"
    body = "".join(rng.choice("0123456789") for _ in range(8))
    return f"{country}{check}{bank}{body}{account_number}"


_DIAL_CODES = {
    "US": "+1",
    "GB": "+44",
    "DE": "+49",
    "FR": "+33",
    "BR": "+55",
    "SG": "+65",
    "JP": "+81",
    "CA": "+1",
}


def _phone(rng: random.Random, country: str) -> str:
    """A plausible E.164-style number for the contact's country."""
    return f"{_DIAL_CODES.get(country, '+1')} {rng.randint(200, 989)} 555 {rng.randint(1000, 9999)}"


def vendors(seed: str, count: int) -> list[dict]:
    """Vendor / supplier master records with country, currency, terms, and tax id."""
    out = []
    for i in range(1, count + 1):
        rng = _rng(seed, "vendor", i)
        name = _company(rng)
        country, currency = rng.choice(_COUNTRIES)
        out.append(
            {
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
            }
        )
    return out


# --------------------------------------------------------------------------- #
# Atlas Vendor Network — vendor master data, onboarding, and supplier records
# --------------------------------------------------------------------------- #
_ATLAS_CATEGORIES = (
    ("Software", "43230000"),
    ("Professional Services", "80100000"),
    ("Facilities", "72100000"),
    ("Logistics", "78100000"),
    ("Hardware", "43210000"),
    ("Marketing", "82100000"),
    ("Utilities", "83100000"),
    ("Consulting", "80101500"),
    ("Manufacturing", "73100000"),
    ("Travel", "90120000"),
)
_ATLAS_TAX_ID_TYPE = {
    "US": "EIN",
    "GB": "VATIN",
    "DE": "VATIN",
    "FR": "VATIN",
    "BR": "CNPJ",
    "SG": "UEN",
    "JP": "CN",
    "CA": "BN",
}
_ATLAS_LIFECYCLE = (
    ("active", "active"),
    ("active", "active"),
    ("active", "active"),
    ("pending_review", "onboarding"),
    ("pending_review", "onboarding"),
    ("on_hold", "active"),
    ("suspended", "suspended"),
    ("offboarded", "offboarded"),
)
_ATLAS_DOC_TYPES = (
    ("w9", "Form W-9", 365 * 3),
    ("coi", "Certificate of Insurance", 365),
    ("bank_letter", "Bank Verification Letter", 730),
    ("msa", "Master Service Agreement", 365 * 2),
    ("registration", "Certificate of Incorporation", 0),
)
_ATLAS_ONBOARDING_STEPS = (
    ("profile", "Company profile captured"),
    ("tax", "Tax identification validated"),
    ("kyb", "KYB / sanctions screening cleared"),
    ("banking", "Bank account verified"),
    ("documents", "Required documents collected"),
    ("approval", "Final approval and activation"),
)
_ATLAS_CONTACT_ROLES = (
    "Accounts Receivable",
    "Sales",
    "Compliance Officer",
    "Account Manager",
    "Support",
)


def _atlas_tax_id(rng: random.Random, country: str) -> str:
    if country == "US":
        return f"{rng.randint(10, 99)}-{rng.randint(10**6, 10**7 - 1)}"
    return f"{country}{rng.randint(10**8, 10**9 - 1)}"


def _atlas_onboarding(
    rng: random.Random, status: str, stage: str, vendor_id: str
) -> dict:
    """A six-step onboarding case whose progress matches the vendor lifecycle stage."""
    if stage in ("active", "suspended", "offboarded", "on_hold"):
        cleared = len(_ATLAS_ONBOARDING_STEPS)
    else:
        cleared = rng.randint(1, len(_ATLAS_ONBOARDING_STEPS) - 1)
    checklist = []
    for idx, (step, label) in enumerate(_ATLAS_ONBOARDING_STEPS):
        if idx < cleared:
            checklist.append(
                {
                    "step": step,
                    "label": label,
                    "status": "completed",
                    "completedAt": _instant(rng, -300, -10),
                }
            )
        elif idx == cleared:
            checklist.append(
                {
                    "step": step,
                    "label": label,
                    "status": "in_progress",
                    "completedAt": None,
                }
            )
        else:
            checklist.append(
                {"step": step, "label": label, "status": "pending", "completedAt": None}
            )
    complete = cleared >= len(_ATLAS_ONBOARDING_STEPS)
    return {
        "caseId": f"ONB-{vendor_id.split('-')[-1]}",
        "stage": "completed" if complete else _ATLAS_ONBOARDING_STEPS[cleared][0],
        "status": "completed" if complete else "in_progress",
        "checklist": checklist,
        "owner": _person(rng),
        "startedAt": _instant(rng, -320, -300),
        "completedAt": _instant(rng, -300, -10) if complete else None,
    }


def atlas_vendors(seed: str, count: int) -> list[dict]:
    """Vendor master records with onboarding, banking, compliance, contacts, and
    documents, shaped after supplier-management platforms (Coupa/Ariba style)."""
    out = []
    for i in range(1, count + 1):
        rng = _rng(seed, "atlas_vendor", i)
        display = _company(rng)
        country, currency = rng.choice(_COUNTRIES)
        legal = f"{display} {_LEGAL_SUFFIX.get(country, 'Ltd.')}"
        category, unspsc = rng.choice(_ATLAS_CATEGORIES)
        status, stage = rng.choice(_ATLAS_LIFECYCLE)
        risk_score = rng.randint(5, 95)
        risk_tier = (
            "low" if risk_score < 40 else "medium" if risk_score < 75 else "high"
        )
        vid = f"VEND-{i:05d}"
        bank_verified = stage in ("active", "suspended") and rng.random() > 0.1
        kyb = (
            "cleared"
            if stage == "active"
            else rng.choice(("cleared", "pending", "flagged"))
        )
        contacts = []
        for c in range(rng.randint(1, 3)):
            person = _person(rng)
            contacts.append(
                {
                    "contactId": f"{vid}-C{c + 1}",
                    "name": person,
                    "email": f"{person.lower().replace(' ', '.')}@{_slug(display)}.example",
                    "phone": _phone(rng, country),
                    "role": rng.choice(_ATLAS_CONTACT_ROLES),
                    "primary": c == 0,
                }
            )
        documents = []
        for dtype, dlabel, ttl in _ATLAS_DOC_TYPES:
            if dtype in ("w9", "registration") and country != "US" and dtype == "w9":
                continue
            present = stage in ("active", "suspended") or rng.random() > 0.4
            if not present:
                continue
            uploaded = _day(rng, -300, -20)
            expires = None
            if ttl:
                expires = (
                    date.fromisoformat(uploaded) + timedelta(days=ttl)
                ).isoformat()
            documents.append(
                {
                    "documentId": f"DOC-{vid.split('-')[-1]}-{dtype.upper()}",
                    "type": dtype,
                    "label": dlabel,
                    "status": "verified" if rng.random() > 0.15 else "received",
                    "fileName": f"{_slug(display)}-{dtype}.pdf",
                    "uploadedAt": uploaded,
                    "expiresAt": expires,
                }
            )
        out.append(
            {
                "id": vid,
                "legalName": legal,
                "displayName": display,
                "slug": _slug(display),
                "registrationNumber": f"REG-{country}-{rng.randint(10**5, 10**6 - 1)}",
                "taxId": _atlas_tax_id(rng, country),
                "taxIdType": _ATLAS_TAX_ID_TYPE.get(country, "TIN"),
                "country": country,
                "currency": currency,
                "category": category,
                "unspsc": unspsc,
                "status": status,
                "lifecycleStage": stage,
                "riskTier": risk_tier,
                "riskScore": risk_score,
                "paymentTerms": rng.choice(_TERMS),
                "website": f"https://www.{_slug(display)}.example",
                "address": {
                    "line1": f"{rng.randint(1, 999)} {rng.choice(_ROOTS)} Street",
                    "city": _CITY_BY_COUNTRY.get(country, "Metropolis"),
                    "postalCode": f"{rng.randint(10000, 99999)}",
                    "country": country,
                },
                "primaryContact": contacts[0],
                "contacts": contacts,
                "banking": {
                    "status": "verified"
                    if bank_verified
                    else rng.choice(("unverified", "pending")),
                    "method": "micro_deposit",
                    "accountName": legal,
                    "accountLast4": f"{rng.randint(0, 9999):04d}",
                    "bankCountry": country,
                    "currency": currency,
                    "verifiedAt": _instant(rng, -200, -5) if bank_verified else None,
                },
                "compliance": {
                    "kyb": kyb,
                    "sanctions": "clear" if rng.random() > 0.03 else "review",
                    "taxValidation": "valid" if rng.random() > 0.1 else "pending",
                    "insurance": "current"
                    if any(d["type"] == "coi" for d in documents)
                    else "missing",
                    "w9OnFile": any(d["type"] == "w9" for d in documents),
                    "lastReviewedAt": _day(rng, -180, -10),
                    "nextReviewDue": _day(rng, 30, 360),
                },
                "documents": documents,
                "onboarding": _atlas_onboarding(rng, status, stage, vid),
                "createdAt": _day(rng, -540, -30),
                "updatedAt": _instant(rng, -30, -1),
            }
        )
    return out


_ATLAS_CONTRACT_TYPES = (
    "master_service_agreement",
    "statement_of_work",
    "purchase_agreement",
    "nda",
    "sla",
)


def atlas_contracts(seed: str, vendors: list[dict]) -> dict[str, dict]:
    """Vendor contracts with value, term, renewal, and lifecycle status."""
    contracts: dict[str, dict] = {}
    n = 0
    for v in vendors:
        if v["lifecycleStage"] not in ("active", "suspended", "on_hold"):
            continue
        rng = _rng(seed, "atlas_contract", v["id"])
        for _ in range(rng.randint(1, 2)):
            n += 1
            cid = f"CTR-{n:05d}"
            start = _day(rng, -540, -60)
            term_months = rng.choice((12, 24, 36))
            end = (
                date.fromisoformat(start) + timedelta(days=term_months * 30)
            ).isoformat()
            expiring = date.fromisoformat(end) <= (_EPOCH + timedelta(days=60))
            contracts[cid] = {
                "id": cid,
                "vendorId": v["id"],
                "type": rng.choice(_ATLAS_CONTRACT_TYPES),
                "currency": v["currency"],
                "value": round(rng.uniform(10_000, 2_000_000), 2),
                "termMonths": term_months,
                "startDate": start,
                "endDate": end,
                "renewal": rng.choice(("auto", "manual")),
                "status": "expiring"
                if expiring
                else rng.choice(("active", "active", "draft")),
                "owner": _person(rng),
            }
    return contracts


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
            identification["sortCode"] = (
                f"{rng.randint(0, 99):02d}-{rng.randint(0, 99):02d}-{rng.randint(0, 99):02d}"
            )
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
        out.append(
            {
                "accountId": f"ACC-{i:04d}",
                "nickname": f"{purpose} {currency}",
                "accountType": "Business",
                "accountSubType": subtype,
                "product": _ACCOUNT_PRODUCTS[subtype],
                "status": status,
                "currency": currency,
                "country": country,
                "identification": identification,
                "servicer": {
                    "scheme": "BICFI",
                    "bic": _BIC_BY_COUNTRY.get(country, "HLCYGB2LXXX"),
                },
                "openingDate": _day(rng, -1460, -200),
                "balances": balances,
            }
        )
    return out


def accounts(seed: str, count: int) -> list[dict]:
    """Bank or ledger accounts with balances and currency."""
    out = []
    kinds = ("operating", "reserve", "payroll", "fx", "escrow")
    for i in range(1, count + 1):
        rng = _rng(seed, "account", i)
        country, currency = rng.choice(_COUNTRIES)
        out.append(
            {
                "id": f"ACCT-{i:04d}",
                "name": f"{rng.choice(kinds).title()} {currency}",
                "kind": rng.choice(kinds),
                "currency": currency,
                "balance": round(rng.uniform(25_000, 4_500_000), 2),
                "available": 0.0,
                "status": "active",
            }
        )
        out[-1]["available"] = round(out[-1]["balance"] * rng.uniform(0.6, 0.99), 2)
    return out


def bank_transactions(
    seed: str, accounts_index: dict[str, dict], count: int
) -> list[dict]:
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
        drafts.append(
            (
                booking_day,
                {
                    "transactionId": f"TXN-{i:06d}",
                    "accountId": account_id,
                    "creditDebitIndicator": indicator,
                    "status": status,
                    "amount": amount,
                    "currency": currency,
                    "bookingDateTime": _instant(rng, booking_day, booking_day),
                    "valueDateTime": _instant(
                        rng, booking_day, min(0, booking_day + 1)
                    ),
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
                },
            )
        )
    out = []
    for booking_day, txn in sorted(drafts, key=lambda d: d[0]):
        if txn["status"] == "Booked":
            signed = (
                txn["amount"]
                if txn["creditDebitIndicator"] == "Credit"
                else -txn["amount"]
            )
            running[txn["accountId"]] = round(running[txn["accountId"]] + signed, 2)
            txn["balanceAfter"] = {
                "amount": running[txn["accountId"]],
                "currency": txn["currency"],
            }
        out.append(txn)
    return out


def bank_statements(
    seed: str,
    accounts_index: dict[str, dict],
    transactions: list[dict],
    periods: int = 3,
) -> list[dict]:
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
            end = _EPOCH - timedelta(days=30 * p)
            start = end - timedelta(days=30)
            window = [
                t
                for t in by_account.get(account_id, [])
                if t["status"] == "Booked"
                and start.isoformat() <= t["bookingDateTime"][:10] < end.isoformat()
            ]
            credits = round(
                sum(
                    t["amount"] for t in window if t["creditDebitIndicator"] == "Credit"
                ),
                2,
            )
            debits = round(
                sum(
                    t["amount"] for t in window if t["creditDebitIndicator"] == "Debit"
                ),
                2,
            )
            opening = round(closing - credits + debits, 2)
            out.append(
                {
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
                    "creditCount": sum(
                        1 for t in window if t["creditDebitIndicator"] == "Credit"
                    ),
                    "debitCount": sum(
                        1 for t in window if t["creditDebitIndicator"] == "Debit"
                    ),
                    "transactionCount": len(window),
                }
            )
            closing = opening
    return out


def invoices(seed: str, vendor_ids: list[str], count: int) -> list[dict]:
    out = []
    for i in range(1, count + 1):
        rng = _rng(seed, "invoice", i)
        currency = rng.choice(_COUNTRIES)[1]
        amount = round(rng.uniform(250, 180_000), 2)
        issued = _EPOCH + timedelta(days=rng.randint(-150, -5))
        out.append(
            {
                "id": f"INV-{i:06d}",
                "vendorId": rng.choice(vendor_ids),
                "number": f"{rng.choice(_ROOTS)[:3].upper()}-{rng.randint(1000, 9999)}",
                "amount": amount,
                "currency": currency,
                "tax": round(amount * rng.choice((0.0, 0.07, 0.19, 0.0825)), 2),
                "issuedAt": issued.isoformat(),
                "dueAt": (
                    issued + timedelta(days=rng.choice((15, 30, 45)))
                ).isoformat(),
                "status": rng.choice(("open", "open", "matched", "paid", "disputed")),
            }
        )
    return out


# --------------------------------------------------------------------------- #
# Lumen Identity — LynxCapital internal enterprise directory
#
# Lumen is an in-house directory and IAM platform, not an external provider.
# It models the company org chart (departments -> teams -> employees), RBAC
# roles with permission grants, security/access/distribution groups, and
# governed service accounts. Relationships are internally consistent: every
# employee resolves to a manager, team, department and cost centre, and every
# group/service account resolves to the roles that grant its permissions.
# --------------------------------------------------------------------------- #
_LUMEN_DOMAIN = "lynxcapital.example"

# (id, name, parentId, costCenter, headTitle)
_LUMEN_DEPARTMENTS = (
    ("DEPT-exec", "Executive", None, "CC-1000", "Chief Executive Officer"),
    ("DEPT-finance", "Finance", None, "CC-2000", "Chief Financial Officer"),
    ("DEPT-treasury", "Treasury", "DEPT-finance", "CC-2100", None),
    ("DEPT-controllership", "Controllership", "DEPT-finance", "CC-2200", None),
    ("DEPT-fpa", "Financial Planning & Analysis", "DEPT-finance", "CC-2300", None),
    ("DEPT-procure-to-pay", "Procure-to-Pay", "DEPT-finance", "CC-2400", None),
    ("DEPT-order-to-cash", "Order-to-Cash", "DEPT-finance", "CC-2500", None),
    ("DEPT-risk", "Risk & Compliance", None, "CC-3000", "Chief Risk Officer"),
    ("DEPT-financial-crime", "Financial Crime", "DEPT-risk", "CC-3100", None),
    ("DEPT-regulatory", "Regulatory Affairs", "DEPT-risk", "CC-3200", None),
    ("DEPT-engineering", "Engineering", None, "CC-4000", "Chief Technology Officer"),
    ("DEPT-platform", "Platform Engineering", "DEPT-engineering", "CC-4100", None),
    ("DEPT-data", "Data Engineering", "DEPT-engineering", "CC-4200", None),
    ("DEPT-infosec", "Information Security", "DEPT-engineering", "CC-4300", None),
    ("DEPT-it", "IT & Corporate Systems", None, "CC-5000", "Chief Information Officer"),
    ("DEPT-people", "People & Talent", None, "CC-6000", "Chief People Officer"),
)

# (id, name, description, category, permissions)
_LUMEN_ROLES = (
    (
        "ROLE-employee",
        "Employee",
        "Birthright access granted to every active employee.",
        "birthright",
        ("directory:read",),
    ),
    (
        "ROLE-treasury-analyst",
        "Treasury Analyst",
        "Reads cash positions and payment activity.",
        "standard",
        ("directory:read", "treasury:read", "payments:read", "reports:read"),
    ),
    (
        "ROLE-treasury-operator",
        "Treasury Operator",
        "Operates sweeps and initiates payments.",
        "standard",
        (
            "directory:read",
            "treasury:read",
            "treasury:operate",
            "payments:read",
            "payments:initiate",
        ),
    ),
    (
        "ROLE-treasury-manager",
        "Treasury Manager",
        "Approves treasury movements and payments.",
        "privileged",
        (
            "directory:read",
            "treasury:read",
            "treasury:operate",
            "treasury:approve",
            "payments:read",
            "payments:initiate",
            "payments:approve",
            "reports:read",
        ),
    ),
    (
        "ROLE-controller",
        "Financial Controller",
        "Owns the ledger and the financial close.",
        "privileged",
        (
            "directory:read",
            "ledger:read",
            "ledger:post",
            "ledger:close",
            "ap:approve",
            "reports:read",
        ),
    ),
    (
        "ROLE-gl-accountant",
        "General Ledger Accountant",
        "Posts journal entries to the ledger.",
        "standard",
        ("directory:read", "ledger:read", "ledger:post", "reports:read"),
    ),
    (
        "ROLE-ap-clerk",
        "Accounts Payable Clerk",
        "Enters and processes supplier bills.",
        "standard",
        ("directory:read", "ap:read", "ap:write", "vendor:read"),
    ),
    (
        "ROLE-ap-approver",
        "Accounts Payable Approver",
        "Approves bills and releases payment.",
        "privileged",
        (
            "directory:read",
            "ap:read",
            "ap:write",
            "ap:approve",
            "payments:initiate",
            "vendor:read",
        ),
    ),
    (
        "ROLE-ar-specialist",
        "Accounts Receivable Specialist",
        "Manages invoicing and collections.",
        "standard",
        ("directory:read", "ar:read", "ar:write", "reports:read"),
    ),
    (
        "ROLE-fpa-analyst",
        "FP&A Analyst",
        "Builds forecasts and management reporting.",
        "standard",
        ("directory:read", "ledger:read", "reports:read"),
    ),
    (
        "ROLE-compliance-analyst",
        "Compliance Analyst",
        "Runs screening and works alert cases.",
        "standard",
        ("directory:read", "screening:read", "screening:run", "cases:write"),
    ),
    (
        "ROLE-compliance-officer",
        "Compliance Officer",
        "Owns screening policy and case escalation.",
        "privileged",
        (
            "directory:read",
            "screening:read",
            "screening:run",
            "cases:write",
            "filings:read",
            "filings:submit",
            "audit:read",
        ),
    ),
    (
        "ROLE-regulatory-reporter",
        "Regulatory Reporter",
        "Prepares and submits regulatory filings.",
        "standard",
        ("directory:read", "filings:read", "filings:submit", "reports:read"),
    ),
    (
        "ROLE-internal-auditor",
        "Internal Auditor",
        "Read-only assurance across finance systems.",
        "privileged",
        ("directory:read", "audit:read", "ledger:read", "reports:read"),
    ),
    (
        "ROLE-platform-engineer",
        "Platform Engineer",
        "Builds and deploys platform services.",
        "standard",
        ("directory:read", "infra:read", "infra:deploy"),
    ),
    (
        "ROLE-data-engineer",
        "Data Engineer",
        "Operates ingestion and analytics pipelines.",
        "standard",
        ("directory:read", "infra:read", "ledger:read", "reports:read"),
    ),
    (
        "ROLE-security-engineer",
        "Security Engineer",
        "Runs security operations and tooling.",
        "privileged",
        ("directory:read", "infra:read", "audit:read", "secops:read", "secops:admin"),
    ),
    (
        "ROLE-it-admin",
        "IT Administrator",
        "Administers corporate systems and accounts.",
        "privileged",
        ("directory:read", "directory:write", "iam:admin"),
    ),
    (
        "ROLE-directory-admin",
        "Directory Administrator",
        "Administers Lumen directory and IAM.",
        "privileged",
        ("directory:read", "directory:write", "iam:admin"),
    ),
    (
        "ROLE-hr-partner",
        "People Operations Partner",
        "Maintains employee records and lifecycle.",
        "standard",
        ("directory:read", "directory:write"),
    ),
    (
        "ROLE-executive",
        "Executive",
        "Oversight and reporting across the organisation.",
        "privileged",
        ("directory:read", "reports:read", "audit:read"),
    ),
)

# (id, name, deptId, function, memberRole, managerRole, groupId, managerTitle, memberTitle, size)
_LUMEN_TEAMS = (
    (
        "TEAM-exec",
        "Executive Office",
        "DEPT-exec",
        "leadership",
        "ROLE-executive",
        "ROLE-executive",
        "GRP-finance-leadership",
        "Chief of Staff",
        "Executive Business Partner",
        2,
    ),
    (
        "TEAM-treasury-ops",
        "Treasury Operations",
        "DEPT-treasury",
        "treasury",
        "ROLE-treasury-operator",
        "ROLE-treasury-manager",
        "GRP-treasury-operators",
        "Head of Treasury Operations",
        "Treasury Operations Analyst",
        6,
    ),
    (
        "TEAM-cash-management",
        "Cash Management",
        "DEPT-treasury",
        "treasury",
        "ROLE-treasury-analyst",
        "ROLE-treasury-manager",
        "GRP-treasury-operators",
        "Cash Management Lead",
        "Cash Management Analyst",
        4,
    ),
    (
        "TEAM-gl",
        "General Ledger",
        "DEPT-controllership",
        "accounting",
        "ROLE-gl-accountant",
        "ROLE-controller",
        "GRP-controllers",
        "Group Controller",
        "General Ledger Accountant",
        5,
    ),
    (
        "TEAM-close",
        "Financial Close",
        "DEPT-controllership",
        "accounting",
        "ROLE-gl-accountant",
        "ROLE-controller",
        "GRP-controllers",
        "Close Manager",
        "Close Accountant",
        4,
    ),
    (
        "TEAM-ap",
        "Accounts Payable",
        "DEPT-procure-to-pay",
        "accounts_payable",
        "ROLE-ap-clerk",
        "ROLE-ap-approver",
        "GRP-ap-team",
        "Accounts Payable Manager",
        "Accounts Payable Clerk",
        6,
    ),
    (
        "TEAM-ar",
        "Accounts Receivable",
        "DEPT-order-to-cash",
        "accounts_receivable",
        "ROLE-ar-specialist",
        "ROLE-ar-specialist",
        "GRP-ar-team",
        "Accounts Receivable Manager",
        "Accounts Receivable Specialist",
        5,
    ),
    (
        "TEAM-fpa",
        "Planning & Analysis",
        "DEPT-fpa",
        "fpa",
        "ROLE-fpa-analyst",
        "ROLE-fpa-analyst",
        "GRP-finance-leadership",
        "FP&A Director",
        "FP&A Analyst",
        4,
    ),
    (
        "TEAM-aml",
        "Financial Crime Operations",
        "DEPT-financial-crime",
        "compliance",
        "ROLE-compliance-analyst",
        "ROLE-compliance-officer",
        "GRP-compliance",
        "Head of Financial Crime",
        "Financial Crime Analyst",
        6,
    ),
    (
        "TEAM-reg-reporting",
        "Regulatory Reporting",
        "DEPT-regulatory",
        "compliance",
        "ROLE-regulatory-reporter",
        "ROLE-compliance-officer",
        "GRP-compliance",
        "Regulatory Reporting Lead",
        "Regulatory Analyst",
        3,
    ),
    (
        "TEAM-audit",
        "Internal Audit",
        "DEPT-risk",
        "audit",
        "ROLE-internal-auditor",
        "ROLE-internal-auditor",
        "GRP-auditors",
        "Head of Internal Audit",
        "Internal Auditor",
        3,
    ),
    (
        "TEAM-platform",
        "Platform",
        "DEPT-platform",
        "engineering",
        "ROLE-platform-engineer",
        "ROLE-platform-engineer",
        "GRP-platform-engineers",
        "Engineering Manager, Platform",
        "Platform Engineer",
        6,
    ),
    (
        "TEAM-data",
        "Data",
        "DEPT-data",
        "engineering",
        "ROLE-data-engineer",
        "ROLE-data-engineer",
        "GRP-platform-engineers",
        "Data Engineering Lead",
        "Data Engineer",
        4,
    ),
    (
        "TEAM-secops",
        "Security Operations",
        "DEPT-infosec",
        "security",
        "ROLE-security-engineer",
        "ROLE-security-engineer",
        "GRP-security",
        "Head of Security",
        "Security Engineer",
        4,
    ),
    (
        "TEAM-itops",
        "IT Operations",
        "DEPT-it",
        "it",
        "ROLE-it-admin",
        "ROLE-it-admin",
        "GRP-it-admins",
        "IT Manager",
        "IT Administrator",
        4,
    ),
    (
        "TEAM-hr",
        "People Operations",
        "DEPT-people",
        "people",
        "ROLE-hr-partner",
        "ROLE-hr-partner",
        "GRP-all-staff",
        "Head of People",
        "People Operations Partner",
        3,
    ),
)

# (id, name, type, description, roleIds, ownerTeamId)
_LUMEN_GROUPS = (
    (
        "GRP-all-staff",
        "All Staff",
        "distribution",
        "Every active employee; company-wide announcements.",
        ("ROLE-employee",),
        "TEAM-hr",
    ),
    (
        "GRP-finance-leadership",
        "Finance Leadership",
        "distribution",
        "Department heads and finance leads.",
        (),
        "TEAM-exec",
    ),
    (
        "GRP-treasury-operators",
        "Treasury Operators",
        "access",
        "Operate cash sweeps and initiate payments.",
        ("ROLE-treasury-operator",),
        "TEAM-treasury-ops",
    ),
    (
        "GRP-controllers",
        "Controllers",
        "access",
        "Post and close the general ledger.",
        ("ROLE-controller",),
        "TEAM-gl",
    ),
    (
        "GRP-ap-team",
        "Accounts Payable",
        "access",
        "Process supplier bills and payment runs.",
        ("ROLE-ap-clerk",),
        "TEAM-ap",
    ),
    (
        "GRP-ar-team",
        "Accounts Receivable",
        "access",
        "Manage customer invoicing and collections.",
        ("ROLE-ar-specialist",),
        "TEAM-ar",
    ),
    (
        "GRP-compliance",
        "Compliance",
        "access",
        "Screening, case management, and regulatory reporting.",
        ("ROLE-compliance-analyst",),
        "TEAM-aml",
    ),
    (
        "GRP-auditors",
        "Internal Audit",
        "access",
        "Read-only assurance access across finance systems.",
        ("ROLE-internal-auditor",),
        "TEAM-audit",
    ),
    (
        "GRP-platform-engineers",
        "Platform Engineers",
        "access",
        "Deploy and operate platform and data services.",
        ("ROLE-platform-engineer",),
        "TEAM-platform",
    ),
    (
        "GRP-security",
        "Security Operations",
        "access",
        "Security tooling and incident response.",
        ("ROLE-security-engineer",),
        "TEAM-secops",
    ),
    (
        "GRP-it-admins",
        "IT Administrators",
        "access",
        "Administer corporate systems and identities.",
        ("ROLE-it-admin",),
        "TEAM-itops",
    ),
)

# (id, username, purpose, ownerTeamId, roleId, environment)
_LUMEN_SERVICE_ACCOUNTS = (
    (
        "SVC-ap-bot",
        "ap-bot",
        "Automated supplier-bill intake and three-way match.",
        "TEAM-ap",
        "ROLE-ap-clerk",
        "production",
    ),
    (
        "SVC-ar-bot",
        "ar-bot",
        "Automated invoice issuance and collections reminders.",
        "TEAM-ar",
        "ROLE-ar-specialist",
        "production",
    ),
    (
        "SVC-treasury-sweep",
        "treasury-sweep",
        "Scheduled cash sweeps between operating accounts.",
        "TEAM-cash-management",
        "ROLE-treasury-operator",
        "production",
    ),
    (
        "SVC-close-runner",
        "close-runner",
        "Month-end close task orchestration.",
        "TEAM-close",
        "ROLE-gl-accountant",
        "production",
    ),
    (
        "SVC-ledger-poster",
        "ledger-poster",
        "Posts validated journal batches to the ledger.",
        "TEAM-gl",
        "ROLE-gl-accountant",
        "production",
    ),
    (
        "SVC-ingest-pipeline",
        "ingest-pipeline",
        "Bank and statement ingestion pipeline.",
        "TEAM-data",
        "ROLE-data-engineer",
        "production",
    ),
    (
        "SVC-screening-connector",
        "screening-connector",
        "Sanctions and AML screening connector.",
        "TEAM-aml",
        "ROLE-compliance-analyst",
        "production",
    ),
    (
        "SVC-reg-filer",
        "reg-filer",
        "Automated regulatory filing submission.",
        "TEAM-reg-reporting",
        "ROLE-regulatory-reporter",
        "production",
    ),
    (
        "SVC-directory-sync",
        "directory-sync",
        "Synchronises directory records to downstream systems.",
        "TEAM-itops",
        "ROLE-directory-admin",
        "production",
    ),
    (
        "SVC-notify-dispatcher",
        "notify-dispatcher",
        "Sends transactional email and SMS notifications.",
        "TEAM-platform",
        "ROLE-platform-engineer",
        "production",
    ),
    (
        "SVC-ci-deployer",
        "ci-deployer",
        "Continuous-delivery deploy agent.",
        "TEAM-platform",
        "ROLE-platform-engineer",
        "staging",
    ),
    (
        "SVC-metrics-scraper",
        "metrics-scraper",
        "Collects platform and security telemetry.",
        "TEAM-secops",
        "ROLE-security-engineer",
        "production",
    ),
)

_LUMEN_OFFICES = (
    ("London", "GB", "Europe/London"),
    ("New York", "US", "America/New_York"),
    ("Singapore", "SG", "Asia/Singapore"),
    ("Frankfurt", "DE", "Europe/Berlin"),
    ("Toronto", "CA", "America/Toronto"),
    ("Bengaluru", "IN", "Asia/Kolkata"),
)
_LUMEN_STATUSES = (
    "active",
    "active",
    "active",
    "active",
    "active",
    "active",
    "active",
    "on_leave",
    "suspended",
    "offboarding",
)


def _toplevel_dept(dept_id: str, parents: dict[str, str | None]) -> str:
    cur = dept_id
    while parents.get(cur):
        cur = parents[cur]
    return cur


def lumen_directory(seed: str) -> dict[str, dict]:
    """Build LynxCapital's internal directory as related directory tables.

    Returns departments, teams, roles, groups, users (employees), and
    service_accounts, each indexed by id and cross-referenced so the org
    chart, RBAC grants, and ownership relationships resolve end to end.
    """
    role_perms = {r[0]: list(r[4]) for r in _LUMEN_ROLES}
    dept_parents = {d[0]: d[2] for d in _LUMEN_DEPARTMENTS}
    dept_cc = {d[0]: d[3] for d in _LUMEN_DEPARTMENTS}

    departments = {
        d[0]: {
            "id": d[0],
            "name": d[1],
            "parentDepartmentId": d[2],
            "costCenter": d[3],
            "headEmployeeId": None,
            "headcount": 0,
        }
        for d in _LUMEN_DEPARTMENTS
    }
    teams = {
        t[0]: {
            "id": t[0],
            "name": t[1],
            "departmentId": t[2],
            "function": t[3],
            "managerId": None,
            "memberCount": 0,
        }
        for t in _LUMEN_TEAMS
    }
    roles = {
        r[0]: {
            "id": r[0],
            "name": r[1],
            "description": r[2],
            "category": r[3],
            "permissions": list(r[4]),
            "assignable": r[3] != "birthright",
        }
        for r in _LUMEN_ROLES
    }
    groups = {
        g[0]: {
            "id": g[0],
            "name": g[1],
            "type": g[2],
            "description": g[3],
            "roleIds": list(g[4]),
            "ownerTeamId": g[5],
            "ownerEmployeeId": None,
            "members": [],
        }
        for g in _LUMEN_GROUPS
    }
    users: dict[str, dict] = {}
    used_usernames: set[str] = set()
    counter = {"n": 1000}

    def make_employee(
        team_id: str,
        dept_id: str,
        title: str,
        role_ids: list[str],
        group_ids: list[str],
        manager_id: str | None,
        *,
        leader: bool,
    ) -> str:
        counter["n"] += 1
        emp_no = counter["n"]
        eid = f"EMP-{emp_no}"
        rng = _rng(seed, "employee", emp_no)
        given = rng.choice(_FIRST)
        family = rng.choice(_LAST)
        base_user = f"{given}.{family}".lower()
        username = base_user
        suffix = 1
        while username in used_usernames:
            suffix += 1
            username = f"{base_user}{suffix}"
        used_usernames.add(username)
        office, country, tz = rng.choice(_LUMEN_OFFICES)
        privileged = any(roles[r]["category"] == "privileged" for r in role_ids)
        status = "active" if (leader or privileged) else rng.choice(_LUMEN_STATUSES)
        emp_type = "full_time"
        if not leader and rng.random() < 0.12:
            emp_type = rng.choice(("contractor", "contractor", "part_time", "intern"))
        hire = _instant(rng, -1600, -45)
        terminated = None
        last_login = _instant(rng, -7, 0)
        if status == "offboarding":
            last_login = _instant(rng, -30, -8)
        record = {
            "id": eid,
            "employeeNumber": str(emp_no),
            "username": username,
            "userPrincipalName": f"{username}@{_LUMEN_DOMAIN}",
            "displayName": f"{given} {family}",
            "givenName": given,
            "familyName": family,
            "workEmail": f"{username}@{_LUMEN_DOMAIN}",
            "status": status,
            "employmentType": emp_type,
            "jobTitle": title,
            "departmentId": dept_id,
            "teamId": team_id,
            "managerId": manager_id,
            "isManager": leader,
            "location": {"office": office, "country": country, "timezone": tz},
            "costCenter": dept_cc.get(dept_id, "CC-0000"),
            "hireDate": hire[:10],
            "terminationDate": terminated,
            "roleIds": sorted(set(["ROLE-employee", *role_ids])),
            "groupIds": sorted(set(group_ids)),
            "mfaEnabled": True if privileged else rng.random() > 0.07,
            "lastLoginAt": last_login,
            "createdAt": hire,
            "updatedAt": last_login,
        }
        users[eid] = record
        for gid in record["groupIds"]:
            if gid in groups and eid not in groups[gid]["members"]:
                groups[gid]["members"].append(eid)
        return eid

    ceo = make_employee(
        "TEAM-exec",
        "DEPT-exec",
        "Chief Executive Officer",
        ["ROLE-executive"],
        ["GRP-all-staff", "GRP-finance-leadership"],
        None,
        leader=True,
    )
    departments["DEPT-exec"]["headEmployeeId"] = ceo

    dept_head: dict[str, str] = {"DEPT-exec": ceo}
    for d in _LUMEN_DEPARTMENTS:
        if d[2] is not None or d[0] == "DEPT-exec":
            continue
        subtree_team = next(
            (t for t in _LUMEN_TEAMS if _toplevel_dept(t[2], dept_parents) == d[0]),
            None,
        )
        team_id = subtree_team[0] if subtree_team else "TEAM-exec"
        head = make_employee(
            team_id,
            d[0],
            d[4],
            ["ROLE-executive"],
            ["GRP-all-staff", "GRP-finance-leadership"],
            ceo,
            leader=True,
        )
        departments[d[0]]["headEmployeeId"] = head
        dept_head[d[0]] = head

    for t in _LUMEN_TEAMS:
        (
            tid,
            _name,
            dept_id,
            _fn,
            member_role,
            manager_role,
            group_id,
            manager_title,
            member_title,
            size,
        ) = t
        top = _toplevel_dept(dept_id, dept_parents)
        head_id = dept_head.get(top, ceo)
        mgr_groups = ["GRP-all-staff", group_id]
        if roles[manager_role]["category"] == "privileged":
            mgr_groups.append("GRP-finance-leadership")
        manager = make_employee(
            tid,
            dept_id,
            manager_title,
            [manager_role],
            mgr_groups,
            head_id,
            leader=True,
        )
        teams[tid]["managerId"] = manager
        if groups.get(group_id) and groups[group_id]["ownerEmployeeId"] is None:
            groups[group_id]["ownerEmployeeId"] = manager
        for _ in range(size):
            make_employee(
                tid,
                dept_id,
                member_title,
                [member_role],
                ["GRP-all-staff", group_id],
                manager,
                leader=False,
            )

    for tid, team in teams.items():
        team["memberCount"] = sum(1 for u in users.values() if u["teamId"] == tid)
    for did, dept in departments.items():
        dept["headcount"] = sum(1 for u in users.values() if u["departmentId"] == did)
    for g in groups.values():
        g["members"] = sorted(set(g["members"]))
        g["memberCount"] = len(g["members"])

    service_accounts = {}
    for sid, uname, purpose, owner_team, role_id, env in _LUMEN_SERVICE_ACCOUNTS:
        rng = _rng(seed, "svc", sid)
        owner_emp = teams.get(owner_team, {}).get("managerId")
        rotated = _instant(rng, -120, -20)
        status = "active" if rng.random() > 0.12 else "disabled"
        service_accounts[sid] = {
            "id": sid,
            "username": uname,
            "displayName": f"{uname} service account",
            "purpose": purpose,
            "ownerTeamId": owner_team,
            "ownerEmployeeId": owner_emp,
            "roleIds": [role_id],
            "scopes": sorted(set(role_perms.get(role_id, []))),
            "environment": env,
            "status": status,
            "interactive": False,
            "secretRotatedAt": rotated,
            "secretExpiresAt": _instant(rng, 60, 240),
            "lastUsedAt": _instant(rng, -3, 0) if status == "active" else rotated,
            "createdBy": owner_emp,
            "createdAt": _instant(rng, -700, -200),
        }

    return {
        "departments": departments,
        "teams": teams,
        "roles": roles,
        "groups": groups,
        "users": users,
        "service_accounts": service_accounts,
    }


def recipients(seed: str, count: int) -> list[dict]:
    out = []
    methods = ("bank", "wallet", "card")
    for i in range(1, count + 1):
        rng = _rng(seed, "recipient", i)
        country, currency = rng.choice(_COUNTRIES)
        out.append(
            {
                "id": f"RCPT-{i:05d}",
                "name": _company(rng) if rng.random() > 0.4 else _person(rng),
                "country": country,
                "currency": currency,
                "method": rng.choice(methods),
                "verified": rng.random() > 0.15,
            }
        )
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
_DISPUTE_REASONS = (
    "fraudulent",
    "duplicate",
    "product_not_received",
    "subscription_canceled",
    "credit_not_processed",
    "general",
)
_DISPUTE_NETWORK_CODE = {
    "fraudulent": "10.4",
    "duplicate": "12.6.1",
    "product_not_received": "13.1",
    "subscription_canceled": "13.2",
    "credit_not_processed": "13.6",
    "general": "13.7",
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
    return (
        _MERIDIAN_EPOCH
        - rng.randint(lo_days, hi_days) * 86_400
        - rng.randint(0, 86_399)
    )


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
    score = {
        "normal": rng.randint(2, 40),
        "elevated": rng.randint(60, 74),
        "highest": rng.randint(75, 95),
    }[risk]
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
            "address": {
                "country": pm["card"]["country"],
                "postalCode": f"{rng.randint(10000, 99999)}",
            },
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
    status = rng.choice(
        (
            "warning_needs_response",
            "needs_response",
            "needs_response",
            "under_review",
            "won",
            "lost",
        )
    )
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
        "balanceTransactions": [
            {
                "id": f"txn_{rng.getrandbits(56):014x}",
                "amount": -charge["amount"],
                "fee": 15.00,
                "type": "adjustment",
            }
        ],
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
            charge.update(
                status="failed",
                captured=False,
                paid=False,
                amountCaptured=0.0,
                net=0.0,
                processingFee=0.0,
                balanceTransaction=None,
            )
            charge["outcome"].update(
                networkStatus="declined_by_network",
                type="issuer_declined",
                reason="card_declined",
                sellerMessage="The bank declined this charge.",
            )
            charge["source"] = "tok_chargeDeclined"
        elif roll < 0.10:
            charge.update(
                status="requires_capture",
                captured=False,
                paid=False,
                amountCaptured=0.0,
            )
            charge["outcome"]["type"] = "manual"
        events[charge["id"]] = _event(
            rng,
            _CHARGE_EVENT_TYPE.get(charge["status"], "charge.updated"),
            charge,
            created,
        )
        charges[charge["chargeId"]] = charge

    succeeded = [c for c in charges.values() if c["status"] == "succeeded"]

    refundable = [
        c for c in succeeded if _rng(seed, "refund_pick", c["chargeId"]).random() < 0.18
    ]
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

    disputed = [
        c
        for c in succeeded
        if _rng(seed, "dispute_pick", c["chargeId"]).random() < 0.12
    ][:8]
    for c in disputed:
        rng = _rng(seed, "dispute", c["chargeId"])
        created = c["created"] + rng.randint(2, 20) * 86_400
        dispute = _new_dispute(rng, c, created)
        disputes[dispute["disputeId"]] = dispute
        c["disputed"] = True
        events[dispute["disputeId"]] = _event(
            rng, "charge.dispute.created", dispute, created
        )

    usd_settled = sorted(
        (c for c in succeeded if c["currency"] == "USD"), key=lambda c: c["created"]
    )
    batch_size = max(1, len(usd_settled) // 6)
    for b in range(0, len(usd_settled), batch_size):
        batch = usd_settled[b : b + batch_size]
        if not batch:
            continue
        idx = b // batch_size + 1
        rng = _rng(seed, "settlement", idx)
        gross = round(sum(c["amount"] for c in batch), 2)
        fee = round(sum(c["processingFee"] for c in batch), 2)
        refund_total = round(sum(c["amountRefunded"] for c in batch), 2)
        net = round(gross - fee - refund_total, 2)
        period_end = max(c["created"] for c in batch) + 2 * 86_400
        status = (
            "paid" if idx <= 4 else rng.choice(("paid", "in_transit", "in_transit"))
        )
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
    ("Cloud compute", "6200"),
    ("Software licenses", "6200"),
    ("Professional services", "6300"),
    ("Office supplies", "6100"),
    ("Marketing services", "6300"),
    ("Networking hardware", "1500"),
    ("Inbound freight", "5000"),
    ("Facilities maintenance", "6100"),
    ("Managed security", "6300"),
    ("Data subscriptions", "6200"),
)
_VENDOR_CATEGORIES = (
    "Software",
    "Professional Services",
    "Facilities",
    "Logistics",
    "Hardware",
    "Marketing",
    "Utilities",
    "Consulting",
)
_SUBSIDIARIES = ("LynxCapital : US", "LynxCapital : EMEA", "LynxCapital : APAC")
_DEPARTMENTS = (
    "Engineering",
    "Finance",
    "Operations",
    "Marketing",
    "Treasury",
    "Legal",
)
_CITY_BY_COUNTRY = {
    "US": "Austin",
    "GB": "London",
    "DE": "Berlin",
    "FR": "Paris",
    "BR": "Sao Paulo",
    "SG": "Singapore",
    "JP": "Tokyo",
    "CA": "Toronto",
}
_TAX_RATE_BY_COUNTRY = {
    "US": 0.0825,
    "GB": 0.20,
    "DE": 0.19,
    "FR": 0.20,
    "BR": 0.17,
    "SG": 0.09,
    "JP": 0.10,
    "CA": 0.13,
}
_LEGAL_SUFFIX = {
    "US": "Inc.",
    "CA": "Inc.",
    "GB": "Ltd.",
    "SG": "Pte. Ltd.",
    "DE": "GmbH",
    "FR": "S.A.S.",
    "BR": "Ltda.",
    "JP": "K.K.",
}
_PO_STATUSES = (
    "pendingReceipt",
    "partiallyReceived",
    "pendingBilling",
    "fullyBilled",
    "closed",
)


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
        "taxId": f"{country}{rng.randint(10**8, 10**9 - 1)}",
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
        "addressBook": [
            {
                "label": "Remit-To",
                "addr1": f"{rng.randint(10, 9999)} {rng.choice(_ROOTS)} {rng.choice(('Ave', 'St', 'Blvd', 'Way'))}",
                "city": _CITY_BY_COUNTRY.get(country, "Austin"),
                "zip": f"{rng.randint(10000, 99999)}",
                "country": country,
            }
        ],
        "createdDate": _instant(rng, -720, -120),
        "lastModifiedDate": _instant(rng, -119, -1),
    }


def _po_lines(rng: random.Random) -> list[dict]:
    lines = []
    for n in range(1, rng.randint(1, 4) + 1):
        item, account = rng.choice(_ERP_ITEMS)
        quantity = rng.randint(1, 40)
        rate = round(rng.uniform(45, 5_200), 2)
        lines.append(
            {
                "lineId": n,
                "item": item,
                "description": f"{item} — PO commitment",
                "account": account,
                "quantity": quantity,
                "quantityReceived": 0,
                "quantityBilled": 0,
                "rate": rate,
                "amount": round(quantity * rate, 2),
            }
        )
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
        line["quantityReceived"] = (
            line["quantity"]
            if received_all
            else (line["quantity"] // 2 if status == "partiallyReceived" else 0)
        )
        line["quantityBilled"] = line["quantity"] if billed_all else 0
    return {
        "id": f"PO-{idx:05d}",
        "tranId": f"PO-2026-{idx:05d}",
        "type": "purchaseOrder",
        "vendorId": vendor["id"],
        "vendorName": vendor["companyName"],
        "status": status,
        "approvalStatus": "approved"
        if status != "pendingReceipt" or rng.random() > 0.2
        else "pendingApproval",
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
    return [
        {
            "lineId": l["lineId"],
            "item": l["item"],
            "description": l["description"].replace("PO commitment", "vendor invoice"),
            "account": l["account"],
            "quantity": l["quantity"],
            "rate": l["rate"],
            "amount": l["amount"],
        }
        for l in po["lines"]
    ]


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
    status = rng.choices(
        ("open", "paidInFull", "pendingApproval", "cancelled"), weights=(50, 34, 12, 4)
    )[0]
    amount_paid = (
        total
        if status == "paidInFull"
        else (
            round(total * rng.uniform(0.2, 0.6), 2)
            if status == "open" and rng.random() < 0.25
            else 0.0
        )
    )
    return {
        "id": f"BILL-{idx:06d}",
        "tranId": f"VENDBILL-{idx:06d}",
        "type": "vendorBill",
        "vendorId": vendor["id"],
        "vendorName": vendor["companyName"],
        "referenceNumber": f"{vendor['companyName'][:3].upper()}-{rng.randint(10000, 99999)}",
        "purchaseOrderId": po["id"] if po else None,
        "status": status,
        "approvalStatus": "approved"
        if status != "pendingApproval"
        else "pendingApproval",
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
        {
            "line": 1,
            "account": expense,
            "debit": amount,
            "credit": 0.0,
            "memo": "Accrued cost",
            "department": rng.choice(_DEPARTMENTS),
        },
        {
            "line": 2,
            "account": credit_account,
            "debit": 0.0,
            "credit": amount,
            "memo": "Offset",
            "department": rng.choice(_DEPARTMENTS),
        },
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
                vendors[bill["vendorId"]]["balancePrimary"] + bill["amountRemaining"], 2
            )
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
# Junction Procurement — procure-to-pay, modeled on Coupa, SAP Ariba, and Ivalua.
# Suppliers, UNSPSC commodities, cost-center budgets with commitment accounting,
# requisitions with amount-tiered approval chains, and purchase orders that flow
# into goods receipts. Wire fields are camelCase the way Coupa and Ariba expose.
# --------------------------------------------------------------------------- #
_JUNCTION_COST_CENTERS = (
    ("CC-1001", "Engineering", "engineering", 1_850_000.0),
    ("CC-1002", "Operations", "operations", 1_240_000.0),
    ("CC-1003", "Marketing", "marketing", 760_000.0),
    ("CC-1004", "Finance", "finance", 540_000.0),
    ("CC-1005", "Facilities", "facilities", 980_000.0),
    ("CC-1006", "Information Technology", "it", 1_420_000.0),
    ("CC-1007", "Legal", "legal", 430_000.0),
)
_JUNCTION_COMMODITIES = (
    ("43211500", "Desktop and laptop computers", "Information Technology Hardware"),
    ("43211900", "Computer displays", "Information Technology Hardware"),
    ("43233200", "Software application licenses", "Software"),
    ("81161800", "Cloud infrastructure services", "Information Technology Services"),
    ("81111800", "Software engineering services", "Professional Services"),
    ("80101600", "Management consulting", "Professional Services"),
    ("44120000", "Office supplies", "Office and Administrative"),
    ("72101500", "Facilities maintenance", "Facilities"),
    ("78101800", "Inbound freight and logistics", "Logistics"),
    ("92121700", "Security guard services", "Security Services"),
    ("83111600", "Telecommunications services", "Telecommunications"),
    ("82101500", "Advertising and marketing services", "Marketing"),
)
_JUNCTION_UOM = ("each", "license", "seat", "hour", "month", "case", "unit")
_JUNCTION_SHIP_TO = (
    {
        "name": "LynxCapital HQ",
        "addr1": "500 Congress Ave",
        "city": "Austin",
        "region": "TX",
        "postalCode": "78701",
        "country": "US",
    },
    {
        "name": "LynxCapital EMEA",
        "addr1": "20 Finsbury Circus",
        "city": "London",
        "region": "",
        "postalCode": "EC2M 7EA",
        "country": "GB",
    },
    {
        "name": "LynxCapital APAC",
        "addr1": "8 Marina Boulevard",
        "city": "Singapore",
        "region": "",
        "postalCode": "018981",
        "country": "SG",
    },
)
_JUNCTION_FINANCE_PARTNER = {"id": "EMP-2201", "name": "Priya Okafor"}
_JUNCTION_CFO = {"id": "EMP-1000", "name": "Marco Bianchi"}
_JUNCTION_REQ_STATUS = ("draft", "pending_approval", "approved", "ordered", "rejected")


def junction_required_approval_steps(total: float) -> int:
    """Coupa-style approval matrix: more signatures as spend climbs through tiers."""
    if total < 2_500.0:
        return 0
    if total < 25_000.0:
        return 1
    if total < 100_000.0:
        return 2
    return 3


def _junction_approval_chain(manager: dict, steps: int) -> list[dict]:
    roles = (
        ("Cost Center Manager", manager),
        ("Finance Business Partner", _JUNCTION_FINANCE_PARTNER),
        ("Chief Financial Officer", _JUNCTION_CFO),
    )
    return [
        {
            "step": i + 1,
            "role": role,
            "approverId": person["id"],
            "approverName": person["name"],
            "status": "pending",
            "decidedAt": None,
            "comment": None,
        }
        for i, (role, person) in enumerate(roles[:steps])
    ]


def _junction_supplier(seed: str, i: int) -> dict:
    rng = _rng(seed, "jp_supplier", i)
    name = _company(rng)
    country, currency = rng.choice(_COUNTRIES)
    commodity = rng.choice(_JUNCTION_COMMODITIES)
    status = rng.choices(
        ("active", "active", "active", "pending_onboarding", "on_hold", "inactive"),
        weights=(58, 0, 0, 18, 14, 10),
    )[0]
    contact = _person(rng)
    handle = _slug(name).split("-")[0]
    return {
        "supplierId": f"SUP-{100000 + i}",
        "displayName": name,
        "legalName": f"{name} {_LEGAL_SUFFIX.get(country, 'Ltd.')}",
        "status": status,
        "category": commodity[2],
        "commodityCode": commodity[0],
        "taxId": f"{country}{rng.randint(10**8, 10**9 - 1)}",
        "currency": currency,
        "paymentTerms": rng.choice(_TERMS),
        "preferred": rng.random() < 0.35 and status == "active",
        "riskRating": rng.choices(("low", "medium", "high"), weights=(64, 28, 8))[0],
        "diversityCertified": rng.random() < 0.22,
        "primaryContact": {
            "name": contact,
            "email": f"{contact.split()[0].lower()}.{contact.split()[1].lower()}@{handle}.example",
            "phone": _phone(rng, country),
        },
        "remitToAddress": {
            "addr1": f"{rng.randint(10, 9999)} {rng.choice(_ROOTS)} {rng.choice(('Ave', 'St', 'Blvd', 'Way'))}",
            "city": _CITY_BY_COUNTRY.get(country, "Austin"),
            "postalCode": f"{rng.randint(10000, 99999)}",
            "country": country,
        },
        "onboardedDate": _instant(rng, -900, -45),
    }


def _junction_req_lines(
    rng: random.Random, currency: str, suppliers: list[dict]
) -> tuple[list[dict], float]:
    lines, subtotal = [], 0.0
    for n in range(1, rng.randint(1, 4) + 1):
        commodity = rng.choice(_JUNCTION_COMMODITIES)
        supplier = rng.choice(suppliers) if suppliers and rng.random() < 0.8 else None
        quantity = rng.randint(1, 25)
        unit_price = round(rng.uniform(35, 3_500), 2)
        line_total = round(quantity * unit_price, 2)
        subtotal += line_total
        lines.append(
            {
                "lineNumber": n,
                "description": commodity[1],
                "commodityCode": commodity[0],
                "quantity": quantity,
                "unitOfMeasure": rng.choice(_JUNCTION_UOM),
                "unitPrice": unit_price,
                "lineTotal": line_total,
                "currency": currency,
                "supplierId": supplier["supplierId"] if supplier else None,
                "glAccount": rng.choice(("6100", "6200", "6300", "1500", "5000")),
                "quantityReceived": 0,
            }
        )
    return lines, round(subtotal, 2)


def _junction_requisition(
    seed: str, idx: int, cost_center: dict, suppliers: list[dict], status: str
) -> dict:
    rng = _rng(seed, "jp_req", idx)
    currency = "USD"
    lines, subtotal = _junction_req_lines(rng, currency, suppliers)
    tax = round(subtotal * 0.0, 2)
    total = round(subtotal + tax, 2)
    steps = junction_required_approval_steps(total)
    chain = _junction_approval_chain(cost_center["manager"], steps)
    requester = {"id": f"EMP-{rng.randint(1100, 1900)}", "name": _person(rng)}
    created = _instant(rng, -180, -3)
    approval_status = "not_required" if steps == 0 else "pending"
    submitted_at = None if status == "draft" else created

    if status in ("approved", "ordered"):
        for step in chain:
            step["status"] = "approved"
            step["decidedAt"] = created
            step["comment"] = "Within policy."
        approval_status = "approved"
    elif status == "rejected":
        if chain:
            chain[0]["status"] = "rejected"
            chain[0]["decidedAt"] = created
            chain[0]["comment"] = "Budget deferred to next quarter."
        approval_status = "rejected"
    elif status == "pending_approval" and len(chain) > 1 and rng.random() < 0.5:
        chain[0]["status"] = "approved"
        chain[0]["decidedAt"] = created
        chain[0]["comment"] = "Endorsed."

    if steps == 0 and status in ("pending_approval",):
        status = "approved"
        approval_status = "approved"

    return {
        "requisitionId": f"REQ-{200000 + idx}",
        "requisitionNumber": f"REQ-2026-{idx:06d}",
        "title": lines[0]["description"] if lines else "Purchase requisition",
        "status": status,
        "department": cost_center["department"],
        "costCenter": cost_center["costCenter"],
        "requestedBy": requester,
        "currency": currency,
        "justification": rng.choice(
            (
                "Approved headcount tooling refresh.",
                "Renewal of an existing service contract.",
                "Capacity expansion for the current quarter.",
                "Replacement of end-of-life equipment.",
                "New project spend approved in planning.",
            )
        ),
        "neededByDate": _day(rng, 5, 75),
        "shipTo": rng.choice(_JUNCTION_SHIP_TO),
        "lines": lines,
        "subtotal": subtotal,
        "estimatedTax": tax,
        "total": total,
        "amount": total,
        "approval": {
            "required": steps > 0,
            "status": approval_status,
            "policyTier": steps,
            "chain": chain,
        },
        "purchaseOrderId": None,
        "createdAt": created,
        "updatedAt": created,
        "submittedAt": submitted_at,
    }


def _junction_purchase_order(
    seed: str, idx: int, req: dict, suppliers_by_id: dict
) -> dict:
    rng = _rng(seed, "jp_po", idx)
    supplier = None
    for line in req["lines"]:
        if line.get("supplierId") and line["supplierId"] in suppliers_by_id:
            supplier = suppliers_by_id[line["supplierId"]]
            break
    if supplier is None:
        supplier = suppliers_by_id[next(iter(suppliers_by_id))]
    issued = req["createdAt"]
    received = rng.random() < 0.45
    po_status = (
        "received" if received else rng.choice(("issued", "acknowledged", "issued"))
    )
    lines = []
    for line in req["lines"]:
        qty_received = line["quantity"] if received else 0
        lines.append(
            {
                "lineNumber": line["lineNumber"],
                "description": line["description"],
                "commodityCode": line["commodityCode"],
                "quantity": line["quantity"],
                "quantityReceived": qty_received,
                "unitOfMeasure": line["unitOfMeasure"],
                "unitPrice": line["unitPrice"],
                "lineTotal": line["lineTotal"],
                "glAccount": line["glAccount"],
            }
        )
    return {
        "poId": f"PO-{300000 + idx}",
        "poNumber": f"PO-2026-{idx:06d}",
        "requisitionId": req["requisitionId"],
        "supplierId": supplier["supplierId"],
        "supplierName": supplier["displayName"],
        "status": po_status,
        "costCenter": req["costCenter"],
        "department": req["department"],
        "currency": req["currency"],
        "buyer": {"id": "EMP-2300", "name": "Lena Novak"},
        "paymentTerms": supplier["paymentTerms"],
        "shipTo": req["shipTo"],
        "lines": lines,
        "subtotal": req["subtotal"],
        "tax": req["estimatedTax"],
        "total": req["total"],
        "amount": req["total"],
        "issuedAt": issued,
        "acknowledgedAt": issued if po_status in ("acknowledged", "received") else None,
        "expectedDeliveryDate": req["neededByDate"],
        "receipts": (
            [
                {
                    "receiptId": f"GRN-{400000 + idx}",
                    "receiptNumber": f"GRN-2026-{idx:06d}",
                    "receivedBy": {"id": "EMP-2400", "name": "Hassan Haddad"},
                    "receivedAt": _day(rng, -20, -1),
                    "lines": [
                        {
                            "lineNumber": l["lineNumber"],
                            "quantityReceived": l["quantity"],
                        }
                        for l in lines
                    ],
                    "status": "received",
                }
            ]
            if received
            else []
        ),
    }


def junction_dataset(seed: str) -> dict[str, dict]:
    """Build a coherent procure-to-pay back office: a supplier master, a commodity
    catalog, cost-center budgets, a requisition backlog whose approval chains and
    statuses are tier-consistent, and the purchase orders and goods receipts those
    requisitions flow into — with budget commitment and spend rolled up the way a
    procurement ledger keeps them."""
    suppliers = {
        s["supplierId"]: s for s in (_junction_supplier(seed, i) for i in range(1, 41))
    }
    supplier_list = list(suppliers.values())

    commodities = {
        c[0]: {"commodityCode": c[0], "name": c[1], "category": c[2]}
        for c in _JUNCTION_COMMODITIES
    }

    cost_centers: dict[str, dict] = {}
    for code, name, dept, budget in _JUNCTION_COST_CENTERS:
        rng = _rng(seed, "jp_cc", code)
        cost_centers[dept] = {
            "costCenter": code,
            "name": name,
            "department": dept,
            "manager": {"id": f"EMP-{rng.randint(1000, 1099)}", "name": _person(rng)},
            "fiscalYear": "FY2026",
            "currency": "USD",
            "budgetAmount": budget,
            "committedAmount": 0.0,
            "spentAmount": 0.0,
            "availableAmount": budget,
            "softLimitPct": 0.90,
            "hardLimitPct": 1.0,
            "status": "open",
        }

    dept_keys = [cc["department"] for cc in cost_centers.values()]
    requisitions: dict[str, dict] = {}
    for idx in range(1, 33):
        rng = _rng(seed, "jp_req_pick", idx)
        dept = rng.choice(dept_keys)
        status = rng.choices(_JUNCTION_REQ_STATUS, weights=(10, 22, 20, 38, 10))[0]
        req = _junction_requisition(
            seed, idx, cost_centers[dept], supplier_list, status
        )
        requisitions[req["requisitionId"]] = req

    purchase_orders: dict[str, dict] = {}
    receipts: dict[str, dict] = {}
    approvals: dict[str, dict] = {}
    po_idx = 0
    for req in requisitions.values():
        for step in req["approval"]["chain"]:
            approval_id = f"APR-{req['requisitionId']}-{step['step']}"
            approvals[approval_id] = {
                "approvalId": approval_id,
                "requisitionId": req["requisitionId"],
                "step": step["step"],
                "role": step["role"],
                "approverId": step["approverId"],
                "approverName": step["approverName"],
                "status": step["status"],
                "decidedAt": step["decidedAt"],
                "comment": step["comment"],
            }
        if req["status"] == "ordered":
            po_idx += 1
            po = _junction_purchase_order(seed, po_idx, req, suppliers)
            req["purchaseOrderId"] = po["poId"]
            if po["status"] == "received":
                req["status"] = "closed"
            purchase_orders[po["poId"]] = po
            for receipt in po["receipts"]:
                receipts[receipt["receiptId"]] = {**receipt, "poId": po["poId"]}

    for req in requisitions.values():
        cc = cost_centers.get(req["department"])
        if cc is None:
            continue
        if req["status"] in ("approved", "ordered"):
            cc["committedAmount"] = round(cc["committedAmount"] + req["total"], 2)
        elif req["status"] == "closed":
            cc["spentAmount"] = round(cc["spentAmount"] + req["total"], 2)
    for cc in cost_centers.values():
        cc["availableAmount"] = round(
            cc["budgetAmount"] - cc["committedAmount"] - cc["spentAmount"], 2
        )

    return {
        "suppliers": suppliers,
        "commodities": commodities,
        "cost_centers": cost_centers,
        "requisitions": requisitions,
        "approvals": approvals,
        "purchase_orders": purchase_orders,
        "receipts": receipts,
    }


# --------------------------------------------------------------------------- #
# Cordoba FX — cross-border FX-as-a-service, modeled on Currencycloud and Wise.
# Mid-market reference, settlement, beneficiary, and payment shapes mirror the
# real wire format: snake_case fields and decimal-string monetary amounts.
# --------------------------------------------------------------------------- #
_CORDOBA_EPOCH = datetime(2026, 1, 1, tzinfo=timezone.utc)

# Mid-market reference: units of the quoted currency per 1 USD.
_FX_MID = {
    "USD": 1.0,
    "EUR": 0.92,
    "GBP": 0.79,
    "JPY": 156.4,
    "BRL": 5.08,
    "SGD": 1.35,
    "CAD": 1.37,
    "CHF": 0.89,
    "AUD": 1.52,
    "INR": 83.2,
    "MXN": 18.7,
}

# Spread charged over mid-market, in basis points, widening for thinner pairs.
_FX_SPREAD_BPS = {
    "EUR": 20,
    "GBP": 22,
    "CHF": 28,
    "CAD": 28,
    "SGD": 30,
    "AUD": 30,
    "JPY": 35,
    "MXN": 55,
    "INR": 60,
    "BRL": 75,
}

# Currencies whose minor unit is not 1/100.
_FX_ZERO_DECIMAL = {"JPY"}

# Country -> (currency, routing_code_type) for beneficiary bank coordinates.
_FX_BANK_ROUTING = {
    "US": ("USD", "aba"),
    "GB": ("GBP", "sort_code"),
    "DE": ("EUR", "iban"),
    "FR": ("EUR", "iban"),
    "BR": ("BRL", "bic_swift"),
    "SG": ("SGD", "bic_swift"),
    "JP": ("JPY", "bic_swift"),
    "CA": ("CAD", "bic_swift"),
    "IN": ("INR", "ifsc"),
    "MX": ("MXN", "clabe"),
    "AU": ("AUD", "bsb_code"),
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


# --------------------------------------------------------------------------- #
# Pulse Market Data: FX instrument reference, intraday quotes, and EOD fixings
# --------------------------------------------------------------------------- #
_PULSE_PAIRS = (
    "USD/EUR",
    "USD/GBP",
    "USD/JPY",
    "USD/BRL",
    "USD/SGD",
    "EUR/GBP",
    "EUR/JPY",
    "GBP/JPY",
    "USD/CAD",
    "EUR/CHF",
    "USD/CHF",
    "USD/MXN",
    "USD/INR",
    "AUD/USD",
)
_PULSE_VENUE = {
    "USD": "NYC",
    "EUR": "LDN",
    "GBP": "LDN",
    "JPY": "TKY",
    "SGD": "SGP",
    "CHF": "ZRH",
    "CAD": "TOR",
    "AUD": "SYD",
    "BRL": "SAO",
    "MXN": "MEX",
    "INR": "MUM",
}
_PULSE_CCY_NAME = {
    "USD": "US Dollar",
    "EUR": "Euro",
    "GBP": "British Pound",
    "JPY": "Japanese Yen",
    "BRL": "Brazilian Real",
    "SGD": "Singapore Dollar",
    "CAD": "Canadian Dollar",
    "CHF": "Swiss Franc",
    "AUD": "Australian Dollar",
    "MXN": "Mexican Peso",
    "INR": "Indian Rupee",
}
_PULSE_EPOCH = datetime(2026, 1, 1, tzinfo=timezone.utc)
_PULSE_FIXING_DAYS = 5


def pulse_pairs() -> tuple[str, ...]:
    return _PULSE_PAIRS


def pulse_price_decimals(quote: str) -> int:
    """FX market convention: yen crosses quote to three decimals, the rest to five."""
    return 3 if quote == "JPY" else 5


def pulse_pip(quote: str) -> float:
    return 0.01 if quote == "JPY" else 0.0001


def _pulse_spread_bps(base: str, quote: str) -> int:
    return max(_FX_SPREAD_BPS.get(quote, 12), _FX_SPREAD_BPS.get(base, 12))


def pulse_instrument(seed: str, symbol: str) -> dict:
    base, quote = symbol.split("/")
    rng = _rng(seed, "pulse-instrument", symbol)
    decimals = pulse_price_decimals(quote)
    mid = round(fx_mid_rate(base, quote), decimals)
    pip = pulse_pip(quote)
    prev_close = round(mid * (1 + rng.uniform(-0.0015, 0.0015)), decimals)
    day_open = round(prev_close * (1 + rng.uniform(-0.0008, 0.0008)), decimals)
    return {
        "symbol": symbol,
        "ticker": f"{base}{quote}",
        "baseCurrency": base,
        "quoteCurrency": quote,
        "description": f"{_PULSE_CCY_NAME.get(base, base)} / {_PULSE_CCY_NAME.get(quote, quote)}",
        "assetClass": "fx_spot",
        "mid": mid,
        "pip": pip,
        "priceDecimals": decimals,
        "spreadBps": _pulse_spread_bps(base, quote),
        "minTickSize": round(pip / 10, decimals + 1),
        "contractSize": 100_000,
        "venue": _PULSE_VENUE.get(base, "LDN"),
        "tradingSession": "24x5",
        "prevClose": prev_close,
        "dayOpen": day_open,
        "status": "active",
    }


def pulse_instruments(seed: str) -> list[dict]:
    return [pulse_instrument(seed, symbol) for symbol in _PULSE_PAIRS]


def _pulse_business_days(count: int) -> list[date]:
    """The most recent settlement (weekday) dates strictly before the lab epoch."""
    out: list[date] = []
    cursor = _PULSE_EPOCH.date()
    while len(out) < count:
        cursor -= timedelta(days=1)
        if cursor.weekday() < 5:
            out.append(cursor)
    return out


def pulse_reference_rates(seed: str) -> list[dict]:
    """Official end-of-day fixings, one series of recent settlement dates per pair."""
    out = []
    fixing_dates = _pulse_business_days(_PULSE_FIXING_DAYS)
    for symbol in _PULSE_PAIRS:
        base, quote = symbol.split("/")
        decimals = pulse_price_decimals(quote)
        mid = fx_mid_rate(base, quote)
        for fixing_date in fixing_dates:
            rng = _rng(seed, "pulse-fixing", symbol, fixing_date.isoformat())
            rate = round(mid * (1 + rng.uniform(-0.004, 0.004)), decimals)
            published = datetime.combine(fixing_date, time(16, 0), tzinfo=timezone.utc)
            out.append(
                {
                    "rateId": f"{base}{quote}-{fixing_date.isoformat()}",
                    "symbol": symbol,
                    "baseCurrency": base,
                    "quoteCurrency": quote,
                    "rate": rate,
                    "fixingDate": fixing_date.isoformat(),
                    "publishedAt": _fx_iso(published).replace("+00:00", "Z"),
                    "source": "PULSE_REF",
                    "session": "EOD",
                }
            )
    return out


def pulse_dataset(seed: str) -> dict[str, dict]:
    return {
        "instruments": index_by(pulse_instruments(seed), key="symbol"),
        "reference_rates": index_by(pulse_reference_rates(seed), key="rateId"),
        "subscriptions": {},
    }


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
        out["routing_code_value_1"] = "".join(
            rng.choice("0123456789") for _ in range(9)
        )
        out["bank_account_type"] = rng.choice(("checking", "savings"))
    elif routing_type == "sort_code":
        out["routing_code_type_1"] = "sort_code"
        out["routing_code_value_1"] = "-".join(
            "".join(rng.choice("0123456789") for _ in range(2)) for _ in range(3)
        )
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
            (
                "".join(rng.choice("0123456789") for _ in range(3)),
                "".join(rng.choice("0123456789") for _ in range(3)),
            )
        )
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
        "beneficiary_city": rng.choice(
            (
                "London",
                "Frankfurt",
                "Singapore",
                "Toronto",
                "Sao Paulo",
                "Tokyo",
                "Sydney",
                "Mumbai",
                "New York",
            )
        ),
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
        amount = (
            rng.uniform(40_000, 900_000)
            if currency != "JPY"
            else rng.uniform(3_000_000, 20_000_000)
        )
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
        buy_amount = (
            rng.uniform(2_000, 250_000)
            if buy != "JPY"
            else rng.uniform(300_000, 9_000_000)
        )
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
            pay_status = (
                "completed"
                if stage == 3
                else prng.choice(("submitted", "ready_to_send"))
            )
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
        "EUR": (
            "Cordoba FX EUR Settlement",
            "DE",
            "CORDDEFFXXX",
            "DE89370400440532013000",
            None,
        ),
        "GBP": (
            "Cordoba FX GBP Settlement",
            "GB",
            "CORDGB2LXXX",
            "GB29CORD60161331926819",
            "60-16-13",
        ),
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
            "routing_code_type_1": "sort_code"
            if routing and "-" in routing
            else ("aba" if routing else None),
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
# Keystone Treasury — corporate treasury management system, flavored after
# Kyriba, GTreasury, ION Treasury, and FIS Quantum. A multi-entity group holds
# bank-account cash positions in several currencies, hedges its FX exposure with
# forwards and swaps, sweeps and lends cash intercompany, and runs short-term
# investments. The reporting currency for the group is USD.
# --------------------------------------------------------------------------- #
_KEYSTONE_EPOCH = datetime(2026, 1, 1, tzinfo=timezone.utc)
_KEYSTONE_REPORTING_CCY = "USD"

# Legal entities in the treasury group: (id, name, country, functional currency, region).
_KEYSTONE_ENTITIES = (
    ("LXC-US", "LynxCapital Inc.", "US", "USD", "US"),
    ("LXC-EU", "LynxCapital Europe GmbH", "DE", "EUR", "DE"),
    ("LXC-UK", "LynxCapital UK Ltd.", "GB", "GBP", "GB"),
    ("LXC-SG", "LynxCapital APAC Pte. Ltd.", "SG", "SGD", "SG"),
    ("LXC-JP", "LynxCapital Japan KK", "JP", "JPY", "JP"),
    ("LXC-BR", "LynxCapital Brasil Ltda.", "BR", "BRL", "BR"),
)
_KEYSTONE_ENTITY_BY_CCY = {ccy: eid for eid, _n, _c, ccy, _r in _KEYSTONE_ENTITIES}
_KEYSTONE_ENTITY_BY_REGION = {
    region: eid for eid, _n, _c, _ccy, region in _KEYSTONE_ENTITIES
}

# Banking partners by country: (bank name, BIC prefix).
_KEYSTONE_BANKS = {
    "US": ("Halcyon Bank", "HLCYUS33"),
    "DE": ("Northwind Bank", "NORDDEFF"),
    "GB": ("Corvus Bank", "CORVGB2L"),
    "SG": ("Sterling National", "STRLSGSG"),
    "JP": ("Sterling National", "STRLJPJT"),
    "BR": ("Corvus Bank", "CORVBRSP"),
}

# Account purposes per entity, in priority order; the first is the concentration
# account a sweep pulls into.
_KEYSTONE_ACCOUNT_PLAN = ("Operating", "Reserve", "Payroll")
_KEYSTONE_ACCOUNT_TYPE = {
    "Operating": "current",
    "Reserve": "current",
    "Payroll": "current",
}

_KEYSTONE_COUNTERPARTIES = (
    "Halcyon Bank",
    "Corvus Bank",
    "Northwind Bank",
    "Sterling National",
)
_KEYSTONE_HEDGE_STATUS_FLOW = ("booked", "confirmed", "settled")
_KEYSTONE_TRANSFER_STATUS_FLOW = ("pending", "value_dated", "executed", "settled")
_KEYSTONE_OPERATION_TYPES = (
    "cash_sweep",
    "money_market_investment",
    "term_deposit",
    "commercial_paper",
    "intercompany_loan",
)


def keystone_usd(amount: float, currency: str) -> float:
    """Group-reporting-currency (USD) equivalent of an amount in any currency."""
    return amount * fx_mid_rate(currency, _KEYSTONE_REPORTING_CCY)


def keystone_entity(
    *, currency: str | None = None, region: str | None = None
) -> tuple | None:
    """Resolve a treasury entity tuple by functional currency or region."""
    eid = None
    if currency is not None:
        eid = _KEYSTONE_ENTITY_BY_CCY.get(currency.upper())
    if eid is None and region is not None:
        eid = _KEYSTONE_ENTITY_BY_REGION.get(region.upper())
    if eid is None:
        return None
    return next(e for e in _KEYSTONE_ENTITIES if e[0] == eid)


def keystone_currencies() -> tuple[str, ...]:
    return tuple(ccy for _e, _n, _c, ccy, _r in _KEYSTONE_ENTITIES)


def _keystone_account_number(rng: random.Random) -> str:
    return "".join(rng.choice("0123456789") for _ in range(10))


def _keystone_position(seed: str, entity: tuple, purpose: str) -> dict:
    eid, name, country, currency, region = entity
    rng = _rng(seed, "position", eid, purpose)
    bank_name, bic_prefix = _KEYSTONE_BANKS[country]
    account_number = _keystone_account_number(rng)
    is_reserve = purpose == "Reserve"
    floor, ceiling = (8_000_000, 60_000_000) if is_reserve else (500_000, 28_000_000)
    if currency == "JPY":
        floor, ceiling = floor * 150, ceiling * 150
    elif currency == "BRL":
        floor, ceiling = floor * 5, ceiling * 5
    ledger = round(rng.uniform(floor, ceiling), 2)
    holds = round(ledger * rng.uniform(0.01, 0.08), 2)
    available = round(ledger - holds, 2)
    intraday = round(
        rng.uniform(-400_000, 600_000) * (1 if currency != "JPY" else 150), 2
    )
    overdraft = 0.0 if is_reserve else round(ceiling * 0.1, 2)
    as_of = _KEYSTONE_EPOCH - timedelta(hours=rng.randint(1, 18))
    return {
        "accountId": f"acct_{bic_prefix[:4].lower()}_{account_number[-6:]}",
        "accountName": f"{name} {purpose} {currency}",
        "accountType": _KEYSTONE_ACCOUNT_TYPE[purpose],
        "purpose": purpose,
        "bankId": f"bank_{_slug(bank_name)}",
        "bankName": bank_name,
        "bic": f"{bic_prefix}",
        "iban": _iban(rng, country, account_number)
        if country in ("DE", "GB", "BR")
        else None,
        "accountNumber": account_number,
        "legalEntityId": eid,
        "legalEntity": name,
        "region": region,
        "country": country,
        "currency": currency,
        "ledgerBalance": ledger,
        "holdsAndUncleared": holds,
        "availableBalance": available,
        "valueDatedBalance": round(available + intraday, 2),
        "projectedBalance": round(available + intraday * rng.uniform(0.8, 1.4), 2),
        "overdraftLimit": overdraft,
        "creditInterestRate": round(rng.uniform(0.5, 4.25), 3),
        "asOf": _fx_iso(as_of),
        "lastMovementAt": _fx_iso(as_of - timedelta(hours=rng.randint(1, 40))),
        "status": "active",
    }


def _keystone_hedge(seed: str, idx: int) -> dict:
    rng = _rng(seed, "hedge", idx)
    pairs = (
        ("EUR", "USD"),
        ("GBP", "USD"),
        ("USD", "SGD"),
        ("USD", "JPY"),
        ("USD", "BRL"),
        ("EUR", "GBP"),
    )
    buy, sell = pairs[idx % len(pairs)]
    instrument = rng.choices(("forward", "fx_swap", "ndf"), weights=(6, 3, 1))[0]
    side = rng.choice(("buy", "sell"))
    notional = round(rng.uniform(500_000, 12_000_000), 2)
    tenor_days = rng.choice((30, 60, 90, 90, 180, 270, 365))
    trade_date = _KEYSTONE_EPOCH - timedelta(days=rng.randint(2, 120))
    value_date = trade_date + timedelta(days=2)
    settlement = trade_date + timedelta(days=tenor_days)
    spot = fx_mid_rate(sell, buy)
    forward_points = round(rng.uniform(-0.004, 0.006), 6)
    all_in = spot + forward_points
    settled = settlement <= _KEYSTONE_EPOCH
    status = _KEYSTONE_HEDGE_STATUS_FLOW[
        2 if settled else rng.choices((0, 1), weights=(1, 3))[0]
    ]
    mtm = round(notional * rng.uniform(-0.03, 0.03), 2)
    return {
        "hedgeId": f"hdg_{rng.getrandbits(48):012x}",
        "dealRef": f"FX{trade_date:%Y%m%d}-{1000 + idx}",
        "instrument": instrument,
        "pair": f"{buy}/{sell}",
        "side": side,
        "notional": notional,
        "notionalCurrency": buy,
        "counterCurrency": sell,
        "spotRate": fx_rate_str(spot),
        "forwardPoints": f"{forward_points:.6f}",
        "allInRate": fx_rate_str(all_in),
        "tradeDate": _fx_iso(trade_date),
        "valueDate": value_date.date().isoformat(),
        "settlementDate": settlement.date().isoformat(),
        "tenorDays": tenor_days,
        "counterparty": rng.choice(_KEYSTONE_COUNTERPARTIES),
        "hedgeType": rng.choice(("cashflow", "balance_sheet")),
        "portfolio": rng.choice(("FX-CORE", "FX-INTERCO")),
        "status": status,
        "markToMarket": mtm,
        "markToMarketCurrency": "USD",
    }


def _keystone_transfer(seed: str, idx: int) -> dict:
    rng = _rng(seed, "transfer", idx)
    entities = [e for e in _KEYSTONE_ENTITIES]
    src = entities[idx % len(entities)]
    dst = entities[(idx * 3 + 1) % len(entities)]
    if dst[0] == src[0]:
        dst = entities[(idx + 2) % len(entities)]
    same_entity = rng.random() < 0.3
    if same_entity:
        dst = src
    currency = src[3]
    amount = round(
        rng.uniform(100_000, 6_000_000) * (150 if currency == "JPY" else 1), 2
    )
    initiated = _KEYSTONE_EPOCH - timedelta(days=rng.randint(0, 60))
    value_date = initiated + timedelta(days=rng.choice((0, 1, 2)))
    stage = rng.choices(range(4), weights=(1, 1, 1, 4))[0]
    status = _KEYSTONE_TRANSFER_STATUS_FLOW[stage]
    fee = 0.0 if same_entity else round(rng.uniform(3, 25), 2)
    transfer_type = "internal_sweep" if same_entity else "intercompany"
    return {
        "transferId": f"tr_{rng.getrandbits(48):012x}",
        "reference": f"TT{initiated:%Y%m%d}-{2000 + idx}",
        "type": transfer_type,
        "fromAccountId": f"acct_{src[0].lower()}_concentration",
        "fromEntityId": src[0],
        "fromEntity": src[1],
        "toAccountId": f"acct_{dst[0].lower()}_concentration",
        "toEntityId": dst[0],
        "toEntity": dst[1],
        "currency": currency,
        "amount": amount,
        "valueDate": value_date.date().isoformat(),
        "status": status,
        "purposeCode": rng.choice(("INTC", "CASH", "TREA", "LOAN")),
        "fee": fee,
        "feeCurrency": currency,
        "initiatedAt": _fx_iso(initiated),
        "settledAt": _fx_iso(value_date) if stage == 3 else None,
    }


def _keystone_exposure(seed: str, currency: str, positions: dict, hedges: dict) -> dict:
    rng = _rng(seed, "exposure", currency)
    cash = sum(
        p["valueDatedBalance"] for p in positions.values() if p["currency"] == currency
    )
    receivables = round(rng.uniform(0.2, 1.5) * max(cash, 1_000_000), 2)
    payables = round(rng.uniform(0.2, 1.4) * max(cash, 1_000_000), 2)
    gross_long = round(cash + receivables, 2)
    gross_short = round(payables, 2)
    net = round(gross_long - gross_short, 2)
    hedged = round(
        sum(
            h["notional"]
            for h in hedges.values()
            if currency in (h["notionalCurrency"], h["counterCurrency"])
            and h["status"] != "settled"
        ),
        2,
    )
    unhedged = round(net - hedged, 2)
    ratio = round(min(1.0, hedged / net), 4) if net > 0 else 0.0
    var = round(abs(unhedged) * rng.uniform(0.008, 0.018), 2)
    return {
        "currency": currency,
        "asOf": _fx_iso(_KEYSTONE_EPOCH - timedelta(hours=rng.randint(1, 12))),
        "grossLong": gross_long,
        "grossShort": gross_short,
        "netExposure": net,
        "hedgedAmount": hedged,
        "unhedgedAmount": unhedged,
        "hedgeRatio": ratio,
        "valueAtRisk1d95": var,
        "reportingCurrency": _KEYSTONE_REPORTING_CCY,
        "netExposureBase": round(keystone_usd(net, currency), 2),
    }


def _keystone_operation(seed: str, idx: int) -> dict:
    rng = _rng(seed, "operation", idx)
    op_type = _KEYSTONE_OPERATION_TYPES[idx % len(_KEYSTONE_OPERATION_TYPES)]
    entity = _KEYSTONE_ENTITIES[(idx * 2) % len(_KEYSTONE_ENTITIES)]
    currency = entity[3]
    principal = round(
        rng.uniform(1_000_000, 25_000_000) * (150 if currency == "JPY" else 1), 2
    )
    value_date = _KEYSTONE_EPOCH - timedelta(days=rng.randint(0, 30))
    tenor = rng.choice((1, 7, 14, 30, 30, 90, 180))
    maturity = value_date + timedelta(days=tenor)
    matured = maturity <= _KEYSTONE_EPOCH
    rate = round(rng.uniform(0.5, 5.25), 3)
    return {
        "operationId": f"op_{rng.getrandbits(40):010x}",
        "type": op_type,
        "status": "matured"
        if matured
        else rng.choice(("booked", "confirmed", "active")),
        "entityId": entity[0],
        "entity": entity[1],
        "currency": currency,
        "principal": principal,
        "rate": rate,
        "tenorDays": tenor,
        "valueDate": value_date.date().isoformat(),
        "maturityDate": maturity.date().isoformat(),
        "counterparty": rng.choice(_KEYSTONE_COUNTERPARTIES),
        "reference": f"OP{value_date:%Y%m%d}-{3000 + idx}",
        "createdAt": _fx_iso(value_date),
    }


def keystone_dataset(seed: str) -> dict[str, dict]:
    """Build a coherent treasury book: multi-entity bank-account positions, an FX
    hedge portfolio, intercompany and internal transfers, currency exposures
    derived from those positions and hedges, and a history of short-term treasury
    operations — the live picture a corporate treasury platform would hold."""
    positions: dict[str, dict] = {}
    for entity in _KEYSTONE_ENTITIES:
        account_count = 3 if entity[3] in ("USD", "EUR") else 2
        for purpose in _KEYSTONE_ACCOUNT_PLAN[:account_count]:
            pos = _keystone_position(seed, entity, purpose)
            positions[pos["accountId"]] = pos

    hedges: dict[str, dict] = {}
    for i in range(1, 13):
        hedge = _keystone_hedge(seed, i)
        hedges[hedge["hedgeId"]] = hedge

    transfers: dict[str, dict] = {}
    for i in range(1, 11):
        transfer = _keystone_transfer(seed, i)
        transfers[transfer["transferId"]] = transfer

    exposures: dict[str, dict] = {}
    for currency in keystone_currencies():
        exposures[currency] = _keystone_exposure(seed, currency, positions, hedges)

    operations: dict[str, dict] = {}
    for i in range(1, 11):
        op = _keystone_operation(seed, i)
        operations[op["operationId"]] = op

    return {
        "positions": positions,
        "forecasts": {},
        "hedges": hedges,
        "transfers": transfers,
        "exposures": exposures,
        "operations": operations,
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
                {
                    "task": t,
                    "status": "complete" if closed else "pending",
                    "owner": "Finance",
                }
                for t in _SLATE_CLOSE_TASKS
            ],
            "closedAt": _instant(_rng(seed, "close", pid), -40, -30)
            if closed
            else None,
            "closedBy": "controller@slate-ledger.test" if closed else None,
        }

    entries: dict[str, dict] = {}
    seq = 0

    def _post(
        rng: random.Random,
        period_id: str,
        entry_type: str,
        source: str,
        description: str,
        raw_lines: list[tuple[str, float, float]],
    ) -> dict:
        nonlocal seq
        seq += 1
        lines = []
        total_debit = total_credit = 0.0
        for ln, (acct, debit, credit) in enumerate(raw_lines, start=1):
            debit = round(debit, 2)
            credit = round(credit, 2)
            total_debit += debit
            total_credit += credit
            lines.append(
                {
                    "lineNo": ln,
                    "accountNo": acct,
                    "accountName": accounts[acct]["name"],
                    "debit": debit,
                    "credit": credit,
                    "department": rng.choice(_DEPARTMENTS),
                    "memo": description,
                }
            )
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

    posted_periods = [p for p in periods if periods[p]["status"] == "open"][:3] or list(
        periods
    )[:3]
    for pid in posted_periods:
        rng = _rng(seed, "journals", pid)
        for _ in range(rng.randint(6, 9)):
            amount = round(rng.uniform(2_500, 180_000), 2)
            kind = rng.random()
            if kind < 0.45:
                expense = rng.choice(expense_accounts)
                _post(
                    rng,
                    pid,
                    "standard",
                    "subledger",
                    "Vendor expense recognition",
                    [(expense, amount, 0.0), ("2000", 0.0, amount)],
                )
            elif kind < 0.75:
                revenue = rng.choice(revenue_accounts)
                _post(
                    rng,
                    pid,
                    "standard",
                    "subledger",
                    "Customer billing",
                    [("1100", amount, 0.0), (revenue, 0.0, amount)],
                )
            elif kind < 0.9:
                expense = rng.choice(expense_accounts)
                _post(
                    rng,
                    pid,
                    "accrual",
                    "recurring",
                    "Month-end accrual",
                    [(expense, amount, 0.0), ("2100", 0.0, amount)],
                )
            else:
                _post(
                    rng,
                    pid,
                    "adjustment",
                    "manual",
                    "Reclassification adjustment",
                    [("6300", amount, 0.0), ("6200", 0.0, amount)],
                )

    reconciliations: dict[str, dict] = {}
    recon_targets = (("1000", 0.0), ("1010", 0.0), ("1020", 142.50), ("2000", 0.0))
    for idx, (acct, residual) in enumerate(recon_targets, start=1):
        rng = _rng(seed, "recon", acct)
        gl_balance = accounts[acct]["balance"]
        statement_balance = round(gl_balance + residual, 2)
        outstanding = []
        if residual:
            outstanding.append(
                {
                    "itemId": f"OS-{idx:03d}",
                    "type": "deposit_in_transit",
                    "amount": residual,
                    "memo": "Late deposit not yet on statement",
                }
            )
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
    for idx, (name, expense_acct, liability_acct) in enumerate(
        _SLATE_ACCRUAL_TEMPLATES, start=1
    ):
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
    "USD": "United States Dollar",
    "GBP": "British Pound Sterling",
    "EUR": "Euro",
    "BRL": "Brazilian Real",
    "SGD": "Singapore Dollar",
    "JPY": "Japanese Yen",
    "CAD": "Canadian Dollar",
}
_QBO_TERMS = {
    "NET15": ("Net 15", 15),
    "NET30": ("Net 30", 30),
    "NET45": ("Net 45", 45),
    "NET60": ("Net 60", 60),
}
_QBO_CHART = (
    ("1000", "Checking", "Bank", "Checking", "Asset"),
    ("1010", "Savings", "Bank", "Savings", "Asset"),
    (
        "1200",
        "Accounts Receivable (A/R)",
        "Accounts Receivable",
        "AccountsReceivable",
        "Asset",
    ),
    ("1300", "Undeposited Funds", "Other Current Asset", "UndepositedFunds", "Asset"),
    ("1400", "Inventory Asset", "Other Current Asset", "Inventory", "Asset"),
    ("1500", "Prepaid Expenses", "Other Current Asset", "PrepaidExpenses", "Asset"),
    ("1700", "Furniture & Equipment", "Fixed Asset", "FurnitureAndFixtures", "Asset"),
    (
        "2000",
        "Accounts Payable (A/P)",
        "Accounts Payable",
        "AccountsPayable",
        "Liability",
    ),
    ("2100", "Mastercard", "Credit Card", "CreditCard", "Liability"),
    (
        "2200",
        "Sales Tax Payable",
        "Other Current Liability",
        "SalesTaxPayable",
        "Liability",
    ),
    ("3000", "Opening Balance Equity", "Equity", "OpeningBalanceEquity", "Equity"),
    ("3900", "Retained Earnings", "Equity", "RetainedEarnings", "Equity"),
    ("4000", "Sales of Product Income", "Income", "SalesOfProductIncome", "Revenue"),
    ("4100", "Services", "Income", "ServiceFeeIncome", "Revenue"),
    (
        "5000",
        "Cost of Goods Sold",
        "Cost of Goods Sold",
        "SuppliesMaterialsCogs",
        "Expense",
    ),
    ("6000", "Advertising & Marketing", "Expense", "AdvertisingPromotional", "Expense"),
    ("6100", "Rent & Lease", "Expense", "RentOrLeaseOfBuildings", "Expense"),
    (
        "6200",
        "Office Supplies & Software",
        "Expense",
        "OfficeGeneralAdministrativeExpenses",
        "Expense",
    ),
    (
        "6300",
        "Legal & Professional Fees",
        "Expense",
        "LegalProfessionalFees",
        "Expense",
    ),
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
_QBO_PAY_METHODS = ("Cash", "Check", "CreditCard")


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
        "PrimaryPhone": {
            "FreeFormNumber": f"+1 ({rng.randint(200, 989)}) {rng.randint(200, 999)}-{rng.randint(1000, 9999)}"
        },
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
        "PrimaryEmailAddr": {
            "Address": f"{given.lower()}@{_slug(name).split('-')[0]}.example"
        },
        "PrimaryPhone": {
            "FreeFormNumber": f"+1 ({rng.randint(200, 989)}) {rng.randint(200, 999)}-{rng.randint(1000, 9999)}"
        },
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
        item["AssetAccountRef"] = {
            "value": acct_by_num["1400"]["Id"],
            "name": acct_by_num["1400"]["Name"],
        }
        item["ExpenseAccountRef"] = {
            "value": acct_by_num["5000"]["Id"],
            "name": acct_by_num["5000"]["Name"],
        }
    return item


def _qbo_bill(seed: str, idx: int, vendor: dict, acct_by_num: dict) -> dict:
    rng = _rng(seed, "qbo_bill", idx)
    currency = vendor["CurrencyRef"]["value"]
    ap = acct_by_num["2000"]
    term = next(
        (t for t in _TERMS if _QBO_TERMS[t][0] == vendor["TermRef"]["name"]), "NET30"
    )
    issued = _EPOCH + timedelta(days=rng.randint(-150, -3))
    due = issued + timedelta(days=_QBO_TERMS[term][1])
    n_lines = rng.randint(1, 3)
    lines, subtotal = [], 0.0
    for ln in range(1, n_lines + 1):
        acct = acct_by_num[rng.choice(_QBO_EXPENSE_ACCTS)]
        amount = _qbo_round(rng.uniform(120, 14_000), currency)
        subtotal += amount
        lines.append(
            {
                "Id": str(ln),
                "Description": f"{acct['Name']} — {vendor['DisplayName']}",
                "Amount": amount,
                "DetailType": "AccountBasedExpenseLineDetail",
                "AccountBasedExpenseLineDetail": {
                    "AccountRef": {"value": acct["Id"], "name": acct["Name"]},
                    "BillableStatus": "NotBillable",
                    "TaxCodeRef": {"value": "NON"},
                },
            }
        )
    total = _qbo_round(subtotal, currency)
    paid = rng.random() > 0.55
    bill = {
        "Id": str(1000 + idx),
        "DocNumber": f"{vendor['DisplayName'][:3].upper()}-{rng.randint(1000, 9999)}",
        "VendorRef": {"value": vendor["Id"], "name": vendor["DisplayName"]},
        "APAccountRef": {"value": ap["Id"], "name": ap["Name"]},
        "SalesTermRef": {
            "value": str(_TERMS.index(term) + 1),
            "name": _QBO_TERMS[term][0],
        },
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


def _qbo_invoice(
    seed: str, idx: int, customer: dict, items: list[dict], acct_by_num: dict
) -> dict:
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
        lines.append(
            {
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
            }
        )
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
        "HomeBalance": balance
        if currency == _QBO_HOME_CCY
        else _qbo_round(balance * 1.0, _QBO_HOME_CCY),
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
    pay_type = rng.choice(_QBO_PAY_METHODS)
    funding = acct_by_num["2100"] if pay_type == "CreditCard" else acct_by_num["1000"]
    acct = acct_by_num[rng.choice(_QBO_EXPENSE_ACCTS)]
    amount = _qbo_round(rng.uniform(30, 4_500), currency)
    issued = _EPOCH + timedelta(days=rng.randint(-90, -1))
    return {
        "Id": str(3000 + idx),
        "PaymentType": pay_type,
        "DocNumber": f"EXP-{1000 + idx}",
        "AccountRef": {"value": funding["Id"], "name": funding["Name"]},
        "EntityRef": {
            "value": vendor["Id"],
            "name": vendor["DisplayName"],
            "type": "Vendor",
        },
        "TxnDate": issued.isoformat(),
        "CurrencyRef": _ccy_ref(currency),
        "TotalAmt": amount,
        "Credit": False,
        "Line": [
            {
                "Id": "1",
                "Amount": amount,
                "Description": f"{acct['Name']} — {vendor['DisplayName']}",
                "DetailType": "AccountBasedExpenseLineDetail",
                "AccountBasedExpenseLineDetail": {
                    "AccountRef": {"value": acct["Id"], "name": acct["Name"]},
                    "BillableStatus": "NotBillable",
                    "TaxCodeRef": {"value": "NON"},
                },
            }
        ],
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
            {
                "Id": "0",
                "Description": "Accrual",
                "Amount": amount,
                "DetailType": "JournalEntryLineDetail",
                "JournalEntryLineDetail": {
                    "PostingType": "Debit",
                    "AccountRef": {
                        "value": debit_acct["Id"],
                        "name": debit_acct["Name"],
                    },
                },
            },
            {
                "Id": "1",
                "Description": "Accrual",
                "Amount": amount,
                "DetailType": "JournalEntryLineDetail",
                "JournalEntryLineDetail": {
                    "PostingType": "Credit",
                    "AccountRef": {
                        "value": credit_acct["Id"],
                        "name": credit_acct["Name"],
                    },
                },
            },
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
    items = [
        _qbo_item(i, row, acct_by_num, _rng(seed, "qbo_item", i))
        for i, row in enumerate(_QBO_ITEMS, start=1)
    ]
    item_index = {it["Id"]: it for it in items}

    active_vendors = [v for v in vendors.values() if v["Active"]]
    active_customers = [c for c in customers.values() if c["Active"]]

    bills = {}
    for idx in range(1, 51):
        vendor = active_vendors[
            _rng(seed, "qbo_bill_pick", idx).randrange(len(active_vendors))
        ]
        bill = _qbo_bill(seed, idx, vendor, acct_by_num)
        bills[bill["Id"]] = bill

    invoices = {}
    for idx in range(1, 51):
        customer = active_customers[
            _rng(seed, "qbo_inv_pick", idx).randrange(len(active_customers))
        ]
        invoice = _qbo_invoice(seed, idx, customer, items, acct_by_num)
        invoices[invoice["Id"]] = invoice

    expenses = {}
    for idx in range(1, 31):
        vendor = active_vendors[
            _rng(seed, "qbo_exp_pick", idx).randrange(len(active_vendors))
        ]
        expense = _qbo_expense(seed, idx, vendor, acct_by_num)
        expenses[expense["Id"]] = expense

    journal_entries = {
        je["Id"]: je
        for je in (_qbo_journal(seed, i, acct_by_num) for i in range(1, 21))
    }

    payments, bill_payments = _qbo_seed_payments(
        seed, bills, invoices, vendors, customers, acct_by_num
    )

    _qbo_roll_balances(
        accounts, acct_by_num, vendors, customers, bills, invoices, expenses
    )

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
                "CheckPayment": {
                    "BankAccountRef": {"value": bank["Id"], "name": bank["Name"]}
                },
                "Line": [
                    {
                        "Amount": bill["TotalAmt"],
                        "LinkedTxn": [{"TxnId": bill["Id"], "TxnType": "Bill"}],
                    }
                ],
                "domain": "QBO",
                "sparse": False,
                "SyncToken": "0",
                "MetaData": {
                    "CreateTime": bill["DueDate"] + "T17:00:00Z",
                    "LastUpdatedTime": bill["DueDate"] + "T17:00:00Z",
                },
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
                "DepositToAccountRef": {
                    "value": undeposited["Id"],
                    "name": undeposited["Name"],
                },
                "Line": [
                    {
                        "Amount": _qbo_round(applied, currency),
                        "LinkedTxn": [{"TxnId": inv["Id"], "TxnType": "Invoice"}],
                    }
                ],
                "domain": "QBO",
                "sparse": False,
                "SyncToken": "0",
                "MetaData": {
                    "CreateTime": inv["DueDate"] + "T12:00:00Z",
                    "LastUpdatedTime": inv["DueDate"] + "T12:00:00Z",
                },
            }
            payments[pay["Id"]] = pay
            inv["LinkedTxn"] = [{"TxnId": pay["Id"], "TxnType": "Payment"}]
    return payments, bill_payments


def _qbo_roll_balances(
    accounts, acct_by_num, vendors, customers, bills, invoices, expenses
):
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
                vendors[bill["VendorRef"]["value"]]["Balance"] + bill["Balance"], 2
            )
            accounts[ap]["CurrentBalance"] = round(
                accounts[ap]["CurrentBalance"] + bill["Balance"], 2
            )
        for line in bill["Line"]:
            detail = line.get("AccountBasedExpenseLineDetail")
            if detail:
                acct_id = detail["AccountRef"]["value"]
                accounts[acct_id]["CurrentBalance"] = round(
                    accounts[acct_id]["CurrentBalance"] + line["Amount"], 2
                )

    for inv in invoices.values():
        if inv["Balance"] > 0:
            customers[inv["CustomerRef"]["value"]]["Balance"] = round(
                customers[inv["CustomerRef"]["value"]]["Balance"] + inv["Balance"], 2
            )
            customers[inv["CustomerRef"]["value"]]["BalanceWithJobs"] = customers[
                inv["CustomerRef"]["value"]
            ]["Balance"]
            accounts[ar]["CurrentBalance"] = round(
                accounts[ar]["CurrentBalance"] + inv["Balance"], 2
            )
        income = acct_by_num["4000"]["Id"]
        for line in inv["Line"]:
            if line.get("DetailType") == "SalesItemLineDetail":
                accounts[income]["CurrentBalance"] = round(
                    accounts[income]["CurrentBalance"] + line["Amount"], 2
                )

    for expense in expenses.values():
        funding = expense["AccountRef"]["value"]
        accounts[funding]["CurrentBalance"] = round(
            accounts[funding]["CurrentBalance"] - expense["TotalAmt"], 2
        )
        for line in expense["Line"]:
            detail = line.get("AccountBasedExpenseLineDetail")
            if detail:
                acct_id = detail["AccountRef"]["value"]
                accounts[acct_id]["CurrentBalance"] = round(
                    accounts[acct_id]["CurrentBalance"] + line["Amount"], 2
                )

    accounts[bank]["CurrentBalance"] = round(
        accounts[bank]["CurrentBalance"] + 1_250_000.0, 2
    )
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
    "pdf": "application/pdf",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "tif": "image/tiff",
    "tiff": "image/tiff",
    "webp": "image/webp",
    "heic": "image/heic",
    "bmp": "image/bmp",
    "gif": "image/gif",
}

_INKWELL_MODELS = (
    (
        "invoice",
        "Invoice",
        "Accounts-payable invoices: supplier, totals, taxes, and line items.",
        "invoice-2026.02",
        0.971,
    ),
    (
        "receipt",
        "Receipt",
        "Expense receipts: merchant, payment method, tip, and totals.",
        "receipt-2026.01",
        0.958,
    ),
    (
        "credit_note",
        "Credit Note",
        "Supplier credit notes and memos carrying negative balances.",
        "invoice-2026.02",
        0.962,
    ),
    (
        "purchase_order",
        "Purchase Order",
        "Outbound purchase orders with ordered line items.",
        "po-2025.11",
        0.949,
    ),
    (
        "bank_statement",
        "Bank Statement",
        "Statements with opening and closing balances and transactions.",
        "statement-2025.09",
        0.933,
    ),
    (
        "w9",
        "Form W-9",
        "US taxpayer identification request forms.",
        "usforms-2025.07",
        0.981,
    ),
)
_INKWELL_MODEL_VERSION = {m[0]: m[3] for m in _INKWELL_MODELS}

_INKWELL_LINE_DESCS = (
    "Managed cloud hosting",
    "Professional services",
    "Software license — annual",
    "Freight and logistics",
    "Hardware components",
    "Consulting retainer",
    "Data processing fees",
    "Maintenance and support",
    "Marketing services",
    "Office supplies",
    "Network bandwidth",
    "Audit services",
    "Field installation",
)
_INKWELL_RETAIL_ITEMS = (
    "Coffee",
    "Sandwich",
    "Printer paper",
    "USB-C cable",
    "Taxi fare",
    "Parking",
    "Hotel night",
    "Lunch",
    "Stationery",
    "Toner cartridge",
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
        return {
            "status": "failed",
            "errorCode": "unreadable_document",
            "errorMessage": "The file could not be decoded; it appears corrupt or truncated.",
        }
    if has("encrypted", "password", "protected", "locked"):
        return {
            "status": "failed",
            "errorCode": "password_protected",
            "errorMessage": "The document is password protected and cannot be opened.",
        }
    if has("blank", "empty"):
        return {
            "status": "failed",
            "errorCode": "no_content_detected",
            "errorMessage": "No machine-readable content was detected in the document.",
        }

    document_type = model
    if has("receipt"):
        document_type = "receipt"
    elif has("creditnote", "credit_note", "credit-note", "creditmemo"):
        document_type = "credit_note"
    degraded = has("scan", "photo", "handwritten", "lowres", "low-res", "fax", "skewed")
    return {"status": "extracted", "documentType": document_type, "degraded": degraded}


def _inkwell_box(rng: random.Random) -> list[float]:
    return [
        round(rng.uniform(0.05, 0.55), 4),
        round(rng.uniform(0.04, 0.92), 4),
        round(rng.uniform(0.12, 0.38), 4),
        round(rng.uniform(0.012, 0.03), 4),
    ]


def _inkwell_field(rng: random.Random, value, page: int, base_conf: float) -> dict:
    conf = round(min(0.999, max(0.30, rng.gauss(base_conf, 0.025))), 3)
    return {
        "value": value,
        "confidence": conf,
        "page": page,
        "boundingBox": _inkwell_box(rng),
    }


def _inkwell_invoice(
    rng: random.Random, document_type: str, page_count: int, base_conf: float
) -> dict:
    country, currency = rng.choice(_COUNTRIES)
    last_page = max(1, page_count)
    sign = -1 if document_type == "credit_note" else 1
    line_items, subtotal = [], 0.0
    for _ in range(rng.randint(1, 6)):
        qty = rng.choice((1, 1, 2, 3, 5, 10, 12, 24))
        unit = round(rng.uniform(18.0, 4200.0), 2)
        amount = round(sign * qty * unit, 2)
        subtotal = round(subtotal + amount, 2)
        line_items.append(
            {
                "description": rng.choice(_INKWELL_LINE_DESCS),
                "productCode": f"SKU-{rng.randint(1000, 9999)}",
                "quantity": qty,
                "unitPrice": unit,
                "amount": amount,
                "confidence": round(
                    min(0.999, max(0.40, rng.gauss(base_conf, 0.04))), 3
                ),
            }
        )
    tax_rate = rng.choice((0.0, 0.05, 0.07, 0.0825, 0.19, 0.20))
    tax_amount = round(subtotal * tax_rate, 2)
    total = round(subtotal + tax_amount, 2)

    issued = _EPOCH + timedelta(days=rng.randint(-120, -3))
    term_days = rng.choice((15, 30, 45, 60))
    due = issued + timedelta(days=term_days)
    prefix = rng.choice(
        ("INV", "BILL", "AP", "CN" if document_type == "credit_note" else "INV")
    )
    supplier = _company(rng)
    account = "".join(rng.choice("0123456789") for _ in range(8))

    fields = {
        "supplierName": _inkwell_field(rng, supplier, 1, base_conf),
        "supplierTaxId": _inkwell_field(
            rng, f"{rng.randint(10, 99)}-{rng.randint(10**6, 10**7 - 1)}", 1, base_conf
        ),
        "supplierVatNumber": _inkwell_field(
            rng, f"{country}{rng.randint(10**8, 10**9 - 1)}", 1, base_conf
        ),
        "supplierAddress": _inkwell_field(
            rng,
            f"{rng.randint(1, 9999)} {rng.choice(_ROOTS)} Ave, {country}",
            1,
            base_conf,
        ),
        "supplierIban": _inkwell_field(
            rng, _iban(rng, country, account), last_page, base_conf
        ),
        "customerName": _inkwell_field(rng, "LynxCapital Holdings", 1, base_conf),
        "customerAddress": _inkwell_field(
            rng, "200 Lynx Plaza, New York, US", 1, base_conf
        ),
        "invoiceNumber": _inkwell_field(
            rng, f"{prefix}-{issued.year}-{rng.randint(1000, 9999)}", 1, base_conf
        ),
        "purchaseOrderNumber": _inkwell_field(
            rng, f"PO-{rng.randint(100000, 999999)}", 1, base_conf
        ),
        "invoiceDate": _inkwell_field(rng, issued.isoformat(), 1, base_conf),
        "dueDate": _inkwell_field(rng, due.isoformat(), 1, base_conf),
        "paymentTerms": _inkwell_field(rng, f"NET{term_days}", 1, base_conf),
        "currency": _inkwell_field(rng, currency, last_page, base_conf),
        "subtotal": _inkwell_field(rng, subtotal, last_page, base_conf),
        "taxAmount": _inkwell_field(rng, tax_amount, last_page, base_conf),
        "totalAmount": _inkwell_field(rng, total, last_page, base_conf),
        "amountDue": _inkwell_field(rng, total, last_page, base_conf),
    }
    taxes = [
        {
            "code": "VAT" if tax_rate else "EXEMPT",
            "rate": tax_rate,
            "base": subtotal,
            "amount": tax_amount,
        }
    ]
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
        line_items.append(
            {
                "description": rng.choice(_INKWELL_RETAIL_ITEMS),
                "quantity": qty,
                "unitPrice": unit,
                "amount": amount,
                "confidence": round(
                    min(0.999, max(0.40, rng.gauss(base_conf, 0.05))), 3
                ),
            }
        )
    tax_rate = rng.choice((0.0, 0.07, 0.0825, 0.20))
    tax_amount = round(subtotal * tax_rate, 2)
    tip = round(subtotal * rng.choice((0.0, 0.0, 0.1, 0.15, 0.18)), 2)
    total = round(subtotal + tax_amount + tip, 2)
    method = rng.choice(_INKWELL_PAY_METHODS)
    purchased = _EPOCH + timedelta(days=rng.randint(-90, -1))

    fields = {
        "merchantName": _inkwell_field(rng, _company(rng), 1, base_conf),
        "merchantAddress": _inkwell_field(
            rng,
            f"{rng.randint(1, 999)} {rng.choice(_ROOTS)} St, {country}",
            1,
            base_conf,
        ),
        "transactionDate": _inkwell_field(rng, purchased.isoformat(), 1, base_conf),
        "transactionTime": _inkwell_field(
            rng, f"{rng.randint(7, 21):02d}:{rng.randint(0, 59):02d}", 1, base_conf
        ),
        "paymentMethod": _inkwell_field(rng, method, 1, base_conf),
        "cardLast4": _inkwell_field(
            rng, "" if method == "CASH" else f"{rng.randint(0, 9999):04d}", 1, base_conf
        ),
        "currency": _inkwell_field(rng, currency, 1, base_conf),
        "subtotal": _inkwell_field(rng, subtotal, 1, base_conf),
        "taxAmount": _inkwell_field(rng, tax_amount, 1, base_conf),
        "tip": _inkwell_field(rng, tip, 1, base_conf),
        "totalAmount": _inkwell_field(rng, total, 1, base_conf),
    }
    taxes = [
        {
            "code": "SALES_TAX" if tax_rate else "EXEMPT",
            "rate": tax_rate,
            "base": subtotal,
            "amount": tax_amount,
        }
    ]
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
        base.update(
            {
                "status": "failed",
                "documentType": "unknown",
                "confidence": 0.0,
                "needsReview": True,
                "reviewReasons": [outcome["errorCode"]],
                "error": {
                    "code": outcome["errorCode"],
                    "message": outcome["errorMessage"],
                },
                "locale": None,
                "fields": {},
                "lineItems": [],
                "taxes": [],
            }
        )
        return base

    document_type = outcome["documentType"]
    degraded = outcome["degraded"]
    base_conf = rng.uniform(0.62, 0.78) if degraded else rng.uniform(0.90, 0.985)
    body = (
        _inkwell_receipt(rng, base["pageCount"], base_conf)
        if document_type == "receipt"
        else _inkwell_invoice(rng, document_type, base["pageCount"], base_conf)
    )

    fields = body["fields"]
    confs = [f["confidence"] for f in fields.values()]
    overall = round(sum(confs) / len(confs), 3) if confs else 0.0
    reasons: list[str] = []
    if overall < _INKWELL_REVIEW_THRESHOLD:
        reasons.append("low_overall_confidence")
    low = sorted(
        k for k, f in fields.items() if f["confidence"] < _INKWELL_FIELD_THRESHOLD
    )
    if low:
        reasons.append("low_field_confidence:" + ",".join(low))
    if degraded:
        reasons.append("image_quality_degraded")

    base.update(
        {
            "status": "needs_review" if reasons else "extracted",
            "documentType": document_type,
            "locale": body["locale"],
            "confidence": overall,
            "needsReview": bool(reasons),
            "reviewReasons": reasons,
            "fields": fields,
            "lineItems": body["lineItems"],
            "taxes": body["taxes"],
        }
    )
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
    return {
        "documents": documents,
        "extractions": extractions,
        "models": inkwell_models(),
    }


def index_by(records: list[dict], key: str = "id") -> dict[str, dict]:
    return {r[key]: r for r in records}


# --------------------------------------------------------------------------- #
# Aegis Screening — sanctions / AML / KYB reference data
# --------------------------------------------------------------------------- #
_AEGIS_WATCHLISTS = (
    ("ofac-sdn", "OFAC SDN", "US Treasury OFAC", "sanctions", "US"),
    (
        "ofac-consolidated",
        "OFAC Consolidated (Non-SDN)",
        "US Treasury OFAC",
        "sanctions",
        "US",
    ),
    (
        "eu-consolidated",
        "EU Consolidated Sanctions List",
        "European Union",
        "sanctions",
        "EU",
    ),
    (
        "un-sc",
        "UN Security Council Consolidated List",
        "United Nations",
        "sanctions",
        "Global",
    ),
    ("uk-ofsi", "UK OFSI Consolidated List", "HM Treasury", "sanctions", "GB"),
    ("bis-dpl", "BIS Denied Persons List", "US BIS", "sanctions", "US"),
    ("pep-global", "Global PEP Database", "Aegis Intelligence", "pep", "Global"),
    (
        "adverse-media",
        "Adverse Media Index",
        "Aegis Media Intelligence",
        "adverse_media",
        "Global",
    ),
    ("interpol-red", "Interpol Red Notices", "Interpol", "law_enforcement", "Global"),
)

# High-risk and sanctioned jurisdictions weighted up by the risk model.
AEGIS_HIGH_RISK = ("IR", "KP", "SY", "RU", "BY", "CU", "VE", "MM")

# Deterministic fictional watchlist subjects for the simulated ecosystem. Each
# screening that resolves to one of these produces a true exact/strong match.
_AEGIS_SANCTIONED = (
    (
        "Oblast Holdings LLC",
        "organization",
        "RU",
        ("ofac-sdn", "eu-consolidated"),
        ("SANCTIONS",),
        "BLOCKING",
        ("Oblast Group", "OOO Oblast"),
    ),
    (
        "Rubicon Maritime Trading",
        "organization",
        "IR",
        ("ofac-sdn", "un-sc"),
        ("SANCTIONS",),
        "BLOCKING",
        ("Rubicon Shipping",),
    ),
    (
        "Crimson Star Logistics",
        "organization",
        "KP",
        ("un-sc", "ofac-sdn"),
        ("SANCTIONS",),
        "BLOCKING",
        ("Crimson Star Co",),
    ),
    (
        "Pyotr Vasiliev",
        "individual",
        "RU",
        ("ofac-sdn", "uk-ofsi"),
        ("SANCTIONS", "PEP"),
        "BLOCKING",
        ("P. Vasiliev", "Pyotr Vasilyev"),
    ),
    (
        "Damascus Freight Forwarders",
        "organization",
        "SY",
        ("eu-consolidated", "ofac-sdn"),
        ("SANCTIONS",),
        "BLOCKING",
        (),
    ),
    (
        "Aurelio Mancuso",
        "individual",
        "VE",
        ("ofac-sdn",),
        ("SANCTIONS", "ADVERSE_MEDIA"),
        "BLOCKING",
        ("A. Mancuso",),
    ),
    (
        "Minsk Industrial Combine",
        "organization",
        "BY",
        ("eu-consolidated", "uk-ofsi"),
        ("SANCTIONS",),
        "SECTORAL",
        (),
    ),
    (
        "Helena Brandt",
        "individual",
        "DE",
        ("pep-global",),
        ("PEP",),
        None,
        ("H. Brandt",),
    ),
    (
        "Tobias Lindqvist",
        "individual",
        "SE",
        ("pep-global", "adverse-media"),
        ("PEP", "ADVERSE_MEDIA"),
        None,
        (),
    ),
    (
        "Cobalt Reach Ventures",
        "organization",
        "VG",
        ("adverse-media",),
        ("ADVERSE_MEDIA",),
        None,
        ("Cobalt Reach",),
    ),
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
            "listId": lid,
            "name": name,
            "source": source,
            "type": kind,
            "jurisdiction": juris,
            "recordCount": rng.randint(1800, 41000),
            "lastUpdatedAt": _instant(rng, 1, 30),
            "refreshFrequency": "daily",
        }

    sanctioned: list[dict] = []
    for idx, (name, etype, country, lists, programs, stype, aliases) in enumerate(
        _AEGIS_SANCTIONED
    ):
        rng = _rng(seed, "sanctioned", idx)
        record = {
            "entityId": f"ent_wl_{idx:04d}",
            "legalName": name,
            "type": etype,
            "country": country,
            "aliases": list(aliases),
            "watchlists": list(lists),
            "programs": list(programs),
            "sanctionType": stype,
            "listedAt": _day(rng, -900, -120),
            "source": "watchlist",
            "verificationStatus": "watchlisted",
            "status": "active",
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
            owners.append(
                {
                    "name": _person(rng),
                    "ownershipPercent": share,
                    "country": rng.choice(_COUNTRIES)[0],
                    "isPep": rng.random() < 0.08,
                    "verified": rng.random() < 0.85,
                }
            )
            if remaining <= 0:
                break
        businesses.append(
            {
                "entityId": f"ent_biz_{i:04d}",
                "legalName": legal,
                "type": "organization",
                "country": country,
                "registrationNumber": _aegis_registration(rng, country),
                "incorporationDate": _day(rng, -6000, -400),
                "registeredAddress": {
                    "line1": f"{rng.randint(1, 400)} {rng.choice(_ROOTS)} Street",
                    "city": rng.choice(_ROOTS),
                    "country": country,
                    "postalCode": f"{rng.randint(10000, 99999)}",
                },
                "industryCode": rng.choice(_MERCHANT_CATEGORIES)[0],
                "status": "dissolved" if dissolved else "active",
                "beneficialOwners": owners,
                "directors": [
                    {"name": _person(rng), "role": "Director"}
                    for _ in range(rng.randint(1, 2))
                ],
                "aliases": [],
                "watchlists": [],
                "programs": [],
                "verificationStatus": "unverified",
                "source": "registry",
            }
        )

    return {
        "watchlists": watchlists,
        "sanctioned": sanctioned,
        "businesses": businesses,
    }


# --------------------------------------------------------------------------- #
# Verafin Monitor — transaction monitoring / BSA-AML regulatory reference data
# --------------------------------------------------------------------------- #
# Monitoring typologies and the weight each contributes to the 0-100 alert score.
_VERAFIN_TYPOLOGIES = (
    ("structuring", "Structuring / smurfing below reporting threshold", 38),
    ("rapid_movement", "Rapid movement of funds (pass-through)", 30),
    ("high_risk_geo", "Exposure to a high-risk jurisdiction", 28),
    ("round_amount", "Round-amount layering pattern", 16),
    ("velocity", "Account velocity spike", 22),
    ("dormant_reactivation", "Reactivation of a dormant account", 20),
    ("cash_intensive", "Cash-intensive activity", 24),
)

# Jurisdictions FinCEN/FATF treats as higher risk; lifts the monitoring score.
_VERAFIN_HIGH_RISK = ("IR", "KP", "SY", "RU", "BY", "CU", "VE", "MM", "AF")

# BSA reporting thresholds (USD) the rules engine references.
_VERAFIN_CTR_THRESHOLD = 10_000
_VERAFIN_SAR_THRESHOLD = 5_000

# Channels carry different inherent monitoring risk.
VERAFIN_CHANNELS = ("wire", "ach", "card", "cash", "check", "crypto", "internal")

# Regulatory and internal controls the program attests to each cycle.
_VERAFIN_CONTROLS = (
    (
        "ctrl-bsa-program",
        "BSA/AML Compliance Program",
        "31 CFR 1020.210",
        "quarterly",
        "Board-approved program covering the four pillars.",
    ),
    (
        "ctrl-sar-timeliness",
        "SAR Filing Timeliness",
        "31 CFR 1020.320",
        "monthly",
        "SARs filed within 30 days of detection.",
    ),
    (
        "ctrl-ctr-accuracy",
        "CTR Filing Accuracy",
        "31 CFR 1010.311",
        "monthly",
        "CTRs filed within 15 days for cash over $10,000.",
    ),
    (
        "ctrl-ofac-screening",
        "OFAC Sanctions Screening",
        "31 CFR 501",
        "monthly",
        "Real-time interdiction against OFAC lists.",
    ),
    (
        "ctrl-cdd",
        "Customer Due Diligence / Beneficial Ownership",
        "31 CFR 1010.230",
        "quarterly",
        "CDD and 25% beneficial-ownership collection.",
    ),
    (
        "ctrl-model-validation",
        "Monitoring Model Validation",
        "FFIEC BSA/AML Manual",
        "annual",
        "Independent validation of detection thresholds.",
    ),
    (
        "ctrl-independent-test",
        "Independent Testing",
        "31 CFR 1020.210(b)(4)",
        "annual",
        "Independent audit of the AML program.",
    ),
)


def verafin_reference(seed: str) -> dict:
    """Build monitored customers and accounts, the typology rule set, and the
    regulatory control catalogue the monitoring and filing engine operates on."""
    typologies = [
        {"code": code, "description": desc, "weight": weight}
        for code, desc, weight in _VERAFIN_TYPOLOGIES
    ]

    controls: dict[str, dict] = {}
    for cid, name, citation, cadence, desc in _VERAFIN_CONTROLS:
        rng = _rng(seed, "control", cid)
        controls[cid] = {
            "controlId": cid,
            "name": name,
            "regulatoryCitation": citation,
            "framework": "FFIEC BSA/AML",
            "cadence": cadence,
            "description": desc,
            "owner": f"{_person(rng).split()[0].lower()}.compliance@verafin.test",
            "lastAttestedAt": None,
            "effectiveness": "not_yet_attested",
        }

    customers: dict[str, dict] = {}
    accounts: dict[str, dict] = {}
    risk_pool = ("low",) * 5 + ("medium",) * 3 + ("high",) * 2
    for i in range(14):
        rng = _rng(seed, "customer", i)
        country, currency = rng.choice(_COUNTRIES)
        if rng.random() < 0.18:
            country = rng.choice(_VERAFIN_HIGH_RISK)
        is_org = rng.random() < 0.7
        cust_id = f"cust_{i:04d}"
        rating = rng.choice(risk_pool)
        if country in _VERAFIN_HIGH_RISK and rating == "low":
            rating = "medium"
        customers[cust_id] = {
            "customerId": cust_id,
            "legalName": _company(rng) if is_org else _person(rng),
            "type": "organization" if is_org else "individual",
            "country": country,
            "kycRiskRating": rating,
            "kycReviewedAt": _day(rng, -400, -20),
            "onboardedAt": _day(rng, -2400, -420),
            "industryCode": rng.choice(_MERCHANT_CATEGORIES)[0] if is_org else None,
            "isCashIntensive": is_org and rng.random() < 0.25,
            "status": "active",
        }
        for a in range(rng.randint(1, 2)):
            acct_id = f"acct_{i:04d}_{a}"
            kind = rng.choice(("operating", "escrow", "payroll", "settlement"))
            accounts[acct_id] = {
                "accountId": acct_id,
                "customerId": cust_id,
                "type": kind,
                "currency": currency,
                "openedAt": customers[cust_id]["onboardedAt"],
                "status": "dormant" if rng.random() < 0.1 else "active",
                "averageMonthlyVolume": rng.randint(20_000, 4_000_000),
            }

    return {
        "typologies": typologies,
        "controls": controls,
        "customers": customers,
        "accounts": accounts,
        "ctrThreshold": _VERAFIN_CTR_THRESHOLD,
        "sarThreshold": _VERAFIN_SAR_THRESHOLD,
        "highRisk": list(_VERAFIN_HIGH_RISK),
    }


# --------------------------------------------------------------------------- #
# Beacon CRM — accounts, contacts, deal pipeline, activities, notes, relations
# --------------------------------------------------------------------------- #
# A HubSpot/Pipedrive-style customer and vendor relationship dataset: companies
# (accounts) hold people (contacts), deals move through a single sales pipeline
# whose stages carry win probabilities, and the engagement history is captured
# as activities and notes. Contact-to-contact relationships model the buying
# committee inside an account.
_CRM_INDUSTRIES = (
    "Software",
    "Manufacturing",
    "Logistics",
    "Financial Services",
    "Retail",
    "Healthcare",
    "Energy",
    "Telecommunications",
    "Media",
    "Construction",
    "Hospitality",
    "Agriculture",
)
_CRM_JOB_TITLES = (
    "Chief Financial Officer",
    "VP Finance",
    "Procurement Manager",
    "Accounts Payable Lead",
    "Head of Operations",
    "Treasury Analyst",
    "Financial Controller",
    "Founder",
    "Director of Sales",
    "Office Manager",
    "Head of Procurement",
    "Operations Analyst",
)
_CRM_SOURCES = ("inbound", "referral", "outbound", "event", "partner", "website")
_CRM_LIFECYCLE = ("lead", "qualified", "customer", "vendor", "churned")
_CRM_LEAD_STATUS = ("new", "open", "in_progress", "connected", "unqualified")
_CRM_ACCOUNT_TYPES = ("customer", "prospect", "partner", "vendor")
_CRM_TIERS = ("smb", "mid_market", "enterprise")
_CRM_TAGS = (
    "vip",
    "newsletter",
    "decision_maker",
    "budget_holder",
    "technical",
    "champion",
    "renewal_risk",
)
_CRM_DEAL_THEMES = (
    "Annual Platform Renewal",
    "Expansion — Additional Seats",
    "New Implementation",
    "Managed Services Agreement",
    "Pilot Program",
    "Hardware Refresh",
    "Premium Support Upgrade",
    "Multi-Year Commitment",
)
_CRM_LOST_REASONS = (
    "budget",
    "lost_to_competitor",
    "no_decision",
    "timing",
    "lost_to_incumbent",
    "no_budget_holder",
)
_CRM_ACTIVITY_TYPES = ("call", "email", "meeting", "note", "task")
_CRM_ACTIVITY_OUTCOMES = (
    "connected",
    "left_voicemail",
    "no_answer",
    "scheduled_follow_up",
    "completed",
)
_CRM_RELATIONSHIP_TYPES = (
    "reports_to",
    "works_with",
    "introduced_by",
    "decision_maker_for",
)

CRM_PIPELINE = "sales"
# Ordered pipeline stages with the win probability each implies.
CRM_STAGES = (
    ("prospect", 10),
    ("qualified", 25),
    ("proposal", 50),
    ("negotiation", 70),
    ("won", 100),
    ("lost", 0),
)


def _crm_account(seed: str, idx: int) -> dict:
    rng = _rng(seed, "crm_account", idx)
    name = _company(rng)
    country, currency = rng.choice(_COUNTRIES)
    tier = rng.choices(_CRM_TIERS, weights=(6, 3, 1))[0]
    employees = {
        "smb": rng.randint(5, 200),
        "mid_market": rng.randint(200, 2_000),
        "enterprise": rng.randint(2_000, 50_000),
    }[tier]
    domain = f"{_slug(name).split('-')[0]}.example"
    return {
        "id": f"ACC-{idx:04d}",
        "name": name,
        "domain": domain,
        "website": f"https://www.{domain}",
        "industry": rng.choice(_CRM_INDUSTRIES),
        "accountType": rng.choices(_CRM_ACCOUNT_TYPES, weights=(4, 3, 1, 2))[0],
        "tier": tier,
        "employeeCount": employees,
        "annualRevenue": employees * rng.randint(80_000, 220_000),
        "currency": currency,
        "country": country,
        "phone": _phone(rng, country),
        "ownerId": f"USR-{rng.randint(1, 25):03d}",
        "openDealCount": 0,
        "createdAt": _instant(rng, -540, -120),
        "updatedAt": _instant(rng, -110, -1),
    }


def _crm_contact(seed: str, idx: int, account: dict, primary: bool) -> dict:
    rng = _rng(seed, "crm_contact", idx)
    first, last = rng.choice(_FIRST), rng.choice(_LAST)
    tags = rng.sample(_CRM_TAGS, rng.randint(0, 3))
    if primary and "decision_maker" not in tags:
        tags.append("decision_maker")
    return {
        "id": f"CONT-{idx:05d}",
        "firstName": first,
        "lastName": last,
        "email": f"{first.lower()}.{last.lower()}@{account['domain']}",
        "phone": _phone(rng, account["country"]),
        "jobTitle": rng.choice(_CRM_JOB_TITLES),
        "company": account["name"],
        "accountId": account["id"],
        "lifecycleStage": rng.choice(_CRM_LIFECYCLE),
        "leadStatus": rng.choice(_CRM_LEAD_STATUS),
        "source": rng.choice(_CRM_SOURCES),
        "ownerId": account["ownerId"],
        "tags": tags,
        "country": account["country"],
        "isPrimary": primary,
        "createdAt": _instant(rng, -400, -40),
        "updatedAt": _instant(rng, -39, -1),
        "lastActivityAt": _instant(rng, -39, -1),
    }


def _crm_deal(seed: str, idx: int, account: dict, contact: dict) -> dict:
    rng = _rng(seed, "crm_deal", idx)
    stage, probability = rng.choice(CRM_STAGES)
    status = {"won": "won", "lost": "lost"}.get(stage, "open")
    created = _instant(rng, -300, -25)
    deal = {
        "id": f"DEAL-{idx:05d}",
        "title": f"{account['name']} — {rng.choice(_CRM_DEAL_THEMES)}",
        "accountId": account["id"],
        "contactId": contact["id"],
        "pipeline": CRM_PIPELINE,
        "stage": stage,
        "status": status,
        "amount": round(rng.uniform(5_000, 400_000), 2),
        "currency": account["currency"],
        "probability": probability,
        "expectedCloseDate": _day(rng, -20, 120),
        "ownerId": account["ownerId"],
        "source": rng.choice(_CRM_SOURCES),
        "createdAt": created,
        "updatedAt": _instant(rng, -24, -1),
    }
    if status == "won":
        deal["wonAt"] = deal["updatedAt"]
        deal["closedAt"] = deal["updatedAt"]
    elif status == "lost":
        deal["lostReason"] = rng.choice(_CRM_LOST_REASONS)
        deal["closedAt"] = deal["updatedAt"]
    return deal


def _crm_activity(seed: str, idx: int, contact: dict, deal_id: str | None) -> dict:
    rng = _rng(seed, "crm_activity", idx)
    kind = rng.choice(_CRM_ACTIVITY_TYPES)
    at = _instant(rng, -120, -1)
    activity = {
        "activityId": f"ACT-{idx:06d}",
        "type": kind,
        "contactId": contact["id"],
        "accountId": contact["accountId"],
        "dealId": deal_id,
        "subject": f"{kind.title()} with {contact['firstName']} {contact['lastName']}",
        "summary": f"{kind.title()} logged for {contact['company']}.",
        "direction": rng.choice(("inbound", "outbound")),
        "outcome": rng.choice(_CRM_ACTIVITY_OUTCOMES),
        "ownerId": contact["ownerId"],
        "at": at,
        "createdAt": at,
    }
    if kind in ("call", "meeting"):
        activity["durationMinutes"] = rng.choice((15, 30, 45, 60))
    return activity


def _crm_note(seed: str, idx: int, contact: dict, deal_id: str | None) -> dict:
    rng = _rng(seed, "crm_note", idx)
    bodies = (
        f"Spoke with {contact['firstName']} about renewal terms and timeline.",
        f"{contact['company']} requested an updated proposal and payment schedule.",
        "Budget approval pending with finance; revisit next quarter.",
        "Confirmed technical requirements with the operations team.",
        "Champion is supportive; needs sign-off from the CFO.",
    )
    created = _instant(rng, -110, -1)
    return {
        "noteId": f"NOTE-{idx:06d}",
        "contactId": contact["id"],
        "accountId": contact["accountId"],
        "dealId": deal_id,
        "body": rng.choice(bodies),
        "ownerId": contact["ownerId"],
        "createdAt": created,
    }


def crm_dataset(seed: str) -> dict[str, dict]:
    """Build a coherent CRM book of business: accounts each holding a small
    buying committee of contacts, an open/won/lost deal pipeline linked to the
    primary contact, and the seeded engagement history (activities, notes) and
    contact-to-contact relationships that a real CRM accumulates over time."""
    accounts: dict[str, dict] = {}
    contacts: dict[str, dict] = {}
    deals: dict[str, dict] = {}
    activities: dict[str, dict] = {}
    notes: dict[str, dict] = {}
    relationships: dict[str, dict] = {}

    contact_idx = deal_idx = act_idx = note_idx = rel_idx = 0
    for a in range(1, 91):
        account = _crm_account(seed, a)
        accounts[account["id"]] = account
        rng = _rng(seed, "crm_account_fill", a)

        committee: list[dict] = []
        for member in range(rng.randint(1, 4)):
            contact_idx += 1
            contact = _crm_contact(seed, contact_idx, account, primary=(member == 0))
            contacts[contact["id"]] = contact
            committee.append(contact)

        primary = committee[0]
        for member in committee[1:]:
            rel_idx += 1
            relationships[f"REL-{rel_idx:05d}"] = {
                "relationshipId": f"REL-{rel_idx:05d}",
                "type": rng.choice(_CRM_RELATIONSHIP_TYPES),
                "fromContactId": member["id"],
                "toContactId": primary["id"],
                "accountId": account["id"],
                "createdAt": member["createdAt"],
            }

        deal_id = None
        for _ in range(rng.randint(0, 2)):
            deal_idx += 1
            deal = _crm_deal(seed, deal_idx, account, primary)
            deals[deal["id"]] = deal
            deal_id = deal["id"]
            if deal["status"] == "open":
                account["openDealCount"] += 1

        for member in committee:
            for _ in range(_rng(seed, "crm_hist", member["id"]).randint(0, 3)):
                act_idx += 1
                activity = _crm_activity(seed, act_idx, member, deal_id)
                activities[activity["activityId"]] = activity
            if rng.random() < 0.5:
                note_idx += 1
                note = _crm_note(seed, note_idx, member, deal_id)
                notes[note["noteId"]] = note

    return {
        "accounts": accounts,
        "contacts": contacts,
        "deals": deals,
        "activities": activities,
        "notes": notes,
        "relationships": relationships,
    }


# --------------------------------------------------------------------------- #
# Sabre Tax — tax determination reference data
# US sales/use tax rolls up state + county + city + special district components;
# international transaction tax is a single VAT/GST/consumption rate. Withholding
# follows the US FDAP model: a 30% statutory rate reduced by bilateral treaties,
# 24% backup withholding on undocumented domestic payees, and FATCA chapter-4.
# --------------------------------------------------------------------------- #

# region -> {state, county (name, rate), city (name, rate), special (name, rate)}
_SABRE_US_JURISDICTIONS = {
    "CA": {
        "stateName": "CALIFORNIA",
        "stateRate": 0.0600,
        "county": ("ORANGE", 0.0025),
        "city": ("IRVINE", 0.0000),
        "special": ("ORANGE CO LOCAL TAX SL", 0.0150),
    },
    "NY": {
        "stateName": "NEW YORK",
        "stateRate": 0.0400,
        "county": ("NEW YORK", 0.0000),
        "city": ("NEW YORK CITY", 0.0450),
        "special": ("MCTD", 0.00375),
    },
    "TX": {
        "stateName": "TEXAS",
        "stateRate": 0.0625,
        "county": ("TRAVIS", 0.0000),
        "city": ("AUSTIN", 0.0100),
        "special": ("AUSTIN MTA TRANSIT", 0.0100),
    },
    "WA": {
        "stateName": "WASHINGTON",
        "stateRate": 0.0650,
        "county": ("KING", 0.0000),
        "city": ("SEATTLE", 0.0375),
        "special": ("", 0.0000),
    },
    "IL": {
        "stateName": "ILLINOIS",
        "stateRate": 0.0625,
        "county": ("COOK", 0.0175),
        "city": ("CHICAGO", 0.0125),
        "special": ("RTA", 0.0100),
    },
    "FL": {
        "stateName": "FLORIDA",
        "stateRate": 0.0600,
        "county": ("MIAMI-DADE", 0.0100),
        "city": ("", 0.0000),
        "special": ("", 0.0000),
    },
    "CO": {
        "stateName": "COLORADO",
        "stateRate": 0.0290,
        "county": ("", 0.0000),
        "city": ("DENVER", 0.0481),
        "special": ("RTD", 0.0110),
    },
    "MA": {
        "stateName": "MASSACHUSETTS",
        "stateRate": 0.0625,
        "county": ("", 0.0000),
        "city": ("", 0.0000),
        "special": ("", 0.0000),
    },
    "GA": {
        "stateName": "GEORGIA",
        "stateRate": 0.0400,
        "county": ("FULTON", 0.0300),
        "city": ("ATLANTA", 0.0150),
        "special": ("", 0.0000),
    },
}

# ISO country -> single transaction-tax (VAT/GST/consumption) regime
_SABRE_COUNTRY_TAX = {
    "GB": {
        "taxType": "VAT",
        "taxName": "UNITED KINGDOM VAT",
        "standardRate": 0.20,
        "reducedRates": {"reduced": 0.05, "zero": 0.0},
        "currency": "GBP",
    },
    "DE": {
        "taxType": "VAT",
        "taxName": "GERMANY VAT (USt)",
        "standardRate": 0.19,
        "reducedRates": {"reduced": 0.07},
        "currency": "EUR",
    },
    "FR": {
        "taxType": "VAT",
        "taxName": "FRANCE TVA",
        "standardRate": 0.20,
        "reducedRates": {"reduced": 0.10, "super_reduced": 0.055},
        "currency": "EUR",
    },
    "NL": {
        "taxType": "VAT",
        "taxName": "NETHERLANDS BTW",
        "standardRate": 0.21,
        "reducedRates": {"reduced": 0.09},
        "currency": "EUR",
    },
    "IE": {
        "taxType": "VAT",
        "taxName": "IRELAND VAT",
        "standardRate": 0.23,
        "reducedRates": {"reduced": 0.135, "second_reduced": 0.09},
        "currency": "EUR",
    },
    "SG": {
        "taxType": "GST",
        "taxName": "SINGAPORE GST",
        "standardRate": 0.09,
        "reducedRates": {},
        "currency": "SGD",
    },
    "JP": {
        "taxType": "JCT",
        "taxName": "JAPAN CONSUMPTION TAX",
        "standardRate": 0.10,
        "reducedRates": {"reduced": 0.08},
        "currency": "JPY",
    },
    "BR": {
        "taxType": "ICMS",
        "taxName": "BRAZIL ICMS",
        "standardRate": 0.17,
        "reducedRates": {"interstate": 0.12, "interstate_south": 0.07},
        "currency": "BRL",
    },
    "IN": {
        "taxType": "GST",
        "taxName": "INDIA GST (CGST+SGST)",
        "standardRate": 0.18,
        "reducedRates": {"merit": 0.05, "standard_merit": 0.12, "demerit": 0.28},
        "currency": "INR",
        "split": ("CGST", "SGST"),
    },
    "CA": {
        "taxType": "GST",
        "taxName": "CANADA GST",
        "standardRate": 0.05,
        "reducedRates": {},
        "currency": "CAD",
    },
    "AU": {
        "taxType": "GST",
        "taxName": "AUSTRALIA GST",
        "standardRate": 0.10,
        "reducedRates": {},
        "currency": "AUD",
    },
}

# (code, category, description, taxableByDefault)
_SABRE_TAX_CODES = (
    ("P0000000", "Tangible Personal Property", "General tangible goods", True),
    ("NT", "Non-Taxable", "Explicitly non-taxable line", False),
    ("FR020100", "Freight", "Shipping and freight charges", True),
    ("FR010000", "Delivery", "Delivery charges", True),
    (
        "SW054000",
        "Software as a Service",
        "Cloud-delivered / subscription software",
        True,
    ),
    ("SW050000", "Software (downloaded)", "Electronically delivered software", True),
    ("SW052000", "Software (canned)", "Pre-written packaged software", True),
    ("DC010200", "Digital Content", "Digital downloads (music, video, ebooks)", True),
    (
        "SC016100",
        "Professional Services",
        "Consulting, professional and IT services",
        False,
    ),
    ("SC110000", "Maintenance and Support", "Hardware maintenance and support", True),
    ("OF010000", "Office Supplies", "General office products", True),
    ("OE040000", "Computer Hardware", "Computers and peripherals", True),
    ("PS081282", "Yarn and Fiber", "Knitting yarn", True),
    ("FD000000", "Food and Grocery", "General unprepared food items", False),
    ("CL000000", "Clothing", "General apparel", True),
    ("PH000000", "Pharmaceuticals", "Prescription drugs", False),
)
_SABRE_TAX_CODE_INDEX = {row[0]: row for row in _SABRE_TAX_CODES}

# country -> tax-identifier validation rule (format + VIES/national-registry source)
_SABRE_TAXID_RULES = {
    "US": {
        "taxType": "EIN",
        "format": "NN-NNNNNNN",
        "pattern": r"^\d{2}-?\d{7}$",
        "source": "IRS TIN Matching",
    },
    "GB": {
        "taxType": "VAT",
        "format": "GB999999999",
        "pattern": r"^GB\d{9}(\d{3})?$",
        "source": "HMRC",
    },
    "DE": {
        "taxType": "VAT",
        "format": "DE999999999",
        "pattern": r"^DE\d{9}$",
        "source": "VIES",
    },
    "FR": {
        "taxType": "VAT",
        "format": "FRXX999999999",
        "pattern": r"^FR[A-Z0-9]{2}\d{9}$",
        "source": "VIES",
    },
    "NL": {
        "taxType": "VAT",
        "format": "NL999999999B99",
        "pattern": r"^NL\d{9}B\d{2}$",
        "source": "VIES",
    },
    "IT": {
        "taxType": "VAT",
        "format": "IT99999999999",
        "pattern": r"^IT\d{11}$",
        "source": "VIES",
    },
    "ES": {
        "taxType": "VAT",
        "format": "ESX9999999X",
        "pattern": r"^ES[A-Z0-9]\d{7}[A-Z0-9]$",
        "source": "VIES",
    },
    "IE": {
        "taxType": "VAT",
        "format": "IE9X99999X",
        "pattern": r"^IE\d[A-Z0-9]\d{5}[A-Z]{1,2}$",
        "source": "VIES",
    },
    "SG": {
        "taxType": "GST",
        "format": "M99999999X",
        "pattern": r"^[A-Z]\d{8}[A-Z]$",
        "source": "IRAS",
    },
    "IN": {
        "taxType": "GSTIN",
        "format": "99XXXXX9999X9ZX",
        "pattern": r"^\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z0-9]$",
        "source": "GSTN",
    },
    "BR": {
        "taxType": "CNPJ",
        "format": "99.999.999/9999-99",
        "pattern": r"^\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2}$",
        "source": "Receita Federal",
    },
    "JP": {
        "taxType": "CN",
        "format": "9999999999999",
        "pattern": r"^\d{13}$",
        "source": "National Tax Agency",
    },
    "CA": {
        "taxType": "BN",
        "format": "999999999RT9999",
        "pattern": r"^\d{9}(RT\d{4})?$",
        "source": "Canada Revenue Agency",
    },
}

# US FDAP withholding constants and the 1042-S income-code map
_SABRE_WHT_STATUTORY = 0.30
_SABRE_WHT_BACKUP = 0.24
_SABRE_WHT_FATCA = 0.30
_SABRE_INCOME_CODES = {
    "interest": "01",
    "dividends": "06",
    "rents": "14",
    "royalties": "12",
    "royalties_industrial": "10",
    "services": "17",
    "independent_services": "16",
    "scholarship": "16",
}

# payee country -> bilateral treaty: income type -> (treatyRate, treatyArticle).
# Countries with no US income-tax treaty (BR, SG) are intentionally absent so the
# 30% statutory rate applies.
_SABRE_TREATY = {
    "DE": {
        "name": "U.S.-Germany Income Tax Treaty",
        "rates": {
            "dividends": (0.15, "Article 10"),
            "interest": (0.0, "Article 11"),
            "royalties": (0.0, "Article 12"),
            "services": (0.0, "Article 7"),
            "rents": (0.0, "Article 6"),
        },
    },
    "GB": {
        "name": "U.S.-U.K. Income Tax Treaty",
        "rates": {
            "dividends": (0.15, "Article 10"),
            "interest": (0.0, "Article 11"),
            "royalties": (0.0, "Article 12"),
            "services": (0.0, "Article 7"),
            "rents": (0.0, "Article 6"),
        },
    },
    "FR": {
        "name": "U.S.-France Income Tax Treaty",
        "rates": {
            "dividends": (0.15, "Article 10"),
            "interest": (0.0, "Article 11"),
            "royalties": (0.0, "Article 12"),
            "services": (0.0, "Article 7"),
            "rents": (0.0, "Article 6"),
        },
    },
    "NL": {
        "name": "U.S.-Netherlands Income Tax Treaty",
        "rates": {
            "dividends": (0.15, "Article 10"),
            "interest": (0.0, "Article 12"),
            "royalties": (0.0, "Article 13"),
            "services": (0.0, "Article 7"),
        },
    },
    "CA": {
        "name": "U.S.-Canada Income Tax Treaty",
        "rates": {
            "dividends": (0.15, "Article X"),
            "interest": (0.0, "Article XI"),
            "royalties": (0.10, "Article XII"),
            "services": (0.0, "Article VII"),
        },
    },
    "JP": {
        "name": "U.S.-Japan Income Tax Treaty",
        "rates": {
            "dividends": (0.10, "Article 10"),
            "interest": (0.10, "Article 11"),
            "royalties": (0.0, "Article 12"),
            "services": (0.0, "Article 7"),
        },
    },
    "IN": {
        "name": "U.S.-India Income Tax Treaty",
        "rates": {
            "dividends": (0.15, "Article 10"),
            "interest": (0.15, "Article 11"),
            "royalties": (0.15, "Article 12"),
            "services": (0.15, "Article 12"),
        },
    },
}

# entity use / exemption reason codes (drive exemption certificate logic)
_SABRE_ENTITY_USE_CODES = {
    "A": "Federal government",
    "B": "State or local government",
    "C": "Tribal government",
    "D": "Foreign diplomat",
    "E": "Charitable or religious organization",
    "F": "Religious organization",
    "G": "Resale",
    "H": "Agricultural production",
    "I": "Industrial production / manufacturer",
    "J": "Direct pay permit",
    "K": "Direct mail",
    "L": "Other",
    "N": "Local government",
    "R": "Non-resident",
}
_SABRE_EXEMPT_ZONES = ("CA", "NY", "TX", "WA", "IL", "FL", "CO", "MA", "GA")


def sabre_us_jurisdiction(region: str) -> dict | None:
    return _SABRE_US_JURISDICTIONS.get(str(region).upper()) if region else None


def sabre_country_tax(country: str) -> dict | None:
    return _SABRE_COUNTRY_TAX.get(str(country).upper()) if country else None


def sabre_tax_codes() -> list[dict]:
    return [
        {"taxCode": c, "category": cat, "description": desc, "taxable": taxable}
        for c, cat, desc, taxable in _SABRE_TAX_CODES
    ]


def sabre_tax_code(code: str) -> dict | None:
    row = _SABRE_TAX_CODE_INDEX.get(str(code).upper())
    if row is None:
        return None
    return {
        "taxCode": row[0],
        "category": row[1],
        "description": row[2],
        "taxable": row[3],
    }


def sabre_taxid_rule(country: str) -> dict | None:
    return _SABRE_TAXID_RULES.get(str(country).upper()) if country else None


def sabre_treaty(country: str) -> dict | None:
    return _SABRE_TREATY.get(str(country).upper()) if country else None


def sabre_income_code(income_type: str) -> str:
    return _SABRE_INCOME_CODES.get(str(income_type).lower(), "50")


def sabre_withholding_rates() -> dict:
    """Statutory NRA FDAP, domestic backup, and FATCA chapter-4 withholding rates."""
    return {
        "statutory": _SABRE_WHT_STATUTORY,
        "backup": _SABRE_WHT_BACKUP,
        "fatca": _SABRE_WHT_FATCA,
    }


def sabre_entity_use_reason(code: str) -> str | None:
    return _SABRE_ENTITY_USE_CODES.get(str(code).upper()) if code else None


def sabre_business_name(taxid: str) -> str:
    """Deterministic registered business name, mimicking a VIES name lookup."""
    return _company(_rng("sabre-vies", taxid))


def _sabre_combined_rate(juris: dict) -> float:
    return round(
        juris["stateRate"]
        + juris["county"][1]
        + juris["city"][1]
        + juris["special"][1],
        5,
    )


def _sabre_jurisdiction_rows(seed: str) -> dict:
    """Stored jurisdiction reference: US states (component breakdown) + VAT/GST countries."""
    rows: dict[str, dict] = {}
    for region, j in _SABRE_US_JURISDICTIONS.items():
        rows[f"US-{region}"] = {
            "jurisdictionId": f"US-{region}",
            "country": "US",
            "region": region,
            "name": j["stateName"],
            "taxType": "SalesAndUse",
            "combinedRate": _sabre_combined_rate(j),
            "components": {
                "state": {"name": j["stateName"], "rate": j["stateRate"]},
                "county": {"name": j["county"][0], "rate": j["county"][1]},
                "city": {"name": j["city"][0], "rate": j["city"][1]},
                "special": {"name": j["special"][0], "rate": j["special"][1]},
            },
        }
    for country, c in _SABRE_COUNTRY_TAX.items():
        rows[country] = {
            "jurisdictionId": country,
            "country": country,
            "region": "",
            "name": c["taxName"],
            "taxType": c["taxType"],
            "combinedRate": c["standardRate"],
            "currency": c["currency"],
            "reducedRates": c["reducedRates"],
        }
    return rows


def _sabre_exemption_certificates(seed: str) -> dict:
    """Deterministic exemption-certificate roll keyed by certificate number."""
    reasons = ("E", "G", "I", "A", "B", "H", "R", "J")
    certs: dict[str, dict] = {}
    for i in range(1, 15):
        rng = _rng(seed, "sabre-cert", i)
        code = rng.choice(reasons)
        zone = rng.choice(_SABRE_EXEMPT_ZONES)
        signed = _EPOCH + timedelta(days=rng.randint(-900, -30))
        expired = rng.random() < 0.18
        expiration = (
            (signed + timedelta(days=365 * 3))
            if not expired
            else (_EPOCH - timedelta(days=rng.randint(10, 120)))
        )
        number = f"EX-{rng.randint(100000, 999999)}"
        customer = f"CUST-{rng.randint(1000, 9999)}"
        tax_number_type = "FEIN"
        business = f"{rng.randint(10, 99)}-{rng.randint(1000000, 9999999)}"
        partial = rng.random() < 0.15
        certs[number] = {
            "exemptionNumber": number,
            "customerCode": customer,
            "entityUseCode": code,
            "exemptionReason": _SABRE_ENTITY_USE_CODES[code],
            "exposureZone": {
                "region": zone,
                "country": "US",
                "name": _SABRE_US_JURISDICTIONS[zone]["stateName"],
            },
            "signedDate": signed.isoformat(),
            "expirationDate": expiration.isoformat(),
            "exemptPercentage": 50.0 if partial else 100.0,
            "taxNumberType": tax_number_type,
            "businessNumber": business,
            "status": "EXPIRED" if expired else "ACTIVE",
            "valid": not expired,
            "verified": not expired and rng.random() > 0.1,
        }
    return certs


def sabre_dataset(seed: str) -> dict[str, dict]:
    """Seed Sabre Tax with reference jurisdictions, the tax-code catalog, and a
    roll of exemption certificates; transactions accrue as determinations run."""
    return {
        "transactions": {},
        "jurisdictions": _sabre_jurisdiction_rows(seed),
        "tax_codes": {row["taxCode"]: row for row in sabre_tax_codes()},
        "exemption_certificates": _sabre_exemption_certificates(seed),
    }


# --------------------------------------------------------------------------- #
# Vela Notify — transactional email + SMS notification platform
# --------------------------------------------------------------------------- #
_VELA_EMAIL_DOMAIN = "notifications.lynxcapital.test"
_VELA_SMS_SENDER = "LYNXCAP"

# Template catalogue. Each entry: alias, display name, channels, message stream,
# category, subject (email), text body, html body, sms body, and the merge
# variables the body interpolates. Bodies use Postmark/Handlebars {{var}} syntax.
_VELA_TEMPLATE_DEFS: tuple[dict, ...] = (
    {
        "alias": "remittance_advice",
        "name": "Remittance Advice",
        "channels": ("email",),
        "stream": "outbound-transactional",
        "category": "remittance",
        "subject": "Remittance advice for payment {{reference}}",
        "text": (
            "Hello {{vendorName}},\n\nA payment of {{currency}} {{amount}} has been "
            "remitted against reference {{reference}} on {{paymentDate}}.\n\n"
            "Thank you,\nLynxCapital Accounts Payable"
        ),
        "html": (
            "<p>Hello {{vendorName}},</p><p>A payment of <strong>{{currency}} {{amount}}"
            "</strong> has been remitted against reference <strong>{{reference}}</strong> "
            "on {{paymentDate}}.</p><p>Thank you,<br>LynxCapital Accounts Payable</p>"
        ),
        "sms": None,
        "variables": ("vendorName", "amount", "currency", "reference", "paymentDate"),
    },
    {
        "alias": "payment_confirmation",
        "name": "Payment Confirmation",
        "channels": ("email", "sms"),
        "stream": "outbound-transactional",
        "category": "payment",
        "subject": "Payment {{reference}} confirmed",
        "text": (
            "Hi {{payeeName}},\n\nWe have confirmed your payment of {{currency}} {{amount}} "
            "(ref {{reference}}). No action is required.\n\nLynxCapital"
        ),
        "html": (
            "<p>Hi {{payeeName}},</p><p>We have confirmed your payment of "
            "<strong>{{currency}} {{amount}}</strong> (ref {{reference}}).</p>"
        ),
        "sms": "LynxCapital: payment of {{currency}} {{amount}} confirmed (ref {{reference}}).",
        "variables": ("payeeName", "amount", "currency", "reference"),
    },
    {
        "alias": "dunning_reminder",
        "name": "Dunning — Friendly Reminder",
        "channels": ("email", "sms"),
        "stream": "outbound-transactional",
        "category": "dunning",
        "subject": "Friendly reminder: invoice {{invoiceNumber}} is due {{dueDate}}",
        "text": (
            "Hello {{customerName}},\n\nThis is a friendly reminder that invoice "
            "{{invoiceNumber}} for {{currency}} {{balance}} is due on {{dueDate}}. "
            "Please disregard if payment is already on its way.\n\nLynxCapital Collections"
        ),
        "html": (
            "<p>Hello {{customerName}},</p><p>Invoice <strong>{{invoiceNumber}}</strong> for "
            "<strong>{{currency}} {{balance}}</strong> is due on {{dueDate}}.</p>"
        ),
        "sms": "LynxCapital: invoice {{invoiceNumber}} ({{currency}} {{balance}}) is due {{dueDate}}.",
        "variables": (
            "customerName",
            "invoiceNumber",
            "balance",
            "currency",
            "dueDate",
        ),
    },
    {
        "alias": "dunning_second_notice",
        "name": "Dunning — Second Notice",
        "channels": ("email", "sms"),
        "stream": "outbound-transactional",
        "category": "dunning",
        "subject": "Second notice: invoice {{invoiceNumber}} is past due",
        "text": (
            "Hello {{customerName}},\n\nInvoice {{invoiceNumber}} for {{currency}} {{balance}} "
            "is now {{daysPastDue}} days past due. Please remit payment to avoid further "
            "action.\n\nLynxCapital Collections"
        ),
        "html": (
            "<p>Hello {{customerName}},</p><p>Invoice <strong>{{invoiceNumber}}</strong> is "
            "<strong>{{daysPastDue}} days past due</strong> ({{currency}} {{balance}}).</p>"
        ),
        "sms": "LynxCapital: invoice {{invoiceNumber}} is {{daysPastDue}} days past due. Please pay.",
        "variables": (
            "customerName",
            "invoiceNumber",
            "balance",
            "currency",
            "daysPastDue",
        ),
    },
    {
        "alias": "dunning_final_notice",
        "name": "Dunning — Final Notice",
        "channels": ("email", "sms"),
        "stream": "outbound-transactional",
        "category": "dunning",
        "subject": "Final notice before collections: invoice {{invoiceNumber}}",
        "text": (
            "Hello {{customerName}},\n\nThis is a final notice for invoice {{invoiceNumber}} "
            "({{currency}} {{balance}}). If payment is not received by {{graceDate}} the "
            "account will be referred to collections.\n\nLynxCapital Collections"
        ),
        "html": (
            "<p>Hello {{customerName}},</p><p><strong>Final notice</strong> for invoice "
            "{{invoiceNumber}} ({{currency}} {{balance}}). Pay by {{graceDate}}.</p>"
        ),
        "sms": "LynxCapital FINAL NOTICE: invoice {{invoiceNumber}} due by {{graceDate}} or it goes to collections.",
        "variables": (
            "customerName",
            "invoiceNumber",
            "balance",
            "currency",
            "graceDate",
        ),
    },
    {
        "alias": "payout_dispatched",
        "name": "Payout Dispatched",
        "channels": ("email",),
        "stream": "outbound-transactional",
        "category": "payout",
        "subject": "Your payout {{payoutId}} is on its way",
        "text": (
            "Hi {{recipientName}},\n\nA payout of {{currency}} {{amount}} ({{payoutId}}) has "
            "been dispatched and should arrive by {{arrivalDate}}.\n\nLynxCapital"
        ),
        "html": (
            "<p>Hi {{recipientName}},</p><p>Payout <strong>{{payoutId}}</strong> of "
            "{{currency}} {{amount}} is on its way (ETA {{arrivalDate}}).</p>"
        ),
        "sms": None,
        "variables": ("recipientName", "amount", "currency", "payoutId", "arrivalDate"),
    },
    {
        "alias": "statement_ready",
        "name": "Monthly Statement Ready",
        "channels": ("email",),
        "stream": "broadcast",
        "category": "statement",
        "subject": "Your {{period}} statement is ready",
        "text": (
            "Hello {{customerName}},\n\nYour statement for {{period}} is now available in the "
            "portal.\n\nLynxCapital"
        ),
        "html": (
            "<p>Hello {{customerName}},</p><p>Your <strong>{{period}}</strong> statement is "
            "ready in the portal.</p>"
        ),
        "sms": None,
        "variables": ("customerName", "period"),
    },
    {
        "alias": "otp_verification",
        "name": "One-Time Passcode",
        "channels": ("sms",),
        "stream": "outbound-transactional",
        "category": "verification",
        "subject": None,
        "text": None,
        "html": None,
        "sms": "LynxCapital verification code: {{code}}. It expires in {{ttlMinutes}} minutes.",
        "variables": ("code", "ttlMinutes"),
    },
)


def _vela_id(rng: random.Random, prefix: str) -> str:
    return f"{prefix}_{rng.getrandbits(48):012x}"


def _vela_templates(seed: str) -> dict[str, dict]:
    """Build the template catalogue keyed by alias, the way Postmark keys templates."""
    out: dict[str, dict] = {}
    for idx, spec in enumerate(_VELA_TEMPLATE_DEFS):
        rng = _rng(seed, "vela-template", spec["alias"])
        created = _instant(rng, 24, 90)
        updated = _instant(rng, 91, 150)
        out[spec["alias"]] = {
            "templateId": _vela_id(rng, "tmpl"),
            "alias": spec["alias"],
            "name": spec["name"],
            "channels": list(spec["channels"]),
            "messageStream": spec["stream"],
            "category": spec["category"],
            "subject": spec["subject"],
            "htmlBody": spec["html"],
            "textBody": spec["text"],
            "smsBody": spec["sms"],
            "variables": list(spec["variables"]),
            "active": True,
            "version": rng.randint(1, 6),
            "createdAt": created,
            "updatedAt": updated,
        }
    return out


def _vela_recipient(rng: random.Random, channel: str) -> tuple[str, str]:
    """Return (display name, address) for the given channel."""
    name = _person(rng)
    if channel == "sms":
        return name, _phone(rng, rng.choice(("US", "GB", "DE", "SG")))
    first, last = name.lower().split(" ")
    return name, f"{first}.{last}@{rng.choice(_ROOTS).lower()}.example"


# Status plan per seeded message: (channel, template alias, terminal status, with_open).
_VELA_MESSAGE_PLAN: tuple[tuple[str, str, str, bool], ...] = (
    ("email", "remittance_advice", "delivered", True),
    ("email", "remittance_advice", "delivered", False),
    ("email", "payment_confirmation", "delivered", True),
    ("email", "payout_dispatched", "delivered", False),
    ("email", "statement_ready", "delivered", True),
    ("email", "dunning_reminder", "delivered", False),
    ("email", "dunning_second_notice", "delivered", True),
    ("email", "dunning_final_notice", "bounced", False),
    ("email", "dunning_reminder", "bounced", False),
    ("email", "statement_ready", "spam", False),
    ("email", "remittance_advice", "sent", False),
    ("email", "payment_confirmation", "queued", False),
    ("sms", "payment_confirmation", "delivered", False),
    ("sms", "dunning_reminder", "delivered", False),
    ("sms", "otp_verification", "delivered", False),
    ("sms", "dunning_second_notice", "undelivered", False),
    ("sms", "dunning_final_notice", "undelivered", False),
    ("sms", "otp_verification", "sending", False),
    ("sms", "payment_confirmation", "queued", False),
)

_VELA_BOUNCE_DETAIL = {
    "type": "HardBounce",
    "code": 1,
    "description": "The recipient's mail server permanently rejected the message.",
}
_VELA_SMS_ERRORS = {
    "undelivered": (30003, "Unreachable destination handset"),
}


def _vela_messages(
    seed: str, templates: dict[str, dict]
) -> tuple[dict[str, dict], dict[str, dict]]:
    """Build seeded messages and their delivery-event timelines."""
    messages: dict[str, dict] = {}
    events: dict[str, dict] = {}

    def add_event(rng, message, etype, base_dt, offset_s, detail=None):
        eid = _vela_id(rng, "evt")
        moment = base_dt + timedelta(seconds=offset_s)
        events[eid] = {
            "eventId": eid,
            "messageId": message["messageId"],
            "type": etype,
            "channel": message["channel"],
            "recipient": message["to"],
            "occurredAt": moment.replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z"),
            "detail": detail or {},
        }

    for idx, (channel, alias, terminal, with_open) in enumerate(_VELA_MESSAGE_PLAN):
        rng = _rng(seed, "vela-message", idx)
        template = templates[alias]
        display, address = _vela_recipient(rng, channel)
        submitted = datetime.combine(
            _EPOCH + timedelta(days=rng.randint(150, 178)), time.min, timezone.utc
        ) + timedelta(seconds=rng.randint(0, 86_399))
        message_id = _vela_id(rng, "msg")
        sender = (
            _VELA_SMS_SENDER if channel == "sms" else f"no-reply@{_VELA_EMAIL_DOMAIN}"
        )
        subject = template["subject"] if channel == "email" else None
        message = {
            "messageId": message_id,
            "providerMessageId": _vela_id(
                rng, "carrier" if channel == "sms" else "esp"
            ),
            "channel": channel,
            "messageStream": template["messageStream"],
            "to": address,
            "toName": display,
            "from": sender,
            "templateAlias": alias,
            "subject": subject,
            "tag": template["category"],
            "status": terminal,
            "metadata": {"campaign": template["category"]},
            "errorCode": 0,
            "error": None,
            "bounce": None,
            "submittedAt": submitted.replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z"),
            "updatedAt": None,
        }

        # Build the event timeline that produced the terminal status.
        if channel == "email":
            add_event(rng, message, "Sent", submitted, 2)
            if terminal == "bounced":
                add_event(
                    rng, message, "Bounce", submitted, 6, dict(_VELA_BOUNCE_DETAIL)
                )
                message["bounce"] = dict(_VELA_BOUNCE_DETAIL)
                message["errorCode"] = _VELA_BOUNCE_DETAIL["code"]
                message["error"] = _VELA_BOUNCE_DETAIL["description"]
            elif terminal == "spam":
                add_event(rng, message, "Delivery", submitted, 5)
                add_event(
                    rng,
                    message,
                    "SpamComplaint",
                    submitted,
                    3600,
                    {"origin": "Recipient"},
                )
                message["status"] = "delivered"
            elif terminal == "delivered":
                add_event(rng, message, "Delivery", submitted, 5)
                if with_open:
                    add_event(
                        rng,
                        message,
                        "Open",
                        submitted,
                        900,
                        {
                            "client": rng.choice(("Gmail", "Outlook", "Apple Mail")),
                            "os": rng.choice(("iOS", "Windows", "macOS")),
                        },
                    )
                    add_event(
                        rng,
                        message,
                        "Click",
                        submitted,
                        960,
                        {"url": "https://portal.lynxcapital.test/payments"},
                    )
            elif terminal == "sent":
                pass  # in flight, no delivery confirmation yet
            # queued -> no events beyond submission
        else:  # sms
            if message["status"] not in ("queued",):
                add_event(rng, message, "sending", submitted, 1)
            if terminal == "delivered":
                add_event(rng, message, "sent", submitted, 3)
                add_event(rng, message, "delivered", submitted, 8)
            elif terminal == "undelivered":
                code, reason = _VELA_SMS_ERRORS["undelivered"]
                add_event(
                    rng,
                    message,
                    "undelivered",
                    submitted,
                    7,
                    {"errorCode": code, "reason": reason},
                )
                message["errorCode"] = code
                message["error"] = reason

        messages[message_id] = message
    return messages, events


def _vela_suppressions(seed: str) -> dict[str, dict]:
    """Recipients the platform will refuse to send to, mirroring Postmark/SendGrid
    suppression lists fed by hard bounces, complaints, and unsubscribes."""
    rows: dict[str, dict] = {}
    plan = (
        ("email", "HardBounce", "Recipient"),
        ("email", "SpamComplaint", "Recipient"),
        ("sms", "Unsubscribe", "Recipient"),
    )
    for idx, (channel, reason, origin) in enumerate(plan):
        rng = _rng(seed, "vela-suppression", idx)
        _, address = _vela_recipient(rng, channel)
        key = f"{channel}:{address.lower()}"
        rows[key] = {
            "recipient": address,
            "channel": channel,
            "reason": reason,
            "origin": origin,
            "createdAt": _instant(rng, 120, 175),
        }
    return rows


def _vela_webhooks(seed: str) -> dict[str, dict]:
    """Registered webhook endpoints that receive delivery, bounce, and complaint
    callbacks, with a short delivery-attempt history."""
    out: dict[str, dict] = {}
    plan = (
        (
            "https://hooks.lynxcapital.test/vela/delivery",
            ["Delivery", "Bounce", "SpamComplaint"],
            "outbound-transactional",
            True,
        ),
        (
            "https://hooks.lynxcapital.test/vela/engagement",
            ["Open", "Click"],
            "broadcast",
            True,
        ),
    )
    for idx, (url, evts, stream, enabled) in enumerate(plan):
        rng = _rng(seed, "vela-webhook", idx)
        hook_id = _vela_id(rng, "hook")
        deliveries = []
        for d in range(3):
            ddt = _instant(rng, 160, 178)
            status = 200 if d != 1 else 503
            deliveries.append(
                {
                    "attemptId": _vela_id(rng, "whk"),
                    "event": rng.choice(evts),
                    "responseStatus": status,
                    "succeeded": status == 200,
                    "occurredAt": ddt,
                }
            )
        out[hook_id] = {
            "webhookId": hook_id,
            "url": url,
            "messageStream": stream,
            "events": evts,
            "enabled": enabled,
            "secret": f"whsec_{rng.getrandbits(80):020x}",
            "createdAt": _instant(rng, 60, 120),
            "deliveries": deliveries,
        }
    return out


def vela_dataset(seed: str) -> dict[str, dict]:
    """Seed Vela Notify with its template catalogue, a roll of messages spanning the
    delivery lifecycle, their event timelines, a suppression list, and webhooks."""
    templates = _vela_templates(seed)
    messages, events = _vela_messages(seed, templates)
    return {
        "templates": templates,
        "messages": messages,
        "events": events,
        "suppressions": _vela_suppressions(seed),
        "webhooks": _vela_webhooks(seed),
    }


# --------------------------------------------------------------------------- #
# Core Billing — LynxCapital's internal accounts-receivable and billing
# platform. Not a third-party SaaS: it is the system the finance org runs to
# invoice customers, apply cash, age receivables, drive dunning, and escalate
# collections. Data is generated as a coherent sub-ledger where customer
# balances, invoice states, payments, credit memos, dunning history, and
# collection cases all reconcile against one another as of a reporting date.
# --------------------------------------------------------------------------- #

_CB_AS_OF = _EPOCH  # reporting date the receivables sub-ledger is aged against
_CB_SEGMENTS = ("enterprise", "mid_market", "smb", "strategic")
_CB_CURRENCIES = (
    ("US", "USD"),
    ("US", "USD"),
    ("US", "USD"),
    ("GB", "GBP"),
    ("DE", "EUR"),
    ("SG", "SGD"),
)
_CB_TERMS = ("NET15", "NET30", "NET30", "NET45", "NET60")
_CB_PRODUCTS = (
    ("PLT-CORE", "Platform subscription - Core", 2400.0),
    ("PLT-ENT", "Platform subscription - Enterprise", 7800.0),
    ("SEAT-USR", "Additional user seats", 65.0),
    ("API-OVG", "API overage charges", 0.012),
    ("IMPL-SVC", "Implementation services", 18500.0),
    ("SUP-PREM", "Premium support plan", 1200.0),
    ("DATA-FEED", "Market data feed", 950.0),
    ("PRO-SVC", "Professional services - day rate", 1850.0),
)
_CB_TAX_RATE = {"US": 0.0, "GB": 0.20, "DE": 0.19, "SG": 0.09}
_CB_COLLECTIONS_OWNERS = (
    "Priya Whitfield",
    "Marco Bianchi",
    "Lena Novak",
    "Hassan Haddad",
)


def _cb_term_days(term: str) -> int:
    return int(term.removeprefix("NET"))


def _cb_bucket(days_past_due: int) -> str:
    if days_past_due <= 0:
        return "current"
    if days_past_due <= 30:
        return "1-30"
    if days_past_due <= 60:
        return "31-60"
    if days_past_due <= 90:
        return "61-90"
    return "90+"


def _cb_dunning_level(days_past_due: int) -> int:
    if days_past_due <= 0:
        return 0
    if days_past_due <= 30:
        return 1
    if days_past_due <= 60:
        return 2
    return 3


def _cb_customer(seed: str, idx: int) -> dict:
    rng = _rng(seed, "customer", idx)
    name = _company(rng)
    country, currency = rng.choice(_CB_CURRENCIES)
    segment = _CB_SEGMENTS[idx % len(_CB_SEGMENTS)]
    terms = rng.choice(_CB_TERMS)
    credit_limit = {
        "enterprise": rng.choice((250_000, 500_000, 750_000)),
        "strategic": rng.choice((500_000, 1_000_000)),
        "mid_market": rng.choice((75_000, 100_000, 150_000)),
        "smb": rng.choice((15_000, 25_000, 50_000)),
    }[segment]
    contact = _person(rng)
    slug = _slug(name)
    status = "inactive" if rng.random() < 0.05 else "active"
    return {
        "customerId": f"CUST-{idx:04d}",
        "name": name,
        "legalName": f"{name} {rng.choice(('Inc.', 'Ltd.', 'LLC', 'GmbH'))}",
        "segment": segment,
        "status": status,
        "currency": currency,
        "country": country,
        "paymentTerms": terms,
        "creditLimit": float(credit_limit),
        "creditHold": False,
        "taxId": f"{country}{rng.randint(10_000_000, 99_999_999)}",
        "billingContact": {
            "name": contact,
            "email": f"ap@{slug}.example",
            "phone": _phone(rng, country),
        },
        "billingAddress": {
            "line1": f"{rng.randint(10, 9990)} {rng.choice(('Market', 'King', 'Bridge', 'Harbor', 'Castle'))} St",
            "city": rng.choice(
                ("New York", "London", "Berlin", "Singapore", "Chicago", "Austin")
            ),
            "region": rng.choice(("NY", "LDN", "BE", "SG", "IL", "TX")),
            "postalCode": f"{rng.randint(10_000, 99_999)}",
            "country": country,
        },
        "accountManager": _person(_rng(seed, "am", idx)),
        "collectionsOwner": _CB_COLLECTIONS_OWNERS[idx % len(_CB_COLLECTIONS_OWNERS)],
        "collectionsStatus": "current",
        "arBalance": 0.0,
        "overdueBalance": 0.0,
        "createdAt": _instant(rng, -540, -200),
    }


def _cb_line_items(rng: random.Random, segment: str) -> tuple[list[dict], float]:
    count = rng.randint(1, 4)
    lines: list[dict] = []
    subtotal = 0.0
    for n in range(1, count + 1):
        sku, desc, unit = rng.choice(_CB_PRODUCTS)
        if unit < 1:  # usage-priced line (per-call overage)
            qty = rng.randint(50_000, 900_000)
        elif unit > 5_000:
            qty = rng.choice((1, 1, 2))
        else:
            qty = rng.randint(1, 25)
        amount = round(unit * qty, 2)
        subtotal += amount
        lines.append(
            {
                "lineNo": n,
                "sku": sku,
                "description": desc,
                "quantity": qty,
                "unitPrice": unit,
                "amount": amount,
            }
        )
    return lines, round(subtotal, 2)


def _cb_invoice(seed: str, idx: int, customer: dict, inv_no: int) -> dict:
    rng = _rng(seed, "invoice", idx)
    terms = customer["paymentTerms"]
    term_days = _cb_term_days(terms)
    # Bias issue dates toward recent billing with a thinning overdue tail, the
    # way a healthy receivables book sits mostly current with fewer aged items.
    skew = rng.random()
    if skew < 0.55:
        issue_offset = -rng.randint(2, 40)
    elif skew < 0.85:
        issue_offset = -rng.randint(40, 80)
    else:
        issue_offset = -rng.randint(80, 150)
    issue_date = _CB_AS_OF + timedelta(days=issue_offset)
    due_date = issue_date + timedelta(days=term_days)
    days_past_due = max(0, (_CB_AS_OF - due_date).days)

    lines, subtotal = _cb_line_items(rng, customer["segment"])
    tax_rate = _CB_TAX_RATE.get(customer["country"], 0.0)
    tax_amount = round(subtotal * tax_rate, 2)
    total = round(subtotal + tax_amount, 2)

    roll = rng.random()
    draft = issue_offset > -5 and roll < 0.10
    disputed = (not draft) and days_past_due > 20 and roll > 0.93
    if draft:
        status, amount_paid = "draft", 0.0
    elif roll < 0.42:
        status, amount_paid = "paid", total
    elif roll < 0.55:
        status, amount_paid = "partiallyPaid", round(total * rng.uniform(0.2, 0.7), 2)
    else:
        status, amount_paid = "open", 0.0

    if status in ("open", "partiallyPaid") and days_past_due > 0:
        status = (
            "disputed"
            if disputed
            else "overdue"
            if status == "open"
            else "partiallyPaid"
        )

    amount_due = round(total - amount_paid, 2)
    outstanding = amount_due if status not in ("paid", "void", "draft") else 0.0
    return {
        "invoiceId": f"INV-2026-{inv_no:06d}",
        "customerId": customer["customerId"],
        "customerName": customer["name"],
        "status": status,
        "currency": customer["currency"],
        "terms": terms,
        "issueDate": issue_date.isoformat(),
        "dueDate": due_date.isoformat(),
        "poNumber": f"PO-{rng.randint(40_000, 99_999)}" if rng.random() < 0.6 else None,
        "lineItems": lines,
        "subtotal": subtotal,
        "taxRate": tax_rate,
        "taxAmount": tax_amount,
        "total": total,
        "amountPaid": amount_paid,
        "amountDue": amount_due,
        "daysPastDue": days_past_due if outstanding else 0,
        "agingBucket": _cb_bucket(days_past_due) if outstanding else "current",
        "dunningLevel": _cb_dunning_level(days_past_due) if outstanding else 0,
        "lastDunnedAt": None,
        "memo": rng.choice(
            ("", "", "Renewal billing", "Usage true-up", "Milestone billing")
        ),
        "createdBy": "billing-batch@core-billing.lynxcapital.test",
        "createdAt": _instant(
            _rng(seed, "inv-created", idx), issue_offset, issue_offset
        ),
        "updatedAt": _instant(rng, max(issue_offset, -30), -1),
    }


def core_billing_dataset(seed: str) -> dict[str, dict]:
    """Build a coherent receivables sub-ledger: a customer master with credit
    terms and limits, issued invoices across the full lifecycle (draft, open,
    overdue, partially paid, paid, disputed), the payments and cash applications
    that settle them, credit memos, a dunning history aged off due dates,
    collection cases for the worst accounts, and an append-only audit trail.
    Customer AR and overdue balances are rolled up from the open invoices so the
    aging and reporting endpoints reconcile to the invoice detail."""
    customers: dict[str, dict] = {}
    for i in range(1, 41):
        cust = _cb_customer(seed, i)
        customers[cust["customerId"]] = cust
    active_ids = [c for c, row in customers.items() if row["status"] == "active"]

    invoices: dict[str, dict] = {}
    payments: dict[str, dict] = {}
    audit: list[dict] = []
    inv_no = 0
    pmt_no = 0
    for i in range(1, 211):
        rng = _rng(seed, "inv-assign", i)
        customer = customers[rng.choice(active_ids)]
        inv_no += 1
        inv = _cb_invoice(seed, i, customer, inv_no)
        invoices[inv["invoiceId"]] = inv
        audit.append(
            {
                "eventId": f"AUD-{len(audit) + 1:06d}",
                "at": inv["createdAt"],
                "actor": inv["createdBy"],
                "action": "invoice.issued",
                "entityType": "invoice",
                "entityId": inv["invoiceId"],
                "details": {
                    "customerId": customer["customerId"],
                    "total": inv["total"],
                    "currency": inv["currency"],
                },
            }
        )
        # Synthesize the cash application behind any settled or partly settled invoice.
        if inv["amountPaid"] > 0:
            pmt_no += 1
            prng = _rng(seed, "pmt", i)
            received = date.fromisoformat(inv["issueDate"]) + timedelta(
                days=prng.randint(5, 40)
            )
            received = min(received, _CB_AS_OF)
            method = prng.choice(("ach", "ach", "wire", "check", "card"))
            pid = f"PMT-2026-{pmt_no:06d}"
            payments[pid] = {
                "paymentId": pid,
                "customerId": customer["customerId"],
                "customerName": customer["name"],
                "currency": inv["currency"],
                "amount": inv["amountPaid"],
                "method": method,
                "reference": f"{method.upper()}-{prng.randint(100000, 999999)}",
                "receivedDate": received.isoformat(),
                "appliedAmount": inv["amountPaid"],
                "unappliedAmount": 0.0,
                "status": "applied",
                "allocations": [
                    {
                        "invoiceId": inv["invoiceId"],
                        "amount": inv["amountPaid"],
                        "appliedAt": received.isoformat(),
                    }
                ],
                "createdAt": _instant(prng, -120, -1),
            }
            inv["lastPaymentId"] = pid
            audit.append(
                {
                    "eventId": f"AUD-{len(audit) + 1:06d}",
                    "at": payments[pid]["createdAt"],
                    "actor": "cash-application@core-billing.lynxcapital.test",
                    "action": "payment.applied",
                    "entityType": "payment",
                    "entityId": pid,
                    "details": {
                        "invoiceId": inv["invoiceId"],
                        "amount": inv["amountPaid"],
                    },
                }
            )

    # Roll customer balances up from open invoices.
    for inv in invoices.values():
        if inv["status"] in ("paid", "void", "draft"):
            continue
        cust = customers[inv["customerId"]]
        cust["arBalance"] = round(cust["arBalance"] + inv["amountDue"], 2)
        if inv["daysPastDue"] > 0:
            cust["overdueBalance"] = round(cust["overdueBalance"] + inv["amountDue"], 2)

    # Derive collections posture and a credit hold for the worst accounts.
    for cust in customers.values():
        worst = max(
            (
                inv["daysPastDue"]
                for inv in invoices.values()
                if inv["customerId"] == cust["customerId"]
                and inv["status"] not in ("paid", "void", "draft")
            ),
            default=0,
        )
        if worst > 60:
            cust["collectionsStatus"] = "in_collections"
        elif worst > 30:
            cust["collectionsStatus"] = "past_due"
        elif worst > 0:
            cust["collectionsStatus"] = "watch"
        if cust["overdueBalance"] > cust["creditLimit"]:
            cust["creditHold"] = True

    # Dunning history for every overdue open invoice.
    dunning: dict[str, dict] = {}
    dun_no = 0
    for inv in invoices.values():
        if inv["dunningLevel"] <= 0 or inv["status"] in (
            "paid",
            "void",
            "draft",
            "disputed",
        ):
            continue
        for level in range(1, inv["dunningLevel"] + 1):
            dun_no += 1
            sent = date.fromisoformat(inv["dueDate"]) + timedelta(days=level * 14)
            sent = min(sent, _CB_AS_OF)
            did = f"DUN-2026-{dun_no:06d}"
            dunning[did] = {
                "dunningId": did,
                "invoiceId": inv["invoiceId"],
                "customerId": inv["customerId"],
                "level": level,
                "channel": "email",
                "template": ("payment_reminder", "second_notice", "final_notice")[
                    level - 1
                ],
                "status": "sent",
                "sentAt": sent.isoformat(),
                "nextActionDate": (sent + timedelta(days=14)).isoformat(),
            }
        inv["lastDunnedAt"] = dunning[did]["sentAt"]

    # Collection cases for accounts in collections.
    collections: dict[str, dict] = {}
    col_no = 0
    for cust in customers.values():
        if cust["collectionsStatus"] != "in_collections":
            continue
        col_no += 1
        rng = _rng(seed, "col", cust["customerId"])
        case_invoices = [
            inv["invoiceId"]
            for inv in invoices.values()
            if inv["customerId"] == cust["customerId"]
            and inv["daysPastDue"] > 60
            and inv["status"] not in ("paid", "void", "draft")
        ]
        cid = f"COL-2026-{col_no:04d}"
        collections[cid] = {
            "caseId": cid,
            "customerId": cust["customerId"],
            "customerName": cust["name"],
            "status": rng.choice(("open", "in_progress", "in_progress")),
            "priority": "high" if cust["overdueBalance"] > 100_000 else "medium",
            "assignedTo": cust["collectionsOwner"],
            "invoiceIds": case_invoices,
            "totalOutstanding": round(
                sum(invoices[i]["amountDue"] for i in case_invoices), 2
            ),
            "openedDate": _day(rng, -60, -10),
            "promiseToPayDate": None,
            "notes": [
                {
                    "at": _instant(rng, -30, -1),
                    "author": cust["collectionsOwner"],
                    "note": "Escalated from automated dunning; awaiting customer response.",
                }
            ],
        }

    credit_memos: dict[str, dict] = {}
    for i in range(1, 9):
        rng = _rng(seed, "cm", i)
        cust = customers[active_ids[i % len(active_ids)]]
        amount = round(rng.uniform(250, 9_500), 2)
        cmid = f"CM-2026-{i:04d}"
        credit_memos[cmid] = {
            "creditMemoId": cmid,
            "customerId": cust["customerId"],
            "currency": cust["currency"],
            "amount": amount,
            "appliedAmount": 0.0,
            "remainingAmount": amount,
            "reason": rng.choice(
                ("billing_error", "service_credit", "goodwill", "overcharge")
            ),
            "status": "open",
            "issueDate": _day(rng, -90, -5),
        }

    audit.sort(key=lambda e: e["at"])
    audit_table = {e["eventId"]: e for e in audit}

    return {
        "customers": customers,
        "invoices": invoices,
        "payments": payments,
        "creditMemos": credit_memos,
        "dunning": dunning,
        "collections": collections,
        "auditEvents": audit_table,
        "counters": {
            "invoiceNo": {"value": inv_no},
            "paymentNo": {"value": pmt_no},
            "dunningNo": {"value": dun_no},
            "collectionNo": {"value": col_no},
            "creditMemoNo": {"value": 8},
            "auditNo": {"value": len(audit)},
        },
    }
