"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Vela Notify domain: transactional email and SMS notifications with templates, delivery tracking, suppression lists, and webhooks.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

from _mock.providerlab.data import generators as gen
from _mock.providerlab.providers import base
from _mock.providerlab.providers.base import Ctx, DomainError

ID = "vela-notify"

_CHANNELS = ("email", "sms")
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_PHONE_RE = re.compile(r"^\+?[0-9][0-9 \-]{5,}$")
_VALID_EVENTS = ("Delivery", "Bounce", "SpamComplaint", "Open", "Click",
                 "sent", "delivered", "undelivered", "failed")
_SMS_UNDELIVERED = (30003, "Unreachable destination handset")


@base.seeder(ID)
def seed(state: base.State) -> None:
    for name, table in gen.vela_dataset(ID).items():
        state.tables[name] = table


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _iso(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _suppression_key(channel: str, recipient: str) -> str:
    return f"{channel}:{recipient.lower()}"


def _valid_recipient(channel: str, recipient: str) -> bool:
    if channel == "email":
        return bool(_EMAIL_RE.match(recipient))
    return bool(_PHONE_RE.match(recipient))


def _route(channel: str, recipient: str) -> str:
    """Resolve the terminal outcome a send will reach, keyed off magic recipient
    markers the way Postmark and Twilio expose deterministic test destinations."""
    target = recipient.lower()
    if channel == "email":
        if "bounce" in target:
            return "bounced"
        if "complaint" in target or "spam" in target:
            return "spam"
        return "delivered"
    digits = re.sub(r"\D", "", recipient)
    if digits.endswith(("0009", "0003")):
        return "undelivered"
    return "delivered"


def _events_for(ctx: Ctx, message_id: str) -> list[dict]:
    events = [e for e in ctx.state.table("events").values() if e["messageId"] == message_id]
    events.sort(key=lambda e: e["occurredAt"])
    return events


def _record_event(ctx: Ctx, message: dict, etype: str, detail: dict | None = None) -> dict:
    event = {
        "eventId": base.new_id("evt"),
        "messageId": message["messageId"],
        "type": etype,
        "channel": message["channel"],
        "recipient": message["to"],
        "occurredAt": _iso(base.now()),
        "detail": detail or {},
    }
    ctx.state.table("events")[event["eventId"]] = event
    return event


def _suppress(ctx: Ctx, message: dict, reason: str) -> None:
    key = _suppression_key(message["channel"], message["to"])
    ctx.state.table("suppressions").setdefault(key, {
        "recipient": message["to"],
        "channel": message["channel"],
        "reason": reason,
        "origin": "Recipient",
        "createdAt": _iso(base.now()),
    })


def _advance(ctx: Ctx, message: dict) -> None:
    """Move an in-flight message one step along its delivery lifecycle, emitting the
    delivery-tracking events a real ESP/carrier callback would produce."""
    status = message["status"]
    if status not in ("queued", "sent", "sending"):
        return
    channel = message["channel"]
    outcome = _route(channel, message["to"])
    if channel == "email":
        if status == "queued":
            message["status"] = "sent"
            _record_event(ctx, message, "Sent")
        elif status == "sent":
            if outcome == "bounced":
                detail = dict(gen._VELA_BOUNCE_DETAIL)
                message["status"] = "bounced"
                message["bounce"] = detail
                message["errorCode"] = detail["code"]
                message["error"] = detail["description"]
                _record_event(ctx, message, "Bounce", detail)
                _suppress(ctx, message, "HardBounce")
            elif outcome == "spam":
                message["status"] = "delivered"
                _record_event(ctx, message, "Delivery")
                _record_event(ctx, message, "SpamComplaint", {"origin": "Recipient"})
                _suppress(ctx, message, "SpamComplaint")
            else:
                message["status"] = "delivered"
                _record_event(ctx, message, "Delivery")
    else:
        if status == "queued":
            message["status"] = "sending"
            _record_event(ctx, message, "sending")
        elif status == "sending":
            if outcome == "undelivered":
                code, reason = _SMS_UNDELIVERED
                message["status"] = "undelivered"
                message["errorCode"] = code
                message["error"] = reason
                _record_event(ctx, message, "undelivered", {"errorCode": code, "reason": reason})
            else:
                message["status"] = "delivered"
                _record_event(ctx, message, "sent")
                _record_event(ctx, message, "delivered")
    message["updatedAt"] = _iso(base.now())


def _with_events(ctx: Ctx, message: dict) -> dict:
    return {**message, "events": _events_for(ctx, message["messageId"])}


def _render(template: dict, variables: dict, channel: str) -> dict:
    missing = [v for v in template["variables"] if v not in variables]
    if missing:
        raise DomainError(422, "missing_variables",
                          f"template requires variable(s): {', '.join(missing)}")

    def fill(text: str | None) -> str | None:
        if text is None:
            return None
        for key, value in variables.items():
            text = text.replace("{{" + key + "}}", str(value))
        return text

    if channel == "sms":
        return {"channel": "sms", "body": fill(template["smsBody"])}
    return {"channel": "email", "subject": fill(template["subject"]),
            "textBody": fill(template["textBody"]), "htmlBody": fill(template["htmlBody"])}


def _build_message(ctx: Ctx, channel: str, recipient: str, template: dict) -> dict:
    message_id = base.new_id("msg")
    sender = ctx.get("from") or (gen._VELA_SMS_SENDER if channel == "sms"
                                 else f"no-reply@{gen._VELA_EMAIL_DOMAIN}")
    return {
        "messageId": message_id,
        "providerMessageId": base.new_id("carrier" if channel == "sms" else "esp"),
        "channel": channel,
        "messageStream": ctx.get("messageStream") or template["messageStream"],
        "to": recipient,
        "toName": ctx.get("toName"),
        "from": sender,
        "templateAlias": template["alias"],
        "subject": template["subject"] if channel == "email" else None,
        "tag": ctx.get("tag") or template["category"],
        "status": "queued",
        "metadata": ctx.get("metadata", {}),
        "errorCode": 0,
        "error": None,
        "bounce": None,
        "submittedAt": _iso(base.now()),
        "updatedAt": None,
    }


# --------------------------------------------------------------------------- #
# messaging
# --------------------------------------------------------------------------- #
@base.op(ID, "send_message")
def send_message(ctx: Ctx) -> dict:
    """Submit a single transactional email or SMS rendered from a template."""
    ctx.require("channel", "to", "template")
    channel = ctx.payload["channel"]
    if channel not in _CHANNELS:
        raise DomainError(422, "invalid_channel", "channel must be email or sms")
    template = ctx.state.table("templates").get(ctx.payload["template"])
    if template is None:
        raise DomainError(404, "template_not_found", ctx.payload["template"])
    if channel not in template["channels"]:
        raise DomainError(422, "channel_unsupported", "template does not support this channel")
    recipient = str(ctx.payload["to"])
    if not _valid_recipient(channel, recipient):
        raise DomainError(422, "invalid_recipient", f"{recipient!r} is not a valid {channel} recipient")
    if _suppression_key(channel, recipient) in ctx.state.table("suppressions"):
        raise DomainError(406, "inactive_recipient",
                          "recipient is on the suppression list and cannot be messaged")
    message = _build_message(ctx, channel, recipient, template)
    ctx.state.table("messages")[message["messageId"]] = message
    return message


@base.op(ID, "send_batch")
def send_batch(ctx: Ctx) -> dict:
    """Submit a batch of messages in one call, returning a per-item result the way
    Postmark's batch endpoint reports an ErrorCode for each recipient."""
    items = ctx.get("messages")
    if not isinstance(items, list) or not items:
        raise DomainError(422, "invalid_request", "messages must be a non-empty array")
    templates = ctx.state.table("templates")
    suppressions = ctx.state.table("suppressions")
    results: list[dict] = []
    for item in items:
        channel = item.get("channel")
        recipient = str(item.get("to", ""))
        template = templates.get(item.get("template"))
        if channel not in _CHANNELS:
            results.append({"to": recipient, "errorCode": 422, "message": "invalid_channel"})
            continue
        if template is None:
            results.append({"to": recipient, "errorCode": 404, "message": "template_not_found"})
            continue
        if channel not in template["channels"]:
            results.append({"to": recipient, "errorCode": 422, "message": "channel_unsupported"})
            continue
        if not _valid_recipient(channel, recipient):
            results.append({"to": recipient, "errorCode": 422, "message": "invalid_recipient"})
            continue
        if _suppression_key(channel, recipient) in suppressions:
            results.append({"to": recipient, "errorCode": 406, "message": "inactive_recipient"})
            continue
        sub = Ctx(ctx.provider, ctx.state, ctx.op, item, ctx.principal)
        message = _build_message(sub, channel, recipient, template)
        ctx.state.table("messages")[message["messageId"]] = message
        results.append({"to": recipient, "errorCode": 0, "messageId": message["messageId"],
                        "status": message["status"]})
    accepted = sum(1 for r in results if r["errorCode"] == 0)
    return {"submitted": len(results), "accepted": accepted,
            "rejected": len(results) - accepted, "results": results}


@base.op(ID, "get_message")
def get_message(ctx: Ctx) -> dict:
    """Fetch a message and advance its delivery lifecycle one step."""
    ctx.require("messageId")
    message = ctx.state.table("messages").get(ctx.payload["messageId"])
    if message is None:
        raise DomainError(404, "message_not_found", ctx.payload["messageId"])
    _advance(ctx, message)
    return _with_events(ctx, message)


@base.op(ID, "list_messages")
def list_messages(ctx: Ctx) -> dict:
    """List submitted messages, filterable by status, channel, tag, stream, or recipient."""
    items = list(ctx.state.table("messages").values())
    for field, key in (("status", "status"), ("channel", "channel"),
                       ("tag", "tag"), ("messageStream", "messageStream")):
        value = ctx.get(field)
        if value:
            items = [m for m in items if m[key] == value]
    recipient = ctx.get("to")
    if recipient:
        items = [m for m in items if m["to"] == recipient]
    items.sort(key=lambda m: m["submittedAt"], reverse=True)
    return ctx.paginate(items)


@base.op(ID, "get_message_events")
def get_message_events(ctx: Ctx) -> dict:
    """Return the delivery-tracking timeline for a message (sent, delivery, bounce,
    open, click, complaint), advancing the lifecycle one step on read."""
    ctx.require("messageId")
    message = ctx.state.table("messages").get(ctx.payload["messageId"])
    if message is None:
        raise DomainError(404, "message_not_found", ctx.payload["messageId"])
    _advance(ctx, message)
    return {"messageId": message["messageId"], "channel": message["channel"],
            "status": message["status"], "events": _events_for(ctx, message["messageId"])}


# --------------------------------------------------------------------------- #
# templates
# --------------------------------------------------------------------------- #
@base.op(ID, "list_templates")
def list_templates(ctx: Ctx) -> dict:
    """List the reusable email and SMS templates."""
    return {"items": list(ctx.state.table("templates").values())}


@base.op(ID, "get_template")
def get_template(ctx: Ctx) -> dict:
    """Fetch one template by its alias."""
    ctx.require("template")
    template = ctx.state.table("templates").get(ctx.payload["template"])
    if template is None:
        raise DomainError(404, "template_not_found", ctx.payload["template"])
    return template


@base.op(ID, "create_template")
def create_template(ctx: Ctx) -> dict:
    """Register a new template keyed by a unique alias."""
    ctx.require("alias", "name", "channels")
    alias = str(ctx.payload["alias"])
    templates = ctx.state.table("templates")
    if alias in templates:
        raise DomainError(409, "template_exists", f"template {alias!r} already exists")
    channels = ctx.payload["channels"]
    if not isinstance(channels, list) or not set(channels).issubset(_CHANNELS):
        raise DomainError(422, "invalid_channels", "channels must be a subset of [email, sms]")
    now = _iso(base.now())
    template = {
        "templateId": base.new_id("tmpl"),
        "alias": alias,
        "name": ctx.payload["name"],
        "channels": list(channels),
        "messageStream": ctx.get("messageStream", "outbound-transactional"),
        "category": ctx.get("category", "transactional"),
        "subject": ctx.get("subject"),
        "htmlBody": ctx.get("htmlBody"),
        "textBody": ctx.get("textBody"),
        "smsBody": ctx.get("smsBody"),
        "variables": list(ctx.get("variables", [])),
        "active": True,
        "version": 1,
        "createdAt": now,
        "updatedAt": now,
    }
    templates[alias] = template
    return template


@base.op(ID, "render_template")
def render_template(ctx: Ctx) -> dict:
    """Render a template with merge variables to preview the outgoing content,
    rejecting the request when a required variable is missing."""
    ctx.require("template")
    template = ctx.state.table("templates").get(ctx.payload["template"])
    if template is None:
        raise DomainError(404, "template_not_found", ctx.payload["template"])
    channel = ctx.get("channel") or template["channels"][0]
    if channel not in template["channels"]:
        raise DomainError(422, "channel_unsupported", "template does not support this channel")
    variables = ctx.get("variables") or ctx.get("model") or {}
    if not isinstance(variables, dict):
        raise DomainError(422, "invalid_request", "variables must be an object")
    rendered = _render(template, variables, channel)
    return {"template": template["alias"], "rendered": rendered}


# --------------------------------------------------------------------------- #
# suppressions
# --------------------------------------------------------------------------- #
@base.op(ID, "list_suppressions")
def list_suppressions(ctx: Ctx) -> dict:
    """List suppressed recipients, filterable by channel or reason."""
    items = list(ctx.state.table("suppressions").values())
    channel = ctx.get("channel")
    if channel:
        items = [s for s in items if s["channel"] == channel]
    reason = ctx.get("reason")
    if reason:
        items = [s for s in items if s["reason"] == reason]
    items.sort(key=lambda s: s["createdAt"], reverse=True)
    return {"items": items}


@base.op(ID, "create_suppression")
def create_suppression(ctx: Ctx) -> dict:
    """Add a recipient to the suppression list so future sends are blocked."""
    ctx.require("recipient", "channel")
    channel = ctx.payload["channel"]
    if channel not in _CHANNELS:
        raise DomainError(422, "invalid_channel", "channel must be email or sms")
    recipient = str(ctx.payload["recipient"])
    record = {
        "recipient": recipient,
        "channel": channel,
        "reason": ctx.get("reason", "ManualSuppression"),
        "origin": ctx.get("origin", "Customer"),
        "createdAt": _iso(base.now()),
    }
    ctx.state.table("suppressions")[_suppression_key(channel, recipient)] = record
    return record


@base.op(ID, "delete_suppression")
def delete_suppression(ctx: Ctx) -> dict:
    """Remove a recipient from the suppression list, reactivating delivery to them."""
    ctx.require("recipient", "channel")
    key = _suppression_key(ctx.payload["channel"], str(ctx.payload["recipient"]))
    removed = ctx.state.table("suppressions").pop(key, None)
    if removed is None:
        raise DomainError(404, "suppression_not_found", ctx.payload["recipient"])
    return {"recipient": removed["recipient"], "channel": removed["channel"], "reactivated": True}


# --------------------------------------------------------------------------- #
# webhooks
# --------------------------------------------------------------------------- #
@base.op(ID, "list_webhooks")
def list_webhooks(ctx: Ctx) -> dict:
    """List registered webhook endpoints that receive delivery callbacks."""
    return {"items": list(ctx.state.table("webhooks").values())}


@base.op(ID, "get_webhook")
def get_webhook(ctx: Ctx) -> dict:
    """Fetch one webhook endpoint, including its recent delivery attempts."""
    ctx.require("webhookId")
    webhook = ctx.state.table("webhooks").get(ctx.payload["webhookId"])
    if webhook is None:
        raise DomainError(404, "webhook_not_found", ctx.payload["webhookId"])
    return webhook


@base.op(ID, "create_webhook")
def create_webhook(ctx: Ctx) -> dict:
    """Register a webhook endpoint subscribed to a set of delivery events."""
    ctx.require("url", "events")
    events = ctx.payload["events"]
    if not isinstance(events, list) or not set(events).issubset(_VALID_EVENTS):
        raise DomainError(422, "invalid_events",
                          f"events must be a subset of {list(_VALID_EVENTS)}")
    import secrets
    webhook = {
        "webhookId": base.new_id("hook"),
        "url": ctx.payload["url"],
        "messageStream": ctx.get("messageStream", "outbound-transactional"),
        "events": list(events),
        "enabled": bool(ctx.get("enabled", True)),
        "secret": f"whsec_{secrets.token_hex(16)}",
        "createdAt": _iso(base.now()),
        "deliveries": [],
    }
    ctx.state.table("webhooks")[webhook["webhookId"]] = webhook
    return webhook


# --------------------------------------------------------------------------- #
# analytics
# --------------------------------------------------------------------------- #
@base.op(ID, "get_delivery_stats")
def get_delivery_stats(ctx: Ctx) -> dict:
    """Aggregate outbound counts by channel and status for delivery reporting."""
    channel = ctx.get("channel")
    counts: dict[str, dict[str, int]] = {}
    totals = {"sent": 0, "delivered": 0, "bounced": 0, "undelivered": 0,
              "queued": 0, "opened": 0}
    events = list(ctx.state.table("events").values())
    opens = sum(1 for e in events if e["type"] == "Open"
                and (channel is None or e["channel"] == channel))
    for message in ctx.state.table("messages").values():
        if channel and message["channel"] != channel:
            continue
        bucket = counts.setdefault(message["channel"], {})
        bucket[message["status"]] = bucket.get(message["status"], 0) + 1
        if message["status"] in totals:
            totals[message["status"]] += 1
    totals["opened"] = opens
    return {"byChannel": counts, "totals": totals}
