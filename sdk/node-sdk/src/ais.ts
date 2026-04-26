/** AIS routing helpers for Node SDK clients. */

function defaultEnv(): Record<string, string | undefined> {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env ?? {};
}

export function isAisSocketConfigured(env: Record<string, string | undefined> = defaultEnv()): boolean {
  return Boolean((env.CCL_AIS_UNIX_SOCKET_PATH ?? '').trim());
}

export function resolveAisBaseUrl(env: Record<string, string | undefined> = defaultEnv()): string | undefined {
  if (!isAisSocketConfigured(env)) {
    return undefined;
  }

  const host = (env.CCL_AIS_LISTEN_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
  const port = (env.CCL_AIS_LISTEN_PORT ?? '7079').trim() || '7079';
  const rawPrefix = (env.CCL_AIS_API_PREFIX ?? '/v1/ais').trim() || '/v1/ais';
  const prefix = (rawPrefix.startsWith('/') ? rawPrefix : `/${rawPrefix}`).replace(/\/$/, '');

  return `http://${host}:${port}${prefix}`;
}

export function resolveSdkBaseUrl(env: Record<string, string | undefined> = defaultEnv()): string {
  return resolveAisBaseUrl(env) ?? env.CCL_API_URL ?? `http://localhost:${env.CCL_API_PORT ?? '8000'}`;
}
