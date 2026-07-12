/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Documentation version routing and Starlight integration helpers.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'

const docsRoot = existsSync(join(process.cwd(), 'versions.json')) ? process.cwd() : resolve(process.cwd(), 'docs')
const versionPattern = /^v\d+\.\d+$/

export const docsVersionState = JSON.parse(readFileSync(join(docsRoot, 'versions.json'), 'utf8'))
export const docsSnapshotMode = process.env.CARACAL_DOCS_SNAPSHOT === '1'
export const starlightVersionsConfig = {
  current: { label: 'Next', redirect: 'same-page' },
  versions: docsVersionState.versions.map((version) => ({
    slug: version.version,
    label: version.version,
    redirect: 'same-page',
  })),
}

export function docsEntryId({ entry, data }, state = docsVersionState, snapshot = docsSnapshotMode) {
  if (typeof data.slug === 'string' && data.slug.length > 0) return data.slug

  const id = entry.replace(/\.(?:markdown|mdown|mkdn|mkd|mdwn|md|mdx)$/, '').replace(/\/index$/, '') || 'index'
  if (snapshot || id === '404') return id
  if (!state.current) {
    if (!state.target) return id
    return id === 'index' ? state.target : `${state.target}/${id}`
  }

  const segment = id.split('/', 1)[0]
  if (state.versions.some((version) => version.version === segment)) return id

  return id === 'index' ? 'next' : `next/${id}`
}

export function prefixSidebar(items, prefix) {
  return items.map((item) => {
    if (typeof item === 'string') return `${prefix}/${item}`
    if ('items' in item) return { ...item, items: prefixSidebar(item.items, prefix) }
    if ('autogenerate' in item) {
      return { ...item, autogenerate: { ...item.autogenerate, directory: `${prefix}/${item.autogenerate.directory}` } }
    }
    if ('slug' in item) return { ...item, slug: `${prefix}/${item.slug}` }
    if (!('link' in item) || !item.link.startsWith('/') || item.link.startsWith('//')) return item
    return { ...item, link: `/${prefix}${item.link}` }
  })
}

export function docsRouteVersion(pathname, state = docsVersionState) {
  const segment = pathname.split('/').filter(Boolean)[0]
  if (segment === 'next') return 'next'
  if (segment === state.target) return segment
  return state.versions.some((version) => version.version === segment) ? segment : null
}

export function docsHref(pathname, href, state = docsVersionState) {
  if (!href.startsWith('/') || href.startsWith('//')) return href

  const hrefSegment = href.split('/').filter(Boolean)[0]
  if (hrefSegment === 'next' || state.versions.some((version) => version.version === hrefSegment)) return href

  const version = docsRouteVersion(pathname, state) ?? state.current ?? state.target
  return version ? `/${version}${href}` : href
}

export function switchDocsVersionPath(pathname, version, state = docsVersionState) {
  const segments = pathname.split('/').filter(Boolean)
  const routeVersion = docsRouteVersion(pathname, state)
  if (routeVersion) segments.shift()

  const suffix = segments.length > 0 ? `/${segments.join('/')}/` : '/'
  return version === 'next' ? `/next${suffix}` : `/${version}${suffix}`
}

export function logicalDocId(id, state = docsVersionState) {
  const segment = id.split('/', 1)[0]
  const isVersion = segment === 'next' || segment === state.target || state.versions.some((version) => version.version === segment)
  if (!isVersion) return id
  if (id === segment) return 'index'
  return id.slice(segment.length + 1)
}

export function publishedDocs(entries, state = docsVersionState) {
  if (!state.current) {
    return state.target
      ? entries.filter((entry) => entry.id === state.target || entry.id.startsWith(`${state.target}/`))
      : entries.filter((entry) => !entry.id.startsWith('next/') && !versionPattern.test(entry.id.split('/', 1)[0]))
  }

  return entries.filter((entry) => entry.id === state.current || entry.id.startsWith(`${state.current}/`))
}

export function publishedPath(id) {
  return id === 'index' ? '/' : `/${id}/`
}

export function isLockedDocsPath(pathname, state = docsVersionState) {
  const version = docsRouteVersion(pathname, state)
  return state.versions.find((entry) => entry.version === version)?.locked === true
}

export function sourceDocRoutes(sourceDir, state = docsVersionState) {
  const routes = []
  const versions = new Set(state.versions.map((version) => version.version))

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const sourcePath = relative(sourceDir, path)
      const firstSegment = sourcePath.split(sep, 1)[0]
      if (entry.isDirectory()) {
        if (!versions.has(firstSegment)) visit(path)
        continue
      }
      if (!entry.isFile() || !['.md', '.mdx'].includes(extname(entry.name))) continue

      const stem = sourcePath
        .replace(/\.(?:md|mdx)$/, '')
        .split(sep)
        .join('/')
      if (stem === '404') continue
      if (stem === 'index') routes.push('/')
      else routes.push(`/${stem.replace(/\/index$/, '')}/`)
    }
  }

  visit(sourceDir)
  return routes.sort()
}

export function versionedRedirects(legacyRedirects, sourceDir, state = docsVersionState) {
  const version = state.current ?? state.target
  if (!version) return legacyRedirects

  const snapshotDir = join(sourceDir, version)
  const snapshotRoutes = existsSync(snapshotDir) ? new Set(sourceDocRoutes(snapshotDir, state)) : new Set()
  const redirects = {}

  for (const [source, destination] of Object.entries(legacyRedirects)) {
    const target = destination.startsWith('/') ? `/${version}${destination}` : destination
    redirects[source] = target
    if (!snapshotRoutes.has(source)) redirects[`/${version}${source}`] = target
  }

  for (const route of sourceDocRoutes(sourceDir, state)) {
    redirects[route] = route === '/' ? `/${version}/` : `/${version}${route}`
  }

  return redirects
}

export function docsShellPlugin() {
  const versionsBySlug = Object.fromEntries(starlightVersionsConfig.versions.map((version) => [version.slug, version]))
  const moduleId = 'virtual:starlight-versions-config'
  const resolvedModuleId = `\0${moduleId}`

  return {
    name: 'caracal-docs-versions-shell',
    hooks: {
      'config:setup'({ addIntegration, addRouteMiddleware, config, updateConfig }) {
        addRouteMiddleware({ entrypoint: './src/middleware/docsVersions.mjs' })
        const versions = docsVersionState.current
          ? [...docsVersionState.versions.map((version) => version.version), 'next']
          : [docsVersionState.target]
        updateConfig({
          components: {
            ...config.components,
            Banner: './src/components/Banner.astro',
            EditLink: './src/components/EditLink.astro',
            PageTitle: './src/components/PageTitle.astro',
            ...(docsVersionState.current ? { Search: 'starlight-versions/overrides/Search.astro' } : {}),
            ThemeSelect: './src/components/ThemeSelectWithVersion.astro',
          },
          sidebar: versions.filter(Boolean).map((version) => ({
            label: version,
            items: prefixSidebar(config.sidebar ?? [], version),
          })),
        })
        if (!docsVersionState.current) return
        addIntegration({
          name: 'caracal-docs-versions-search',
          hooks: {
            'astro:config:setup'({ updateConfig: updateAstroConfig }) {
              const moduleContent = `export default ${JSON.stringify({ ...starlightVersionsConfig, versionsBySlug })}`
              updateAstroConfig({
                vite: {
                  plugins: [
                    {
                      name: 'caracal-docs-versions-config',
                      resolveId(id) {
                        return id === moduleId ? resolvedModuleId : undefined
                      },
                      load(id) {
                        return id === resolvedModuleId ? moduleContent : undefined
                      },
                    },
                  ],
                },
              })
            },
          },
        })
      },
    },
  }
}
