"""
Agent-to-agent delegation protocol.

This module provides the protocol for delegating tasks and authority between
agents in a multi-agent system, with full Caracal integration for mandate
delegation and authority tracking.
"""

import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional
from uuid import uuid4

from examples.langchain_demo.agents.base import AgentRole

logger = logging.getLogger(__name__)


@dataclass
class DelegationRequest:
    """
    Request to delegate a task to another agent.
    
    Attributes:
        request_id: Unique identifier for this delegation request
        from_agent_id: ID of the agent delegating the task
        from_agent_role: Role of the delegating agent
        to_agent_role: Role of the target agent
        task_description: Description of the task to delegate
        context: Additional context for the task
        required_tools: List of tool IDs the delegate will need
        mandate_scope: Scope of authority to delegate
        priority: Priority level (1=highest, 5=lowest)
        created_at: When the request was created
    """
    
    request_id: str
    from_agent_id: str
    from_agent_role: AgentRole
    to_agent_role: AgentRole
    task_description: str
    context: Dict[str, Any] = field(default_factory=dict)
    required_tools: List[str] = field(default_factory=list)
    mandate_scope: Dict[str, Any] = field(default_factory=dict)
    priority: int = 3
    created_at: datetime = field(default_factory=datetime.utcnow)
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert delegation request to dictionary."""
        return {
            "request_id": self.request_id,
            "from_agent_id": self.from_agent_id,
            "from_agent_role": self.from_agent_role.value,
            "to_agent_role": self.to_agent_role.value,
            "task_description": self.task_description,
            "context": self.context,
            "required_tools": self.required_tools,
            "mandate_scope": self.mandate_scope,
            "priority": self.priority,
            "created_at": self.created_at.isoformat(),
        }


@dataclass
class DelegationResult:
    """
    Result of a delegated task.
    
    Attributes:
        request_id: ID of the original delegation request
        agent_id: ID of the agent that executed the task
        agent_role: Role of the executing agent
        status: Status of the delegation (success, error, timeout)
        result: Result data from the task execution
        error: Error message if status is error
        started_at: When execution started
        completed_at: When execution completed
        duration_ms: Duration of execution in milliseconds
    """
    
    request_id: str
    agent_id: str
    agent_role: AgentRole
    status: str
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    duration_ms: Optional[int] = None
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert delegation result to dictionary."""
        return {
            "request_id": self.request_id,
            "agent_id": self.agent_id,
            "agent_role": self.agent_role.value,
            "status": self.status,
            "result": self.result,
            "error": self.error,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
            "duration_ms": self.duration_ms,
        }


@dataclass
class MandateDelegation:
    """
    Record of a Caracal mandate delegation.
    
    # CARACAL INTEGRATION POINT
    # This represents a cryptographic delegation of authority from one
    # agent's mandate to another agent's mandate.
    
    Attributes:
        delegation_id: Unique identifier for this delegation
        source_mandate_id: Mandate ID of the delegating agent
        target_mandate_id: Mandate ID of the delegate agent
        source_agent_id: ID of the delegating agent
        target_agent_id: ID of the delegate agent
        resource_scopes: List of resource scopes delegated
        action_scopes: List of action scopes delegated
        created_at: When the delegation was created
        expires_at: When the delegation expires (if applicable)
        revoked: Whether the delegation has been revoked
        revoked_at: When the delegation was revoked (if applicable)
        metadata: Additional metadata about the delegation
    """
    
    delegation_id: str
    source_mandate_id: str
    target_mandate_id: str
    source_agent_id: str
    target_agent_id: str
    resource_scopes: List[str] = field(default_factory=list)
    action_scopes: List[str] = field(default_factory=list)
    created_at: datetime = field(default_factory=datetime.utcnow)
    expires_at: Optional[datetime] = None
    revoked: bool = False
    revoked_at: Optional[datetime] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert mandate delegation to dictionary."""
        return {
            "delegation_id": self.delegation_id,
            "source_mandate_id": self.source_mandate_id,
            "target_mandate_id": self.target_mandate_id,
            "source_agent_id": self.source_agent_id,
            "target_agent_id": self.target_agent_id,
            "resource_scopes": self.resource_scopes,
            "action_scopes": self.action_scopes,
            "created_at": self.created_at.isoformat(),
            "expires_at": self.expires_at.isoformat() if self.expires_at else None,
            "revoked": self.revoked,
            "revoked_at": self.revoked_at.isoformat() if self.revoked_at else None,
            "metadata": self.metadata,
        }


class DelegationProtocol:
    """
    Protocol for agent-to-agent delegation.
    
    This class manages the delegation of tasks between agents, including:
    1. Creating delegation requests
    2. Delegating Caracal mandates
    3. Tracking delegation chains
    4. Managing delegation lifecycle
    
    # CARACAL INTEGRATION POINT
    # The delegation protocol integrates with Caracal's mandate system:
    # - Parent agent has a mandate with broad authority
    # - Parent delegates a scoped mandate to child agent
    # - Child agent can only access tools within delegated scope
    # - Delegation is cryptographically signed and tracked in ledger
    # - Revoking parent mandate cascades to child mandates
    """
    
    def __init__(self, caracal_client: Any):
        """
        Initialize the delegation protocol.
        
        Args:
            caracal_client: Caracal client for mandate operations
        """
        self.caracal_client = caracal_client
        self.delegation_requests: Dict[str, DelegationRequest] = {}
        self.delegation_results: Dict[str, DelegationResult] = {}
        self.mandate_delegations: Dict[str, MandateDelegation] = {}
        
        logger.debug("Initialized DelegationProtocol")
    
    def create_delegation_request(
        self,
        from_agent_id: str,
        from_agent_role: AgentRole,
        to_agent_role: AgentRole,
        task_description: str,
        context: Optional[Dict[str, Any]] = None,
        required_tools: Optional[List[str]] = None,
        mandate_scope: Optional[Dict[str, Any]] = None,
        priority: int = 3,
    ) -> DelegationRequest:
        """
        Create a delegation request.
        
        Args:
            from_agent_id: ID of the agent delegating the task
            from_agent_role: Role of the delegating agent
            to_agent_role: Role of the target agent
            task_description: Description of the task to delegate
            context: Additional context for the task
            required_tools: List of tool IDs the delegate will need
            mandate_scope: Scope of authority to delegate
            priority: Priority level (1=highest, 5=lowest)
        
        Returns:
            Created DelegationRequest
        """
        request = DelegationRequest(
            request_id=str(uuid4()),
            from_agent_id=from_agent_id,
            from_agent_role=from_agent_role,
            to_agent_role=to_agent_role,
            task_description=task_description,
            context=context or {},
            required_tools=required_tools or [],
            mandate_scope=mandate_scope or {},
            priority=priority,
        )
        
        self.delegation_requests[request.request_id] = request
        
        logger.info(
            f"Created delegation request {request.request_id[:8]}: "
            f"{from_agent_role.value} → {to_agent_role.value}"
        )
        
        return request
    
    async def delegate_mandate(
        self,
        source_agent_id: str,
        source_mandate_id: str,
        target_agent_id: str,
        target_mandate_id: str,
        resource_scopes: Optional[List[str]] = None,
        action_scopes: Optional[List[str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> MandateDelegation:
        """
        Delegate a Caracal mandate from one agent to another.
        
        # CARACAL INTEGRATION POINT
        # This method demonstrates cryptographic mandate delegation:
        # 1. Source agent has a mandate with certain authority
        # 2. Source agent delegates a subset of that authority to target agent
        # 3. Caracal creates a new mandate for target with scoped authority
        # 4. Delegation is cryptographically signed and logged
        # 5. Revoking source mandate will cascade to target mandate
        
        Args:
            source_agent_id: ID of the delegating agent
            source_mandate_id: Mandate ID of the delegating agent
            target_agent_id: ID of the delegate agent
            target_mandate_id: Mandate ID for the delegate agent
            resource_scopes: List of resource scopes to delegate
            action_scopes: List of action scopes to delegate
            metadata: Additional metadata about the delegation
        
        Returns:
            MandateDelegation record
        
        Note:
            In a real implementation, this would call Caracal's delegation API.
            For now, we track the delegation locally.
        """
        delegation = MandateDelegation(
            delegation_id=str(uuid4()),
            source_mandate_id=source_mandate_id,
            target_mandate_id=target_mandate_id,
            source_agent_id=source_agent_id,
            target_agent_id=target_agent_id,
            resource_scopes=resource_scopes or [],
            action_scopes=action_scopes or [],
            metadata=metadata or {},
        )
        
        self.mandate_delegations[delegation.delegation_id] = delegation
        
        logger.info(
            f"Delegated mandate {source_mandate_id[:8]} → {target_mandate_id[:8]} "
            f"(delegation: {delegation.delegation_id[:8]})"
        )
        
        # In a real implementation, this would call Caracal's delegation API:
        # result = await self.caracal_client.delegate_mandate(
        #     source_mandate_id=source_mandate_id,
        #     target_principal_id=target_principal_id,
        #     resource_scopes=resource_scopes,
        #     action_scopes=action_scopes,
        # )
        
        return delegation
    
    def record_delegation_result(
        self,
        request_id: str,
        agent_id: str,
        agent_role: AgentRole,
        status: str,
        result: Optional[Dict[str, Any]] = None,
        error: Optional[str] = None,
        started_at: Optional[datetime] = None,
        completed_at: Optional[datetime] = None,
    ) -> DelegationResult:
        """
        Record the result of a delegated task.
        
        Args:
            request_id: ID of the original delegation request
            agent_id: ID of the agent that executed the task
            agent_role: Role of the executing agent
            status: Status of the delegation (success, error, timeout)
            result: Result data from the task execution
            error: Error message if status is error
            started_at: When execution started
            completed_at: When execution completed
        
        Returns:
            Created DelegationResult
        """
        duration_ms = None
        if started_at and completed_at:
            duration_ms = int((completed_at - started_at).total_seconds() * 1000)
        
        delegation_result = DelegationResult(
            request_id=request_id,
            agent_id=agent_id,
            agent_role=agent_role,
            status=status,
            result=result,
            error=error,
            started_at=started_at,
            completed_at=completed_at,
            duration_ms=duration_ms,
        )
        
        self.delegation_results[request_id] = delegation_result
        
        logger.info(
            f"Recorded delegation result for {request_id[:8]}: "
            f"status={status}, duration={duration_ms}ms"
        )
        
        return delegation_result
    
    def get_delegation_request(self, request_id: str) -> Optional[DelegationRequest]:
        """
        Get a delegation request by ID.
        
        Args:
            request_id: ID of the delegation request
        
        Returns:
            DelegationRequest if found, None otherwise
        """
        return self.delegation_requests.get(request_id)
    
    def get_delegation_result(self, request_id: str) -> Optional[DelegationResult]:
        """
        Get a delegation result by request ID.
        
        Args:
            request_id: ID of the delegation request
        
        Returns:
            DelegationResult if found, None otherwise
        """
        return self.delegation_results.get(request_id)
    
    def get_mandate_delegation(self, delegation_id: str) -> Optional[MandateDelegation]:
        """
        Get a mandate delegation by ID.
        
        Args:
            delegation_id: ID of the mandate delegation
        
        Returns:
            MandateDelegation if found, None otherwise
        """
        return self.mandate_delegations.get(delegation_id)
    
    def get_delegations_by_agent(
        self,
        agent_id: str,
        as_source: bool = True,
    ) -> List[MandateDelegation]:
        """
        Get all mandate delegations for an agent.
        
        Args:
            agent_id: ID of the agent
            as_source: If True, get delegations where agent is source;
                      if False, get delegations where agent is target
        
        Returns:
            List of MandateDelegation records
        """
        delegations = []
        
        for delegation in self.mandate_delegations.values():
            if as_source and delegation.source_agent_id == agent_id:
                delegations.append(delegation)
            elif not as_source and delegation.target_agent_id == agent_id:
                delegations.append(delegation)
        
        return delegations
    
    def get_delegation_chain(
        self,
        agent_id: str,
        mandate_id: str,
    ) -> List[MandateDelegation]:
        """
        Get the complete delegation chain for an agent.
        
        This traces the delegation chain from the root mandate down to
        the specified agent's mandate.
        
        Args:
            agent_id: ID of the agent
            mandate_id: Mandate ID of the agent
        
        Returns:
            List of MandateDelegation records in chain order
        """
        chain = []
        current_mandate_id = mandate_id
        
        # Trace backwards through delegations
        while True:
            found = False
            for delegation in self.mandate_delegations.values():
                if delegation.target_mandate_id == current_mandate_id:
                    chain.insert(0, delegation)
                    current_mandate_id = delegation.source_mandate_id
                    found = True
                    break
            
            if not found:
                break
        
        return chain
    
    def revoke_mandate_delegation(
        self,
        delegation_id: str,
        reason: str = "Revoked by parent agent",
    ) -> bool:
        """
        Revoke a mandate delegation.
        
        # CARACAL INTEGRATION POINT
        # In a real implementation, this would call Caracal's revocation API
        # and the revocation would cascade to any child delegations.
        
        Args:
            delegation_id: ID of the delegation to revoke
            reason: Reason for revocation
        
        Returns:
            True if revoked, False if not found
        """
        delegation = self.mandate_delegations.get(delegation_id)
        
        if not delegation:
            return False
        
        delegation.revoked = True
        delegation.revoked_at = datetime.utcnow()
        delegation.metadata["revocation_reason"] = reason
        
        logger.info(
            f"Revoked mandate delegation {delegation_id[:8]}: {reason}"
        )
        
        # In a real implementation:
        # await self.caracal_client.revoke_mandate(
        #     mandate_id=delegation.target_mandate_id,
        #     revoker_id=delegation.source_agent_id,
        #     reason=reason,
        #     cascade=True,
        # )
        
        return True
    
    def get_statistics(self) -> Dict[str, Any]:
        """
        Get statistics about delegations.
        
        Returns:
            Dictionary with delegation statistics
        """
        stats = {
            "total_requests": len(self.delegation_requests),
            "total_results": len(self.delegation_results),
            "total_mandate_delegations": len(self.mandate_delegations),
            "active_delegations": 0,
            "revoked_delegations": 0,
            "successful_delegations": 0,
            "failed_delegations": 0,
        }
        
        for delegation in self.mandate_delegations.values():
            if delegation.revoked:
                stats["revoked_delegations"] += 1
            else:
                stats["active_delegations"] += 1
        
        for result in self.delegation_results.values():
            if result.status == "success":
                stats["successful_delegations"] += 1
            elif result.status == "error":
                stats["failed_delegations"] += 1
        
        return stats
    
    def clear(self) -> None:
        """Clear all delegation records."""
        self.delegation_requests.clear()
        self.delegation_results.clear()
        self.mandate_delegations.clear()
        logger.debug("Cleared delegation protocol records")
    
    def __repr__(self) -> str:
        """String representation of the delegation protocol."""
        stats = self.get_statistics()
        return (
            f"<DelegationProtocol "
            f"requests={stats['total_requests']} "
            f"delegations={stats['total_mandate_delegations']}>"
        )


# Global delegation protocol instance
_global_delegation_protocol: Optional[DelegationProtocol] = None


def get_delegation_protocol(caracal_client: Any) -> DelegationProtocol:
    """
    Get the global delegation protocol instance.
    
    Args:
        caracal_client: Caracal client for mandate operations
    
    Returns:
        The global DelegationProtocol instance
    """
    global _global_delegation_protocol
    if _global_delegation_protocol is None:
        _global_delegation_protocol = DelegationProtocol(caracal_client)
    return _global_delegation_protocol


def reset_delegation_protocol() -> None:
    """Reset the global delegation protocol (useful for testing)."""
    global _global_delegation_protocol
    if _global_delegation_protocol is not None:
        _global_delegation_protocol.clear()
    _global_delegation_protocol = None
