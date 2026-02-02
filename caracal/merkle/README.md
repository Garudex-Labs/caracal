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
