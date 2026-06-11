"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Junction Procurement domain: procure-to-pay suppliers, commodity catalog, cost-center budgets, tiered requisition approvals, purchase orders, and goods receipts.
"""
from __future__ import annotations

import time

from _mock.providerlab.data import generators as gen
from _mock.providerlab.providers import base
from _mock.providerlab.providers.base import Ctx, DomainError

ID = "junction-procure"


def _iso(epoch: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


@base.seeder(ID)
def seed(state: base.State) -> None:
    for name, table in gen.junction_dataset(ID).items():
        state.tables[name] = table


# --------------------------------------------------------------------------- #
# Lookups
# --------------------------------------------------------------------------- #
def _cost_center(ctx: Ctx, key: str | None = None) -> dict:
    key = key if key is not None else (ctx.get("costCenter") or ctx.get("department"))
    table = ctx.state.table("cost_centers")
    if key is None:
        raise DomainError(422, "invalid_request", "provide a department or costCenter")
    for candidate in (key, str(key).lower()):
        if candidate in table:
            return table[candidate]
    for cc in table.values():
        if cc["costCenter"] == key:
            return cc
    raise DomainError(404, "cost_center_not_found", f"no cost center for {key!r}")


def _requisition(ctx: Ctx, requisition_id: str) -> dict:
    req = ctx.state.table("requisitions").get(requisition_id)
    if req is None:
        raise DomainError(404, "requisition_not_found", requisition_id)
    return req


def _supplier(ctx: Ctx, supplier_id: str) -> dict:
    supplier = ctx.state.table("suppliers").get(supplier_id)
    if supplier is None:
        raise DomainError(404, "supplier_not_found", supplier_id)
    return supplier


def _purchase_order(ctx: Ctx, po_id: str) -> dict:
    po = ctx.state.table("purchase_orders").get(po_id)
    if po is None:
        raise DomainError(404, "purchase_order_not_found", po_id)
    return po


def _recompute_budget(cc: dict) -> None:
    cc["availableAmount"] = round(
        cc["budgetAmount"] - cc["committedAmount"] - cc["spentAmount"], 2)


def _budget_view(cc: dict) -> dict:
    soft = round(cc["budgetAmount"] * cc["softLimitPct"], 2)
    consumed = round(cc["committedAmount"] + cc["spentAmount"], 2)
    return {**cc, "consumedAmount": consumed, "softLimitAmount": soft,
            "softLimitBreached": consumed > soft}


# --------------------------------------------------------------------------- #
# Suppliers and commodity catalog
# --------------------------------------------------------------------------- #
@base.op(ID, "list_suppliers")
def list_suppliers(ctx: Ctx) -> dict:
    """List supplier-master records, filterable by status, category, or free text."""
    ctx.require_scope("procure.read")
    items = list(ctx.state.table("suppliers").values())
    query = str(ctx.get("query", "")).lower()
    if query:
        items = [s for s in items if query in s["displayName"].lower()]
    status = ctx.get("status")
    if status:
        items = [s for s in items if s["status"] == status]
    category = ctx.get("category")
    if category:
        items = [s for s in items if s["category"] == category]
    if ctx.get("preferred") is not None:
        items = [s for s in items if s["preferred"] == bool(ctx.get("preferred"))]
    items.sort(key=lambda s: s["supplierId"])
    return ctx.paginate(items, size_default=20)


@base.op(ID, "get_supplier")
def get_supplier(ctx: Ctx) -> dict:
    """Retrieve a single supplier-master record by id."""
    ctx.require_scope("procure.read")
    ctx.require("supplierId")
    return _supplier(ctx, ctx.payload["supplierId"])


@base.op(ID, "list_commodities")
def list_commodities(ctx: Ctx) -> dict:
    """List the UNSPSC commodity catalog requisition lines are classified against."""
    ctx.require_scope("procure.read")
    items = sorted(ctx.state.table("commodities").values(), key=lambda c: c["commodityCode"])
    return {"items": items, "total": len(items)}


# --------------------------------------------------------------------------- #
# Requisitions
# --------------------------------------------------------------------------- #
def _build_lines(ctx: Ctx, raw_lines: list, currency: str) -> tuple[list[dict], float]:
    lines, subtotal = [], 0.0
    for n, line in enumerate(raw_lines, start=1):
        try:
            quantity = float(line["quantity"])
            unit_price = float(line.get("unitPrice", line.get("rate")))
        except (KeyError, TypeError, ValueError):
            line_total = line.get("lineTotal", line.get("amount"))
            if line_total is None:
                raise DomainError(422, "invalid_line",
                                  "each line needs quantity and unitPrice, or a lineTotal")
            quantity, unit_price = 1.0, float(line_total)
        if quantity <= 0 or unit_price < 0:
            raise DomainError(422, "invalid_line",
                              "quantity must be positive and unitPrice non-negative")
        line_total = round(quantity * unit_price, 2)
        subtotal += line_total
        lines.append({
            "lineNumber": n,
            "description": line.get("description", "Goods or services"),
            "commodityCode": str(line.get("commodityCode", "81111800")),
            "quantity": quantity,
            "unitOfMeasure": line.get("unitOfMeasure", "each"),
            "unitPrice": unit_price,
            "lineTotal": line_total,
            "currency": currency,
            "supplierId": line.get("supplierId"),
            "glAccount": str(line.get("glAccount", "6300")),
            "quantityReceived": 0,
        })
    return lines, round(subtotal, 2)


def _finalize_approval(req: dict, cc: dict) -> None:
    """Mark a requisition approved and place the open commitment against its budget."""
    consumed = cc["committedAmount"] + cc["spentAmount"]
    if consumed + req["total"] > cc["budgetAmount"] * cc["hardLimitPct"]:
        raise DomainError(409, "budget_exceeded",
                          f"approval would exceed the {cc['costCenter']} budget hard limit")
    cc["committedAmount"] = round(cc["committedAmount"] + req["total"], 2)
    _recompute_budget(cc)
    req["status"] = "approved"
    req["approval"]["status"] = "approved"


@base.op(ID, "create_requisition")
def create_requisition(ctx: Ctx) -> dict:
    """Raise a purchase requisition. Routes through the cost-center approval matrix
    by amount; sub-threshold spend is auto-approved and committed immediately."""
    ctx.require_scope("procure.write")
    ctx.require("department", "description")
    cc = _cost_center(ctx)
    currency = ctx.get("currency", "USD")

    raw_lines = ctx.get("lines")
    if isinstance(raw_lines, list) and raw_lines:
        lines, subtotal = _build_lines(ctx, raw_lines, currency)
    else:
        try:
            amount = float(ctx.payload["amount"])
        except (KeyError, TypeError, ValueError):
            raise DomainError(422, "invalid_request", "provide line items or an amount")
        if amount <= 0:
            raise DomainError(422, "invalid_amount", "amount must be positive")
        lines = [{
            "lineNumber": 1, "description": ctx.payload["description"],
            "commodityCode": str(ctx.get("commodityCode", "81111800")),
            "quantity": 1.0, "unitOfMeasure": "each", "unitPrice": amount,
            "lineTotal": amount, "currency": currency,
            "supplierId": ctx.get("supplierId"), "glAccount": str(ctx.get("glAccount", "6300")),
            "quantityReceived": 0,
        }]
        subtotal = amount

    total = subtotal
    steps = gen.junction_required_approval_steps(total)
    chain = gen._junction_approval_chain(cc["manager"], steps)
    now = base.now()
    draft = ctx.get("submit") is False
    requester = ctx.get("requestedBy") or {"id": "EMP-2300", "name": "Lena Novak"}
    if isinstance(requester, str):
        requester = {"id": requester, "name": requester}

    req = {
        "requisitionId": base.new_id("req"),
        "requisitionNumber": f"REQ-2026-{now}",
        "title": ctx.payload["description"],
        "status": "draft" if draft else ("pending_approval" if steps else "approved"),
        "department": cc["department"],
        "costCenter": cc["costCenter"],
        "requestedBy": requester,
        "currency": currency,
        "justification": ctx.get("justification", "Operational purchase."),
        "neededByDate": ctx.get("neededByDate", _iso(now + 30 * 86_400)[:10]),
        "shipTo": ctx.get("shipTo", gen._JUNCTION_SHIP_TO[0]),
        "lines": lines,
        "subtotal": subtotal,
        "estimatedTax": 0.0,
        "total": total,
        "amount": total,
        "approval": {"required": steps > 0,
                     "status": ("not_started" if draft else ("pending" if steps else "not_required")),
                     "policyTier": steps, "chain": chain},
        "purchaseOrderId": None,
        "createdAt": _iso(now),
        "updatedAt": _iso(now),
        "submittedAt": None if draft else _iso(now),
    }
    available_before = cc["availableAmount"]
    if not draft and steps == 0:
        _finalize_approval(req, cc)
    req["budgetCheck"] = {
        "costCenter": cc["costCenter"],
        "availableBefore": available_before,
        "availableAfter": cc["availableAmount"],
        "withinBudget": total <= available_before,
    }
    ctx.state.table("requisitions")[req["requisitionId"]] = req
    return req


@base.op(ID, "submit_requisition")
def submit_requisition(ctx: Ctx) -> dict:
    """Submit a draft requisition into its approval workflow."""
    ctx.require_scope("procure.write")
    ctx.require("requisitionId")
    req = _requisition(ctx, ctx.payload["requisitionId"])
    if req["status"] != "draft":
        raise DomainError(409, "requisition_not_draft",
                          f"requisition is {req['status']} and cannot be submitted")
    cc = _cost_center(ctx, req["department"])
    now = base.now()
    req["submittedAt"] = _iso(now)
    req["updatedAt"] = _iso(now)
    if req["approval"]["policyTier"] == 0:
        _finalize_approval(req, cc)
    else:
        req["status"] = "pending_approval"
        req["approval"]["status"] = "pending"
    return req


@base.op(ID, "approve_requisition")
def approve_requisition(ctx: Ctx) -> dict:
    """Approve the next pending step of a requisition's approval chain. The final
    approval commits the spend against the cost-center budget."""
    ctx.require_scope("procure.write")
    ctx.require("requisitionId")
    req = _requisition(ctx, ctx.payload["requisitionId"])
    if req["status"] == "approved":
        raise DomainError(409, "already_approved", "requisition already approved")
    if req["status"] in ("ordered", "closed"):
        raise DomainError(409, "already_ordered", "requisition already converted to a purchase order")
    if req["status"] == "rejected":
        raise DomainError(409, "requisition_rejected", "requisition was rejected")
    if req["status"] == "draft":
        raise DomainError(409, "requisition_not_submitted", "submit the requisition before approving")

    pending = [s for s in req["approval"]["chain"] if s["status"] == "pending"]
    if not pending:
        raise DomainError(409, "no_pending_approval", "no approval step is pending")
    step = pending[0]
    approver = ctx.get("approverId")
    if approver and approver != step["approverId"]:
        raise DomainError(403, "not_authorized_approver",
                          f"step {step['step']} is assigned to {step['approverId']}")

    cc = _cost_center(ctx, req["department"])
    if len(pending) == 1:
        consumed = cc["committedAmount"] + cc["spentAmount"]
        if consumed + req["total"] > cc["budgetAmount"] * cc["hardLimitPct"]:
            raise DomainError(409, "budget_exceeded",
                              f"approval would exceed the {cc['costCenter']} budget hard limit")

    now = base.now()
    step["status"] = "approved"
    step["decidedAt"] = _iso(now)
    step["comment"] = ctx.get("comment", "Approved.")
    req["updatedAt"] = _iso(now)
    if len(pending) == 1:
        _finalize_approval(req, cc)
    return req


@base.op(ID, "reject_requisition")
def reject_requisition(ctx: Ctx) -> dict:
    """Reject a requisition that is awaiting approval."""
    ctx.require_scope("procure.write")
    ctx.require("requisitionId")
    req = _requisition(ctx, ctx.payload["requisitionId"])
    if req["status"] not in ("pending_approval", "draft"):
        raise DomainError(409, "requisition_not_pending",
                          f"requisition is {req['status']} and cannot be rejected")
    now = base.now()
    pending = [s for s in req["approval"]["chain"] if s["status"] == "pending"]
    if pending:
        pending[0]["status"] = "rejected"
        pending[0]["decidedAt"] = _iso(now)
        pending[0]["comment"] = ctx.get("comment", "Rejected.")
    req["status"] = "rejected"
    req["approval"]["status"] = "rejected"
    req["updatedAt"] = _iso(now)
    return req


@base.op(ID, "list_requisitions")
def list_requisitions(ctx: Ctx) -> dict:
    """List requisitions, filterable by status, department, or cost center."""
    ctx.require_scope("procure.read")
    items = list(ctx.state.table("requisitions").values())
    status = ctx.get("status")
    if status:
        items = [r for r in items if r["status"] == status]
    department = ctx.get("department")
    if department:
        items = [r for r in items if r["department"] == str(department).lower()]
    cost_center = ctx.get("costCenter")
    if cost_center:
        items = [r for r in items if r["costCenter"] == cost_center]
    items.sort(key=lambda r: r["createdAt"], reverse=True)
    return ctx.paginate(items, size_default=20)


@base.op(ID, "get_requisition")
def get_requisition(ctx: Ctx) -> dict:
    """Retrieve a single requisition with its lines and approval chain."""
    ctx.require_scope("procure.read")
    ctx.require("requisitionId")
    return _requisition(ctx, ctx.payload["requisitionId"])


@base.op(ID, "get_approval_chain")
def get_approval_chain(ctx: Ctx) -> dict:
    """Inspect the approval chain and current decision status for a requisition."""
    ctx.require_scope("procure.read")
    ctx.require("requisitionId")
    req = _requisition(ctx, ctx.payload["requisitionId"])
    return {
        "requisitionId": req["requisitionId"],
        "requisitionNumber": req["requisitionNumber"],
        "status": req["approval"]["status"],
        "policyTier": req["approval"]["policyTier"],
        "chain": req["approval"]["chain"],
    }


# --------------------------------------------------------------------------- #
# Purchase orders and goods receipts
# --------------------------------------------------------------------------- #
@base.op(ID, "create_purchase_order")
def create_purchase_order(ctx: Ctx) -> dict:
    """Convert an approved requisition into a purchase order issued to a supplier."""
    ctx.require_scope("procure.write")
    ctx.require("requisitionId")
    req = _requisition(ctx, ctx.payload["requisitionId"])
    if req["status"] == "approved":
        pass
    elif req["status"] in ("ordered", "closed"):
        raise DomainError(409, "already_ordered", "requisition already has a purchase order")
    else:
        raise DomainError(409, "requisition_not_approved", "requisition must be approved first")

    supplier_id = ctx.get("supplierId") or ctx.get("vendorId")
    if not supplier_id:
        raise DomainError(422, "invalid_request", "missing required field(s): supplierId")
    supplier = _supplier(ctx, supplier_id)
    if supplier["status"] != "active":
        raise DomainError(409, "supplier_inactive",
                          f"supplier {supplier['supplierId']} is {supplier['status']}")

    now = base.now()
    lines = [{
        "lineNumber": l["lineNumber"],
        "description": l["description"],
        "commodityCode": l["commodityCode"],
        "quantity": l["quantity"],
        "quantityReceived": 0,
        "unitOfMeasure": l["unitOfMeasure"],
        "unitPrice": l["unitPrice"],
        "lineTotal": l["lineTotal"],
        "glAccount": l["glAccount"],
    } for l in req["lines"]]
    po = {
        "poId": base.new_id("po"),
        "poNumber": f"PO-2026-{now}",
        "requisitionId": req["requisitionId"],
        "supplierId": supplier["supplierId"],
        "supplierName": supplier["displayName"],
        "status": "issued",
        "costCenter": req["costCenter"],
        "department": req["department"],
        "currency": req["currency"],
        "buyer": ctx.get("buyer", {"id": "EMP-2300", "name": "Lena Novak"}),
        "paymentTerms": supplier["paymentTerms"],
        "shipTo": req["shipTo"],
        "lines": lines,
        "subtotal": req["subtotal"],
        "tax": req["estimatedTax"],
        "total": req["total"],
        "amount": req["total"],
        "issuedAt": _iso(now),
        "acknowledgedAt": None,
        "expectedDeliveryDate": req["neededByDate"],
        "receipts": [],
    }
    ctx.state.table("purchase_orders")[po["poId"]] = po
    req["status"] = "ordered"
    req["purchaseOrderId"] = po["poId"]
    req["updatedAt"] = _iso(now)
    return po


@base.op(ID, "acknowledge_order")
def acknowledge_order(ctx: Ctx) -> dict:
    """Record a supplier's acknowledgement of an issued purchase order."""
    ctx.require_scope("procure.write")
    ctx.require("poId")
    po = _purchase_order(ctx, ctx.payload["poId"])
    if po["status"] != "issued":
        raise DomainError(409, "po_not_issued", f"purchase order is {po['status']}")
    po["status"] = "acknowledged"
    po["acknowledgedAt"] = _iso(base.now())
    return po


@base.op(ID, "receive_order")
def receive_order(ctx: Ctx) -> dict:
    """Record a goods receipt against a purchase order. A fully received order
    closes the requisition and moves its budget commitment into actual spend."""
    ctx.require_scope("procure.write")
    ctx.require("poId")
    po = _purchase_order(ctx, ctx.payload["poId"])
    if po["status"] in ("received", "closed", "cancelled"):
        raise DomainError(409, "po_not_receivable", f"purchase order is {po['status']}")

    by_number = {l["lineNumber"]: l for l in po["lines"]}
    raw = ctx.get("lines")
    receipt_lines = []
    if isinstance(raw, list) and raw:
        for entry in raw:
            line = by_number.get(int(entry.get("lineNumber", 0)))
            if line is None:
                raise DomainError(422, "invalid_line", f"line {entry.get('lineNumber')} not on this order")
            qty = float(entry.get("quantityReceived", line["quantity"] - line["quantityReceived"]))
            remaining = line["quantity"] - line["quantityReceived"]
            if qty <= 0 or qty > remaining:
                raise DomainError(422, "invalid_quantity",
                                  f"line {line['lineNumber']} can receive up to {remaining}")
            line["quantityReceived"] = round(line["quantityReceived"] + qty, 4)
            receipt_lines.append({"lineNumber": line["lineNumber"], "quantityReceived": qty})
    else:
        for line in po["lines"]:
            remaining = line["quantity"] - line["quantityReceived"]
            if remaining > 0:
                line["quantityReceived"] = line["quantity"]
                receipt_lines.append({"lineNumber": line["lineNumber"], "quantityReceived": remaining})

    now = base.now()
    receipt = {
        "receiptId": base.new_id("grn"),
        "receiptNumber": f"GRN-2026-{now}",
        "poId": po["poId"],
        "receivedBy": ctx.get("receivedBy", {"id": "EMP-2400", "name": "Hassan Haddad"}),
        "receivedAt": _iso(now),
        "lines": receipt_lines,
        "status": "received",
    }
    ctx.state.table("receipts")[receipt["receiptId"]] = receipt
    po["receipts"].append(receipt)

    fully = all(l["quantityReceived"] >= l["quantity"] for l in po["lines"])
    po["status"] = "received" if fully else "partially_received"
    if fully:
        req = ctx.state.table("requisitions").get(po["requisitionId"])
        if req is not None and req["status"] == "ordered":
            cc = _cost_center(ctx, req["department"])
            cc["committedAmount"] = round(max(0.0, cc["committedAmount"] - req["total"]), 2)
            cc["spentAmount"] = round(cc["spentAmount"] + req["total"], 2)
            _recompute_budget(cc)
            req["status"] = "closed"
            req["updatedAt"] = _iso(now)
    return {"receipt": receipt, "purchaseOrder": po}


@base.op(ID, "list_purchase_orders")
def list_purchase_orders(ctx: Ctx) -> dict:
    """List purchase orders, filterable by status, supplier, or cost center."""
    ctx.require_scope("procure.read")
    items = list(ctx.state.table("purchase_orders").values())
    status = ctx.get("status")
    if status:
        items = [p for p in items if p["status"] == status]
    supplier_id = ctx.get("supplierId")
    if supplier_id:
        items = [p for p in items if p["supplierId"] == supplier_id]
    cost_center = ctx.get("costCenter")
    if cost_center:
        items = [p for p in items if p["costCenter"] == cost_center]
    items.sort(key=lambda p: p["issuedAt"], reverse=True)
    return ctx.paginate(items, size_default=20)


@base.op(ID, "get_purchase_order")
def get_purchase_order(ctx: Ctx) -> dict:
    """Retrieve a single purchase order with its lines and goods receipts."""
    ctx.require_scope("procure.read")
    ctx.require("poId")
    return _purchase_order(ctx, ctx.payload["poId"])


# --------------------------------------------------------------------------- #
# Budgets
# --------------------------------------------------------------------------- #
@base.op(ID, "list_budgets")
def list_budgets(ctx: Ctx) -> dict:
    """List every cost-center budget with commitment, spend, and availability."""
    ctx.require_scope("procure.read")
    items = [_budget_view(cc) for cc in ctx.state.table("cost_centers").values()]
    items.sort(key=lambda c: c["costCenter"])
    return {"items": items, "total": len(items)}


@base.op(ID, "get_budget")
def get_budget(ctx: Ctx) -> dict:
    """Read a single cost-center budget by department or cost-center code."""
    ctx.require_scope("procure.read")
    if ctx.get("department") is None and ctx.get("costCenter") is None:
        raise DomainError(422, "invalid_request", "provide a department or costCenter")
    return _budget_view(_cost_center(ctx))
