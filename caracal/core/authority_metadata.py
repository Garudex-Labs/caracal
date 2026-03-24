"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Authority Metadata for Caracal Core.

This module provides AuthorityMetadata, a protocol-level metadata container
for authority enforcement that replaces ASE's EconomicMetadata.

Enhancements over ASE:
- Focus on authority semantics only (no economic fields)
- Integration with Caracal's mandate system
- Support for delegation chains
- Audit trail linking
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional

from caracal.core.identity import AgentIdentity
from caracal.core.audit import AuditReference


@dataclass
class AuthorityMetadata:
    """
    Protocol-level metadata for authority enforcement.
    
    Replaces ASE's EconomicMetadata with authority-focused design.
    This metadata container provides a standardized way to attach
    authority information to agent operations and communications.
    
    Improvements over ASE:
    - Focuses on authority enforcement metadata only
    - Integrates with Caracal's existing mandate system
    - Supports delegation chains for complex authorization scenarios
    - Maintains audit trail linkage
    - No economic fields (budget, cost, charges)
    
    Attributes:
        version: Caracal authority protocol version
        agent_identity: Identity of the agent performing the operation
        mandate_id: Optional link to Caracal mandate
        audit_reference: Optional reference to audit trail
        delegation_token: Optional JWT delegation token
        delegation_chain: List of agent IDs in the delegation chain
        timestamp: When the metadata was created
        signature: Optional cryptographic signature
    """
    version: str = "1.0.0"
    agent_identity: Optional[AgentIdentity] = None
    mandate_id: Optional[str] = None
    audit_reference: Optional[AuditReference] = None
    delegation_token: Optional[str] = None
    delegation_chain: List[str] = field(default_factory=list)
    timestamp: Optional[datetime] = None
    signature: Optional[str] = None
    
    def __post_init__(self):
        """Set default timestamp."""
        if self.timestamp is None:
            self.timestamp = datetime.utcnow()
    
    def to_dict(self) -> Dict[str, Any]:
        """
        Convert to dictionary for JSON serialization.
        
        Returns:
            Dictionary representation of the metadata
        """
        return {
            "version": self.version,
            "agent_identity": self.agent_identity.to_dict() if self.agent_identity else None,
            "mandate_id": self.mandate_id,
            "audit_reference": self.audit_reference.to_dict() if self.audit_reference else None,
            "delegation_token": self.delegation_token,
            "delegation_chain": self.delegation_chain,
            "timestamp": self.timestamp.isoformat() if self.timestamp else None,
            "signature": self.signature
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "AuthorityMetadata":
        """
        Create AuthorityMetadata from dictionary.
        
        Args:
            data: Dictionary containing metadata
            
        Returns:
            AuthorityMetadata instance
        """
        # Parse nested objects
        agent_identity = None
        if data.get("agent_identity"):
            agent_identity = AgentIdentity.from_dict(data["agent_identity"])
        
        audit_reference = None
        if data.get("audit_reference"):
            audit_reference = AuditReference.from_dict(data["audit_reference"])
        
        timestamp = None
        if data.get("timestamp"):
            timestamp = datetime.fromisoformat(data["timestamp"])
        
        return cls(
            version=data.get("version", "1.0.0"),
            agent_identity=agent_identity,
            mandate_id=data.get("mandate_id"),
            audit_reference=audit_reference,
            delegation_token=data.get("delegation_token"),
            delegation_chain=data.get("delegation_chain", []),
            timestamp=timestamp,
            signature=data.get("signature")
        )
