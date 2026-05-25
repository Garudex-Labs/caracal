# Governance

Caracal is maintained by Garudex Labs. Active maintainers are listed in `.github/MAINTAINERS`; those owners review changes for their areas, triage issues, enforce repository standards, and approve releases.

Small changes should go directly through pull requests. Medium changes such as new packages, endpoints, or significant component refactors should start with a GitHub issue. Architectural or security-sensitive changes require an RFC issue with a problem statement, proposal, alternatives, trade-offs, and open questions.

Only maintainers listed in `.github/MAINTAINERS` cut releases. Stable release publication requires the protected `release-approval` GitHub Environment, and the approving maintainer must be different from the actor who pushed the release tag. PyPI and npm stable publication require their protected publish environments. Release tags matching `v*` must be protected from deletion and force-push.

Security vulnerabilities must be reported privately to `support@caracal.run`, not as public GitHub issues.
