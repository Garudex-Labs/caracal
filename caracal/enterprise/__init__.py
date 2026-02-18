"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal Enterprise Extension Module.

This module provides extension points for Caracal Enterprise features.
In the open source edition, all enterprise features are stubbed with
clear messages indicating they require the paid Caracal Enterprise edition.

Enterprise Features:
- SSO Integration (SAML, OIDC, Okta, Azure AD)
- Advanced Analytics Dashboard
- Workflow Automation Engine
- Compliance Reporting (SOC 2, ISO 27001)
- Multi-Tenancy Support
- Priority Support

For licensing information, visit: https://garudexlabs.com
Contact: support@garudexlabs.com
"""

from caracal.enterprise.exceptions import EnterpriseFeatureRequired
from caracal.enterprise.license import (
    EnterpriseLicenseValidator,
    LicenseValidationResult,
)

__all__ = [
    "EnterpriseFeatureRequired",
    "EnterpriseLicenseValidator",
    "LicenseValidationResult",
]
