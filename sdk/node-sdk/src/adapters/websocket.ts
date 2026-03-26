/**
 * Copyright (C) 2026 Garudex Labs. All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * WebSocket transport adapter (placeholder — coming in v0.4).
 */

import { BaseAdapter, SDKRequest, SDKResponse } from './base';

export class WebSocketAdapter extends BaseAdapter {
  constructor(private readonly options: { url: string }) {
    super();
  }

  async send(_request: SDKRequest): Promise<SDKResponse> {
    throw new Error('WebSocket adapter coming in v0.4');
  }

  close(): void {
    // no-op
  }

  get isConnected(): boolean {
    return false;
  }
}
