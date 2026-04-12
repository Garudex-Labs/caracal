# Configuration Schema Documentation

This document describes the complete configuration schema for the Caracal Unified Demo.

## Table of Contents

- [Overview](#overview)
- [Configuration File Location](#configuration-file-location)
- [Schema Version](#schema-version)
- [Configuration Sections](#configuration-sections)
  - [Caracal](#caracal)
  - [Modes](#modes)
  - [Scenario](#scenario)
  - [UI](#ui)
  - [Logging](#logging)
  - [Mock System](#mock-system)
  - [Agent](#agent)
- [Example Configurations](#example-configurations)
- [Configuration Migration](#configuration-migration)
- [Validation](#validation)

## Overview

The demo uses a JSON configuration file to control all aspects of the application including Caracal integration, UI settings, logging, mock system behavior, and agent configuration.

## Configuration File Location

The configuration file is located at:
- Default: `examples/langchain_demo/demo_config.json`
- Can be overridden with environment variable: `LANGCHAIN_DEMO_CONFIG`

Example:
```bash
export LANGCHAIN_DEMO_CONFIG=/path/to/custom/config.json
```

## Schema Version

Current schema version: **2.0**

The configuration file should include a `_config_version` field to track the schema version:

```json
{
  "_config_version": "2.0",
  ...
}
```

## Configuration Sections

### Caracal

Configuration for Caracal runtime connection and authentication.

```json
{
  "caracal": {
    "base_url": "http://127.0.0.1:8080",
    "api_key_env": "CARACAL_API_KEY",
    "organization_id": null,
    "workspace_id": "langchain-demo",
    "project_id": null
  }
}
```

**Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `base_url` | string | Yes | Base URL of the Caracal runtime API |
| `api_key_env` | string | Yes | Name of environment variable containing the API key |
| `organization_id` | string | No | Organization ID (optional) |
| `workspace_id` | string | No | Workspace ID (recommended) |
| `project_id` | string | No | Project ID (optional) |

**Validation Rules:**
- `base_url` must start with `http://` or `https://`
- `api_key_env` must reference a valid environment variable
- API key must be set in the environment when running in real mode

### Modes

Configuration for mock and real execution modes.

```json
{
  "modes": {
    "mock": {
      "source_mandate_id": "mandate-123",
      "revoker_id": "principal-456",
      "principal_ids": {
        "orchestrator": "principal-orch",
        "finance": "principal-fin",
        "ops": "principal-ops"
      },
      "mandates": {
        "orchestrator": "mandate-orch",
        "finance": "mandate-fin",
        "ops": "mandate-ops"
      }
    },
    "real": {
      ...
    }
  }
}
```

**Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `source_mandate_id` | string | No | Source mandate for delegation |
| `revoker_id` | string | No | Principal ID authorized to revoke mandates |
| `principal_ids` | object | No | Map of role names to principal IDs |
| `mandates` | object | Yes | Map of role names to mandate IDs |

**Required Roles:**
- `orchestrator`: Main orchestrator agent
- `finance`: Finance specialist agent
- `ops`: Operations specialist agent

**Validation Rules:**
- All three required roles must have mandate IDs
- Principal IDs are optional but recommended for delegation tracking

### Scenario

Configuration for scenario system.

```json
{
  "scenario": {
    "default_scenario": "default",
    "scenarios_path": null,
    "auto_load": true
  }
}
```

**Fields:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `default_scenario` | string | No | "default" | Default scenario to load on startup |
| `scenarios_path` | string | No | null | Custom path to scenario definitions |
| `auto_load` | boolean | No | true | Whether to auto-load scenarios on startup |

**Validation Rules:**
- `default_scenario` must be a non-empty string
- `scenarios_path` must exist if specified
- `auto_load` must be a boolean

### UI

Configuration for web user interface.

```json
{
  "ui": {
    "host": "127.0.0.1",
    "port": 8000,
    "enable_websocket": true,
    "websocket_ping_interval": 30,
    "max_message_history": 1000,
    "enable_logs_panel": true,
    "enable_tool_panel": true,
    "enable_caracal_panel": true
  }
}
```

**Fields:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `host` | string | No | "127.0.0.1" | Host address to bind the web server |
| `port` | integer | No | 8000 | Port number for the web server |
| `enable_websocket` | boolean | No | true | Enable WebSocket for real-time updates |
| `websocket_ping_interval` | integer | No | 30 | WebSocket ping interval in seconds |
| `max_message_history` | integer | No | 1000 | Maximum number of messages to keep in history |
| `enable_logs_panel` | boolean | No | true | Show logs panel in UI |
| `enable_tool_panel` | boolean | No | true | Show tool activity panel in UI |
| `enable_caracal_panel` | boolean | No | true | Show Caracal state panel in UI |

**Validation Rules:**
- `host` must be a non-empty string
- `port` must be between 1 and 65535
- `websocket_ping_interval` must be positive
- `max_message_history` must be positive

### Logging

Configuration for application logging.

```json
{
  "logging": {
    "level": "INFO",
    "format": "detailed",
    "log_to_file": false,
    "log_file_path": null,
    "max_file_size_mb": 10,
    "backup_count": 3
  }
}
```

**Fields:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `level` | string | No | "INFO" | Logging level |
| `format` | string | No | "detailed" | Log format style |
| `log_to_file` | boolean | No | false | Enable file logging |
| `log_file_path` | string | No | null | Path to log file |
| `max_file_size_mb` | integer | No | 10 | Maximum log file size in MB |
| `backup_count` | integer | No | 3 | Number of backup log files to keep |

**Valid Values:**
- `level`: "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"
- `format`: "simple", "detailed", "json"

**Validation Rules:**
- `level` must be one of the valid logging levels
- `format` must be one of the valid format types
- `log_file_path` is required when `log_to_file` is true
- `max_file_size_mb` must be positive
- `backup_count` must be non-negative

### Mock System

Configuration for mock system behavior.

```json
{
  "mock_system": {
    "enabled": true,
    "config_path": null,
    "cache_responses": true,
    "simulate_delays": true,
    "default_llm_provider": "openai"
  }
}
```

**Fields:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `enabled` | boolean | No | true | Enable mock system |
| `config_path` | string | No | null | Custom path to mock configurations |
| `cache_responses` | boolean | No | true | Cache mock responses for performance |
| `simulate_delays` | boolean | No | true | Simulate realistic API delays |
| `default_llm_provider` | string | No | "openai" | Default LLM provider for mock responses |

**Validation Rules:**
- `config_path` must exist if specified
- `default_llm_provider` must be a non-empty string

### Agent

Configuration for agent system behavior.

```json
{
  "agent": {
    "max_iterations": 10,
    "timeout_seconds": 300,
    "enable_sub_agents": true,
    "max_delegation_depth": 3
  }
}
```

**Fields:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `max_iterations` | integer | No | 10 | Maximum iterations for agent workflows |
| `timeout_seconds` | integer | No | 300 | Timeout for agent operations in seconds |
| `enable_sub_agents` | boolean | No | true | Enable sub-agent spawning |
| `max_delegation_depth` | integer | No | 3 | Maximum depth of agent delegation |

**Validation Rules:**
- `max_iterations` must be positive
- `timeout_seconds` must be positive
- `max_delegation_depth` must be positive

## Example Configurations

The demo includes several example configurations for different use cases:

### 1. Standard Configuration (`demo_config.example.json`)
Complete configuration with all sections and default values. Use this as a template for your own configuration.

### 2. Minimal Configuration (`demo_config.minimal.json`)
Minimal configuration with only required fields. Good for quick setup and testing.

### 3. Development Configuration (`demo_config.development.json`)
Development-optimized configuration with:
- DEBUG logging level
- File logging enabled
- Verbose output
- Extended timeouts
- Disabled response caching for testing

### 4. Production Configuration (`demo_config.production.json`)
Production-optimized configuration with:
- INFO logging level
- JSON log format
- File logging to `/var/log`
- Optimized timeouts
- Mock system disabled
- Binding to all interfaces (0.0.0.0)

### 5. Testing Configuration (`demo_config.testing.json`)
Testing-optimized configuration with:
- WARNING logging level
- Minimal UI features
- Fast timeouts
- No delays in mock system
- Reduced message history

## Configuration Migration

The demo includes automatic configuration migration to upgrade from older schema versions.

### Migrating from v1.0 to v2.0

Version 2.0 adds the following sections:
- `scenario`: Scenario system configuration
- `ui`: Web UI configuration
- `logging`: Logging configuration
- `mock_system`: Mock system configuration
- `agent`: Agent behavior configuration

To migrate your configuration:

```bash
# Interactive migration
python examples/langchain_demo/config_migration.py

# Or specify a config file
python examples/langchain_demo/config_migration.py /path/to/config.json
```

The migration tool will:
1. Detect your current configuration version
2. Show what changes will be made
3. Create a backup of your current configuration
4. Apply the migration
5. Validate the migrated configuration

### Manual Migration

If you prefer to migrate manually:

1. Add `"_config_version": "2.0"` to your configuration
2. Add the new sections with default values (see example configurations)
3. Validate your configuration:

```python
from runtime_config import load_demo_runtime_config, validate_config

config = load_demo_runtime_config(require_api_key=False)
errors = validate_config(config)
if errors:
    print("Validation errors:", errors)
```

## Validation

### Validating Configuration

You can validate your configuration using the built-in validation functions:

```python
from runtime_config import validate_config_file

result = validate_config_file()
print(f"Valid: {result['valid']}")
print(f"Errors: {result['errors']}")
print(f"Warnings: {result['warnings']}")
```

### Common Validation Errors

1. **Missing required fields**
   - Error: "Missing required value 'mandates' in modes.mock"
   - Solution: Add all required mandate IDs for orchestrator, finance, and ops roles

2. **Invalid port number**
   - Error: "ui.port must be between 1 and 65535"
   - Solution: Use a valid port number (typically 8000-9000 for development)

3. **Invalid logging level**
   - Error: "logging.level must be one of ('DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL')"
   - Solution: Use a valid logging level

4. **Missing log file path**
   - Error: "logging.log_file_path is required when log_to_file is true"
   - Solution: Specify a log file path or set log_to_file to false

5. **Invalid path**
   - Error: "scenario.scenarios_path does not exist"
   - Solution: Create the directory or set scenarios_path to null

### Configuration Status

Check configuration status programmatically:

```python
from runtime_config import config_status

status = config_status()
if status['configured']:
    print("Configuration is valid")
    print(f"Workspace: {status['workspace_id']}")
    print(f"Modes: {list(status['modes'].keys())}")
else:
    print(f"Configuration error: {status['message']}")
```

## Best Practices

1. **Use environment variables for secrets**
   - Never hardcode API keys in configuration files
   - Use `api_key_env` to reference environment variables

2. **Version your configuration**
   - Always include `_config_version` field
   - Use configuration migration tools when upgrading

3. **Validate before deployment**
   - Run validation before deploying to production
   - Check for warnings as well as errors

4. **Use appropriate configurations for each environment**
   - Development: Use development configuration with verbose logging
   - Testing: Use testing configuration with fast timeouts
   - Production: Use production configuration with optimized settings

5. **Enable file logging in production**
   - Set `log_to_file: true` for debugging and auditing
   - Use JSON format for structured logging
   - Configure log rotation with appropriate size limits

6. **Document custom configurations**
   - Add `_description` field to document purpose
   - Include comments about non-standard settings
   - Keep example configurations up to date

## Troubleshooting

### Configuration not found

```
Error: Demo config file not found
```

**Solution:**
1. Copy `demo_config.example.json` to `demo_config.json`
2. Fill in the mandate IDs from your Caracal setup
3. Or set `LANGCHAIN_DEMO_CONFIG` environment variable

### Invalid JSON

```
Error: Invalid JSON in configuration file
```

**Solution:**
1. Validate JSON syntax using a JSON validator
2. Check for trailing commas (not allowed in JSON)
3. Ensure all strings are properly quoted

### Missing API key

```
Error: Environment variable 'CARACAL_API_KEY' is required
```

**Solution:**
1. Set the environment variable: `export CARACAL_API_KEY=your-key`
2. Or update `api_key_env` in configuration to reference a different variable

### Port already in use

```
Error: Address already in use
```

**Solution:**
1. Change `ui.port` to a different port number
2. Or stop the process using the current port

## See Also

- [Setup Guide](SETUP.md) - Complete setup instructions
- [Architecture Documentation](ARCHITECTURE.md) - System architecture
- [Troubleshooting Guide](TROUBLESHOOTING.md) - Common issues and solutions
