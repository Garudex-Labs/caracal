"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Advanced analytics export for Caracal Enterprise.

This module provides advanced analytics and anomaly detection capabilities
for Caracal Enterprise. In the open source edition, all analytics methods
are stubbed and raise EnterpriseFeatureRequired exceptions.

Note: Basic Prometheus metrics are available in the open source edition
at the /metrics endpoint. Advanced analytics require Caracal Enterprise.

Enterprise Analytics Features:
- Real-time analytics dashboard
- Anomaly detection
- Usage pattern analysis
- Custom metrics export
- Predictive analytics
- Trend analysis
"""

from abc import ABC, abstractmethod
from typing import Any, Optional

from caracal.enterprise.exceptions import EnterpriseFeatureRequired


class AnalyticsExporter(ABC):
    """
    Abstract base class for analytics export.
    
    ENTERPRISE ONLY: Advanced analytics requires Caracal Enterprise.
    Open source includes basic Prometheus metrics only.
    
    Analytics exporters provide advanced analysis of authority enforcement
    data, including usage patterns, anomaly detection, and predictive analytics.
    
    In Caracal Enterprise, implementations would:
    - Aggregate authority ledger data
    - Detect anomalous patterns
    - Generate usage reports
    - Provide predictive insights
    - Export data in various formats
    """
    
    @abstractmethod
    def export_authority_metrics(
        self,
        time_range: tuple[str, str],
        principals: Optional[list[str]] = None,
        format: str = "json",
    ) -> dict[str, Any]:
        """
        Export authority metrics for a time range.
        
        Args:
            time_range: Tuple of (start_time, end_time) in ISO format
            principals: Optional list of principal IDs to filter by
            format: Export format (json, csv, parquet)
        
        Returns:
            Dictionary with exported metrics
        
        Raises:
            EnterpriseFeatureRequired: In open source edition
        
        Enterprise Metrics:
            - mandate_issuance_rate: Mandates issued per time period
            - validation_success_rate: Percentage of successful validations
            - denial_rate: Percentage of denied validations
            - revocation_rate: Mandates revoked per time period
            - delegation_depth_distribution: Distribution of delegation depths
            - resource_access_patterns: Most accessed resources
            - action_type_distribution: Distribution of action types
            - principal_activity: Activity levels by principal
        """
        pass
    
    @abstractmethod
    def get_anomaly_report(
        self,
        time_range: Optional[tuple[str, str]] = None,
        sensitivity: float = 0.95,
    ) -> dict[str, Any]:
        """
        Get anomaly detection report.
        
        Args:
            time_range: Optional time range to analyze (defaults to last 24 hours)
            sensitivity: Anomaly detection sensitivity (0.0-1.0)
        
        Returns:
            Dictionary with detected anomalies
        
        Raises:
            EnterpriseFeatureRequired: In open source edition
        
        Enterprise Anomalies:
            - unusual_validation_patterns: Unexpected validation rates
            - suspicious_principals: Principals with anomalous behavior
            - resource_access_anomalies: Unusual resource access patterns
            - delegation_anomalies: Unusual delegation patterns
            - time_based_anomalies: Activity outside normal hours
        """
        pass
    
    @abstractmethod
    def get_usage_patterns(
        self,
        principal_id: Optional[str] = None,
        time_range: Optional[tuple[str, str]] = None,
    ) -> dict[str, Any]:
        """
        Get usage pattern analysis.
        
        Args:
            principal_id: Optional principal ID to analyze
            time_range: Optional time range to analyze
        
        Returns:
            Dictionary with usage patterns
        
        Raises:
            EnterpriseFeatureRequired: In open source edition
        
        Enterprise Patterns:
            - peak_usage_times: Times of highest activity
            - resource_preferences: Most frequently accessed resources
            - action_preferences: Most frequently used actions
            - delegation_patterns: Delegation behavior patterns
            - temporal_patterns: Day-of-week and time-of-day patterns
        """
        pass
    
    @abstractmethod
    def get_predictive_insights(
        self,
        forecast_period: str = "7d",
    ) -> dict[str, Any]:
        """
        Get predictive analytics insights.
        
        Args:
            forecast_period: Period to forecast (e.g., "7d", "30d")
        
        Returns:
            Dictionary with predictive insights
        
        Raises:
            EnterpriseFeatureRequired: In open source edition
        
        Enterprise Insights:
            - expected_validation_volume: Predicted validation requests
            - expected_denial_rate: Predicted denial rate
            - capacity_recommendations: Scaling recommendations
            - risk_predictions: Predicted security risks
        """
        pass
    
    @abstractmethod
    def export_custom_report(
        self,
        query: dict[str, Any],
        format: str = "json",
    ) -> bytes:
        """
        Export custom analytics report.
        
        Args:
            query: Custom query specification
            format: Export format (json, csv, pdf, excel)
        
        Returns:
            Report data in requested format
        
        Raises:
            EnterpriseFeatureRequired: In open source edition
        
        Enterprise Query Specification:
            - metrics: List of metrics to include
            - dimensions: Grouping dimensions
            - filters: Data filters
            - aggregations: Aggregation functions
            - time_range: Time range for analysis
        """
        pass


class OpenSourceAnalyticsExporter(AnalyticsExporter):
    """
    Open source analytics stub.
    
    Basic Prometheus metrics are available in the open source edition.
    Advanced analytics requires Caracal Enterprise.
    
    Open Source Metrics:
    - Available at /metrics endpoint
    - Standard Prometheus format
    - Basic counters and histograms
    - No advanced analytics or anomaly detection
    
    Usage:
        >>> analytics = OpenSourceAnalyticsExporter()
        >>> try:
        ...     report = analytics.get_anomaly_report()
        ... except EnterpriseFeatureRequired as e:
        ...     print(e.message)
    """
    
    def export_authority_metrics(
        self,
        time_range: tuple[str, str],
        principals: Optional[list[str]] = None,
        format: str = "json",
    ) -> dict[str, Any]:
        """
        Export authority metrics.
        
        In open source, this always raises EnterpriseFeatureRequired.
        Basic metrics are available at /metrics endpoint.
        
        Args:
            time_range: Time range (ignored in open source)
            principals: Principal filter (ignored in open source)
            format: Export format (ignored in open source)
        
        Raises:
            EnterpriseFeatureRequired: Always raised in open source
        """
        raise EnterpriseFeatureRequired(
            feature="Advanced Analytics Export",
            message=(
                "Advanced analytics export requires Caracal Enterprise. "
                "Basic Prometheus metrics are available at /metrics endpoint."
            ),
        )
    
    def get_anomaly_report(
        self,
        time_range: Optional[tuple[str, str]] = None,
        sensitivity: float = 0.95,
    ) -> dict[str, Any]:
        """
        Get anomaly detection report.
        
        In open source, this always raises EnterpriseFeatureRequired.
        
        Args:
            time_range: Time range (ignored in open source)
            sensitivity: Sensitivity (ignored in open source)
        
        Raises:
            EnterpriseFeatureRequired: Always raised in open source
        """
        raise EnterpriseFeatureRequired(
            feature="Anomaly Detection",
            message=(
                "Anomaly detection requires Caracal Enterprise. "
                "Visit https://garudexlabs.com for licensing information."
            ),
        )
    
    def get_usage_patterns(
        self,
        principal_id: Optional[str] = None,
        time_range: Optional[tuple[str, str]] = None,
    ) -> dict[str, Any]:
        """
        Get usage pattern analysis.
        
        In open source, this always raises EnterpriseFeatureRequired.
        
        Args:
            principal_id: Principal ID (ignored in open source)
            time_range: Time range (ignored in open source)
        
        Raises:
            EnterpriseFeatureRequired: Always raised in open source
        """
        raise EnterpriseFeatureRequired(
            feature="Usage Pattern Analysis",
            message=(
                "Usage pattern analysis requires Caracal Enterprise. "
                "Visit https://garudexlabs.com for licensing information."
            ),
        )
    
    def get_predictive_insights(
        self,
        forecast_period: str = "7d",
    ) -> dict[str, Any]:
        """
        Get predictive analytics insights.
        
        In open source, this always raises EnterpriseFeatureRequired.
        
        Args:
            forecast_period: Forecast period (ignored in open source)
        
        Raises:
            EnterpriseFeatureRequired: Always raised in open source
        """
        raise EnterpriseFeatureRequired(
            feature="Predictive Analytics",
            message=(
                "Predictive analytics requires Caracal Enterprise. "
                "Visit https://garudexlabs.com for licensing information."
            ),
        )
    
    def export_custom_report(
        self,
        query: dict[str, Any],
        format: str = "json",
    ) -> bytes:
        """
        Export custom analytics report.
        
        In open source, this always raises EnterpriseFeatureRequired.
        
        Args:
            query: Query specification (ignored in open source)
            format: Export format (ignored in open source)
        
        Raises:
            EnterpriseFeatureRequired: Always raised in open source
        """
        raise EnterpriseFeatureRequired(
            feature="Custom Analytics Reports",
            message=(
                "Custom analytics reports require Caracal Enterprise. "
                "Visit https://garudexlabs.com for licensing information."
            ),
        )


# Convenience function for getting analytics exporter
def get_analytics_exporter() -> AnalyticsExporter:
    """
    Get analytics exporter instance.
    
    In open source, always returns OpenSourceAnalyticsExporter.
    In Caracal Enterprise, returns the full analytics exporter.
    
    Returns:
        AnalyticsExporter instance (OpenSourceAnalyticsExporter in open source)
    """
    # In open source, always return the stub
    return OpenSourceAnalyticsExporter()
