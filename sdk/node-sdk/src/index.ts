/**
 * Copyright (C) 2026 Garudex Labs. All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * @caracal/core — public API surface.
 */

export const VERSION = '0.1.0';

// Client
export { CaracalClient, CaracalBuilder, SDKConfigurationError } from './client';

// Context
export { ScopeContext, ContextManager } from './context';

// Operations
export {
	ToolOperations,
	CANONICAL_TOOL_CALL_CONTRACT_VERSION,
} from './tools';
export type { JsonArray, JsonObject, JsonPrimitive, JsonValue, QueryValue } from './json';

// Grouped surfaces
export * as ais from './ais';

// Infrastructure
export { HookRegistry, ScopeRef, StateSnapshot } from './hooks';
export { CaracalExtension } from './extensions';

// Adapters
export { BaseAdapter, SDKRequest, SDKResponse } from './adapters/base';
export { HttpAdapter } from './adapters/http';
export { WebSocketAdapter } from './adapters/websocket';
export { MockAdapter } from './adapters/mock';
