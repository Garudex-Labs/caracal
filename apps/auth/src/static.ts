// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Static asset server for the built single-page app, with SPA fallback and immutable-asset caching.

import type { ServerResponse } from 'node:http'
import { createReadStream, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { applySecurityHeaders } from './security.ts'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

function contentType(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

// Maps a request path to an absolute path confined to the web root. Returns undefined when the
// normalized path would escape the root (directory traversal), which is the security-critical
// guard for static serving.
export function resolveStaticPath(root: string, urlPath: string): string | undefined {
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '')
  const candidate = resolve(root, '.' + (clean.startsWith('/') ? clean : '/' + clean))
  const rootResolved = resolve(root)
  if (candidate !== rootResolved && !candidate.startsWith(rootResolved + sep)) return undefined
  return candidate
}

// Asset cache policy: content-hashed files under /assets are immutable; everything else (notably
// the SPA shell) must revalidate so a deploy is reflected immediately.
export function cacheControlFor(urlPath: string): string {
  return urlPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
}

async function fileSize(path: string): Promise<number | undefined> {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : undefined
  } catch {
    return undefined
  }
}

interface ServeOutcome {
  served: boolean
}

// Serves a single asset or, when the path does not resolve to a file, falls back to the SPA
// shell so client-side routes deep-link correctly. Returns served=false only when index.html is
// missing, letting the caller surface a real error instead of a blank page.
export async function serveStatic(
  res: ServerResponse,
  root: string,
  urlPath: string,
  acceptEncoding: string,
  secure: boolean,
): Promise<ServeOutcome> {
  const direct = resolveStaticPath(root, urlPath)
  if (direct && extname(direct) && (await fileSize(direct)) !== undefined) {
    sendFile(res, direct, urlPath, acceptEncoding, secure)
    return { served: true }
  }
  const indexPath = join(resolve(root), 'index.html')
  if ((await fileSize(indexPath)) === undefined) return { served: false }
  sendFile(res, indexPath, '/index.html', acceptEncoding, secure)
  return { served: true }
}

function sendFile(res: ServerResponse, filePath: string, urlPath: string, acceptEncoding: string, secure: boolean): void {
  const isHtml = extname(filePath).toLowerCase() === '.html'
  applySecurityHeaders(res, { html: isHtml, secure })
  res.setHeader('Content-Type', contentType(filePath))
  res.setHeader('Cache-Control', cacheControlFor(urlPath))

  // Precompressed siblings (vite can emit .br/.gz) are served verbatim with the matching
  // Content-Encoding when the client advertises support, avoiding per-request compression.
  let source = filePath
  if (/\bbr\b/.test(acceptEncoding)) {
    source = pickEncoded(filePath, '.br') ?? source
  }
  if (source === filePath && /\bgzip\b/.test(acceptEncoding)) {
    source = pickEncoded(filePath, '.gz') ?? source
  }
  if (source !== filePath) {
    res.setHeader('Content-Encoding', source.endsWith('.br') ? 'br' : 'gzip')
    res.setHeader('Vary', 'Accept-Encoding')
  }
  createReadStream(source).pipe(res)
}

function pickEncoded(filePath: string, suffix: string): string | undefined {
  const candidate = filePath + suffix
  return existsSync(candidate) ? candidate : undefined
}
