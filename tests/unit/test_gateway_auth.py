"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for gateway authentication.

Tests authentication methods:
- mTLS certificate validation
- JWT token verification
- API key lookup
"""

import pytest
import bcrypt
import jwt
from datetime import datetime, timedelta
from cryptography import x509
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from caracal.gateway.auth import Authenticator, AuthenticationMethod
from caracal.core.identity import AgentRegistry


@pytest.fixture
def temp_registry(tmp_path):
    """Create a temporary agent registry."""
    registry_path = tmp_path / "agents.json"
    return AgentRegistry(str(registry_path))


@pytest.fixture
def sample_agent(temp_registry):
    """Create a sample agent for testing."""
    return temp_registry.register_agent(
        name="test-agent",
        owner="test@example.com",
        metadata={}
    )


@pytest.fixture
def agent_with_api_key(temp_registry):
    """Create an agent with API key."""
    api_key = "test-api-key-12345"
    api_key_hash = bcrypt.hashpw(api_key.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
    
    agent = temp_registry.register_agent(
        name="api-key-agent",
        owner="test@example.com",
        metadata={"api_key_hash": api_key_hash}
    )
    
    return agent, api_key


@pytest.fixture
def rsa_key_pair():
    """Generate RSA key pair for JWT testing."""
    private_key = rsa.generate_private_key(
        public_exponent=65537,
        key_size=2048,
        backend=default_backend()
    )
    
    public_key_pem = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo
    ).decode('utf-8')
    
    return private_key, public_key_pem


@pytest.fixture
def client_certificate(sample_agent):
    """Generate a client certificate for mTLS testing."""
    # Generate private key
    private_key = rsa.generate_private_key(
        public_exponent=65537,
        key_size=2048,
        backend=default_backend()
    )
    
    # Create certificate with agent ID in CN
    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, sample_agent.agent_id),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Caracal Test"),
    ])
    
    cert = x509.CertificateBuilder().subject_name(
        subject
    ).issuer_name(
        issuer
    ).public_key(
        private_key.public_key()
    ).serial_number(
        x509.random_serial_number()
    ).not_valid_before(
        datetime.utcnow()
    ).not_valid_after(
        datetime.utcnow() + timedelta(days=365)
    ).sign(private_key, hashes.SHA256(), default_backend())
    
    cert_pem = cert.public_bytes(serialization.Encoding.PEM)
    
    return cert_pem, sample_agent


class TestAuthenticator:
    """Test Authenticator class."""
    
    def test_authenticator_initialization(self, temp_registry):
        """Test initializing an Authenticator."""
        auth = Authenticator(agent_registry=temp_registry)
        
        assert auth.agent_registry == temp_registry
        assert auth.jwt_algorithm == "RS256"
        assert auth.ca_cert is None
    
    @pytest.mark.asyncio
    async def test_authenticate_mtls_success(self, temp_registry, client_certificate):
        """Test successful mTLS authentication."""
        cert_pem, agent = client_certificate
        
        auth = Authenticator(agent_registry=temp_registry)
        result = await auth.authenticate_mtls(cert_pem)
        
        assert result.success is True
        assert result.agent_identity is not None
        assert result.agent_identity.agent_id == agent.agent_id
        assert result.method == AuthenticationMethod.MTLS
        assert result.error is None
    
    @pytest.mark.asyncio
    async def test_authenticate_mtls_invalid_cert(self, temp_registry):
        """Test mTLS authentication with invalid certificate."""
        auth = Authenticator(agent_registry=temp_registry)
        result = await auth.authenticate_mtls(b"invalid-cert-data")
        
        assert result.success is False
        assert result.agent_identity is None
        assert result.method == AuthenticationMethod.MTLS
        assert "Invalid certificate format" in result.error
    
    @pytest.mark.asyncio
    async def test_authenticate_mtls_agent_not_found(self, temp_registry):
        """Test mTLS authentication when agent not in registry."""
        # Generate certificate with non-existent agent ID
        private_key = rsa.generate_private_key(
            public_exponent=65537,
            key_size=2048,
            backend=default_backend()
        )
        
        subject = issuer = x509.Name([
            x509.NameAttribute(NameOID.COMMON_NAME, "non-existent-agent-id"),
        ])
        
        cert = x509.CertificateBuilder().subject_name(
            subject
        ).issuer_name(
            issuer
        ).public_key(
            private_key.public_key()
        ).serial_number(
            x509.random_serial_number()
        ).not_valid_before(
            datetime.utcnow()
        ).not_valid_after(
            datetime.utcnow() + timedelta(days=365)
        ).sign(private_key, hashes.SHA256(), default_backend())
        
        cert_pem = cert.public_bytes(serialization.Encoding.PEM)
        
        auth = Authenticator(agent_registry=temp_registry)
        result = await auth.authenticate_mtls(cert_pem)
        
        assert result.success is False
        assert result.agent_identity is None
        assert "Agent not found" in result.error
    
    @pytest.mark.asyncio
    async def test_authenticate_jwt_success(self, temp_registry, sample_agent, rsa_key_pair):
        """Test successful JWT authentication."""
        private_key, public_key_pem = rsa_key_pair
        
        # Create JWT token
        payload = {
            "agent_id": sample_agent.agent_id,
            "exp": datetime.utcnow() + timedelta(hours=1),
            "iat": datetime.utcnow()
        }
        
        token = jwt.encode(payload, private_key, algorithm="RS256")
        
        auth = Authenticator(
            agent_registry=temp_registry,
            jwt_public_key=public_key_pem,
            jwt_algorithm="RS256"
        )
        
        result = await auth.authenticate_jwt(token)
        
        assert result.success is True
        assert result.agent_identity is not None
        assert result.agent_identity.agent_id == sample_agent.agent_id
        assert result.method == AuthenticationMethod.JWT
        assert result.error is None
    
    @pytest.mark.asyncio
    async def test_authenticate_jwt_expired(self, temp_registry, sample_agent, rsa_key_pair):
        """Test JWT authentication with expired token."""
        private_key, public_key_pem = rsa_key_pair
        
        # Create expired JWT token
        payload = {
            "agent_id": sample_agent.agent_id,
            "exp": datetime.utcnow() - timedelta(hours=1),  # Expired
            "iat": datetime.utcnow() - timedelta(hours=2)
        }
        
        token = jwt.encode(payload, private_key, algorithm="RS256")
        
        auth = Authenticator(
            agent_registry=temp_registry,
            jwt_public_key=public_key_pem,
            jwt_algorithm="RS256"
        )
        
        result = await auth.authenticate_jwt(token)
        
        assert result.success is False
        assert result.agent_identity is None
        assert "Token expired" in result.error
    
    @pytest.mark.asyncio
    async def test_authenticate_jwt_invalid_signature(self, temp_registry, sample_agent, rsa_key_pair):
        """Test JWT authentication with invalid signature."""
        private_key, public_key_pem = rsa_key_pair
        
        # Create token with one key
        payload = {
            "agent_id": sample_agent.agent_id,
            "exp": datetime.utcnow() + timedelta(hours=1),
            "iat": datetime.utcnow()
        }
        
        token = jwt.encode(payload, private_key, algorithm="RS256")
        
        # Try to verify with different key
        different_key = rsa.generate_private_key(
            public_exponent=65537,
            key_size=2048,
            backend=default_backend()
        )
        
        different_public_key_pem = different_key.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo
        ).decode('utf-8')
        
        auth = Authenticator(
            agent_registry=temp_registry,
            jwt_public_key=different_public_key_pem,
            jwt_algorithm="RS256"
        )
        
        result = await auth.authenticate_jwt(token)
        
        assert result.success is False
        assert result.agent_identity is None
        assert "Invalid token" in result.error
    
    @pytest.mark.asyncio
    async def test_authenticate_jwt_no_public_key(self, temp_registry):
        """Test JWT authentication when no public key configured."""
        auth = Authenticator(agent_registry=temp_registry)
        result = await auth.authenticate_jwt("some-token")
        
        assert result.success is False
        assert "JWT authentication not configured" in result.error
    
    @pytest.mark.asyncio
    async def test_authenticate_api_key_success(self, temp_registry, agent_with_api_key):
        """Test successful API key authentication."""
        agent, api_key = agent_with_api_key
        
        auth = Authenticator(agent_registry=temp_registry)
        result = await auth.authenticate_api_key(api_key)
        
        assert result.success is True
        assert result.agent_identity is not None
        assert result.agent_identity.agent_id == agent.agent_id
        assert result.method == AuthenticationMethod.API_KEY
        assert result.error is None
    
    @pytest.mark.asyncio
    async def test_authenticate_api_key_invalid(self, temp_registry, agent_with_api_key):
        """Test API key authentication with invalid key."""
        agent, api_key = agent_with_api_key
        
        auth = Authenticator(agent_registry=temp_registry)
        result = await auth.authenticate_api_key("wrong-api-key")
        
        assert result.success is False
        assert result.agent_identity is None
        assert "Invalid API key" in result.error
    
    @pytest.mark.asyncio
    async def test_authenticate_api_key_no_agents_with_keys(self, temp_registry, sample_agent):
        """Test API key authentication when no agents have API keys."""
        auth = Authenticator(agent_registry=temp_registry)
        result = await auth.authenticate_api_key("any-key")
        
        assert result.success is False
        assert "Invalid API key" in result.error
    
    @pytest.mark.asyncio
    async def test_authenticate_dispatch_mtls(self, temp_registry, client_certificate):
        """Test authenticate() dispatch to mTLS."""
        cert_pem, agent = client_certificate
        
        auth = Authenticator(agent_registry=temp_registry)
        result = await auth.authenticate(
            method=AuthenticationMethod.MTLS,
            credentials={"client_cert_pem": cert_pem}
        )
        
        assert result.success is True
        assert result.method == AuthenticationMethod.MTLS
    
    @pytest.mark.asyncio
    async def test_authenticate_dispatch_jwt(self, temp_registry, sample_agent, rsa_key_pair):
        """Test authenticate() dispatch to JWT."""
        private_key, public_key_pem = rsa_key_pair
        
        payload = {
            "agent_id": sample_agent.agent_id,
            "exp": datetime.utcnow() + timedelta(hours=1),
            "iat": datetime.utcnow()
        }
        
        token = jwt.encode(payload, private_key, algorithm="RS256")
        
        auth = Authenticator(
            agent_registry=temp_registry,
            jwt_public_key=public_key_pem
        )
        
        result = await auth.authenticate(
            method=AuthenticationMethod.JWT,
            credentials={"token": token}
        )
        
        assert result.success is True
        assert result.method == AuthenticationMethod.JWT
    
    @pytest.mark.asyncio
    async def test_authenticate_dispatch_api_key(self, temp_registry, agent_with_api_key):
        """Test authenticate() dispatch to API key."""
        agent, api_key = agent_with_api_key
        
        auth = Authenticator(agent_registry=temp_registry)
        result = await auth.authenticate(
            method=AuthenticationMethod.API_KEY,
            credentials={"api_key": api_key}
        )
        
        assert result.success is True
        assert result.method == AuthenticationMethod.API_KEY
