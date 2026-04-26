"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for Prometheus HTTP metrics server.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from caracal.monitoring.http_server import (
    PrometheusMetricsServer,
    get_metrics_server,
    start_metrics_server,
    stop_metrics_server,
)
import caracal.monitoring.http_server as http_server_module


@pytest.mark.unit
class TestPrometheusMetricsServerInit:
    def test_default_values(self) -> None:
        server = PrometheusMetricsServer()
        assert server.host == "0.0.0.0"
        assert server.port == 9090
        assert server.metrics_registry is None
        assert server.is_running() is False

    def test_custom_host_and_port(self) -> None:
        server = PrometheusMetricsServer(host="127.0.0.1", port=8888)
        assert server.host == "127.0.0.1"
        assert server.port == 8888

    def test_get_url(self) -> None:
        server = PrometheusMetricsServer(host="127.0.0.1", port=9191)
        assert server.get_url() == "http://127.0.0.1:9191/metrics"

    def test_is_not_running_after_init(self) -> None:
        server = PrometheusMetricsServer()
        assert not server.is_running()

    def test_stop_when_not_running_is_noop(self) -> None:
        server = PrometheusMetricsServer()
        server.stop()  # must not raise


@pytest.mark.unit
class TestPrometheusMetricsServerStartStop:
    def test_start_sets_running(self) -> None:
        mock_registry = MagicMock()
        server = PrometheusMetricsServer(host="127.0.0.1", port=0, metrics_registry=mock_registry)
        with patch("caracal.monitoring.http_server.HTTPServer") as MockHTTP:
            mock_http = MagicMock()
            MockHTTP.return_value = mock_http
            server.start()
            assert server.is_running() is True
            server.stop()

    def test_double_start_is_noop(self) -> None:
        server = PrometheusMetricsServer(host="127.0.0.1", port=0)
        with patch("caracal.monitoring.http_server.HTTPServer") as MockHTTP:
            mock_http = MagicMock()
            MockHTTP.return_value = mock_http
            server.start()
            server.start()  # second call should be noop
            assert server.is_running() is True
            server.stop()

    def test_stop_clears_running(self) -> None:
        server = PrometheusMetricsServer(host="127.0.0.1", port=0)
        with patch("caracal.monitoring.http_server.HTTPServer") as MockHTTP:
            mock_http = MagicMock()
            MockHTTP.return_value = mock_http
            server.start()
            server.stop()
            assert not server.is_running()


@pytest.mark.unit
class TestGlobalMetricsServerFunctions:
    def setup_method(self) -> None:
        http_server_module._metrics_server = None

    def teardown_method(self) -> None:
        http_server_module._metrics_server = None

    def test_get_metrics_server_raises_when_not_initialized(self) -> None:
        with pytest.raises(RuntimeError, match="not initialized"):
            get_metrics_server()

    def test_stop_metrics_server_when_none_is_noop(self) -> None:
        stop_metrics_server()  # must not raise

    def test_start_creates_server(self) -> None:
        with patch("caracal.monitoring.http_server.HTTPServer") as MockHTTP:
            mock_http = MagicMock()
            MockHTTP.return_value = mock_http
            srv = start_metrics_server(host="127.0.0.1", port=0)
            assert srv.is_running()
            stop_metrics_server()

    def test_get_metrics_server_after_start(self) -> None:
        with patch("caracal.monitoring.http_server.HTTPServer") as MockHTTP:
            mock_http = MagicMock()
            MockHTTP.return_value = mock_http
            start_metrics_server(host="127.0.0.1", port=0)
            srv = get_metrics_server()
            assert srv is not None
            stop_metrics_server()

    def test_start_already_running_returns_existing(self) -> None:
        with patch("caracal.monitoring.http_server.HTTPServer") as MockHTTP:
            mock_http = MagicMock()
            MockHTTP.return_value = mock_http
            srv1 = start_metrics_server(host="127.0.0.1", port=0)
            srv2 = start_metrics_server(host="127.0.0.1", port=1)
            assert srv1 is srv2
            stop_metrics_server()
