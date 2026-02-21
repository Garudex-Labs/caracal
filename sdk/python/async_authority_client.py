"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Async SDK client for Caracal Authority Enforcement.

Provides async developer-friendly API for mandate management and authority validation.
Implements fail-closed semantics for connection errors.
"""

from datetime import datetime
from typing import Any, Dict, List, Optional
from uuid import UUID
import aiohttp
from aiohttp import ClientTimeout, TCPConnector

from caracal.exceptions import (
    ConnectionError,
    SDKConfigurationError,
)
from caracal.logging_config import get_logger

logger = get_logger(__name__)


class AsyncAuthorityClient:
    """
    Async SDK client for interacting with Caracal Authority Enforcement.
    
    Provides async methods for:
    - Requesting execution mandates
    - Validating mandates
    - Revoking mandates
    - Querying authority ledger
    - Managing delegation
    
    Implements fail-closed semantics: on connection or initialization errors,
    the client will raise exceptions to prevent unauthorized access.
    
    """

    def __init__(
        self,
        base_url: str,
        api_key: Optional[str] = None,
        timeout: int = 30,
        max_connections: int = 100,
        workspace_id: Optional[str] = None,
        directory_scope: Optional[str] = None,
    ):
        """
        Initialize Async Authority SDK client.
        
        Args:
            base_url: Base URL for Caracal authority service (e.g., "http://localhost:8000")
            api_key: Optional API key for authentication
            timeout: Request timeout in seconds (default: 30)
            max_connections: Maximum number of concurrent connections (default: 100)
            workspace_id: Optional workspace identifier for multi-workspace isolation.
            directory_scope: Optional directory path scope for client-side binding.
            
        Raises:
            SDKConfigurationError: If configuration is invalid
        """
        try:
            logger.info("Initializing Async Caracal Authority SDK client")
            
            # Validate configuration
            if not base_url:
                raise SDKConfigurationError("base_url is required")
            
            self.base_url = base_url.rstrip('/')
            self.api_key = api_key
            self.timeout = ClientTimeout(total=timeout)
            self.workspace_id = workspace_id
            self.directory_scope = directory_scope
            
            # Prepare headers
            self.headers = {
                "Content-Type": "application/json",
                "User-Agent": "Caracal-Authority-SDK-Async/1.0.0"
            }
            
            if self.api_key:
                self.headers["Authorization"] = f"Bearer {self.api_key}"
            
            if self.workspace_id:
                self.headers["X-Workspace-Id"] = self.workspace_id
            if self.directory_scope:
                self.headers["X-Directory-Scope"] = self.directory_scope
            
            # Create connector with connection pooling
            self.connector = TCPConnector(limit=max_connections)
            
            # Session will be created on first use
            self._session: Optional[aiohttp.ClientSession] = None
            
            logger.info("Async Caracal Authority SDK client initialized successfully")
            
        except Exception as e:
            logger.error(f"Failed to initialize Async Caracal Authority SDK client: {e}", exc_info=True)
            raise SDKConfigurationError(
                f"Failed to initialize Async Caracal Authority SDK client: {e}"
            ) from e

    async def _get_session(self) -> aiohttp.ClientSession:
        """Get or create aiohttp session."""
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                headers=self.headers,
                timeout=self.timeout,
                connector=self.connector
            )
        return self._session

    async def _make_request(
        self,
        method: str,
        endpoint: str,
        data: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Make async HTTP request with error handling.
        
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
        session = await self._get_session()
        
        try:
            logger.debug(f"Making async {method} request to {url}")
            
            async with session.request(
                method=method,
                url=url,
                json=data,
                params=params
            ) as response:
                # Check for HTTP errors
                if response.status >= 400:
                    error_detail = await response.json() if response.content_length else {}
                    error_message = error_detail.get('message', await response.text())
                    
                    logger.error(
                        f"Request failed: {method} {url} - "
                        f"Status {response.status}: {error_message}"
                    )
                    
                    raise ConnectionError(
                        f"Request failed with status {response.status}: {error_message}"
                    )
                
                # Parse response
                if response.content_length:
                    return await response.json()
                else:
                    return {}
            
        except aiohttp.ClientError as e:
            logger.error(f"Request failed: {method} {url}", exc_info=True)
            raise ConnectionError(f"Request failed: {e}") from e

    async def close(self) -> None:
        """
        Close the HTTP session and release resources.
        
        Should be called when the client is no longer needed.
        """
        if self._session and not self._session.closed:
            await self._session.close()
            logger.debug("Closed Async Authority SDK client session")

    async def __aenter__(self):
        """Async context manager entry."""
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit."""
        await self.close()

    async def request_mandate(
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
        Request a new execution mandate (async).
        
        See AuthorityClient.request_mandate() for full documentation.
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
            f"Requesting mandate (async): issuer={issuer_id}, subject={subject_id}, "
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
        response = await self._make_request(
            method="POST",
            endpoint="/mandates",
            data=request_data
        )
        
        logger.info(
            f"Successfully requested mandate (async): {response.get('mandate_id')}"
        )
        
        return response

    async def validate_mandate(
        self,
        mandate_id: str,
        requested_action: str,
        requested_resource: str,
        mandate_data: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Validate an execution mandate for a specific action (async).
        
        See AuthorityClient.validate_mandate() for full documentation.
        """
        # Validate parameters
        if not mandate_id:
            raise SDKConfigurationError("mandate_id is required")
        if not requested_action:
            raise SDKConfigurationError("requested_action is required")
        if not requested_resource:
            raise SDKConfigurationError("requested_resource is required")
        
        logger.info(
            f"Validating mandate (async): mandate_id={mandate_id}, "
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
        response = await self._make_request(
            method="POST",
            endpoint="/mandates/validate",
            data=request_data
        )
        
        if response.get('allowed'):
            logger.info(
                f"Mandate validation succeeded (async): {mandate_id}"
            )
        else:
            logger.warning(
                f"Mandate validation denied (async): {mandate_id} - "
                f"{response.get('denial_reason')}"
            )
        
        return response

    async def revoke_mandate(
        self,
        mandate_id: str,
        revoker_id: str,
        reason: str,
        cascade: bool = True,
    ) -> Dict[str, Any]:
        """
        Revoke an execution mandate (async).
        
        See AuthorityClient.revoke_mandate() for full documentation.
        """
        # Validate parameters
        if not mandate_id:
            raise SDKConfigurationError("mandate_id is required")
        if not revoker_id:
            raise SDKConfigurationError("revoker_id is required")
        if not reason:
            raise SDKConfigurationError("reason is required")
        
        logger.info(
            f"Revoking mandate (async): mandate_id={mandate_id}, "
            f"revoker={revoker_id}, cascade={cascade}"
        )
        
        # Prepare request data
        request_data = {
            "revoker_id": revoker_id,
            "reason": reason,
            "cascade": cascade,
        }
        
        # Make request
        response = await self._make_request(
            method="DELETE",
            endpoint=f"/mandates/{mandate_id}",
            data=request_data
        )
        
        logger.info(
            f"Successfully revoked mandate (async): {mandate_id} "
            f"(count: {response.get('revoked_count', 1)})"
        )
        
        return response

    async def query_ledger(
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
        Query the authority ledger for events (async).
        
        See AuthorityClient.query_ledger() for full documentation.
        """
        # Validate parameters
        if limit <= 0:
            raise SDKConfigurationError("limit must be positive")
        if offset < 0:
            raise SDKConfigurationError("offset must be non-negative")
        
        logger.info(
            f"Querying ledger (async): principal={principal_id}, mandate={mandate_id}, "
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
        response = await self._make_request(
            method="GET",
            endpoint="/ledger",
            params=params
        )
        
        logger.info(
            f"Ledger query returned {len(response.get('events', []))} events "
            f"(total: {response.get('total_count', 0)})"
        )
        
        return response

    async def delegate_mandate(
        self,
        parent_mandate_id: str,
        child_subject_id: str,
        resource_scope: List[str],
        action_scope: List[str],
        validity_seconds: int,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Create a delegated mandate from a parent mandate (async).
        
        See AuthorityClient.delegate_mandate() for full documentation.
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
            f"Delegating mandate (async): parent={parent_mandate_id}, "
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
        response = await self._make_request(
            method="POST",
            endpoint="/mandates/delegate",
            data=request_data
        )
        
        logger.info(
            f"Successfully delegated mandate (async): {response.get('mandate_id')} "
            f"(depth: {response.get('delegation_depth')})"
        )
        
        return response

    # ------------------------------------------------------------------
    # Health & discovery
    # ------------------------------------------------------------------

    async def health_check(self) -> Dict[str, Any]:
        """
        Check connectivity and service health (async).

        Returns:
            Dictionary with at least ``{"status": "ok"}`` on success.

        Raises:
            ConnectionError: If the service is unreachable.

        Example:
            >>> async with AsyncAuthorityClient(
            ...     base_url=os.environ["CARACAL_AUTHORITY_URL"],
            ...     api_key=os.environ.get("CARACAL_API_KEY"),
            ... ) as client:
            ...     health = await client.health_check()
            ...     assert health["status"] == "ok"
        """
        logger.debug("Performing health check (async)")
        return await self._make_request(method="GET", endpoint="/health")

    # ------------------------------------------------------------------
    # Principal management
    # ------------------------------------------------------------------

    async def register_principal(
        self,
        name: str,
        principal_type: str = "agent",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Register a new principal (user, agent, or service) — async.

        See :meth:`AuthorityClient.register_principal` for full documentation.
        """
        logger.info(f"Registering principal (async): name={name}, type={principal_type}")

        request_data: Dict[str, Any] = {
            "name": name,
            "principal_type": principal_type,
        }
        if metadata:
            request_data["metadata"] = metadata

        response = await self._make_request(
            method="POST",
            endpoint="/principals",
            data=request_data,
        )

        logger.info(f"Principal registered (async): {response.get('principal_id')}")
        return response

    async def list_principals(
        self,
        page: int = 1,
        page_size: int = 50,
    ) -> Dict[str, Any]:
        """
        List registered principals (paginated) — async.

        See :meth:`AuthorityClient.list_principals` for full documentation.
        """
        logger.debug(f"Listing principals (async): page={page}, page_size={page_size}")
        return await self._make_request(
            method="GET",
            endpoint="/principals",
            params={"page": page, "page_size": page_size},
        )

    # ------------------------------------------------------------------
    # Policy management
    # ------------------------------------------------------------------

    async def create_policy(
        self,
        principal_id: str,
        allowed_resource_patterns: List[str],
        allowed_actions: List[str],
        max_validity_seconds: int = 86400,
        delegation_depth: int = 0,
    ) -> Dict[str, Any]:
        """
        Create an authority policy for a principal — async.

        See :meth:`AuthorityClient.create_policy` for full documentation.
        """
        logger.info(f"Creating policy (async) for principal {principal_id}")

        request_data: Dict[str, Any] = {
            "principal_id": principal_id,
            "allowed_resource_patterns": allowed_resource_patterns,
            "allowed_actions": allowed_actions,
            "max_validity_seconds": max_validity_seconds,
            "allow_delegation": delegation_depth > 0,
            "max_delegation_depth": delegation_depth,
        }

        response = await self._make_request(
            method="POST",
            endpoint="/policies",
            data=request_data,
        )

        logger.info(f"Policy created (async): {response.get('policy_id')}")
        return response

    async def list_policies(
        self,
        principal_id: Optional[str] = None,
        page: int = 1,
        page_size: int = 50,
    ) -> Dict[str, Any]:
        """
        List authority policies (paginated), optionally filtered by principal — async.

        See :meth:`AuthorityClient.list_policies` for full documentation.
        """
        logger.debug(f"Listing policies (async): principal={principal_id}, page={page}")
        params: Dict[str, Any] = {"page": page, "page_size": page_size}
        if principal_id:
            params["principal_id"] = principal_id
        return await self._make_request(
            method="GET",
            endpoint="/policies",
            params=params,
        )

    # ------------------------------------------------------------------
    # Metadata sync (Enterprise dashboard integration)
    # ------------------------------------------------------------------

    async def sync_metadata(
        self,
        enforcement_state: Dict[str, Any],
        sync_type: str = "full",
        enterprise_url: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Push local enforcement state to the Caracal Enterprise dashboard — async.

        See :meth:`AuthorityClient.sync_metadata` for full documentation.
        """
        if not self.workspace_id:
            raise SDKConfigurationError(
                "workspace_id is required for metadata sync. "
                "Pass workspace_id when constructing AsyncAuthorityClient."
            )

        url = (enterprise_url or self.base_url).rstrip("/")
        payload = {
            "workspace_id": self.workspace_id,
            "directory_scope": self.directory_scope,
            "sync_type": sync_type,
            "enforcement_state": enforcement_state,
            "client_version": self.headers.get("User-Agent", "unknown"),
            "timestamp": datetime.utcnow().isoformat(),
        }

        logger.info(
            "Syncing metadata to enterprise (async): workspace=%s type=%s",
            self.workspace_id,
            sync_type,
        )

        try:
            session = await self._get_session()
            async with session.post(
                f"{url}/api/connection/sync",
                json=payload,
                headers=self.headers,
                timeout=self.timeout,
            ) as resp:
                resp.raise_for_status()
                return await resp.json()
        except aiohttp.ClientError as e:
            raise ConnectionError(
                f"Failed to sync metadata to enterprise: {e}"
            ) from e
