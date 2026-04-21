/**
 * Copyright (C) 2026 Garudex Labs. All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Reserved for a future WebSocket transport implementation.
 */

import { BaseAdapter, SDKRequest, SDKResponse } from './base';

export class WebSocketAdapter extends BaseAdapter {
  constructor(private readonly options: { url: string }) {
    super();
  }

  async send(_request: SDKRequest): Promise<SDKResponse> {
    throw new Error('WebSocket transport is not implemented.');
  }

  close(): void {}

  get isConnected(): boolean {
    return false;
  }
}
