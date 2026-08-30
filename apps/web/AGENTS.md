<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Web Frontend

Vite 6 / React 19 / TypeScript 6 / TanStack Router / Tailwind CSS 4 / Playwright 1.59

## How users interact with it

The web UI is one of three ways to interact with Caracal, alongside the CLI and the bundled caracal skill. It covers:

- **Browsing and installing agents** from the registry
- **Viewing session traces** with conversation replay, span tree, and token counts
- **Admin operations** such as review queue, user management, insights, and audit logs
- **Agent building** with component assembly and live YAML preview

## Stack decisions

| Concern | Choice | Why |
|---------|--------|-----|
| Framework | Vite SPA with TanStack Router | Static Docker asset, simple split from FastAPI |
| UI primitives | shadcn/ui | Composable, accessible, themeable |
| Data fetching | TanStack Query via `use-api.ts` | Caching, deduplication, mutations |
| Tables | TanStack Table | Sort, filter, pagination built-in |
| Charts | Recharts 3 | Simple, works with OKLCH tokens |
| Auth storage | Current code uses sessionStorage for access token, localStorage for refresh token and profile cache | Documents existing behavior. Do not add new auth localStorage use unless intentionally changing the auth model. |
| API proxy | Vite dev proxy and nginx in Docker | Single origin for `/api/v1/*`, no CORS in prod |
| Fonts | Local files only | No Google Fonts CDN calls |
| Design tokens | OKLCH in `app.css` | Perceptually uniform themes |
| Harness list | Server-fetched (`/api/v1/config/harnesses`) | Never hardcoded in frontend |

## Design system

OKLCH color space with semantic tokens: `background`, `foreground`, `card`, `border`, `primary`, `secondary`, `accent`, `destructive`, `success`, `warning`, `info`.

**Foundation:** the dark theme (default) sits on a pure-black canvas (`--bg: 0 0 0`) with neutral gray surfaces and borders - structure comes from 1px borders, not shadows or elevation. The light theme mirrors this with neutral grays. Radius tokens are restrained (2–12px); avoid pills and large rounded containers. No gradients, glows, or decorative backgrounds.

**Blue is the brand color.** `primary` is blue in both themes and is the only accent for CTAs, links, focus rings, and selected states. Status colors stay semantic (`success`/`warning`/`destructive`/`info`); categorical data-viz hues (trace event types, span threads, chart series) are the only place other hues belong. Do not use raw Tailwind palette classes (`text-emerald-500`) for status or accent - use the tokens.

**Typography:** `--font-display` is Departure Mono (single 400 weight, pixel mono) for headings, branding, and prominent text - base styles pin `font-weight: 400`, `font-synthesis: none`, and `letter-spacing: 0` because the font is unreadable when squeezed or faux-bolded. `--font-body` is Albert Sans for body text, labels, tables, and controls. `--font-mono` is JetBrains Mono for code. All three load locally from `public/fonts/`; never add remote fonts.

**Application chrome:** the authed shell is a bordered, collapsible left sidebar (`RegistrySidebar`, icon-collapse mode, primary product navigation only) plus a dedicated top bar (`AppTopBar`: sidebar trigger, global search, and page breadcrumbs/title on the left; user-level controls - Inbox with unread dot, then the account menu (theme toggle and sign-out live in its dropdown) - on the right). The top bar is the single primary entry point to the Inbox; do not add it back to the sidebar. The main workspace is open on the black canvas - do not wrap page content in an outer boxed container. `PageHeader` (actions/tabs) sticks below the top bar at `top-12`.

**Navigation model:** the sidebar has exactly three groups. **Registry** is the project workspace - Home (personalized landing), **Resources** (`/resources`, the unified read plane over every resource type: one table across agents, MCPs, skills, hooks, prompts, and sandboxes served by `GET /api/v1/resources`, with type chips, search, and a "Mine" toggle; rows navigate to the per-type detail pages), and Intelligence (`/intelligence`, the project-scoped decision workspace). There is no standalone `/changes` page - change management is part of each resource's lifecycle: the resource workspace's Changes tab lists open and decided changes, and `?view=review` is the in-context review surface (diff-first, with review actions for reviewers and resolvable review issues anchored to the change; the server authorizes per capability). Reviewers are driven by Inbox notifications, whose links deep-link to the resource's review view; contributors find their drafts/pending/rejected work through `/resources` (`mine`+`wip` filters) and manage each submission on its own resource page - `OwnerSubmissionActions` in the detail header covers edit draft, edit pending submission (edit lock), submit, and resubmit, reusing `SubmitComponentDialog`. There are no standalone `/agents` or `/components` list pages - both resource families are browsed through Resources (`?type=` filters the table); soft-deleted agents restore from a contextual section there. Per-type detail pages remain the home of type-specific management. **Your work** holds strictly personal surfaces - My Traces. **Administration** is admin-gated operations only - Audit Log and Security Events; the `_admin` route layout enforces `minRole="admin"`. Do not put mixed-audience items in Administration, and do not reintroduce a "Workspace" grab-bag group or a "My component submissions" strip on `/resources`.

**Intelligence architecture:** `/intelligence` is a project-scoped workspace with three modes in one page header: Summary, Resources, and History. The time range persists across modes; resource scope is contextual and URL-backed. Summary reads the canonical `/intelligence/briefing` payload and expands signal evidence in place; Resources uses the paginated `/intelligence/resources` contract plus contextual resource/version comparisons; History combines material metric shifts with releases and review issues. Do not reintroduce a second navigation rail, saved-view dashboard controls, metric-category pages, a standalone investigation route, a Rankings destination, or instance analytics inside this workspace.

**Builder is contextual, not a destination:** creating an agent lives at `/agents/new` (`?draft=` resumes) and editing lives at the agent's own URL, `/agents/$namespace/$slug/edit` (the `$namespace.$slug.tsx` route is a layout with `index`/`edit` children). Authoring flows into review: builder submissions navigate to the agent's in-context review view (`/agents/$id?view=review`), and the agent detail header offers "Open in Builder" (owners) and "View change" (pending, switches to the review view). There is no standalone `/agents/builder` route - do not reintroduce one.

The product ships two composed themes: dark (default) and light. Tokens are defined in `app.css` and switched by `ThemeProvider` in `src/lib/theme.tsx`. Unsupported legacy theme values stored by older builds migrate to dark.

## Route groups

TanStack Router file routes live in `src/routes/`. Several routes lazy-load page modules from `src/pages/` while the migration from page components to route files continues.

**URL tenancy contract:** project-facing routes are always addressed as `{org}.{host}/{project}/...`. `src/main.tsx` derives the project segment and installs it as the router basepath; `ProjectGate` refuses to render project routes until that URL project is found in the host organization. Cached project state is only a deterministic redirect preference and never the active scope. Organization administration (`/organization`), account settings (`/settings`), onboarding, and the operator console are unprefixed root routes; use plain absolute anchors when leaving project context so TanStack does not prepend the project basepath. API requests take the organization from the host (single-host deployments use the validated selected org) and the project only from the URL. Never restore a project from local storage into request headers.

```
src/routes/
├── (auth)/                         # Unauthenticated
│   ├── login.tsx                   #   Login and first-run admin init
│   ├── register.tsx                #   User registration
│   └── device.tsx                  #   Device authorization
├── _authed.tsx                     # Authenticated layout and guard
├── _authed/
│   ├── index.tsx                   #   Registry home
│   ├── agents/                     #   Contextual agent surfaces (no list page)
│   │   ├── new.tsx                 #   Builder (create; ?draft= resumes)
│   │   ├── $agentId.tsx            #   Agent detail (legacy UUID URL)
│   │   ├── $namespace.$slug.tsx    #   Canonical detail layout (+ index/edit)
│   │   └── $agentId/insights/$reportId.tsx
│   ├── components/                 #   Contextual component surfaces (no list page)
│   │   ├── $componentId.tsx        #   Component detail (legacy UUID URL)
│   │   └── $type.$namespace.$slug.tsx  # Canonical component detail
│   ├── intelligence.tsx            #   Project Intelligence layout + shared search context
│   ├── intelligence/               #   Summary, Resources, History
│   ├── review.tsx                  #   Submission review queue (server-authorized)
│   ├── insights/$reportId.tsx      #   Insight report detail
│   ├── settings.tsx                #   Settings layout: scope-grouped nav + outlet
│   ├── settings/                   #   One route per settings section
│   │   ├── index.tsx               #     Directory + settings search
│   │   ├── profile.tsx             #     Account: identity, username
│   │   ├── security.tsx            #     Account: password, passkeys, sessions, API keys
│   │   ├── preferences.tsx         #     Account: theme
│   │   ├── members.tsx             #     Organization: user administration (admin)
│   │   ├── sso.tsx                 #     Organization: OIDC/SAML providers (admin)
│   │   ├── instance.tsx            #     Instance: status + branding (super_admin)
│   │   ├── telemetry.tsx           #     Instance: trace privacy, retention, migration, purge
│   │   ├── insights.tsx            #     Instance: insights LLM provider
│   │   └── advanced.tsx            #     Instance: server config catalog + danger zone
│   ├── _admin.tsx                  #   Admin layout and guard (minRole admin)
│   ├── _admin/
│   │   ├── audit-log.tsx
│   │   ├── security-events.tsx
│   │   └── diagnostics.tsx
│   ├── _user.tsx                   #   User layout
│   └── _user/
│       ├── inbox.tsx
│       └── traces/
│           ├── index.tsx
│           └── $traceId.tsx
└── __root.tsx                      # Query client, theme provider, error boundary
```

Only current routes exist - no legacy redirect stubs. Unmatched paths (including removed legacy routes like `/dashboard` or bare `/projects`) redirect to Home via `defaultNotFoundComponent` in `src/main.tsx`; item detail pages render their own in-place not-found states.

### Settings architecture

All configuration lives under `/settings`, split by scope: **Account** (profile, security, preferences - current user), **Organization** (members, projects, SSO - everyone on the instance), and **Instance** (general, telemetry & data, insights, advanced - deployment-wide, super_admin). `src/lib/settings-index.ts` is the single source of truth for sections, scopes, descriptions, and search keywords; the settings side nav, the `/settings` directory, the inline settings search, and the ⌘K command menu all render from it. Add a section there first, then create the route/page pair. Page scaffolding (scope badge, anchored sections, rows) comes from `src/components/settings/settings-shell.tsx`; settings search deep-links to section anchors via URL hash.

## Key directories

```
src/components/
├── builder/       # model-picker, preview-panel, sortable-component-list, validation-panel
├── dashboard/     # Stat cards, trend charts, bar lists, heatmap, time range select
├── layouts/       # AuthGuard, AdminGuard, RoleGuard, DashboardShell, PageHeader
├── nav/           # RegistrySidebar, CommandMenu, NavUser, GitHubStarBanner
├── registry/      # AgentCard, ComponentCard, ComponentEditForm, PullCommand,
│                  # StatusBadge, SubmitComponentDialog, HarnessBadges
├── resource-workspace/ # Repository-style resource detail primitives shared by the agent and
│                  # component pages: WorkspaceTabBar (?view= deep links), VersionsPanel
│                  # (compare + controlled restore), ChangesPanel, ChangeReviewPanel
│                  # (in-context review at ?view=review), ActivityPanel,
│                  # ContributorsPanel
├── review/        # ChangeReviewBody (diff-first change surface), ReviewIssuesPanel, ReviewDetailSheet, ValidationBadges
├── settings/      # SettingsShell (nav, page, sections), SettingsSearch, RestartStatusControl
├── shared/        # SkeletonLayouts, ErrorState, EmptyState
├── traces/        # TraceList, TraceDetail, SpanTree
└── ui/            # shadcn/ui primitives

src/pages/         # Lazy-loaded page components used by route files
src/routes/        # TanStack Router file routes
src/hooks/         # TanStack Query hooks and auth guards
src/lib/           # API wrapper, types, query client, theme, GraphQL WS
```

## Key files

- `src/lib/api.ts`: typed fetch wrapper and current auth storage helpers
- `src/lib/types.ts`: shared TypeScript interfaces for API responses
- `src/lib/graphql-ws.ts`: GraphQL WebSocket subscription client
- `src/lib/harness-capabilities.ts`: harness capability detection
- `src/lib/query-client.ts`: TanStack Query client config
- `src/lib/theme.tsx`: theme provider and storage
- `src/hooks/use-api.ts`: TanStack Query hook exports for endpoints
- `src/hooks/use-auth.ts`: auth guard and optional auth helper
- `src/hooks/use-deployment-config.ts`: feature flags and license status
- `src/hooks/use-harnesses.ts`: harness list from server
- `vite.config.ts`: Vite build, chunks, and dev proxy
- `mock/`: dev-only mock API fixtures and Vite middleware (see below)

## Coding patterns

**Data fetching:** Always use hooks from `use-api.ts`. Never call `fetch` directly in components unless the endpoint is not covered yet and the smallest change is local. Prefer adding a hook for reusable endpoints.

**Types:** API response types live in `src/lib/types.ts`. Do not define inline types for API data that is shared by multiple components. If a new endpoint is added, add its types there.

**Access control:** Feature access is role-based and enforced server-side. The frontend may use deployment config for display decisions, but never trusts the client to enforce access.

**Harness list:** Fetched from `/api/v1/config/harnesses` via `useHarnesses()`. Never hardcode harness names or capabilities in the frontend. The server is the single source of truth.

**Auth state:** Browser auth is context-separated. Tenant/app auth uses `caracal_tenant_access_token` plus `caracal_tenant_context_active`; deployment operator auth uses `caracal_operator_access_token` plus `caracal_operator_context_active`. Cached profile fields are also context-prefixed. `/login` may activate only the tenant context and `/operator-login` may activate only the operator context; clearing tenant state must also clear org/project context. Do not use the legacy generic `caracal_access_token` or `/api/auth/token` in web code.

**Theming:** Use semantic tokens such as `var(--primary)` and `var(--destructive)`. Never use raw color values in components. Theme tokens live in `app.css`.

## Commands

```bash
pnpm dev          # Vite dev server on :8000 (proxies /api/v1 to localhost:8080)
pnpm dev:mock     # Vite dev server with the mock API - no backend needed
pnpm build        # Typecheck and production build
pnpm lint         # ESLint
pnpm typecheck    # TypeScript only
pnpm e2e          # Playwright, requires running Docker stack
pnpm e2e:kiro     # Kiro-specific e2e tests
pnpm e2e:ui       # Playwright UI mode
```

E2E specs live in `tests/e2e/*.spec.ts` in the repo root workspace.

## Mock API mode (backend-free development)

`pnpm dev:mock` (sets `VITE_MOCK_API=1`) enables a Vite dev middleware that answers `/api/v1/*` from static fixtures instead of proxying to the backend. App code is untouched: components and hooks keep calling the exact same endpoints, so nothing changes when reconnecting to the real server - just run plain `pnpm dev`.

This is an intentionally isolated test harness, not product data: fixtures are fabricated, live only under `mock/`, require the explicit opt-in command, and can never ship (`apply: "serve"`). Mock mode is self-announcing - every response carries an `X-Caracal-Mock: 1` header and the page shows a fixed "MOCK DATA" badge. Plain `pnpm dev` and production installs start completely empty; the customer provides the data.

- `mock/plugin.ts`: the middleware (dev-only, `apply: "serve"`, gated on the env var; never in the production bundle)
- `mock/handlers.ts`: the route table (`METHOD /path/:param` → fixture)
- `mock/data.ts`: fixtures, typechecked against `src/lib/types` so contract drift fails `tsc`

Behavior in mock mode: any login credentials succeed (admin user), the harness list is derived from `packages/harness-data/registry.json`, and an unmocked endpoint returns 404 with the exact path logged in the Vite terminal - add a route in `mock/handlers.ts` when you hit one. GraphQL WS subscriptions are not mocked; the client retries 5× and gives up (live-session updates simply stay off). `MOCK_API_DELAY` (ms, default 120) simulates latency for loading states.

Do not import from `mock/` in `src/` - the mock layer must stay a dev-server concern.
