"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Graph-based authority delegation engine for Caracal Core.

This module provides the DelegationGraph class for managing authority
delegation as a directed graph across principal types (user, agent, service).
Authority flows downward: user → agent → service, with peer delegation
allowed between users and between agents.

Delegation direction rules:
  ✅ user → agent     (human grants authority to AI)
  ✅ user → service   (human grants authority to service)
  ✅ user → user      (peer: team lead delegates to member)
  ✅ agent → service   (AI delegates to service for task)
  ✅ agent → agent     (peer: AI-to-AI coordination)
  ❌ service → service (services are leaf executors)
  ❌ agent → user      (AI cannot grant authority to humans)
  ❌ service → user    (services cannot grant to humans)
  ❌ service → agent   (services cannot grant to AI)
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Optional, Set, Tuple
from uuid import UUID, uuid4

from sqlalchemy.orm import Session

from caracal.db.models import DelegationEdgeModel, ExecutionMandate, Principal
from caracal.logging_config import get_logger

logger = get_logger(__name__)


# ============================================================================
# Delegation Direction Rules
# ============================================================================

# (source_type, target_type) -> allowed
ALLOWED_DELEGATIONS: Dict[Tuple[str, str], bool] = {
    # Downward delegation (authority flows down)
    ("user", "agent"): True,
    ("user", "service"): True,
    ("agent", "service"): True,
    # Peer delegation (same level coordination)
    ("user", "user"): True,
    ("agent", "agent"): True,
    # Blocked: services are leaf executors, no upward delegation
    ("service", "service"): False,
    ("service", "agent"): False,
    ("service", "user"): False,
    ("agent", "user"): False,
}

# Human-readable descriptions for error messages
DELEGATION_BLOCK_REASONS: Dict[Tuple[str, str], str] = {
    ("service", "service"): "Services are leaf executors and cannot delegate to other services",
    ("service", "agent"): "Services cannot grant authority to AI agents",
    ("service", "user"): "Services cannot grant authority to users",
    ("agent", "user"): "AI agents cannot grant authority back to users",
}

# Valid principal types
VALID_PRINCIPAL_TYPES = {"user", "agent", "service"}


# ============================================================================
# Data Classes
# ============================================================================

@dataclass
class DelegationEdge:
    """Represents a directed authority delegation edge between principals."""
    edge_id: UUID
    source_mandate_id: UUID
    target_mandate_id: UUID
    source_principal_type: str
    target_principal_type: str
    delegation_type: str  # "hierarchical" | "peer"
    context_tags: List[str] = field(default_factory=list)
    granted_at: datetime = field(default_factory=datetime.utcnow)
    expires_at: Optional[datetime] = None
    revoked: bool = False
    revoked_at: Optional[datetime] = None
    metadata: Optional[dict] = None

    @classmethod
    def from_model(cls, model: DelegationEdgeModel) -> "DelegationEdge":
        """Create DelegationEdge from SQLAlchemy model."""
        return cls(
            edge_id=model.edge_id,
            source_mandate_id=model.source_mandate_id,
            target_mandate_id=model.target_mandate_id,
            source_principal_type=model.source_principal_type,
            target_principal_type=model.target_principal_type,
            delegation_type=model.delegation_type,
            context_tags=model.context_tags or [],
            granted_at=model.granted_at,
            expires_at=model.expires_at,
            revoked=model.revoked,
            revoked_at=model.revoked_at,
            metadata=model.edge_metadata,
        )


@dataclass
class DelegationGraphTopology:
    """Represents the full delegation graph topology."""
    nodes: List[dict]   # [{mandate_id, subject_id, principal_type, ...}]
    edges: List[dict]   # [{edge_id, source, target, type, ...}]
    stats: dict         # {total_nodes, total_edges, by_type, ...}


# ============================================================================
# DelegationGraph Engine
# ============================================================================

class DelegationGraph:
    """
    Manages authority delegation topology across principal types.

    Supports chains like:
      user → agent → service  (hierarchical)
      agent ↔ agent            (peer)
      user → service           (direct cross-type)

    Enforces delegation direction rules at edge creation time.
    """

    def __init__(self, db_session: Session):
        """
        Initialize DelegationGraph.

        Args:
            db_session: SQLAlchemy database session
        """
        self.db_session = db_session
        logger.info("DelegationGraph initialized")

    # ----------------------------------------------------------------
    # Direction Validation
    # ----------------------------------------------------------------

    @staticmethod
    def validate_delegation_direction(
        source_type: str,
        target_type: str,
    ) -> bool:
        """
        Check if delegation from source_type to target_type is allowed.

        Args:
            source_type: Principal type of the delegator (user/agent/service)
            target_type: Principal type of the delegate (user/agent/service)

        Returns:
            True if the delegation direction is allowed

        Raises:
            ValueError: If either type is invalid or delegation is blocked
        """
        if source_type not in VALID_PRINCIPAL_TYPES:
            raise ValueError(f"Invalid source principal type: '{source_type}'. Must be one of {VALID_PRINCIPAL_TYPES}")
        if target_type not in VALID_PRINCIPAL_TYPES:
            raise ValueError(f"Invalid target principal type: '{target_type}'. Must be one of {VALID_PRINCIPAL_TYPES}")

        key = (source_type, target_type)
        allowed = ALLOWED_DELEGATIONS.get(key, False)

        if not allowed:
            reason = DELEGATION_BLOCK_REASONS.get(
                key,
                f"Delegation from '{source_type}' to '{target_type}' is not allowed"
            )
            raise ValueError(reason)

        return True

    @staticmethod
    def get_delegation_type(source_type: str, target_type: str) -> str:
        """
        Determine if delegation is hierarchical or peer.

        Returns:
            'peer' if same principal types, 'hierarchical' otherwise
        """
        if source_type == target_type:
            return "peer"
        return "hierarchical"

    # ----------------------------------------------------------------
    # Edge Management
    # ----------------------------------------------------------------

    def add_edge(
        self,
        source_mandate_id: UUID,
        target_mandate_id: UUID,
        context_tags: Optional[List[str]] = None,
        expires_at: Optional[datetime] = None,
        metadata: Optional[dict] = None,
    ) -> DelegationEdge:
        """
        Add a delegation edge between two mandates.

        Validates:
        - Both mandates exist and are active
        - Delegation direction is allowed based on principal types
        - No duplicate active edge exists

        Args:
            source_mandate_id: The delegating mandate ID
            target_mandate_id: The receiving mandate ID
            context_tags: Optional context tags for dynamic filtering
            expires_at: Optional expiration for this edge
            metadata: Optional metadata

        Returns:
            Created DelegationEdge

        Raises:
            ValueError: If validation fails
            RuntimeError: If edge creation fails
        """
        logger.info(f"Adding delegation edge: {source_mandate_id} → {target_mandate_id}")

        # Get source mandate
        source_mandate = self.db_session.query(ExecutionMandate).filter(
            ExecutionMandate.mandate_id == source_mandate_id
        ).first()
        if not source_mandate:
            raise ValueError(f"Source mandate {source_mandate_id} not found")
        if source_mandate.revoked:
            raise ValueError(f"Source mandate {source_mandate_id} is revoked")

        # Get target mandate
        target_mandate = self.db_session.query(ExecutionMandate).filter(
            ExecutionMandate.mandate_id == target_mandate_id
        ).first()
        if not target_mandate:
            raise ValueError(f"Target mandate {target_mandate_id} not found")
        if target_mandate.revoked:
            raise ValueError(f"Target mandate {target_mandate_id} is revoked")

        # Get principal types
        source_principal = self.db_session.query(Principal).filter(
            Principal.principal_id == source_mandate.subject_id
        ).first()
        target_principal = self.db_session.query(Principal).filter(
            Principal.principal_id == target_mandate.subject_id
        ).first()

        if not source_principal:
            raise ValueError(f"Source principal {source_mandate.subject_id} not found")
        if not target_principal:
            raise ValueError(f"Target principal {target_mandate.subject_id} not found")

        source_type = source_principal.principal_type
        target_type = target_principal.principal_type

        # Validate delegation direction
        self.validate_delegation_direction(source_type, target_type)

        # Check for duplicate active edge
        existing_edge = self.db_session.query(DelegationEdgeModel).filter(
            DelegationEdgeModel.source_mandate_id == source_mandate_id,
            DelegationEdgeModel.target_mandate_id == target_mandate_id,
            DelegationEdgeModel.revoked == False,
        ).first()
        if existing_edge:
            raise ValueError(
                f"Active delegation edge already exists between "
                f"{source_mandate_id} and {target_mandate_id}"
            )

        # Determine delegation type
        delegation_type = self.get_delegation_type(source_type, target_type)

        # Create edge
        edge_id = uuid4()
        edge_model = DelegationEdgeModel(
            edge_id=edge_id,
            source_mandate_id=source_mandate_id,
            target_mandate_id=target_mandate_id,
            source_principal_type=source_type,
            target_principal_type=target_type,
            delegation_type=delegation_type,
            context_tags=context_tags or [],
            granted_at=datetime.utcnow(),
            expires_at=expires_at,
            revoked=False,
            edge_metadata=metadata,
        )

        try:
            self.db_session.add(edge_model)
            self.db_session.flush()
            logger.info(
                f"Delegation edge {edge_id} created: "
                f"{source_type}({source_mandate_id}) → {target_type}({target_mandate_id}) "
                f"[{delegation_type}]"
            )
        except Exception as e:
            self.db_session.rollback()
            raise RuntimeError(f"Failed to create delegation edge: {e}")

        return DelegationEdge.from_model(edge_model)

    def revoke_edge(self, edge_id: UUID, reason: Optional[str] = None) -> None:
        """
        Revoke a single delegation edge.

        Args:
            edge_id: The edge ID to revoke
            reason: Optional reason for revocation

        Raises:
            ValueError: If edge not found or already revoked
        """
        edge = self.db_session.query(DelegationEdgeModel).filter(
            DelegationEdgeModel.edge_id == edge_id
        ).first()

        if not edge:
            raise ValueError(f"Delegation edge {edge_id} not found")
        if edge.revoked:
            raise ValueError(f"Delegation edge {edge_id} is already revoked")

        edge.revoked = True
        edge.revoked_at = datetime.utcnow()
        if reason:
            edge.edge_metadata = edge.edge_metadata or {}
            edge.edge_metadata["revocation_reason"] = reason

        try:
            self.db_session.flush()
            logger.info(f"Delegation edge {edge_id} revoked")
        except Exception as e:
            self.db_session.rollback()
            raise RuntimeError(f"Failed to revoke delegation edge: {e}")

    def revoke_cascade(self, mandate_id: UUID, reason: Optional[str] = None) -> int:
        """
        Revoke all edges originating from a mandate, recursively.

        Args:
            mandate_id: The mandate whose outgoing edges are revoked
            reason: Optional reason for revocation

        Returns:
            Total number of edges revoked
        """
        logger.info(f"Cascade revoking edges from mandate {mandate_id}")
        revoked_count = 0

        # Get all active outgoing edges
        outgoing_edges = self.db_session.query(DelegationEdgeModel).filter(
            DelegationEdgeModel.source_mandate_id == mandate_id,
            DelegationEdgeModel.revoked == False,
        ).all()

        for edge in outgoing_edges:
            edge.revoked = True
            edge.revoked_at = datetime.utcnow()
            edge.edge_metadata = edge.edge_metadata or {}
            edge.edge_metadata["revocation_reason"] = reason or f"Cascade from mandate {mandate_id}"
            revoked_count += 1

            # Recursively revoke from target
            revoked_count += self.revoke_cascade(edge.target_mandate_id, reason)

        if revoked_count > 0:
            try:
                self.db_session.flush()
            except Exception as e:
                self.db_session.rollback()
                raise RuntimeError(f"Failed to cascade revoke: {e}")

        logger.info(f"Cascade revocation from {mandate_id}: {revoked_count} edges revoked")
        return revoked_count

    # ----------------------------------------------------------------
    # Graph Queries
    # ----------------------------------------------------------------

    def get_authority_sources(
        self,
        mandate_id: UUID,
        active_only: bool = True,
    ) -> List[DelegationEdge]:
        """
        Get all edges granting authority TO this mandate.

        Args:
            mandate_id: The mandate ID to query
            active_only: Only return non-revoked, non-expired edges

        Returns:
            List of DelegationEdge granting authority to this mandate
        """
        query = self.db_session.query(DelegationEdgeModel).filter(
            DelegationEdgeModel.target_mandate_id == mandate_id,
        )

        if active_only:
            query = query.filter(DelegationEdgeModel.revoked == False)
            now = datetime.utcnow()
            query = query.filter(
                (DelegationEdgeModel.expires_at == None) |
                (DelegationEdgeModel.expires_at > now)
            )

        return [DelegationEdge.from_model(e) for e in query.all()]

    def get_delegated_targets(
        self,
        mandate_id: UUID,
        active_only: bool = True,
    ) -> List[DelegationEdge]:
        """
        Get all edges delegating authority FROM this mandate.

        Args:
            mandate_id: The mandate ID to query
            active_only: Only return non-revoked, non-expired edges

        Returns:
            List of DelegationEdge delegated from this mandate
        """
        query = self.db_session.query(DelegationEdgeModel).filter(
            DelegationEdgeModel.source_mandate_id == mandate_id,
        )

        if active_only:
            query = query.filter(DelegationEdgeModel.revoked == False)
            now = datetime.utcnow()
            query = query.filter(
                (DelegationEdgeModel.expires_at == None) |
                (DelegationEdgeModel.expires_at > now)
            )

        return [DelegationEdge.from_model(e) for e in query.all()]

    def get_edges_by_type(
        self,
        source_type: Optional[str] = None,
        target_type: Optional[str] = None,
        active_only: bool = True,
    ) -> List[DelegationEdge]:
        """
        Get delegation edges filtered by principal types.

        Args:
            source_type: Filter by source principal type
            target_type: Filter by target principal type
            active_only: Only return non-revoked, non-expired edges

        Returns:
            List of matching DelegationEdge
        """
        query = self.db_session.query(DelegationEdgeModel)

        if source_type:
            query = query.filter(DelegationEdgeModel.source_principal_type == source_type)
        if target_type:
            query = query.filter(DelegationEdgeModel.target_principal_type == target_type)
        if active_only:
            query = query.filter(DelegationEdgeModel.revoked == False)

        return [DelegationEdge.from_model(e) for e in query.all()]

    def validate_authority_path(
        self,
        source_mandate_id: UUID,
        target_mandate_id: UUID,
        visited: Optional[Set[UUID]] = None,
    ) -> bool:
        """
        Check if a valid, non-revoked delegation path exists.

        Args:
            source_mandate_id: Starting mandate
            target_mandate_id: Ending mandate
            visited: Set of visited mandate IDs (for cycle detection)

        Returns:
            True if a valid path exists
        """
        if source_mandate_id == target_mandate_id:
            return True

        if visited is None:
            visited = set()

        if source_mandate_id in visited:
            return False  # Cycle detection
        visited.add(source_mandate_id)

        # Get active outgoing edges
        targets = self.get_delegated_targets(source_mandate_id, active_only=True)

        for edge in targets:
            if self.validate_authority_path(edge.target_mandate_id, target_mandate_id, visited):
                return True

        return False

    def get_effective_scope(self, mandate_id: UUID) -> dict:
        """
        Compute effective scope for a mandate considering all authority sources.

        If a mandate has multiple authority sources, the effective scope is the
        intersection of all sources' scopes (most restrictive).

        Args:
            mandate_id: The mandate to compute scope for

        Returns:
            Dict with 'resource_scope' and 'action_scope' lists
        """
        mandate = self.db_session.query(ExecutionMandate).filter(
            ExecutionMandate.mandate_id == mandate_id
        ).first()

        if not mandate:
            return {"resource_scope": [], "action_scope": []}

        # Get authority sources
        sources = self.get_authority_sources(mandate_id, active_only=True)

        if not sources:
            # No inbound delegation — use mandate's own scope
            return {
                "resource_scope": mandate.resource_scope or [],
                "action_scope": mandate.action_scope or [],
            }

        # Intersect scopes from all sources
        resource_sets = []
        action_sets = []

        for src_edge in sources:
            src_mandate = self.db_session.query(ExecutionMandate).filter(
                ExecutionMandate.mandate_id == src_edge.source_mandate_id
            ).first()
            if src_mandate and not src_mandate.revoked:
                resource_sets.append(set(src_mandate.resource_scope or []))
                action_sets.append(set(src_mandate.action_scope or []))

        if not resource_sets:
            return {
                "resource_scope": mandate.resource_scope or [],
                "action_scope": mandate.action_scope or [],
            }

        # Intersect all sources and also the mandate's own scope
        effective_resources = set(mandate.resource_scope or [])
        effective_actions = set(mandate.action_scope or [])

        for rs in resource_sets:
            effective_resources &= rs
        for as_ in action_sets:
            effective_actions &= as_

        return {
            "resource_scope": sorted(effective_resources),
            "action_scope": sorted(effective_actions),
        }

    def get_topology(
        self,
        root_mandate_id: Optional[UUID] = None,
        active_only: bool = True,
    ) -> DelegationGraphTopology:
        """
        Get the full delegation graph topology or a subgraph.

        Args:
            root_mandate_id: If provided, return subgraph from this root
            active_only: Only include non-revoked edges

        Returns:
            DelegationGraphTopology with nodes, edges, and stats
        """
        # Get edges
        edge_query = self.db_session.query(DelegationEdgeModel)
        if active_only:
            edge_query = edge_query.filter(DelegationEdgeModel.revoked == False)

        all_edges = edge_query.all()

        if root_mandate_id:
            # BFS to find reachable edges from root
            reachable = set()
            queue = [root_mandate_id]
            visited_mandates = set()

            while queue:
                current = queue.pop(0)
                if current in visited_mandates:
                    continue
                visited_mandates.add(current)
                reachable.add(current)

                for edge in all_edges:
                    if edge.source_mandate_id == current:
                        queue.append(edge.target_mandate_id)
                        reachable.add(edge.target_mandate_id)

            all_edges = [e for e in all_edges if e.source_mandate_id in reachable or e.target_mandate_id in reachable]

        # Collect unique mandate IDs
        mandate_ids = set()
        for e in all_edges:
            mandate_ids.add(e.source_mandate_id)
            mandate_ids.add(e.target_mandate_id)

        # Build nodes
        nodes = []
        by_type_count = {"user": 0, "agent": 0, "service": 0}
        for mid in mandate_ids:
            mandate = self.db_session.query(ExecutionMandate).filter(
                ExecutionMandate.mandate_id == mid
            ).first()
            if mandate:
                principal = self.db_session.query(Principal).filter(
                    Principal.principal_id == mandate.subject_id
                ).first()
                ptype = principal.principal_type if principal else "unknown"
                by_type_count[ptype] = by_type_count.get(ptype, 0) + 1
                nodes.append({
                    "mandate_id": str(mid),
                    "subject_id": str(mandate.subject_id),
                    "subject_name": principal.name if principal else "unknown",
                    "principal_type": ptype,
                    "resource_scope": mandate.resource_scope,
                    "action_scope": mandate.action_scope,
                    "active": not mandate.revoked,
                    "valid_from": mandate.valid_from.isoformat() if mandate.valid_from else None,
                    "valid_until": mandate.valid_until.isoformat() if mandate.valid_until else None,
                })

        # Build edges
        edges_out = []
        by_delegation_type = {"hierarchical": 0, "peer": 0}
        for e in all_edges:
            dtype = e.delegation_type or "hierarchical"
            by_delegation_type[dtype] = by_delegation_type.get(dtype, 0) + 1
            edges_out.append({
                "edge_id": str(e.edge_id),
                "source_mandate_id": str(e.source_mandate_id),
                "target_mandate_id": str(e.target_mandate_id),
                "source_principal_type": e.source_principal_type,
                "target_principal_type": e.target_principal_type,
                "delegation_type": dtype,
                "context_tags": e.context_tags or [],
                "granted_at": e.granted_at.isoformat() if e.granted_at else None,
                "expires_at": e.expires_at.isoformat() if e.expires_at else None,
                "revoked": e.revoked,
            })

        stats = {
            "total_nodes": len(nodes),
            "total_edges": len(edges_out),
            "nodes_by_type": by_type_count,
            "edges_by_delegation_type": by_delegation_type,
        }

        return DelegationGraphTopology(nodes=nodes, edges=edges_out, stats=stats)

    def get_chain_details(
        self,
        root_mandate_id: UUID,
        active_only: bool = True,
    ) -> dict:
        """
        Build a detailed delegation chain view rooted at a mandate.

        The resulting structure is optimized for presentation in CLI/TUI and
        includes depth, branching, leaf nodes, and per-node validity metadata.

        Args:
            root_mandate_id: Root mandate of the delegation chain
            active_only: Only include active (non-revoked, non-expired) edges

        Returns:
            Dict with keys: root_mandate_id, chain, edges, stats
        """
        now = datetime.utcnow()
        topology = self.get_topology(root_mandate_id=root_mandate_id, active_only=active_only)

        node_by_id = {n["mandate_id"]: n for n in topology.nodes}
        if str(root_mandate_id) not in node_by_id:
            raise ValueError(f"Root mandate {root_mandate_id} not found in delegation graph")

        out_adj: Dict[str, List[str]] = {}
        in_adj: Dict[str, List[str]] = {}
        for edge in topology.edges:
            src = edge["source_mandate_id"]
            tgt = edge["target_mandate_id"]
            out_adj.setdefault(src, []).append(tgt)
            in_adj.setdefault(tgt, []).append(src)

        root_id = str(root_mandate_id)
        depth_map: Dict[str, int] = {root_id: 0}
        path_count: Dict[str, int] = {root_id: 1}
        queue = [root_id]
        visited_bfs: Set[str] = set()

        while queue:
            current = queue.pop(0)
            if current in visited_bfs:
                continue
            visited_bfs.add(current)
            current_depth = depth_map[current]

            for child in out_adj.get(current, []):
                if child not in depth_map or depth_map[child] > current_depth + 1:
                    depth_map[child] = current_depth + 1
                path_count[child] = path_count.get(child, 0) + path_count.get(current, 0)
                queue.append(child)

        reachable_nodes = [nid for nid in depth_map.keys() if nid in node_by_id]

        cycle_detected = False
        temp_mark: Set[str] = set()
        perm_mark: Set[str] = set()

        def _visit(node_id: str) -> None:
            nonlocal cycle_detected
            if node_id in perm_mark or cycle_detected:
                return
            if node_id in temp_mark:
                cycle_detected = True
                return
            temp_mark.add(node_id)
            for nxt in out_adj.get(node_id, []):
                if nxt in depth_map:
                    _visit(nxt)
            temp_mark.remove(node_id)
            perm_mark.add(node_id)

        _visit(root_id)

        chain_rows = []
        for node_id in sorted(reachable_nodes, key=lambda nid: (depth_map[nid], nid)):
            node = node_by_id[node_id]
            valid_until_raw = node.get("valid_until")
            is_expired = False
            if valid_until_raw:
                try:
                    is_expired = datetime.fromisoformat(valid_until_raw) <= now
                except Exception:
                    is_expired = False

            inbound = in_adj.get(node_id, [])
            outbound = out_adj.get(node_id, [])
            chain_rows.append({
                "mandate_id": node_id,
                "subject_id": node.get("subject_id"),
                "subject_name": node.get("subject_name"),
                "principal_type": node.get("principal_type"),
                "depth": depth_map[node_id],
                "parent_count": len(inbound),
                "child_count": len(outbound),
                "path_count": path_count.get(node_id, 0),
                "delegation_depth": None,
                "active": bool(node.get("active", False)),
                "expired": is_expired,
                "valid_from": node.get("valid_from"),
                "valid_until": valid_until_raw,
                "resource_scope": node.get("resource_scope") or [],
                "action_scope": node.get("action_scope") or [],
            })

        # Backfill delegation_depth from mandate records where possible.
        for row in chain_rows:
            mandate = self.db_session.query(ExecutionMandate).filter(
                ExecutionMandate.mandate_id == UUID(row["mandate_id"])
            ).first()
            row["delegation_depth"] = int(mandate.delegation_depth or 0) if mandate else 0

        branch_nodes = sum(1 for nid in reachable_nodes if len(out_adj.get(nid, [])) > 1)
        leaf_nodes = sum(1 for nid in reachable_nodes if len(out_adj.get(nid, [])) == 0)
        max_depth = max((depth_map[nid] for nid in reachable_nodes), default=0)

        chain_edge_set = {
            e["edge_id"]
            for e in topology.edges
            if e["source_mandate_id"] in depth_map and e["target_mandate_id"] in depth_map
        }
        chain_edges = [e for e in topology.edges if e["edge_id"] in chain_edge_set]

        is_valid = bool(chain_rows) and not cycle_detected and all(
            r["active"] and not r["expired"] for r in chain_rows
        )

        return {
            "root_mandate_id": root_id,
            "chain": chain_rows,
            "edges": chain_edges,
            "stats": {
                "total_nodes": len(chain_rows),
                "total_edges": len(chain_edges),
                "max_depth": max_depth,
                "branch_nodes": branch_nodes,
                "leaf_nodes": leaf_nodes,
                "has_cycles": cycle_detected,
                "is_valid": is_valid,
            },
        }

    def check_delegation_chain(self, mandate_id: UUID) -> bool:
        """
        Validate delegation chain for a mandate via the graph.

        Checks all inbound authority edges are active, their source mandates
        are valid (not revoked, not expired), and recursively validates up
        the chain.

        Args:
            mandate_id: The mandate to validate

        Returns:
            True if the delegation chain is valid
        """
        sources = self.get_authority_sources(mandate_id, active_only=True)

        # No inbound edges means this is a root mandate — valid
        if not sources:
            return True

        now = datetime.utcnow()

        for edge in sources:
            # Check source mandate is valid
            source_mandate = self.db_session.query(ExecutionMandate).filter(
                ExecutionMandate.mandate_id == edge.source_mandate_id
            ).first()

            if not source_mandate:
                logger.warning(f"Source mandate {edge.source_mandate_id} not found in chain")
                return False

            if source_mandate.revoked:
                logger.warning(f"Source mandate {edge.source_mandate_id} is revoked")
                return False

            if now > source_mandate.valid_until:
                logger.warning(f"Source mandate {edge.source_mandate_id} is expired")
                return False

            if now < source_mandate.valid_from:
                logger.warning(f"Source mandate {edge.source_mandate_id} is not yet valid")
                return False

            # Recursively validate up the chain
            if not self.check_delegation_chain(edge.source_mandate_id):
                return False

        return True
