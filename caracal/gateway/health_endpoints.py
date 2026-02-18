"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Health check endpoints for gateway and services.

Provides HTTP endpoints for health checks that can be used by load balancers,
Kubernetes probes, and monitoring systems.

Requirements: 15.8
"""

import asyncio
from datetime import datetime
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from caracal.monitoring.health import HealthChecker, HealthStatus
from caracal.logging_config import get_logger

logger = get_logger(__name__)


class HealthEndpoints:
    """
    Health check endpoints for gateway and services.
    
    Provides /health endpoint that checks:
    - Database connectivity
    - Redis connectivity (if configured)
    Requirements: 15.8
    """
    
    def __init__(
        self,
        service_name: str,
        service_version: str,
        db_connection_manager: Optional[Any] = None,
        redis_client: Optional[Any] = None
    ):
        """
        Initialize health endpoints.
        
        Args:
            service_name: Name of the service (e.g., "gateway", "ledger-writer")
            service_version: Version of the service
            db_connection_manager: Optional database connection manager
            redis_client: Optional Redis client
        """
        self.service_name = service_name
        self.service_version = service_version
        self.health_checker = HealthChecker(
            service_name=service_name,
            service_version=service_version,
            db_connection_manager=db_connection_manager,
            redis_client=redis_client
        )
        logger.info(f"HealthEndpoints initialized for {service_name} v{service_version}")
    
    async def health_check(self) -> Dict[str, Any]:
        """
        Perform health check and return result.
        
        Returns:
            Dictionary with health check results in JSON format
        """
        logger.debug(f"Performing health check for {self.service_name}")
        
        try:
            result = await self.health_checker.check_health()
            
            # Convert to dictionary for JSON response
            response = result.to_dict()
            
            logger.info(
                f"Health check completed: service={self.service_name}, "
                f"status={result.status.value}"
            )
            
            return response
            
        except Exception as e:
            logger.error(f"Health check failed: {e}", exc_info=True)
            
            # Return unhealthy status on error
            return {
                "status": HealthStatus.UNHEALTHY.value,
                "service": self.service_name,
                "version": self.service_version,
                "checked_at": datetime.utcnow().isoformat(),
                "error": str(e),
                "checks": {}
            }
    
    def health_check_sync(self) -> Dict[str, Any]:
        """
        Synchronous wrapper for health check.
        
        Returns:
            Dictionary with health check results in JSON format
        """
        # Run async health check in event loop
        try:
            loop = asyncio.get_event_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
        
        return loop.run_until_complete(self.health_check())
    
    def get_http_status_code(self, health_status: str) -> int:
        """
        Get HTTP status code for health status.
        
        Args:
            health_status: Health status string (healthy, degraded, unhealthy)
        
        Returns:
            HTTP status code (200 for healthy, 503 for degraded/unhealthy)
        """
        if health_status == HealthStatus.HEALTHY.value:
            return 200
        else:
            # Return 503 Service Unavailable for degraded or unhealthy
            return 503


# Flask integration

def create_flask_health_endpoint(
    app: Any,
    health_endpoints: HealthEndpoints,
    path: str = "/health"
) -> None:
    """
    Create Flask health check endpoint.
    
    Args:
        app: Flask application instance
        health_endpoints: HealthEndpoints instance
        path: URL path for health endpoint (default: /health)
    """
    from flask import jsonify
    
    @app.route(path, methods=["GET"])
    def health():
        """Health check endpoint."""
        result = health_endpoints.health_check_sync()
        status_code = health_endpoints.get_http_status_code(result["status"])
        return jsonify(result), status_code
    
    logger.info(f"Flask health endpoint created at {path}")


# FastAPI integration

def create_fastapi_health_endpoint(
    app: Any,
    health_endpoints: HealthEndpoints,
    path: str = "/health"
) -> None:
    """
    Create FastAPI health check endpoint.
    
    Args:
        app: FastAPI application instance
        health_endpoints: HealthEndpoints instance
        path: URL path for health endpoint (default: /health)
    """
    from fastapi import Response
    
    @app.get(path)
    async def health():
        """Health check endpoint."""
        result = await health_endpoints.health_check()
        status_code = health_endpoints.get_http_status_code(result["status"])
        return Response(
            content=str(result),
            status_code=status_code,
            media_type="application/json"
        )
    
    logger.info(f"FastAPI health endpoint created at {path}")


# WSGI integration

class HealthCheckWSGIApp:
    """
    WSGI application for health check endpoint.
    
    Can be used standalone or mounted in existing WSGI applications.
    """
    
    def __init__(self, health_endpoints: HealthEndpoints):
        """
        Initialize WSGI health check app.
        
        Args:
            health_endpoints: HealthEndpoints instance
        """
        self.health_endpoints = health_endpoints
        logger.info("HealthCheckWSGIApp initialized")
    
    def __call__(self, environ: Dict, start_response: callable) -> list:
        """
        WSGI application interface.
        
        Args:
            environ: WSGI environment dictionary
            start_response: WSGI start_response callable
        
        Returns:
            Response body as list of bytes
        """
        path = environ.get("PATH_INFO", "")
        method = environ.get("REQUEST_METHOD", "GET")
        
        # Only handle GET /health
        if path == "/health" and method == "GET":
            result = self.health_endpoints.health_check_sync()
            status_code = self.health_endpoints.get_http_status_code(result["status"])
            
            # Convert result to JSON
            import json
            body = json.dumps(result).encode("utf-8")
            
            # Send response
            status = f"{status_code} {self._get_status_text(status_code)}"
            headers = [
                ("Content-Type", "application/json"),
                ("Content-Length", str(len(body)))
            ]
            start_response(status, headers)
            
            return [body]
        else:
            # Return 404 for other paths
            status = "404 Not Found"
            body = b'{"error": "Not Found"}'
            headers = [
                ("Content-Type", "application/json"),
                ("Content-Length", str(len(body)))
            ]
            start_response(status, headers)
            return [body]
    
    def _get_status_text(self, status_code: int) -> str:
        """
        Get HTTP status text for status code.
        
        Args:
            status_code: HTTP status code
        
        Returns:
            Status text string
        """
        status_texts = {
            200: "OK",
            503: "Service Unavailable",
            404: "Not Found"
        }
        return status_texts.get(status_code, "Unknown")


# Standalone HTTP server for health checks

def run_health_check_server(
    health_endpoints: HealthEndpoints,
    host: str = "0.0.0.0",
    port: int = 8080
) -> None:
    """
    Run standalone HTTP server for health checks.
    
    Useful for services that don't have their own HTTP server.
    
    Args:
        health_endpoints: HealthEndpoints instance
        host: Host to bind to (default: 0.0.0.0)
        port: Port to bind to (default: 8080)
    """
    from http.server import HTTPServer
    from wsgiref.simple_server import make_server
    
    app = HealthCheckWSGIApp(health_endpoints)
    
    logger.info(f"Starting health check server on {host}:{port}")
    
    with make_server(host, port, app) as httpd:
        logger.info(f"Health check server running at http://{host}:{port}/health")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            logger.info("Health check server stopped")
