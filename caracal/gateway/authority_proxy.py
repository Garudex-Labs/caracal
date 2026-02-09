"""
Authority gateway proxy for pre-execution enforcement.

This module provides the AuthorityGatewayProxy class for intercepting requests
and validating mandates before forwarding to target services. It also includes
decorator and middleware patterns for function-level and HTTP-level enforcement.

Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 9.10
"""

from dataclasses import dataclass
from datetime import datetime
from functools import wraps
from typing import Any, Callable, Dict, Optional
from uuid import UUID

from sqlalchemy.orm import Session

from caracal.core.authority import AuthorityEvaluator, AuthorityDecision
from caracal.core.authority_ledger import AuthorityLedgerWriter
from caracal.db.models import ExecutionMandate
from caracal.exceptions import AuthorityDeniedError
from caracal.logging_config import get_logger

logger = get_logger(__name__)


@dataclass
class Request:
    """
    Generic request object for gateway interception.
    
    Represents an incoming request with headers, body, and metadata.
    Can be adapted to different request types (HTTP, gRPC, etc.).
    """
    headers: Dict[str, str]
    body: Optional[Dict[str, Any]] = None
    method: Optional[str] = None
    path: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


@dataclass
class Response:
    """
    Generic response object for gateway interception.
    
    Represents an outgoing response with status, body, and headers.
    """
    status_code: int
    body: Optional[Dict[str, Any]] = None
    headers: Optional[Dict[str, str]] = None
    error: Optional[str] = None


class AuthorityGatewayProxy:
    """
    Gateway proxy for authority enforcement.
    
    Intercepts requests and validates mandates before forwarding to target
    services. Implements fail-closed semantics: any error or missing mandate
    results in request denial.
    
    Requirements: 9.1, 9.2, 9.10
    """
    
    def __init__(
        self,
        authority_evaluator: AuthorityEvaluator,
        ledger_writer: AuthorityLedgerWriter,
        db_session: Session
    ):
        """
        Initialize AuthorityGatewayProxy.
        
        Args:
            authority_evaluator: AuthorityEvaluator instance for mandate validation
            ledger_writer: AuthorityLedgerWriter instance for recording decisions
            db_session: SQLAlchemy database session for mandate lookups
        """
        self.authority_evaluator = authority_evaluator
        self.ledger_writer = ledger_writer
        self.db_session = db_session
        logger.info("AuthorityGatewayProxy initialized with fail-closed semantics")
    
    def _extract_mandate_from_header(self, request: Request) -> Optional[str]:
        """
        Extract mandate ID from request headers.
        
        Looks for mandate in the following headers (in order):
        1. X-Execution-Mandate
        2. Authorization (Bearer token format)
        
        Args:
            request: The incoming request
        
        Returns:
            Mandate ID string if found, None otherwise
        """
        # Check X-Execution-Mandate header
        mandate_id = request.headers.get("X-Execution-Mandate")
        if mandate_id:
            logger.debug(f"Found mandate in X-Execution-Mandate header: {mandate_id}")
            return mandate_id
        
        # Check Authorization header (Bearer token format)
        auth_header = request.headers.get("Authorization")
        if auth_header and auth_header.startswith("Bearer "):
            mandate_id = auth_header[7:]  # Remove "Bearer " prefix
            logger.debug(f"Found mandate in Authorization header: {mandate_id}")
            return mandate_id
        
        logger.debug("No mandate found in request headers")
        return None
    
    def _get_mandate_from_db(self, mandate_id: str) -> Optional[ExecutionMandate]:
        """
        Retrieve mandate from database by ID.
        
        Args:
            mandate_id: The mandate ID to retrieve
        
        Returns:
            ExecutionMandate if found, None otherwise
        """
        try:
            mandate_uuid = UUID(mandate_id)
            mandate = self.db_session.query(ExecutionMandate).filter(
                ExecutionMandate.mandate_id == mandate_uuid
            ).first()
            
            if mandate:
                logger.debug(f"Retrieved mandate {mandate_id} from database")
            else:
                logger.warning(f"Mandate {mandate_id} not found in database")
            
            return mandate
            
        except ValueError:
            logger.warning(f"Invalid mandate ID format: {mandate_id}")
            return None
        except Exception as e:
            logger.error(f"Failed to retrieve mandate {mandate_id}: {e}", exc_info=True)
            return None
    
    def _extract_action_and_resource(self, request: Request) -> tuple[str, str]:
        """
        Extract action and resource from request.
        
        Uses request method and path to determine action and resource.
        Can be customized based on application needs.
        
        Args:
            request: The incoming request
        
        Returns:
            Tuple of (action, resource)
        """
        # Default action based on HTTP method
        method_to_action = {
            "GET": "read",
            "POST": "create",
            "PUT": "update",
            "PATCH": "update",
            "DELETE": "delete"
        }
        
        action = method_to_action.get(request.method, "execute")
        
        # Resource is the request path
        resource = request.path or "unknown"
        
        # Check if request body contains explicit action/resource
        if request.body:
            if "action" in request.body:
                action = request.body["action"]
            if "resource" in request.body:
                resource = request.body["resource"]
        
        logger.debug(f"Extracted action={action}, resource={resource} from request")
        return action, resource
    
    def intercept_request(
        self,
        request: Request,
        extract_mandate: Optional[Callable[[Request], str]] = None,
        forward_request: Optional[Callable[[Request], Response]] = None
    ) -> Response:
        """
        Intercept and validate request.
        
        Flow:
        1. Extract mandate from request
        2. Validate mandate
        3. If valid, forward request
        4. If invalid, return error
        5. Record decision in authority ledger
        
        Implements fail-closed semantics: any error results in denial.
        
        Args:
            request: The incoming request to intercept
            extract_mandate: Optional custom function to extract mandate ID from request
            forward_request: Optional function to forward validated request to target service
        
        Returns:
            Response object with result or error
        
        Requirements: 9.2, 9.3, 9.4, 9.5, 9.9
        """
        logger.info(f"Intercepting request: method={request.method}, path={request.path}")
        
        # Extract mandate from request
        if extract_mandate:
            mandate_id_str = extract_mandate(request)
        else:
            mandate_id_str = self._extract_mandate_from_header(request)
        
        # Fail-closed: If no mandate provided, deny request
        if not mandate_id_str:
            error_msg = "No execution mandate provided in request"
            logger.warning(error_msg)
            
            # Record denial in ledger
            try:
                self.ledger_writer.record_validation(
                    mandate_id=None,
                    principal_id=None,
                    decision="denied",
                    denial_reason=error_msg,
                    requested_action=request.method or "unknown",
                    requested_resource=request.path or "unknown",
                    metadata={"request_headers": request.headers}
                )
            except Exception as e:
                logger.error(f"Failed to record denial in ledger: {e}", exc_info=True)
            
            return Response(
                status_code=403,
                body={
                    "allowed": False,
                    "error": {
                        "code": "MANDATE_NOT_PROVIDED",
                        "message": error_msg
                    }
                },
                headers={"Content-Type": "application/json"}
            )
        
        # Retrieve mandate from database
        mandate = self._get_mandate_from_db(mandate_id_str)
        
        # Fail-closed: If mandate not found, deny request
        if not mandate:
            error_msg = f"Mandate {mandate_id_str} not found"
            logger.warning(error_msg)
            
            # Record denial in ledger
            try:
                self.ledger_writer.record_validation(
                    mandate_id=None,
                    principal_id=None,
                    decision="denied",
                    denial_reason=error_msg,
                    requested_action=request.method or "unknown",
                    requested_resource=request.path or "unknown",
                    metadata={"mandate_id": mandate_id_str}
                )
            except Exception as e:
                logger.error(f"Failed to record denial in ledger: {e}", exc_info=True)
            
            return Response(
                status_code=403,
                body={
                    "allowed": False,
                    "error": {
                        "code": "MANDATE_NOT_FOUND",
                        "message": error_msg
                    }
                },
                headers={"Content-Type": "application/json"}
            )
        
        # Extract action and resource from request
        action, resource = self._extract_action_and_resource(request)
        
        # Validate mandate
        try:
            decision = self.authority_evaluator.validate_mandate(
                mandate=mandate,
                requested_action=action,
                requested_resource=resource,
                current_time=datetime.utcnow()
            )
        except Exception as e:
            # Fail-closed: Any error in validation results in denial
            error_msg = f"Mandate validation failed: {e}"
            logger.error(error_msg, exc_info=True)
            
            # Record denial in ledger
            try:
                self.ledger_writer.record_validation(
                    mandate_id=mandate.mandate_id,
                    principal_id=mandate.subject_id,
                    decision="denied",
                    denial_reason=error_msg,
                    requested_action=action,
                    requested_resource=resource,
                    metadata={"error": str(e)}
                )
            except Exception as ledger_error:
                logger.error(f"Failed to record denial in ledger: {ledger_error}", exc_info=True)
            
            return Response(
                status_code=500,
                body={
                    "allowed": False,
                    "error": {
                        "code": "INTERNAL_ERROR",
                        "message": error_msg
                    }
                },
                headers={"Content-Type": "application/json"}
            )
        
        # Check decision
        if not decision.allowed:
            # Mandate validation failed - block request
            logger.warning(
                f"Request denied: mandate={mandate.mandate_id}, "
                f"reason={decision.reason}"
            )
            
            return Response(
                status_code=403,
                body={
                    "allowed": False,
                    "error": {
                        "code": self._get_error_code(decision.reason),
                        "message": decision.reason,
                        "details": {
                            "mandate_id": str(mandate.mandate_id),
                            "principal_id": str(mandate.subject_id),
                            "requested_action": action,
                            "requested_resource": resource
                        }
                    }
                },
                headers={"Content-Type": "application/json"}
            )
        
        # Mandate validation succeeded - forward request
        logger.info(
            f"Request allowed: mandate={mandate.mandate_id}, "
            f"action={action}, resource={resource}"
        )
        
        # Forward request to target service
        if forward_request:
            try:
                response = forward_request(request)
                logger.info(f"Request forwarded successfully, status={response.status_code}")
                return response
            except Exception as e:
                error_msg = f"Failed to forward request: {e}"
                logger.error(error_msg, exc_info=True)
                return Response(
                    status_code=502,
                    body={
                        "allowed": True,
                        "error": {
                            "code": "FORWARD_FAILED",
                            "message": error_msg
                        }
                    },
                    headers={"Content-Type": "application/json"}
                )
        else:
            # No forward function provided - return success
            return Response(
                status_code=200,
                body={
                    "allowed": True,
                    "message": "Request validated successfully",
                    "mandate_id": str(mandate.mandate_id)
                },
                headers={"Content-Type": "application/json"}
            )
    
    def _get_error_code(self, reason: str) -> str:
        """
        Map denial reason to error code.
        
        Args:
            reason: The denial reason string
        
        Returns:
            Error code string
        """
        reason_lower = reason.lower()
        
        if "expired" in reason_lower:
            return "MANDATE_EXPIRED"
        elif "revoked" in reason_lower:
            return "MANDATE_REVOKED"
        elif "signature" in reason_lower:
            return "MANDATE_INVALID_SIGNATURE"
        elif "action" in reason_lower and "scope" in reason_lower:
            return "ACTION_NOT_IN_SCOPE"
        elif "resource" in reason_lower and "scope" in reason_lower:
            return "RESOURCE_NOT_IN_SCOPE"
        elif "delegation" in reason_lower:
            return "DELEGATION_CHAIN_INVALID"
        elif "not yet valid" in reason_lower:
            return "MANDATE_NOT_YET_VALID"
        else:
            return "MANDATE_VALIDATION_FAILED"


def require_authority(
    action: str,
    resource: str,
    mandate_param: str = "mandate",
    db_session_param: str = "db_session"
):
    """
    Decorator for Python functions requiring authority.
    
    Validates that the function caller has a valid mandate for the specified
    action and resource before executing the function. Raises AuthorityDeniedError
    if validation fails.
    
    Usage:
        @require_authority(action="read", resource="database:users")
        def get_users(mandate: ExecutionMandate, db_session: Session):
            # Function implementation
            pass
    
    Args:
        action: The action type required (e.g., "read", "write", "execute")
        resource: The resource identifier (e.g., "database:users", "api:openai:*")
        mandate_param: Name of the function parameter containing the mandate (default: "mandate")
        db_session_param: Name of the function parameter containing the db session (default: "db_session")
    
    Returns:
        Decorated function that validates authority before execution
    
    Raises:
        AuthorityDeniedError: If mandate validation fails
        ValueError: If required parameters are missing
    
    Requirements: 9.6
    """
    def decorator(func: Callable) -> Callable:
        @wraps(func)
        def wrapper(*args, **kwargs):
            logger.debug(
                f"Checking authority for function {func.__name__}: "
                f"action={action}, resource={resource}"
            )
            
            # Extract mandate from function arguments
            mandate = kwargs.get(mandate_param)
            if mandate is None:
                # Try to get from positional args based on function signature
                import inspect
                sig = inspect.signature(func)
                param_names = list(sig.parameters.keys())
                if mandate_param in param_names:
                    param_index = param_names.index(mandate_param)
                    if param_index < len(args):
                        mandate = args[param_index]
            
            if mandate is None:
                error_msg = (
                    f"No mandate provided to function {func.__name__}. "
                    f"Expected parameter '{mandate_param}'"
                )
                logger.error(error_msg)
                raise ValueError(error_msg)
            
            # Extract db_session from function arguments
            db_session = kwargs.get(db_session_param)
            if db_session is None:
                # Try to get from positional args
                import inspect
                sig = inspect.signature(func)
                param_names = list(sig.parameters.keys())
                if db_session_param in param_names:
                    param_index = param_names.index(db_session_param)
                    if param_index < len(args):
                        db_session = args[param_index]
            
            if db_session is None:
                error_msg = (
                    f"No database session provided to function {func.__name__}. "
                    f"Expected parameter '{db_session_param}'"
                )
                logger.error(error_msg)
                raise ValueError(error_msg)
            
            # Create authority evaluator and ledger writer
            ledger_writer = AuthorityLedgerWriter(db_session)
            authority_evaluator = AuthorityEvaluator(db_session, ledger_writer)
            
            # Validate mandate
            try:
                decision = authority_evaluator.validate_mandate(
                    mandate=mandate,
                    requested_action=action,
                    requested_resource=resource,
                    current_time=datetime.utcnow()
                )
            except Exception as e:
                error_msg = f"Authority validation failed: {e}"
                logger.error(error_msg, exc_info=True)
                raise AuthorityDeniedError(error_msg)
            
            # Check decision
            if not decision.allowed:
                logger.warning(
                    f"Authority denied for function {func.__name__}: {decision.reason}"
                )
                raise AuthorityDeniedError(decision.reason)
            
            # Authority validated - execute function
            logger.info(
                f"Authority validated for function {func.__name__}: "
                f"mandate={mandate.mandate_id}"
            )
            return func(*args, **kwargs)
        
        return wrapper
    return decorator


class AuthorityMiddleware:
    """
    Middleware for HTTP services requiring authority.
    
    Integrates with WSGI/ASGI frameworks (Flask, FastAPI, etc.) to validate
    mandates before request processing. Returns 403 Forbidden if validation fails.
    
    Requirements: 9.7
    """
    
    def __init__(
        self,
        app: Any,
        authority_evaluator: AuthorityEvaluator,
        ledger_writer: AuthorityLedgerWriter,
        db_session: Session,
        exempt_paths: Optional[list[str]] = None
    ):
        """
        Initialize AuthorityMiddleware.
        
        Args:
            app: The WSGI/ASGI application to wrap
            authority_evaluator: AuthorityEvaluator instance for mandate validation
            ledger_writer: AuthorityLedgerWriter instance for recording decisions
            db_session: SQLAlchemy database session for mandate lookups
            exempt_paths: Optional list of paths that don't require authority (e.g., /health)
        """
        self.app = app
        self.authority_evaluator = authority_evaluator
        self.ledger_writer = ledger_writer
        self.db_session = db_session
        self.exempt_paths = exempt_paths or ["/health", "/metrics"]
        self.gateway_proxy = AuthorityGatewayProxy(
            authority_evaluator=authority_evaluator,
            ledger_writer=ledger_writer,
            db_session=db_session
        )
        logger.info(
            f"AuthorityMiddleware initialized with exempt_paths={self.exempt_paths}"
        )
    
    def __call__(self, environ: Dict, start_response: Callable) -> Any:
        """
        WSGI application interface.
        
        Args:
            environ: WSGI environment dictionary
            start_response: WSGI start_response callable
        
        Returns:
            Response iterable
        """
        # Extract request information from WSGI environ
        path = environ.get("PATH_INFO", "")
        method = environ.get("REQUEST_METHOD", "GET")
        
        # Check if path is exempt from authority checks
        if path in self.exempt_paths:
            logger.debug(f"Path {path} is exempt from authority checks")
            return self.app(environ, start_response)
        
        # Extract headers from environ
        headers = {}
        for key, value in environ.items():
            if key.startswith("HTTP_"):
                header_name = key[5:].replace("_", "-").title()
                headers[header_name] = value
        
        # Create request object
        request = Request(
            headers=headers,
            method=method,
            path=path,
            metadata={"environ": environ}
        )
        
        # Intercept and validate request
        response = self.gateway_proxy.intercept_request(
            request=request,
            forward_request=lambda req: self._forward_to_app(environ, start_response)
        )
        
        # If validation failed, return error response
        if response.status_code != 200:
            status = f"{response.status_code} {self._get_status_text(response.status_code)}"
            response_headers = [
                ("Content-Type", "application/json"),
            ]
            start_response(status, response_headers)
            
            import json
            return [json.dumps(response.body).encode("utf-8")]
        
        # Validation succeeded - forward to app
        return self.app(environ, start_response)
    
    def _forward_to_app(self, environ: Dict, start_response: Callable) -> Response:
        """
        Forward request to wrapped application.
        
        Args:
            environ: WSGI environment dictionary
            start_response: WSGI start_response callable
        
        Returns:
            Response object
        """
        # This is a simplified implementation
        # In practice, you would capture the app's response
        return Response(
            status_code=200,
            body={"message": "Request forwarded to application"}
        )
    
    def _get_status_text(self, status_code: int) -> str:
        """
        Get HTTP status text for status code.
        
        Args:
            status_code: HTTP status code
        
        Returns:
            Status text string
        """
        status_texts = {
            200: "OK",
            403: "Forbidden",
            500: "Internal Server Error",
            502: "Bad Gateway"
        }
        return status_texts.get(status_code, "Unknown")


class AuthorityAdapter:
    """
    Base class for external API enforcement adapters.
    
    Provides a pattern for wrapping external API calls with authority validation.
    Subclasses implement specific adapters for different APIs (OpenAI, Anthropic, etc.).
    
    Requirements: 9.8
    """
    
    def __init__(
        self,
        authority_evaluator: AuthorityEvaluator,
        ledger_writer: AuthorityLedgerWriter,
        db_session: Session
    ):
        """
        Initialize AuthorityAdapter.
        
        Args:
            authority_evaluator: AuthorityEvaluator instance for mandate validation
            ledger_writer: AuthorityLedgerWriter instance for recording decisions
            db_session: SQLAlchemy database session for mandate lookups
        """
        self.authority_evaluator = authority_evaluator
        self.ledger_writer = ledger_writer
        self.db_session = db_session
        logger.info(f"{self.__class__.__name__} initialized")
    
    def validate_and_call(
        self,
        mandate: ExecutionMandate,
        action: str,
        resource: str,
        api_call: Callable,
        *args,
        **kwargs
    ) -> Any:
        """
        Validate mandate and execute API call.
        
        Args:
            mandate: The execution mandate to validate
            action: The action type (e.g., "api_call")
            resource: The resource identifier (e.g., "api:openai:gpt-4")
            api_call: The API function to call if validation succeeds
            *args: Positional arguments for api_call
            **kwargs: Keyword arguments for api_call
        
        Returns:
            Result of api_call if validation succeeds
        
        Raises:
            AuthorityDeniedError: If mandate validation fails
        """
        logger.debug(
            f"Validating mandate for API call: action={action}, resource={resource}"
        )
        
        # Validate mandate
        try:
            decision = self.authority_evaluator.validate_mandate(
                mandate=mandate,
                requested_action=action,
                requested_resource=resource,
                current_time=datetime.utcnow()
            )
        except Exception as e:
            error_msg = f"Authority validation failed: {e}"
            logger.error(error_msg, exc_info=True)
            raise AuthorityDeniedError(error_msg)
        
        # Check decision
        if not decision.allowed:
            logger.warning(f"API call denied: {decision.reason}")
            raise AuthorityDeniedError(decision.reason)
        
        # Authority validated - execute API call
        logger.info(f"API call authorized: mandate={mandate.mandate_id}")
        try:
            result = api_call(*args, **kwargs)
            return result
        except Exception as e:
            logger.error(f"API call failed: {e}", exc_info=True)
            raise


class OpenAIAdapter(AuthorityAdapter):
    """
    Adapter for OpenAI API with authority enforcement.
    
    Wraps OpenAI API calls with mandate validation.
    """
    
    def chat_completion(
        self,
        mandate: ExecutionMandate,
        model: str,
        messages: list,
        **kwargs
    ) -> Any:
        """
        Create chat completion with authority validation.
        
        Args:
            mandate: The execution mandate to validate
            model: OpenAI model name (e.g., "gpt-4")
            messages: List of chat messages
            **kwargs: Additional OpenAI API parameters
        
        Returns:
            OpenAI API response
        
        Raises:
            AuthorityDeniedError: If mandate validation fails
        """
        resource = f"api:openai:{model}"
        
        def api_call():
            # This would call the actual OpenAI API
            # For now, return a placeholder
            logger.info(f"Calling OpenAI API: model={model}")
            return {"model": model, "messages": messages}
        
        return self.validate_and_call(
            mandate=mandate,
            action="api_call",
            resource=resource,
            api_call=api_call
        )


class AnthropicAdapter(AuthorityAdapter):
    """
    Adapter for Anthropic API with authority enforcement.
    
    Wraps Anthropic API calls with mandate validation.
    """
    
    def messages_create(
        self,
        mandate: ExecutionMandate,
        model: str,
        messages: list,
        **kwargs
    ) -> Any:
        """
        Create message with authority validation.
        
        Args:
            mandate: The execution mandate to validate
            model: Anthropic model name (e.g., "claude-3-opus")
            messages: List of messages
            **kwargs: Additional Anthropic API parameters
        
        Returns:
            Anthropic API response
        
        Raises:
            AuthorityDeniedError: If mandate validation fails
        """
        resource = f"api:anthropic:{model}"
        
        def api_call():
            # This would call the actual Anthropic API
            # For now, return a placeholder
            logger.info(f"Calling Anthropic API: model={model}")
            return {"model": model, "messages": messages}
        
        return self.validate_and_call(
            mandate=mandate,
            action="api_call",
            resource=resource,
            api_call=api_call
        )
