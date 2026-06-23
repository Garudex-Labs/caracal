# Caracal Web

React single-page application for [Caracal](https://github.com/Garudex-Labs/caracal). It serves the marketing and enterprise surface today and is the foundation for the browser-based Console that replaces the terminal Console.

## Stack

- React 19 + TypeScript
- Vite (client-only SPA build)
- TanStack Router (file-based routing) + TanStack Query
- Tailwind CSS 4

## Getting Started

Install dependencies once from the repository root, then start the dev server.

```bash
# From the repository root
pnpm install
pnpm --dir apps/web dev

# Or from this directory (apps/web)
pnpm install
pnpm dev
```

The dev server runs on http://localhost:3001.

## Scripts

Run these from `apps/web`. From the repository root, prefix with `--dir apps/web`
(for example, `pnpm --dir apps/web dev`).

| Command | Description |
| --- | --- |
| `pnpm dev` | Start the local dev server. |
| `pnpm build` | Production build to `dist/`. |
| `pnpm preview` | Preview the production build. |
| `pnpm lint` | Run ESLint. |
| `pnpm typecheck` | Type-check with `tsc --noEmit`. |
| `pnpm format` | Format with Prettier. |

## Structure

```
apps/web/
  index.html            Document shell and pre-paint theme bootstrap
  public/               Static assets
  src/
    main.tsx            SPA mount point
    router.tsx          Type-safe router factory
    routes/             File-based routes
    components/         Shared layout and UI
    styles/globals.css  Tailwind theme and global styles
```
