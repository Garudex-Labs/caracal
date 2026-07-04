/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Public surface of the Caracal SDK.
 */

export { Caracal } from './client.js'
export type {
  CaracalConfig,
  SpawnOptions,
  ServiceOptions,
  DelegateOptions,
  ResourceBinding,
  GatewayRequest,
  LifecycleHook,
  RootOptions,
  BindOptions,
  TokenSource,
  ClientSecretOptions,
  CaracalOptions,
} from './client.js'
export { captureContext, describeAuthority } from './context.js'
export type { AuthoritySummary, CaracalContext, VerifiedClaims } from './context.js'
export { CoordinatorError } from './coordinator.js'
export type { AgentStatus, CoordinatorClient, DelegationResponse } from './coordinator.js'
export { Grant, adoptDelegation } from './primitives.js'
export type { GrantMode } from './primitives.js'
export type { DelegationConstraints } from './coordinator.js'
export type { ServiceAgent } from './primitives.js'
export type { Envelope } from './envelope.js'
export type { JsonArray, JsonObject, JsonPrimitive, JsonValue } from './json.js'
