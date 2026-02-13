---
sidebar_position: 8
title: Resource Registry Commands
---

# Resource Registry Commands

The `pricebook` command group manages the resource registry. This defines the resources that can be referenced in authority policies and mandates.

```
caracal pricebook COMMAND [OPTIONS]
```

---

## Commands Overview

| Command | Description |
|---------|-------------|
| [`list`](#list) | List all registered resources |
| [`get`](#get) | Get details for a specific resource |
| [`set`](#set) | Register or update a resource |
| [`import`](#import) | Import resources from CSV file |

---

## Resource Structure

| Field | Description |
|-------|-------------|
| resource_type | Unique identifier (e.g., `api:external/openai`) |
| description | Human-readable description |
| category | Resource category (api, db, service) |

### Resource Type Naming Convention

```
category:provider/resource
```

| Example | Category | Provider | Resource |
|---------|----------|----------|----------|
| `api:external/openai` | api | external | openai |
| `api:external/anthropic` | api | external | anthropic |
| `db:analytics/reports` | db | analytics | reports |
| `service:internal/auth` | service | internal | auth |

---

## list

List all registered resources.

```
caracal pricebook list [OPTIONS]
```

### Options

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--category` | `-c` | - | Filter by category |
| `--format` | `-f` | table | Output format |

<details>
<summary>List all resources</summary>

```bash
caracal pricebook list
```

**Output:**
```
Registered Resources
====================

Resource Type                         Category    Description
--------------------------------------------------------------------
api:external/openai                   api         OpenAI API access
api:external/anthropic                api         Anthropic API access
db:analytics/reports                  db          Analytics database
service:internal/auth                 service     Auth service

Total: 4 resources
```

</details>

---

## get

Get details for a specific resource.

```
caracal pricebook get [OPTIONS]
```

| Option | Short | Required | Description |
|--------|-------|:--------:|-------------|
| `--resource-type` | `-r` | Yes | Resource type identifier |

---

## set

Register or update a resource.

```
caracal pricebook set [OPTIONS]
```

| Option | Short | Required | Description |
|--------|-------|:--------:|-------------|
| `--resource-type` | `-r` | Yes | Resource type identifier |
| `--description` | `-d` | No | Human-readable description |
| `--category` | `-c` | No | Resource category |

---

## import

Import resources from CSV file.

```
caracal pricebook import [OPTIONS] FILE
```

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--overwrite` | | false | Overwrite existing entries |
| `--dry-run` | | false | Preview without importing |

### CSV Format

```csv
resource_type,description,category
api:external/openai,OpenAI API access,api
api:external/anthropic,Anthropic API access,api
db:analytics/reports,Analytics database,db
```

---

## See Also

- [Policy Commands](./policy) -- Reference resources in authority policies
- [Ledger Commands](./ledger) -- View events by resource
