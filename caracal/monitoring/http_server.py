"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

HTTP server for Prometheus metrics endpoint.

Provides HTTP endpoint for Prometheus to scrape metrics from Caracal Core.

Requirements: 16.7
"""

import asyncio
from http.server import HTTPServer, BaseHTTPRequestHandler
from threading import Thread
from typing import Optional

from caracal.monitoring.metrics import MetricsRegistry, get_metrics_registry
from caracal.logging_config import get_logger

logger = get_logger(__name__)


class MetricsHandler(BaseHTTPRequestHandler):
    """
    HTTP request handler for Prometheus metrics endpoint.
    
    Serves metrics at /metrics endpoint in Prometheus text format.
    """
    
    def __init__(self, *args, metrics_registry: Optional[MetricsRegistry] = None, **kwargs):
        """
        Initialize metrics handler.
        
        Args:
            metrics_registry: MetricsRegistry instance (uses global if not provided)
        """
        self.metrics_registry = metrics_registry
        super().__init__(*args, **kwargs)
    
    def do_GET(self):
        """Handle GET requests."""
        if self.path == '/metrics':
            self._serve_metrics()
        elif self.path == '/health':
            self._serve_health()
        else:
            self.send_error(404, "Not Found")
    
    def _serve_metrics(self):
        """Serve Prometheus metrics."""
        try:
            # Get metrics registry
            if self.metrics_registry is None:
                self.metrics_registry = get_metrics_registry()
            
            # Generate metrics
            metrics_data = self.metrics_registry.generate_metrics()
            content_type = self.metrics_registry.get_content_type()
            
            # Send response
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(metrics_data)))
            self.end_headers()
            self.wfile.write(metrics_data)
            
            logger.debug("Served Prometheus metrics")
        
        except Exception as e:
            logger.error(f"Failed to serve metrics: {e}", exc_info=True)
            self.send_error(500, f"Internal Server Error: {e}")
    
    def _serve_health(self):
        """Serve health check endpoint."""
        try:
            health_data = b'{"status": "healthy"}\n'
            
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(health_data)))
            self.end_headers()
            self.wfile.write(health_data)
            
            logger.debug("Served health check")
        
        except Exception as e:
            logger.error(f"Failed to serve health check: {e}", exc_info=True)
            self.send_error(500, f"Internal Server Error: {e}")
    
    def log_message(self, format, *args):
        """Override to use our logger instead of stderr."""
        logger.debug(f"HTTP {format % args}")


class PrometheusMetricsServer:
    """
    HTTP server for Prometheus metrics endpoint.
    
    Runs in a separate thread to avoid blocking the main application.
    Exposes metrics at http://host:port/metrics for Prometheus scraping.
    
    Requirements: 16.7
    """
    
    def __init__(
        self,
        host: str = "0.0.0.0",
        port: int = 9090,
        metrics_registry: Optional[MetricsRegistry] = None
    ):
        """
        Initialize Prometheus metrics server.
        
        Args:
            host: Host to bind to (default: 0.0.0.0)
            port: Port to bind to (default: 9090)
            metrics_registry: MetricsRegistry instance (uses global if not provided)
        """
        self.host = host
        self.port = port
        self.metrics_registry = metrics_registry
        
        self._server = None
        self._thread = None
        self._running = False
        
        logger.info(f"PrometheusMetricsServer initialized: host={host}, port={port}")
    
    def start(self):
        """
        Start HTTP server in background thread.
        
        The server will listen on the configured host and port and serve
        Prometheus metrics at /metrics endpoint.
        """
        if self._running:
            logger.warning("Metrics server already running")
            return
        
        # Create handler factory with metrics registry
        def handler_factory(*args, **kwargs):
            return MetricsHandler(
                *args,
                metrics_registry=self.metrics_registry,
                **kwargs
            )
        
        # Create HTTP server
        self._server = HTTPServer((self.host, self.port), handler_factory)
        
        # Start server in background thread
        self._thread = Thread(target=self._run_server, daemon=True)
        self._thread.start()
        
        self._running = True
        
        logger.info(
            f"Prometheus metrics server started: "
            f"http://{self.host}:{self.port}/metrics"
        )
    
    def _run_server(self):
        """Run HTTP server (called in background thread)."""
        try:
            logger.info("Metrics server thread started")
            self._server.serve_forever()
        except Exception as e:
            logger.error(f"Metrics server error: {e}", exc_info=True)
        finally:
            logger.info("Metrics server thread stopped")
    
    def stop(self):
        """Stop HTTP server."""
        if not self._running:
            return
        
        logger.info("Stopping Prometheus metrics server")
        
        if self._server:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        
        if self._thread:
            self._thread.join(timeout=5.0)
            self._thread = None
        
        self._running = False
        
        logger.info("Prometheus metrics server stopped")
    
    def is_running(self) -> bool:
        """Check if server is running."""
        return self._running
    
    def get_url(self) -> str:
        """Get metrics endpoint URL."""
        return f"http://{self.host}:{self.port}/metrics"


# Global metrics server instance
_metrics_server: Optional[PrometheusMetricsServer] = None


def get_metrics_server() -> PrometheusMetricsServer:
    """
    Get global metrics server instance.
    
    Returns:
        PrometheusMetricsServer singleton instance
    
    Raises:
        RuntimeError: If metrics server not initialized
    """
    global _metrics_server
    if _metrics_server is None:
        raise RuntimeError(
            "Metrics server not initialized. "
            "Call start_metrics_server() first."
        )
    return _metrics_server


def start_metrics_server(
    host: str = "0.0.0.0",
    port: int = 9090,
    metrics_registry: Optional[MetricsRegistry] = None
) -> PrometheusMetricsServer:
    """
    Start global metrics server.
    
    Args:
        host: Host to bind to
        port: Port to bind to
        metrics_registry: MetricsRegistry instance
    
    Returns:
        Started PrometheusMetricsServer instance
    """
    global _metrics_server
    
    if _metrics_server is not None and _metrics_server.is_running():
        logger.warning("Metrics server already running")
        return _metrics_server
    
    _metrics_server = PrometheusMetricsServer(
        host=host,
        port=port,
        metrics_registry=metrics_registry
    )
    _metrics_server.start()
    
    logger.info(f"Global metrics server started: {_metrics_server.get_url()}")
    return _metrics_server


def stop_metrics_server():
    """Stop global metrics server."""
    global _metrics_server
    
    if _metrics_server is not None:
        _metrics_server.stop()
        _metrics_server = None
        logger.info("Global metrics server stopped")
