# Caracal Core Monitoring

This module provides comprehensive Prometheus metrics for monitoring Caracal Core v0.5 in production.

## Overview

The monitoring module instruments all major components of the pre-execution authority enforcement system:

- **Gateway Proxy**: Request metrics, authorization failures, mandate validation latency
- **Authority Evaluator**: Mandate validation metrics, cache statistics
- **Database**: Query metrics, connection pool statistics
- **Circuit Breakers**: State tracking for downstream health

## Installation

The `prometheus-client` package is included in Caracal Core dependencies:

```bash
pip install caracal-core
```

## Quick Start

### Record Metrics

```python
from caracal.monitoring import get_metrics_registry, AuthorityDecisionType

metrics = get_metrics_registry()

# Record a gateway request
metrics.record_gateway_request(
    method="POST",
    status_code=200,
    auth_method="mandate",
    duration_seconds=0.04
)

# Record an authority validation
metrics.record_authority_validation(
    decision=AuthorityDecisionType.ALLOWED,
    principal_id="principal-uuid",
    duration_seconds=0.01
)
```

## Available Metrics

### Gateway Request Metrics

| Metric | Type | Description | Labels |
|--------|------|-------------|--------|
| `caracal_gateway_requests_total` | Counter | Total number of gateway requests | method, status_code, auth_method |
| `caracal_gateway_request_duration_seconds` | Histogram | Gateway request duration | method, status_code |
| `caracal_gateway_auth_failures_total` | Counter | Total authentication failures | auth_method, reason |

### Authority Validation Metrics

| Metric | Type | Description | Labels |
|--------|------|-------------|--------|
| `caracal_authority_validations_total` | Counter | Total authority validation requests | decision, principal_id |
| `caracal_authority_validation_duration_seconds` | Histogram | Authority validation duration | decision |
| `caracal_authority_cache_hits_total` | Counter | Total mandate/policy cache hits | - |

### Database Query Metrics

| Metric | Type | Description | Labels |
|--------|------|-------------|--------|
| `caracal_database_queries_total` | Counter | Total database queries | operation, table, status |
| `caracal_database_query_duration_seconds` | Histogram | Database query duration | operation, table |
| `caracal_database_connection_pool_size` | Gauge | Current connection pool size | - |

---

## Grafana Dashboards

### Key Metrics to Monitor

1. **Authorization Performance**
   - Validation rate: `rate(caracal_authority_validations_total[5m])`
   - Denial rate: `rate(caracal_authority_validations_total{decision="denied"}[5m])`
   - Validation latency: `histogram_quantile(0.99, rate(caracal_authority_validation_duration_seconds_bucket[5m]))`

2. **Database & Infrastructure**
   - Query latency (p99): `histogram_quantile(0.99, rate(caracal_database_query_duration_seconds_bucket[5m]))`
   - Connection pool utilization: `caracal_database_connection_pool_checked_out / caracal_database_connection_pool_size`

## Alerting Rules

Example Prometheus alerting rules:

```yaml
groups:
  - name: caracal_alerts
    rules:
      # High authority denial rate (indicates potential attack or misconfiguration)
      - alert: HighAuthorityDenialRate
        expr: rate(caracal_authority_validations_total{decision="denied"}[5m]) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High authority denial rate"
          description: "Authority denial rate is {{ $value }} denials/sec"
```
