/** AIS routing helpers for Node SDK clients. */

export function isAisSocketConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean((env.CARACAL_AIS_UNIX_SOCKET_PATH ?? '').trim());
}

export function resolveAisBaseUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  if (!isAisSocketConfigured(env)) {
    return undefined;
  }

  const host = (env.CARACAL_AIS_LISTEN_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
  const port = (env.CARACAL_AIS_LISTEN_PORT ?? '7079').trim() || '7079';
  const rawPrefix = (env.CARACAL_AIS_API_PREFIX ?? '/v1/ais').trim() || '/v1/ais';
  const prefix = (rawPrefix.startsWith('/') ? rawPrefix : `/${rawPrefix}`).replace(/\/$/, '');

  return `http://${host}:${port}${prefix}`;
}

export function resolveSdkBaseUrl(env: Record<string, string | undefined> = process.env): string {
  return resolveAisBaseUrl(env) ?? env.CARACAL_API_URL ?? `http://localhost:${env.CARACAL_API_PORT ?? '8000'}`;
}
