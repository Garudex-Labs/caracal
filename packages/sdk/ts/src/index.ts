/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Public surface of the Caracal SDK.
 */

export { Caracal, CredentialsUnavailableError } from './client.js'
export type {
  CaracalEvent,
  DelegationAcceptEvent,
  EventHook,
  SessionOptions,
  StartSessionOptions,
  DelegateOptions,
  ResourceBinding,
  GatewayTarget,
  LifecycleHook,
  CallOptions,
  TransportOptions,
  ApplicationTransportOptions,
  MandateOptions,
  MintedMandate,
  FederatedSubject,
  BindOptions,
  ClientSecretOptions,
} from './client.js'
export { CaracalError, ApprovalRequiredError, isApprovalRequired } from '@caracalai/oauth'
export type { ApprovalState, ApprovalWaitEvent, ApprovalRequiredDetails, OAuthEvent, TokenExchangeEvent } from '@caracalai/oauth'
export { captureContext, describeAuthority } from './context.js'
export type { AuthoritySummary, CaracalContext, VerifiedClaims } from './context.js'
export { CoordinatorError } from './coordinator.js'
export type { SessionStatus, CoordinatorCallEvent } from './coordinator.js'
export { Authority } from './primitives.js'
export type { AuthorityMode, Delegation } from './primitives.js'
export type { DelegationConstraints } from './coordinator.js'
export type { SessionHandle } from './primitives.js'
export type { JsonArray, JsonObject, JsonPrimitive, JsonValue } from './json.js'
