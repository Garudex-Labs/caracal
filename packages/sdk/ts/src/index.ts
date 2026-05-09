/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Public surface of the Caracal SDK.
 *
 * The drop-in API is the `Caracal` class. Construct it once (or call
 * `Caracal.fromEnv()`) and use `run`, `delegate`, `fetch`, `middleware`,
 * `context`, and `headers` directly. Everything else is advanced and
 * available from "@caracalai/sdk/advanced".
 */

export { Caracal } from "./client.js";
export type { CaracalConfig, RunOptions, DelegateOptions } from "./client.js";
export type { CaracalContext } from "./context.js";
export type { CoordinatorClient } from "./coordinator.js";
export type { Envelope } from "./envelope.js";
