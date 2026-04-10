# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in **caracal**, please report it responsibly. Security is a critical part of the system, and responsible disclosure helps ensure that issues are resolved safely without exposing users or infrastructure to unnecessary risk. We expect reports to be clear, structured, and actionable so that they can be reviewed efficiently by a small team.

---

## Reporting Channels

caracal supports two primary reporting methods. For open-source related issues, you should use GitHub private advisories at:
[https://github.com/Garudex-Labs/caracal/security/advisories/new](https://github.com/Garudex-Labs/caracal/security/advisories/new)

For more sensitive disclosures, detailed reports, or anything requiring attachments such as patches or exploit demonstrations, you should use email:
[support@garudexlabs.com](mailto:support@garudexlabs.com)

If the issue relates to anything under the `/enterprise` directory, it must be reported strictly via email. GitHub advisories must not be used for enterprise-related vulnerabilities. These reports are handled directly by the founding team at Garudex Labs.

---

## Required Reporting Format (Email Only)

To ensure consistency and faster review, all email reports must follow a standard format. This allows us to quickly understand the issue, reproduce it, and evaluate its impact without unnecessary back-and-forth.

```
Subject: [SECURITY][caracal] Short description of the issue

Body:

1. Summary
Provide a clear and direct explanation of the vulnerability.

2. Steps to Reproduce
Include exact steps or a proof-of-concept so the issue can be reliably reproduced.

3. Impact
Explain what can be achieved if this vulnerability is exploited.

4. Affected Area
Mention relevant files, modules, or components if known.

5. Suggested Fix (Optional)
Include any mitigation or fix if you have one.

6. Attachments (Optional)
- Code snippets
- Patch files
- ZIP archive (if submitting a fix implementation)
```

Reports must be written clearly and precisely. Ambiguous, incomplete, or poorly structured reports will slow down the review process and may not be prioritized.

---

## Submitting Fixes

If you have identified a fix, you are encouraged to include it in your report. Fixes can be shared as inline code, patch files, or compressed archives such as ZIP. We may review and validate the proposed solution internally. If the fix is accepted, we may request you to submit it through a controlled pull request process so that proper validation and attribution can be ensured. Direct public pull requests for security issues are not recommended unless explicitly requested.

---

## Response Timeline

As a small and evolving team, we aim to review and respond to security reports within up to 7 days. Resolution timelines may vary depending on the complexity of the issue, availability of maintainers, and required validation. We are actively improving internal security workflows to reduce response times over time.

---

## Disclosure Guidelines

All vulnerabilities must remain private until a fix or mitigation has been released. Public disclosure before resolution can put users at risk and will be considered irresponsible. Once a fix is published, or if a decision is made not to address the issue, you are free to disclose it responsibly.

---

## Expectations

caracal is an early-stage project and security processes are still being developed. We request that reports are submitted with clarity, sufficient detail, and a reproducible approach. Please allow reasonable time for investigation and avoid placing pressure on maintainers for immediate fixes.

Repeated, low-quality, or spam reports reduce our ability to respond effectively. Any submissions that are clearly spam, non-actionable, or intentionally disruptive may be ignored and can result in blocking of the sender. Respect for maintainer time and process is expected.

---

## Preferred Languages

We prefer all communications to be in English.

---

## Acknowledgment

We value responsible disclosures and meaningful contributions. Where appropriate, contributors may be acknowledged for valid findings, though recognition is not guaranteed and is subject to internal review.