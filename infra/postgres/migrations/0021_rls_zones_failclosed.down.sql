-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Reverts to the NULL/empty bypass policy from 0016_rls_zones.

DO $$
DECLARE
    t TEXT;
    tables TEXT[] := ARRAY[
        'providers',
        'applications',
        'sessions',
        'secrets',
        'delegated_grants',
        'policies',
        'policy_sets',
        'policy_set_bindings',
        'resources',
        'audit_events',
        'agent_sessions',
        'invitations',
        'teams',
        'delegation_edges',
        'agent_services',
        'agent_invocations',
        'gateway_resource_bindings',
        'resource_rate_limits',
        'step_up_challenges',
        'admin_audit_events',
        'admin_tokens',
        'delegation_graph_epochs'
    ];
BEGIN
    FOREACH t IN ARRAY tables LOOP
        EXECUTE format('DROP POLICY IF EXISTS zone_isolation ON %I', t);
        EXECUTE format(
            'CREATE POLICY zone_isolation ON %I '
            'USING ('
                'current_setting(''caracal.zone_id'', true) IS NULL '
                'OR current_setting(''caracal.zone_id'', true) = '''' '
                'OR zone_id = current_setting(''caracal.zone_id'', true)'
            ') '
            'WITH CHECK ('
                'current_setting(''caracal.zone_id'', true) IS NULL '
                'OR current_setting(''caracal.zone_id'', true) = '''' '
                'OR zone_id = current_setting(''caracal.zone_id'', true)'
            ')',
            t
        );
    END LOOP;
END
$$;
