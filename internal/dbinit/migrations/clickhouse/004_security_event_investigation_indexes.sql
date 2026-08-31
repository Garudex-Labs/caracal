-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
-- SPDX-License-Identifier: Apache-2.0

-- Additional skipping indexes for the organization security investigation view.
-- These match the newly exposed equality filters and broadened free-text
-- expression while preserving the existing org-scope target_id index.

ALTER TABLE security_events ADD INDEX IF NOT EXISTS idx_se_target_type target_type TYPE bloom_filter(0.01) GRANULARITY 1;
ALTER TABLE security_events ADD INDEX IF NOT EXISTS idx_se_source_ip source_ip TYPE bloom_filter(0.01) GRANULARITY 1;
ALTER TABLE security_events ADD INDEX IF NOT EXISTS idx_se_org_investigation_search lowerUTF8(concat(event_type, ' ', severity, ' ', actor_email, ' ', actor_role, ' ', target_type, ' ', target_id, ' ', outcome, ' ', source_ip, ' ', user_agent, ' ', detail)) TYPE ngrambf_v1(2, 2048, 3, 0) GRANULARITY 1;