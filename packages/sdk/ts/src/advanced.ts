/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Advanced surface: low-level primitives, codec, bound context plumbing,
 * and the raw coordinator client. Most integrators only need the default
 * "@caracalai/sdk" entrypoint; reach for these when building a transport
 * adapter or framework integration.
 */

export {
  HeaderAuthorization,
  HeaderTraceparent,
  HeaderTracestate,
  HeaderBaggage,
  BaggageAgentSession,
  BaggageDelegationEdge,
  BaggageParentEdge,
  BaggageSession,
  BaggageHop,
  MaxHop,
  formatTraceparent,
  parseTraceparent,
  encodeBaggage,
  parseBaggage,
  fromHeaders,
  decodeEnvelope,
  encodeEnvelope,
  toHeaders,
} from './envelope.js'
export type { Envelope, HeaderGetter, HeaderSetter } from './envelope.js'
export {
  current,
  captureContext,
  bind,
  withOverrides,
  toEnvelope,
  fromEnvelope,
  fromVerifiedEnvelope,
  describeAuthority,
} from './context.js'
export type { CaracalContext, AuthoritySummary, VerifiedClaims } from './context.js'
export {
  CoordinatorError,
  Lifecycle,
  startCoordinatorSession,
  terminateSession,
  acquireSessionLease,
  heartbeatSession,
  createDelegation,
  revokeDelegation,
  getInboundDelegation,
  listInboundDelegations,
} from './coordinator.js'
export type {
  CoordinatorCallEvent,
  CoordinatorClient,
  SessionStatus,
  DelegationConstraints,
  StartSessionRequest,
  StartSessionResponse,
  DelegationRequest,
  DelegationResponse,
  HeartbeatResponse,
  InboundDelegation,
} from './coordinator.js'
export { Authority, session, delegate, acceptDelegation, startSession, attachSession } from './primitives.js'
export type {
  AuthorityMode,
  SessionInput,
  DelegateInput,
  Delegation,
  StartSessionInput,
  SessionHandle,
  AttachSessionInput,
} from './primitives.js'
export { caracalContextMiddleware, caracalFastifyHook } from './http.js'
export type { IncomingLike, FastifyRequestLike, ServerResponseLike, FastifyReplyLike, ConnectMiddleware } from './http.js'
export {
  Caracal,
  createAdvancedClient,
  createAdvancedClientFromConfig,
  createAdvancedClientFromCredentials,
  createAdvancedClientFromEnv,
} from './client.js'
export type {
  CaracalConfig,
  SessionOptions,
  DelegateOptions,
  LifecycleHook,
  CallOptions,
  TokenSource,
  ClientCredentials,
  CredentialsResolver,
  ClientSecretOptions,
} from './client.js'
