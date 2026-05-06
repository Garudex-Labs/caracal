"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Typed service clients used by agent tools; all dispatch through registry.call().
"""
from __future__ import annotations

from app.services import registry


class MercuryBankClient:
    _SVC = "mercury-bank"

    def get_account_balance(self, vendor_id: str) -> dict[str, object]:
        return registry.call(self._SVC, "get_account_balance", {"vendor_id": vendor_id})

    def submit_payment(self, vendor_id: str, amount: float, currency: str, rail: str, reference: str) -> dict[str, object]:
        return registry.call(self._SVC, "submit_payment", {
            "vendor_id": vendor_id, "amount": amount, "currency": currency,
            "rail": rail, "reference": reference,
        })


class WisePayoutsClient:
    _SVC = "wise-payouts"

    def get_quote(self, from_currency: str, to_currency: str, amount: float) -> dict[str, object]:
        return registry.call(self._SVC, "get_quote", {
            "from_currency": from_currency, "to_currency": to_currency, "amount": amount,
        })

    def submit_payout(self, vendor_id: str, amount: float, currency: str, rail: str, reference: str) -> dict[str, object]:
        return registry.call(self._SVC, "submit_payout", {
            "vendor_id": vendor_id, "amount": amount, "currency": currency,
            "rail": rail, "reference": reference,
        })


class StripeTreasuryClient:
    _SVC = "stripe-treasury"

    def get_financial_account(self, vendor_id: str) -> dict[str, object]:
        return registry.call(self._SVC, "get_financial_account", {"vendor_id": vendor_id})

    def create_outbound_payment(self, vendor_id: str, amount: float, currency: str, rail: str, reference: str) -> dict[str, object]:
        return registry.call(self._SVC, "create_outbound_payment", {
            "vendor_id": vendor_id, "amount": amount, "currency": currency,
            "rail": rail, "reference": reference,
        })


class NetSuiteClient:
    _SVC = "netsuite"

    def get_vendor_record(self, vendor_id: str) -> dict[str, object]:
        return registry.call(self._SVC, "get_vendor_record", {"vendor_id": vendor_id})

    def match_invoice(self, vendor_id: str, invoice_id: str, amount: float, currency: str) -> dict[str, object]:
        return registry.call(self._SVC, "match_invoice", {
            "vendor_id": vendor_id, "invoice_id": invoice_id,
            "amount": amount, "currency": currency,
        })

    def get_payment_status(self, vendor_id: str) -> dict[str, object]:
        return registry.call(self._SVC, "get_payment_status", {"vendor_id": vendor_id})


class SapErpClient:
    _SVC = "sap-erp"

    def get_vendor_record(self, vendor_id: str) -> dict[str, object]:
        return registry.call(self._SVC, "get_vendor_record", {"vendor_id": vendor_id})

    def match_invoice(self, vendor_id: str, invoice_id: str, amount: float, currency: str) -> dict[str, object]:
        return registry.call(self._SVC, "match_invoice", {
            "vendor_id": vendor_id, "invoice_id": invoice_id,
            "amount": amount, "currency": currency,
        })

    def post_payment_confirmation(self, vendor_id: str, amount: float, currency: str, reference: str) -> dict[str, object]:
        return registry.call(self._SVC, "post_payment_confirmation", {
            "vendor_id": vendor_id, "amount": amount, "currency": currency, "reference": reference,
        })


class QuickBooksClient:
    _SVC = "quickbooks"

    def get_vendor(self, vendor_id: str) -> dict[str, object]:
        return registry.call(self._SVC, "get_vendor", {"vendor_id": vendor_id})

    def match_bill(self, vendor_id: str, invoice_id: str, amount: float, currency: str) -> dict[str, object]:
        return registry.call(self._SVC, "match_bill", {
            "vendor_id": vendor_id, "invoice_id": invoice_id,
            "amount": amount, "currency": currency,
        })

    def create_vendor_payment(self, vendor_id: str, amount: float, currency: str, reference: str) -> dict[str, object]:
        return registry.call(self._SVC, "create_vendor_payment", {
            "vendor_id": vendor_id, "amount": amount, "currency": currency, "reference": reference,
        })


class ComplianceNexusClient:
    _SVC = "compliance-nexus"

    def check_vendor(self, vendor_id: str) -> dict[str, object]:
        return registry.call(self._SVC, "check_vendor", {"vendor_id": vendor_id})

    def check_transaction(self, vendor_id: str, amount: float, currency: str, rail: str) -> dict[str, object]:
        return registry.call(self._SVC, "check_transaction", {
            "vendor_id": vendor_id, "amount": amount, "currency": currency, "rail": rail,
        })


class OcrVisionClient:
    _SVC = "ocr-vision"

    def extract_invoice(self, invoice_id: str, document_ref: str) -> dict[str, object]:
        return registry.call(self._SVC, "extract_invoice", {
            "invoice_id": invoice_id, "document_ref": document_ref,
        })


class VendorPortalClient:
    _SVC = "vendor-portal"

    def get_vendor_profile(self, vendor_id: str) -> dict[str, object]:
        return registry.call(self._SVC, "get_vendor_profile", {"vendor_id": vendor_id})

    def get_contract_terms(self, vendor_id: str) -> dict[str, object]:
        return registry.call(self._SVC, "get_contract_terms", {"vendor_id": vendor_id})


class TaxRulesClient:
    _SVC = "tax-rules"

    def get_withholding_rate(self, region: str, currency: str) -> dict[str, object]:
        return registry.call(self._SVC, "get_withholding_rate", {"region": region, "currency": currency})

    def validate_tax_id(self, vendor_id: str) -> dict[str, object]:
        return registry.call(self._SVC, "validate_tax_id", {"vendor_id": vendor_id})


class FXRatesClient:
    _SVC = "fx-rates"

    def get_rate(self, from_currency: str, to_currency: str) -> dict[str, object]:
        return registry.call(self._SVC, "get_rate", {"from_currency": from_currency, "to_currency": to_currency})

    def get_rates_batch(self, base_currency: str) -> dict[str, object]:
        return registry.call(self._SVC, "get_rates_batch", {"base_currency": base_currency})


mercury_bank = MercuryBankClient()
wise_payouts = WisePayoutsClient()
stripe_treasury = StripeTreasuryClient()
netsuite = NetSuiteClient()
sap_erp = SapErpClient()
quickbooks = QuickBooksClient()
compliance_nexus = ComplianceNexusClient()
ocr_vision = OcrVisionClient()
vendor_portal = VendorPortalClient()
tax_rules = TaxRulesClient()
fx_rates = FXRatesClient()
