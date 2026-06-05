# Safe Implementation

Use after user confirmation to implement the Caracal SDK integration with complete, production-grade code, minimal native changes, and official APIs.

## Procedure

1. **Verify User Approval**: Ensure the user has explicitly confirmed the integration plan.
2. **Consult Official APIs**: Always write code using verified, actual Caracal SDK capabilities and API contracts. Never invent or assume methods, types, or configuration.
3. **No Mockups or Placeholders**: Write fully functional, complete integrations instead of mockups or placeholder code. Avoid comments like `// TODO: implement later` in critical integration points.
4. **Follow Existing Patterns**: Reuse the codebase's existing directories, files, frameworks, dependency injection, and configuration approaches. Do not perform broad refactorings or restructure the repository.
5. **Secure Secret Management**: Configure the SDK using environment variables or the user's existing secret manager. Never output or hardcode client secrets, private keys, or API tokens.
6. **Validate the Integration**: Run the codebase's local test suite, compile steps, or type checks to guarantee the integration did not introduce regressions.
7. **Document the Changes**: Provide a concise summary of files changed, integration behavior, and remaining steps for user validation.
