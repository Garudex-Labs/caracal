"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for MCPAdapter pure static helper methods.
"""
import pytest
from unittest.mock import Mock, MagicMock
from types import SimpleNamespace

from caracal.exceptions import CaracalError, MCPToolTypeMismatchError, MCPToolBindingError
from caracal.mcp.adapter import MCPAdapter


def _adapter():
    from caracal.core.authority import AuthorityEvaluator
    from caracal.core.metering import MeteringCollector
    evaluator = Mock(spec=AuthorityEvaluator)
    metering = Mock(spec=MeteringCollector)
    return MCPAdapter(
        authority_evaluator=evaluator,
        metering_collector=metering,
    )


@pytest.mark.unit
class TestNormalizeToolId:
    def test_strips_whitespace(self):
        a = _adapter()
        assert a._normalize_tool_id("  mytool  ") == "mytool"

    def test_empty_raises(self):
        a = _adapter()
        with pytest.raises(CaracalError):
            a._normalize_tool_id("")

    def test_none_equivalent_raises(self):
        a = _adapter()
        with pytest.raises(CaracalError):
            a._normalize_tool_id("  ")


@pytest.mark.unit
class TestNormalizeWorkspaceName:
    def test_none_returns_none(self):
        assert MCPAdapter._normalize_workspace_name(None) is None

    def test_empty_string_returns_none(self):
        assert MCPAdapter._normalize_workspace_name("") is None

    def test_whitespace_returns_none(self):
        assert MCPAdapter._normalize_workspace_name("   ") is None

    def test_value_stripped(self):
        assert MCPAdapter._normalize_workspace_name("  dev  ") == "dev"


@pytest.mark.unit
class TestNormalizeToolType:
    def test_direct_api_accepted(self):
        assert MCPAdapter._normalize_tool_type("direct_api") == "direct_api"

    def test_logic_accepted(self):
        assert MCPAdapter._normalize_tool_type("logic") == "logic"

    def test_none_defaults_to_direct_api(self):
        assert MCPAdapter._normalize_tool_type(None) == "direct_api"

    def test_uppercase_normalized(self):
        assert MCPAdapter._normalize_tool_type("DIRECT_API") == "direct_api"

    def test_invalid_raises(self):
        with pytest.raises(MCPToolTypeMismatchError):
            MCPAdapter._normalize_tool_type("invalid")


@pytest.mark.unit
class TestNormalizeHandlerRef:
    def test_none_returns_none(self):
        assert MCPAdapter._normalize_handler_ref(None) is None

    def test_empty_returns_none(self):
        assert MCPAdapter._normalize_handler_ref("") is None

    def test_value_stripped(self):
        assert MCPAdapter._normalize_handler_ref("  mymodule:fn  ") == "mymodule:fn"


@pytest.mark.unit
class TestNormalizeAllowedDownstreamScopes:
    def test_none_returns_empty(self):
        assert MCPAdapter._normalize_allowed_downstream_scopes(None) == []

    def test_empty_list_returns_empty(self):
        assert MCPAdapter._normalize_allowed_downstream_scopes([]) == []

    def test_deduplicates(self):
        result = MCPAdapter._normalize_allowed_downstream_scopes(["a", "a", "b"])
        assert result == ["a", "b"]

    def test_empty_strings_filtered(self):
        result = MCPAdapter._normalize_allowed_downstream_scopes(["", "a"])
        assert "" not in result
        assert "a" in result

    def test_whitespace_stripped(self):
        result = MCPAdapter._normalize_allowed_downstream_scopes(["  scope  "])
        assert result == ["scope"]


@pytest.mark.unit
class TestValidateToolBindingContract:
    def test_direct_api_forward_valid(self):
        MCPAdapter._validate_tool_binding_contract(
            tool_id="t", execution_mode="mcp_forward", tool_type="direct_api", handler_ref=None
        )

    def test_direct_api_with_handler_ref_raises(self):
        with pytest.raises(MCPToolTypeMismatchError):
            MCPAdapter._validate_tool_binding_contract(
                tool_id="t", execution_mode="mcp_forward", tool_type="direct_api", handler_ref="mod:fn"
            )

    def test_direct_api_local_mode_raises(self):
        with pytest.raises(MCPToolTypeMismatchError):
            MCPAdapter._validate_tool_binding_contract(
                tool_id="t", execution_mode="local", tool_type="direct_api", handler_ref=None
            )

    def test_logic_local_without_handler_ref_raises(self):
        with pytest.raises(MCPToolBindingError):
            MCPAdapter._validate_tool_binding_contract(
                tool_id="t", execution_mode="local", tool_type="logic", handler_ref=None
            )

    def test_logic_local_with_handler_ref_valid(self):
        MCPAdapter._validate_tool_binding_contract(
            tool_id="t", execution_mode="local", tool_type="logic", handler_ref="mod:fn"
        )

    def test_logic_forward_without_handler_ref_valid(self):
        MCPAdapter._validate_tool_binding_contract(
            tool_id="t", execution_mode="mcp_forward", tool_type="logic", handler_ref=None
        )


@pytest.mark.unit
class TestCallableHandlerRef:
    def test_function_ref_built(self):
        def my_func():
            pass
        # my_func has __module__ and __name__
        result = MCPAdapter._callable_handler_ref(my_func)
        assert "my_func" in result

    def test_no_module_returns_empty(self):
        obj = SimpleNamespace(__name__="fn", __module__="")
        assert MCPAdapter._callable_handler_ref(obj) == ""

    def test_no_name_returns_empty(self):
        obj = SimpleNamespace(__name__="", __module__="mod")
        assert MCPAdapter._callable_handler_ref(obj) == ""


@pytest.mark.unit
class TestBindingContractKey:
    def test_full_key_returned(self):
        result = MCPAdapter._binding_contract_key(
            workspace_name="workspace",
            provider_name="prov",
            resource_scope="r:scope",
            action_scope="a:scope",
            tool_type="direct_api",
        )
        assert result == ("workspace", "prov", "r:scope", "a:scope", "direct_api")

    def test_missing_provider_returns_none(self):
        assert MCPAdapter._binding_contract_key(
            workspace_name="workspace", provider_name="", resource_scope="r", action_scope="a", tool_type="direct_api"
        ) is None

    def test_missing_resource_scope_returns_none(self):
        assert MCPAdapter._binding_contract_key(
            workspace_name="workspace", provider_name="p", resource_scope="", action_scope="a", tool_type="direct_api"
        ) is None

    def test_missing_action_scope_returns_none(self):
        assert MCPAdapter._binding_contract_key(
            workspace_name="workspace", provider_name="p", resource_scope="r", action_scope="", tool_type="direct_api"
        ) is None

    def test_none_workspace_defaults_to_default(self):
        result = MCPAdapter._binding_contract_key(
            workspace_name=None, provider_name="p", resource_scope="r", action_scope="a", tool_type=None
        )
        assert result is not None
        assert result[0] == "default"
        assert result[4] == "direct_api"


@pytest.mark.unit
class TestNormalizedRowWorkspaceName:
    def test_populated_workspace_name(self):
        row = SimpleNamespace(workspace_name="dev")
        assert MCPAdapter._normalized_row_workspace_name(row) == "dev"

    def test_empty_workspace_name_returns_default(self):
        row = SimpleNamespace(workspace_name="")
        assert MCPAdapter._normalized_row_workspace_name(row) == "default"

    def test_none_workspace_name_returns_default(self):
        row = SimpleNamespace(workspace_name=None)
        assert MCPAdapter._normalized_row_workspace_name(row) == "default"

    def test_missing_attr_returns_default(self):
        row = SimpleNamespace()
        assert MCPAdapter._normalized_row_workspace_name(row) == "default"


@pytest.mark.unit
class TestIsToolIdUniquenessViolation:
    def test_correct_sqlstate_and_constraint(self):
        assert MCPAdapter._is_tool_id_uniqueness_violation(
            sqlstate="23505",
            constraint="uq_registered_tools_active_workspace_tool_id",
            message="",
        ) is True

    def test_different_sqlstate_returns_false(self):
        assert MCPAdapter._is_tool_id_uniqueness_violation(
            sqlstate="23000", constraint="uq_registered_tools_tool_id", message=""
        ) is False

    def test_message_fallback(self):
        assert MCPAdapter._is_tool_id_uniqueness_violation(
            sqlstate="23505",
            constraint=None,
            message="duplicate key value violates unique constraint on (workspace_name, tool_id)",
        ) is True


@pytest.mark.unit
class TestIsBindingUniquenessViolation:
    def test_correct_constraint(self):
        assert MCPAdapter._is_binding_uniqueness_violation(
            sqlstate="23505",
            constraint="uq_registered_tools_active_workspace_binding",
            message="",
        ) is True

    def test_wrong_sqlstate_returns_false(self):
        assert MCPAdapter._is_binding_uniqueness_violation(
            sqlstate="23000", constraint="uq_registered_tools_active_workspace_binding", message=""
        ) is False


@pytest.mark.unit
class TestResolveCaveatMode:
    def test_jwt_mode(self):
        assert MCPAdapter._resolve_caveat_mode("jwt") == "jwt"

    def test_caveat_chain_mode(self):
        assert MCPAdapter._resolve_caveat_mode("caveat_chain") == "caveat_chain"

    def test_uppercase_normalized(self):
        assert MCPAdapter._resolve_caveat_mode("JWT") == "jwt"

    def test_invalid_mode_raises(self):
        with pytest.raises(CaracalError, match="Invalid caveat mode"):
            MCPAdapter._resolve_caveat_mode("magic")
