"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Deterministic synthetic dataset: vendor catalog, FX rates, and 4,200 invoices.
"""
from __future__ import annotations

import random
from datetime import date, timedelta
from decimal import Decimal

from app.core.types import Invoice, Rail, Region, Vendor

SEED = 42

FX_RATES: dict[str, float] = {
    "USD": 1.0,
    "EUR": 1.08,
    "INR": 0.01198,
    "SGD": 0.742,
    "BRL": 0.198,
}

REGIONS: dict[str, Region] = {
    "US": Region(id="US", name="North America", currency="USD",
                 rails=[Rail.ACH, Rail.WIRE]),
    "IN": Region(id="IN", name="India", currency="INR",
                 rails=[Rail.NEFT, Rail.RTGS, Rail.SWIFT]),
    "DE": Region(id="DE", name="Europe", currency="EUR",
                 rails=[Rail.SEPA, Rail.SWIFT, Rail.WIRE]),
    "SG": Region(id="SG", name="Southeast Asia", currency="SGD",
                 rails=[Rail.PAYNOW, Rail.SWIFT, Rail.WIRE]),
    "BR": Region(id="BR", name="Latin America", currency="BRL",
                 rails=[Rail.PIX, Rail.SWIFT, Rail.WIRE]),
}

_REGION_CURRENCY = {k: v.currency for k, v in REGIONS.items()}

# (id, name, region, category, preferred_rails, payment_terms_days, max_fee_pct)
_V: list[tuple] = [
    # US vendors
    ("us-axiom-cloud",    "Axiom Cloud Solutions",       "US", "cloud",      ["ACH"],        30, 0.8),
    ("us-vector-an",      "Vector Analytics Inc",         "US", "analytics",  ["ACH", "WIRE"], 45, 1.0),
    ("us-meridian-data",  "Meridian Data Corp",           "US", "data",       ["ACH"],        30, 0.9),
    ("us-crestview-sw",   "Crestview Software",           "US", "saas",       ["ACH"],        60, 1.0),
    ("us-northgate-sys",  "Northgate Systems",            "US", "cloud",      ["WIRE"],       30, 0.8),
    ("us-pinnacle-tech",  "Pinnacle Technologies",        "US", "cloud",      ["ACH"],        45, 0.9),
    ("us-summit-fin",     "Summit Financial Services",    "US", "consulting",  ["WIRE"],      15, 1.2),
    ("us-keystone",       "Keystone Consulting",          "US", "consulting",  ["ACH"],       45, 1.5),
    ("us-horizon-plat",   "Horizon Platform Inc",         "US", "saas",       ["ACH"],        60, 1.0),
    ("us-apex-infra",     "Apex Infrastructure",          "US", "cloud",      ["WIRE"],       30, 0.8),
    ("us-sterling-dig",   "Sterling Digital",             "US", "saas",       ["ACH"],        45, 1.0),
    ("us-cascade-sol",    "Cascade Solutions",            "US", "analytics",  ["ACH"],        30, 0.9),
    ("us-vertex-tech",    "Vertex Technologies",          "US", "cloud",      ["ACH", "WIRE"], 30, 0.8),
    ("us-blueprint-an",   "Blueprint Analytics",          "US", "analytics",  ["ACH"],        60, 1.1),
    # IN vendors
    ("in-zylotech",       "Zylotech Solutions",           "IN", "cloud",      ["NEFT"],       30, 1.0),
    ("in-indira-tech",    "Indira Tech Services",         "IN", "consulting",  ["NEFT"],      45, 1.2),
    ("in-kiran-an",       "Kiran Analytics Pvt Ltd",      "IN", "analytics",  ["RTGS"],       30, 0.9),
    ("in-veda-sys",       "Veda Systems",                 "IN", "cloud",      ["NEFT"],       45, 1.0),
    ("in-brahma-dig",     "Brahma Digital",               "IN", "saas",       ["NEFT"],       60, 1.1),
    ("in-prism-sw",       "Prism Software India",         "IN", "saas",       ["NEFT"],       30, 0.8),
    ("in-lakshmi",        "Lakshmi Consulting",           "IN", "consulting",  ["RTGS"],      45, 1.5),
    ("in-saraswati",      "Saraswati Data Systems",       "IN", "data",       ["NEFT"],       30, 0.9),
    ("in-ananta-cloud",   "Ananta Cloud Pvt Ltd",         "IN", "cloud",      ["RTGS"],       30, 0.8),
    ("in-dharma-tech",    "Dharma Tech Solutions",        "IN", "cloud",      ["NEFT"],       45, 1.0),
    ("in-vayu-sys",       "Vayu Systems",                 "IN", "data",       ["NEFT"],       60, 1.1),
    ("in-surya-dig",      "Surya Digital",                "IN", "saas",       ["NEFT"],       30, 0.9),
    ("in-chandra-tech",   "Chandra Technologies",         "IN", "analytics",  ["NEFT", "RTGS"], 45, 1.0),
    ("in-indus-data",     "Indus Data Corp",              "IN", "data",       ["RTGS"],       30, 0.8),
    # DE vendors
    ("de-berliner",       "Berliner Datentechnik GmbH",   "DE", "data",       ["SEPA"],       30, 0.7),
    ("de-rhein-sol",      "Rhein Solutions AG",           "DE", "consulting",  ["SEPA"],      45, 1.0),
    ("de-bayern-an",      "Bayern Analytics GmbH",        "DE", "analytics",  ["SEPA"],       30, 0.8),
    ("de-nordlicht",      "Nordlicht Systems AG",         "DE", "cloud",      ["SEPA", "SWIFT"], 30, 0.7),
    ("de-elbtal",         "Elbtal Software GmbH",         "DE", "saas",       ["SEPA"],       60, 0.9),
    ("de-dresden",        "Dresden Digital GmbH",         "DE", "saas",       ["SEPA"],       45, 0.8),
    ("de-stuttgart",      "Stuttgart Tech AG",            "DE", "cloud",      ["SEPA"],       30, 0.7),
    ("de-frankfurt",      "Frankfurt Analytics",          "DE", "analytics",  ["SEPA", "SWIFT"], 30, 0.8),
    ("de-hamburg",        "Hamburg Solutions GmbH",       "DE", "cloud",      ["SEPA"],       45, 0.9),
    ("de-munich",         "Munich Systems AG",            "DE", "data",       ["SEPA"],       30, 0.7),
    ("de-cologne",        "Cologne Data AG",              "DE", "data",       ["SEPA"],       60, 1.0),
    ("de-dusseldorf",     "Dusseldorf Tech GmbH",         "DE", "consulting",  ["SWIFT"],     45, 1.2),
    ("de-leipzig",        "Leipzig Analytics GmbH",       "DE", "analytics",  ["SEPA"],       30, 0.8),
    ("de-hannover",       "Hannover Systems AG",          "DE", "cloud",      ["SEPA", "SWIFT"], 45, 0.9),
    # SG vendors
    ("sg-singatech",      "SingaTech Solutions",          "SG", "cloud",      ["PAYNOW"],     30, 0.8),
    ("sg-marina-bay",     "Marina Bay Analytics",         "SG", "analytics",  ["PAYNOW", "SWIFT"], 45, 1.0),
    ("sg-orchard",        "Orchard Systems Pte Ltd",      "SG", "saas",       ["PAYNOW"],     30, 0.9),
    ("sg-raffles-dig",    "Raffles Digital Pte",          "SG", "consulting",  ["SWIFT"],     45, 1.2),
    ("sg-sentosa-an",     "Sentosa Analytics",            "SG", "analytics",  ["PAYNOW"],     30, 0.8),
    ("sg-jurong-tech",    "Jurong Tech Pte Ltd",          "SG", "cloud",      ["PAYNOW"],     30, 0.7),
    ("sg-changi-data",    "Changi Data Systems",          "SG", "data",       ["PAYNOW", "SWIFT"], 30, 0.9),
    ("sg-queenstown",     "Queenstown Analytics",         "SG", "analytics",  ["PAYNOW"],     45, 1.0),
    ("sg-woodlands",      "Woodlands Tech Pte",           "SG", "cloud",      ["PAYNOW"],     60, 0.9),
    ("sg-bugis-dig",      "Bugis Digital Pte",            "SG", "saas",       ["PAYNOW"],     30, 0.8),
    ("sg-tampines",       "Tampines Systems Pte",         "SG", "data",       ["PAYNOW"],     45, 0.9),
    ("sg-clementi",       "Clementi Analytics",           "SG", "analytics",  ["PAYNOW", "SWIFT"], 30, 1.0),
    # BR vendors
    ("br-saopaulo",       "Sao Paulo Tech Ltda",          "BR", "cloud",      ["PIX"],        30, 1.0),
    ("br-rio-dig",        "Rio Digital Solutions",        "BR", "consulting",  ["PIX", "SWIFT"], 45, 1.2),
    ("br-amazonia",       "Amazonia Analytics",           "BR", "analytics",  ["PIX"],        30, 0.9),
    ("br-brasilia",       "Brasilia Systems",             "BR", "cloud",      ["PIX"],        30, 1.0),
    ("br-curitiba",       "Curitiba Tech Ltda",           "BR", "saas",       ["PIX"],        45, 1.1),
    ("br-belo",           "Belo Horizonte Data",          "BR", "data",       ["PIX", "SWIFT"], 30, 0.9),
    ("br-porto",          "Porto Alegre Digital",         "BR", "saas",       ["PIX"],        60, 1.0),
    ("br-manaus",         "Manaus Solutions Ltda",        "BR", "cloud",      ["PIX"],        45, 1.1),
    ("br-recife",         "Recife Analytics",             "BR", "analytics",  ["SWIFT"],      30, 1.0),
    ("br-fortaleza",      "Fortaleza Systems",            "BR", "cloud",      ["PIX"],        30, 0.9),
]

VENDORS: dict[str, Vendor] = {
    d[0]: Vendor(
        id=d[0],
        name=d[1],
        region=d[2],
        currency=_REGION_CURRENCY[d[2]],
        category=d[3],
        preferred_rails=[Rail(r) for r in d[4]],
        payment_terms_days=d[5],
        max_fee_pct=d[6],
        bank_account=f"****{sum(ord(c) for c in d[0][:8]) % 9000 + 1000:04d}",
    )
    for d in _V
}

_CATEGORY_DESC: dict[str, str] = {
    "cloud":      "Cloud infrastructure and compute services",
    "saas":       "Enterprise software subscription",
    "analytics":  "Analytics platform license and services",
    "consulting": "Professional consulting services",
    "data":       "Data processing and management services",
    "security":   "Security and compliance services",
}

_INVOICES_PER_REGION = 840  # 840 * 5 = 4,200


def _build() -> list[Invoice]:
    rng = random.Random(SEED)
    ref = date(2026, 4, 22)
    invoices: list[Invoice] = []
    n = 0

    for region_id in ("US", "IN", "DE", "SG", "BR"):
        region = REGIONS[region_id]
        vendors = [v for v in VENDORS.values() if v.region == region_id]
        fx = FX_RATES[region.currency]

        for _ in range(_INVOICES_PER_REGION):
            n += 1
            vendor = vendors[rng.randrange(len(vendors))]
            usd = round(rng.uniform(300.0, 3700.0), 2)
            local = round(usd / fx, 2) if region.currency != "USD" else usd
            issued = ref - timedelta(weeks=rng.randint(2, 8))
            due = issued + timedelta(days=vendor.payment_terms_days)
            period = issued.strftime("%B %Y")
            desc = f"{_CATEGORY_DESC.get(vendor.category, 'Professional services')} - {period}"

            invoices.append(Invoice(
                id=f"INV-{n:05d}",
                vendor_id=vendor.id,
                region=region_id,
                currency=region.currency,
                amount_local=Decimal(str(local)),
                amount_usd=Decimal(str(usd)),
                issued_date=issued,
                due_date=due,
                description=desc,
                status="pending",
            ))

    return invoices


INVOICES: list[Invoice] = _build()


def by_region(region: str) -> list[Invoice]:
    return [i for i in INVOICES if i.region == region]
