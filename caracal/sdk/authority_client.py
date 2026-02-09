"""
SDK client for Caracal Authority Enforcement.

Provides developer-friendly API for mandate management and authority validation.
Implements fail-closed semantics for connection errors.
"""

from datetime import datetime
from typing import Any, Dict, List, Optional
from uuid import UUID
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from caracal.exceptions import (
    ConnectionError,
    SDKConfigurationError,
)
from caracal.logging_config import get_logger

logger = get_logger(__name__)


class AuthorityClient:
    """
    SDK client for interacting with Caracal Authority Enforcement.
    
    Provides methods for:
    - Requesting execution mandates
    - Validating mandates
    - Revoking mandates
    - Querying authority ledger
    - Managing delegation
    
    Implements fail-closed semantics: on connection or initialization errors,
    the client will raise exceptions to prevent unauthorized access.
    
    Requirements: 10.6, 10.7, 10.8, 10.9
    """

    def __init__(
        self,
        base_url: str,
        api_key: Optional[str] = None,
        timeout: int = 30,
        max_retries: int = 3,
        backoff_factor: float = 0.5,
    ):
        """
        Initialize Authority SDK client.
        
        Args:
            base_url: Base URL for Caracal authority service (e.g., "http://localhost:8000")
            api_key: Optional API key for authentication
            timeout: Request timeout in seconds (default: 30)
            max_retries: Maximum number of retry attempts (default: 3)
            backoff_factor: Backoff factor for exponential retry (default: 0.5)
            
        Raises:
            SDKConfigurationError: If configuration is invalid
            ConnectionError: If initial connection test fails (fail-closed)
        """
        try:
            logger.info("Initializing Caracal Authority SDK client")
            
            # Validate configuration
            if not base_url:
                raise SDKConfigurationError("base_url is required")
            
            self.base_url = base_url.rstrip('/')
            self.api_key = api_key
            self.timeout = timeout
            
            # Create session with connection pooling
            self.session = requests.Session()
            
            # Configure retry strategy
            retry_strategy = Retry(
                total=max_retries,
                backoff_factor=backoff_factor,
                status_forcelist=[429, 500, 502, 503, 504],
                allowed_methods=["HEAD", "GET", "POST", "PUT", "DELETE", "OPTIONS", "TRACE"]
            )
            
            adapter = HTTPAdapter(
                max_retries=retry_strategy,
                pool_connections=10,
                pool_maxsize=20
            )
            
            self.session.mount("http://", adapter)
            self.session.mount("https://", adapter)
            
            # Set default headers
            self.session.headers.update({
                "Content-Type": "application/json",
                "User-Agent": "Caracal-Authority-SDK/0.5.0"
            })
            
            if self.api_key:
                self.session.headers.update({
                    "Authorization": f"Bearer {self.api_key}"
                })
            
            logger.info("Caracal Authority SDK client initialized successfully")
            
        except Exception as e:
            # Fail closed: if we can't initialize, raise error
            logger.error(f"Failed to initialize Caracal Authority SDK client: {e}", exc_info=True)
            raise ConnectionError(
                f"Failed to initialize Caracal Authority SDK client: {e}. "
                "Failing closed to prevent unauthorized access."
            ) from e

    def _make_request(
        self,
        method: str,
        endpoint: str,
        data: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Make HTTP request with error handling.
        
        Args:
            method: HTTP method (GET, POST, DELETE, etc.)
            endpoint: API endpoint path
            data: Request body data
            params: Query parameters
            
        Returns:
            Response data as dictionary
            
        Raises:
            ConnectionError: If request fails
        """
        url = f"{self.base_url}{endpoint}"
        
        try:
            logger.debug(f"Making {method} request to {url}")
            
            response = self.session.request(
                method=method,
                url=url,
                json=data,
                params=params,
                timeout=self.timeout
            )
            
            # Check for HTTP errors
            if response.status_code >= 400:
                error_detail = response.json() if response.content else {}
                error_message = error_detail.get('message', response.text)
                
                logger.error(
                    f"Request failed: {method} {url} - "
                    f"Status {response.status_code}: {error_message}"
                )
                
                raise ConnectionError(
                    f"Request failed with status {response.status_code}: {error_message}"
                )
            
            # Parse response
            if response.content:
                return response.json()
            else:
                return {}
            
        except requests.exceptions.Timeout as e:
            logger.error(f"Request timeout: {method} {url}", exc_info=True)
            raise ConnectionError(f"Request timeout: {e}") from e
            
        except requests.exceptions.ConnectionError as e:
            logger.error(f"Connection error: {method} {url}", exc_info=True)
            raise ConnectionError(f"Connection error: {e}") from e
            
        except requests.exceptions.RequestException as e:
            logger.error(f"Request failed: {method} {url}", exc_info=True)
            raise ConnectionError(f"Request failed: {e}") from e

    def close(self) -> None:
        """
        Close the HTTP session and release resources.
        
        Should be called when the client is no longer needed.
        """
        if self.session:
            self.session.close()
            logger.debug("Closed Authority SDK client session")

    def __enter__(self):
        """Context manager entry."""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit."""
        self.close()

    def request_mandate(
        self,
        issuer_id: str,
        subject_id: str,
        resource_scope: List[str],
        action_scope: List[str],
        validity_seconds: int,
        intent: Optional[Dict[str, Any]] = None,
        parent_mandate_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Request a new execution mandate.
        
        Sends a POST request to /mandates endpoint to issue a new mandate.
        
        Args:
            issuer_id: Principal ID of the issuer
            subject_id: Principal ID of the subject (who will use the mandate)
            resource_scope: List of resource patterns (e.g., ["api:openai:*", "database:users:read"])
            action_scope: List of allowed actions (e.g., ["api_call", "database_query"])
            validity_seconds: How long the mandate is valid (TTL in seconds)
            intent: Optional intent that constrains the mandate
            parent_mandate_id: Optional parent mandate ID for delegation
            metadata: Optional additional metadata
            
        Returns:
            Dictionary containing the execution mandate with fields:
            - mandate_id: Unique mandate identifier
            - issuer_id: Issuer principal ID
            - subject_id: Subject principal ID
            - valid_from: Start of validity period (ISO timestamp)
            - valid_until: End of validity period (ISO timestamp)
            - resource_scope: List of resource patterns
            - action_scope: List of allowed actions
            - signature: Cryptographic signature
            - created_at: Creation timestamp
            - metadata: Additional metadata
            - revoked: Revocation status
            - parent_mandate_id: Parent mandate ID (if delegated)
            - delegation_depth: Delegation depth
            
        Raises:
            ConnectionError: If request fails
            SDKConfigurationError: If parameters are invalid
            
        Requirements: 10.1, 10.7, 10.8
        
        Example:
            >>> client = AuthorityClient(base_url="http://localhost:8000", api_key="secret")
            >>> mandate = client.request_mandate(
            ...     issuer_id="admin-uuid",
            ...     subject_id="agent-uuid",
            ...     resource_scope=["api:openai:gpt-4"],
            ...     action_scope=["api_call"],
            ...     validity_seconds=3600
            ... )
            >>> print(f"Mandate ID: {mandate['mandate_id']}")
        """
        # Validate parameters
        if not issuer_id:
            raise SDKConfigurationError("issuer_id is required")
        if not subject_id:
            raise SDKConfigurationError("subject_id is required")
        if not resource_scope:
            raise SDKConfigurationError("resource_scope must not be empty")
        if not action_scope:
            raise SDKConfigurationError("action_scope must not be empty")
        if validity_seconds <= 0:
            raise SDKConfigurationError("validity_seconds must be positive")
        
        logger.info(
            f"Requesting mandate: issuer={issuer_id}, subject={subject_id}, "
            f"validity={validity_seconds}s"
        )
        
        # Prepare request data
        request_data = {
            "issuer_id": issuer_id,
            "subject_id": subject_id,
            "resource_scope": resource_scope,
            "action_scope": action_scope,
            "validity_seconds": validity_seconds,
        }
        
        if intent:
            request_data["intent"] = intent
        if parent_mandate_id:
            request_data["parent_mandate_id"] = parent_mandate_id
        if metadata:
            request_data["metadata"] = metadata
        
        # Make request
        try:
            response = self._make_request(
                method="POST",
                endpoint="/mandates",
                data=request_data
            )
            
            logger.info(
                f"Successfully requested mandate: {response.get('mandate_id')}"
            )
            
            return response
            
        except Exception as e:
            logger.error(
                f"Failed to request mandate for subject {subject_id}: {e}",
                exc_info=True
            )
            raise

    def validate_mandate(
        self,
        mandate_id: str,
        requested_action: str,
        requested_resource: str,
        mandate_data: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Validate an execution mandate for a specific action.
        
        Sends a POST request to /mandates/validate endpoint to check if a mandate
        is valid for the requested action and resource.
        
        Args:
            mandate_id: Mandate identifier to validate
            requested_action: Action being requested (e.g., "api_call")
            requested_resource: Resource being accessed (e.g., "api:openai:gpt-4")
            mandate_data: Optional full mandate data (if not provided, will be fetched)
            
        Returns:
            Dictionary containing the authority decision with fields:
            - allowed: Boolean indicating if action is allowed
            - mandate_id: Mandate identifier
            - principal_id: Subject principal ID
            - requested_action: Action that was requested
            - requested_resource: Resource that was requested
            - decision_timestamp: When the decision was made
            - denial_reason: Reason for denial (if allowed=False)
            - correlation_id: Correlation ID for tracking
            
        Raises:
            ConnectionError: If request fails
            SDKConfigurationError: If parameters are invalid
            
        Requirements: 10.2
        
        Example:
            >>> client = AuthorityClient(base_url="http://localhost:8000", api_key="secret")
            >>> decision = client.validate_mandate(
            ...     mandate_id="mandate-uuid",
            ...     requested_action="api_call",
            ...     requested_resource="api:openai:gpt-4"
            ... )
            >>> if decision['allowed']:
            ...     print("Action authorized")
            ... else:
            ...     print(f"Action denied: {decision['denial_reason']}")
        """
        # Validate parameters
        if not mandate_id:
            raise SDKConfigurationError("mandate_id is required")
        if not requested_action:
            raise SDKConfigurationError("requested_action is required")
        if not requested_resource:
            raise SDKConfigurationError("requested_resource is required")
        
        logger.info(
            f"Validating mandate: mandate_id={mandate_id}, "
            f"action={requested_action}, resource={requested_resource}"
        )
        
        # Prepare request data
        request_data = {
            "mandate_id": mandate_id,
            "requested_action": requested_action,
            "requested_resource": requested_resource,
        }
        
        if mandate_data:
            request_data["mandate"] = mandate_data
        
        # Make request
        try:
            response = self._make_request(
                method="POST",
                endpoint="/mandates/validate",
                data=request_data
            )
            
            if response.get('allowed'):
                logger.info(
                    f"Mandate validation succeeded: {mandate_id}"
                )
            else:
                logger.warning(
                    f"Mandate validation denied: {mandate_id} - "
                    f"{response.get('denial_reason')}"
                )
            
            return response
            
        except Exception as e:
            logger.error(
                f"Failed to validate mandate {mandate_id}: {e}",
                exc_info=True
            )
            raise

    def revoke_mandate(
        self,
        mandate_id: str,
        revoker_id: str,
        reason: str,
        cascade: bool = True,
    ) -> Dict[str, Any]:
        """
        Revoke an execution mandate.
        
        Sends a DELETE request to /mandates/{mandate_id} endpoint to revoke a mandate.
        
        Args:
            mandate_id: Mandate identifier to revoke
            revoker_id: Principal ID of the revoker
            reason: Reason for revocation
            cascade: If True, revoke all child mandates (default: True)
            
        Returns:
            Dictionary containing revocation confirmation with fields:
            - mandate_id: Revoked mandate identifier
            - revoked: Boolean (should be True)
            - revoked_at: Revocation timestamp
            - revocation_reason: Reason for revocation
            - cascade: Whether cascade was applied
            - revoked_count: Number of mandates revoked (including children if cascade=True)
            
        Raises:
            ConnectionError: If request fails
            SDKConfigurationError: If parameters are invalid
            
        Requirements: 10.3
        
        Example:
            >>> client = AuthorityClient(base_url="http://localhost:8000", api_key="secret")
            >>> result = client.revoke_mandate(
            ...     mandate_id="mandate-uuid",
            ...     revoker_id="admin-uuid",
            ...     reason="Security incident",
            ...     cascade=True
            ... )
            >>> print(f"Revoked {result['revoked_count']} mandate(s)")
        """
        # Validate parameters
        if not mandate_id:
            raise SDKConfigurationError("mandate_id is required")
        if not revoker_id:
            raise SDKConfigurationError("revoker_id is required")
        if not reason:
            raise SDKConfigurationError("reason is required")
        
        logger.info(
            f"Revoking mandate: mandate_id={mandate_id}, "
            f"revoker={revoker_id}, cascade={cascade}"
        )
        
        # Prepare request data
        request_data = {
            "revoker_id": revoker_id,
            "reason": reason,
            "cascade": cascade,
        }
        
        # Make request
        try:
            response = self._make_request(
                method="DELETE",
                endpoint=f"/mandates/{mandate_id}",
                data=request_data
            )
            
            logger.info(
                f"Successfully revoked mandate: {mandate_id} "
                f"(count: {response.get('revoked_count', 1)})"
            )
            
            return response
            
        except Exception as e:
            logger.error(
                f"Failed to revoke mandate {mandate_id}: {e}",
                exc_info=True
            )
            raise

    def query_ledger(
        self,
        principal_id: Optional[str] = None,
        mandate_id: Optional[str] = None,
        event_type: Optional[str] = None,
        start_time: Optional[datetime] = None,
        end_time: Optional[datetime] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> Dict[str, Any]:
        """
        Query the authority ledger for events.
        
        Sends a GET request to /ledger endpoint to retrieve authority ledger events
        with optional filtering.
        
        Args:
            principal_id: Filter by principal ID
            mandate_id: Filter by mandate ID
            event_type: Filter by event type (issued, validated, denied, revoked)
            start_time: Filter events after this time
            end_time: Filter events before this time
            limit: Maximum number of events to return (default: 100)
            offset: Number of events to skip for pagination (default: 0)
            
        Returns:
            Dictionary containing:
            - events: List of authority ledger events
            - total_count: Total number of matching events
            - limit: Limit used in query
            - offset: Offset used in query
            
            Each event contains:
            - event_id: Unique event identifier
            - event_type: Type of event
            - timestamp: When the event occurred
            - principal_id: Principal involved
            - mandate_id: Mandate involved (if applicable)
            - decision: Decision outcome (for validation events)
            - denial_reason: Reason for denial (if applicable)
            - requested_action: Action requested (for validation events)
            - requested_resource: Resource requested (for validation events)
            - event_metadata: Additional metadata
            
        Raises:
            ConnectionError: If request fails
            SDKConfigurationError: If parameters are invalid
            
        Requirements: 10.4
        
        Example:
            >>> from datetime import datetime, timedelta
            >>> client = AuthorityClient(base_url="http://localhost:8000", api_key="secret")
            >>> 
            >>> # Query last 24 hours of events for a principal
            >>> end = datetime.utcnow()
            >>> start = end - timedelta(days=1)
            >>> result = client.query_ledger(
            ...     principal_id="agent-uuid",
            ...     start_time=start,
            ...     end_time=end,
            ...     limit=50
            ... )
            >>> print(f"Found {result['total_count']} events")
            >>> for event in result['events']:
            ...     print(f"{event['timestamp']}: {event['event_type']}")
        """
        # Validate parameters
        if limit <= 0:
            raise SDKConfigurationError("limit must be positive")
        if offset < 0:
            raise SDKConfigurationError("offset must be non-negative")
        
        logger.info(
            f"Querying ledger: principal={principal_id}, mandate={mandate_id}, "
            f"type={event_type}, limit={limit}, offset={offset}"
        )
        
        # Prepare query parameters
        params = {
            "limit": limit,
            "offset": offset,
        }
        
        if principal_id:
            params["principal_id"] = principal_id
        if mandate_id:
            params["mandate_id"] = mandate_id
        if event_type:
            params["event_type"] = event_type
        if start_time:
            params["start_time"] = start_time.isoformat() + "Z"
        if end_time:
            params["end_time"] = end_time.isoformat() + "Z"
        
        # Make request
        try:
            response = self._make_request(
                method="GET",
                endpoint="/ledger",
                params=params
            )
            
            logger.info(
                f"Ledger query returned {len(response.get('events', []))} events "
                f"(total: {response.get('total_count', 0)})"
            )
            
            return response
            
        except Exception as e:
            logger.error(
                f"Failed to query ledger: {e}",
                exc_info=True
            )
            raise

    def delegate_mandate(
        self,
        parent_mandate_id: str,
        child_subject_id: str,
        resource_scope: List[str],
        action_scope: List[str],
        validity_seconds: int,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Create a delegated mandate from a parent mandate.
        
        Sends a POST request to /mandates/delegate endpoint to create a child mandate
        with scope and validity constrained by the parent.
        
        Args:
            parent_mandate_id: Parent mandate identifier
            child_subject_id: Principal ID for the child mandate subject
            resource_scope: Resource scope for child (must be subset of parent)
            action_scope: Action scope for child (must be subset of parent)
            validity_seconds: Validity period for child (must be within parent validity)
            metadata: Optional additional metadata
            
        Returns:
            Dictionary containing the delegated execution mandate with fields:
            - mandate_id: Unique mandate identifier
            - issuer_id: Issuer principal ID (from parent)
            - subject_id: Child subject principal ID
            - valid_from: Start of validity period
            - valid_until: End of validity period
            - resource_scope: List of resource patterns
            - action_scope: List of allowed actions
            - signature: Cryptographic signature
            - created_at: Creation timestamp
            - parent_mandate_id: Parent mandate ID
            - delegation_depth: Delegation depth (parent depth + 1)
            
        Raises:
            ConnectionError: If request fails
            SDKConfigurationError: If parameters are invalid
            
        Requirements: 10.5
        
        Example:
            >>> client = AuthorityClient(base_url="http://localhost:8000", api_key="secret")
            >>> child_mandate = client.delegate_mandate(
            ...     parent_mandate_id="parent-uuid",
            ...     child_subject_id="child-agent-uuid",
            ...     resource_scope=["api:openai:gpt-3.5"],  # Subset of parent
            ...     action_scope=["api_call"],
            ...     validity_seconds=1800  # 30 minutes
            ... )
            >>> print(f"Delegated mandate: {child_mandate['mandate_id']}")
            >>> print(f"Delegation depth: {child_mandate['delegation_depth']}")
        """
        # Validate parameters
        if not parent_mandate_id:
            raise SDKConfigurationError("parent_mandate_id is required")
        if not child_subject_id:
            raise SDKConfigurationError("child_subject_id is required")
        if not resource_scope:
            raise SDKConfigurationError("resource_scope must not be empty")
        if not action_scope:
            raise SDKConfigurationError("action_scope must not be empty")
        if validity_seconds <= 0:
            raise SDKConfigurationError("validity_seconds must be positive")
        
        logger.info(
            f"Delegating mandate: parent={parent_mandate_id}, "
            f"child_subject={child_subject_id}, validity={validity_seconds}s"
        )
        
        # Prepare request data
        request_data = {
            "parent_mandate_id": parent_mandate_id,
            "child_subject_id": child_subject_id,
            "resource_scope": resource_scope,
            "action_scope": action_scope,
            "validity_seconds": validity_seconds,
        }
        
        if metadata:
            request_data["metadata"] = metadata
        
        # Make request
        try:
            response = self._make_request(
                method="POST",
                endpoint="/mandates/delegate",
                data=request_data
            )
            
            logger.info(
                f"Successfully delegated mandate: {response.get('mandate_id')} "
                f"(depth: {response.get('delegation_depth')})"
            )
            
            return response
            
        except Exception as e:
            logger.error(
                f"Failed to delegate mandate from {parent_mandate_id}: {e}",
                exc_info=True
            )
            raise
