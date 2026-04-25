import { SDKRequest, SDKResponse } from './adapters/base';
import type { JsonObject } from './json';

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

export interface ScopeRef {
  workspaceId?: string;
}

export interface StateSnapshot {
  workspaceId?: string;
  metadata?: JsonObject;
}

// ---------------------------------------------------------------------------
// Callback types
// ---------------------------------------------------------------------------

type InitializeCallback = () => void;
type BeforeRequestCallback = (req: SDKRequest, scope: ScopeRef) => SDKRequest | Promise<SDKRequest>;
type AfterResponseCallback = (res: SDKResponse, scope: ScopeRef) => void;
type StateChangeCallback = (state: StateSnapshot) => void;
type ErrorCallback = (err: Error) => void;
type ContextSwitchCallback = (from: ScopeRef | null, to: ScopeRef) => void;

// ---------------------------------------------------------------------------
// HookRegistry
// ---------------------------------------------------------------------------

export class HookRegistry {
  private initializeCallbacks: InitializeCallback[] = [];
  private beforeRequestCallbacks: BeforeRequestCallback[] = [];
  private afterResponseCallbacks: AfterResponseCallback[] = [];
  private stateChangeCallbacks: StateChangeCallback[] = [];
  private errorCallbacks: ErrorCallback[] = [];
  private contextSwitchCallbacks: ContextSwitchCallback[] = [];

  // -- Registration --------------------------------------------------------

  onInitialize(cb: InitializeCallback): void {
    this.initializeCallbacks.push(cb);
  }

  onBeforeRequest(cb: BeforeRequestCallback): void {
    this.beforeRequestCallbacks.push(cb);
  }

  onAfterResponse(cb: AfterResponseCallback): void {
    this.afterResponseCallbacks.push(cb);
  }

  onStateChange(cb: StateChangeCallback): void {
    this.stateChangeCallbacks.push(cb);
  }

  onError(cb: ErrorCallback): void {
    this.errorCallbacks.push(cb);
  }

  onContextSwitch(cb: ContextSwitchCallback): void {
    this.contextSwitchCallbacks.push(cb);
  }

  // -- Firing --------------------------------------------------------------

  fireInitialize(): void {
    for (const cb of this.initializeCallbacks) {
      try { cb(); } catch (e) { this.fireError(e as Error); }
    }
  }

  async fireBeforeRequest(request: SDKRequest, scope: ScopeRef): Promise<SDKRequest> {
    let current = request;
    for (const cb of this.beforeRequestCallbacks) {
      try { current = await cb(current, scope); } catch (e) { this.fireError(e as Error); }
    }
    return current;
  }

  fireAfterResponse(response: SDKResponse, scope: ScopeRef): void {
    for (const cb of this.afterResponseCallbacks) {
      try { cb(response, scope); } catch (e) { this.fireError(e as Error); }
    }
  }

  fireStateChange(state: StateSnapshot): void {
    for (const cb of this.stateChangeCallbacks) {
      try { cb(state); } catch (e) { this.fireError(e as Error); }
    }
  }

  fireError(error: Error): void {
    for (const cb of this.errorCallbacks) {
      try {
        cb(error);
      } catch (e) {
        // Match Python SDK: never recurse into on_error; still surface hook bugs.
        console.error('[caracal-sdk] onError hook callback failed:', e);
      }
    }
  }

  fireContextSwitch(from: ScopeRef | null, to: ScopeRef): void {
    for (const cb of this.contextSwitchCallbacks) {
      try { cb(from, to); } catch (e) { this.fireError(e as Error); }
    }
  }
}
