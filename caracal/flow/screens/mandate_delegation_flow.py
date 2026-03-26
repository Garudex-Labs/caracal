"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal Flow Mandate Delegation Screen — Graph-Based Model.

Mandate delegation management flows:
- Show delegation graph with rich tree visualization
- Delegate mandate with scope subset validation
- Peer-to-peer delegation
- View delegation edges for a principal
- Revoke delegation edge with cascade option
"""

from typing import Optional, List, Dict, Any
from uuid import UUID

from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.tree import Tree

from caracal.flow.components.menu import show_menu
from caracal.flow.components.prompt import FlowPrompt
from caracal.flow.theme import Colors, Icons
from caracal.flow.state import FlowState, RecentAction
from caracal.logging_config import get_logger

logger = get_logger(__name__)


class MandateDelegationFlow:
    """Mandate delegation management flow (graph-based)."""
    
    def __init__(self, console: Optional[Console] = None, state: Optional[FlowState] = None):
        self.console = console or Console()
        self.state = state
        self.prompt = FlowPrompt(self.console)
    
    def run(self) -> None:
        """Run the mandate delegation management flow."""
        while True:
            self.console.clear()
            
            action = show_menu(
                title="Mandate Delegation",
                items=[
                    ("graph", "Show Delegation Graph", "Visualize mandate delegation topology"),
                    ("delegate", "Delegate Mandate", "Create a delegation edge"),
                    ("peer", "Peer Delegate", "Create peer-to-peer delegation"),
                    ("list", "View Delegation Edges", "List edges for a principal"),
                    ("revoke", "Revoke Delegation Edge", "Revoke a delegation edge"),
                ],
                subtitle="Manage mandate delegation graph",
            )
            
            if action is None:
                break
            
            self.console.clear()
            
            if action == "graph":
                self.show_delegation_graph()
            elif action == "delegate":
                self.delegate_mandate()
            elif action == "peer":
                self.peer_delegate()
            elif action == "list":
                self.view_delegation_edges()
            elif action == "revoke":
                self.revoke_delegation()
            
            self.console.print()
            self.console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
            input()
    
    def show_delegation_graph(self) -> None:
        """Show delegation graph with tree visualization."""
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]Visualize mandate delegation graph topology[/]",
            title=f"[bold {Colors.INFO}]Delegation Graph[/]",
            border_style=Colors.PRIMARY,
        ))
        self.console.print()
        
        try:
            from caracal.db.connection import get_db_manager
            from caracal.db.models import ExecutionMandate
            from caracal.core.delegation_graph import DelegationGraph
            
            db_manager = get_db_manager()
            
            with db_manager.session_scope() as db_session:
                # Get all mandates
                mandates = db_session.query(ExecutionMandate).all()
                
                if not mandates:
                    self.console.print(f"  [{Colors.DIM}]No mandates exist.[/]")
                    return
                
                # Select a mandate to show its graph
                items = [(str(m.mandate_id), f"Subject {str(m.subject_id)[:8]}...") for m in mandates]
                mandate_id_str = self.prompt.uuid("Mandate ID (Tab for suggestions)", items)
                mandate_id = UUID(mandate_id_str)
                
                mandate = db_session.query(ExecutionMandate).filter_by(mandate_id=mandate_id).first()

                if not mandate:
                    self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Mandate not found.[/]")
                    return

                graph = DelegationGraph(db_session)
                details = graph.get_path_details(root_mandate_id=mandate_id)

                # Build graph visualization from full reachable subgraph
                tree = self._build_delegation_graph(mandate, details, db_session)
                
                self.console.print()
                self.console.print(tree)
                self.console.print()

                stats = details.get("stats", {})
                self.console.print(f"  [{Colors.INFO}]Nodes: {stats.get('total_nodes', 0)}[/]")
                self.console.print(f"  [{Colors.INFO}]Edges: {stats.get('total_edges', 0)}[/]")
                self.console.print(f"  [{Colors.INFO}]Max Network Distance: {stats.get('max_network_distance', 0)}[/]")
                self.console.print(f"  [{Colors.INFO}]Branch Nodes: {stats.get('branch_nodes', 0)}[/]")
                self.console.print(f"  [{Colors.INFO}]Leaf Nodes: {stats.get('leaf_nodes', 0)}[/]")
                validity_style = Colors.SUCCESS if stats.get('is_valid', False) else Colors.ERROR
                self.console.print(f"  [{validity_style}]Path Valid: {stats.get('is_valid', False)}[/]")
            
            db_manager.close()
            
        except Exception as e:
            logger.error(f"Error showing delegation graph: {e}")
            self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
    
    def _build_delegation_graph(self, mandate: Any, details: dict, db_session: Any) -> Tree:
        """Build a tree visualization of the delegation graph subgraph."""
        from caracal.db.models import Principal
        
        principal = db_session.query(Principal).filter_by(principal_id=mandate.subject_id).first()
        root_name = principal.name if principal else str(mandate.subject_id)[:8]
        
        status_icon = Icons.SUCCESS if not mandate.revoked else Icons.ERROR
        status_color = Colors.SUCCESS if not mandate.revoked else Colors.ERROR
        
        tree = Tree(
            f"[{status_color}]{status_icon}[/] {root_name} (mandate: {str(mandate.mandate_id)[:8]}...)",
            guide_style=Colors.DIM
        )
        
        path_nodes = details.get("path", [])
        edges = details.get("edges", [])
        outbound = [e for e in edges if e.get("source_mandate_id") == str(mandate.mandate_id)]

        if outbound:
            out_branch = tree.add(f"[{Colors.WARNING}]⇒ Outbound ({len(outbound)})[/]")
            for edge in outbound:
                target_id = edge.get("target_mandate_id")
                target_node = next((n for n in path_nodes if n.get("mandate_id") == target_id), None)
                target_name = target_node.get("subject_name", target_id[:8]) if target_node else target_id[:8]
                target_type = target_node.get("principal_type", edge.get("target_principal_type", "unknown")) if target_node else edge.get("target_principal_type", "unknown")
                network_distance = target_node.get("network_distance", "?") if target_node else "?"
                tags = edge.get("context_tags") or []
                tag_text = f" [{Colors.DIM}]tags={','.join(tags)}[/]" if tags else ""
                out_branch.add(
                    f"[{Colors.NEUTRAL}]{target_type}[/] {target_name}... "
                    f"[{Colors.DIM}](network_distance={network_distance}, {edge.get('delegation_type', 'directed')}){tag_text}[/]"
                )

        if not outbound:
            tree.add(f"[{Colors.DIM}]No delegation edges[/]")
        
        return tree

    def delegate_mandate(self) -> None:
        """Delegate mandate with scope subset validation."""
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]Create a delegation edge from a source mandate[/]",
            title=f"[bold {Colors.INFO}]Delegate Mandate[/]",
            border_style=Colors.PRIMARY,
        ))
        self.console.print()
        
        try:
            from caracal.db.connection import get_db_manager
            from caracal.db.models import ExecutionMandate, Principal
            from caracal.core.mandate import MandateManager
            
            db_manager = get_db_manager()
            
            with db_manager.session_scope() as db_session:
                # Get valid source mandates
                mandates = db_session.query(ExecutionMandate).filter_by(revoked=False).all()
                
                if not mandates:
                    self.console.print(f"  [{Colors.DIM}]No valid mandates available for delegation.[/]")
                    return
                
                # Select source mandate
                items = [(str(m.mandate_id), f"Subject {str(m.subject_id)[:8]}...") for m in mandates]
                source_mandate_id_str = self.prompt.uuid("Source Mandate ID (Tab for suggestions)", items)
                source_mandate_id = UUID(source_mandate_id_str)
                
                source_mandate = db_session.query(ExecutionMandate).filter_by(mandate_id=source_mandate_id).first()
                
                if not source_mandate:
                    self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Source mandate not found.[/]")
                    return
                
                # Show source mandate scope
                self.console.print()
                self.console.print(f"  [{Colors.INFO}]Source Mandate Scope:[/]")
                self.console.print(f"    Resources: {', '.join(source_mandate.resource_scope[:3])}{'...' if len(source_mandate.resource_scope) > 3 else ''}")
                self.console.print(f"    Actions: {', '.join(source_mandate.action_scope[:3])}{'...' if len(source_mandate.action_scope) > 3 else ''}")
                source_network_distance = int(source_mandate.network_distance or 0)
                self.console.print(f"    Remaining Delegation Network Distance: {source_network_distance}")
                if source_network_distance <= 0:
                    self.console.print()
                    self.console.print(
                        f"  [{Colors.ERROR}]{Icons.ERROR} This mandate cannot delegate because delegation network_distance is exhausted.[/]"
                    )
                    return
                self.console.print()
                
                # Select target principal
                principals = db_session.query(Principal).all()
                principal_items = [(str(p.principal_id), p.name) for p in principals]
                target_subject_id_str = self.prompt.uuid("Target Principal ID (Tab for suggestions)", principal_items)
                target_subject_id = UUID(target_subject_id_str)
                
                # Target resource scope (must be subset)
                self.console.print()
                self.console.print(f"  [{Colors.INFO}]Select target resource scope (subset of source):[/]")
                target_resources = []
                while True:
                    remaining = [r for r in source_mandate.resource_scope if r not in target_resources]
                    if not remaining:
                        break
                    resource = self.prompt.select(
                        f"Resource {len(target_resources) + 1}",
                        choices=remaining + ["done"],
                        default=remaining[0],
                    )
                    if resource == "done":
                        break
                    target_resources.append(resource)
                
                if not target_resources:
                    self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} At least one resource is required.[/]")
                    return
                
                # Target action scope (must be subset)
                self.console.print()
                self.console.print(f"  [{Colors.INFO}]Select target action scope (subset of source):[/]")
                target_actions = []
                while True:
                    remaining = [a for a in source_mandate.action_scope if a not in target_actions]
                    if not remaining:
                        break
                    action = self.prompt.select(
                        f"Action {len(target_actions) + 1}",
                        choices=remaining + ["done"],
                        default=remaining[0],
                    )
                    if action == "done":
                        break
                    target_actions.append(action)
                
                if not target_actions:
                    self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} At least one action is required.[/]")
                    return
                
                # Validity period (must be within source)
                from datetime import datetime, timedelta
                
                source_remaining = (source_mandate.valid_until - datetime.utcnow()).total_seconds()
                max_validity = int(source_remaining) if source_remaining > 0 else 0
                
                if max_validity <= 0:
                    self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Source mandate has expired.[/]")
                    return
                
                validity_seconds = self.prompt.number(
                    f"Validity period (seconds, max {max_validity})",
                    default=min(3600, max_validity),
                    min_value=60,
                    max_value=max_validity,
                )
                
                # Context tags (optional)
                self.console.print()
                self.console.print(f"  [{Colors.INFO}]Context tags (optional, empty to skip):[/]")
                context_tags = []
                while True:
                    tag = self.prompt.text(f"Tag {len(context_tags) + 1}", required=False)
                    if not tag:
                        break
                    context_tags.append(tag)
                
                # Summary
                self.console.print()
                self.console.print(f"  [{Colors.INFO}]Delegation Summary:[/]")
                self.console.print(f"    Source Mandate: [{Colors.DIM}]{source_mandate_id_str[:8]}...[/]")
                self.console.print(f"    Target Principal: [{Colors.DIM}]{target_subject_id_str[:8]}...[/]")
                self.console.print(f"    Resources: [{Colors.NEUTRAL}]{len(target_resources)} resources[/]")
                self.console.print(f"    Actions: [{Colors.NEUTRAL}]{len(target_actions)} actions[/]")
                self.console.print(f"    Validity: [{Colors.NEUTRAL}]{int(validity_seconds)}s[/]")
                self.console.print(f"    Target Delegation Network Distance: [{Colors.NEUTRAL}]{source_network_distance - 1}[/]")
                if context_tags:
                    self.console.print(f"    Tags: [{Colors.NEUTRAL}]{', '.join(context_tags)}[/]")
                self.console.print()
                
                if not self.prompt.confirm("Create delegation edge?", default=True):
                    self.console.print(f"  [{Colors.WARNING}]{Icons.WARNING} Cancelled[/]")
                    return
                
                # Create delegated mandate
                self.console.print()
                self.console.print(f"  [{Colors.INFO}]Creating delegation edge...[/]")
                
                mandate_manager = MandateManager(db_session)
                
                delegated_mandate = mandate_manager.delegate_mandate(
                    source_mandate_id=source_mandate_id,
                    target_subject_id=target_subject_id,
                    resource_scope=target_resources,
                    action_scope=target_actions,
                    validity_seconds=int(validity_seconds),
                    context_tags=context_tags if context_tags else None,
                )
                
                self.console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Delegation edge created![/]")
                self.console.print(f"  [{Colors.NEUTRAL}]Target Mandate ID: [{Colors.PRIMARY}]{delegated_mandate.mandate_id}[/]")
                self.console.print(f"  [{Colors.NEUTRAL}]Delegation Network Distance: [{Colors.PRIMARY}]{delegated_mandate.network_distance}[/]")
                
                if self.state:
                    self.state.add_recent_action(RecentAction.create(
                        "delegate_mandate",
                        f"Delegated mandate to {target_subject_id_str[:8]}...",
                    ))
            
            db_manager.close()
            
        except Exception as e:
            logger.error(f"Error delegating mandate: {e}")
            self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
    
    def peer_delegate(self) -> None:
        """Create a peer-to-peer delegation between same-type principals."""
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]Create a peer-to-peer delegation edge[/]",
            title=f"[bold {Colors.INFO}]Peer Delegation[/]",
            border_style=Colors.PRIMARY,
        ))
        self.console.print()
        
        try:
            from caracal.db.connection import get_db_manager
            from caracal.db.models import ExecutionMandate, Principal
            from caracal.core.mandate import MandateManager
            
            db_manager = get_db_manager()
            
            with db_manager.session_scope() as db_session:
                mandates = db_session.query(ExecutionMandate).filter_by(revoked=False).all()
                
                if not mandates:
                    self.console.print(f"  [{Colors.DIM}]No valid mandates available.[/]")
                    return
                
                items = [(str(m.mandate_id), f"Subject {str(m.subject_id)[:8]}...") for m in mandates]
                source_id_str = self.prompt.uuid("Source Mandate ID", items)
                source_mandate_id = UUID(source_id_str)
                
                principals = db_session.query(Principal).all()
                principal_items = [(str(p.principal_id), f"{p.name} ({p.principal_type})") for p in principals]
                target_id_str = self.prompt.uuid("Peer Target Principal ID", principal_items)
                target_subject_id = UUID(target_id_str)
                
                source_mandate = db_session.query(ExecutionMandate).filter_by(mandate_id=source_mandate_id).first()
                if not source_mandate:
                    self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Source mandate not found.[/]")
                    return
                
                validity_seconds = self.prompt.number(
                    "Validity period (seconds)",
                    default=3600,
                    min_value=60,
                    max_value=86400,
                )
                
                if not self.prompt.confirm("Create peer delegation?", default=True):
                    return
                
                mandate_manager = MandateManager(db_session)
                
                delegated = mandate_manager.peer_delegate(
                    source_mandate_id=source_mandate_id,
                    target_subject_id=target_subject_id,
                    resource_scope=source_mandate.resource_scope,
                    action_scope=source_mandate.action_scope,
                    validity_seconds=int(validity_seconds),
                )
                
                self.console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Peer delegation created![/]")
                self.console.print(f"  [{Colors.NEUTRAL}]Target Mandate ID: [{Colors.PRIMARY}]{delegated.mandate_id}[/]")
                self.console.print(f"  [{Colors.NEUTRAL}]Delegation Network Distance: [{Colors.PRIMARY}]{delegated.network_distance}[/]")
                
                if self.state:
                    self.state.add_recent_action(RecentAction.create(
                        "peer_delegate",
                        f"Peer delegated to {target_id_str[:8]}...",
                    ))
            
            db_manager.close()
            
        except Exception as e:
            logger.error(f"Error creating peer delegation: {e}")
            self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
    
    def view_delegation_edges(self) -> None:
        """View delegation edges for a principal."""
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]View delegation edges connected to a principal[/]",
            title=f"[bold {Colors.INFO}]Delegation Edges[/]",
            border_style=Colors.PRIMARY,
        ))
        self.console.print()
        
        try:
            from caracal.db.connection import get_db_manager
            from caracal.db.models import ExecutionMandate, DelegationEdgeModel, Principal
            
            db_manager = get_db_manager()
            
            with db_manager.session_scope() as db_session:
                # Select principal
                principals = db_session.query(Principal).all()
                
                if not principals:
                    self.console.print(f"  [{Colors.DIM}]No principals registered.[/]")
                    return
                
                items = [(str(p.principal_id), p.name) for p in principals]
                principal_id_str = self.prompt.uuid("Principal ID (Tab for suggestions)", items)
                principal_id = UUID(principal_id_str)
                
                # Get mandates for this principal
                mandate_ids = [
                    m.mandate_id for m in
                    db_session.query(ExecutionMandate).filter(
                        ExecutionMandate.subject_id == principal_id
                    ).all()
                ]
                
                if not mandate_ids:
                    self.console.print(f"  [{Colors.DIM}]No mandates for this principal.[/]")
                    return
                
                # Get all edges involving this principal's mandates
                edges = db_session.query(DelegationEdgeModel).filter(
                    (DelegationEdgeModel.source_mandate_id.in_(mandate_ids)) |
                    (DelegationEdgeModel.target_mandate_id.in_(mandate_ids)),
                    DelegationEdgeModel.revoked == False,
                ).all()
                
                if not edges:
                    self.console.print(f"  [{Colors.DIM}]No delegation edges for this principal.[/]")
                    return
                
                self.console.print()
                
                table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
                table.add_column("Edge ID", style=Colors.DIM)
                table.add_column("Direction", style=Colors.NEUTRAL)
                table.add_column("Source Type", style=Colors.NEUTRAL)
                table.add_column("Target Type", style=Colors.NEUTRAL)
                table.add_column("Type", style=Colors.NEUTRAL)
                table.add_column("Tags", style=Colors.DIM)
                table.add_column("Status", style=Colors.NEUTRAL)
                
                for edge in edges:
                    direction = "⇒ OUT" if edge.source_mandate_id in mandate_ids else "⇐ IN"
                    status_style = Colors.SUCCESS if not edge.revoked else Colors.ERROR
                    status_text = "Active" if not edge.revoked else "Revoked"
                    tags = ", ".join(edge.context_tags) if edge.context_tags else ""
                    
                    table.add_row(
                        str(edge.edge_id)[:8] + "...",
                        direction,
                        edge.source_principal_type,
                        edge.target_principal_type,
                        edge.delegation_type,
                        tags,
                        f"[{status_style}]{status_text}[/]",
                    )
                
                self.console.print(table)
                self.console.print()
                self.console.print(f"  [{Colors.DIM}]Total: {len(edges)} delegation edges[/]")
            
            db_manager.close()
            
        except Exception as e:
            logger.error(f"Error viewing delegation edges: {e}")
            self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
    
    def revoke_delegation(self) -> None:
        """Revoke delegation edge with cascade option."""
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]Revoke a delegation edge[/]",
            title=f"[bold {Colors.WARNING}]Revoke Delegation[/]",
            border_style=Colors.WARNING,
        ))
        self.console.print()
        
        try:
            from caracal.db.connection import get_db_manager
            from caracal.db.models import ExecutionMandate, DelegationEdgeModel
            from caracal.core.mandate import MandateManager
            
            db_manager = get_db_manager()
            
            with db_manager.session_scope() as db_session:
                # Get active delegation edges
                edges = db_session.query(DelegationEdgeModel).filter(
                    DelegationEdgeModel.revoked == False,
                ).all()
                
                if not edges:
                    self.console.print(f"  [{Colors.DIM}]No active delegation edges to revoke.[/]")
                    return
                
                items = [
                    (str(e.edge_id), f"{e.source_principal_type}→{e.target_principal_type} ({e.delegation_type})")
                    for e in edges
                ]
                edge_id_str = self.prompt.uuid("Edge ID (Tab for suggestions)", items)
                edge_id = UUID(edge_id_str)
                
                edge = db_session.query(DelegationEdgeModel).filter_by(edge_id=edge_id).first()
                
                if not edge:
                    self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Edge not found.[/]")
                    return
                
                # Check for downstream edges from target mandate
                downstream_count = db_session.query(DelegationEdgeModel).filter(
                    DelegationEdgeModel.source_mandate_id == edge.target_mandate_id,
                    DelegationEdgeModel.revoked == False,
                ).count()
                
                cascade = False
                if downstream_count > 0:
                    self.console.print()
                    self.console.print(f"  [{Colors.WARNING}]This edge's target has {downstream_count} downstream edge(s).[/]")
                    cascade = self.prompt.confirm("Revoke downstream edges (cascade)?", default=True)
                
                # Revocation reason
                reason = self.prompt.text("Revocation reason", default="Manual revocation via TUI")
                
                # Confirmation
                self.console.print()
                self.console.print(f"  [{Colors.WARNING}]Warning: This action cannot be undone.[/]")
                if cascade:
                    self.console.print(f"  [{Colors.WARNING}]All downstream edges will also be revoked.[/]")
                self.console.print()
                
                if not self.prompt.confirm("Revoke this delegation edge?", default=False):
                    self.console.print(f"  [{Colors.INFO}]Cancelled[/]")
                    return
                
                # Revoke the edge
                self.console.print()
                self.console.print(f"  [{Colors.INFO}]Revoking delegation edge...[/]")
                
                # Revoke the edge itself
                edge.revoked = True
                
                # If cascading, revoke the target mandate and downstream edges
                if cascade:
                    mandate_manager = MandateManager(db_session)
                    target_mandate = db_session.query(ExecutionMandate).filter_by(
                        mandate_id=edge.target_mandate_id
                    ).first()
                    if target_mandate:
                        mandate_manager.revoke_mandate(
                            mandate_id=target_mandate.mandate_id,
                            revoker_id=target_mandate.issuer_id,
                            reason=reason,
                            cascade=True,
                        )
                
                db_session.commit()
                
                self.console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Delegation edge revoked![/]")
                if cascade and downstream_count > 0:
                    self.console.print(f"  [{Colors.INFO}]Revoked {downstream_count} downstream edge(s).[/]")
                
                if self.state:
                    self.state.add_recent_action(RecentAction.create(
                        "revoke_delegation",
                        f"Revoked edge {edge_id_str[:8]}...",
                    ))
            
            db_manager.close()
            
        except Exception as e:
            logger.error(f"Error revoking delegation: {e}")
            self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")


def run_mandate_delegation_flow(console: Optional[Console] = None, state: Optional[FlowState] = None) -> None:
    """Run the mandate delegation management flow."""
    flow = MandateDelegationFlow(console, state)
    flow.run()
