/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Public surface of the Caracal SDK.
 */

export { Caracal, CredentialsUnavailableError } from './client.js'
export type {
  CaracalConfig,
  CaracalEvent,
  ClientCredentials,
  CredentialsResolver,
  EventHook,
  SessionOptions,
  StartSessionOptions,
  DelegateOptions,
  ResourceBinding,
  GatewayRequest,
  LifecycleHook,
  AppIdentityOptions,
  TransportOptions,
  ApplicationTransportOptions,
  MandateOptions,
  MintedMandate,
  BindOptions,
  TokenSource,
  ClientSecretExchanger,
  ClientSecretOptions,
  CaracalOptions,
} from './client.js'
export { CaracalError, ApprovalRequiredError } from '@caracalai/oauth'
export type { ApprovalWaitEvent, ApprovalRequiredDetails, OAuthEvent, TokenExchangeEvent } from '@caracalai/oauth'
export { captureContext, describeAuthority } from './context.js'
export type { AuthoritySummary, CaracalContext, VerifiedClaims } from './context.js'
export { CoordinatorError } from './coordinator.js'
export type { AgentStatus, CoordinatorCallEvent, CoordinatorClient } from './coordinator.js'
export { Authority, acceptDelegation } from './primitives.js'
export type { AuthorityMode, Delegation } from './primitives.js'
export type { DelegationConstraints } from './coordinator.js'
export type { SessionHandle } from './primitives.js'
export type { Envelope } from './envelope.js'
export type { JsonArray, JsonObject, JsonPrimitive, JsonValue } from './json.js'
