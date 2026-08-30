-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
-- SPDX-License-Identifier: Apache-2.0

-- N-gram data-skipping indexes for organization activity free-text search.
-- The indexed expressions exactly match the fixed expressions used by the
-- audit/security handlers. Existing parts gain the indexes as they merge;
-- no blocking MATERIALIZE mutation runs during startup.

ALTER TABLE audit_log ADD INDEX IF NOT EXISTS idx_al_org_search lowerUTF8(concat(actor_email, ' ', action, ' ', resource_type, ' ', resource_name, ' ', http_method, ' ', http_path, ' ', outcome, ' ', detail)) TYPE ngrambf_v1(2, 2048, 3, 0) GRANULARITY 1;
ALTER TABLE security_events ADD INDEX IF NOT EXISTS idx_se_org_search lowerUTF8(concat(event_type, ' ', actor_email, ' ', outcome, ' ', detail)) TYPE ngrambf_v1(2, 2048, 3, 0) GRANULARITY 1;
