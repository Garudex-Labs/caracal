# Incident Response Plan (IRP)

*Last updated: 2026-March*

## Purpose

This Incident Response Plan defines how **caracal** responds to security incidents with **clear ownership**, **immediate containment**, and **controlled remediation**. The process is designed to be executed without ambiguity. Each phase specifies **what must be done**, **who is responsible**, and **what artifact must be recorded**.

---

## Operating Model

Each incident has a single **Incident Lead (IL)** who owns decisions, sequencing, and final approval. All work is centralized in a **private GitHub Security Advisory**, which serves as the authoritative record. **No parallel sources of truth are allowed.**

Two coordinated teams operate under the IL.

* **Red Team** focuses on immediate risk reduction through minimal, targeted changes.
* **Blue Team** focuses on root cause correction, validation, and long-term safety.

All responsibilities are handled within the **Red Team** and **Blue Team** structure. The Incident Lead participates across both teams and is responsible for continuity between phases.

---

## Incident Classification

Classification is based on the **first required action**.

* **Type A: Immediate Containment Required**
  Active exploitation, privilege escalation, token leakage, policy bypass, or unsafe execution. Action must begin with restriction or shutdown of affected paths.

* **Type B: Guardrail Required**
  Authorization flaws, partial bypasses, or unsafe integrations with realistic exploit potential. Action must begin with adding restrictive checks or gating.

* **Type C: Logic Weakness**
  Reproducible issues with limited scope or edge-case impact. Action begins with reliable reproduction and a failing test.

* **Type D: Hardening**
  No direct exploit path. Action is backlog with tests and documentation.

Classification can be revised as evidence improves.

---

## End-to-End Sequence (Runbook)

The following sequence defines the required flow for handling a security incident. Each step must be executed in order and documented within the private advisory to maintain **clarity**, **traceability**, and **control**.

### Step 1: Intake and Initial Decision

A maintainer is assigned as **Incident Lead (IL)** based on availability. The IL performs an initial evaluation to determine whether the report represents a valid security issue requiring formal handling. If the issue is not security-relevant or lacks sufficient impact, the reporter is directed to raise it through the [public issue tracker](https://github.com/Garudex-Labs/caracal/issues). If the report is valid, the IL acknowledges it privately, may request clarification, and ensures the **reporter maintains confidentiality**. An initial incident brief is prepared capturing the summary, suspected impact, affected areas, and preliminary classification. Ownership may be reassigned at this stage if deeper expertise is required.

### Step 2: Team Formation and Ownership

The IL establishes a working group by selecting available maintainers and contributors and dividing them into a **Red Team** and a **Blue Team** based on capability and current load. The IL records the final ownership structure clearly, including all participating members. This structure serves as the execution boundary for the incident, and all actions must be coordinated within it.

### Step 3: Containment

The Red Team immediately initiates containment to reduce risk before detailed analysis. Actions are chosen to be **minimal**, **effective**, and **reversible**, such as disabling affected functionality, restricting access paths, tightening policies, or rotating credentials. The focus is on limiting exposure quickly rather than achieving a complete fix. All actions are documented with scope and rollback considerations.

### Step 4: Red Team Mitigation

The Red Team implements a minimal patch that blocks or significantly reduces the exploit path. Changes are kept localized and small to minimize unintended impact. These changes are committed in a manner consistent with normal development activity, while maintaining a detailed internal record of all modifications and reasoning.

### Step 5: Red to Blue Handoff

After mitigation, the Red Team prepares a structured internal report describing the changes made, the reasoning behind them, and any assumptions or risks. This report is shared with the Blue Team, along with continuous updates if new observations arise. This handoff ensures continuity and provides a clear baseline for deeper analysis.

### Step 6: Blue Team Analysis and Planning

The Blue Team reviews the mitigation, validates its effectiveness, and examines whether it introduces side effects or incomplete coverage. The team identifies the root cause of the issue and designs a comprehensive fix that resolves the problem correctly. This phase focuses on **correctness**, **completeness**, and **long-term stability** rather than speed.

### Step 7: Blue Team Implementation

The Blue Team implements the final patch based on its analysis. The implementation includes proper validation, safeguards, and test coverage to ensure reliability. The patch is prepared and documented internally but is not released until it passes full review.

### Step 8: Final Review and Release Planning

The Red Team, Blue Team, and Incident Lead jointly review the final implementation and associated reports. The review confirms that the vulnerability is resolved, no new issues are introduced, and the system remains stable. A controlled release plan is prepared along with a carefully scoped public disclosure strategy to ensure no unintended information is exposed.

### Step 9: Disclosure and Improvement

The fix is released through the standard process, and a public advisory is issued with appropriate details. Care is taken to disclose only what is necessary. Following release, the team documents lessons learned and updates internal practices, safeguards, or tooling to improve future incident response.

---

## Reporter Participation

If the reporter wants to contribute, they may request involvement. The Incident Lead may allow participation if it improves resolution speed or quality.

The reporter may provide patches, proof-of-concept code, or validation help. All contributions remain controlled and must go through internal review by the Red Team or Blue Team. Direct merge access is not granted.

The reporter is treated as an external contributor and does not hold any internal role. All decisions remain with the Incident Lead and internal teams.

---

## Fix Strategy

Use a two-layer approach.

* **Immediate Guard**: smallest change that blocks or reduces risk.
* **Structural Fix**: root cause correction with tests and safeguards.

Ship the guard first, then follow with the structural fix in the sequence.

---

## Verification and Recovery

Before closure, verify that the exploit path is blocked and no new issues are introduced. Keep temporary restrictions until confidence is established, then remove them deliberately.

**Artifact:** **Final Verification Report**.

---

## Communication

All communication remains private until mitigation exists. Provide updates only at checkpoints: containment applied, mitigation verified, fix ready, release completed.

**Artifact:** **Checkpoint Updates** in advisory.

---

## Response Timeline

Initial review target is up to 7 days. **Type A** incidents require immediate containment. Resolution timing depends on complexity.

---

## Red Team Execution Prompt

The following prompt is mandatory for Red Team. Fill all placeholders before use and paste into the advisory or tool.

```text
ROLE
You are a security-focused engineer performing rapid mitigation in the caracal codebase.

CONTEXT
[Clear description of the vulnerability. Where it exists, why it is dangerous, and the likely entry point.]

REPRODUCTION
[Exact steps or proof-of-concept. Include inputs, requests, environment, and expected vs actual behavior.]

AFFECTED AREA
[Files, modules, functions, endpoints, providers, policies.]

OBJECTIVE
- Block or significantly reduce the exploit path immediately
- Apply the smallest safe change possible
- Keep changes localized and reversible

STRICT DOs
- Add explicit validation, authorization checks, or deny rules at the narrowest choke point
- Prefer fail-closed behavior
- Restrict capabilities via flags, scopes, or guards
- Keep the diff minimal and focused on affected code only
- Preserve existing behavior for unaffected paths
- Add a minimal assertion or test when feasible
- Document assumptions in concise form

STRICT DON'Ts
- Do not refactor unrelated code
- Do not introduce new features or expand scope
- Do not remove existing security checks unless replaced with stricter ones
- Do not modify multiple subsystems in a single patch
- Do not add new dependencies unless strictly necessary
- Do not implement complex logic when a simple guard is sufficient
- Do not expose sensitive data or debugging output

PATCH STRATEGY
1. Identify the exact exploit entry point and propagation path
2. Insert the narrowest guard to block it (validation, authorization, restriction)
3. Ensure safe fallback behavior (error or no-op)
4. Verify unaffected flows remain unchanged

OUTPUT FORMAT
1. One-line summary of the fix
2. Exact code changes (minimal diff)
3. Why this blocks the exploit (2 to 3 lines)
4. Limitations or follow-up required

QUALITY BAR
- Exploit path is demonstrably blocked
- No new privilege or bypass introduced
- Patch is minimal, readable, and reversible

THINKING MODE
Act under time pressure. Prioritize containment over completeness. Make the smallest change that removes the risk.
```

---

## Review Checklist (Required)

* Exploit reproduction fails after patch
* No permission widening or new access paths
* Affected paths covered by at least one test or assertion
* Diff is minimal and localized
* No sensitive data exposure introduced

---

## Post-Incident Summary Template

* Summary: one paragraph of what happened
* Root Cause: specific condition or logic gap
* Containment: actions taken and when
* Fix: mitigation and final correction
* Impact: scope and affected components
* Improvement: one concrete change to prevent recurrence

---

## Final Note

This IRP is intended to be followed step by step. Each phase produces explicit artifacts, and all work is recorded in a single advisory. The emphasis is on **fast containment**, **minimal change**, and **verifiable outcomes.**
