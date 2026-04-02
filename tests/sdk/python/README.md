# Python SDK Tests

## Overview

This directory will contain tests for the Caracal Python SDK once it stabilizes.

## Planned Structure

```
python/
├── README.md (this file)
├── unit/
│   ├── test_client.py
│   ├── test_authority_client.py
│   ├── test_mandate_client.py
│   ├── test_delegation_client.py
│   ├── test_secrets_client.py
│   └── test_async_client.py
└── integration/
    ├── test_authority_workflow.py
    ├── test_mandate_workflow.py
    ├── test_delegation_workflow.py
    └── test_secrets_workflow.py
```

## Test Framework

- **Framework**: pytest >= 7.0.0
- **Async Support**: pytest-asyncio >= 0.23.0
- **Mocking**: unittest.mock or pytest-mock
- **Coverage**: pytest-cov >= 4.0.0
- **HTTP Mocking**: responses or httpx-mock

## Test Guidelines

### Unit Tests

Test SDK client methods in isolation using mocks:

```python
import pytest
from unittest.mock import Mock, patch
from caracal_sdk import CaracalClient

class TestCaracalClient:
    """Unit tests for CaracalClient."""
    
    def test_client_initialization(self):
        """Test client initializes with correct config."""
        client = CaracalClient(
            api_url="http://localhost:8000",
            api_key="test-key"
        )
        assert client.api_url == "http://localhost:8000"
        assert client.api_key == "test-key"
    
    def test_client_default_config(self):
        """Test client uses default configuration."""
        client = CaracalClient()
        assert client.api_url is not None
        assert client.timeout > 0
    
    @patch('caracal_sdk.client.httpx.Client.post')
    def test_create_authority(self, mock_post):
        """Test authority creation method."""
        # Arrange
        mock_post.return_value = Mock(
            status_code=201,
            json=lambda: {"id": "auth-123", "name": "test-authority"}
        )
        client = CaracalClient()
        
        # Act
        authority = client.create_authority(
            name="test-authority",
            scope="read:secrets"
        )
        
        # Assert
        assert authority["id"] == "auth-123"
        assert authority["name"] == "test-authority"
        mock_post.assert_called_once()


@pytest.mark.asyncio
class TestAsyncCaracalClient:
    """Unit tests for async CaracalClient."""
    
    async def test_async_client_initialization(self):
        """Test async client initializes correctly."""
        from caracal_sdk import AsyncCaracalClient
        
        client = AsyncCaracalClient(api_url="http://localhost:8000")
        assert client.api_url == "http://localhost:8000"
    
    @patch('caracal_sdk.async_client.httpx.AsyncClient.post')
    async def test_async_create_authority(self, mock_post):
        """Test async authority creation."""
        from caracal_sdk import AsyncCaracalClient
        
        # Arrange
        mock_post.return_value = Mock(
            status_code=201,
            json=lambda: {"id": "auth-123", "name": "test-authority"}
        )
        client = AsyncCaracalClient()
        
        # Act
        authority = await client.create_authority(
            name="test-authority",
            scope="read:secrets"
        )
        
        # Assert
        assert authority["id"] == "auth-123"
```

### Integration Tests

Test SDK against live Caracal broker:

```python
import pytest
from caracal_sdk import CaracalClient

@pytest.mark.integration
class TestAuthorityWorkflow:
    """Integration tests for authority workflows."""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Set up test client."""
        self.client = CaracalClient(
            api_url="http://localhost:8000",
            api_key="test-key"
        )
    
    def test_authority_lifecycle(self):
        """Test complete authority lifecycle through SDK."""
        # Create authority
        authority = self.client.create_authority(
            name="test-authority",
            scope="read:secrets"
        )
        assert authority["id"] is not None
        assert authority["name"] == "test-authority"
        
        # Get authority
        retrieved = self.client.get_authority(authority["id"])
        assert retrieved["id"] == authority["id"]
        assert retrieved["name"] == "test-authority"
        
        # List authorities
        authorities = self.client.list_authorities()
        assert any(a["id"] == authority["id"] for a in authorities)
        
        # Delete authority
        self.client.delete_authority(authority["id"])
        
        # Verify deletion
        with pytest.raises(Exception):
            self.client.get_authority(authority["id"])


@pytest.mark.integration
@pytest.mark.asyncio
class TestMandateWorkflow:
    """Integration tests for mandate workflows."""
    
    @pytest.fixture(autouse=True)
    async def setup(self):
        """Set up test client and authority."""
        from caracal_sdk import AsyncCaracalClient
        
        self.client = AsyncCaracalClient(
            api_url="http://localhost:8000",
            api_key="test-key"
        )
        
        # Create test authority
        self.authority = await self.client.create_authority(
            name="test-authority",
            scope="read:secrets"
        )
    
    async def test_mandate_lifecycle(self):
        """Test complete mandate lifecycle."""
        # Create mandate
        mandate = await self.client.create_mandate(
            authority_id=self.authority["id"],
            principal_id="user-123",
            scope="read:secrets"
        )
        assert mandate["id"] is not None
        
        # Verify mandate
        is_valid = await self.client.verify_mandate(mandate["id"])
        assert is_valid is True
        
        # Revoke mandate
        await self.client.revoke_mandate(mandate["id"])
        
        # Verify revocation
        is_valid = await self.client.verify_mandate(mandate["id"])
        assert is_valid is False
```

## Running Tests

```bash
# Run all Python SDK tests
pytest tests/sdk/python/

# Run only unit tests
pytest tests/sdk/python/unit/

# Run only integration tests
pytest tests/sdk/python/integration/ -m integration

# Run with coverage
pytest tests/sdk/python/ --cov=caracal_sdk --cov-report=html

# Run async tests only
pytest tests/sdk/python/ -m asyncio

# Run in parallel
pytest tests/sdk/python/ -n auto
```

## Test Markers

Use pytest markers to categorize tests:

```python
@pytest.mark.unit          # Unit tests
@pytest.mark.integration   # Integration tests
@pytest.mark.asyncio       # Async tests
@pytest.mark.slow          # Slow-running tests
```

## Environment Setup

Integration tests require:

1. Running Caracal broker:
   ```bash
   docker-compose up -d
   ```

2. Environment variables:
   ```bash
   export CARACAL_API_URL=http://localhost:8000
   export CARACAL_API_KEY=test-key
   ```

3. Test database:
   ```bash
   caracal db init --test
   ```

## Status

**Not yet implemented** - SDK is subject to change.
Add tests here once the Python SDK API stabilizes.

## Contributing

When adding tests:
1. Follow the examples above
2. Use descriptive test names
3. Add docstrings to all test methods
4. Mock external dependencies in unit tests
5. Clean up resources in integration tests
6. Update this README with new patterns
