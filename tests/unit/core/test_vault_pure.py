"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for core/vault.py pure module-level and static helpers.
"""

import pytest
from unittest.mock import MagicMock

pytestmark = pytest.mark.unit


class TestTruncateDetail:
    def setup_method(self):
        from caracal.core.vault import _truncate_detail
        self.fn = _truncate_detail

    def test_empty_string_returns_empty(self):
        assert self.fn("") == ""

    def test_none_returns_empty(self):
        assert self.fn(None) == ""

    def test_whitespace_returns_empty(self):
        assert self.fn("   ") == ""

    def test_short_string_unchanged(self):
        assert self.fn("hello world") == "hello world"

    def test_exactly_limit_unchanged(self):
        s = "a" * 300
        assert self.fn(s, limit=300) == s

    def test_over_limit_truncated(self):
        s = "b" * 400
        result = self.fn(s, limit=300)
        assert result.endswith("...")
        assert len(result) == 303

    def test_custom_limit(self):
        result = self.fn("a" * 20, limit=10)
        assert result == "a" * 10 + "..."

    def test_strips_surrounding_whitespace(self):
        assert self.fn("  hi  ") == "hi"


class TestJsonObject:
    def setup_method(self):
        from caracal.core.vault import _json_object
        self.fn = _json_object

    def _response(self, content, json_data=None):
        r = MagicMock()
        r.content = content
        if json_data is not None:
            r.json.return_value = json_data
        else:
            r.json.side_effect = ValueError("bad json")
        return r

    def test_empty_content_returns_empty_dict(self):
        r = self._response(b"")
        assert self.fn(r) == {}

    def test_valid_dict_response(self):
        r = self._response(b'{"key": "val"}', {"key": "val"})
        assert self.fn(r) == {"key": "val"}

    def test_json_parse_error_returns_empty_dict(self):
        r = self._response(b"not-json")
        assert self.fn(r) == {}

    def test_non_dict_json_returns_empty_dict(self):
        r = self._response(b"[1,2]", [1, 2])
        assert self.fn(r) == {}


class TestExtractString:
    def setup_method(self):
        from caracal.core.vault import _extract_string
        self.fn = _extract_string

    def test_simple_path_hit(self):
        payload = {"a": "hello"}
        assert self.fn(payload, ("a",)) == "hello"

    def test_nested_path_hit(self):
        payload = {"a": {"b": "deep"}}
        assert self.fn(payload, ("a", "b")) == "deep"

    def test_first_matching_path_wins(self):
        payload = {"x": "first", "y": "second"}
        assert self.fn(payload, ("x",), ("y",)) == "first"

    def test_fallback_to_second_path(self):
        payload = {"y": "second"}
        assert self.fn(payload, ("x",), ("y",)) == "second"

    def test_missing_all_paths_returns_none(self):
        assert self.fn({}, ("a",), ("b",)) is None

    def test_empty_string_value_not_returned(self):
        assert self.fn({"a": "   "}, ("a",)) is None

    def test_non_string_value_not_returned(self):
        assert self.fn({"a": 42}, ("a",)) is None


class TestIsLocalBootstrapToken:
    def setup_method(self):
        from caracal.core.vault import _is_local_bootstrap_token
        self.fn = _is_local_bootstrap_token

    def test_dev_local_token_is_local(self):
        assert self.fn("dev-local-token") is True

    def test_enterprise_local_token_is_local(self):
        assert self.fn("enterprise-local-token") is True

    def test_uppercase_is_normalized(self):
        assert self.fn("DEV-LOCAL-TOKEN") is True

    def test_random_token_is_not_local(self):
        assert self.fn("real-token-abc123") is False

    def test_empty_is_not_local(self):
        assert self.fn("") is False

    def test_none_is_not_local(self):
        assert self.fn(None) is False


class TestIsLocalBootstrapVaultUrl:
    def setup_method(self):
        from caracal.core.vault import _is_local_bootstrap_vault_url
        self.fn = _is_local_bootstrap_vault_url

    def test_localhost_is_local(self):
        assert self.fn("http://localhost:8200") is True

    def test_loopback_is_local(self):
        assert self.fn("http://127.0.0.1:8200") is True

    def test_vault_host_is_local(self):
        assert self.fn("https://vault:8200") is True

    def test_remote_host_is_not_local(self):
        assert self.fn("https://vault.company.com") is False

    def test_missing_scheme_is_not_local(self):
        assert self.fn("localhost:8200") is False

    def test_empty_is_not_local(self):
        assert self.fn("") is False


class TestNormalizeSecretPath:
    def setup_method(self):
        from caracal.core.vault import CaracalVault
        self.fn = CaracalVault._normalize_secret_path

    def test_slash_stays_slash(self):
        assert self.fn("/") == "/"

    def test_empty_becomes_slash(self):
        assert self.fn("") == "/"

    def test_none_becomes_slash(self):
        assert self.fn(None) == "/"

    def test_adds_leading_slash(self):
        assert self.fn("secrets") == "/secrets"

    def test_strips_trailing_slash(self):
        assert self.fn("/secrets/") == "/secrets"

    def test_preserves_interior_path(self):
        assert self.fn("/prod/app/") == "/prod/app"


class TestExtractSecretValue:
    def setup_method(self):
        from caracal.core.vault import CaracalVault
        self.fn = CaracalVault._extract_secret_value

    def test_secret_secretValue_path(self):
        payload = {"secret": {"secretValue": "mysecret"}}
        assert self.fn(payload) == "mysecret"

    def test_secret_snake_case(self):
        payload = {"secret": {"secret_value": "mysecret"}}
        assert self.fn(payload) == "mysecret"

    def test_top_level_secretValue(self):
        payload = {"secretValue": "top"}
        assert self.fn(payload) == "top"

    def test_data_nested(self):
        payload = {"data": {"secretValue": "nested"}}
        assert self.fn(payload) == "nested"

    def test_missing_returns_none(self):
        assert self.fn({}) is None

    def test_non_string_returns_none(self):
        payload = {"secretValue": 42}
        assert self.fn(payload) is None


class TestExtractSecretNames:
    def setup_method(self):
        from caracal.core.vault import CaracalVault
        self.fn = CaracalVault._extract_secret_names

    def test_empty_payload_returns_empty(self):
        assert self.fn({}) == []

    def test_secrets_list_with_secretKey(self):
        payload = {"secrets": [{"secretKey": "db_password"}, {"secretKey": "api_key"}]}
        result = self.fn(payload)
        assert "db_password" in result
        assert "api_key" in result

    def test_items_list_with_name(self):
        payload = {"items": [{"name": "secret_a"}, {"name": "secret_b"}]}
        assert "secret_a" in self.fn(payload)

    def test_deduplicates(self):
        payload = {"secrets": [{"secretKey": "x"}, {"secretKey": "x"}]}
        assert self.fn(payload).count("x") == 1

    def test_sorted_result(self):
        payload = {"secrets": [{"secretKey": "zzz"}, {"secretKey": "aaa"}]}
        result = self.fn(payload)
        assert result == sorted(result)


class TestIsMissingEndpoint:
    def setup_method(self):
        from caracal.core.vault import CaracalVault, VaultError
        self.is_bootstrap = CaracalVault._is_missing_bootstrap_endpoint
        self.is_sign = CaracalVault._is_missing_sign_endpoint
        self.VaultError = VaultError

    def test_bootstrap_404_matches(self):
        err = self.VaultError("POST /api/caracal/keys/bootstrap -> 404 not found")
        assert self.is_bootstrap(err) is True

    def test_bootstrap_other_error_no_match(self):
        err = self.VaultError("POST /api/caracal/keys/bootstrap -> 500 error")
        assert self.is_bootstrap(err) is False

    def test_sign_endpoint_404_matches(self):
        err = self.VaultError("POST /api/caracal/sign/jwt -> 404 not found")
        assert self.is_sign(err) is True

    def test_sign_endpoint_other_error_no_match(self):
        err = self.VaultError("POST /api/caracal/sign/jwt -> 500 error")
        assert self.is_sign(err) is False


class TestSaveRecoveredVaultToken:
    def setup_method(self):
        from caracal.core.vault import _save_recovered_vault_token
        self.fn = _save_recovered_vault_token

    def test_no_ccl_home_returns_silently(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.delenv("CCL_HOME", raising=False)
        self.fn("some-token")  # must not raise

    def test_writes_token_to_dotenv(self, monkeypatch: pytest.MonkeyPatch, tmp_path):
        monkeypatch.setenv("CCL_HOME", str(tmp_path))
        self.fn("my-vault-token")
        env_file = tmp_path / ".env"
        assert env_file.exists()
        content = env_file.read_text()
        assert "CCL_VAULT_ID_TOKEN=my-vault-token" in content

    def test_creates_missing_ccl_home_directory(self, monkeypatch: pytest.MonkeyPatch, tmp_path):
        nested_home = tmp_path / "nested" / "vault-home"
        monkeypatch.setenv("CCL_HOME", str(nested_home))
        self.fn("created-token")
        env_file = nested_home / ".env"
        assert env_file.exists()
        assert "CCL_VAULT_ID_TOKEN=created-token" in env_file.read_text()

    def test_replaces_existing_token(self, monkeypatch: pytest.MonkeyPatch, tmp_path):
        monkeypatch.setenv("CCL_HOME", str(tmp_path))
        env_file = tmp_path / ".env"
        env_file.write_text("CCL_VAULT_ID_TOKEN=old-token\nOTHER=val\n")
        self.fn("new-token")
        content = env_file.read_text()
        assert "CCL_VAULT_ID_TOKEN=new-token" in content
        assert "old-token" not in content
        assert "OTHER=val" in content

    def test_appends_when_key_absent(self, monkeypatch: pytest.MonkeyPatch, tmp_path):
        monkeypatch.setenv("CCL_HOME", str(tmp_path))
        env_file = tmp_path / ".env"
        env_file.write_text("EXISTING=value\n")
        self.fn("appended-token")
        content = env_file.read_text()
        assert "CCL_VAULT_ID_TOKEN=appended-token" in content
        assert "EXISTING=value" in content


class TestReadEnvOrDotenv:
    def setup_method(self):
        from caracal.core.vault import _read_env_or_dotenv
        self.fn = _read_env_or_dotenv

    def test_returns_env_var_when_set(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("CCL_TEST_KEY", "env-value")
        assert self.fn("CCL_TEST_KEY") == "env-value"

    def test_returns_none_when_not_found(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.delenv("CCL_TEST_KEY_ABSENT", raising=False)
        result = self.fn("CCL_TEST_KEY_ABSENT")
        assert result is None

    def test_reads_from_ccl_home_dotenv(self, monkeypatch: pytest.MonkeyPatch, tmp_path):
        monkeypatch.delenv("CCL_TEST_DOTENV_KEY", raising=False)
        monkeypatch.setenv("CCL_HOME", str(tmp_path))
        env_file = tmp_path / ".env"
        env_file.write_text("CCL_TEST_DOTENV_KEY=my-value\n")
        result = self.fn("CCL_TEST_DOTENV_KEY")
        assert result == "my-value"

    def test_strips_inline_comment(self, monkeypatch: pytest.MonkeyPatch, tmp_path):
        monkeypatch.delenv("CCL_COMMENT_KEY", raising=False)
        monkeypatch.setenv("CCL_HOME", str(tmp_path))
        env_file = tmp_path / ".env"
        env_file.write_text("CCL_COMMENT_KEY=real-val #comment\n")
        result = self.fn("CCL_COMMENT_KEY")
        assert result == "real-val"

    def test_strips_quoted_value(self, monkeypatch: pytest.MonkeyPatch, tmp_path):
        monkeypatch.delenv("CCL_QUOTED_KEY", raising=False)
        monkeypatch.setenv("CCL_HOME", str(tmp_path))
        env_file = tmp_path / ".env"
        env_file.write_text('CCL_QUOTED_KEY="quoted-value"\n')
        result = self.fn("CCL_QUOTED_KEY")
        assert result == "quoted-value"

    def test_skips_comments_in_dotenv(self, monkeypatch: pytest.MonkeyPatch, tmp_path):
        monkeypatch.delenv("CCL_COMMENT_LINE", raising=False)
        monkeypatch.setenv("CCL_HOME", str(tmp_path))
        env_file = tmp_path / ".env"
        env_file.write_text("# this is a comment\nCCL_COMMENT_LINE=val\n")
        result = self.fn("CCL_COMMENT_LINE")
        assert result == "val"


class TestLoadVaultConfig:
    def setup_method(self):
        from caracal.core.vault import _load_vault_config
        self.fn = _load_vault_config

    def _set_valid_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("CCL_VAULT_URL", "https://vault.example.com")
        monkeypatch.setenv("CCL_VAULT_TOKEN", "tok-abc")
        monkeypatch.setenv("CCL_VAULT_MODE", "managed")

    def test_returns_config_with_valid_env(self, monkeypatch: pytest.MonkeyPatch):
        self._set_valid_env(monkeypatch)
        cfg = self.fn()
        assert cfg.base_url == "https://vault.example.com"
        assert cfg.token == "tok-abc"
        assert cfg.mode == "managed"

    def test_default_environment_is_dev(self, monkeypatch: pytest.MonkeyPatch):
        self._set_valid_env(monkeypatch)
        monkeypatch.delenv("CCL_VAULT_ENVIRONMENT", raising=False)
        cfg = self.fn()
        assert cfg.default_environment == "dev"

    def test_default_secret_path_is_slash(self, monkeypatch: pytest.MonkeyPatch):
        self._set_valid_env(monkeypatch)
        monkeypatch.delenv("CCL_VAULT_SECRET_PATH", raising=False)
        cfg = self.fn()
        assert cfg.default_secret_path == "/"

    def test_missing_url_raises(self, monkeypatch: pytest.MonkeyPatch):
        from caracal.core import vault as vault_module
        from caracal.core.vault import VaultConfigurationError

        monkeypatch.setattr(
            vault_module,
            "_read_env_or_dotenv",
            lambda name: {
                "CCL_VAULT_URL": None,
                "CCL_VAULT_TOKEN": "tok",
                "CCL_VAULT_MODE": "managed",
            }.get(name),
        )
        with pytest.raises(VaultConfigurationError, match="CCL_VAULT_URL"):
            self.fn()

    def test_missing_token_raises(self, monkeypatch: pytest.MonkeyPatch):
        from caracal.core import vault as vault_module
        from caracal.core.vault import VaultConfigurationError

        monkeypatch.setattr(
            vault_module,
            "_read_env_or_dotenv",
            lambda name: {
                "CCL_VAULT_URL": "https://vault.example.com",
                "CCL_VAULT_TOKEN": None,
                "CCL_VAULT_MODE": "managed",
            }.get(name),
        )
        with pytest.raises(VaultConfigurationError, match="CCL_VAULT_TOKEN"):
            self.fn()

    def test_invalid_mode_raises(self, monkeypatch: pytest.MonkeyPatch):
        from caracal.core.vault import VaultConfigurationError
        monkeypatch.setenv("CCL_VAULT_URL", "https://vault.example.com")
        monkeypatch.setenv("CCL_VAULT_TOKEN", "tok-abc")
        monkeypatch.setenv("CCL_VAULT_MODE", "badmode")
        with pytest.raises(VaultConfigurationError, match="CCL_VAULT_MODE"):
            self.fn()

    def test_invalid_retry_attempts_raises(self, monkeypatch: pytest.MonkeyPatch):
        from caracal.core.vault import VaultConfigurationError
        self._set_valid_env(monkeypatch)
        monkeypatch.setenv("CCL_VAULT_RETRY_MAX_ATTEMPTS", "not-a-number")
        with pytest.raises(VaultConfigurationError, match="CCL_VAULT_RETRY_MAX_ATTEMPTS"):
            self.fn()

    def test_invalid_retry_backoff_raises(self, monkeypatch: pytest.MonkeyPatch):
        from caracal.core.vault import VaultConfigurationError
        self._set_valid_env(monkeypatch)
        monkeypatch.setenv("CCL_VAULT_RETRY_BACKOFF_SECONDS", "not-a-float")
        with pytest.raises(VaultConfigurationError, match="CCL_VAULT_RETRY_BACKOFF_SECONDS"):
            self.fn()
