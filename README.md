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

[![License](https://img.shields.io/badge/License-Apache--2.0-blue?style=for-the-badge&logo=gnubash&logoColor=white)](LICENSE)
[![Version](https://img.shields.io/github/v/release/Garudex-Labs/caracal?style=for-the-badge&label=Release&color=orange)](https://github.com/Garudex-Labs/caracal/releases)
[![Python](https://img.shields.io/badge/Python-3.11%2B-blue?style=for-the-badge&logo=python&logoColor=white)](pyproject.toml)
[![Repo Size](https://img.shields.io/github/repo-size/Garudex-Labs/caracal?style=for-the-badge&color=green)](https://github.com/Garudex-Labs/caracal)
[![Activity](https://img.shields.io/github/commit-activity/m/Garudex-Labs/caracal?style=for-the-badge&color=blueviolet)](https://github.com/Garudex-Labs/caracal/graphs/commit-activity)
[![Website](https://img.shields.io/badge/Website-garudexlabs.com-333333?style=for-the-badge&logo=google-chrome&logoColor=white)](https://garudexlabs.com)
[![PyPI](https://img.shields.io/pypi/v/caracal-core?style=for-the-badge&logo=pypi&logoColor=white)](https://pypi.org/project/caracal-core/)

</div>

---

## Overview

**Caracal** is a pre-execution authority enforcement system for AI agents and automated software operating in production environments. It exists at the boundary where autonomous decisions turn into irreversible actions—API calls, database writes, or system triggers.

By enforcing the **principle of explicit authority**, Caracal ensures no action executes without a cryptographically verified, time-bound mandate issued under a governing policy.

---

## Community

<div align="center">
<table>
<tr>
<td align="center">
<a href="https://www.youtube.com/live/tZ4FdO-zjeE" target="_blank" rel="noopener">
<img src="https://img.youtube.com/vi/tZ4FdO-zjeE/hqdefault.jpg" alt="Open Source Friday — Preview" height="180"><br>
<strong>GitHub's Open Source Friday</strong>
</a>
</td>
<td align="center">
<div style="width:320px;height:180px;display:flex;align-items:center;justify-content:center;border-radius:6px;border:1px solid #ddd;background:#f8f8f8;font-weight:600">
More coming soon
</div>
</td>
</tr>
</table>
</div>

</div>

<div align="center">
</div>


---

## Core Interfaces

### 1. Caracal SDK (Python & Node.js)

**Target:** Developers and System Architects.

The second-generation (v2) SDK provides a unified, high-performance interface for integrating Caracal into any agentic loop.

**Installation (Python):**

```bash
pip install caracal-core
```

**Installation (Node.js):**

```bash
npm install @caracal/core
```

**Fluent API Example:**

```python
from caracal.sdk import CaracalClient

client = CaracalClient(api_key="your-key")
context = client.context.checkout(workspace_id="ws_123")

# Register an agent principal
agent = context.agents.create(name="web-scraper", owner="system")
```

### 2. Caracal Flow (TUI)

**Target:** Security Operations and Governance Officers.

Interactive terminal interface for monitoring authority ledgers, managing principals, and initial onboarding.

```bash
caracal-flow
```

---

## Technical Architecture

Caracal Core (the open-source foundation) implements the primary enforcement engine:

| Component      | Description                                                         |
| -------------- | ------------------------------------------------------------------- |
| **Principals** | Identities (agents/users) with ECDSA P-256 cryptographic keys.      |
| **Policies**   | Fine-grained rules defining resource patterns and allowed actions.  |
| **Mandates**   | Short-lived, signed tokens granting the right to execute an action. |
| **Ledger**     | High-performance audit trail of every authorization event.          |

> [!NOTE]
> Enterprise features (Gateway Proxy, SSO Provider, Compliance Extensions) are available on www.garudexlabs.com

---

## Project Structure

- `caracal/core/`: The core policy evaluation and mandate engine.
- `caracal/sdk/`: The unified Python SDK implementation.
- `caracal/flow/`: TUI application for management and monitoring.
- `caracal/db/`: Persistence layer with PostgreSQL and Redis support.
- `k8s/`: Kubernetes manifests for core component deployment.

---

## Citation (Optional but Appreciated)

**Caracal** is an open-source framework for *pre-execution authority enforcement for AI agents controlling delegated actions, with real-time revocation and immutable proof*.

If this project contributes to your research, product, or derivative systems, please consider citing it. Citations help us build credibility, advance trustworthy AI security research, and continue developing open infrastructure that benefits the broader ecosystem.

```bibtex
@software{madhuwala2026caracal,
  author    = {Madhuwala, Ryan and Garudex Labs},
  title     = {Caracal: Authority Enforcement Framework for AI Agents},
  year      = {2026},
  publisher = {GitHub},
  url       = {https://github.com/garudex-labs/caracal}
}
```

---

## License

Caracal is open-source software licensed under the **Apache-2.0**. See the [LICENSE](LICENSE) file for details.

**Developed by Garudex Labs.**
