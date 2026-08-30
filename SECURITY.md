<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->

<!-- SPDX-License-Identifier: Apache-2.0 -->

# Security Policy

## Security Overview

Caracal's security posture is documented in its [Security Assurance Case](docs/security/assurance-case.md), which describes the system's threat model, trust boundaries, security controls, supporting evidence, and identified residual risks.

Users running downloaded or distributed Caracal artifacts should also review the [Release Verification](docs/security/release-verification.md) documentation before execution. This guidance describes the verification procedures used to establish the authenticity and integrity of released artifacts.

## Supported Versions

Security fixes are currently provided for the following release line:

| Version          | Security Support |
| ---------------- | ---------------- |
| 1.11.x           | Supported        |
| Earlier versions | Not supported    |

Users running unsupported versions should upgrade to a supported release before reporting or investigating security issues.

## Reporting a Vulnerability

Security vulnerabilities must not be disclosed through public GitHub issues, discussions, or other publicly accessible channels.

Caracal supports responsible disclosure through the following channels:

### GitHub Private Vulnerability Reporting

GitHub Private Vulnerability Reporting is the preferred reporting mechanism.

Submit a report through the [Caracal Security Advisories](https://github.com/Garudex-Labs/caracal/security/advisories) page and select **Report a vulnerability**.

### Email

Security reports may also be submitted by email to:

**[support@caracal.run](mailto:support@caracal.run)**

When reporting a vulnerability, provide sufficient technical information to allow the issue to be reproduced and assessed. Reports should include a description of the vulnerability, its potential security impact, the affected version or versions, and, where available, reliable reproduction steps and a suggested remediation.

## Vulnerability Handling

Security reports are reviewed and handled through a coordinated disclosure process.

Caracal aims to acknowledge received reports within **48 hours**. An initial assessment and status update will generally be provided within **7 days**.

For confirmed vulnerabilities, the target remediation period is **30 days**, subject to the severity, complexity, affected components, and operational requirements of the issue.

Disclosure timelines may be coordinated with the reporter where additional time is required to develop, validate, or deploy an appropriate remediation. Reporters are asked to allow reasonable time for remediation before publicly disclosing the vulnerability.

## Security-Relevant Issues

Caracal processes security-sensitive information, including API keys, authentication tokens, and enterprise telemetry data. Vulnerabilities that may compromise the confidentiality, integrity, or availability of these assets are considered security-relevant.

Examples include authentication or authorization bypasses, exposure or improper handling of API keys or authentication tokens, SQL injection, command injection, path traversal, cross-site scripting (XSS), cross-site request forgery (CSRF), server-side request forgery (SSRF), insecure defaults that may result in unauthorized access or sensitive-data exposure, and dependency vulnerabilities where a credible exploitation path exists.

This list is not exhaustive. Vulnerabilities that do not clearly fall into one of these categories may still present a meaningful security risk. When in doubt, report the issue through a private disclosure channel so it can be properly assessed.

## Responsible Disclosure and Recognition

Caracal appreciates responsible security research and coordinated vulnerability disclosure.

Contributors who report valid security vulnerabilities may be acknowledged in the applicable release notes or security documentation. Researchers may request to remain anonymous, in which case no public attribution will be made.
