# Caracal Enterprise Extension Module

This module provides extension points for Caracal Enterprise features. In the open source edition, all enterprise features are stubbed with clear messages indicating they require the paid Caracal Enterprise edition.

## Architecture

The enterprise module follows an extension point architecture where:

1. **Abstract Base Classes** define the interface for enterprise features
2. **Open Source Implementations** provide stubs that raise `EnterpriseFeatureRequired` exceptions
3. **Caracal Enterprise** provides full implementations that replace the stubs

```
┌─────────────────────────────────────────────────────────────────┐
│                     Caracal Open Source                          │
│                                                                   │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │  Core Authority │  │  Authority      │  │  Gateway        │  │
│  │  Enforcement    │  │  Ledger         │  │  Proxy          │  │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘  │
│           │                    │                    │            │
│  ┌────────┴────────────────────┴────────────────────┴────────┐  │
│  │                 Enterprise Extension Points                │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐      │  │
│  │  │ SSO Hook │ │ Analytics│ │ Workflow │ │ Compliance│     │  │
│  │  │ (Stub)   │ │ Hook     │ │ Hook     │ │ Hook      │     │  │
│  │  │          │ │ (Stub)   │ │ (Stub)   │ │ (Stub)    │     │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘      │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                               │
                               │ (Requires Enterprise License)
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Caracal Enterprise                            │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐           │
│  │ SSO      │ │ Analytics│ │ Workflow │ │ Compliance│          │
│  │ Provider │ │ Engine   │ │ Engine   │ │ Reporter  │          │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘           │
└─────────────────────────────────────────────────────────────────┘
```

## Enterprise Features

### Available in Caracal Enterprise

1. **SSO Integration** (`sso.py`)
   - SAML 2.0 support
   - OIDC/OAuth 2.0 support
   - Integration with Okta, Azure AD, Google Workspace
   - Custom SSO provider support

2. **Advanced Analytics** (`analytics.py`)
   - Real-time analytics dashboard
   - Anomaly detection
   - Usage pattern analysis
   - Custom metrics export

3. **Workflow Automation** (`workflows.py`)
   - Event-driven automation
   - Custom workflow definitions
   - Integration with external systems
   - Scheduled tasks

4. **Compliance Reporting** (`compliance.py`)
   - SOC 2 compliance reports
   - ISO 27001 compliance reports
   - Custom audit reports
   - Automated compliance checks

5. **Multi-Tenancy** (Enterprise only)
   - Tenant isolation
   - Per-tenant configuration
   - Cross-tenant analytics
   - Tenant management API

6. **Priority Support** (Enterprise only)
   - 24/7 support access
   - Dedicated support engineer
   - SLA guarantees
   - Direct escalation path

### Available in Open Source

All core authority enforcement features are available in the open source edition:

- Execution mandate issuance, validation, and revocation
- Authority policy management
- Authority ledger (immutable audit trail)
- Delegation chain management
- Gateway enforcement (proxy, middleware, decorator)
- SDK client library
- CLI tools
- Caracal Flow TUI
- Basic Prometheus metrics
- Basic structured logging

## Module Structure

```
caracal/enterprise/
├── __init__.py           # Module exports
├── README.md             # This file
├── exceptions.py         # EnterpriseFeatureRequired exception
├── license.py            # License validation (stub in open source)
├── sso.py                # SSO integration (stub in open source)
├── analytics.py          # Analytics export (stub in open source)
├── workflows.py          # Workflow automation (stub in open source)
└── compliance.py         # Compliance reporting (stub in open source)
```

## Usage Examples

### Checking License Status

```python
from caracal.enterprise import EnterpriseLicenseValidator

validator = EnterpriseLicenseValidator()
result = validator.validate_license("CE-1-...")

if result.valid:
    print(f"Enterprise features enabled: {result.features_available}")
else:
    print(result.message)
```

### Handling Enterprise Features

```python
from caracal.enterprise import EnterpriseFeatureRequired
from caracal.enterprise.sso import OpenSourceSSOProvider

try:
    sso = OpenSourceSSOProvider()
    principal = sso.authenticate(token)
except EnterpriseFeatureRequired as e:
    print(f"Feature '{e.feature}' requires Caracal Enterprise")
    print(e.message)
    # Display upgrade information to user
```

### API Response Format

When an enterprise feature is accessed, the exception can be converted to a dictionary for API responses:

```python
try:
    # Attempt to use enterprise feature
    result = analytics.export_authority_metrics(time_range)
except EnterpriseFeatureRequired as e:
    return JSONResponse(
        status_code=402,  # Payment Required
        content=e.to_dict()
    )
```

Response format:
```json
{
  "error": "enterprise_feature_required",
  "feature": "Advanced Analytics Export",
  "message": "Advanced analytics export requires Caracal Enterprise. Basic Prometheus metrics are available at /metrics endpoint.",
  "upgrade_url": "https://garudexlabs.com",
  "contact_email": "support@garudexlabs.com"
}
```

## Extension Point Guidelines

When adding new enterprise extension points:

1. **Define Abstract Base Class**: Create an ABC with the interface
2. **Implement Open Source Stub**: Raise `EnterpriseFeatureRequired` with clear messaging
3. **Document Interface**: Clearly document what the enterprise implementation provides
4. **Provide Alternatives**: Mention any open source alternatives (e.g., basic metrics vs. advanced analytics)
5. **Update License Validator**: Add feature flag to `get_available_features()`

## License Token Format

Enterprise license tokens follow this format:

```
CE-{version}-{org_id}-{features}-{expiry}-{signature}
```

Components:
- `version`: License format version (currently "1")
- `org_id`: Organization identifier
- `features`: Comma-separated feature flags (e.g., "sso,analytics,workflows")
- `expiry`: Expiration date in YYYYMMDD format
- `signature`: Cryptographic signature for validation

Example:
```
CE-1-abc123-sso,analytics,workflows-20251231-3a7b9c...
```

## Upgrade Information

To upgrade to Caracal Enterprise:

- **Website**: https://garudexlabs.com
- **Email**: support@garudexlabs.com
- **Documentation**: https://docs.garudexlabs.com/enterprise

## Security Considerations

1. **License Validation**: License tokens are cryptographically signed and validated
2. **Feature Flags**: Features are enabled only with valid license
3. **Graceful Degradation**: Open source features continue to work without license
4. **Clear Messaging**: Users always know when they need enterprise features

## Testing

Enterprise stubs should be tested to ensure:

1. All methods raise `EnterpriseFeatureRequired` with appropriate messages
2. Exception messages include upgrade information
3. License validation always returns False in open source
4. Feature availability checks always return False in open source

Example test:
```python
def test_sso_requires_enterprise():
    sso = OpenSourceSSOProvider()
    
    with pytest.raises(EnterpriseFeatureRequired) as exc_info:
        sso.authenticate("token")
    
    assert exc_info.value.feature == "SSO Authentication"
    assert "Caracal Enterprise" in exc_info.value.message
    assert "https://garudexlabs.com" in exc_info.value.message
```
