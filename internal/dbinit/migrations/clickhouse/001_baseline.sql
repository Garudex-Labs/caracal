-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
-- SPDX-License-Identifier: Apache-2.0

-- Baseline schema: creates the complete ClickHouse schema from an empty
-- database. Databases created before this baseline are not upgradable
-- through these migrations; recreate them from scratch.
--
-- Retention: audit_log and security_events expire after 730 days;
-- webhook_deliveries after 730 days. Session data (including raw
-- transcripts) is governed by the data.retention_days dynamic setting,
-- applied as a table TTL at startup and enforced by the retention purger.

-- Raw session transcript lines, one row per JSONL line. The ingest service
-- recomputes session_stats_agg after every insert; there is deliberately no
-- materialized view (per-insert-block partial aggregates could transiently
-- replace complete summaries).
CREATE TABLE IF NOT EXISTS session_events (
    session_id          String,
    project_id          String,
    user_id             String,
    agent_id            Nullable(String),
    agent_version       Nullable(String),
    layer_hash          Nullable(String),
    harness             LowCardinality(String),
    line_offset         UInt32,
    source_end_offset   UInt64 DEFAULT 0,
    line_hash           String DEFAULT '' CODEC(ZSTD(1)),
    source_sha256       String DEFAULT '' CODEC(ZSTD(1)),
    is_source_record    UInt8 DEFAULT 1,
    rendered            UInt8 DEFAULT 1,
    event_type          LowCardinality(String),
    timestamp           DateTime64(3, 'UTC'),
    uuid                Nullable(String),
    parent_uuid         Nullable(String),
    tool_name           Nullable(String),
    tool_id             Nullable(String),
    content_preview     String CODEC(ZSTD(1)),
    content_length      UInt32,
    raw_line            String CODEC(ZSTD(3)),
    ingested_at         DateTime64(3, 'UTC') DEFAULT now64(3),
    credits             Float64 DEFAULT 0,
    parent_session_id   Nullable(String),
    input_tokens        Int32 DEFAULT 0,
    output_tokens       Int32 DEFAULT 0,
    cache_read_tokens   Int32 DEFAULT 0,
    cache_write_tokens  Int32 DEFAULT 0,
    model               LowCardinality(String) DEFAULT '',
    raw_line_truncated  UInt8 DEFAULT 0,
    INDEX idx_se_session_id session_id TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_se_project_id project_id TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_se_user_id user_id TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_se_agent_id agent_id TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_se_event_type event_type TYPE set(20) GRANULARITY 1,
    INDEX idx_se_line_hash line_hash TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_se_parent_session_id parent_session_id TYPE set(0) GRANULARITY 1
) ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY sipHash64(project_id, user_id, harness, session_id) % 64
ORDER BY (project_id, user_id, harness, session_id, line_offset);

-- Acknowledged-delivery watermarks for the ingest ack/repair protocol.
CREATE TABLE IF NOT EXISTS session_checkpoints (
    project_id          String,
    user_id             String,
    harness             LowCardinality(String),
    session_id          String,
    acknowledged_line   Int64,
    acknowledged_offset UInt64 DEFAULT 0,
    checkpoint_version  UInt64,
    updated_at          DateTime64(3, 'UTC') DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(checkpoint_version)
ORDER BY (project_id, user_id, harness, session_id);

-- One complete summary row per session, recomputed by the ingest service
-- after each accepted push (summary_version = recompute time).
CREATE TABLE IF NOT EXISTS session_stats_agg (
    project_id          String,
    session_id          String,
    agent_id            LowCardinality(String) DEFAULT '',
    agent_version       LowCardinality(String) DEFAULT '',
    user_id             String DEFAULT '',
    parent_session_id   String DEFAULT '',
    harness             LowCardinality(String) DEFAULT '',
    layer_hash          String DEFAULT '',
    first_event_time    DateTime64(3, 'UTC'),
    last_event_time     DateTime64(3, 'UTC'),
    event_count         Int64,
    prompt_count        Int64,
    tool_call_count     Int64,
    tool_result_count   Int64,
    input_tokens        Int64,
    output_tokens       Int64,
    cache_read_tokens   Int64,
    cache_write_tokens  Int64,
    total_credits       Float64,
    model               String,
    summary_version     UInt64,
    updated_at          DateTime64(3, 'UTC') DEFAULT now64(3),
    INDEX idx_ssa_user_id user_id TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_ssa_agent_id agent_id TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_ssa_agent_version agent_version TYPE bloom_filter(0.01) GRANULARITY 1
) ENGINE = ReplacingMergeTree(summary_version)
PARTITION BY sipHash64(project_id, user_id, harness, session_id) % 64
ORDER BY (project_id, user_id, harness, session_id);

-- Compliance audit trail (append-only, hash-chained).
CREATE TABLE IF NOT EXISTS audit_log (
    event_id      UUID,
    timestamp     DateTime64(3, 'UTC'),
    actor_id      String,
    actor_email   String,
    actor_role    LowCardinality(String),
    action        LowCardinality(String),
    resource_type LowCardinality(String),
    resource_id   String DEFAULT '',
    resource_name String DEFAULT '',
    http_method   LowCardinality(String) DEFAULT '',
    http_path     String DEFAULT '',
    status_code   UInt16 DEFAULT 0,
    ip_address    String DEFAULT '',
    user_agent    String DEFAULT '',
    detail        String DEFAULT '',
    sensitivity   LowCardinality(String) DEFAULT 'standard',
    request_id    String DEFAULT '',
    outcome       LowCardinality(String) DEFAULT '',
    duration_ms   Float32 DEFAULT 0,
    chain_hash    String DEFAULT '',
    source        LowCardinality(String) DEFAULT 'server',
    INDEX idx_actor_id actor_id TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_action action TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_resource_type resource_type TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_outcome outcome TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_sensitivity sensitivity TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_source source TYPE bloom_filter(0.01) GRANULARITY 1
) ENGINE = MergeTree()
TTL toDateTime(timestamp) + INTERVAL 730 DAY
PARTITION BY toYYYYMM(timestamp)
ORDER BY (action, resource_type, timestamp);

-- Security-relevant events (auth failures, permission denials, ...).
CREATE TABLE IF NOT EXISTS security_events (
    event_id    UUID,
    timestamp   DateTime64(3, 'UTC'),
    event_type  LowCardinality(String),
    severity    LowCardinality(String),
    actor_id    String DEFAULT '',
    actor_email String DEFAULT '',
    actor_role  LowCardinality(String) DEFAULT '',
    target_id   String DEFAULT '',
    target_type LowCardinality(String) DEFAULT '',
    outcome     LowCardinality(String),
    source_ip   String DEFAULT '',
    user_agent  String DEFAULT '',
    detail      String DEFAULT '',
    INDEX idx_event_type event_type TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_severity severity TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_actor_id actor_id TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_outcome outcome TYPE bloom_filter(0.01) GRANULARITY 1
) ENGINE = MergeTree()
TTL toDateTime(timestamp) + INTERVAL 730 DAY
PARTITION BY toYYYYMM(timestamp)
ORDER BY (event_type, severity, timestamp);

-- Alert webhook delivery attempts.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    delivery_id     UUID,
    event_id        UUID,
    alert_rule_id   UUID,
    attempt_number  UInt8,
    timestamp       DateTime64(3, 'UTC'),
    webhook_url     String,
    status_code     Nullable(UInt16),
    delivery_status LowCardinality(String),
    error           Nullable(String),
    duration_ms     Float32,
    payload_size    UInt32
) ENGINE = MergeTree()
TTL toDateTime(timestamp) + INTERVAL 730 DAY
PARTITION BY toYYYYMM(timestamp)
ORDER BY (alert_rule_id, timestamp);

-- Full harness layer manifests keyed by content hash; power version-aware
-- insights (diffing layer states, per-agent baseline pins).
CREATE TABLE IF NOT EXISTS layer_snapshots (
    hash            String,
    project_id      String,
    user_id         String,
    harness         LowCardinality(String),
    content         String CODEC(ZSTD(3)),
    uploaded_at     DateTime64(3, 'UTC') DEFAULT now64(3),
    file_count      UInt16,
    total_size      UInt32,
    lockfile_hash   String DEFAULT ''
) ENGINE = ReplacingMergeTree(uploaded_at)
ORDER BY (project_id, user_id, hash);
