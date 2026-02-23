/**
 * Copyright (C) 2026 Garudex Labs. All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Mock transport adapter for testing.
 */

import { BaseAdapter, SDKRequest, SDKResponse } from './base';

export class MockAdapter extends BaseAdapter {
  private readonly responses: Map<string, SDKResponse>;
  private readonly sent: SDKRequest[] = [];

  constructor(responses?: Map<string, SDKResponse>) {
    super();
    this.responses = responses ?? new Map();
  }

  /** Add a mocked response keyed by `METHOD /path`. */
  mock(method: string, path: string, response: SDKResponse): void {
    this.responses.set(`${method.toUpperCase()} ${path}`, response);
  }

  async send(request: SDKRequest): Promise<SDKResponse> {
    this.sent.push(request);
    const key = `${request.method.toUpperCase()} ${request.path}`;
    const match = this.responses.get(key);
    if (match) return match;
    return {
      statusCode: 404,
      headers: {},
      body: { error: 'not mocked' },
      elapsedMs: 0,
    };
  }

  close(): void {
    this.responses.clear();
    this.sent.length = 0;
  }

  get isConnected(): boolean {
    return true;
  }

  /** All requests that have been sent through this adapter. */
  get sentRequests(): SDKRequest[] {
    return [...this.sent];
  }
}
