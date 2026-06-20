<div align="center">
<picture>
<source media="(prefers-color-scheme: dark)" srcset="public/caracal_nobg_dark_mode.png">
<source media="(prefers-color-scheme: light)" srcset="public/caracal_nobg.png">
<img alt="Caracal Logo" src="public/caracal_nobg.png" width="300">
</picture>
</div>

<div align="center">

**Security-first authority and delegation layer for AI agents**
</div>

<div align="center">

[![License](https://img.shields.io/badge/License-Apache--2.0-blue?style=for-the-badge&logo=gnubash&logoColor=white)](LICENSE)
[![Version](https://img.shields.io/github/v/release/Garudex-Labs/caracal?style=for-the-badge&label=Release&color=orange)](https://github.com/Garudex-Labs/caracal/releases)
[![Repo Size](https://img.shields.io/github/repo-size/Garudex-Labs/caracal?style=for-the-badge&color=green)](https://github.com/Garudex-Labs/caracal)
[![Website](https://img.shields.io/badge/Website-caracal.run-333333?style=for-the-badge&logo=google-chrome&logoColor=white)](https://caracal.run)

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/12350/badge)](https://www.bestpractices.dev/projects/12350) 
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Garudex-Labs/caracal/badge)](https://scorecard.dev/viewer/?uri=github.com/Garudex-Labs/caracal) 
[![codecov](https://codecov.io/github/garudex-labs/caracal/graph/badge.svg?token=2Z0FY88RF5)](https://codecov.io/github/garudex-labs/caracal)
</div>

-----

# Overview

**Caracal** is a security-first **authority and delegation layer** for **autonomous agents**. It solves the platform problem of letting agents act in real environments without exposing long-lived secrets or uncontrolled access. Instead of giving agents broad standing permissions, Caracal lets teams issue scoped authority, delegate it safely, revoke it when needed, and keep a clear audit trail of every sensitive action.

Read the full documentation at [docs.caracal.run](https://docs.caracal.run).

-----

## Installation & Setup

<details>
<summary><strong>End Users</strong></summary>

### Prerequisites

- Docker Desktop 4.x or Docker Engine 24+ with Compose v2
- Git 2.x
- GitHub CLI `gh` for installer provenance verification

### Install

The installer provides the thin `caracal` runtime CLI and the `caracal-console` management interface.

> Version examples below pin `v2026.06.10-rc.1`. Check [GitHub Releases](https://github.com/Garudex-Labs/caracal/releases) for the latest available tag. Unpinned installs follow GitHub's latest stable release.
> Pin a version: `--version vYYYY.MM.DD` on Unix or `-Version vYYYY.MM.DD` in PowerShell.  
> Change install directory: `--install-dir /path` on Unix or `-InstallDir C:\path` in PowerShell. Unix installers also honor `PREFIX`/`CARACAL_PREFIX` and `DESTDIR` for staged installs.
> Uninstall: rerun the installer with `--uninstall` on Unix or `-Uninstall` in PowerShell.
> Provenance verification is required by default.

<details>
<summary><strong>Linux</strong> (amd64 / arm64)</summary>

```bash
# Console
curl -fsSL https://raw.githubusercontent.com/Garudex-Labs/caracal/main/install-console.sh | \
  sh -s -- --version v2026.06.10-rc.1
```

Installs to `~/.local/bin` and verifies release provenance by default. Override with `--install-dir /usr/local/bin` (may need `sudo`) or use packaging-style roots such as `PREFIX=/usr DESTDIR=/tmp/pkg`.

</details>

<details>
<summary><strong>macOS</strong> (Intel / Apple Silicon)</summary>

```bash
# Console
curl -fsSL https://raw.githubusercontent.com/Garudex-Labs/caracal/main/install-console.sh | \
  sh -s -- --version v2026.06.10-rc.1
```

If Gatekeeper blocks the binary: `xattr -d com.apple.quarantine ~/.local/bin/caracal`.

</details>

<details>
<summary><strong>Windows</strong> (amd64) PowerShell</summary>

```powershell
# Console
$installer = "$env:TEMP\install-console.ps1"
iwr -useb https://raw.githubusercontent.com/Garudex-Labs/caracal/main/install-console.ps1 -OutFile $installer
powershell -ExecutionPolicy Bypass -File $installer -Version v2026.06.10-rc.1
```

Installs to `%LOCALAPPDATA%\Programs\caracal` and verifies release provenance by default. Remove installed binaries and the user `Path` entry with `-Uninstall`. Requires Docker Desktop with WSL2.

</details>

### Start the stack

```bash
caracal up                            # start all services, override with `CARACAL_VERSION=vYYYY.MM.DD caracal up`
caracal status [--ready]              # probe all services
caracal down                          # stop; add -v to remove volumes
caracal purge                         # interactive cleanup (containers, volumes, config, runtime, examples, caches)
caracal console                       # launch Console
caracal run -- node worker.js         # workload execution
```

</details>

<pr></pr>

<details>
<summary><strong>Contributors</strong></summary>

### Prerequisites

- Node.js 24+
- pnpm 11.1.1
- Docker Engine 24+ with Compose v2 (or Docker Desktop 4.x)
- Git 2.x
- Go 1.26+ (only when changing Go services or shared Go packages)
- Python 3.14+ (only when changing Python packages)
- Bun (only when building distributable runtime/console binaries)

Run `pnpm install` after cloning for the standard Node workspace setup. Run `pnpm run setup` when you need the full cross-platform developer environment with Go modules, Python test/style tooling, and editable Python packages.

See [CONTRIBUTING.md](./.github/CONTRIBUTING.md) for clone, setup, testing, and pull request workflow.

</details>

-----

## Maintainers

<table width="100%">
  <tr align="center">
    <td valign="top" width="33%">
      <a href="https://github.com/RAWx18" target="_blank">
        <img src="https://avatars.githubusercontent.com/RAWx18?s=150" width="120" alt="RAWx18"/><br/>
        <strong>RAWx18</strong>
      </a>
      <p>
        <a href="https://github.com/RAWx18" target="_blank">
          <img src="https://img.shields.io/badge/GitHub-100000?style=flat&logo=github&logoColor=white" alt="GitHub"/>
        </a>
        <a href="https://linkedin.com/in/ryanmadhuwala" target="_blank">
          <img src="https://img.shields.io/badge/LinkedIn-0077B5?style=flat&logo=linkedin&logoColor=white" alt="LinkedIn"/>
        </a>
      </p>
    </td>
    <td valign="top" width="33%">
      <a href="https://github.com/Slo-Pix" target="_blank">
        <img src="https://avatars.githubusercontent.com/Slo-Pix?s=150" width="120" alt="Slo-Pix"/><br/>
        <strong>Slo-Pix</strong>
      </a>
      <p>
        <a href="https://github.com/Slo-Pix" target="_blank">
          <img src="https://img.shields.io/badge/GitHub-100000?style=flat&logo=github&logoColor=white" alt="GitHub"/>
        </a>
        <a href="https://www.linkedin.com/in/shubh465" target="_blank">
          <img src="https://img.shields.io/badge/LinkedIn-0077B5?style=flat&logo=linkedin&logoColor=white" alt="LinkedIn"/>
        </a>
      </p>
    </td>
  </tr>
</table>

-----

## Contributing

See [CONTRIBUTING.md](./.github/CONTRIBUTING.md) for setup, workflow, tests, and pull request standards.

-----

## Security & Trust

See the [Enterprise Security Readiness](https://docs.caracal.run/security/enterprise-readiness/) guide for the security posture, supply-chain controls, release signing, SBOMs, and the enterprise-adoption review checklist. Report vulnerabilities privately through [SECURITY.md](./.github/SECURITY.md).

-----

## Community & Partnerships

<div align="center">

| Program | Timeline |
|:---:|:---:|
| <a href="https://www.youtube.com/live/tZ4FdO-zjeE"><img src="https://img.shields.io/badge/GitHub-Open%20Source%20Friday-E74C3C?style=for-the-badge&logo=github&logoColor=white" width="240"/></a> | Feb 2026 |
| <a href="https://vercel.com/open-source-program"><img src="https://img.shields.io/badge/Vercel-OSS%20Program-2ECC71?style=for-the-badge&logo=vercel&logoColor=white" width="240"/></a> | Spring 2026 |
| <a href="#"><img src="https://img.shields.io/badge/Founders%20Inc.-%20Canopy%20Online-F39C12?style=for-the-badge" width="240"/></a> | Apr – Jun 2026 |
| <a href="https://www.microsoft.com/startups"><img src="https://img.shields.io/badge/Microsoft%20for%20Startups-Member-0078D4?style=for-the-badge&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyMyAyMyI%2BPHJlY3QgeD0iMSIgeT0iMSIgd2lkdGg9IjEwIiBoZWlnaHQ9IjEwIiBmaWxsPSIjRjI1MDIyIi8%2BPHJlY3QgeD0iMTIiIHk9IjEiIHdpZHRoPSIxMCIgaGVpZ2h0PSIxMCIgZmlsbD0iIzdGQkEwMCIvPjxyZWN0IHg9IjEiIHk9IjEyIiB3aWR0aD0iMTAiIGhlaWdodD0iMTAiIGZpbGw9IiMwMEE0RUYiLz48cmVjdCB4PSIxMiIgeT0iMTIiIHdpZHRoPSIxMCIgaGVpZ2h0PSIxMCIgZmlsbD0iI0ZGQjkwMCIvPjwvc3ZnPg%3D%3D" width="240"/></a> | May 2026 – Present |
| <a href="https://mentorship.lfx.linuxfoundation.org/project/9cfe285b-7006-4610-84a8-1a52b0dff662"><img src="https://img.shields.io/badge/LFX-Mentorship%202026-8E44AD?style=for-the-badge&logo=linuxfoundation&logoColor=white" width="240"/></a> | Jun 2026 – present |

</div>

-----

## License

Caracal is open-source software licensed under the **Apache-2.0** License. See the [LICENSE](LICENSE) file for details.

**Developed by Garudex Labs.**
