"""
Enterprise API routes for Caracal.

This module provides API endpoints for enterprise features.
In the open source edition, these endpoints return appropriate
enterprise required messages.

Endpoints:
- GET /enterprise/status: Get enterprise edition status
- POST /enterprise/connect: Attempt to connect with enterprise license
- GET /enterprise/features: List available enterprise features
"""

from typing import Any

from caracal.enterprise import EnterpriseLicenseValidator


def get_enterprise_status() -> dict[str, Any]:
    """
    Get enterprise edition status.
    
    Returns information about enterprise features and license status.
    This endpoint is available in both open source and enterprise editions.
    
    Returns:
        Dictionary with enterprise status information
    
    Response Format:
        {
            "edition": "open_source" | "enterprise",
            "enterprise_features_available": bool,
            "upgrade_url": str,
            "contact_email": str,
            "features": {
                "feature_name": {
                    "available": bool,
                    "requires": "open_source" | "enterprise"
                },
                ...
            }
        }
    
    Example:
        >>> status = get_enterprise_status()
        >>> print(status["edition"])
        "open_source"
    """
    return {
        "edition": "open_source",
        "enterprise_features_available": False,
        "upgrade_url": "https://garudexlabs.com",
        "contact_email": "support@garudexlabs.com",
        "features": {
            "sso": {
                "available": False,
                "requires": "enterprise",
                "description": "Single Sign-On integration (SAML, OIDC, Okta, Azure AD)",
            },
            "analytics": {
                "available": False,
                "requires": "enterprise",
                "description": "Advanced analytics dashboard and anomaly detection",
            },
            "workflows": {
                "available": False,
                "requires": "enterprise",
                "description": "Workflow automation engine",
            },
            "compliance": {
                "available": False,
                "requires": "enterprise",
                "description": "Compliance reporting (SOC 2, ISO 27001, GDPR, HIPAA)",
            },
            "multi_tenancy": {
                "available": False,
                "requires": "enterprise",
                "description": "Multi-tenancy support",
            },
            "priority_support": {
                "available": False,
                "requires": "enterprise",
                "description": "24/7 priority support with SLA guarantees",
            },
        },
    }


def connect_enterprise(license_token: str) -> dict[str, Any]:
    """
    Attempt to connect with enterprise license.
    
    Validates license token and returns connection status.
    In the open source edition, this always returns a failure with
    upgrade messaging.
    
    Args:
        license_token: Enterprise license token
    
    Returns:
        Dictionary with connection status
    
    Response Format:
        {
            "connected": bool,
            "message": str,
            "features_available": list[str],
            "expires_at": str | None
        }
    
    Example:
        >>> result = connect_enterprise("CE-1-...")
        >>> print(result["connected"])
        False
    """
    validator = EnterpriseLicenseValidator()
    result = validator.validate_license(license_token)
    
    return {
        "connected": result.valid,
        "message": result.message,
        "features_available": result.features_available,
        "expires_at": result.expires_at.isoformat() if result.expires_at else None,
    }


def get_enterprise_features() -> dict[str, Any]:
    """
    Get list of available enterprise features.
    
    Returns detailed information about each enterprise feature,
    including availability status and requirements.
    
    Returns:
        Dictionary with feature information
    
    Response Format:
        {
            "features": [
                {
                    "name": str,
                    "available": bool,
                    "requires": "open_source" | "enterprise",
                    "description": str,
                    "documentation_url": str
                },
                ...
            ]
        }
    
    Example:
        >>> features = get_enterprise_features()
        >>> for feature in features["features"]:
        ...     print(f"{feature['name']}: {feature['available']}")
    """
    validator = EnterpriseLicenseValidator()
    available_features = validator.get_available_features()
    
    all_features = [
        {
            "name": "sso",
            "display_name": "Single Sign-On",
            "available": "sso" in available_features,
            "requires": "enterprise",
            "description": "Single Sign-On integration with SAML, OIDC, Okta, Azure AD, and Google Workspace",
            "documentation_url": "https://docs.garudexlabs.com/enterprise/sso",
        },
        {
            "name": "analytics",
            "display_name": "Advanced Analytics",
            "available": "analytics" in available_features,
            "requires": "enterprise",
            "description": "Advanced analytics dashboard with anomaly detection and usage pattern analysis",
            "documentation_url": "https://docs.garudexlabs.com/enterprise/analytics",
        },
        {
            "name": "workflows",
            "display_name": "Workflow Automation",
            "available": "workflows" in available_features,
            "requires": "enterprise",
            "description": "Event-driven workflow automation engine with custom workflow definitions",
            "documentation_url": "https://docs.garudexlabs.com/enterprise/workflows",
        },
        {
            "name": "compliance",
            "display_name": "Compliance Reporting",
            "available": "compliance" in available_features,
            "requires": "enterprise",
            "description": "Compliance reporting for SOC 2, ISO 27001, GDPR, and HIPAA",
            "documentation_url": "https://docs.garudexlabs.com/enterprise/compliance",
        },
        {
            "name": "multi_tenancy",
            "display_name": "Multi-Tenancy",
            "available": "multi_tenancy" in available_features,
            "requires": "enterprise",
            "description": "Multi-tenancy support with tenant isolation and per-tenant configuration",
            "documentation_url": "https://docs.garudexlabs.com/enterprise/multi-tenancy",
        },
        {
            "name": "priority_support",
            "display_name": "Priority Support",
            "available": "priority_support" in available_features,
            "requires": "enterprise",
            "description": "24/7 priority support with dedicated support engineer and SLA guarantees",
            "documentation_url": "https://docs.garudexlabs.com/enterprise/support",
        },
    ]
    
    return {
        "features": all_features,
        "upgrade_url": "https://garudexlabs.com",
        "contact_email": "support@garudexlabs.com",
    }


def get_license_info() -> dict[str, Any]:
    """
    Get information about the current license.
    
    Returns license status and available features.
    In the open source edition, this indicates no enterprise license is active.
    
    Returns:
        Dictionary with license information
    
    Response Format:
        {
            "edition": "open_source" | "enterprise",
            "license_active": bool,
            "features_available": list[str],
            "expires_at": str | None,
            "upgrade_url": str,
            "contact_email": str
        }
    
    Example:
        >>> info = get_license_info()
        >>> print(info["license_active"])
        False
    """
    validator = EnterpriseLicenseValidator()
    return validator.get_license_info()


# Flask/FastAPI route handlers
# These can be used to integrate with web frameworks

def create_flask_routes(app):
    """
    Create Flask routes for enterprise endpoints.
    
    Args:
        app: Flask application instance
    
    Example:
        >>> from flask import Flask
        >>> app = Flask(__name__)
        >>> create_flask_routes(app)
    """
    from flask import jsonify, request
    
    @app.route("/enterprise/status", methods=["GET"])
    def enterprise_status():
        """Get enterprise status."""
        return jsonify(get_enterprise_status())
    
    @app.route("/enterprise/connect", methods=["POST"])
    def enterprise_connect():
        """Connect with enterprise license."""
        data = request.get_json()
        license_token = data.get("license_token", "")
        return jsonify(connect_enterprise(license_token))
    
    @app.route("/enterprise/features", methods=["GET"])
    def enterprise_features():
        """Get enterprise features."""
        return jsonify(get_enterprise_features())
    
    @app.route("/enterprise/license", methods=["GET"])
    def enterprise_license():
        """Get license information."""
        return jsonify(get_license_info())


def create_fastapi_routes(app):
    """
    Create FastAPI routes for enterprise endpoints.
    
    Args:
        app: FastAPI application instance
    
    Example:
        >>> from fastapi import FastAPI
        >>> app = FastAPI()
        >>> create_fastapi_routes(app)
    """
    from fastapi import Body
    
    @app.get("/enterprise/status")
    async def enterprise_status():
        """Get enterprise status."""
        return get_enterprise_status()
    
    @app.post("/enterprise/connect")
    async def enterprise_connect_endpoint(license_token: str = Body(..., embed=True)):
        """Connect with enterprise license."""
        return connect_enterprise(license_token)
    
    @app.get("/enterprise/features")
    async def enterprise_features():
        """Get enterprise features."""
        return get_enterprise_features()
    
    @app.get("/enterprise/license")
    async def enterprise_license():
        """Get license information."""
        return get_license_info()
