<div align="center">
<picture>
<source media="(prefers-color-scheme: dark)" srcset="public/caracal_nobg_dark_mode.png">
<source media="(prefers-color-scheme: light)" srcset="public/caracal_nobg.png">
<img alt="Caracal Logo" src="public/caracal_nobg.png" width="300">
</picture>
</div>

<div align="center">

**Pre-execution authority enforcement for AI agents**

</div>

<div align="center">

[![License](https://img.shields.io/badge/License-AGPL_3.0-blue?style=for-the-badge&logo=gnu-bash&logoColor=white)](LICENSE)
[![Version](https://img.shields.io/github/v/release/Garudex-Labs/caracal?style=for-the-badge&label=Release&color=orange)](https://github.com/Garudex-Labs/caracal/releases)
[![Python](https://img.shields.io/badge/Python-3.11%2B-blue?style=for-the-badge&logo=python&logoColor=white)](pyproject.toml)
[![Repo Size](https://img.shields.io/github/repo-size/Garudex-Labs/caracal?style=for-the-badge&color=green)](https://github.com/Garudex-Labs/caracal)
[![Activity](https://img.shields.io/github/commit-activity/m/Garudex-Labs/caracal?style=for-the-badge&color=blueviolet)](https://github.com/Garudex-Labs/caracal/graphs/commit-activity)
[![Website](https://img.shields.io/badge/Website-garudexlabs.com-333333?style=for-the-badge&logo=google-chrome&logoColor=white)](https://garudexlabs.com)
[![PyPI](https://img.shields.io/pypi/v/caracal-core?style=for-the-badge&logo=pypi&logoColor=white)](https://pypi.org/project/caracal-core/)

</div>

---

## Overview

**Caracal** is a pre-execution authority enforcement system for AI agents and automated software operating in production environments. It exists at the exact boundary where decisions turn into irreversible actions—API calls, database writes, deployments, or workflow triggers. 

Instead of relying on broad roles or static API keys, Caracal enforces the **principle of explicit authority**: no action executes unless there is a cryptographically verified, time-bound mandate issued under a governing policy.

---

## Quickstart

Caracal offers two distinct interfaces for managing authority.

### 1. Caracal Flow (TUI)

**Target:** Security Teams, Governance Officers, and Developers.

Caracal Flow is an interactive terminal interface for onboarding, monitoring authority ledgers, and managing infrastructure. It includes an **Onboarding Wizard** to help you configure your first principal, policy, and mandate in minutes.

```text
╔═══════════════════════════════════════════════════════════════════╗
║                                                                   ║
║     ██████╗ █████╗ ██████╗  █████╗  ██████╗ █████╗ ██╗            ║
║    ██╔════╝██╔══██╗██╔══██╗██╔══██╗██╔════╝██╔══██╗██║            ║
║    ██║     ███████║██████╔╝███████║██║     ███████║██║            ║
║    ██║     ██╔══██║██╔══██╗██╔══██║██║     ██╔══██║██║            ║
║    ╚██████╗██║  ██║██║  ██║██║  ██║╚██████╗██║  ██║███████╗       ║
║     ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝╚══════╝       ║
║                                                                   ║
║                   C A R A C A L  F L O W                          ║
║         Pre-Execution Authority Enforcement System                ║
║                                                                   ║
╚═══════════════════════════════════════════════════════════════════╝
```

**Launch Caracal Flow:**

```bash
caracal-flow
```

**Capabilities in Flow:**

* **Onboarding Wizard:** Guided setup for principals and policies.
* **Authority Ledger:** Real-time stream of authorization decisions.
* **Principal Hub:** Manage identities and cryptographic key pairs.
* **Infrastructure Setup:** Provision PostgreSQL with one click.

---

### 2. Caracal Core (CLI & SDK)

**Target:** Developers and System Architects.

Caracal Core provides the high-performance CLI and SDK for deep integration into agentic loops and CI/CD pipelines.

**Installation:**

```bash
pip install caracal-core
```

**Example CLI Commands:**

```bash
# Register a principal (agent identity)
caracal principals register --name "web-scraper-01" --type agent

# Create an authority policy allowing search on specific resources
caracal policies create --principal-id <ID> --resources "google.com/*" --actions "GET,POST"

# Issue a time-bound execution mandate
caracal mandates issue --principal-id <ID> --ttl 1800

# Query the authority ledger
caracal authority-ledger query --principal-id <ID>
```

---

## Core Concepts

**Principals**
Identities (agents, users, or services) that can hold and exercise authority. Principals use ECDSA P-256 keys for cryptographic attestation.

**Authority Policies**
Governing rules that define the maximum validity, allowed resource patterns, and permitted actions for a given principal.

**Execution Mandates**
Short-lived, cryptographically signed tokens that grant specific rights. Mandates are checked by the Caracal Gateway before any action is executed.

**Authority Ledger**
A high-performance, immutable audit trail of every authorization request, decision, and enforcement event.

---

## Infrastructure

Caracal scales from local development to enterprise-grade throughput.

| Environment | Database | Messaging | Event Bus | Use Case |
| --- | --- | --- | --- | --- |
| **Standard** | SQLite | File-based | In-Memory | Local development, testing, and TUI default. |
| **Enterprise** | PostgreSQL | — | Redis/Redpanda | High-availability production enforcement. |

---

## Project Structure

* `caracal/core/`: Core engine for policy evaluation and mandate issuance.
* `caracal/flow/`: TUI layer for interactive management.
* `caracal/db/`: Persistence layer supporting multiple backends.
* `k8s/`: Kubernetes manifests for production deployment.
* `deploy/`: Infrastructure automation scripts.

---

## License

Caracal is open-source software licensed under the **AGPL-3.0**. See the [LICENSE](LICENSE) file for details.

**Developed by Garudex Labs.**