"""
Unit tests for the restricted interactive Caracal shell.
"""

from caracal.runtime.restricted_shell import parse_restricted_tokens


def test_restricted_shell_rejects_caracal_prefix() -> None:
    parsed = parse_restricted_tokens(["caracal", "workspace", "list"])

    assert parsed.args == []
    assert parsed.is_error is True
    assert "already inside Caracal CLI" in parsed.message


def test_restricted_shell_help_action() -> None:
    parsed = parse_restricted_tokens(["help"])

    assert parsed.action == "help"
    assert parsed.message is None


def test_restricted_shell_root_help_action() -> None:
    parsed = parse_restricted_tokens(["--help"])

    assert parsed.action == "help"
    assert parsed.message is None


def test_restricted_shell_alloworkspace_direct_command() -> None:
    parsed = parse_restricted_tokens(["workspace", "list"])

    assert parsed.args == ["workspace", "list"]
    assert parsed.message is None
    assert parsed.action is None
