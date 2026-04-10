/**
 * Runtime surface guards for removed SDK resource APIs.
 */

import { SDKConfigurationError } from './errors';

export function requireLegacyResourceApi(operation: string, endpointGroup: string): never {
  throw new SDKConfigurationError(
    `${operation} targets removed legacy '${endpointGroup}' SDK routes. `
      + 'Legacy compatibility is not supported in hard-cut mode. '
      + 'Use scope.tools.call(...) for execution, and manage principal identities '
      + '(orchestrator/worker/service/human) via principal control surfaces.',
  );
}
