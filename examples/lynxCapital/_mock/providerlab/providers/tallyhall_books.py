"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tallyhall Books domain: a QuickBooks Online-style SMB company file with a chart of accounts, vendors, customers, bills, invoices, expenses, payments, journal entries, and financial reports.
"""

from __future__ import annotations

import time

from _mock.providerlab.data import generators as gen
from _mock.providerlab.providers import base
from _mock.providerlab.providers.base import Ctx, DomainError

ID = "tallyhall-books"

ACCOUNTING = "com.intuit.quickbooks.accounting"
PAYMENT = "com.intuit.quickbooks.payment"

_REPORTS = (
    "ProfitAndLoss",
    "BalanceSheet",
    "AgedPayables",
    "AgedReceivables",
    "TrialBalance",
    "CustomerBalance",
    "VendorBalance",
)


def _iso(epoch: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def _today() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(base.now()))


def _qid(ctx: Ctx) -> str:
    ctx.state.seq += 1
    return str(9_000_000 + ctx.state.seq)


def _meta(now: int) -> dict:
    return {"CreateTime": _iso(now), "LastUpdatedTime": _iso(now)}


def _bump(entity: dict) -> dict:
    entity["SyncToken"] = str(int(entity.get("SyncToken", "0")) + 1)
    entity.setdefault("MetaData", {})["LastUpdatedTime"] = _iso(base.now())
    return entity


@base.seeder(ID)
def seed(state: base.State) -> None:
    for name, table in gen.quickbooks_dataset(ID).items():
        state.tables[name] = table


def _company(ctx: Ctx) -> dict:
    return ctx.state.table("company")["1"]


def _check_realm(ctx: Ctx) -> None:
    """QBO scopes a token to one company file; a call against the wrong realmId is
    rejected with 401 the way Intuit's gateway rejects a mismatched realm."""
    requested = ctx.get("realmId")
    if requested and str(requested) != _company(ctx)["realmId"]:
        raise DomainError(
            401,
            "AuthenticationFailed",
            f"token is not authorized for realm {requested}",
        )


def _guard(ctx: Ctx, scope: str) -> None:
    """Every QBO call carries the company realm and a required scope; validate both
    the way Intuit's gateway does before the operation touches the company file."""
    ctx.require_scope(scope)
    _check_realm(ctx)


def _lookup(ctx: Ctx, table: str, field: str, code: str) -> dict:
    ctx.require(field)
    record = ctx.state.table(table).get(str(ctx.payload[field]))
    if record is None:
        raise DomainError(404, code, f"{field} {ctx.payload[field]} not found")
    return record


def _amount(ctx: Ctx, *fields: str) -> float:
    for field in fields:
        if ctx.get(field) is not None:
            try:
                value = float(ctx.payload[field])
            except (TypeError, ValueError):
                raise DomainError(400, "ValidationFault", f"{field} must be numeric")
            if value <= 0:
                raise DomainError(400, "ValidationFault", f"{field} must be positive")
            return value
    raise DomainError(400, "ValidationFault", f"provide one of: {', '.join(fields)}")


# --------------------------------------------------------------------------- #
# Company file
# --------------------------------------------------------------------------- #
@base.op(ID, "get_company_info")
def get_company_info(ctx: Ctx) -> dict:
    _guard(ctx, ACCOUNTING)
    return _company(ctx)


# --------------------------------------------------------------------------- #
# Chart of accounts
# --------------------------------------------------------------------------- #
@base.op(ID, "list_accounts")
def list_accounts(ctx: Ctx) -> dict:
    _guard(ctx, ACCOUNTING)
    items = list(ctx.state.table("accounts").values())
    classification = ctx.get("classification")
    if classification:
        items = [a for a in items if a["Classification"] == classification]
    acct_type = ctx.get("accountType")
    if acct_type:
        items = [a for a in items if a["AccountType"] == acct_type]
    items.sort(key=lambda a: a["AcctNum"])
    return ctx.paginate(items, size_default=25)


@base.op(ID, "get_account")
def get_account(ctx: Ctx) -> dict:
    _guard(ctx, ACCOUNTING)
    accounts = ctx.state.table("accounts")
    account_id = ctx.payload.get("accountId")
    if account_id is None:
        raise DomainError(
            400, "ValidationFault", "missing required field(s): accountId"
        )
    acct = accounts.get(str(account_id))
    if acct is None:
        acct = next(
            (a for a in accounts.values() if a["AcctNum"] == str(account_id)), None
        )
    if acct is None:
        raise DomainError(404, "account_not_found", str(account_id))
    return acct


# --------------------------------------------------------------------------- #
# Vendors
# --------------------------------------------------------------------------- #
@base.op(ID, "list_vendors")
def list_vendors(ctx: Ctx) -> dict:
    _guard(ctx, ACCOUNTING)
    items = list(ctx.state.table("vendors").values())
    query = str(ctx.get("query", "")).lower()
    if query:
        items = [v for v in items if query in v["DisplayName"].lower()]
    if ctx.get("active") is not None:
        want = bool(ctx.get("active"))
        items = [v for v in items if v["Active"] == want]
    items.sort(key=lambda v: int(v["Id"]))
    return ctx.paginate(items, size_default=20)


@base.op(ID, "get_vendor")
def get_vendor(ctx: Ctx) -> dict:
    _guard(ctx, ACCOUNTING)
    return _lookup(ctx, "vendors", "vendorId", "vendor_not_found")


@base.op(ID, "create_vendor")
def create_vendor(ctx: Ctx) -> dict:
    _guard(ctx, ACCOUNTING)
    ctx.require("displayName")
    name = str(ctx.payload["displayName"])
    for existing in ctx.state.table("vendors").values():
        if existing["DisplayName"].lower() == name.lower():
            raise DomainError(
                400, "DuplicateName", f"another vendor already uses the name {name!r}"
            )
    now = base.now()
    currency = ctx.get("currency", "USD")
    vendor = {
        "Id": _qid(ctx),
        "DisplayName": name,
        "CompanyName": ctx.get("companyName", name),
        "PrintOnCheckName": name,
        "Active": True,
        "Vendor1099": bool(ctx.get("vendor1099", False)),
        "Balance": 0.0,
        "AcctNum": ctx.get("acctNum"),
        "TaxIdentifier": ctx.get("taxId"),
        "PrimaryEmailAddr": {"Address": ctx.get("email", "")},
        "CurrencyRef": gen._ccy_ref(currency),
        "domain": "QBO",
        "sparse": False,
        "SyncToken": "0",
        "MetaData": _meta(now),
    }
    ctx.state.table("vendors")[vendor["Id"]] = vendor
    return vendor


# --------------------------------------------------------------------------- #
# Customers
# --------------------------------------------------------------------------- #
@base.op(ID, "list_customers")
def list_customers(ctx: Ctx) -> dict:
    _guard(ctx, ACCOUNTING)
    items = list(ctx.state.table("customers").values())
    query = str(ctx.get("query", "")).lower()
    if query:
        items = [c for c in items if query in c["DisplayName"].lower()]
    if ctx.get("active") is not None:
        want = bool(ctx.get("active"))
        items = [c for c in items if c["Active"] == want]
    items.sort(key=lambda c: int(c["Id"]))
    return ctx.paginate(items, size_default=20)


@base.op(ID, "get_customer")
def get_customer(ctx: Ctx) -> dict:
    _guard(ctx, ACCOUNTING)
    return _lookup(ctx, "customers", "customerId", "customer_not_found")


@base.op(ID, "create_customer")
def create_customer(ctx: Ctx) -> dict:
    _guard(ctx, ACCOUNTING)
    ctx.require("displayName")
    name = str(ctx.payload["displayName"])
    for existing in ctx.state.table("customers").values():
        if existing["DisplayName"].lower() == name.lower():
            raise DomainError(
                400, "DuplicateName", f"another customer already uses the name {name!r}"
            )
    now = base.now()
    currency = ctx.get("currency", "USD")
    taxable = bool(ctx.get("taxable", currency == "USD"))
    customer = {
        "Id": _qid(ctx),
        "DisplayName": name,
        "CompanyName": ctx.get("companyName", name),
        "Active": True,
        "Job": False,
        "BillWithParent": False,
        "Level": 0,
        "Taxable": taxable,
        "DefaultTaxCodeRef": {"value": "3"} if taxable else None,
        "Balance": 0.0,
        "BalanceWithJobs": 0.0,
        "PrimaryEmailAddr": {"Address": ctx.get("email", "")},
        "PreferredDeliveryMethod": ctx.get("deliveryMethod", "Email"),
        "CurrencyRef": gen._ccy_ref(currency),
        "domain": "QBO",
        "sparse": False,
        "SyncToken": "0",
        "MetaData": _meta(now),
    }
    ctx.state.table("customers")[customer["Id"]] = customer
    return customer


# --------------------------------------------------------------------------- #
# Items
# --------------------------------------------------------------------------- #
@base.op(ID, "list_items")
def list_items(ctx: Ctx) -> dict:
    _guard(ctx, ACCOUNTING)
    items = sorted(ctx.state.table("items").values(), key=lambda i: int(i["Id"]))
    return ctx.paginate(items, size_default=25)


# --------------------------------------------------------------------------- #
# Bills (accounts payable)
# --------------------------------------------------------------------------- #
def _ap_status(bill: dict) -> str:
    if bill["Balance"] == 0.0:
        return "Paid"
    if bill["DueDate"] < _today():
        return "Overdue"
    return "Open"


def _bill_view(bill: dict) -> dict:
    view = dict(bill)
    view["status"] = _ap_status(bill)
    return view


@base.op(ID, "list_bills")
def list_bills(ctx: Ctx) -> dict:
    _guard(ctx, ACCOUNTING)
    items = list(ctx.state.table("bills").values())
    vendor_id = ctx.get("vendorId")
    if vendor_id:
        items = [b for b in items if b["VendorRef"]["value"] == str(vendor_id)]
    status = ctx.get("status")
    if status:
        items = [b for b in items if _ap_status(b).lower() == str(status).lower()]
    items.sort(key=lambda b: b["TxnDate"], reverse=True)
    return ctx.paginate([_bill_view(b) for b in items], size_default=20)


@base.op(ID, "get_bill")
def get_bill(ctx: Ctx) -> dict:
    _guard(ctx, ACCOUNTING)
    return _bill_view(_lookup(ctx, "bills", "billId", "bill_not_found"))


@base.op(ID, "create_bill")
def create_bill(ctx: Ctx) -> dict:
    _guard(ctx, ACCOUNTING)
    vendor = _lookup(ctx, "vendors", "vendorId", "vendor_not_found")
    if not vendor["Active"]:
        raise DomainError(
            400,
            "ObjectInactive",
            f"vendor {vendor['Id']} is inactive and cannot be billed",
        )
    currency = ctx.get("currency", vendor["CurrencyRef"]["value"])
    if currency != vendor["CurrencyRef"]["value"]:
        raise DomainError(
            400,
            "CurrencyMismatch",
            f"vendor transacts in {vendor['CurrencyRef']['value']}, not {currency}",
        )
    accounts = ctx.state.table("accounts")
    ap = next(a for a in accounts.values() if a["AccountSubType"] == "AccountsPayable")

    doc_number = ctx.get("docNumber")
    if doc_number:
        for existing in ctx.state.table("bills").values():
            if (
                existing["VendorRef"]["value"] == vendor["Id"]
                and existing.get("DocNumber") == doc_number
            ):
                raise DomainError(
                    400,
                    "DuplicateDocNum",
                    f"bill {doc_number} already recorded as {existing['Id']}",
                )

    lines = _expense_lines(ctx, accounts, currency)
    total = gen._qbo_round(sum(line["Amount"] for line in lines), currency)
    now = base.now()
    bill = {
        "Id": _qid(ctx),
        "DocNumber": doc_number,
        "VendorRef": {"value": vendor["Id"], "name": vendor["DisplayName"]},
        "APAccountRef": {"value": ap["Id"], "name": ap["Name"]},
        "SalesTermRef": vendor.get("TermRef"),
        "TxnDate": ctx.get("txnDate", _today()),
        "DueDate": ctx.get("dueDate", _date_plus(_term_days(vendor))),
        "CurrencyRef": gen._ccy_ref(currency),
        "Line": lines,
        "TotalAmt": total,
        "Balance": total,
        "PrivateNote": ctx.get("memo", ""),
        "LinkedTxn": [],
        "domain": "QBO",
        "sparse": False,
        "SyncToken": "0",
        "MetaData": _meta(now),
    }
    if currency != gen._QBO_HOME_CCY and ctx.get("exchangeRate"):
        bill["ExchangeRate"] = float(ctx.payload["exchangeRate"])
    ctx.state.table("bills")[bill["Id"]] = bill
    vendor["Balance"] = round(vendor["Balance"] + total, 2)
    ap["CurrentBalance"] = round(ap["CurrentBalance"] + total, 2)
    return _bill_view(bill)


@base.op(ID, "match_bill")
def match_bill(ctx: Ctx) -> dict:
    """Link a vendor bill to its source document (a purchase order or expense
    reference) the way QBO threads transactions through LinkedTxn."""
    _guard(ctx, ACCOUNTING)
    bill = _lookup(ctx, "bills", "billId", "bill_not_found")
    if any(t.get("TxnType") == "PurchaseOrder" for t in bill["LinkedTxn"]):
        raise DomainError(400, "AlreadyLinked", f"bill {bill['Id']} is already matched")
    po_ref = ctx.get("poRef") or ctx.get("docNumber")
    if po_ref:
        bill["LinkedTxn"].append({"TxnId": str(po_ref), "TxnType": "PurchaseOrder"})
    bill["matched"] = True
    return _bill_view(_bump(bill))


@base.op(ID, "pay_bill")
def pay_bill(ctx: Ctx) -> dict:
    """Settle a vendor bill, emitting a QBO BillPayment and clearing A/P."""
    _guard(ctx, PAYMENT)
    bill = _lookup(ctx, "bills", "billId", "bill_not_found")
    if bill["Balance"] == 0.0:
        raise DomainError(400, "AlreadyPaid", f"bill {bill['Id']} is fully paid")
    currency = bill["CurrencyRef"]["value"]
    amount = gen._qbo_round(float(ctx.get("amount", bill["Balance"])), currency)
    if amount <= 0:
        raise DomainError(400, "ValidationFault", "payment amount must be positive")
    if amount > bill["Balance"] + 1e-6:
        raise DomainError(
            400,
            "AmountExceedsBalance",
            f"amount {amount} exceeds bill balance {bill['Balance']}",
        )
    accounts = ctx.state.table("accounts")
    pay_type = ctx.get("payType", "Check")
    funding = _funding_account(accounts, pay_type)
    now = base.now()
    payment = {
        "Id": _qid(ctx),
        "VendorRef": bill["VendorRef"],
        "PayType": pay_type,
        "TxnDate": ctx.get("txnDate", _today()),
        "CurrencyRef": gen._ccy_ref(currency),
        "TotalAmt": amount,
        "Line": [
            {"Amount": amount, "LinkedTxn": [{"TxnId": bill["Id"], "TxnType": "Bill"}]}
        ],
        "domain": "QBO",
        "sparse": False,
        "SyncToken": "0",
        "MetaData": _meta(now),
    }
    if pay_type == "Check":
        payment["CheckPayment"] = {
            "BankAccountRef": {"value": funding["Id"], "name": funding["Name"]}
        }
    else:
        payment["CreditCardPayment"] = {
            "CCAccountRef": {"value": funding["Id"], "name": funding["Name"]}
        }
    ctx.state.table("bill_payments")[payment["Id"]] = payment

    bill["Balance"] = round(bill["Balance"] - amount, 2)
    bill["LinkedTxn"].append({"TxnId": payment["Id"], "TxnType": "BillPayment"})
    _bump(bill)
    vendor = ctx.state.table("vendors").get(bill["VendorRef"]["value"])
    if vendor:
        vendor["Balance"] = round(vendor["Balance"] - amount, 2)
    ap = next(a for a in accounts.values() if a["AccountSubType"] == "AccountsPayable")
    ap["CurrentBalance"] = round(ap["CurrentBalance"] - amount, 2)
    funding["CurrentBalance"] = round(funding["CurrentBalance"] - amount, 2)
    return payment


# --------------------------------------------------------------------------- #
# Invoices (accounts receivable)
# --------------------------------------------------------------------------- #
def _ar_status(inv: dict) -> str:
    if inv.get("status_voided"):
        return "Voided"
    if inv["Balance"] == 0.0:
        return "Paid"
    if 0 < inv["Balance"] < inv["TotalAmt"]:
        return "PartiallyPaid"
    if inv["DueDate"] < _today():
        return "Overdue"
    return "Open"


def _invoice_view(inv: dict) -> dict:
    view = dict(inv)
    view["status"] = _ar_status(inv)
    return view


@base.op(ID, "list_invoices")
def list_invoices(ctx: Ctx) -> dict:
    _guard(ctx, ACCOUNTING)
    items = list(ctx.state.table("invoices").values())
    customer_id = ctx.get("customerId")
    if customer_id:
        items = [i for i in items if i["CustomerRef"]["value"] == str(customer_id)]
    status = ctx.get("status")
    if status:
        items = [i for i in items if _ar_status(i).lower() == str(status).lower()]
    items.sort(key=lambda i: i["TxnDate"], reverse=True)
    return ctx.paginate([_invoice_view(i) for i in items], size_default=20)


@base.op(ID, "get_invoice")
def get_invoice(ctx: Ctx) -> dict:
    _guard(ctx, ACCOUNTING)
    return _invoice_view(_lookup(ctx, "invoices", "invoiceId", "invoice_not_found"))


@base.op(ID, "create_invoice")
def create_invoice(ctx: Ctx) -> dict:
    _guard(ctx, ACCOUNTING)
    customer = _resolve_customer(ctx)
    currency = ctx.get("currency", customer["CurrencyRef"]["value"])
    accounts = ctx.state.table("accounts")
    ar = next(
        a for a in accounts.values() if a["AccountSubType"] == "AccountsReceivable"
    )
    income = next(a for a in accounts.values() if a["AcctNum"] == "4000")
    lines = _sales_lines(ctx, currency)
    subtotal = gen._qbo_round(sum(line["Amount"] for line in lines), currency)
    tax = gen._qbo_round(subtotal * (0.0825 if customer["Taxable"] else 0.0), currency)
    total = gen._qbo_round(subtotal + tax, currency)
    now = base.now()
    invoice = {
        "Id": _qid(ctx),
        "DocNumber": ctx.get("docNumber", f"INV-{base.now() % 100000}"),
        "CustomerRef": {"value": customer["Id"], "name": customer["DisplayName"]},
        "ARAccountRef": {"value": ar["Id"], "name": ar["Name"]},
        "TxnDate": ctx.get("txnDate", _today()),
        "DueDate": ctx.get("dueDate", _date_plus(int(ctx.get("dueInDays", 30)))),
        "CurrencyRef": gen._ccy_ref(currency),
        "Line": lines
        + [
            {
                "Amount": subtotal,
                "DetailType": "SubTotalLineDetail",
                "SubTotalLineDetail": {},
            }
        ],
        "TxnTaxDetail": gen._qbo_tax_detail(tax, currency, customer["Taxable"]),
        "TotalAmt": total,
        "Balance": total,
        "ApplyTaxAfterDiscount": False,
        "PrintStatus": "NeedToPrint",
        "EmailStatus": "NeedToSend",
        "BillAddr": customer.get("BillAddr"),
        "ShipAddr": customer.get("ShipAddr"),
        "BillEmail": customer.get("PrimaryEmailAddr", {"Address": ""}),
        "CustomerMemo": {
            "value": ctx.get("customerMemo", "Thank you for your business.")
        },
        "AllowOnlineCreditCardPayment": True,
        "AllowOnlineACHPayment": currency == gen._QBO_HOME_CCY,
        "PrivateNote": ctx.get("memo", ""),
        "LinkedTxn": [],
        "domain": "QBO",
        "sparse": False,
        "SyncToken": "0",
        "MetaData": _meta(now),
    }
    if currency != gen._QBO_HOME_CCY and ctx.get("exchangeRate"):
        invoice["ExchangeRate"] = float(ctx.payload["exchangeRate"])
    ctx.state.table("invoices")[invoice["Id"]] = invoice
    customer["Balance"] = round(customer["Balance"] + total, 2)
    customer["BalanceWithJobs"] = customer["Balance"]
    ar["CurrentBalance"] = round(ar["CurrentBalance"] + total, 2)
    income["CurrentBalance"] = round(income["CurrentBalance"] + subtotal, 2)
    return _invoice_view(invoice)


@base.op(ID, "send_invoice")
def send_invoice(ctx: Ctx) -> dict:
    _guard(ctx, ACCOUNTING)
    invoice = _lookup(ctx, "invoices", "invoiceId", "invoice_not_found")
    email = ctx.get("email") or invoice.get("BillEmail", {}).get("Address")
    if not email:
        raise DomainError(
            400, "ValidationFault", "no billing email on file; provide email"
        )
    invoice["EmailStatus"] = "EmailSent"
    invoice["DeliveryInfo"] = {
        "DeliveryType": "Email",
        "DeliveryTime": _iso(base.now()),
    }
    invoice["BillEmail"] = {"Address": email}
    return _invoice_view(_bump(invoice))


@base.op(ID, "void_invoice")
def void_invoice(ctx: Ctx) -> dict:
    _guard(ctx, ACCOUNTING)
    invoice = _lookup(ctx, "invoices", "invoiceId", "invoice_not_found")
    if invoice.get("LinkedTxn"):
        raise DomainError(
            400,
            "VoidNotAllowed",
            "invoice has applied payments; unapply them before voiding",
        )
    accounts = ctx.state.table("accounts")
    ar = next(
        a for a in accounts.values() if a["AccountSubType"] == "AccountsReceivable"
    )
    customer = ctx.state.table("customers").get(invoice["CustomerRef"]["value"])
    if customer and invoice["Balance"]:
        customer["Balance"] = round(customer["Balance"] - invoice["Balance"], 2)
        customer["BalanceWithJobs"] = customer["Balance"]
        ar["CurrentBalance"] = round(ar["CurrentBalance"] - invoice["Balance"], 2)
    invoice["Balance"] = 0.0
    invoice["TotalAmt"] = 0.0
    invoice["PrivateNote"] = "Voided"
    invoice["status_voided"] = True
    return _invoice_view(_bump(invoice))


# --------------------------------------------------------------------------- #
# Customer payments (accounts receivable settlement)
# --------------------------------------------------------------------------- #
@base.op(ID, "record_payment")
def record_payment(ctx: Ctx) -> dict:
    """Receive a customer payment and apply it against an open invoice."""
    _guard(ctx, PAYMENT)
    invoice = _lookup(ctx, "invoices", "invoiceId", "invoice_not_found")
    if invoice["Balance"] == 0.0:
        raise DomainError(400, "AlreadyPaid", f"invoice {invoice['Id']} is fully paid")
    currency = invoice["CurrencyRef"]["value"]
    amount = gen._qbo_round(float(ctx.get("amount", invoice["Balance"])), currency)
    if amount <= 0:
        raise DomainError(400, "ValidationFault", "payment amount must be positive")
    if amount > invoice["Balance"] + 1e-6:
        raise DomainError(
            400,
            "AmountExceedsBalance",
            f"amount {amount} exceeds invoice balance {invoice['Balance']}",
        )
    accounts = ctx.state.table("accounts")
    deposit = next(
        a for a in accounts.values() if a["AccountSubType"] == "UndepositedFunds"
    )
    ar = next(
        a for a in accounts.values() if a["AccountSubType"] == "AccountsReceivable"
    )
    now = base.now()
    payment = {
        "Id": _qid(ctx),
        "CustomerRef": invoice["CustomerRef"],
        "TxnDate": ctx.get("txnDate", _today()),
        "CurrencyRef": gen._ccy_ref(currency),
        "TotalAmt": amount,
        "UnappliedAmt": 0.0,
        "PaymentMethodRef": {"value": ctx.get("paymentMethod", "Check")},
        "DepositToAccountRef": {"value": deposit["Id"], "name": deposit["Name"]},
        "Line": [
            {
                "Amount": amount,
                "LinkedTxn": [{"TxnId": invoice["Id"], "TxnType": "Invoice"}],
            }
        ],
        "domain": "QBO",
        "sparse": False,
        "SyncToken": "0",
        "MetaData": _meta(now),
    }
    ctx.state.table("payments")[payment["Id"]] = payment
    invoice["Balance"] = round(invoice["Balance"] - amount, 2)
    invoice["LinkedTxn"].append({"TxnId": payment["Id"], "TxnType": "Payment"})
    _bump(invoice)
    customer = ctx.state.table("customers").get(invoice["CustomerRef"]["value"])
    if customer:
        customer["Balance"] = round(customer["Balance"] - amount, 2)
        customer["BalanceWithJobs"] = customer["Balance"]
    ar["CurrentBalance"] = round(ar["CurrentBalance"] - amount, 2)
    deposit["CurrentBalance"] = round(deposit["CurrentBalance"] + amount, 2)
    return payment


# --------------------------------------------------------------------------- #
# Expenses (cash / card purchases)
# --------------------------------------------------------------------------- #
@base.op(ID, "list_expenses")
def list_expenses(ctx: Ctx) -> dict:
    _guard(ctx, ACCOUNTING)
    items = list(ctx.state.table("expenses").values())
    vendor_id = ctx.get("vendorId")
    if vendor_id:
        items = [e for e in items if e["EntityRef"]["value"] == str(vendor_id)]
    items.sort(key=lambda e: e["TxnDate"], reverse=True)
    return ctx.paginate(items, size_default=20)


@base.op(ID, "get_expense")
def get_expense(ctx: Ctx) -> dict:
    _guard(ctx, ACCOUNTING)
    return _lookup(ctx, "expenses", "expenseId", "expense_not_found")


@base.op(ID, "create_expense")
def create_expense(ctx: Ctx) -> dict:
    _guard(ctx, ACCOUNTING)
    vendor = _lookup(ctx, "vendors", "vendorId", "vendor_not_found")
    currency = ctx.get("currency", vendor["CurrencyRef"]["value"])
    accounts = ctx.state.table("accounts")
    pay_type = ctx.get("paymentType", "CreditCard")
    funding = _funding_account(accounts, pay_type)
    lines = _expense_lines(ctx, accounts, currency)
    total = gen._qbo_round(sum(line["Amount"] for line in lines), currency)
    now = base.now()
    expense = {
        "Id": _qid(ctx),
        "PaymentType": pay_type,
        "DocNumber": ctx.get("docNumber"),
        "AccountRef": {"value": funding["Id"], "name": funding["Name"]},
        "EntityRef": {
            "value": vendor["Id"],
            "name": vendor["DisplayName"],
            "type": "Vendor",
        },
        "TxnDate": ctx.get("txnDate", _today()),
        "CurrencyRef": gen._ccy_ref(currency),
        "TotalAmt": total,
        "Credit": False,
        "Line": lines,
        "domain": "QBO",
        "sparse": False,
        "SyncToken": "0",
        "MetaData": _meta(now),
    }
    ctx.state.table("expenses")[expense["Id"]] = expense
    funding["CurrentBalance"] = round(funding["CurrentBalance"] - total, 2)
    for line in lines:
        acct_id = line["AccountBasedExpenseLineDetail"]["AccountRef"]["value"]
        accounts[acct_id]["CurrentBalance"] = round(
            accounts[acct_id]["CurrentBalance"] + line["Amount"], 2
        )
    return expense


# --------------------------------------------------------------------------- #
# Journal entries
# --------------------------------------------------------------------------- #
@base.op(ID, "list_journal_entries")
def list_journal_entries(ctx: Ctx) -> dict:
    _guard(ctx, ACCOUNTING)
    items = sorted(
        ctx.state.table("journal_entries").values(),
        key=lambda e: e["TxnDate"],
        reverse=True,
    )
    return ctx.paginate(items, size_default=20)


@base.op(ID, "get_journal_entry")
def get_journal_entry(ctx: Ctx) -> dict:
    _guard(ctx, ACCOUNTING)
    return _lookup(ctx, "journal_entries", "entryId", "journal_entry_not_found")


@base.op(ID, "post_journal_entry")
def post_journal_entry(ctx: Ctx) -> dict:
    _guard(ctx, ACCOUNTING)
    raw_lines = ctx.get("lines") or []
    if len(raw_lines) < 2:
        raise DomainError(
            400, "ValidationFault", "a journal entry needs at least two lines"
        )
    accounts = ctx.state.table("accounts")
    debit = credit = 0.0
    lines = []
    for n, line in enumerate(raw_lines):
        acct = _resolve_account(accounts, str(line.get("account", "")))
        if acct is None:
            raise DomainError(
                400,
                "InvalidAccountRef",
                f"account {line.get('account')} is not in the chart",
            )
        d = float(line.get("debit", 0) or 0)
        c = float(line.get("credit", 0) or 0)
        posting = "Debit" if d else "Credit"
        debit += d
        credit += c
        lines.append(
            {
                "Id": str(n),
                "Description": line.get("memo", ""),
                "Amount": d or c,
                "DetailType": "JournalEntryLineDetail",
                "JournalEntryLineDetail": {
                    "PostingType": posting,
                    "AccountRef": {"value": acct["Id"], "name": acct["Name"]},
                },
            }
        )
    if round(debit - credit, 2) != 0:
        raise DomainError(
            400, "UnbalancedTransaction", f"debits {debit} != credits {credit}"
        )
    now = base.now()
    entry = {
        "Id": _qid(ctx),
        "DocNumber": ctx.get("docNumber", f"JE-{base.now() % 100000}"),
        "TxnDate": ctx.get("txnDate", _today()),
        "Adjustment": bool(ctx.get("adjustment", False)),
        "CurrencyRef": gen._ccy_ref(ctx.get("currency", "USD")),
        "Line": lines,
        "TotalAmt": round(debit, 2),
        "PrivateNote": ctx.get("memo", ""),
        "domain": "QBO",
        "sparse": False,
        "SyncToken": "0",
        "MetaData": _meta(now),
    }
    ctx.state.table("journal_entries")[entry["Id"]] = entry
    for line in lines:
        acct_id = line["JournalEntryLineDetail"]["AccountRef"]["value"]
        delta = (
            line["Amount"]
            if line["JournalEntryLineDetail"]["PostingType"] == "Debit"
            else -line["Amount"]
        )
        accounts[acct_id]["CurrentBalance"] = round(
            accounts[acct_id]["CurrentBalance"] + delta, 2
        )
    return entry


# --------------------------------------------------------------------------- #
# Reports
# --------------------------------------------------------------------------- #
@base.op(ID, "get_report")
def get_report(ctx: Ctx) -> dict:
    _guard(ctx, ACCOUNTING)
    name = ctx.get("reportType", "ProfitAndLoss")
    if name not in _REPORTS:
        raise DomainError(
            400,
            "InvalidReport",
            f"unknown report {name!r}; supported: {', '.join(_REPORTS)}",
        )
    builder = {
        "ProfitAndLoss": _report_pl,
        "BalanceSheet": _report_balance_sheet,
        "AgedPayables": _report_aged_payables,
        "AgedReceivables": _report_aged_receivables,
        "TrialBalance": _report_trial_balance,
        "CustomerBalance": _report_customer_balance,
        "VendorBalance": _report_vendor_balance,
    }[name]
    return builder(ctx)


def _report_header(name: str) -> dict:
    return {
        "ReportName": name,
        "Time": _iso(base.now()),
        "ReportBasis": "Accrual",
        "StartPeriod": gen._EPOCH.isoformat(),
        "EndPeriod": _today(),
        "Currency": gen._QBO_HOME_CCY,
    }


def _money_row(label: str, amount: float) -> dict:
    return {"type": "Data", "ColData": [{"value": label}, {"value": f"{amount:.2f}"}]}


def _report_pl(ctx: Ctx) -> dict:
    accounts = ctx.state.table("accounts")
    income_rows, expense_rows = [], []
    income_total = expense_total = 0.0
    for acct in sorted(accounts.values(), key=lambda a: a["AcctNum"]):
        balance = acct["CurrentBalance"]
        if acct["Classification"] == "Revenue" and balance:
            income_rows.append(_money_row(acct["Name"], balance))
            income_total += balance
        elif acct["AccountType"] in ("Expense", "Cost of Goods Sold") and balance:
            expense_rows.append(_money_row(acct["Name"], balance))
            expense_total += balance
    net = round(income_total - expense_total, 2)
    return {
        "Header": _report_header("ProfitAndLoss"),
        "Columns": {
            "Column": [
                {"ColTitle": "", "ColType": "Account"},
                {"ColTitle": "Total", "ColType": "Money"},
            ]
        },
        "Rows": {
            "Row": [
                {
                    "Header": {"ColData": [{"value": "Income"}]},
                    "Rows": {"Row": income_rows},
                    "Summary": {
                        "ColData": [
                            {"value": "Total Income"},
                            {"value": f"{income_total:.2f}"},
                        ]
                    },
                    "type": "Section",
                },
                {
                    "Header": {"ColData": [{"value": "Expenses"}]},
                    "Rows": {"Row": expense_rows},
                    "Summary": {
                        "ColData": [
                            {"value": "Total Expenses"},
                            {"value": f"{expense_total:.2f}"},
                        ]
                    },
                    "type": "Section",
                },
                {
                    "Summary": {
                        "ColData": [{"value": "Net Income"}, {"value": f"{net:.2f}"}]
                    },
                    "type": "Section",
                    "group": "NetIncome",
                },
            ]
        },
    }


def _report_balance_sheet(ctx: Ctx) -> dict:
    accounts = ctx.state.table("accounts")
    sections = {"Asset": [], "Liability": [], "Equity": []}
    totals = {"Asset": 0.0, "Liability": 0.0, "Equity": 0.0}
    for acct in sorted(accounts.values(), key=lambda a: a["AcctNum"]):
        cls = acct["Classification"]
        if cls in sections and acct["CurrentBalance"]:
            sections[cls].append(_money_row(acct["Name"], acct["CurrentBalance"]))
            totals[cls] += acct["CurrentBalance"]
    rows = []
    for cls in ("Asset", "Liability", "Equity"):
        rows.append(
            {
                "Header": {"ColData": [{"value": cls}]},
                "Rows": {"Row": sections[cls]},
                "Summary": {
                    "ColData": [
                        {"value": f"Total {cls}"},
                        {"value": f"{totals[cls]:.2f}"},
                    ]
                },
                "type": "Section",
            }
        )
    return {
        "Header": _report_header("BalanceSheet"),
        "Columns": {
            "Column": [
                {"ColTitle": "", "ColType": "Account"},
                {"ColTitle": "Total", "ColType": "Money"},
            ]
        },
        "Rows": {"Row": rows},
        "Reconciled": round(
            totals["Asset"] - totals["Liability"] - totals["Equity"], 2
        ),
    }


def _aging_bucket(due_date: str) -> str:
    days = (
        gen.date.fromisoformat(_today()) - gen.date.fromisoformat(due_date[:10])
    ).days
    if days <= 0:
        return "Current"
    if days <= 30:
        return "1-30"
    if days <= 60:
        return "31-60"
    if days <= 90:
        return "61-90"
    return "91+"


def _aging(records, ref_key: str) -> dict:
    buckets = {"Current": 0.0, "1-30": 0.0, "31-60": 0.0, "61-90": 0.0, "91+": 0.0}
    rows = []
    for rec in records:
        if rec["Balance"] <= 0:
            continue
        bucket = _aging_bucket(rec["DueDate"])
        buckets[bucket] = round(buckets[bucket] + rec["Balance"], 2)
        rows.append(
            {
                "type": "Data",
                "ColData": [
                    {"value": rec[ref_key]["name"]},
                    {"value": rec.get("DocNumber", rec["Id"])},
                    {"value": rec["DueDate"]},
                    {"value": bucket},
                    {"value": f"{rec['Balance']:.2f}"},
                ],
            }
        )
    return {"rows": rows, "buckets": buckets, "total": round(sum(buckets.values()), 2)}


def _report_aged_payables(ctx: Ctx) -> dict:
    aged = _aging(ctx.state.table("bills").values(), "VendorRef")
    return {
        "Header": _report_header("AgedPayables"),
        "Columns": {
            "Column": [
                {"ColTitle": c}
                for c in ("Vendor", "Num", "Due Date", "Aging", "Open Balance")
            ]
        },
        "Rows": {"Row": aged["rows"]},
        "Summary": {"Buckets": aged["buckets"], "Total": aged["total"]},
    }


def _report_aged_receivables(ctx: Ctx) -> dict:
    aged = _aging(ctx.state.table("invoices").values(), "CustomerRef")
    return {
        "Header": _report_header("AgedReceivables"),
        "Columns": {
            "Column": [
                {"ColTitle": c}
                for c in ("Customer", "Num", "Due Date", "Aging", "Open Balance")
            ]
        },
        "Rows": {"Row": aged["rows"]},
        "Summary": {"Buckets": aged["buckets"], "Total": aged["total"]},
    }


def _report_trial_balance(ctx: Ctx) -> dict:
    accounts = ctx.state.table("accounts")
    rows, debit_total, credit_total = [], 0.0, 0.0
    for acct in sorted(accounts.values(), key=lambda a: a["AcctNum"]):
        balance = acct["CurrentBalance"]
        if not balance:
            continue
        debit_normal = acct["Classification"] in ("Asset",) or acct["AccountType"] in (
            "Expense",
            "Cost of Goods Sold",
        )
        on_debit = (debit_normal and balance > 0) or (not debit_normal and balance < 0)
        debit = abs(balance) if on_debit else 0.0
        credit = abs(balance) if not on_debit else 0.0
        debit_total += debit
        credit_total += credit
        rows.append(
            {
                "type": "Data",
                "ColData": [
                    {"value": acct["Name"]},
                    {"value": f"{debit:.2f}" if debit else ""},
                    {"value": f"{credit:.2f}" if credit else ""},
                ],
            }
        )
    return {
        "Header": _report_header("TrialBalance"),
        "Columns": {
            "Column": [
                {"ColTitle": "Account"},
                {"ColTitle": "Debit"},
                {"ColTitle": "Credit"},
            ]
        },
        "Rows": {"Row": rows},
        "Summary": {"Debit": round(debit_total, 2), "Credit": round(credit_total, 2)},
    }


def _entity_balance(records, name: str, ref_label: str) -> dict:
    """A QBO balance summary: one row per party carrying an open balance, plus the
    rolled-up total that ties to the A/R or A/P control account."""
    rows, total = [], 0.0
    for rec in sorted(records, key=lambda r: r["DisplayName"]):
        balance = round(rec["Balance"], 2)
        if balance == 0.0:
            continue
        total += balance
        rows.append(
            {
                "type": "Data",
                "ColData": [
                    {"value": rec["DisplayName"], "id": rec["Id"]},
                    {"value": f"{balance:.2f}"},
                ],
            }
        )
    return {
        "Header": _report_header(name),
        "Columns": {
            "Column": [
                {"ColTitle": ref_label, "ColType": "String"},
                {"ColTitle": "Total", "ColType": "Money"},
            ]
        },
        "Rows": {"Row": rows},
        "Summary": {
            "ColData": [{"value": "TOTAL"}, {"value": f"{round(total, 2):.2f}"}]
        },
    }


def _report_customer_balance(ctx: Ctx) -> dict:
    return _entity_balance(
        ctx.state.table("customers").values(), "CustomerBalance", "Customer"
    )


def _report_vendor_balance(ctx: Ctx) -> dict:
    return _entity_balance(
        ctx.state.table("vendors").values(), "VendorBalance", "Vendor"
    )


# --------------------------------------------------------------------------- #
# Shared builders
# --------------------------------------------------------------------------- #
def _term_days(vendor: dict) -> int:
    name = (vendor.get("TermRef") or {}).get("name", "Net 30")
    return {"Net 15": 15, "Net 30": 30, "Net 45": 45, "Net 60": 60}.get(name, 30)


def _date_plus(days: int) -> str:
    return (gen.date.fromisoformat(_today()) + gen.timedelta(days=days)).isoformat()


def _resolve_account(accounts: dict, ref: str):
    if ref in accounts:
        return accounts[ref]
    return next((a for a in accounts.values() if a["AcctNum"] == ref), None)


def _funding_account(accounts: dict, pay_type: str) -> dict:
    if pay_type == "CreditCard":
        return next(a for a in accounts.values() if a["AccountType"] == "Credit Card")
    return next(a for a in accounts.values() if a["AccountType"] == "Bank")


def _resolve_customer(ctx: Ctx) -> dict:
    customers = ctx.state.table("customers")
    customer_id = ctx.get("customerId")
    if customer_id is not None:
        customer = customers.get(str(customer_id))
        if customer is None:
            raise DomainError(404, "customer_not_found", str(customer_id))
        return customer
    name = ctx.get("customer")
    if not name:
        raise DomainError(400, "ValidationFault", "provide customerId or customer")
    match = next(
        (
            c
            for c in customers.values()
            if c["DisplayName"].lower() == str(name).lower()
        ),
        None,
    )
    if match is not None:
        return match
    return create_customer(
        Ctx(
            ctx.provider,
            ctx.state,
            "create_customer",
            {"displayName": str(name)},
            ctx.principal,
        )
    )


def _expense_lines(ctx: Ctx, accounts: dict, currency: str) -> list[dict]:
    raw = ctx.get("lines")
    lines = []
    if isinstance(raw, list) and raw:
        for n, line in enumerate(raw, start=1):
            acct = _resolve_account(accounts, str(line.get("account", "6200")))
            if acct is None:
                raise DomainError(
                    400,
                    "InvalidAccountRef",
                    f"account {line.get('account')} not in chart",
                )
            amount = gen._qbo_round(float(line.get("amount", 0)), currency)
            if amount <= 0:
                raise DomainError(
                    400, "ValidationFault", "each line needs a positive amount"
                )
            lines.append(
                _expense_line(n, amount, acct, line.get("description", acct["Name"]))
            )
        return lines
    amount = _amount(ctx, "amount")
    acct = _resolve_account(accounts, str(ctx.get("account", "6200"))) or accounts["1"]
    lines.append(
        _expense_line(
            1, gen._qbo_round(amount, currency), acct, ctx.get("memo", acct["Name"])
        )
    )
    return lines


def _expense_line(n: int, amount: float, acct: dict, description: str) -> dict:
    return {
        "Id": str(n),
        "Amount": amount,
        "Description": description,
        "DetailType": "AccountBasedExpenseLineDetail",
        "AccountBasedExpenseLineDetail": {
            "AccountRef": {"value": acct["Id"], "name": acct["Name"]},
            "BillableStatus": "NotBillable",
            "TaxCodeRef": {"value": "NON"},
        },
    }


def _sales_lines(ctx: Ctx, currency: str) -> list[dict]:
    items = ctx.state.table("items")
    raw = ctx.get("lines")
    lines = []
    if isinstance(raw, list) and raw:
        for n, line in enumerate(raw, start=1):
            qty = int(line.get("quantity", 1))
            rate = gen._qbo_round(
                float(line.get("rate", line.get("amount", 0))), currency
            )
            amount = gen._qbo_round(float(line.get("amount", qty * rate)), currency)
            if amount <= 0:
                raise DomainError(
                    400, "ValidationFault", "each line needs a positive amount"
                )
            item = items.get(str(line.get("itemId"))) if line.get("itemId") else None
            lines.append(
                _sales_line(
                    n, amount, qty, rate, item, line.get("description", "Sales")
                )
            )
        return lines
    amount = _amount(ctx, "amount")
    rounded = gen._qbo_round(amount, currency)
    lines.append(_sales_line(1, rounded, 1, rounded, None, ctx.get("memo", "Sales")))
    return lines


def _sales_line(
    n: int, amount: float, qty: int, rate: float, item, description: str
) -> dict:
    detail = {"Qty": qty, "UnitPrice": rate, "TaxCodeRef": {"value": "TAX"}}
    if item is not None:
        detail["ItemRef"] = {"value": item["Id"], "name": item["Name"]}
    return {
        "Id": str(n),
        "LineNum": n,
        "Amount": amount,
        "Description": description,
        "DetailType": "SalesItemLineDetail",
        "SalesItemLineDetail": detail,
    }
