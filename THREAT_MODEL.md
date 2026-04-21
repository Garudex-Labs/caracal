# Threat Model

*Last updated: 2026-March*

## Purpose

This document defines the threat model for **caracal**. It identifies the primary assets, trust boundaries, attacker capabilities, threat categories, and security controls that shape the system’s defense posture. The goal is to make risk explicit, align engineering decisions with security requirements, and keep incident response grounded in the actual design of the product.

This threat model is intended to be used alongside the project’s security reporting process and incident response plan. It should be reviewed whenever the codebase, execution model, or provider integrations change in a meaningful way.

---

## System Context

caracal is a security-sensitive system for controlling delegated AI-driven actions. It sits between user intent, agent execution, and provider/tool access. The system is designed to ensure that actions are authorized before execution, that behavior is traceable, and that unsafe or unintended actions can be contained quickly.

The most important security property is that an agent or integration must never gain more capability than it has been explicitly granted. Every action should be evaluated against policy, scope, and execution context before it is allowed to proceed.

---

## Security Objectives

The main security objectives for caracal are confidentiality, integrity, authorization correctness, traceability, and controlled recovery.

Confidentiality means secrets, credentials, internal policies, and incident details must not be exposed to unauthorized parties. Integrity means actions, logs, and enforcement decisions must not be tampered with. Authorization correctness means every agent action must be validated against the proper policy before it runs. Traceability means important decisions and executions must be auditable. Controlled recovery means vulnerable behavior can be restricted or disabled quickly when risk is identified.

---

## Assets

The most sensitive assets in caracal are execution authority, policy data, credentials, audit records, and provider connectivity. Execution authority refers to the ability to perform actions through the system. Policy data includes rules, constraints, allowlists, denylists, and any metadata used to decide whether an action is permitted. Credentials include API keys, tokens, service accounts, and any secret material required to reach external systems. Audit records include logs, traces, event records, and incident notes. Provider connectivity includes the interfaces through which the system reaches tools, services, repositories, or remote APIs.

A compromise of any one of these assets can affect the safety of the whole system.

---

## Trust Boundaries

caracal has several trust boundaries that must be treated carefully.

The first boundary is between a user or operator and the system itself. User intent may be legitimate, but it still must be normalized and constrained before becoming executable action.

The second boundary is between the policy layer and the execution layer. Policy decisions must be enforced, not merely recorded. Any mismatch between decision and execution is a serious security risk.

The third boundary is between internal logic and external providers. Providers, APIs, and tool integrations must be assumed untrusted until their outputs are validated.

The fourth boundary is between normal operation and incident response. During a security event, the system must be able to shift into a restricted mode without losing traceability or control.

---

## Trust Assumptions

caracal assumes that internal code may contain bugs, that external services may behave unpredictably, and that reporters may provide incomplete or adversarial inputs. The system does not assume that agent behavior is safe by default. It does not assume that a successful API call was necessarily authorized in the intended scope. It does not assume that logs are correct unless their integrity has been preserved.

The system also assumes that any feature that can execute code, invoke tools, or forward requests can become an attack surface if it is not tightly controlled.

---

## Threat Actors

The primary threat actors are malicious external users, compromised agents, unauthorized contributors, and trusted users making dangerous mistakes. External users may attempt to abuse exposed interfaces, over-permissioned agents, or weak enforcement paths. Compromised agents may attempt to expand their own capability or trigger unsafe actions. Unauthorized contributors may try to introduce malicious changes through code, configuration, or dependencies. Trusted users may unintentionally create risk through misconfiguration, excessive permissions, or unsafe operational choices.

A secondary threat actor is the environment itself, including misbehaving services, inconsistent provider responses, and dependency-chain failures.

---

## Threat Categories

### Unauthorized Action Execution

An attacker may try to make the system perform an action that was never intended or approved. This includes bypassing authorization, abusing permissions, exploiting race conditions, or triggering actions through an unvalidated path. This is one of the highest-risk threat categories because it directly affects the core safety property of the system.

### Policy Bypass

An attacker may attempt to evade policy checks by routing actions through alternate code paths, malformed inputs, edge cases, or provider forwarding behavior. Any place where policy is evaluated in one layer but not enforced in another is a potential bypass point.

### Privilege Escalation

An attacker may seek to increase the authority of a principal, agent, or request beyond its intended scope. This can happen through confused-deputy behavior, scope confusion, insecure defaults, or incorrect inheritance of privileges.

### Secret Exposure

Secrets may be exposed through logs, error messages, misrouted requests, debug output, or unprotected configuration paths. Exposed secrets can rapidly expand the blast radius of an incident.

### Audit Tampering

If logs or incident records can be modified, deleted, or forged, it becomes difficult to determine what happened and whether a fix is sufficient. Integrity of the audit trail is therefore a first-class security requirement.

### Unsafe Provider Interaction

External providers may execute actions that exceed the intended scope if requests are forwarded without strict validation. Any provider integration can become unsafe if the system trusts provider responses more than the local policy decision.

### Supply Chain and Dependency Risk

Dependencies, build steps, and contributed changes can introduce vulnerabilities. A compromised dependency or unsafe code contribution may create an attack path before runtime even begins.

### Denial of Service

Attackers may try to overwhelm enforcement, logging, or provider pathways in order to reduce availability or delay incident response. Resource exhaustion can also reduce the system’s ability to enforce policy in real time.

### Incident Response Delay

A threat may not exploit the code directly, but instead exploit delays in triage, communication, or containment. Slow response can materially increase the impact of an otherwise manageable issue.

---

## Attack Surfaces

The main attack surfaces are the SDK boundary, policy evaluation layer, provider/action routing, CLI and TUI interfaces, direct API calls, forwarded tool calls, and any code paths that transform user intent into executable commands.

Each of these surfaces must be assumed attackable unless the code explicitly restricts input, validates context, and enforces policy at the correct point.

---

## Core Failure Modes

The most important failure modes are the ones that produce unsafe execution without clear visibility.

The first failure mode is enforcing policy too late, after side effects have already begun. The second is evaluating policy correctly but failing to carry the decision all the way to execution. The third is using overly broad permissions or default allow behavior. The fourth is assuming that one component will protect another component without explicit checks. The fifth is failing to detect or preserve evidence when a security event occurs.

These failure modes are especially dangerous because they can appear normal until the system is under attack.

---

## Primary Mitigations

caracal should defend itself using deny-by-default behavior, explicit authorization, least privilege, strict input validation, and centralized enforcement. Sensitive operations should be validated at the narrowest practical choke point before execution. Provider access should be constrained to the minimum required scope. Audit logs should be tamper-resistant and captured consistently. Secrets should be stored and transmitted with strict handling rules. Changes to enforcement logic should be covered by tests that focus on both happy paths and bypass attempts.

During a live incident, the system should be able to disable or restrict risky paths quickly without requiring a major redesign.

---

## Detection and Response

A threat model is only useful if it maps to action. caracal should treat alerts, report quality, reproduction steps, and exploit evidence as inputs to incident handling. When a plausible issue is identified, the response should begin with validation, then containment, then a minimal mitigation, and finally a structured fix and review.

This response approach matches the project’s incident process and is intended to keep the system stable even when the team is under pressure. fileciteturn1file0

---

## Residual Risk

No system of this type can eliminate all risk. Residual risk remains in external dependencies, operator mistakes, provider behavior, and unknown logic gaps. The objective is not to claim perfect security, but to make harmful outcomes harder, narrower, and easier to detect and contain.

Residual risk should be accepted only when it is understood, monitored, and documented.

---

## Review Triggers

This threat model should be reviewed when authorization logic changes, when provider integrations are added or modified, when execution paths become more autonomous, when new sensitive data is introduced, or when an incident reveals a weakness that was not previously modeled.

It should also be reviewed after major structural changes to the codebase or deployment model.

---

## Final Note

This threat model is intended to remain practical and grounded. It should help guide design decisions, prioritize hardening work, and support incident response with a clear understanding of what must be protected and where the system is most exposed.
