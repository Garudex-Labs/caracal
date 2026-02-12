"""
Workflow automation engine for Caracal Enterprise.

This module provides workflow automation capabilities for Caracal Enterprise.
In the open source edition, all workflow methods are stubbed and raise
EnterpriseFeatureRequired exceptions.

Enterprise Workflow Features:
- Event-driven automation
- Custom workflow definitions
- Integration with external systems
- Scheduled tasks
- Conditional logic
- Multi-step workflows
"""

from abc import ABC, abstractmethod
from typing import Any, Callable, Optional

from caracal.enterprise.exceptions import EnterpriseFeatureRequired


class WorkflowEngine(ABC):
    """
    Abstract base class for workflow automation.
    
    ENTERPRISE ONLY: Workflow automation requires Caracal Enterprise.
    
    Workflow engines enable automated responses to authority enforcement events,
    such as automatically revoking mandates when anomalies are detected or
    sending notifications when specific conditions are met.
    
    In Caracal Enterprise, implementations would:
    - Register event triggers
    - Execute workflow definitions
    - Integrate with external systems
    - Schedule recurring tasks
    - Provide workflow monitoring and logging
    """
    
    @abstractmethod
    def register_trigger(
        self,
        event_type: str,
        action: Callable[[dict], Any],
        conditions: Optional[dict[str, Any]] = None,
    ) -> str:
        """
        Register an automated trigger for an event type.
        
        Args:
            event_type: Type of event to trigger on (e.g., "mandate_issued", "validation_denied")
            action: Callable to execute when event occurs
            conditions: Optional conditions that must be met for trigger to fire
        
        Returns:
            Trigger ID for managing the registered trigger
        
        Raises:
            EnterpriseFeatureRequired: In open source edition
        
        Enterprise Event Types:
            - mandate_issued: When a mandate is issued
            - mandate_validated: When a mandate is validated
            - mandate_denied: When validation is denied
            - mandate_revoked: When a mandate is revoked
            - policy_created: When an authority policy is created
            - policy_updated: When an authority policy is updated
            - anomaly_detected: When an anomaly is detected
            - threshold_exceeded: When a metric exceeds threshold
        
        Enterprise Conditions:
            - principal_id: Filter by principal
            - resource_pattern: Filter by resource pattern
            - action_type: Filter by action type
            - denial_reason: Filter by denial reason
            - custom_filters: Custom filter expressions
        """
        pass
    
    @abstractmethod
    def unregister_trigger(self, trigger_id: str) -> bool:
        """
        Unregister a trigger.
        
        Args:
            trigger_id: ID of trigger to unregister
        
        Returns:
            True if trigger was unregistered, False if not found
        
        Raises:
            EnterpriseFeatureRequired: In open source edition
        """
        pass
    
    @abstractmethod
    def execute_workflow(
        self,
        workflow_id: str,
        context: dict[str, Any],
    ) -> dict[str, Any]:
        """
        Execute a workflow.
        
        Args:
            workflow_id: ID of workflow to execute
            context: Context data for workflow execution
        
        Returns:
            Dictionary with workflow execution results
        
        Raises:
            EnterpriseFeatureRequired: In open source edition
        
        Enterprise Workflow Definition:
            - steps: List of workflow steps
            - conditions: Conditional branching logic
            - error_handling: Error handling strategy
            - timeout: Workflow timeout
            - retry_policy: Retry configuration
        
        Enterprise Workflow Steps:
            - revoke_mandate: Revoke a mandate
            - send_notification: Send email/SMS/webhook notification
            - create_ticket: Create support ticket
            - call_api: Call external API
            - update_policy: Update authority policy
            - custom_action: Execute custom code
        """
        pass
    
    @abstractmethod
    def create_workflow(
        self,
        name: str,
        definition: dict[str, Any],
    ) -> str:
        """
        Create a new workflow definition.
        
        Args:
            name: Workflow name
            definition: Workflow definition
        
        Returns:
            Workflow ID
        
        Raises:
            EnterpriseFeatureRequired: In open source edition
        """
        pass
    
    @abstractmethod
    def schedule_workflow(
        self,
        workflow_id: str,
        schedule: str,
        context: Optional[dict[str, Any]] = None,
    ) -> str:
        """
        Schedule a workflow to run on a recurring basis.
        
        Args:
            workflow_id: ID of workflow to schedule
            schedule: Cron expression for schedule
            context: Optional context data for workflow
        
        Returns:
            Schedule ID
        
        Raises:
            EnterpriseFeatureRequired: In open source edition
        
        Enterprise Schedule Formats:
            - Cron expressions: "0 0 * * *" (daily at midnight)
            - Interval expressions: "every 1h" (every hour)
            - Natural language: "daily at 9am"
        """
        pass
    
    @abstractmethod
    def get_workflow_status(self, execution_id: str) -> dict[str, Any]:
        """
        Get status of a workflow execution.
        
        Args:
            execution_id: ID of workflow execution
        
        Returns:
            Dictionary with execution status
        
        Raises:
            EnterpriseFeatureRequired: In open source edition
        
        Enterprise Status Fields:
            - status: running, completed, failed, cancelled
            - started_at: Execution start time
            - completed_at: Execution completion time
            - current_step: Current step being executed
            - results: Results from completed steps
            - errors: Any errors encountered
        """
        pass


class OpenSourceWorkflowEngine(WorkflowEngine):
    """
    Open source workflow stub.
    
    Workflow automation requires Caracal Enterprise.
    This implementation provides clear messaging about enterprise requirements.
    
    Usage:
        >>> workflow = OpenSourceWorkflowEngine()
        >>> try:
        ...     trigger_id = workflow.register_trigger("mandate_issued", handler)
        ... except EnterpriseFeatureRequired as e:
        ...     print(e.message)
    """
    
    def register_trigger(
        self,
        event_type: str,
        action: Callable[[dict], Any],
        conditions: Optional[dict[str, Any]] = None,
    ) -> str:
        """
        Register automated trigger.
        
        In open source, this always raises EnterpriseFeatureRequired.
        
        Args:
            event_type: Event type (ignored in open source)
            action: Action callable (ignored in open source)
            conditions: Conditions (ignored in open source)
        
        Raises:
            EnterpriseFeatureRequired: Always raised in open source
        """
        raise EnterpriseFeatureRequired(
            feature="Workflow Automation",
            message=(
                "Automated workflow triggers require Caracal Enterprise. "
                "Visit https://garudexlabs.com for licensing information."
            ),
        )
    
    def unregister_trigger(self, trigger_id: str) -> bool:
        """
        Unregister trigger.
        
        In open source, this always raises EnterpriseFeatureRequired.
        
        Args:
            trigger_id: Trigger ID (ignored in open source)
        
        Raises:
            EnterpriseFeatureRequired: Always raised in open source
        """
        raise EnterpriseFeatureRequired(
            feature="Workflow Automation",
            message=(
                "Workflow trigger management requires Caracal Enterprise. "
                "Visit https://garudexlabs.com for licensing information."
            ),
        )
    
    def execute_workflow(
        self,
        workflow_id: str,
        context: dict[str, Any],
    ) -> dict[str, Any]:
        """
        Execute workflow.
        
        In open source, this always raises EnterpriseFeatureRequired.
        
        Args:
            workflow_id: Workflow ID (ignored in open source)
            context: Context data (ignored in open source)
        
        Raises:
            EnterpriseFeatureRequired: Always raised in open source
        """
        raise EnterpriseFeatureRequired(
            feature="Workflow Execution",
            message=(
                "Workflow execution requires Caracal Enterprise. "
                "Visit https://garudexlabs.com for licensing information."
            ),
        )
    
    def create_workflow(
        self,
        name: str,
        definition: dict[str, Any],
    ) -> str:
        """
        Create workflow definition.
        
        In open source, this always raises EnterpriseFeatureRequired.
        
        Args:
            name: Workflow name (ignored in open source)
            definition: Workflow definition (ignored in open source)
        
        Raises:
            EnterpriseFeatureRequired: Always raised in open source
        """
        raise EnterpriseFeatureRequired(
            feature="Workflow Creation",
            message=(
                "Workflow creation requires Caracal Enterprise. "
                "Visit https://garudexlabs.com for licensing information."
            ),
        )
    
    def schedule_workflow(
        self,
        workflow_id: str,
        schedule: str,
        context: Optional[dict[str, Any]] = None,
    ) -> str:
        """
        Schedule workflow.
        
        In open source, this always raises EnterpriseFeatureRequired.
        
        Args:
            workflow_id: Workflow ID (ignored in open source)
            schedule: Schedule expression (ignored in open source)
            context: Context data (ignored in open source)
        
        Raises:
            EnterpriseFeatureRequired: Always raised in open source
        """
        raise EnterpriseFeatureRequired(
            feature="Workflow Scheduling",
            message=(
                "Workflow scheduling requires Caracal Enterprise. "
                "Visit https://garudexlabs.com for licensing information."
            ),
        )
    
    def get_workflow_status(self, execution_id: str) -> dict[str, Any]:
        """
        Get workflow execution status.
        
        In open source, this always raises EnterpriseFeatureRequired.
        
        Args:
            execution_id: Execution ID (ignored in open source)
        
        Raises:
            EnterpriseFeatureRequired: Always raised in open source
        """
        raise EnterpriseFeatureRequired(
            feature="Workflow Status",
            message=(
                "Workflow status tracking requires Caracal Enterprise. "
                "Visit https://garudexlabs.com for licensing information."
            ),
        )


# Convenience function for getting workflow engine
def get_workflow_engine() -> WorkflowEngine:
    """
    Get workflow engine instance.
    
    In open source, always returns OpenSourceWorkflowEngine.
    In Caracal Enterprise, returns the full workflow engine.
    
    Returns:
        WorkflowEngine instance (OpenSourceWorkflowEngine in open source)
    """
    # In open source, always return the stub
    return OpenSourceWorkflowEngine()
