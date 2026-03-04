# @nexus/ui

`@nexus/ui` is the Nexus web app built with TanStack Start, Vite, and React.

## What it contains

- Dashboard and agent sidebar
- Chat thread UI with streaming updates
- Composer with file attachments and voice transcription hooks
- Settings surfaces (general, auth, integrations)

## Scripts

Run from repo root:

```bash
pnpm --filter @nexus/ui dev
pnpm --filter @nexus/ui build
pnpm --filter @nexus/ui preview
pnpm --filter @nexus/ui test
```

## Local runtime

- UI dev server default: `http://127.0.0.1:47188`
- Backend WS target default: `ws://127.0.0.1:47187`

For full-stack local development, use `pnpm dev` from the repo root to run backend and UI together.
