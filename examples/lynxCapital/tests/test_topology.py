"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Topology structure tests: layer presence, per-region groupings, and node count bounds.
"""
from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.config import load_config
from app.orchestration.topology import build_topology

REQUIRED_LAYERS = [
    "finance-control",
    "regional-orchestrator",
    "invoice-intake",
    "ledger-match",
    "policy-check",
    "route-optimization",
    "payment-execution",
    "audit",
    "exception",
]


@pytest.fixture(scope="module")
def topology():
    cfg = load_config()
    regions = [r.id for r in cfg.regions]
    layer_cfg = [
        {"id": lc.id, "perRegion": lc.perRegion, "ephemeral": lc.ephemeral}
        for lc in cfg.agentLayers
    ]
    return build_topology(regions, layer_cfg), cfg


def test_all_required_layers_present(topology):
    graph, _ = topology
    layers_in_graph = {n.layer for n in graph.nodes}
    for layer in REQUIRED_LAYERS:
        assert layer in layers_in_graph, f"Layer {layer!r} missing from topology"


def test_single_finance_control_node(topology):
    graph, _ = topology
    fc_nodes = graph.by_layer("finance-control")
    assert len(fc_nodes) == 1, f"Expected 1 finance-control node, got {len(fc_nodes)}"
    assert fc_nodes[0].parent_id is None, "finance-control must be root (no parent)"


def test_regional_orchestrators_match_config(topology):
    graph, cfg = topology
    ro_nodes = graph.by_layer("regional-orchestrator")
    expected = len(cfg.regions)
    assert len(ro_nodes) == expected, (
        f"Expected {expected} regional-orchestrator nodes, got {len(ro_nodes)}"
    )
    ro_regions = {n.region for n in ro_nodes}
    config_regions = {r.id for r in cfg.regions}
    assert ro_regions == config_regions


def test_per_region_node_counts_match_config(topology):
    graph, cfg = topology
    layer_map = {lc.id: lc for lc in cfg.agentLayers}
    regions = [r.id for r in cfg.regions]

    for layer_id, lc in layer_map.items():
        if lc.perRegion == 0 or lc.ephemeral:
            continue
        for region in regions:
            nodes_in_region = [
                n for n in graph.by_layer(layer_id) if n.region == region
            ]
            assert len(nodes_in_region) == lc.perRegion, (
                f"Layer {layer_id!r} region {region!r}: "
                f"expected {lc.perRegion} nodes, got {len(nodes_in_region)}"
            )


def test_ephemeral_layers_are_batch_nodes(topology):
    graph, cfg = topology
    ephemeral_layers = {lc.id for lc in cfg.agentLayers if lc.ephemeral}
    for layer_id in ephemeral_layers:
        nodes = graph.by_layer(layer_id)
        for n in nodes:
            assert n.ephemeral, f"Node {n.id!r} in ephemeral layer {layer_id!r} is not marked ephemeral"


def test_every_non_root_has_valid_parent(topology):
    graph, _ = topology
    node_ids = {n.id for n in graph.nodes}
    for n in graph.nodes:
        if n.parent_id is None:
            assert n.layer == "finance-control", (
                f"Node {n.id!r} has no parent but is not finance-control"
            )
        else:
            assert n.parent_id in node_ids, (
                f"Node {n.id!r} references unknown parent {n.parent_id!r}"
            )


def test_worker_layers_parented_to_regional_orchestrators(topology):
    graph, _ = topology
    ro_ids = {n.id for n in graph.by_layer("regional-orchestrator")}
    non_root_non_ro_layers = [
        n for n in graph.nodes
        if n.layer not in ("finance-control", "regional-orchestrator")
    ]
    for n in non_root_non_ro_layers:
        assert n.parent_id in ro_ids, (
            f"Worker node {n.id!r} (layer={n.layer!r}) is not parented to a regional-orchestrator"
        )


def test_total_node_count_is_reasonable(topology):
    graph, cfg = topology
    n_regions = len(cfg.regions)
    n_nodes = len(graph.nodes)
    # 1 FC + N RO + at least 5 worker layers * N regions
    min_expected = 1 + n_regions + 5 * n_regions
    assert n_nodes >= min_expected, (
        f"Only {n_nodes} nodes in topology, expected at least {min_expected}"
    )
