"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for the market stream consumer's governed routing and fail-closed gating.
"""

from __future__ import annotations
from unittest import mock

from app.services import streams


def _drain_threads():
    streams.stop_streams()
    assert streams.get_active_stream_count() == 0


def test_streams_fail_closed_without_caracal_or_simulation(monkeypatch):
    monkeypatch.delenv("LYNX_SIMULATION", raising=False)
    monkeypatch.setenv("LYNX_PARTNER_PULSE_MARKET_URL", "http://pulse.test")
    monkeypatch.setenv("LYNX_PARTNER_PULSE_MARKET_API_KEY", "pk-test")
    with (
        mock.patch.object(streams.caracal, "enabled", return_value=False),
        mock.patch.object(streams, "_consume_direct") as consume_direct,
        mock.patch.object(streams, "_consume_governed") as consume_governed,
    ):
        streams.start_streams()
    assert streams.get_active_stream_count() == 0
    consume_direct.assert_not_called()
    consume_governed.assert_not_called()


def test_streams_use_direct_path_only_in_simulation(monkeypatch):
    monkeypatch.setenv("LYNX_SIMULATION", "1")
    monkeypatch.setenv("LYNX_PARTNER_PULSE_MARKET_URL", "http://pulse.test")
    monkeypatch.setenv("LYNX_PARTNER_PULSE_MARKET_API_KEY", "pk-test")
    monkeypatch.delenv("LYNX_PULSE_SYMBOL", raising=False)
    seen: list[tuple] = []
    with (
        mock.patch.object(streams.caracal, "enabled", return_value=False),
        mock.patch.object(
            streams, "_consume_direct", side_effect=lambda *a: seen.append(a)
        ),
    ):
        streams.start_streams()
        _drain_threads()
    assert seen == [("http://pulse.test", "pk-test", "USD/EUR")]


def test_streams_route_through_gateway_when_caracal_enabled(monkeypatch):
    monkeypatch.setenv("LYNX_SIMULATION", "1")
    seen: list[tuple] = []
    with (
        mock.patch.object(streams.caracal, "enabled", return_value=True),
        mock.patch.object(
            streams, "_consume_governed", side_effect=lambda *a: seen.append(a)
        ),
    ):
        streams.start_streams()
        _drain_threads()
    assert seen == [("USD/EUR",)]


def test_streams_route_through_gateway_uses_custom_symbol(monkeypatch):
    monkeypatch.setenv("LYNX_SIMULATION", "1")
    monkeypatch.setenv("LYNX_PULSE_SYMBOL", "GBP/JPY")
    seen: list[tuple] = []
    with (
        mock.patch.object(streams.caracal, "enabled", return_value=True),
        mock.patch.object(
            streams, "_consume_governed", side_effect=lambda *a: seen.append(a)
        ),
    ):
        streams.start_streams()
        _drain_threads()
    assert seen == [("GBP/JPY",)]


def test_sse_parser_publishes_only_tick_data():
    published: list[dict] = []
    with mock.patch.object(streams, "_publish_tick", side_effect=published.append):
        event = "message"
        for line in (
            "event: subscribed",
            'data: {"symbol": "USD/EUR"}',
            "",
            "event: tick",
            'data: {"rate": 1.07}',
            "",
            "event: heartbeat",
            'data: {"seq": 5}',
        ):
            event = streams._handle_line(line, event)
    assert published == [{"rate": 1.07}]
