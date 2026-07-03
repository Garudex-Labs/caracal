# caracalai-identity

JWT verification, JWKS cache, scope evaluation, and claim shapes for Caracal-issued agent tokens.

Part of [Caracal](https://github.com/Garudex-Labs/caracal): the identity and authorization layer for AI agents - short-lived, policy-approved authority instead of credentials.

## Install

```bash
pip install caracalai-identity
```

## Production contract

Verified tokens must include `exp`, `iat`, `jti`, `sub`, `sid`, `client_id`, `zone_id`, and `use`. Configure expected issuer, audience, zone, required scopes, and required token use at the resource boundary.

Verification failures are authentication failures. Do not continue with anonymous identity state or partially trusted claims.

## Links

- Source: https://github.com/Garudex-Labs/caracal
- Docs: https://caracal.run/sdks/identity/
- License: Apache-2.0
