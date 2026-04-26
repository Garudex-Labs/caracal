"""
Unit tests for Caracal crypto module.
"""
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.backends import default_backend
from caracal.core import crypto
from tests.mock.signing import sign_mandate_for_test, sign_merkle_root_for_test


@pytest.fixture
def ec_key_pair():
    """Generate an ECDSA P-256 key pair for testing."""
    private_key = ec.generate_private_key(ec.SECP256R1(), default_backend())
    public_key = private_key.public_key()
    
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption()
    ).decode()
    
    public_pem = public_key.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo
    ).decode()
    
    return private_pem, public_pem


@pytest.fixture
def sample_mandate():
    """Sample mandate data for testing."""
    return {
        "mandate_id": "550e8400-e29b-41d4-a716-446655440000",
        "issuer_id": "660e8400-e29b-41d4-a716-446655440000",
        "subject_id": "770e8400-e29b-41d4-a716-446655440000",
        "valid_from": "2024-01-15T10:00:00Z",
        "valid_until": "2024-01-15T11:00:00Z",
        "resource_scope": ["api:openai:gpt-4"],
        "action_scope": ["api_call"]
    }


@pytest.mark.unit
class TestSignMandate:
    """Test sign_mandate function."""
    
    def test_sign_mandate_success(self, ec_key_pair, sample_mandate):
        """Test successful mandate signing."""
        private_pem, _ = ec_key_pair
        signature = sign_mandate_for_test(sample_mandate, private_pem)
        
        assert signature is not None
        assert isinstance(signature, str)
        assert len(signature) > 0
        # Signature should be hex string
        bytes.fromhex(signature)
    
    def test_sign_mandate_empty_data(self, ec_key_pair):
        """Test signing with empty mandate data."""
        private_pem, _ = ec_key_pair
        with pytest.raises(ValueError, match="cannot be empty"):
            sign_mandate_for_test({}, private_pem)
    
    def test_sign_mandate_not_dict(self, ec_key_pair):
        """Test signing with non-dict mandate data."""
        private_pem, _ = ec_key_pair
        with pytest.raises(TypeError, match="must be a dictionary"):
            sign_mandate_for_test("not a dict", private_pem)
    
    def test_sign_mandate_empty_key(self, sample_mandate):
        """Test signing with empty private key."""
        with pytest.raises(ValueError, match="cannot be empty"):
            sign_mandate_for_test(sample_mandate, "")
    
    def test_sign_mandate_invalid_key(self, sample_mandate):
        """Test signing with invalid private key."""
        with pytest.raises(ValueError, match="Invalid private key"):
            sign_mandate_for_test(sample_mandate, "invalid key")
    
    @pytest.mark.skip(reason="ECDSA signatures are non-deterministic by default in cryptography library")
    def test_sign_mandate_deterministic(self, ec_key_pair, sample_mandate):
        """Test that signing is deterministic."""
        private_pem, _ = ec_key_pair
        sig1 = sign_mandate_for_test(sample_mandate, private_pem)
        sig2 = sign_mandate_for_test(sample_mandate, private_pem)
        
        # ECDSA with RFC 6979 should be deterministic
        assert sig1 == sig2


@pytest.mark.unit
class TestVerifyMandateSignature:
    """Test verify_mandate_signature function."""
    
    def test_verify_valid_signature(self, ec_key_pair, sample_mandate):
        """Test verifying a valid signature."""
        private_pem, public_pem = ec_key_pair
        signature = sign_mandate_for_test(sample_mandate, private_pem)
        
        is_valid = crypto.verify_mandate_signature(sample_mandate, signature, public_pem)
        assert is_valid is True
    
    def test_verify_invalid_signature(self, ec_key_pair, sample_mandate):
        """Test verifying an invalid signature."""
        _, public_pem = ec_key_pair
        invalid_sig = "0" * 128  # Invalid signature
        
        is_valid = crypto.verify_mandate_signature(sample_mandate, invalid_sig, public_pem)
        assert is_valid is False
    
    def test_verify_tampered_data(self, ec_key_pair, sample_mandate):
        """Test verifying signature with tampered data."""
        private_pem, public_pem = ec_key_pair
        signature = sign_mandate_for_test(sample_mandate, private_pem)
        
        # Tamper with the data
        tampered_mandate = sample_mandate.copy()
        tampered_mandate["mandate_id"] = "different-id"
        
        is_valid = crypto.verify_mandate_signature(tampered_mandate, signature, public_pem)
        assert is_valid is False
    
    def test_verify_empty_data(self, ec_key_pair):
        """Test verifying with empty mandate data."""
        _, public_pem = ec_key_pair
        is_valid = crypto.verify_mandate_signature({}, "signature", public_pem)
        assert is_valid is False
    
    def test_verify_not_dict(self, ec_key_pair):
        """Test verifying with non-dict mandate data."""
        _, public_pem = ec_key_pair
        is_valid = crypto.verify_mandate_signature("not a dict", "signature", public_pem)
        assert is_valid is False
    
    def test_verify_empty_signature(self, ec_key_pair, sample_mandate):
        """Test verifying with empty signature."""
        _, public_pem = ec_key_pair
        is_valid = crypto.verify_mandate_signature(sample_mandate, "", public_pem)
        assert is_valid is False
    
    def test_verify_empty_public_key(self, sample_mandate):
        """Test verifying with empty public key."""
        is_valid = crypto.verify_mandate_signature(sample_mandate, "signature", "")
        assert is_valid is False
    
    def test_verify_invalid_public_key(self, sample_mandate):
        """Test verifying with invalid public key."""
        is_valid = crypto.verify_mandate_signature(sample_mandate, "signature", "invalid key")
        assert is_valid is False


@pytest.mark.unit
class TestSignMerkleRoot:
    """Test sign_merkle_root function."""
    
    def test_sign_merkle_root_success(self, ec_key_pair):
        """Test successful Merkle root signing."""
        private_pem, _ = ec_key_pair
        merkle_root = b"0" * 32  # 32-byte hash
        
        signature = sign_merkle_root_for_test(merkle_root, private_pem)
        
        assert signature is not None
        assert isinstance(signature, str)
        assert len(signature) > 0
        bytes.fromhex(signature)
    
    def test_sign_merkle_root_empty(self, ec_key_pair):
        """Test signing empty Merkle root."""
        private_pem, _ = ec_key_pair
        with pytest.raises(ValueError, match="cannot be empty"):
            sign_merkle_root_for_test(b"", private_pem)
    
    def test_sign_merkle_root_wrong_size(self, ec_key_pair):
        """Test signing Merkle root with wrong size."""
        private_pem, _ = ec_key_pair
        with pytest.raises(ValueError, match="must be 32 bytes"):
            sign_merkle_root_for_test(b"0" * 16, private_pem)
    
    def test_sign_merkle_root_empty_key(self):
        """Test signing with empty private key."""
        merkle_root = b"0" * 32
        with pytest.raises(ValueError, match="cannot be empty"):
            sign_merkle_root_for_test(merkle_root, "")
    
    def test_sign_merkle_root_invalid_key(self):
        """Test signing with invalid private key."""
        merkle_root = b"0" * 32
        with pytest.raises(ValueError, match="Invalid private key"):
            sign_merkle_root_for_test(merkle_root, "invalid key")


@pytest.mark.unit
class TestVerifyMerkleRoot:
    """Test verify_merkle_root function."""
    
    def test_verify_merkle_root_valid(self, ec_key_pair):
        """Test verifying valid Merkle root signature."""
        private_pem, public_pem = ec_key_pair
        merkle_root = b"0" * 32
        
        signature = sign_merkle_root_for_test(merkle_root, private_pem)
        is_valid = crypto.verify_merkle_root(merkle_root, signature, public_pem)
        
        assert is_valid is True
    
    def test_verify_merkle_root_invalid_signature(self, ec_key_pair):
        """Test verifying invalid Merkle root signature."""
        _, public_pem = ec_key_pair
        merkle_root = b"0" * 32
        invalid_sig = "0" * 128
        
        is_valid = crypto.verify_merkle_root(merkle_root, invalid_sig, public_pem)
        assert is_valid is False
    
    def test_verify_merkle_root_tampered(self, ec_key_pair):
        """Test verifying signature with tampered Merkle root."""
        private_pem, public_pem = ec_key_pair
        merkle_root = b"0" * 32
        signature = sign_merkle_root_for_test(merkle_root, private_pem)
        
        tampered_root = b"1" * 32
        is_valid = crypto.verify_merkle_root(tampered_root, signature, public_pem)
        assert is_valid is False
    
    def test_verify_merkle_root_empty(self, ec_key_pair):
        """Test verifying empty Merkle root."""
        _, public_pem = ec_key_pair
        is_valid = crypto.verify_merkle_root(b"", "signature", public_pem)
        assert is_valid is False
    
    def test_verify_merkle_root_wrong_size(self, ec_key_pair):
        """Test verifying Merkle root with wrong size."""
        _, public_pem = ec_key_pair
        is_valid = crypto.verify_merkle_root(b"0" * 16, "signature", public_pem)
        assert is_valid is False
    
    def test_verify_merkle_root_empty_signature(self, ec_key_pair):
        """Test verifying with empty signature."""
        _, public_pem = ec_key_pair
        merkle_root = b"0" * 32
        is_valid = crypto.verify_merkle_root(merkle_root, "", public_pem)
        assert is_valid is False
    
    def test_verify_merkle_root_empty_public_key(self):
        """Test verifying with empty public key."""
        merkle_root = b"0" * 32
        is_valid = crypto.verify_merkle_root(merkle_root, "signature", "")
        assert is_valid is False


@pytest.mark.unit
class TestCryptoIntegration:
    """Integration tests for crypto functions."""
    
    def test_sign_and_verify_roundtrip(self, ec_key_pair, sample_mandate):
        """Test complete sign and verify roundtrip."""
        private_pem, public_pem = ec_key_pair
        
        # Sign
        signature = sign_mandate_for_test(sample_mandate, private_pem)
        
        # Verify
        is_valid = crypto.verify_mandate_signature(sample_mandate, signature, public_pem)
        
        assert is_valid is True
    
    def test_merkle_sign_and_verify_roundtrip(self, ec_key_pair):
        """Test complete Merkle root sign and verify roundtrip."""
        private_pem, public_pem = ec_key_pair
        merkle_root = b"a" * 32
        
        # Sign
        signature = sign_merkle_root_for_test(merkle_root, private_pem)
        
        # Verify
        is_valid = crypto.verify_merkle_root(merkle_root, signature, public_pem)
        
        assert is_valid is True
    
    def test_different_keys_fail_verification(self, sample_mandate):
        """Test that verification fails with different keys."""
        # Generate two different key pairs
        private_key1 = ec.generate_private_key(ec.SECP256R1(), default_backend())
        private_key2 = ec.generate_private_key(ec.SECP256R1(), default_backend())
        
        private_pem1 = private_key1.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption()
        ).decode()
        
        public_pem2 = private_key2.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo
        ).decode()
        
        # Sign with key1, verify with key2
        signature = sign_mandate_for_test(sample_mandate, private_pem1)
        is_valid = crypto.verify_mandate_signature(sample_mandate, signature, public_pem2)
        
        assert is_valid is False
