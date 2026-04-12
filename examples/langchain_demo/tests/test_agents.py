"""
Unit tests for agent system components.

Tests cover:
- BaseAgent: Abstract base class and common functionality
- AgentMessage: Message data model
- AgentState: State management data model
- AgentStateManager: Centralized state management
- CommunicationBus: Agent-to-agent communication
- AgentRegistry: Agent factory and instance management
"""

import pytest
import asyncio
from datetime import datetime
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent))

from agents.base import (
    BaseAgent,
    AgentMessage,
    AgentState,
    AgentRole,
    MessageType,
)
from agents.state_manager import (
    AgentStateManager,
    StateSnapshot,
    get_state_manager,
    reset_state_manager,
)
from agents.communication import (
    CommunicationBus,
    AgentCommunication,
    CommunicationType,
    DelegationRequest,
    DelegationResult,
    get_communication_bus,
    reset_communication_bus,
)
from agents.registry import (
    AgentRegistry,
    AgentFactory,
    AgentRegistration,
    get_agent_registry,
    reset_agent_registry,
)


# Test implementation of BaseAgent for testing
class TestAgent(BaseAgent):
    """Concrete implementation of BaseAgent for testing."""
    
    async def execute(self, task: str, **kwargs):
        """Execute a test task."""
        self.emit_message(MessageType.THOUGHT, f"Thinking about: {task}")
        self.emit_message(MessageType.ACTION, f"Executing: {task}")
        self.emit_message(MessageType.OBSERVATION, f"Result: {kwargs.get('result', 'success')}")
        return {"status": "completed", "task": task, **kwargs}


class TestAgentMessage:
    """Tests for AgentMessage data model."""
    
    def test_init(self):
        """Test message initialization."""
        msg = AgentMessage(
            agent_id="test-agent-1",
            agent_role=AgentRole.ORCHESTRATOR,
            message_type=MessageType.THOUGHT,
            content="Test message"
        )
        
        assert msg.agent_id == "test-agent-1"
        assert msg.agent_role == AgentRole.ORCHESTRATOR
        assert msg.message_type == MessageType.THOUGHT
        assert msg.content == "Test message"
        assert isinstance(msg.timestamp, datetime)
        assert msg.metadata == {}
    
    def test_init_with_metadata(self):
        """Test message initialization with metadata."""
        metadata = {"key": "value", "count": 42}
        msg = AgentMessage(
            agent_id="test-agent-1",
            agent_role=AgentRole.FINANCE,
            message_type=MessageType.ACTION,
            content="Test action",
            metadata=metadata
        )
        
        assert msg.metadata == metadata
    
    def test_to_dict(self):
        """Test converting message to dictionary."""
        msg = AgentMessage(
            agent_id="test-agent-1",
            agent_role=AgentRole.OPS,
            message_type=MessageType.RESPONSE,
            content="Test response",
            metadata={"key": "value"}
        )
        
        result = msg.to_dict()
        
        assert isinstance(result, dict)
        assert result["agent_id"] == "test-agent-1"
        assert result["agent_role"] == "ops"
        assert result["message_type"] == "response"
        assert result["content"] == "Test response"
        assert isinstance(result["timestamp"], str)
        assert result["metadata"] == {"key": "value"}


class TestAgentState:
    """Tests for AgentState data model."""
    
    def test_init(self):
        """Test state initialization."""
        state = AgentState(
            agent_id="test-agent-1",
            agent_role=AgentRole.ANALYST,
            mandate_id="mandate-123"
        )
        
        assert state.agent_id == "test-agent-1"
        assert state.agent_role == AgentRole.ANALYST
        assert state.mandate_id == "mandate-123"
        assert state.parent_agent_id is None
        assert state.messages == []
        assert state.tool_calls == []
        assert state.sub_agents == []
        assert state.context == {}
        assert state.status == "active"
        assert isinstance(state.created_at, datetime)
        assert state.completed_at is None
    
    def test_init_with_parent(self):
        """Test state initialization with parent agent."""
        state = AgentState(
            agent_id="sub-agent-1",
            agent_role=AgentRole.ANALYST,
            mandate_id="mandate-456",
            parent_agent_id="parent-agent-1"
        )
        
        assert state.parent_agent_id == "parent-agent-1"
    
    def test_add_message(self):
        """Test adding message to state."""
        state = AgentState(
            agent_id="test-agent-1",
            agent_role=AgentRole.FINANCE,
            mandate_id="mandate-123"
        )
        
        msg = AgentMessage(
            agent_id="test-agent-1",
            agent_role=AgentRole.FINANCE,
            message_type=MessageType.THOUGHT,
            content="Test thought"
        )
        
        state.add_message(msg)
        
        assert len(state.messages) == 1
        assert state.messages[0] == msg
    
    def test_add_tool_call(self):
        """Test adding tool call to state."""
        state = AgentState(
            agent_id="test-agent-1",
            agent_role=AgentRole.OPS,
            mandate_id="mandate-123"
        )
        
        state.add_tool_call("tool-call-1")
        state.add_tool_call("tool-call-2")
        
        assert len(state.tool_calls) == 2
        assert "tool-call-1" in state.tool_calls
        assert "tool-call-2" in state.tool_calls
    
    def test_add_sub_agent(self):
        """Test adding sub-agent to state."""
        state = AgentState(
            agent_id="parent-agent-1",
            agent_role=AgentRole.ORCHESTRATOR,
            mandate_id="mandate-123"
        )
        
        state.add_sub_agent("sub-agent-1")
        state.add_sub_agent("sub-agent-2")
        
        assert len(state.sub_agents) == 2
        assert "sub-agent-1" in state.sub_agents
        assert "sub-agent-2" in state.sub_agents
    
    def test_mark_completed(self):
        """Test marking state as completed."""
        state = AgentState(
            agent_id="test-agent-1",
            agent_role=AgentRole.REPORTER,
            mandate_id="mandate-123"
        )
        
        assert state.status == "active"
        assert state.completed_at is None
        
        state.mark_completed()
        
        assert state.status == "completed"
        assert isinstance(state.completed_at, datetime)
    
    def test_mark_error(self):
        """Test marking state as error."""
        state = AgentState(
            agent_id="test-agent-1",
            agent_role=AgentRole.FINANCE,
            mandate_id="mandate-123"
        )
        
        state.mark_error()
        
        assert state.status == "error"
        assert isinstance(state.completed_at, datetime)
    
    def test_to_dict(self):
        """Test converting state to dictionary."""
        state = AgentState(
            agent_id="test-agent-1",
            agent_role=AgentRole.ORCHESTRATOR,
            mandate_id="mandate-123",
            parent_agent_id="parent-1"
        )
        
        msg = AgentMessage(
            agent_id="test-agent-1",
            agent_role=AgentRole.ORCHESTRATOR,
            message_type=MessageType.THOUGHT,
            content="Test"
        )
        state.add_message(msg)
        state.add_tool_call("tool-1")
        state.add_sub_agent("sub-1")
        state.mark_completed()
        
        result = state.to_dict()
        
        assert isinstance(result, dict)
        assert result["agent_id"] == "test-agent-1"
        assert result["agent_role"] == "orchestrator"
        assert result["mandate_id"] == "mandate-123"
        assert result["parent_agent_id"] == "parent-1"
        assert len(result["messages"]) == 1
        assert result["tool_calls"] == ["tool-1"]
        assert result["sub_agents"] == ["sub-1"]
        assert result["status"] == "completed"
        assert isinstance(result["created_at"], str)
        assert isinstance(result["completed_at"], str)


class TestBaseAgent:
    """Tests for BaseAgent abstract class."""
    
    def test_init(self):
        """Test agent initialization."""
        agent = TestAgent(
            role=AgentRole.FINANCE,
            mandate_id="mandate-123"
        )
        
        assert agent.role == AgentRole.FINANCE
        assert agent.mandate_id == "mandate-123"
        assert agent.parent_agent is None
        assert isinstance(agent.agent_id, str)
        assert len(agent.agent_id) > 0
        assert isinstance(agent.state, AgentState)
        assert agent.state.agent_role == AgentRole.FINANCE
    
    def test_init_with_parent(self):
        """Test agent initialization with parent."""
        parent = TestAgent(
            role=AgentRole.ORCHESTRATOR,
            mandate_id="mandate-parent"
        )
        
        child = TestAgent(
            role=AgentRole.ANALYST,
            mandate_id="mandate-child",
            parent_agent=parent
        )
        
        assert child.parent_agent is parent
        assert child.state.parent_agent_id == parent.agent_id
    
    def test_init_with_custom_id(self):
        """Test agent initialization with custom ID."""
        agent = TestAgent(
            role=AgentRole.OPS,
            mandate_id="mandate-123",
            agent_id="custom-agent-id"
        )
        
        assert agent.agent_id == "custom-agent-id"
    
    def test_init_with_context(self):
        """Test agent initialization with context."""
        context = {"key": "value", "count": 42}
        agent = TestAgent(
            role=AgentRole.REPORTER,
            mandate_id="mandate-123",
            context=context
        )
        
        assert agent.state.context == context
    
    def test_emit_message(self):
        """Test emitting messages."""
        agent = TestAgent(
            role=AgentRole.FINANCE,
            mandate_id="mandate-123"
        )
        
        msg = agent.emit_message(
            MessageType.THOUGHT,
            "Test thought",
            metadata={"key": "value"}
        )
        
        assert isinstance(msg, AgentMessage)
        assert msg.agent_id == agent.agent_id
        assert msg.agent_role == AgentRole.FINANCE
        assert msg.message_type == MessageType.THOUGHT
        assert msg.content == "Test thought"
        assert msg.metadata == {"key": "value"}
        
        # Check message was added to state
        assert len(agent.state.messages) == 1
        assert agent.state.messages[0] == msg
    
    def test_record_tool_call(self):
        """Test recording tool calls."""
        agent = TestAgent(
            role=AgentRole.OPS,
            mandate_id="mandate-123"
        )
        
        agent.record_tool_call("tool-call-1")
        agent.record_tool_call("tool-call-2")
        
        assert len(agent.state.tool_calls) == 2
        assert "tool-call-1" in agent.state.tool_calls
        assert "tool-call-2" in agent.state.tool_calls
    
    def test_spawn_sub_agent_not_implemented(self):
        """Test that spawn_sub_agent raises NotImplementedError by default."""
        agent = TestAgent(
            role=AgentRole.ORCHESTRATOR,
            mandate_id="mandate-123"
        )
        
        with pytest.raises(NotImplementedError):
            agent.spawn_sub_agent(
                AgentRole.FINANCE,
                "mandate-sub"
            )
    
    @pytest.mark.asyncio
    async def test_execute(self):
        """Test executing agent task."""
        agent = TestAgent(
            role=AgentRole.ANALYST,
            mandate_id="mandate-123"
        )
        
        result = await agent.execute("analyze data", result="success")
        
        assert result["status"] == "completed"
        assert result["task"] == "analyze data"
        assert result["result"] == "success"
        
        # Check messages were emitted
        assert len(agent.state.messages) == 3
        assert agent.state.messages[0].message_type == MessageType.THOUGHT
        assert agent.state.messages[1].message_type == MessageType.ACTION
        assert agent.state.messages[2].message_type == MessageType.OBSERVATION
    
    def test_get_state(self):
        """Test getting agent state."""
        agent = TestAgent(
            role=AgentRole.FINANCE,
            mandate_id="mandate-123"
        )
        
        state = agent.get_state()
        
        assert isinstance(state, AgentState)
        assert state is agent.state
    
    def test_get_messages(self):
        """Test getting agent messages."""
        agent = TestAgent(
            role=AgentRole.OPS,
            mandate_id="mandate-123"
        )
        
        agent.emit_message(MessageType.THOUGHT, "Thought 1")
        agent.emit_message(MessageType.ACTION, "Action 1")
        
        messages = agent.get_messages()
        
        assert len(messages) == 2
        assert messages[0].content == "Thought 1"
        assert messages[1].content == "Action 1"
    
    def test_repr(self):
        """Test string representation."""
        agent = TestAgent(
            role=AgentRole.REPORTER,
            mandate_id="mandate-123",
            agent_id="test-agent-123"
        )
        
        repr_str = repr(agent)
        
        assert "TestAgent" in repr_str
        assert "test-age" in repr_str  # First 8 chars of ID
        assert "reporter" in repr_str
        assert "active" in repr_str


class TestAgentStateManager:
    """Tests for AgentStateManager."""
    
    def setup_method(self):
        """Reset state manager before each test."""
        reset_state_manager()
    
    def test_init(self):
        """Test state manager initialization."""
        manager = AgentStateManager()
        
        assert len(manager) == 0
        assert manager.get_all_states() == {}
    
    def test_register_agent(self):
        """Test registering an agent."""
        manager = AgentStateManager()
        
        state = AgentState(
            agent_id="agent-1",
            agent_role=AgentRole.FINANCE,
            mandate_id="mandate-1"
        )
        
        manager.register_agent(state)
        
        assert len(manager) == 1
        assert manager.get_agent_state("agent-1") is state
    
    def test_update_agent_state(self):
        """Test updating agent state."""
        manager = AgentStateManager()
        
        state1 = AgentState(
            agent_id="agent-1",
            agent_role=AgentRole.OPS,
            mandate_id="mandate-1"
        )
        manager.register_agent(state1)
        
        state2 = AgentState(
            agent_id="agent-1",
            agent_role=AgentRole.OPS,
            mandate_id="mandate-1"
        )
        state2.mark_completed()
        
        manager.update_agent_state("agent-1", state2)
        
        retrieved = manager.get_agent_state("agent-1")
        assert retrieved.status == "completed"
    
    def test_update_agent_state_not_found(self):
        """Test updating non-existent agent."""
        manager = AgentStateManager()
        
        state = AgentState(
            agent_id="agent-1",
            agent_role=AgentRole.ANALYST,
            mandate_id="mandate-1"
        )
        
        with pytest.raises(KeyError):
            manager.update_agent_state("nonexistent", state)
    
    def test_get_agents_by_role(self):
        """Test getting agents by role."""
        manager = AgentStateManager()
        
        state1 = AgentState(agent_id="agent-1", agent_role=AgentRole.FINANCE, mandate_id="m1")
        state2 = AgentState(agent_id="agent-2", agent_role=AgentRole.FINANCE, mandate_id="m2")
        state3 = AgentState(agent_id="agent-3", agent_role=AgentRole.OPS, mandate_id="m3")
        
        manager.register_agent(state1)
        manager.register_agent(state2)
        manager.register_agent(state3)
        
        finance_agents = manager.get_agents_by_role(AgentRole.FINANCE)
        
        assert len(finance_agents) == 2
        assert state1 in finance_agents
        assert state2 in finance_agents
    
    def test_get_agents_by_status(self):
        """Test getting agents by status."""
        manager = AgentStateManager()
        
        state1 = AgentState(agent_id="agent-1", agent_role=AgentRole.ORCHESTRATOR, mandate_id="m1")
        state2 = AgentState(agent_id="agent-2", agent_role=AgentRole.FINANCE, mandate_id="m2")
        state2.mark_completed()
        state3 = AgentState(agent_id="agent-3", agent_role=AgentRole.OPS, mandate_id="m3")
        state3.mark_error()
        
        manager.register_agent(state1)
        manager.register_agent(state2)
        manager.register_agent(state3)
        
        active = manager.get_agents_by_status("active")
        completed = manager.get_agents_by_status("completed")
        error = manager.get_agents_by_status("error")
        
        assert len(active) == 1
        assert len(completed) == 1
        assert len(error) == 1
    
    def test_get_sub_agents(self):
        """Test getting sub-agents."""
        manager = AgentStateManager()
        
        parent = AgentState(agent_id="parent", agent_role=AgentRole.ORCHESTRATOR, mandate_id="m1")
        child1 = AgentState(agent_id="child1", agent_role=AgentRole.FINANCE, mandate_id="m2", parent_agent_id="parent")
        child2 = AgentState(agent_id="child2", agent_role=AgentRole.OPS, mandate_id="m3", parent_agent_id="parent")
        other = AgentState(agent_id="other", agent_role=AgentRole.ANALYST, mandate_id="m4")
        
        manager.register_agent(parent)
        manager.register_agent(child1)
        manager.register_agent(child2)
        manager.register_agent(other)
        
        sub_agents = manager.get_sub_agents("parent")
        
        assert len(sub_agents) == 2
        assert child1 in sub_agents
        assert child2 in sub_agents
    
    def test_get_statistics(self):
        """Test getting statistics."""
        manager = AgentStateManager()
        
        state1 = AgentState(agent_id="agent-1", agent_role=AgentRole.ORCHESTRATOR, mandate_id="m1")
        state2 = AgentState(agent_id="agent-2", agent_role=AgentRole.FINANCE, mandate_id="m2")
        state2.mark_completed()
        
        msg = AgentMessage(agent_id="agent-1", agent_role=AgentRole.ORCHESTRATOR, message_type=MessageType.THOUGHT, content="test")
        state1.add_message(msg)
        state1.add_tool_call("tool-1")
        
        manager.register_agent(state1)
        manager.register_agent(state2)
        
        stats = manager.get_statistics()
        
        assert stats["total_agents"] == 2
        assert stats["active_agents"] == 1
        assert stats["completed_agents"] == 1
        assert stats["total_messages"] == 1
        assert stats["total_tool_calls"] == 1
    
    def test_global_state_manager(self):
        """Test global state manager singleton."""
        manager1 = get_state_manager()
        manager2 = get_state_manager()
        
        assert manager1 is manager2


class TestCommunicationBus:
    """Tests for CommunicationBus."""
    
    def setup_method(self):
        """Reset communication bus before each test."""
        reset_communication_bus()
    
    def test_init(self):
        """Test communication bus initialization."""
        bus = CommunicationBus()
        
        assert len(bus) == 0
    
    @pytest.mark.asyncio
    async def test_send_and_subscribe(self):
        """Test sending and receiving communications."""
        bus = CommunicationBus()
        received = []
        
        def handler(comm):
            received.append(comm)
        
        bus.subscribe("agent-2", handler)
        
        comm = AgentCommunication(
            from_agent_id="agent-1",
            to_agent_id="agent-2",
            communication_type=CommunicationType.NOTIFICATION,
            payload={"message": "hello"}
        )
        
        await bus.send(comm)
        
        assert len(received) == 1
        assert received[0] is comm
    
    @pytest.mark.asyncio
    async def test_request_response(self):
        """Test request-response pattern."""
        bus = CommunicationBus()
        
        async def handler(comm):
            if comm.communication_type == CommunicationType.REQUEST:
                await bus.respond(
                    to_communication_id=comm.communication_id,
                    from_agent_id="agent-2",
                    to_agent_id="agent-1",
                    payload={"result": "success"}
                )
        
        bus.subscribe("agent-2", handler)
        
        response = await bus.request(
            from_agent_id="agent-1",
            to_agent_id="agent-2",
            payload={"query": "test"}
        )
        
        assert response == {"result": "success"}
    
    @pytest.mark.asyncio
    async def test_delegation(self):
        """Test delegation pattern."""
        bus = CommunicationBus()
        
        async def handler(comm):
            if comm.communication_type == CommunicationType.DELEGATION:
                result = DelegationResult(
                    success=True,
                    result={"data": "completed"},
                    execution_time_seconds=0.5
                )
                await bus.send_delegation_result(
                    to_communication_id=comm.communication_id,
                    from_agent_id="agent-2",
                    to_agent_id="agent-1",
                    result=result
                )
        
        bus.subscribe("agent-2", handler)
        
        delegation_request = DelegationRequest(
            task_description="test task",
            delegated_mandate_id="mandate-2"
        )
        
        result = await bus.delegate(
            from_agent_id="agent-1",
            to_agent_id="agent-2",
            delegation_request=delegation_request
        )
        
        assert result.success is True
        assert result.result == {"data": "completed"}
    
    def test_global_communication_bus(self):
        """Test global communication bus singleton."""
        bus1 = get_communication_bus()
        bus2 = get_communication_bus()
        
        assert bus1 is bus2


class TestAgentRegistry:
    """Tests for AgentRegistry."""
    
    def setup_method(self):
        """Reset registry before each test."""
        reset_agent_registry()
    
    def test_init(self):
        """Test registry initialization."""
        registry = AgentRegistry()
        
        assert len(registry) == 0
    
    def test_register_factory(self):
        """Test registering agent factory."""
        registry = AgentRegistry()
        
        factory = AgentFactory(
            role=AgentRole.FINANCE,
            agent_class=TestAgent,
            description="Test finance agent"
        )
        
        registry.register_factory(factory)
        
        retrieved = registry.get_factory(AgentRole.FINANCE)
        assert retrieved is factory
    
    def test_create_agent(self):
        """Test creating agent from factory."""
        registry = AgentRegistry()
        
        factory = AgentFactory(
            role=AgentRole.OPS,
            agent_class=TestAgent,
            description="Test ops agent"
        )
        registry.register_factory(factory)
        
        agent = registry.create_agent(
            role=AgentRole.OPS,
            mandate_id="mandate-123"
        )
        
        assert isinstance(agent, TestAgent)
        assert agent.role == AgentRole.OPS
        assert agent.mandate_id == "mandate-123"
        assert len(registry) == 1
    
    def test_list_instances_by_role(self):
        """Test listing instances by role."""
        registry = AgentRegistry()
        
        factory1 = AgentFactory(role=AgentRole.FINANCE, agent_class=TestAgent, description="Finance")
        factory2 = AgentFactory(role=AgentRole.OPS, agent_class=TestAgent, description="Ops")
        registry.register_factory(factory1)
        registry.register_factory(factory2)
        
        agent1 = registry.create_agent(AgentRole.FINANCE, "m1")
        agent2 = registry.create_agent(AgentRole.FINANCE, "m2")
        agent3 = registry.create_agent(AgentRole.OPS, "m3")
        
        finance_agents = registry.list_instances(role=AgentRole.FINANCE)
        
        assert len(finance_agents) == 2
        assert agent1 in finance_agents
        assert agent2 in finance_agents
    
    def test_global_agent_registry(self):
        """Test global agent registry singleton."""
        registry1 = get_agent_registry()
        registry2 = get_agent_registry()
        
        assert registry1 is registry2
