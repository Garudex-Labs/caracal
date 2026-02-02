# Merkle Tree Implementation

This module provides a cryptographic Merkle tree implementation for ensuring ledger integrity in Caracal Core v0.3.

## Overview

A Merkle tree is a binary tree where each leaf node contains a hash of data, and each internal node contains a hash of its children. This structure enables:

- **Tamper Detection**: Any modification to the data changes the root hash
- **Efficient Proofs**: Prove inclusion of data with O(log n) proof size
- **Batch Verification**: Verify integrity of large datasets efficiently

## Components

### MerkleTree

The main class for constructing and working with Merkle trees.

```python
from caracal.merkle.tree import MerkleTree

# Create tree from leaf data
leaves = [b"data1", b"data2", b"data3", b"data4"]
tree = MerkleTree(leaves)

# Get root hash
root = tree.get_root()

# Generate proof for a leaf
proof = tree.generate_proof(0)

# Verify proof
is_valid = MerkleTree.verify_proof(leaves[0], proof, root)
```

### MerkleProof

A dataclass representing a Merkle proof of inclusion.

```python
@dataclass
class MerkleProof:
    leaf_hash: bytes              # Hash of the leaf being proven
    proof_hashes: List[bytes]     # Sibling hashes from leaf to root
    proof_directions: List[str]   # "left" or "right" for each sibling
    root_hash: bytes              # Expected root hash
```

## Implementation Details

### Hashing Algorithm

- Uses SHA-256 for all hashing operations
- Internal nodes are computed as: `SHA256(left_child || right_child)`
- Leaf nodes are computed as: `SHA256(leaf_data)`

### Tree Construction

1. Hash each leaf with SHA-256
2. Build tree bottom-up by hashing pairs of nodes
3. If odd number of nodes at any level, duplicate the last node
4. Continue until reaching a single root node

### Proof Generation

1. Start at the leaf node
2. Collect sibling hash at each level
3. Record whether sibling is on left or right
4. Continue up to the root
5. Return proof with all sibling hashes and directions

### Proof Verification

1. Start with the leaf hash
2. For each proof element:
   - If direction is "left": `hash = SHA256(sibling || current)`
   - If direction is "right": `hash = SHA256(current || sibling)`
3. Compare final hash with expected root
4. Return true if they match

## Usage in Caracal

The Merkle tree is used in Caracal Core v0.3 to provide cryptographic tamper-evidence for the ledger:

1. **Batching**: Ledger events are grouped into batches
2. **Tree Construction**: A Merkle tree is built over each batch
3. **Root Signing**: The root hash is cryptographically signed
4. **Verification**: Any event can be proven to be in the ledger
5. **Tamper Detection**: Any modification to events is detectable

## Requirements Validated

This implementation validates the following requirements from the v0.3 spec:

- **Requirement 3.2**: Merkle tree computation over event batches
- **Requirement 3.3**: Merkle root hash computation
- **Requirement 3.6**: Merkle proof generation
- **Requirement 3.7**: Merkle proof verification

## Testing

Comprehensive unit tests are provided in `tests/unit/test_merkle_tree.py`:

- Tree construction with various leaf counts
- Proof generation and verification
- Tamper detection
- Edge cases (single leaf, odd numbers, large trees)
- Error handling

Run tests with:
```bash
pytest tests/unit/test_merkle_tree.py -v
```

## Performance Characteristics

- **Tree Construction**: O(n) where n is the number of leaves
- **Proof Generation**: O(log n)
- **Proof Verification**: O(log n)
- **Space Complexity**: O(n) for tree storage

## Security Considerations

- Uses SHA-256, a cryptographically secure hash function
- Collision resistance ensures tamper detection
- Proof size grows logarithmically with tree size
- No secret keys required (public verification)

## Future Enhancements

Potential improvements for future versions:

- Support for different hash algorithms (SHA-512, Blake2)
- Sparse Merkle trees for efficient updates
- Parallel tree construction for large batches
- Proof compression for storage efficiency


## Merkle Batcher and Signer (v0.3)

### MerkleBatcher

Accumulates events into batches and triggers Merkle tree computation.

```python
from caracal.merkle import MerkleBatcher, SoftwareSigner

# Create signer
signer = SoftwareSigner("/path/to/private_key.pem")

# Create batcher with configurable thresholds
batcher = MerkleBatcher(
    merkle_signer=signer,
    batch_size_limit=1000,  # Max events per batch
    batch_timeout_seconds=300,  # Max time before batch closes (5 minutes)
)

# Add events
await batcher.add_event(event_id=1, event_hash=hash1)
await batcher.add_event(event_id=2, event_hash=hash2)

# Batch automatically closes when threshold reached
```

**Batch Configuration Trade-offs**:

- **Smaller batches** (more frequent signing):
  - Pros: Faster tamper detection, finer-grained audit trails
  - Cons: Higher storage costs, more signature operations
  
- **Larger batches** (less frequent signing):
  - Pros: Lower storage costs, better throughput
  - Cons: Slower tamper detection, coarser audit trails

**Recommended configurations**:
- High-compliance: 1000 events / 5 minutes
- Standard: 10000 events / 1 hour
- Low-volume: 50000 events / 24 hours

### MerkleSigner

Pluggable signing backend for Merkle roots.

**SoftwareSigner** (OSS default):
```python
from caracal.merkle import SoftwareSigner

# Create signer with private key
signer = SoftwareSigner("/path/to/private_key.pem")

# Sign Merkle root
signature = await signer.sign_root(merkle_root, batch)

# Verify signature
is_valid = await signer.verify_signature(merkle_root, signature.signature)
```

### KeyManager

Manages cryptographic keys for Merkle signing.

```python
from caracal.merkle import KeyManager

key_manager = KeyManager(audit_log_path="/var/log/caracal/keys.log")

# Generate new key pair
key_manager.generate_key_pair(
    "/path/to/private.pem",
    "/path/to/public.pem",
    passphrase="secure_passphrase"
)

# Verify key
is_valid = key_manager.verify_key("/path/to/private.pem", passphrase="secure_passphrase")

# Rotate key
key_manager.rotate_key(
    "/path/to/old.pem",
    "/path/to/new.pem",
    "/path/to/new.pub",
    passphrase="secure_passphrase"
)
```

## CLI Commands

### Generate Key Pair

```bash
# Generate key without passphrase
caracal merkle generate-key \
  -k /etc/caracal/keys/merkle-signing-key.pem \
  -p /etc/caracal/keys/merkle-signing-key.pub

# Generate key with passphrase
caracal merkle generate-key \
  -k /etc/caracal/keys/merkle-signing-key.pem \
  -p /etc/caracal/keys/merkle-signing-key.pub \
  -P "secure_passphrase"
```

### Verify Key

```bash
caracal merkle verify-key -k /etc/caracal/keys/merkle-signing-key.pem
```

### Rotate Key

```bash
caracal merkle rotate-key \
  -o /etc/caracal/keys/old.pem \
  -n /etc/caracal/keys/new.pem \
  -p /etc/caracal/keys/new.pub
```

## Configuration

Add Merkle configuration to your `config.yaml`:

```yaml
merkle:
  batch_size_limit: 1000
  batch_timeout_seconds: 300
  signing_algorithm: ES256
  signing_backend: software
  private_key_path: /etc/caracal/keys/merkle-signing-key.pem
  key_encryption_passphrase: ${MERKLE_KEY_PASSPHRASE}
```

## Security Best Practices

1. **Key Storage**: Store private keys with restricted permissions (600)
2. **Key Backup**: Backup private keys to secure offline storage
3. **Key Rotation**: Rotate keys periodically (e.g., annually)
4. **Environment Variables**: Use environment variables for passphrases
5. **Audit Logging**: Enable audit logging for all key operations
