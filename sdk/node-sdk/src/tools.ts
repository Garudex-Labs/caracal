import { SDKRequest, SDKResponse } from './adapters/base';
import { SDKConfigurationError } from './errors';
import { JsonObject, JsonValue } from './json';

// Canonical SDK->MCP tool-call contract version.
export const CANONICAL_TOOL_CALL_CONTRACT_VERSION = 'v1';

const ALLOWED_CORRELATION_METADATA_KEYS = new Set([
  'correlation_id',
  'trace_id',
  'request_id',
]);

const PROHIBITED_CALLER_SPOOFING_FIELDS = new Set([
  'principal_id',
  'mandate_id',
  'resolved_mandate_id',
  'policy_id',
  'token_subject',
  'task_token_claims',
  'task_caveat_chain',
  'task_caveat_hmac_key',
  'caveat_chain',
  'caveat_hmac_key',
  'caveat_task_id',
]);

function isObjectRecord(value: JsonValue | null | undefined): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export interface ToolScope {
  scopeHeaders(): Record<string, string>;
  toScopeRef(): {
    workspaceId?: string;
  };
  readonly _adapter: {
    send(request: SDKRequest): Promise<SDKResponse>;
  };
  readonly _hooks: {
    fireBeforeRequest(
      request: SDKRequest,
      scope: ReturnType<ToolScope['toScopeRef']>,
    ): Promise<SDKRequest>;
    fireAfterResponse(response: SDKResponse, scope: ReturnType<ToolScope['toScopeRef']>): void;
    fireError(error: Error): void;
  };
}

export class ToolOperations {
  constructor(private readonly scope: ToolScope) {}

  private buildReq(method: string, path: string, body?: JsonObject): SDKRequest {
    return { method, path, headers: { ...this.scope.scopeHeaders() }, body };
  }

  private async exec(req: SDKRequest): Promise<JsonValue> {
    const scoped = await this.scope._hooks.fireBeforeRequest(req, this.scope.toScopeRef());
    try {
      const res = await this.scope._adapter.send(scoped);
      this.scope._hooks.fireAfterResponse(res, this.scope.toScopeRef());
      return res.body;
    } catch (e) {
      this.scope._hooks.fireError(e as Error);
      throw e;
    }
  }

  async call(options: {
    toolId: string;
    toolArgs?: JsonObject;
    metadata?: JsonObject;
    correlationId?: string;
  }): Promise<JsonObject> {
    const toolId = String(options.toolId ?? '').trim();

    if (!toolId) {
      throw new SDKConfigurationError('toolId is required');
    }

    if (options.metadata !== undefined && !isObjectRecord(options.metadata)) {
      throw new SDKConfigurationError('metadata must be a dictionary');
    }
    if (options.toolArgs !== undefined && !isObjectRecord(options.toolArgs)) {
      throw new SDKConfigurationError('toolArgs must be a dictionary');
    }

    const payloadMetadata: JsonObject = { ...(options.metadata ?? {}) };
    const prohibitedMetadataKeys = Object.keys(payloadMetadata)
      .filter((key) => PROHIBITED_CALLER_SPOOFING_FIELDS.has(String(key)))
      .sort();
    if (prohibitedMetadataKeys.length > 0) {
      throw new SDKConfigurationError(
        `Caller identity fields are not allowed in tool call metadata: ${prohibitedMetadataKeys.join(', ')}`,
      );
    }

    const invalidMetadataKeys = Object.keys(payloadMetadata)
      .filter((key) => !ALLOWED_CORRELATION_METADATA_KEYS.has(String(key)))
      .sort();
    if (invalidMetadataKeys.length > 0) {
      throw new SDKConfigurationError(
        `metadata supports correlation keys only: ${Array.from(ALLOWED_CORRELATION_METADATA_KEYS).sort().join(', ')}`,
      );
    }

    if (options.correlationId) {
      payloadMetadata.correlation_id = String(options.correlationId);
    }

    const payloadToolArgs: JsonObject = { ...(options.toolArgs ?? {}) };
    const prohibitedToolArgKeys = Object.keys(payloadToolArgs)
      .filter((key) => PROHIBITED_CALLER_SPOOFING_FIELDS.has(String(key)))
      .sort();
    if (prohibitedToolArgKeys.length > 0) {
      throw new SDKConfigurationError(
        `Caller identity fields are not allowed in toolArgs: ${prohibitedToolArgKeys.join(', ')}`,
      );
    }

    const req = this.buildReq('POST', '/mcp/tool/call', {
      tool_id: toolId,
      tool_args: payloadToolArgs,
      metadata: payloadMetadata,
    });

    const result = await this.exec(req);
    return isObjectRecord(result) ? result : { result };
  }
}
