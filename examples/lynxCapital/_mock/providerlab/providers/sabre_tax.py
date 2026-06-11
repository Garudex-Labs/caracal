"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Sabre Tax domain: transaction tax determination, jurisdiction resolution, tax-identifier validation, exemption certificates, and cross-border withholding.
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone

from _mock.providerlab.data import generators as gen
from _mock.providerlab.providers import base
from _mock.providerlab.providers.base import Ctx, DomainError

ID = "sabre-tax"

_DEFAULT_TAX_CODE = "P0000000"
_INCOME_TYPES = ("interest", "dividends", "royalties", "royalties_industrial",
                 "rents", "services", "independent_services")
_W8_FORMS = ("W-8BEN", "W-8BEN-E", "W-8ECI", "W-8EXP", "W-8IMY")
_WHT_RATES = gen.sabre_withholding_rates()


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _today() -> str:
    return _now().date().isoformat()


def _transaction_code() -> str:
    return f"SABRE-{_now():%Y%m%d}-{uuid.uuid4().hex[:8].upper()}"


def _amount(value, field: str = "amount") -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        raise DomainError(422, "invalid_amount", f"{field} must be a number")


def _ship_to(ctx: Ctx) -> dict:
    addresses = ctx.get("addresses") or {}
    address = addresses.get("shipTo") or addresses.get("singleLocation") or ctx.get("address")
    if not isinstance(address, dict) or not address.get("country"):
        raise DomainError(422, "address_required",
                          "a shipTo address with a country is required to determine tax")
    return address


def _resolve(country: str, region: str | None) -> dict:
    """Resolve an address country/region to its tax jurisdictions and combined rate."""
    country = str(country).upper()
    if country == "US":
        juris = gen.sabre_us_jurisdiction(region or "")
        if juris is None:
            raise DomainError(404, "jurisdiction_not_found",
                              f"no US tax jurisdiction configured for region {region!r}")
        components = []
        for kind, name, rate in (
            ("State", juris["stateName"], juris["stateRate"]),
            ("County", juris["county"][0], juris["county"][1]),
            ("City", juris["city"][0], juris["city"][1]),
            ("Special", juris["special"][0], juris["special"][1]),
        ):
            if kind != "State" and (not name or rate == 0.0):
                continue
            components.append({
                "jurisType": kind, "jurisName": name,
                "jurisCode": f"{region}-{kind[:3].upper()}", "rate": round(rate, 5),
                "taxName": f"{name} {kind.upper()} TAX", "taxType": "SalesAndUse",
            })
        combined = round(sum(c["rate"] for c in components), 5)
        return {"country": "US", "region": str(region).upper(), "taxType": "SalesAndUse",
                "jurisdictions": components, "combinedRate": combined,
                "resolutionQuality": "Intersection"}
    country_tax = gen.sabre_country_tax(country)
    if country_tax is None:
        raise DomainError(404, "jurisdiction_not_found",
                          f"no tax jurisdiction configured for country {country!r}")
    juris = {"jurisType": "Country", "jurisName": country_tax["taxName"],
             "jurisCode": country, "rate": country_tax["standardRate"],
             "taxName": country_tax["taxName"], "taxType": country_tax["taxType"]}
    return {"country": country, "region": "", "taxType": country_tax["taxType"],
            "jurisdictions": [juris], "combinedRate": country_tax["standardRate"],
            "currency": country_tax["currency"], "resolutionQuality": "CountrySystem"}


def _line_exempt(ctx: Ctx, line: dict, doc_exempt: bool) -> tuple[bool, str]:
    """Decide whether a line is exempt and why, from tax code, entity-use code, or certificate."""
    tax_code = str(line.get("taxCode") or _DEFAULT_TAX_CODE).upper()
    if tax_code == "NT":
        return True, "non_taxable_code"
    catalog = gen.sabre_tax_code(tax_code)
    if catalog is not None and not catalog["taxable"]:
        return True, "non_taxable_product"
    use_code = line.get("entityUseCode") or ctx.get("entityUseCode")
    if use_code:
        return True, "entity_use_exemption"
    cert_no = line.get("exemptionCode") or ctx.get("exemptionNo")
    if cert_no:
        cert = ctx.state.table("exemption_certificates").get(str(cert_no))
        if cert is not None and cert.get("valid"):
            return True, "exemption_certificate"
    return doc_exempt, "document_exemption" if doc_exempt else ""


@base.seeder(ID)
def seed(state: base.State) -> None:
    for name, table in gen.sabre_dataset(ID).items():
        state.tables[name] = table


@base.op(ID, "calculate_tax")
def calculate_tax(ctx: Ctx) -> dict:
    """Determine transaction tax across every jurisdiction for a multi-line document."""
    doc_type = str(ctx.get("type", "SalesInvoice"))
    lines = ctx.get("lines")
    if not isinstance(lines, list) or not lines:
        raise DomainError(422, "missing_line", "a transaction requires at least one line")
    address = _ship_to(ctx)
    resolved = _resolve(address["country"], address.get("region"))
    currency = str(ctx.get("currencyCode") or resolved.get("currency") or "USD").upper()
    doc_exempt = bool(ctx.get("exemptionNo") or ctx.get("entityUseCode"))

    summary: dict[str, dict] = {}
    out_lines = []
    total_amount = total_taxable = total_exempt = total_tax = 0.0
    for index, line in enumerate(lines, start=1):
        if not isinstance(line, dict):
            raise DomainError(422, "invalid_line", f"line {index} must be an object")
        amount = _amount(line.get("amount"), f"line {index} amount")
        number = str(line.get("number") or index)
        tax_code = str(line.get("taxCode") or _DEFAULT_TAX_CODE).upper()
        exempt, reason = _line_exempt(ctx, line, doc_exempt)
        total_amount += amount
        details = []
        line_tax = 0.0
        if exempt:
            total_exempt += amount
        else:
            total_taxable += amount
            for juris in resolved["jurisdictions"]:
                tax = round(amount * juris["rate"], 2)
                line_tax += tax
                details.append({
                    "country": resolved["country"], "region": resolved["region"],
                    "jurisType": juris["jurisType"], "jurisName": juris["jurisName"],
                    "jurisCode": juris["jurisCode"], "taxName": juris["taxName"],
                    "taxType": juris["taxType"], "rate": juris["rate"],
                    "taxableAmount": round(amount, 2), "tax": tax,
                })
                key = juris["jurisCode"]
                bucket = summary.setdefault(key, {
                    "country": resolved["country"], "region": resolved["region"],
                    "jurisType": juris["jurisType"], "jurisName": juris["jurisName"],
                    "jurisCode": juris["jurisCode"], "taxName": juris["taxName"],
                    "taxType": juris["taxType"], "rate": juris["rate"],
                    "taxable": 0.0, "tax": 0.0,
                })
                bucket["taxable"] = round(bucket["taxable"] + amount, 2)
                bucket["tax"] = round(bucket["tax"] + tax, 2)
        line_tax = round(line_tax, 2)
        total_tax += line_tax
        out_lines.append({
            "number": number, "itemCode": line.get("itemCode"),
            "description": line.get("description", ""), "quantity": line.get("quantity", 1),
            "taxCode": tax_code, "lineAmount": round(amount, 2),
            "taxableAmount": 0.0 if exempt else round(amount, 2),
            "exemptAmount": round(amount, 2) if exempt else 0.0,
            "exemptReason": reason, "isItemTaxable": not exempt,
            "tax": line_tax, "details": details,
        })

    if doc_type.endswith("Order"):
        status = "Temporary"
    elif ctx.get("commit") in (True, "true", "1", 1):
        status = "Committed"
    else:
        status = "Saved"

    now = _now()
    transaction = {
        "transactionId": _uuid(),
        "code": str(ctx.get("code") or _transaction_code()),
        "type": doc_type, "status": status,
        "companyCode": str(ctx.get("companyCode", "LYNX")),
        "customerCode": ctx.get("customerCode"),
        "date": str(ctx.get("date") or _today()),
        "currencyCode": currency, "country": resolved["country"], "region": resolved["region"],
        "exemptNo": ctx.get("exemptionNo"), "entityUseCode": ctx.get("entityUseCode"),
        "totalAmount": round(total_amount, 2), "totalTaxable": round(total_taxable, 2),
        "totalExempt": round(total_exempt, 2), "totalTax": round(total_tax, 2),
        "totalTaxCalculated": round(total_tax, 2),
        "summary": list(summary.values()), "lines": out_lines,
        "createdAt": _iso(now), "modifiedAt": _iso(now),
    }
    if status != "Temporary":
        ctx.state.table("transactions")[transaction["code"]] = transaction
    return transaction


@base.op(ID, "get_transaction")
def get_transaction(ctx: Ctx) -> dict:
    ctx.require("code")
    transaction = ctx.state.table("transactions").get(str(ctx.payload["code"]))
    if transaction is None:
        raise DomainError(404, "transaction_not_found", str(ctx.payload["code"]))
    return transaction


@base.op(ID, "commit_transaction")
def commit_transaction(ctx: Ctx) -> dict:
    ctx.require("code")
    transaction = ctx.state.table("transactions").get(str(ctx.payload["code"]))
    if transaction is None:
        raise DomainError(404, "transaction_not_found", str(ctx.payload["code"]))
    if transaction["status"] == "Cancelled":
        raise DomainError(409, "transaction_cancelled",
                          "a cancelled transaction cannot be committed")
    transaction["status"] = "Committed"
    transaction["modifiedAt"] = _iso(_now())
    return transaction


@base.op(ID, "void_transaction")
def void_transaction(ctx: Ctx) -> dict:
    ctx.require("code")
    transaction = ctx.state.table("transactions").get(str(ctx.payload["code"]))
    if transaction is None:
        raise DomainError(404, "transaction_not_found", str(ctx.payload["code"]))
    transaction["status"] = "Cancelled"
    transaction["voidReason"] = str(ctx.get("reason", "DocVoided"))
    transaction["modifiedAt"] = _iso(_now())
    return transaction


@base.op(ID, "resolve_jurisdiction")
def resolve_jurisdiction(ctx: Ctx) -> dict:
    """Resolve an address to its tax jurisdictions and combined rate."""
    address = ctx.get("address") or {}
    country = address.get("country") or ctx.get("country")
    region = address.get("region") or ctx.get("region")
    if not country:
        raise DomainError(422, "address_required", "an address country is required")
    resolved = _resolve(country, region)
    return {
        "address": {"country": str(country).upper(), "region": (region or "").upper(),
                    "city": address.get("city"), "postalCode": address.get("postalCode")},
        "taxType": resolved["taxType"], "combinedRate": resolved["combinedRate"],
        "jurisdictions": resolved["jurisdictions"],
        "resolutionQuality": resolved["resolutionQuality"],
    }


@base.op(ID, "validate_tax_id")
def validate_tax_id(ctx: Ctx) -> dict:
    """Validate a tax identifier against its national format and registry."""
    ctx.require("taxId", "country")
    raw = str(ctx.payload["taxId"]).strip()
    country = str(ctx.payload["country"]).upper()
    rule = gen.sabre_taxid_rule(country)
    if rule is None:
        raise DomainError(422, "unsupported_country",
                          f"tax-id validation is not supported for country {country!r}")
    normalized = raw.upper().replace(" ", "")
    is_valid = bool(re.match(rule["pattern"], normalized))
    result = {
        "taxId": raw, "normalizedTaxId": normalized, "country": country,
        "taxType": rule["taxType"], "format": rule["format"], "source": rule["source"],
        "isValid": is_valid, "validatedDate": _today(),
        "requestId": _uuid(),
    }
    if is_valid and rule["taxType"] in ("VAT", "GST", "GSTIN"):
        result["businessName"] = gen.sabre_business_name(normalized)
        result["businessAddress"] = f"Registered office, {country}"
    else:
        result["businessName"] = None
        if not is_valid:
            result["reason"] = "format_mismatch"
    return result


@base.op(ID, "determine_withholding")
def determine_withholding(ctx: Ctx) -> dict:
    """Determine cross-border withholding tax on a payment to a vendor or contractor."""
    income_type = str(ctx.get("paymentType") or ctx.get("incomeType") or "services").lower()
    if income_type not in _INCOME_TYPES:
        raise DomainError(422, "invalid_payment_type",
                          f"paymentType must be one of {', '.join(_INCOME_TYPES)}")
    payee = ctx.get("payee") or {}
    payee_country = str(payee.get("country") or "").upper()
    if not payee_country:
        raise DomainError(422, "payee_country_required",
                          "payee.country is required to determine withholding")
    payer_country = str((ctx.get("payer") or {}).get("country", "US")).upper()
    currency = str(ctx.get("currencyCode", "USD")).upper()
    documentation = str(payee.get("documentationType") or payee.get("withholdingFormType") or "none")
    entity_type = str(payee.get("entityType", "individual")).lower()
    treaty_claim = payee.get("treatyClaim", documentation.startswith("W-8"))
    tax_id = payee.get("taxId")

    statutory_rate = _WHT_RATES["statutory"] if payer_country == "US" else 0.0
    treaty_rate = None
    treaty_article = None
    treaty_name = None
    is_treaty_applicable = False
    fatca_applicable = False
    backup_applicable = False
    chapter3_code = None
    chapter4_code = None

    us_person = payee_country == payer_country or documentation == "W-9"
    if us_person:
        if documentation == "W-9" or _valid_us_tin(tax_id):
            withholding_rate = 0.0
            doc_status = "ValidW9" if documentation == "W-9" else "DomesticPayee"
        else:
            withholding_rate = _WHT_RATES["backup"]
            backup_applicable = True
            doc_status = "BackupWithholding"
    elif entity_type in ("financial_institution", "ffi") and not payee.get("giin"):
        withholding_rate = _WHT_RATES["fatca"]
        fatca_applicable = True
        doc_status = "FATCANonParticipating"
    else:
        treaty = gen.sabre_treaty(payee_country)
        documented = documentation in _W8_FORMS
        if documented and treaty_claim and treaty and income_type in treaty["rates"]:
            treaty_rate, treaty_article = treaty["rates"][income_type]
            treaty_name = treaty["name"]
            withholding_rate = treaty_rate
            is_treaty_applicable = True
            chapter3_code = "04"
            doc_status = f"Valid{documentation.replace('-', '')}"
        else:
            withholding_rate = statutory_rate
            doc_status = "Undocumented" if not documented else "NoTreatyBenefit"

    response = {
        "determinationId": _uuid(),
        "transactionId": ctx.get("transactionId"),
        "paymentType": income_type, "incomeCode": gen.sabre_income_code(income_type),
        "currencyCode": currency, "payeeCountry": payee_country, "payerCountry": payer_country,
        "statutoryRate": statutory_rate if not us_person else 0.0,
        "withholdingRate": round(withholding_rate, 4),
        "treatyRate": treaty_rate, "treatyArticle": treaty_article,
        "treatyCountry": payee_country if is_treaty_applicable else None,
        "treatyName": treaty_name, "isTreatyApplicable": is_treaty_applicable,
        "backupWithholdingApplicable": backup_applicable,
        "backupWithholdingRate": _WHT_RATES["backup"],
        "fatcaApplicable": fatca_applicable,
        "documentationType": documentation, "documentationStatus": doc_status,
        "chapter3ExemptionCode": chapter3_code, "chapter4ExemptionCode": chapter4_code,
        "calculatedAt": _iso(_now()),
    }

    gross = ctx.get("grossAmount")
    if gross is not None:
        gross = _amount(gross, "grossAmount")
        withholding_amount = round(gross * withholding_rate, 2)
        response["grossAmount"] = round(gross, 2)
        response["withholdingAmount"] = withholding_amount
        response["netPaymentAmount"] = round(gross - withholding_amount, 2)
        if ctx.get("grossUp") in (True, "true", "1", 1) and withholding_rate < 1.0:
            response["grossUp"] = True
            response["grossUpAmount"] = round(gross / (1.0 - withholding_rate), 2)
        else:
            response["grossUp"] = False
            response["grossUpAmount"] = None
    return response


@base.op(ID, "get_exemption_certificate")
def get_exemption_certificate(ctx: Ctx) -> dict:
    ctx.require("exemptionNumber")
    number = str(ctx.payload["exemptionNumber"])
    cert = ctx.state.table("exemption_certificates").get(number)
    if cert is None:
        raise DomainError(404, "certificate_not_found", number)
    return cert


@base.op(ID, "list_tax_codes")
def list_tax_codes(ctx: Ctx) -> dict:
    """List the product tax-code catalog used to classify line taxability."""
    items = list(ctx.state.table("tax_codes").values())
    category = ctx.get("category")
    if category:
        needle = str(category).lower()
        items = [c for c in items if needle in c["category"].lower()]
    query = ctx.get("query")
    if query:
        needle = str(query).lower()
        items = [c for c in items
                 if needle in c["taxCode"].lower() or needle in c["description"].lower()]
    items.sort(key=lambda c: c["taxCode"])
    return ctx.paginate(items, size_default=25)


def _valid_us_tin(tax_id) -> bool:
    if not tax_id:
        return False
    rule = gen.sabre_taxid_rule("US")
    return bool(re.match(rule["pattern"], str(tax_id).strip().replace(" ", "")))

