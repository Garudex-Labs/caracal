<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->

<!-- SPDX-License-Identifier: Apache-2.0 -->

# AI Policy

Caracal permits the use of artificial intelligence ("AI") systems and AI-assisted development tools in the creation, review, testing, and documentation of contributions.

AI-assisted development can improve productivity and reduce implementation effort. However, all contributions must meet the project's standards for correctness, maintainability, security, licensing, and human accountability. AI-generated output must therefore be treated as development assistance rather than as a substitute for contributor responsibility.

This policy establishes the requirements that apply when AI systems are used in the development or submission of contributions to Caracal.

> [!IMPORTANT]
> The use of AI is permitted, but responsibility for every submitted contribution remains with the human contributor who submits it.

## Human Authorship and Accountability

Fully autonomous submissions are not permitted.

An AI system or coding agent must not independently determine the scope of work, make material implementation decisions, produce a complete contribution, and submit that contribution to Caracal without meaningful human direction, review, and approval.

Interactive AI development tools may be used to write, modify, review, test, document, or otherwise assist with project development provided that an accountable human contributor:

* Directs or meaningfully supervises the work.
* Reviews the resulting changes before submission.
* Understands the material technical and licensing implications of the contribution.
* Makes or explicitly approves material implementation decisions.
* Accepts responsibility for the submitted contribution.
* Has the authority to make the contribution under the project's applicable contribution and licensing requirements.

The relevant distinction is therefore not whether an AI system can edit files, execute commands, create commits, push branches, or open pull requests. The distinction is whether a human contributor provides meaningful authorship, oversight, review, and accountability.

## Intellectual Property and Licensing

Contributors remain responsible for ensuring that their submissions satisfy the project's licensing requirements, including the representations and obligations contained in the applicable Contributor License Agreement.

AI assistance does not transfer responsibility for intellectual property rights to the project. A contributor must have the necessary rights to submit the resulting work and must not knowingly introduce material that infringes or conflicts with third-party copyrights, patents, licenses, or other intellectual property rights.

The copyright status of AI-assisted material may depend on the degree and nature of human creative contribution and the circumstances under which the material was produced. Because these questions are fact-specific and can vary by jurisdiction, contributors must exercise appropriate judgment and ensure that submitted work contains sufficient human review and authorship to support the representations they make under the project's contribution agreements.

Contributors should also consider the possibility that an AI system may produce output that is substantially similar to existing third-party material. Generated code must therefore be reviewed for licensing and provenance concerns before submission.

This policy is consistent with the broader approach used across responsible open-source development communities: AI systems may assist contributors, but they do not replace human responsibility for the legal and technical consequences of submitted work.

## Permitted Use of AI

AI systems may be used for legitimate development activities, including implementation, refactoring, debugging, code review, test generation, documentation, repository analysis, design exploration, and preparation of pull requests.

A contributor may also authorize an interactive AI coding system to perform repository operations such as creating commits, updating branches, preparing pull requests, or running development tooling, provided that the contributor has reviewed and approved the resulting changes and remains accountable for the submission.

AI-assisted contributions are acceptable when the contributor can independently assess the correctness, security, licensing implications, and maintainability of the resulting work.

## Requirements for AI-Assisted Contributions

### Human Review

The contributor must review the complete resulting change before submission.

Generated or modified code must not be submitted solely because it appears plausible or because an AI system reports that it is correct.

The contributor is responsible for identifying:

* Incorrect or incomplete implementations.
* Hallucinated APIs or dependencies.
* Incorrect assumptions about the codebase.
* Security vulnerabilities.
* Unnecessary complexity.
* Poor performance characteristics.
* Inconsistent project conventions.
* Dead code, placeholder code, or generated boilerplate.
* Licensing or attribution concerns.

### Technical Understanding

The contributor must understand the material behavior and design of the submitted changes.

A contributor must be able to explain the implementation, its dependencies, relevant design decisions, and expected behavior when requested during review.

Attributing a decision or implementation solely to an AI system does not satisfy this requirement.

### Validation

AI-assisted changes must be tested and validated using the project's normal development and CI processes.

Before opening a pull request, contributors should:

* Build the affected components.
* Run the relevant test suite.
* Run applicable static analysis and linting.
* Verify integration behavior where relevant.
* Confirm that no unrelated functionality has been unintentionally changed.

For the current project workflow, contributors must run:

```bash
make test
```

and verify that the applicable continuous-integration checks pass before submitting the pull request.

### Diff Review

The contributor must review the complete final diff, not merely the portions of the code that were directly requested from the AI system.

AI systems may introduce unrelated changes, subtle logic errors, unnecessary refactoring, or incorrect assumptions outside the immediate task. The entire submitted change must therefore be reviewed as a single contribution.

### Frontend Changes

Pull requests affecting the web frontend must include screenshots of all materially affected screens in the pull request description.

This requirement applies regardless of whether AI assistance was used.

### AI Disclosure

When AI makes a non-trivial contribution to a pull request, the contributor must disclose its use in the pull request description.

The disclosure should identify the AI tool and, where available, the relevant model or tool version.

For example:

```text
AI assistance: [tool name], [model/tool version]
```

A non-trivial contribution includes cases where an AI system writes, substantially restructures, or materially modifies source code, documentation, configuration, tests, or other project content.

Routine autocomplete or similarly minor assistance does not require disclosure unless the contributor considers the disclosure appropriate.

## Prohibited Use

The following practices are not permitted:

* Submitting pull requests generated and published by an unattended autonomous agent without meaningful human direction, review, and approval.
* Submitting AI-generated material that the contributor has not reviewed and understood.
* Representing AI-generated work as independently authored where doing so would make the contributor's licensing or authorship representations inaccurate.
* Introducing third-party material with unknown or incompatible licensing without appropriate review and disclosure.
* Publishing AI-generated comments, review responses, issue responses, or other project communications without human review and approval.
* Repeatedly introducing known classes of AI-generated defects after they have been identified during review.
* Using AI systems to bypass project security, contribution, review, or release controls.

> [!WARNING]
> Contributions containing substantial evidence of unreviewed or uncontrolled AI output may be rejected without review. Examples include hallucinated APIs, placeholder implementations, irrelevant boilerplate, inconsistent architecture, fabricated dependencies, incorrect identifiers, or changes that the contributor cannot explain or validate.
>
> Repeated submission of materially unreviewed AI-generated work may result in restrictions on the contributor's participation in the project.

## Contributor Responsibility

The use of AI does not reduce or transfer contributor responsibility.

The submitting contributor remains responsible for ensuring that each contribution:

* Is technically correct.
* Meets project requirements and engineering standards.
* Does not introduce avoidable security vulnerabilities.
* Complies with applicable licenses and intellectual property obligations.
* Has been appropriately tested and reviewed.
* Can be explained and maintained by the contributor.
* Complies with the project's Contributor License Agreement and other contribution policies.

Caracal evaluates contributions based on their quality, correctness, security, maintainability, and compliance with project requirements, regardless of whether AI assistance was used.

## Policy Interpretation

This policy establishes minimum requirements for responsible AI-assisted development. Maintainers may request additional information about the use of AI where necessary to evaluate authorship, provenance, licensing, security, or technical correctness.

Where uncertainty exists regarding whether a particular use of AI complies with this policy, contributors should err on the side of disclosure, review, and human oversight.

The project may update this policy as AI-assisted development practices, applicable law, and open-source licensing standards evolve.
