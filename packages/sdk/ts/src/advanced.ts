/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Advanced surface: low-level primitives, codec, ambient context plumbing,
 * and the raw coordinator client. Most integrators only need the default
 * "@caracalai/sdk" entrypoint; reach for these when building a transport
 * adapter or a framework shim.
 */

export * from "./envelope.js";
export * from "./context.js";
export * from "./coordinator.js";
export * from "./primitives.js";
export * from "./http.js";
export { Caracal } from "./client.js";
export type { CaracalConfig, SpawnOptions, DelegateOptions, LifecycleHook } from "./client.js";
