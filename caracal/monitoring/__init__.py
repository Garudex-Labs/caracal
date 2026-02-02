"""
Monitoring and observability for Caracal Core.

This module provides Prometheus metrics for monitoring system performance
and behavior.
"""

from caracal.monitoring.metrics import (
    MetricsRegistry,
    get_metrics_registry,
    initialize_metrics_registry,
)

__all__ = [
    "MetricsRegistry",
    "get_metrics_registry",
    "initialize_metrics_registry",
]
