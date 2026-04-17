/**
 * Copyright (C) 2026 Garudex Labs. All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * SDK Transport Adapter — base class and data structures.
 */

import { JsonObject, JsonValue, QueryValue } from '../json';

/** Outbound SDK request representation. */
export interface SDKRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: JsonObject;
  params?: Record<string, QueryValue>;
}

/** Inbound SDK response representation. */
export interface SDKResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: JsonValue;
  elapsedMs: number;
}

/** Abstract base for all transport adapters. */
export abstract class BaseAdapter {
  abstract send(request: SDKRequest): Promise<SDKResponse>;
  abstract close(): void;
  abstract get isConnected(): boolean;
}
