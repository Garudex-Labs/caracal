"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Authority Metadata for Caracal Core.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Optional

from caracal.core.identity import PrincipalIdentity
from caracal.core.audit import AuditReference


@dataclass
class AuthorityMetadata:
    """
    Protocol-level metadata for authority enforcement.
    
    Attributes:
        version: Caracal authority protocol version
        principal_identity: Identity of the principal performing the operation
        mandate_id: Optional link to Caracal mandate
        audit_reference: Optional reference to audit trail
        delegation_token: Optional JWT delegation token
        delegation_path: List of principal IDs in the delegation path
        timestamp: When the metadata was created
        signature: Optional cryptographic signature
    """
    version: str = "1.0.0"
    principal_identity: Optional[PrincipalIdentity] = None
    mandate_id: Optional[str] = None
    audit_reference: Optional[AuditReference] = None
    delegation_token: Optional[str] = None
    delegation_path: List[str] = field(default_factory=list)
    timestamp: Optional[datetime] = None
    signature: Optional[str] = None
    
    def __post_init__(self):
        """Set default timestamp."""
        if self.timestamp is None:
            self.timestamp = datetime.utcnow()
    
    def to_dict(self) -> Dict[str, object]:
        """
        Convert to dictionary for JSON serialization.
        
        Returns:
            Dictionary representation of the metadata
        """
        return {
            "version": self.version,
            "principal_identity": self.principal_identity.to_dict() if self.principal_identity else None,
            "mandate_id": self.mandate_id,
            "audit_reference": self.audit_reference.to_dict() if self.audit_reference else None,
            "delegation_token": self.delegation_token,
            "delegation_path": self.delegation_path,
            "timestamp": self.timestamp.isoformat() if self.timestamp else None,
            "signature": self.signature
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, object]) -> "AuthorityMetadata":
        """
        Create AuthorityMetadata from dictionary.
        
        Args:
            data: Dictionary containing metadata
            
        Returns:
            AuthorityMetadata instance
        """
        # Parse nested objects
        principal_identity = None
        if data.get("principal_identity"):
            principal_identity = PrincipalIdentity.from_dict(data["principal_identity"])
        
        audit_reference = None
        if data.get("audit_reference"):
            audit_reference = AuditReference.from_dict(data["audit_reference"])
        
        timestamp = None
        if data.get("timestamp"):
            timestamp = datetime.fromisoformat(data["timestamp"])
        
        return cls(
            version=data.get("version", "1.0.0"),
            principal_identity=principal_identity,
            mandate_id=data.get("mandate_id"),
            audit_reference=audit_reference,
            delegation_token=data.get("delegation_token"),
            delegation_path=data.get("delegation_path", []),
            timestamp=timestamp,
            signature=data.get("signature")
        )
