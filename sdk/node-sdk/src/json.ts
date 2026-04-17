/**
 * Copyright (C) 2026 Garudex Labs. All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Shared JSON payload types for SDK transport surfaces.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonArray = JsonValue[];
export type QueryValue = string | number | boolean | null;
