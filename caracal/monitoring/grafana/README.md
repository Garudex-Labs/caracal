# Grafana Dashboards for Caracal Core

This directory contains Grafana dashboard JSON files for monitoring Caracal Core.

## Dashboards

1. **merkle-tree.json** - Merkle tree operations dashboard
   - Batch creation rate and size
   - Tree computation and signing duration
   - Verification performance
   - Tamper detection alerts

3. **policy-versioning.json** - Policy versioning dashboard
   - Policy version creation rate
   - Version history queries
   - Policy change audit trail
   - Active policies per principal

4. **allowlists.json** - Resource allowlist dashboard
   - Allowlist check rate
   - Match vs miss ratio
   - Pattern matching performance
   - Cache hit rate

5. **spending-trends.json** - Spending trends dashboard
   - Spending over time per principal
   - Budget utilization
   - Spending anomalies
   - Top spenders

## Installation

1. Import dashboards into Grafana:
   ```bash
   # Via Grafana UI
   # Settings > Data Sources > Add Prometheus data source
   # Dashboards > Import > Upload JSON file
   
   # Via API
   curl -X POST http://grafana:3000/api/dashboards/db \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer YOUR_API_KEY" \
     -d @merkle-tree.json
   ```

2. Configure Prometheus data source:
   - URL: http://prometheus:9090
   - Access: Server (default)
   - Scrape interval: 15s

3. Set up alerts (optional):
   - Configure alert channels (email, Slack, PagerDuty)
   - Enable alerting on critical metrics

## Metrics Endpoint

Caracal Core exposes Prometheus metrics at:
- Gateway: http://gateway:9090/metrics
- Consumers: http://consumer:9090/metrics

## Requirements

- Grafana 8.0+
- Prometheus data source configured
- Caracal Core v0.3 with metrics enabled
