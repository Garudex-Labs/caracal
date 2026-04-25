"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Graph-based authority delegation engine for Caracal Core.

This module provides the DelegationGraph class for managing authority
delegation as a directed graph across principal kinds.
Authority flows downward from human to orchestration and workers, then to services.

Delegation direction rules:
    ✅ human → orchestrator
    ✅ human → worker
    ✅ human → service
    ✅ orchestrator → worker
    ✅ orchestrator → service
    ✅ worker → service
    ✅ human ↔ human
    ✅ orchestrator ↔ orchestrator
    ✅ worker ↔ worker
    ❌ service → *
"""

from dataclasses import dataclass, field
from datetime import datetime
from fnmatch import fnmatchcase
from typing import Dict, List, Optional, Set, Tuple
from uuid import UUID, uuid4

from sqlalchemy.orm import Session

from caracal.db.models import DelegationEdgeModel, ExecutionMandate, Principal
from caracal.logging_config import get_logger

logger = get_logger(__name__)


# ============================================================================
# Delegation Direction Rules
# ============================================================================

# (source_kind, target_kind) -> allowed
ALLOWED_DELEGATIONS: Dict[Tuple[str, str], bool] = {
    # Downward delegation (authority flows down)
    ("human", "orchestrator"): True,
    ("human", "worker"): True,
    ("human", "service"): True,
    ("orchestrator", "worker"): True,
    ("orchestrator", "service"): True,
    ("worker", "service"): True,
    # Peer delegation (same level coordination)
    ("human", "human"): True,
    ("orchestrator", "orchestrator"): True,
    ("worker", "worker"): True,
    # Blocked: services are leaf executors, no upward delegation
    ("service", "service"): False,
    ("service", "worker"): False,
    ("service", "orchestrator"): False,
    ("service", "human"): False,
    ("worker", "human"): False,
    ("orchestrator", "human"): False,
    ("worker", "orchestrator"): False,
}

# Human-readable descriptions for error messages
DELEGATION_BLOCK_REASONS: Dict[Tuple[str, str], str] = {
    ("service", "service"): "Services are terminal executors and cannot delegate",
    ("service", "worker"): "Services cannot grant authority to worker principals",
    ("service", "orchestrator"): "Services cannot grant authority to orchestrator principals",
    ("service", "human"): "Services cannot grant authority to human principals",
    ("worker", "human"): "Worker principals cannot grant authority back to human principals",
    ("orchestrator", "human"): "Orchestrator principals cannot grant authority back to human principals",
    ("worker", "orchestrator"): "Worker principals cannot elevate authority to orchestrators",
}

# Valid principal kinds
VALID_PRINCIPAL_KINDS = {"human", "orchestrator", "worker", "service"}


# ============================================================================
# Data Classes
# ============================================================================

@dataclass
class DelegationEdge:
    """Represents a directed authority delegation edge between principals."""
    edge_id: UUID
    source_mandate_id: UUID
    target_mandate_id: UUID
    source_principal_kind: str
    target_principal_kind: str
    delegation_type: str  # "directed" | "peer"
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
            source_principal_kind=model.source_principal_kind,
            target_principal_kind=model.target_principal_kind,
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
    nodes: List[dict]   # [{mandate_id, subject_id, principal_kind, ...}]
    edges: List[dict]   # [{edge_id, source, target, type, ...}]
    stats: dict         # {total_nodes, total_edges, by_type, ...}


# ============================================================================
# DelegationGraph Engine
# ============================================================================

class DelegationGraph:
    """
    Manages authority delegation topology across principal kinds.

    Supports paths like:
            human → orchestrator → worker → service  (directed)
            worker ↔ worker                            (peer)
            human → service                            (direct cross-kind)

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

    @staticmethod
    def _is_mandate_active(mandate: ExecutionMandate, now: Optional[datetime] = None) -> bool:
        """Return True when mandate is currently active and not revoked."""
        if mandate is None:
            return False
        current_time = now or datetime.utcnow()
        if mandate.revoked:
            return False
        if mandate.valid_from and mandate.valid_from > current_time:
            return False
        if mandate.valid_until and mandate.valid_until <= current_time:
            return False
        return True

    def _get_mandate(self, mandate_id: UUID) -> Optional[ExecutionMandate]:
        """Load mandate by ID."""
        return self.db_session.query(ExecutionMandate).filter(
            ExecutionMandate.mandate_id == mandate_id
        ).first()

    @staticmethod
    def _scope_is_covered_by_union(
        requested_scope: Optional[List[str]],
        source_scopes: List[List[str]],
    ) -> bool:
        """Return True when every requested entry is matched by at least one source entry."""
        flattened_patterns = [
            pattern
            for scope in source_scopes
            for pattern in (scope or [])
        ]
        for requested_entry in requested_scope or []:
            if not any(fnmatchcase(requested_entry, pattern) for pattern in flattened_patterns):
                return False
        return True

    @staticmethod
    def _resolve_edge_expiration(
        *,
        source_mandate: ExecutionMandate,
        target_mandate: ExecutionMandate,
        requested_expires_at: Optional[datetime],
    ) -> Optional[datetime]:
        """Cap edge lifetime so it never outlives either connected mandate."""
        candidate_expirations = [
            expiry
            for expiry in (
                requested_expires_at,
                getattr(source_mandate, "valid_until", None),
                getattr(target_mandate, "valid_until", None),
            )
            if expiry is not None
        ]
        if not candidate_expirations:
            return None
        return min(candidate_expirations)

    def _validate_non_amplifying_target_scope(
        self,
        *,
        source_mandate: ExecutionMandate,
        target_mandate: ExecutionMandate,
    ) -> None:
        """Ensure target scope does not exceed the union of active authority sources."""
        inbound_source_mandates: list[ExecutionMandate] = [source_mandate]

        for edge in self.get_authority_sources(target_mandate.mandate_id, active_only=True):
            if edge.source_mandate_id == source_mandate.mandate_id:
                continue
            existing_source = self._get_mandate(edge.source_mandate_id)
            if existing_source is None or not self._is_mandate_active(existing_source):
                continue
            inbound_source_mandates.append(existing_source)

        resource_sources = [
            list(mandate.resource_scope or [])
            for mandate in inbound_source_mandates
        ]
        action_sources = [
            list(mandate.action_scope or [])
            for mandate in inbound_source_mandates
        ]

        if not self._scope_is_covered_by_union(target_mandate.resource_scope, resource_sources):
            raise ValueError(
                "Delegation edge would amplify target resource scope beyond the active source union"
            )
        if not self._scope_is_covered_by_union(target_mandate.action_scope, action_sources):
            raise ValueError(
                "Delegation edge would amplify target action scope beyond the active source union"
            )

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
            source_type: Principal kind of the delegator
            target_type: Principal kind of the delegate

        Returns:
            True if the delegation direction is allowed

        Raises:
            ValueError: If either type is invalid or delegation is blocked
        """
        if source_type not in VALID_PRINCIPAL_KINDS:
            raise ValueError(f"Invalid source principal kind: '{source_type}'. Must be one of {VALID_PRINCIPAL_KINDS}")
        if target_type not in VALID_PRINCIPAL_KINDS:
            raise ValueError(f"Invalid target principal kind: '{target_type}'. Must be one of {VALID_PRINCIPAL_KINDS}")

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
        Determine if delegation is directed or peer.

        Returns:
            'peer' if same principal types, 'directed' otherwise
        """
        if source_type == target_type:
            return "peer"
        return "directed"

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
        - Graph expansion does not introduce cycles or scope amplification

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

        source_mandate = self._get_mandate(source_mandate_id)
        if not source_mandate:
            raise ValueError(f"Source mandate {source_mandate_id} not found")
        if not self._is_mandate_active(source_mandate):
            raise ValueError(f"Source mandate {source_mandate_id} is not active")

        target_mandate = self._get_mandate(target_mandate_id)
        if not target_mandate:
            raise ValueError(f"Target mandate {target_mandate_id} not found")
        if not self._is_mandate_active(target_mandate):
            raise ValueError(f"Target mandate {target_mandate_id} is not active")

        source_depth = int(source_mandate.network_distance or 0)
        target_depth = int(target_mandate.network_distance or 0)
        if target_depth != source_depth - 1:
            raise ValueError(
                "Target mandate network_distance mismatch: "
                f"target depth {target_depth} must be exactly source depth {source_depth} - 1"
            )

        if source_mandate_id == target_mandate_id:
            raise ValueError("Delegation cycle detected: source and target mandates are identical")

        # Prevent cycles by denying any edge when a reverse active path exists.
        # The seed check avoids recursive traversal when the target has no outgoing edges.
        reverse_path_seed = self.db_session.query(DelegationEdgeModel).filter(
            DelegationEdgeModel.source_mandate_id == target_mandate_id,
            DelegationEdgeModel.revoked == False,
        ).first()
        if reverse_path_seed and self.validate_authority_path(target_mandate_id, source_mandate_id):
            raise ValueError(
                "Delegation cycle detected: "
                f"adding {source_mandate_id} -> {target_mandate_id} creates a cycle"
            )

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

        source_type = source_principal.principal_kind
        target_type = target_principal.principal_kind

        # Validate delegation direction
        self.validate_delegation_direction(source_type, target_type)
        self._validate_non_amplifying_target_scope(
            source_mandate=source_mandate,
            target_mandate=target_mandate,
        )

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

        edge_id = uuid4()
        edge_model = DelegationEdgeModel(
            edge_id=edge_id,
            source_mandate_id=source_mandate_id,
            target_mandate_id=target_mandate_id,
            source_principal_kind=source_type,
            target_principal_kind=target_type,
            delegation_type=delegation_type,
            context_tags=context_tags or [],
            granted_at=datetime.utcnow(),
            expires_at=self._resolve_edge_expiration(
                source_mandate=source_mandate,
                target_mandate=target_mandate,
                requested_expires_at=expires_at,
            ),
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

    def revoke_cascade(
        self,
        mandate_id: UUID,
        reason: Optional[str] = None,
        visited: Optional[Set[UUID]] = None,
    ) -> int:
        """
        Revoke all edges originating from a mandate, recursively.

        Args:
            mandate_id: The mandate whose outgoing edges are revoked
            reason: Optional reason for revocation

        Returns:
            Total number of edges revoked
        """
        logger.info(f"Cascade revoking edges from mandate {mandate_id}")
        if visited is None:
            visited = set()
        if mandate_id in visited:
            return 0
        visited.add(mandate_id)
        revoked_count = 0

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
            revoked_count += self.revoke_cascade(edge.target_mandate_id, reason, visited)

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
        Get delegation edges filtered by principal kinds.

        Args:
            source_type: Filter by source principal kind
            target_type: Filter by target principal kind
            active_only: Only return non-revoked, non-expired edges

        Returns:
            List of matching DelegationEdge
        """
        query = self.db_session.query(DelegationEdgeModel)

        if source_type:
            query = query.filter(DelegationEdgeModel.source_principal_kind == source_type)
        if target_type:
            query = query.filter(DelegationEdgeModel.target_principal_kind == target_type)
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
            source_mandate = self._get_mandate(source_mandate_id)
            return self._is_mandate_active(source_mandate)

        if visited is None:
            visited = set()

        if source_mandate_id in visited:
            return False  # Cycle detection
        visited.add(source_mandate_id)

        # Fail closed when either endpoint is not active.
        source_mandate = self._get_mandate(source_mandate_id)
        target_mandate = self._get_mandate(target_mandate_id)
        if not self._is_mandate_active(source_mandate):
            return False
        if not self._is_mandate_active(target_mandate):
            return False

        targets = self.get_delegated_targets(source_mandate_id, active_only=True)

        for edge in targets:
            edge_target = self._get_mandate(edge.target_mandate_id)
            if not self._is_mandate_active(edge_target):
                continue
            if self.validate_authority_path(edge.target_mandate_id, target_mandate_id, visited):
                return True

        return False

    def get_effective_scope(self, mandate_id: UUID) -> dict:
        """
        Compute effective scope for a mandate considering all authority sources.

        If a mandate has multiple authority sources, the effective scope is the
        subset of the mandate's own scope that is covered by the active source union.

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

        sources = self.get_authority_sources(mandate_id, active_only=True)

        if not sources:
            # No inbound delegation — use mandate's own scope
            return {
                "resource_scope": mandate.resource_scope or [],
                "action_scope": mandate.action_scope or [],
            }

        source_resource_scopes: list[list[str]] = []
        source_action_scopes: list[list[str]] = []

        for src_edge in sources:
            src_mandate = self.db_session.query(ExecutionMandate).filter(
                ExecutionMandate.mandate_id == src_edge.source_mandate_id
            ).first()
            if src_mandate and not src_mandate.revoked:
                source_resource_scopes.append(list(src_mandate.resource_scope or []))
                source_action_scopes.append(list(src_mandate.action_scope or []))

        if not source_resource_scopes and not source_action_scopes:
            return {
                "resource_scope": mandate.resource_scope or [],
                "action_scope": mandate.action_scope or [],
            }

        effective_resources = [
            scope_entry
            for scope_entry in (mandate.resource_scope or [])
            if self._scope_is_covered_by_union([scope_entry], source_resource_scopes)
        ]
        effective_actions = [
            scope_entry
            for scope_entry in (mandate.action_scope or [])
            if self._scope_is_covered_by_union([scope_entry], source_action_scopes)
        ]

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

        nodes = []
        by_type_count = {"human": 0, "orchestrator": 0, "worker": 0, "service": 0}
        for mid in mandate_ids:
            mandate = self.db_session.query(ExecutionMandate).filter(
                ExecutionMandate.mandate_id == mid
            ).first()
            if mandate:
                principal = self.db_session.query(Principal).filter(
                    Principal.principal_id == mandate.subject_id
                ).first()
                ptype = principal.principal_kind if principal else "unknown"
                by_type_count[ptype] = by_type_count.get(ptype, 0) + 1
                nodes.append({
                    "mandate_id": str(mid),
                    "subject_id": str(mandate.subject_id),
                    "subject_name": principal.name if principal else "unknown",
                    "principal_kind": ptype,
                    "resource_scope": mandate.resource_scope,
                    "action_scope": mandate.action_scope,
                    "active": not mandate.revoked,
                    "valid_from": mandate.valid_from.isoformat() if mandate.valid_from else None,
                    "valid_until": mandate.valid_until.isoformat() if mandate.valid_until else None,
                })

        edges_out = []
        by_delegation_type = {"directed": 0, "peer": 0}
        for e in all_edges:
            dtype = e.delegation_type or "directed"
            by_delegation_type[dtype] = by_delegation_type.get(dtype, 0) + 1
            edges_out.append({
                "edge_id": str(e.edge_id),
                "source_mandate_id": str(e.source_mandate_id),
                "target_mandate_id": str(e.target_mandate_id),
                "source_principal_kind": e.source_principal_kind,
                "target_principal_kind": e.target_principal_kind,
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

    def get_path_details(
        self,
        root_mandate_id: UUID,
        active_only: bool = True,
    ) -> dict:
        """
        Build a detailed delegation path view rooted at a mandate.

        The resulting structure is optimized for presentation in CLI/TUI and
        includes depth, branching, leaf nodes, and per-node validity metadata.

        Args:
            root_mandate_id: Root mandate of the delegation path
            active_only: Only include active (non-revoked, non-expired) edges

        Returns:
            Dict with keys: root_mandate_id, path, edges, stats
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
        distance_map: Dict[str, int] = {root_id: 0}
        path_count: Dict[str, int] = {root_id: 1}
        queue = [root_id]
        visited_bfs: Set[str] = set()

        while queue:
            current = queue.pop(0)
            if current in visited_bfs:
                continue
            visited_bfs.add(current)
            current_distance = distance_map[current]

            for target in out_adj.get(current, []):
                if target not in distance_map or distance_map[target] > current_distance + 1:
                    distance_map[target] = current_distance + 1
                path_count[target] = path_count.get(target, 0) + path_count.get(current, 0)
                queue.append(target)

        reachable_nodes = [nid for nid in distance_map.keys() if nid in node_by_id]

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
                if nxt in distance_map:
                    _visit(nxt)
            temp_mark.remove(node_id)
            perm_mark.add(node_id)

        _visit(root_id)

        path_rows = []
        for node_id in sorted(reachable_nodes, key=lambda nid: (distance_map[nid], nid)):
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
            path_rows.append({
                "mandate_id": node_id,
                "subject_id": node.get("subject_id"),
                "subject_name": node.get("subject_name"),
                "principal_kind": node.get("principal_kind"),
                "distance": distance_map[node_id],
                "source_count": len(inbound),
                "target_count": len(outbound),
                "path_count": path_count.get(node_id, 0),
                "network_distance": None,
                "active": bool(node.get("active", False)),
                "expired": is_expired,
                "valid_from": node.get("valid_from"),
                "valid_until": valid_until_raw,
                "resource_scope": node.get("resource_scope") or [],
                "action_scope": node.get("action_scope") or [],
            })

        # Backfill network_distance from mandate records where possible.
        for row in path_rows:
            mandate = self.db_session.query(ExecutionMandate).filter(
                ExecutionMandate.mandate_id == UUID(row["mandate_id"])
            ).first()
            row["network_distance"] = int(mandate.network_distance or 0) if mandate else 0

        branch_nodes = sum(1 for nid in reachable_nodes if len(out_adj.get(nid, [])) > 1)
        leaf_nodes = sum(1 for nid in reachable_nodes if len(out_adj.get(nid, [])) == 0)
        max_distance = max((distance_map[nid] for nid in reachable_nodes), default=0)

        path_edge_set = {
            e["edge_id"]
            for e in topology.edges
            if e["source_mandate_id"] in distance_map and e["target_mandate_id"] in distance_map
        }
        path_edges = [e for e in topology.edges if e["edge_id"] in path_edge_set]

        is_valid = bool(path_rows) and not cycle_detected and all(
            r["active"] and not r["expired"] for r in path_rows
        )

        return {
            "root_mandate_id": root_id,
            "path": path_rows,
            "edges": path_edges,
            "stats": {
                "total_nodes": len(path_rows),
                "total_edges": len(path_edges),
                "max_distance": max_distance,
                "branch_nodes": branch_nodes,
                "leaf_nodes": leaf_nodes,
                "has_cycles": cycle_detected,
                "is_valid": is_valid,
            },
        }

    def check_delegation_path(self, mandate_id: UUID) -> bool:
        """
        Validate delegation path for a mandate via the graph.

        Checks all inbound authority edges are active, their source mandates
        are valid (not revoked, not expired), and recursively validates up
        the path.

        Args:
            mandate_id: The mandate to validate

        Returns:
            True if the delegation path is valid
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
                logger.warning(f"Source mandate {edge.source_mandate_id} not found in path")
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

            # Recursively validate up the path
            if not self.check_delegation_path(edge.source_mandate_id):
                return False

        return True
