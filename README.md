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

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/12350/badge)](https://www.bestpractices.dev/projects/12350) [![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Garudex-Labs/caracal/badge)](https://scorecard.dev/viewer/?uri=github.com/Garudex-Labs/caracal)
</div>

-----

# Overview

**Caracal** is a pre-execution authority enforcement system for AI agents and automated software operating in production environments. It exists at the boundary where autonomous decisions turn into irreversible actions—such as API calls, database writes, or system triggers.

By enforcing the **principle of explicit authority**, Caracal ensures no action executes without a cryptographically verified, time-bound mandate issued under a governing policy.

-----

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

-----

## Installation & Setup

### Quickstart

```bash
caracal      # Open the TUI (same as: caracal flow)
caracal up   # Setup
```

### Command Reference

```bash
caracal            # Open the TUI
caracal up         # Pull images, create network/volumes, start postgres+redis+mcp
caracal down       # Stop stack and remove services
caracal flow       # Launch Flow (TUI) inside runtime container
caracal cli        # Run full Caracal CLI inside container
caracal logs -f    # Tail runtime logs
caracal reset      # Down + remove volumes (full local reset)
caracal purge      # Completely remove Caracal containers, data, networks, images, and local state
```

### Migration and Cleanup

```bash
caracal migrate repo-to-package
caracal workspace delete <workspace-name> --force
caracal reset
caracal purge --force
```

-----

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, workflow, tests, and pull request standards.

-----

## Citation

**Caracal** is an open-source framework for *pre-execution authority enforcement for AI agents controlling delegated actions, with real-time revocation and immutable proof*.

If this project contributes to your research, product, or derivative systems, please consider citing it to help us advance trustworthy AI security research.

```bibtex
@software{madhuwala2026caracal,
  author    = {Madhuwala, Ryan and Garudex Labs},
  title     = {Caracal: Authority Enforcement Framework for AI Agents},
  year      = {2026},
  publisher = {GitHub},
  url       = {https://github.com/garudex-labs/caracal}
}
```

-----

## License

Caracal is open-source software licensed under the **Apache-2.0** License. See the [LICENSE](https://www.google.com/search?q=LICENSE) file for details.

**Developed by Garudex Labs.**
