/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Public surface of the Caracal SDK.
 */

export { Caracal } from './client.js'
export type {
  CaracalConfig,
  CaracalEvent,
  EventHook,
  SpawnOptions,
  ServiceOptions,
  DelegateOptions,
  ResourceBinding,
  GatewayRequest,
  LifecycleHook,
  RootOptions,
  TransportOptions,
  GovernedTransportOptions,
  MandateOptions,
  MintedMandate,
  BindOptions,
  TokenSource,
  ClientSecretExchanger,
  ClientSecretOptions,
  CaracalOptions,
} from './client.js'
export { CaracalError, InteractionRequiredError } from '@caracalai/oauth'
export type { ApprovalWaitEvent, InteractionRequiredDetails, OAuthEvent, TokenExchangeEvent } from '@caracalai/oauth'
export { captureContext, describeAuthority } from './context.js'
export type { AuthoritySummary, CaracalContext, VerifiedClaims } from './context.js'
export { CoordinatorError } from './coordinator.js'
export type { AgentStatus, CoordinatorCallEvent, CoordinatorClient, DelegationResponse } from './coordinator.js'
export { Grant, adoptDelegation } from './primitives.js'
export type { GrantMode } from './primitives.js'
export type { DelegationConstraints } from './coordinator.js'
export type { ServiceAgent } from './primitives.js'
export type { Envelope } from './envelope.js'
export type { JsonArray, JsonObject, JsonPrimitive, JsonValue } from './json.js'
