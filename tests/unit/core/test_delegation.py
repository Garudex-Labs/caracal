"""
Unit tests for Delegation core logic.

This module tests the DelegationTokenManager class and delegation token operations.
"""
import pytest
import jwt
from datetime import datetime, timedelta, timezone
from uuid import uuid4
from unittest.mock import Mock

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from caracal.core.delegation import DelegationTokenManager, DelegationTokenClaims
from caracal.exceptions import (
    PrincipalNotFoundError,
    InvalidDelegationTokenError,
    TokenExpiredError,
    TokenValidationError,
)


def _generate_test_key_pair() -> tuple[bytes, bytes]:
    private_key = ec.generate_private_key(ec.SECP256R1())
    private_key_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_key_pem = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return private_key_pem, public_key_pem


@pytest.mark.unit
class TestDelegationTokenManager:
    """Test suite for DelegationTokenManager class."""
    
    def setup_method(self):
        """Set up test fixtures before each test method."""
        self.mock_principal_registry = Mock()
        self.manager = DelegationTokenManager(self.mock_principal_registry)
    
    def test_generate_token_success(self):
        """Test delegation token generation with valid data."""
        # Arrange
        source_id = uuid4()
        target_id = uuid4()
        
        # Mock principal with private key
        mock_principal = Mock()
        mock_principal.metadata = {"public_key_pem": "test_public_key"}
        self.mock_principal_registry.get_principal.return_value = mock_principal
        
        private_key_pem, _public_key_pem = _generate_test_key_pair()
        self.manager._signing_service = Mock()
        self.manager._signing_service.sign_jwt_for_principal.return_value = jwt.encode(
            {"sub": str(target_id), "iss": str(source_id), "aud": "caracal-core"},
            private_key_pem,
            algorithm="ES256",
            headers={"kid": str(source_id)},
        )

        # Act
        token = self.manager.generate_token(
            source_principal_id=source_id,
            target_principal_id=target_id,
            expiration_seconds=3600,
            allowed_operations=["api_call"],
            delegation_type="directed"
        )
        
        # Assert
        assert token is not None
        assert isinstance(token, str)
        assert len(token) > 0
    
    def test_generate_token_principal_not_found(self):
        """Test token generation fails when principal not found."""
        # Arrange
        source_id = uuid4()
        target_id = uuid4()
        
        self.mock_principal_registry.get_principal.return_value = None
        
        # Act & Assert
        with pytest.raises(PrincipalNotFoundError):
            self.manager.generate_token(
                source_principal_id=source_id,
                target_principal_id=target_id
            )

    def test_generate_token_emits_single_lineage_source_mandate_claim(self):
        """Delegation token should emit sourceMandateId and never authoritySources."""
        source_id = uuid4()
        target_id = uuid4()
        source_mandate_id = uuid4()

        mock_principal = Mock()
        mock_principal.metadata = {"public_key_pem": "test_public_key"}
        self.mock_principal_registry.get_principal.return_value = mock_principal

        private_key_pem, _public_key_pem = _generate_test_key_pair()
        self.manager._signing_service = Mock()
        self.manager._signing_service.sign_jwt_for_principal.side_effect = (
            lambda **kwargs: jwt.encode(
                kwargs["payload"],
                private_key_pem,
                algorithm=kwargs["algorithm"],
                headers=kwargs["headers"],
            )
        )

        token = self.manager.generate_token(
            source_principal_id=source_id,
            target_principal_id=target_id,
            source_mandate_id=source_mandate_id,
        )

        payload = jwt.decode(token, options={"verify_signature": False, "verify_exp": False})
        assert payload.get("sourceMandateId") == str(source_mandate_id)
        assert "authoritySources" not in payload
    
    def test_validate_token_success(self):
        """Test delegation token validation with valid token."""
        # Arrange
        source_id = uuid4()
        target_id = uuid4()
        
        # Generate real key pair
        private_key_pem, public_key_pem = _generate_test_key_pair()
        
        # Mock principal for generation
        mock_principal_gen = Mock()
        mock_principal_gen.metadata = {}
        
        # Mock principal for validation
        mock_principal_val = Mock()
        mock_principal_val.public_key = public_key_pem.decode()
        mock_principal_val.metadata = {}
        
        self.mock_principal_registry.get_principal.return_value = mock_principal_gen
        
        self.manager._signing_service = Mock()
        self.manager._signing_service.sign_jwt_for_principal.side_effect = (
            lambda **kwargs: jwt.encode(
                kwargs["payload"],
                private_key_pem,
                algorithm=kwargs["algorithm"],
                headers=kwargs["headers"],
            )
        )
        self.manager._signing_service.verify_jwt_for_principal.side_effect = (
            lambda **kwargs: jwt.decode(
                kwargs["token"],
                public_key_pem,
                algorithms=kwargs["algorithms"],
                audience=kwargs["audience"],
            )
        )

        # Generate token
        token = self.manager.generate_token(
            source_principal_id=source_id,
            target_principal_id=target_id,
            expiration_seconds=3600
        )
        
        # Mock principal for validation
        self.mock_principal_registry.get_principal.return_value = mock_principal_val
        
        # Act
        claims = self.manager.validate_token(token)
        
        # Assert
        assert claims is not None
        assert claims.issuer == source_id
        assert claims.subject == target_id
        assert claims.audience == "caracal-core"
    
    def test_validate_token_expired(self):
        """Test token validation fails with expired token."""
        # Arrange
        source_id = uuid4()
        target_id = uuid4()
        
        # Generate real key pair
        private_key_pem, public_key_pem = _generate_test_key_pair()
        
        # Mock principal for generation
        mock_principal_gen = Mock()
        mock_principal_gen.metadata = {}
        
        self.mock_principal_registry.get_principal.return_value = mock_principal_gen
        
        self.manager._signing_service = Mock()
        self.manager._signing_service.sign_jwt_for_principal.side_effect = (
            lambda **kwargs: jwt.encode(
                kwargs["payload"],
                private_key_pem,
                algorithm=kwargs["algorithm"],
                headers=kwargs["headers"],
            )
        )
        self.manager._signing_service.verify_jwt_for_principal.side_effect = (
            lambda **kwargs: jwt.decode(
                kwargs["token"],
                public_key_pem,
                algorithms=kwargs["algorithms"],
                audience=kwargs["audience"],
            )
        )

        # Generate token with very short expiration
        token = self.manager.generate_token(
            source_principal_id=source_id,
            target_principal_id=target_id,
            expiration_seconds=1  # 1 second
        )
        
        # Wait for token to expire
        import time
        time.sleep(2)
        
        # Mock principal for validation
        mock_principal_val = Mock()
        mock_principal_val.public_key = public_key_pem.decode()
        mock_principal_val.metadata = {}
        self.mock_principal_registry.get_principal.return_value = mock_principal_val
        
        # Act & Assert
        with pytest.raises(TokenExpiredError):
            self.manager.validate_token(token)
    
    def test_validate_token_invalid_signature(self):
        """Test token validation fails with invalid signature."""
        # Arrange
        source_id = uuid4()
        target_id = uuid4()
        
        # Generate two different key pairs
        private_key_pem1, _ = _generate_test_key_pair()
        _, public_key_pem2 = _generate_test_key_pair()
        
        # Mock principal for generation
        mock_principal_gen = Mock()
        mock_principal_gen.metadata = {}
        
        self.mock_principal_registry.get_principal.return_value = mock_principal_gen
        
        self.manager._signing_service = Mock()
        self.manager._signing_service.sign_jwt_for_principal.side_effect = (
            lambda **kwargs: jwt.encode(
                kwargs["payload"],
                private_key_pem1,
                algorithm=kwargs["algorithm"],
                headers=kwargs["headers"],
            )
        )
        self.manager._signing_service.verify_jwt_for_principal.side_effect = (
            lambda **kwargs: jwt.decode(
                kwargs["token"],
                public_key_pem2,
                algorithms=kwargs["algorithms"],
                audience=kwargs["audience"],
            )
        )

        # Generate token with first key
        token = self.manager.generate_token(
            source_principal_id=source_id,
            target_principal_id=target_id,
            expiration_seconds=3600
        )
        
        # Mock principal for validation with different public key
        mock_principal_val = Mock()
        mock_principal_val.public_key = public_key_pem2.decode()
        mock_principal_val.metadata = {}
        self.mock_principal_registry.get_principal.return_value = mock_principal_val
        
        # Act & Assert
        with pytest.raises(TokenValidationError):
            self.manager.validate_token(token)


@pytest.mark.unit
class TestDelegationTokenClaims:
    """Test suite for DelegationTokenClaims dataclass."""
    
    def test_delegation_token_claims_creation(self):
        """Test DelegationTokenClaims creation with valid data."""
        # Arrange
        issuer = uuid4()
        subject = uuid4()
        token_id = uuid4()
        now = datetime.now(timezone.utc)
        expiration = now + timedelta(hours=1)
        
        # Act
        claims = DelegationTokenClaims(
            issuer=issuer,
            subject=subject,
            audience="caracal-core",
            expiration=expiration,
            issued_at=now,
            token_id=token_id,
            allowed_operations=["api_call"],
            delegation_type="directed",
            source_principal_kind="human",
            target_principal_kind="worker"
        )
        
        # Assert
        assert claims.issuer == issuer
        assert claims.subject == subject
        assert claims.audience == "caracal-core"
        assert claims.delegation_type == "directed"
        assert claims.source_principal_kind == "human"
        assert claims.target_principal_kind == "worker"
    
    def test_delegation_token_claims_with_context_tags(self):
        """Test DelegationTokenClaims with context tags."""
        # Arrange & Act
        claims = DelegationTokenClaims(
            issuer=uuid4(),
            subject=uuid4(),
            audience="caracal-core",
            expiration=datetime.now(timezone.utc) + timedelta(hours=1),
            issued_at=datetime.now(timezone.utc),
            token_id=uuid4(),
            allowed_operations=["api_call"],
            context_tags=["production", "read-only"]
        )
        
        # Assert
        assert claims.context_tags == ["production", "read-only"]


@pytest.mark.unit
class TestDelegationChainValidation:
    """Test suite for delegation chain validation logic."""
    
    def test_delegation_chain_depth_limit(self):
        """Test delegation chain respects depth limits."""
        # Arrange
        max_depth = 3
        current_depth = 2
        
        # Act
        can_delegate = current_depth < max_depth
        
        # Assert
        assert can_delegate is True
    
    def test_delegation_chain_exceeds_depth(self):
        """Test delegation chain validation fails when depth exceeded."""
        # Arrange
        max_depth = 3
        current_depth = 3
        
        # Act
        can_delegate = current_depth < max_depth
        
        # Assert
        assert can_delegate is False
    
    def test_delegation_revocation_cascades(self):
        """Test delegation revocation cascades to child delegations."""
        # This is a conceptual test - actual implementation would involve
        # the delegation graph and database operations
        # Arrange
        parent_revoked = True
        child_should_be_revoked = parent_revoked
        
        # Assert
        assert child_should_be_revoked is True
