"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Static topology graph for the Lynx Capital swarm, with grouping metadata per node.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class NodeDef:
    id: str
    role: str
    layer: str
    region: str | None
    parent_id: str | None
    ephemeral: bool
    count: int


@dataclass
class TopologyGraph:
    nodes: list[NodeDef] = field(default_factory=list)
    _by_id: dict[str, NodeDef] = field(default_factory=dict, repr=False)

    def add(self, node: NodeDef) -> None:
        self.nodes.append(node)
        self._by_id[node.id] = node

    def get(self, node_id: str) -> NodeDef | None:
        return self._by_id.get(node_id)

    def children_of(self, parent_id: str) -> list[NodeDef]:
        return [n for n in self.nodes if n.parent_id == parent_id]

    def by_layer(self, layer: str) -> list[NodeDef]:
        return [n for n in self.nodes if n.layer == layer]

    def by_region(self, region: str) -> list[NodeDef]:
        return [n for n in self.nodes if n.region == region]


def build_topology(regions: list[str], layer_cfg: list[dict]) -> TopologyGraph:
    """Build the static topology graph from config.

    layer_cfg is a list of dicts with keys: id, perRegion, ephemeral.
    regions is the ordered list of region ids (e.g. ["US","IN","DE","SG","BR"]).
    """
    graph = TopologyGraph()

    # Layer ordering determines parent assignment
    # finance-control is root; regional-orchestrators are its children.
    # All other layers' nodes are children of the regional-orchestrator
    # for their region.

    FC_ID = "fc-0"
    graph.add(NodeDef(
        id=FC_ID,
        role="finance-control",
        layer="finance-control",
        region=None,
        parent_id=None,
        ephemeral=False,
        count=1,
    ))

    # Build a lookup for layer config
    layer_map = {lc["id"]: lc for lc in layer_cfg}

    # Spawn regional orchestrators as children of FC
    ro_ids: dict[str, str] = {}
    for region in regions:
        ro_id = f"ro-{region.lower()}"
        ro_ids[region] = ro_id
        graph.add(NodeDef(
            id=ro_id,
            role="regional-orchestrator",
            layer="regional-orchestrator",
            region=region,
            parent_id=FC_ID,
            ephemeral=False,
            count=1,
        ))

    # Spawn remaining layers per region under their regional orchestrator
    WORKER_LAYERS = [
        "invoice-intake",
        "ledger-match",
        "policy-check",
        "route-optimization",
        "payment-execution",
        "audit",
        "exception",
    ]

    for layer_id in WORKER_LAYERS:
        lc = layer_map.get(layer_id)
        if not lc or lc["perRegion"] == 0:
            continue
        per_region = lc["perRegion"]
        ephemeral = lc.get("ephemeral", False)

        for region in regions:
            parent_id = ro_ids[region]
            if ephemeral:
                # Represent the entire ephemeral batch as a single group node
                node_id = f"{layer_id}-{region.lower()}-batch"
                graph.add(NodeDef(
                    id=node_id,
                    role=layer_id,
                    layer=layer_id,
                    region=region,
                    parent_id=parent_id,
                    ephemeral=True,
                    count=per_region,
                ))
            else:
                for i in range(per_region):
                    node_id = f"{layer_id}-{region.lower()}-{i}"
                    graph.add(NodeDef(
                        id=node_id,
                        role=layer_id,
                        layer=layer_id,
                        region=region,
                        parent_id=parent_id,
                        ephemeral=False,
                        count=1,
                    ))

    return graph
