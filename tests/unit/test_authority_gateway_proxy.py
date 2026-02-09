"""
Unit tests for Authority Gateway Proxy.

Tests the authority enforcement gateway functionality:
- Request interception
- Mandate extraction and validation
- Request forwarding and blocking
- Decorator pattern (require_authority)
- Middleware pattern (AuthorityMiddleware)
- Adapter pattern (AuthorityAdapter)
"""

import pytest
from datetime import datetime, timedelta
from unittest.mock import Mock, MagicMock, patch
from uuid import uuid4

from caracal.gateway.authority_proxy import (
    AuthorityGatewayProxy,
    require_authority,
    AuthorityMiddleware,
    AuthorityAdapter,
    OpenAIAdapter,
    AnthropicAdapter,
    Request,
    Response,
)
from caracal.core.authority import AuthorityEvaluator, AuthorityDecision
from caracal.core.authority_ledger import AuthorityLedgerWriter
from caracal.db.models import ExecutionMandate, Principal
from caracal.exceptions import AuthorityDeniedError


@pytest.fixture
def mock_db_session():
    """Create a mock database session."""
    return Mock()


@pytest.fixture
def mock_authority_evaluator():
    """Create a mock authority evaluator."""
    return Mock(spec=AuthorityEvaluator)


@pytest.fixture
def mock_ledger_writer():
    """Create a mock ledger writer."""
    return Mock(spec=AuthorityLedgerWriter)


@pytest.fixture
def sample_principal():
    """Create a sample principal."""
    return Principal(
        principal_id=uuid4(),
        name="test-principal",
        principal_type="agent",
        owner="test@example.com",
        public_key_pem="test-public-key",
        private_key_pem="test-private-key"
    )


@pytest.fixture
def sample_mandate(sample_principal):
    """Create a sample execution mandate."""
    mandate_id = uuid4()
    valid_from = datetime.utcnow()
    valid_until = valid_from + timedelta(hours=1)
    
    return ExecutionMandate(
        mandate_id=mandate_id,
        issuer_id=sample_principal.principal_id,
        subject_id=sample_principal.principal_id,
        valid_from=valid_from,
        valid_until=valid_until,
        resource_scope=["api:*", "database:users:*"],
        action_scope=["read", "write"],
        signature="test-signature",
        revoked=False,
        delegation_depth=0
    )


@pytest.fixture
def gateway_proxy(mock_authority_evaluator, mock_ledger_writer, mock_db_session):
    """Create an AuthorityGatewayProxy instance for testing."""
    return AuthorityGatewayProxy(
        authority_evaluator=mock_authority_evaluator,
        ledger_writer=mock_ledger_writer,
        db_session=mock_db_session
    )


class TestAuthorityGatewayProxyInitialization:
    """Test AuthorityGatewayProxy initialization."""
    
    def test_initialization(self, gateway_proxy):
        """Test that AuthorityGatewayProxy initializes correctly."""
        assert gateway_proxy.authority_evaluator is not None
        assert gateway_proxy.ledger_writer is not None
        assert gateway_proxy.db_session is not None


class TestMandateExtraction:
    """Test mandate extraction from requests."""
    
    def test_extract_mandate_from_x_execution_mandate_header(self, gateway_proxy):
        """Test extracting mandate from X-Execution-Mandate header."""
        mandate_id = str(uuid4())
        request = Request(
            headers={"X-Execution-Mandate": mandate_id},
            method="GET",
            path="/api/users"
        )
        
        extracted = gateway_proxy._extract_mandate_from_header(request)
        assert extracted == mandate_id
    
    def test_extract_mandate_from_authorization_header(self, gateway_proxy):
        """Test extracting mandate from Authorization Bearer header."""
        mandate_id = str(uuid4())
        request = Request(
            headers={"Authorization": f"Bearer {mandate_id}"},
            method="GET",
            path="/api/users"
        )
        
        extracted = gateway_proxy._extract_mandate_from_header(request)
        assert extracted == mandate_id
    
    def test_extract_mandate_no_header(self, gateway_proxy):
        """Test extracting mandate when no header is present."""
        request = Request(
            headers={},
            method="GET",
            path="/api/users"
        )
        
        extracted = gateway_proxy._extract_mandate_from_header(request)
        assert extracted is None


class TestActionAndResourceExtraction:
    """Test action and resource extraction from requests."""
    
    def test_extract_action_from_http_method(self, gateway_proxy):
        """Test extracting action from HTTP method."""
        request = Request(
            headers={},
            method="GET",
            path="/api/users"
        )
        
        action, resource = gateway_proxy._extract_action_and_resource(request)
        assert action == "read"
        assert resource == "/api/users"
    
    def test_extract_action_from_request_body(self, gateway_proxy):
        """Test extracting action from request body."""
        request = Request(
            headers={},
            method="POST",
            path="/api/execute",
            body={"action": "custom_action", "resource": "custom:resource"}
        )
        
        action, resource = gateway_proxy._extract_action_and_resource(request)
        assert action == "custom_action"
        assert resource == "custom:resource"


class TestRequestInterception:
    """Test request interception and validation."""
    
    def test_intercept_request_no_mandate(self, gateway_proxy):
        """Test intercepting request with no mandate."""
        request = Request(
            headers={},
            method="GET",
            path="/api/users"
        )
        
        response = gateway_proxy.intercept_request(request)
        
        assert response.status_code == 403
        assert response.body["allowed"] is False
        assert response.body["error"]["code"] == "MANDATE_NOT_PROVIDED"
    
    def test_intercept_request_mandate_not_found(self, gateway_proxy, mock_db_session):
        """Test intercepting request with mandate not found in database."""
        mandate_id = str(uuid4())
        request = Request(
            headers={"X-Execution-Mandate": mandate_id},
            method="GET",
            path="/api/users"
        )
        
        # Mock database query to return None
        mock_db_session.query.return_value.filter.return_value.first.return_value = None
        
        response = gateway_proxy.intercept_request(request)
        
        assert response.status_code == 403
        assert response.body["allowed"] is False
        assert response.body["error"]["code"] == "MANDATE_NOT_FOUND"
    
    def test_intercept_request_validation_denied(
        self,
        gateway_proxy,
        mock_db_session,
        mock_authority_evaluator,
        sample_mandate
    ):
        """Test intercepting request with mandate validation denied."""
        mandate_id = str(sample_mandate.mandate_id)
        request = Request(
            headers={"X-Execution-Mandate": mandate_id},
            method="GET",
            path="/api/users"
        )
        
        # Mock database query to return mandate
        mock_db_session.query.return_value.filter.return_value.first.return_value = sample_mandate
        
        # Mock authority evaluator to deny
        mock_authority_evaluator.validate_mandate.return_value = AuthorityDecision(
            allowed=False,
            reason="Mandate expired",
            mandate_id=sample_mandate.mandate_id,
            principal_id=sample_mandate.subject_id
        )
        
        response = gateway_proxy.intercept_request(request)
        
        assert response.status_code == 403
        assert response.body["allowed"] is False
        assert "Mandate expired" in response.body["error"]["message"]
    
    def test_intercept_request_validation_allowed(
        self,
        gateway_proxy,
        mock_db_session,
        mock_authority_evaluator,
        sample_mandate
    ):
        """Test intercepting request with mandate validation allowed."""
        mandate_id = str(sample_mandate.mandate_id)
        request = Request(
            headers={"X-Execution-Mandate": mandate_id},
            method="GET",
            path="/api/users"
        )
        
        # Mock database query to return mandate
        mock_db_session.query.return_value.filter.return_value.first.return_value = sample_mandate
        
        # Mock authority evaluator to allow
        mock_authority_evaluator.validate_mandate.return_value = AuthorityDecision(
            allowed=True,
            reason="Mandate valid",
            mandate_id=sample_mandate.mandate_id,
            principal_id=sample_mandate.subject_id
        )
        
        response = gateway_proxy.intercept_request(request)
        
        assert response.status_code == 200
        assert response.body["allowed"] is True
    
    def test_intercept_request_with_forward_function(
        self,
        gateway_proxy,
        mock_db_session,
        mock_authority_evaluator,
        sample_mandate
    ):
        """Test intercepting request with custom forward function."""
        mandate_id = str(sample_mandate.mandate_id)
        request = Request(
            headers={"X-Execution-Mandate": mandate_id},
            method="GET",
            path="/api/users"
        )
        
        # Mock database query to return mandate
        mock_db_session.query.return_value.filter.return_value.first.return_value = sample_mandate
        
        # Mock authority evaluator to allow
        mock_authority_evaluator.validate_mandate.return_value = AuthorityDecision(
            allowed=True,
            reason="Mandate valid",
            mandate_id=sample_mandate.mandate_id,
            principal_id=sample_mandate.subject_id
        )
        
        # Mock forward function
        mock_forward = Mock(return_value=Response(
            status_code=200,
            body={"data": "test"}
        ))
        
        response = gateway_proxy.intercept_request(
            request=request,
            forward_request=mock_forward
        )
        
        assert response.status_code == 200
        assert response.body["data"] == "test"
        mock_forward.assert_called_once()


class TestRequireAuthorityDecorator:
    """Test require_authority decorator."""
    
    def test_decorator_with_valid_mandate(self, mock_db_session, sample_mandate):
        """Test decorator allows function execution with valid mandate."""
        
        @require_authority(action="read", resource="database:users")
        def test_function(mandate, db_session):
            return "success"
        
        # Mock authority evaluator to allow
        with patch('caracal.gateway.authority_proxy.AuthorityEvaluator') as mock_evaluator_class:
            mock_evaluator = Mock()
            mock_evaluator.validate_mandate.return_value = AuthorityDecision(
                allowed=True,
                reason="Valid mandate"
            )
            mock_evaluator_class.return_value = mock_evaluator
            
            result = test_function(mandate=sample_mandate, db_session=mock_db_session)
            assert result == "success"
    
    def test_decorator_with_invalid_mandate(self, mock_db_session, sample_mandate):
        """Test decorator blocks function execution with invalid mandate."""
        
        @require_authority(action="read", resource="database:users")
        def test_function(mandate, db_session):
            return "success"
        
        # Mock authority evaluator to deny
        with patch('caracal.gateway.authority_proxy.AuthorityEvaluator') as mock_evaluator_class:
            mock_evaluator = Mock()
            mock_evaluator.validate_mandate.return_value = AuthorityDecision(
                allowed=False,
                reason="Mandate expired"
            )
            mock_evaluator_class.return_value = mock_evaluator
            
            with pytest.raises(AuthorityDeniedError) as exc_info:
                test_function(mandate=sample_mandate, db_session=mock_db_session)
            
            assert "Mandate expired" in str(exc_info.value)
    
    def test_decorator_without_mandate_parameter(self, mock_db_session):
        """Test decorator raises error when mandate parameter is missing."""
        
        @require_authority(action="read", resource="database:users")
        def test_function(db_session):
            return "success"
        
        with pytest.raises(ValueError) as exc_info:
            test_function(db_session=mock_db_session)
        
        assert "No mandate provided" in str(exc_info.value)


class TestAuthorityMiddleware:
    """Test AuthorityMiddleware for HTTP services."""
    
    def test_middleware_initialization(
        self,
        mock_authority_evaluator,
        mock_ledger_writer,
        mock_db_session
    ):
        """Test middleware initializes correctly."""
        app = Mock()
        middleware = AuthorityMiddleware(
            app=app,
            authority_evaluator=mock_authority_evaluator,
            ledger_writer=mock_ledger_writer,
            db_session=mock_db_session
        )
        
        assert middleware.app == app
        assert middleware.authority_evaluator == mock_authority_evaluator
        assert middleware.ledger_writer == mock_ledger_writer
        assert middleware.db_session == mock_db_session
        assert middleware.gateway_proxy is not None
    
    def test_middleware_exempt_path(
        self,
        mock_authority_evaluator,
        mock_ledger_writer,
        mock_db_session
    ):
        """Test middleware skips validation for exempt paths."""
        app = Mock()
        middleware = AuthorityMiddleware(
            app=app,
            authority_evaluator=mock_authority_evaluator,
            ledger_writer=mock_ledger_writer,
            db_session=mock_db_session,
            exempt_paths=["/health"]
        )
        
        environ = {
            "PATH_INFO": "/health",
            "REQUEST_METHOD": "GET"
        }
        start_response = Mock()
        
        # Should forward to app without validation
        middleware(environ, start_response)
        app.assert_called_once()


class TestAuthorityAdapter:
    """Test AuthorityAdapter base class."""
    
    def test_adapter_initialization(
        self,
        mock_authority_evaluator,
        mock_ledger_writer,
        mock_db_session
    ):
        """Test adapter initializes correctly."""
        adapter = AuthorityAdapter(
            authority_evaluator=mock_authority_evaluator,
            ledger_writer=mock_ledger_writer,
            db_session=mock_db_session
        )
        
        assert adapter.authority_evaluator == mock_authority_evaluator
        assert adapter.ledger_writer == mock_ledger_writer
        assert adapter.db_session == mock_db_session
    
    def test_validate_and_call_allowed(
        self,
        mock_authority_evaluator,
        mock_ledger_writer,
        mock_db_session,
        sample_mandate
    ):
        """Test validate_and_call allows API call with valid mandate."""
        adapter = AuthorityAdapter(
            authority_evaluator=mock_authority_evaluator,
            ledger_writer=mock_ledger_writer,
            db_session=mock_db_session
        )
        
        # Mock authority evaluator to allow
        mock_authority_evaluator.validate_mandate.return_value = AuthorityDecision(
            allowed=True,
            reason="Valid mandate"
        )
        
        # Mock API call
        mock_api_call = Mock(return_value="api_result")
        
        result = adapter.validate_and_call(
            mandate=sample_mandate,
            action="api_call",
            resource="api:test",
            api_call=mock_api_call,
            arg1="value1"
        )
        
        assert result == "api_result"
        mock_api_call.assert_called_once_with("value1")
    
    def test_validate_and_call_denied(
        self,
        mock_authority_evaluator,
        mock_ledger_writer,
        mock_db_session,
        sample_mandate
    ):
        """Test validate_and_call blocks API call with invalid mandate."""
        adapter = AuthorityAdapter(
            authority_evaluator=mock_authority_evaluator,
            ledger_writer=mock_ledger_writer,
            db_session=mock_db_session
        )
        
        # Mock authority evaluator to deny
        mock_authority_evaluator.validate_mandate.return_value = AuthorityDecision(
            allowed=False,
            reason="Mandate expired"
        )
        
        # Mock API call
        mock_api_call = Mock(return_value="api_result")
        
        with pytest.raises(AuthorityDeniedError) as exc_info:
            adapter.validate_and_call(
                mandate=sample_mandate,
                action="api_call",
                resource="api:test",
                api_call=mock_api_call
            )
        
        assert "Mandate expired" in str(exc_info.value)
        mock_api_call.assert_not_called()


class TestOpenAIAdapter:
    """Test OpenAI API adapter."""
    
    def test_chat_completion(
        self,
        mock_authority_evaluator,
        mock_ledger_writer,
        mock_db_session,
        sample_mandate
    ):
        """Test OpenAI chat completion with authority validation."""
        adapter = OpenAIAdapter(
            authority_evaluator=mock_authority_evaluator,
            ledger_writer=mock_ledger_writer,
            db_session=mock_db_session
        )
        
        # Mock authority evaluator to allow
        mock_authority_evaluator.validate_mandate.return_value = AuthorityDecision(
            allowed=True,
            reason="Valid mandate"
        )
        
        result = adapter.chat_completion(
            mandate=sample_mandate,
            model="gpt-4",
            messages=[{"role": "user", "content": "Hello"}]
        )
        
        assert result["model"] == "gpt-4"
        assert result["messages"] == [{"role": "user", "content": "Hello"}]


class TestAnthropicAdapter:
    """Test Anthropic API adapter."""
    
    def test_messages_create(
        self,
        mock_authority_evaluator,
        mock_ledger_writer,
        mock_db_session,
        sample_mandate
    ):
        """Test Anthropic messages create with authority validation."""
        adapter = AnthropicAdapter(
            authority_evaluator=mock_authority_evaluator,
            ledger_writer=mock_ledger_writer,
            db_session=mock_db_session
        )
        
        # Mock authority evaluator to allow
        mock_authority_evaluator.validate_mandate.return_value = AuthorityDecision(
            allowed=True,
            reason="Valid mandate"
        )
        
        result = adapter.messages_create(
            mandate=sample_mandate,
            model="claude-3-opus",
            messages=[{"role": "user", "content": "Hello"}]
        )
        
        assert result["model"] == "claude-3-opus"
        assert result["messages"] == [{"role": "user", "content": "Hello"}]


class TestErrorCodeMapping:
    """Test error code mapping from denial reasons."""
    
    def test_expired_mandate_error_code(self, gateway_proxy):
        """Test error code for expired mandate."""
        code = gateway_proxy._get_error_code("Mandate has expired")
        assert code == "MANDATE_EXPIRED"
    
    def test_revoked_mandate_error_code(self, gateway_proxy):
        """Test error code for revoked mandate."""
        code = gateway_proxy._get_error_code("Mandate is revoked")
        assert code == "MANDATE_REVOKED"
    
    def test_invalid_signature_error_code(self, gateway_proxy):
        """Test error code for invalid signature."""
        code = gateway_proxy._get_error_code("Invalid signature")
        assert code == "MANDATE_INVALID_SIGNATURE"
    
    def test_action_not_in_scope_error_code(self, gateway_proxy):
        """Test error code for action not in scope."""
        code = gateway_proxy._get_error_code("Action not in scope")
        assert code == "ACTION_NOT_IN_SCOPE"
    
    def test_resource_not_in_scope_error_code(self, gateway_proxy):
        """Test error code for resource not in scope."""
        code = gateway_proxy._get_error_code("Resource not in scope")
        assert code == "RESOURCE_NOT_IN_SCOPE"
    
    def test_delegation_chain_invalid_error_code(self, gateway_proxy):
        """Test error code for invalid delegation chain."""
        code = gateway_proxy._get_error_code("Delegation chain is invalid")
        assert code == "DELEGATION_CHAIN_INVALID"
    
    def test_generic_error_code(self, gateway_proxy):
        """Test error code for generic validation failure."""
        code = gateway_proxy._get_error_code("Some other error")
        assert code == "MANDATE_VALIDATION_FAILED"
