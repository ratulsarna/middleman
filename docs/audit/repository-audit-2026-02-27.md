# Repository Audit - February 27, 2026

## Scope

This audit covers backend, frontend, tests, CI, and operational scripts for the current clone of `middleman`.

## Baseline Command Results

- `pnpm test` -> failed (backend tests failed first)
- `pnpm --filter @middleman/ui test` -> failed (`9` failed tests, `3` unhandled errors)
- `pnpm build` -> passed
- `pnpm exec tsc --noEmit` -> failed at repo root (`Command "tsc" not found`)
- `pnpm --filter @middleman/backend exec tsc -p tsconfig.build.json --noEmit` -> passed
- `pnpm --filter @middleman/ui exec tsc --noEmit` -> passed
- `pnpm --filter @middleman/site exec tsc --noEmit` -> passed

## Findings (Deal-Breakers First)

### Critical

1. CI is non-blocking and currently does not run intended checks.
- Workflow uses `@swarm/*` filters, but packages are `@middleman/*`, so CI steps no-op.
- Backend tests are marked `continue-on-error: true`.
- Evidence:
  - `.github/workflows/ci.yml:35`
  - `.github/workflows/ci.yml:38`
  - `.github/workflows/ci.yml:41`
  - `apps/backend/package.json:2`
  - `apps/ui/package.json:2`

2. Test suites are significantly broken.
- Backend: `61 failed / 91 passed`.
- UI: `9 failed / 36 passed`, plus `3` unhandled errors.
- Many backend failures cascade from assumptions that a manager exists immediately after `boot()`.
- Evidence:
  - `apps/backend/src/test/swarm-manager.test.ts:228`
  - `apps/backend/src/swarm/swarm-manager.ts:377`
  - `apps/backend/src/swarm/swarm-manager.ts:603`
  - `apps/ui/src/routes/-index.test.ts:149`
  - `apps/ui/src/routes/index.tsx:339`

3. Backend control plane is unauthenticated.
- Privileged HTTP and WebSocket operations are exposed without auth checks.
- Local early-project priority: important but not an immediate blocker for solo local work; add a lightweight local token before broader use.
- Evidence:
  - `apps/backend/src/ws/server.ts:190`
  - `apps/backend/src/ws/server.ts:274`
  - `apps/backend/src/ws/server.ts:1544`

4. CORS + WS origin handling allows browser-driven localhost abuse.
- CORS reflects arbitrary `Origin`.
- WebSocket connection path does not enforce origin/auth validation.
- Local early-project priority: not a day-1 blocker, but should be addressed soon because browser tabs can still reach localhost.
- Evidence:
  - `apps/backend/src/ws/server.ts:1383`
  - `apps/backend/src/ws/server.ts:1386`
  - `apps/backend/src/ws/server.ts:200`

5. Arbitrary local file read includes home directory and `/tmp`.
- `/api/read-file` allows reads under `homedir()` and `/tmp`, not only project roots.
- Combined with unauthenticated control plane and permissive CORS, this is direct local-data exposure.
- Why this likely exists: backend state and uploads live under `~/.middleman`, and the artifact panel reads files via `/api/read-file`.
- Local early-project action: restrict to `rootDir + cwdAllowlistRoots + dataDir` instead of full home-directory access.
- Evidence:
  - `apps/backend/src/ws/server.ts:420`
  - `apps/backend/src/ws/server.ts:474`
  - `apps/backend/src/ws/server.ts:477`
  - `apps/backend/src/ws/server.ts:506`
  - `apps/backend/src/config.ts:10`
  - `apps/ui/src/components/chat/ArtifactPanel.tsx:308`

### High

6. Codex runtime is configured for unrestricted execution and auto-approval.
- Uses `danger-full-access` and `approvalPolicy: "never"`.
- Command/file-change approval requests are auto-accepted.
- Local early-project stance: accepted by design for productivity.
- Required guardrail if kept: prioritize control-plane protections (#3 and #4) so only trusted local clients can trigger actions.
- Evidence:
  - `apps/backend/src/swarm/codex-agent-runtime.ts:27`
  - `apps/backend/src/swarm/codex-agent-runtime.ts:351`
  - `apps/backend/src/swarm/codex-agent-runtime.ts:691`
  - `apps/backend/src/swarm/codex-agent-runtime.ts:880`

7. CWD allowlist policy is not actually enforced.
- `allowlistRoots` exists but directory validation only checks path existence/type.
- Evidence:
  - `apps/backend/src/swarm/cwd-policy.ts:75`
  - `apps/backend/src/swarm/cwd-policy.ts:97`
  - `apps/backend/src/swarm/swarm-manager.ts:1770`

8. Attachment ingestion lacks practical limits.
- Base64 attachments are accepted and persisted without strict quota/size enforcement.
- Local early-project priority: defer as non-blocking for now; add basic caps later to prevent accidental disk/memory bloat.
- Evidence:
  - `apps/backend/src/ws/server.ts:2168`
  - `apps/backend/src/ws/server.ts:2824`
  - `apps/backend/src/ws/server.ts:2926`

9. Production runtime setup is fragile.
- `prod:start` serves UI with `vite preview`.
- Daemon does not automatically restart child after normal crash/exit unless explicitly restarted.
- Local early-project priority: defer until unattended/prod operation is needed.
- Evidence:
  - `package.json:19`
  - `apps/ui/package.json:9`
  - `scripts/prod-daemon.mjs:195`
  - `scripts/prod-daemon.mjs:211`

### Medium

10. Root typecheck instruction is broken.
- Contributor instruction says to run `pnpm exec tsc --noEmit`, but root does not provide `tsc`.
- Evidence:
  - `AGENTS.md:100`
  - `package.json:24`

11. Root test script hides UI test failures when backend fails.
- `pnpm test` uses `backend && ui`; UI tests are skipped if backend fails.
- Evidence:
  - `package.json:22`

12. Frontend WS client has reliability risks.
- Loading can stay stuck when send fails early.
- Pending request fallback can resolve the wrong request when `requestId` is absent/mismatched.
- Incoming events are cast without runtime validation.
- Evidence:
  - `apps/ui/src/routes/index.tsx:653`
  - `apps/ui/src/lib/ws-client.ts:176`
  - `apps/ui/src/lib/ws-client.ts:775`
  - `apps/ui/src/lib/ws-client.ts:485`

## Quality, Bug-Risk, and Maintainability Sweep

This was a separate deeper pass focused on correctness risk, maintainability, and test confidence.

### High-Impact Bug Risks

1. Worker spawn can leave orphaned persisted worker descriptors if runtime creation fails.
- `spawnAgent` persists descriptor before runtime creation and has no rollback.
- `createManager` already uses a rollback pattern, but `spawnAgent` does not.
- Evidence:
  - `apps/backend/src/swarm/swarm-manager.ts:452`
  - `apps/backend/src/swarm/swarm-manager.ts:453`
  - `apps/backend/src/swarm/swarm-manager.ts:471`
  - `apps/backend/src/swarm/swarm-manager.ts:647`

2. Async event entrypoints drop promise rejections in multiple runtime paths.
- `void`-dispatched async handlers can fail without centralized handling.
- Evidence:
  - `apps/backend/src/swarm/agent-runtime.ts:58`
  - `apps/backend/src/swarm/codex-jsonrpc-client.ts:77`
  - `apps/backend/src/swarm/codex-jsonrpc-client.ts:206`
  - `apps/backend/src/swarm/codex-jsonrpc-client.ts:212`

3. Slack socket flow acknowledges envelopes before handler processing, increasing drop risk on downstream failures.
- Evidence:
  - `apps/backend/src/integrations/slack/slack-socket.ts:106`
  - `apps/backend/src/integrations/slack/slack-socket.ts:111`
  - `apps/backend/src/integrations/slack/slack-socket.ts:20`

4. Startup flags can be set too early and get stuck on partial startup failure.
- Evidence:
  - `apps/backend/src/scheduler/cron-scheduler-service.ts:62`
  - `apps/backend/src/integrations/registry.ts:57`
  - `apps/backend/src/integrations/telegram/telegram-polling.ts:46`

5. UI can enter stuck “loading” state when send fails early.
- Evidence:
  - `apps/ui/src/routes/index.tsx:653`
  - `apps/ui/src/routes/index.tsx:561`
  - `apps/ui/src/lib/ws-client.ts:176`
  - `apps/ui/src/lib/ws-client.ts:187`

6. Slack settings type guard is shallow and can accept malformed nested payloads.
- Evidence:
  - `apps/ui/src/components/settings/settings-api.ts:122`
  - `apps/ui/src/components/settings/SettingsIntegrations.tsx:63`

### Maintainability and Architecture Risks

1. Oversized multi-responsibility core files increase regression blast radius.
- Evidence:
  - `apps/backend/src/swarm/swarm-manager.ts` (~4099 LOC)
  - `apps/backend/src/ws/server.ts` (~3054 LOC)
  - `apps/ui/src/routes/index.tsx` (~1243 LOC)
  - `apps/ui/src/lib/ws-client.ts` (~1041 LOC)

2. Backend/UI wire contracts are duplicated and already drifting.
- Example: `create_manager.model` optional in backend but required in UI.
- Evidence:
  - `apps/backend/src/protocol/ws-types.ts:33`
  - `apps/ui/src/lib/ws-types.ts:89`

3. API endpoint resolution logic is duplicated in multiple UI modules.
- Evidence:
  - `apps/ui/src/components/settings/settings-api.ts:52`
  - `apps/ui/src/components/chat/MessageInput.tsx:68`
  - `apps/ui/src/components/chat/ArtifactsSidebar.tsx:116`
  - `apps/ui/src/routes/index.tsx:1227`

### Test Coverage and Confidence Risks

1. Test suites are red in core areas, so current regression signal is weak.
- Backend: `61 failed / 152`.
- UI: `9 failed / 45` with `3` unhandled errors.

2. UI tests include hard isolation and stale assertion failures.
- Router context mismatch:
  - `apps/ui/src/routes/-index.test.ts:150`
  - `apps/ui/src/routes/index.tsx:339`
- Duplicate sidebar render in test environment:
  - `apps/ui/src/components/chat/AgentSidebar.tsx:510`
  - `apps/ui/src/components/chat/AgentSidebar.tsx:537`
  - `apps/ui/src/components/chat/AgentSidebar.test.ts:189`
- Brittle markup assertion:
  - `apps/ui/src/components/chat/MarkdownMessage.test.ts:27`

3. Coverage governance is missing.
- No coverage thresholds or reporting configured in Vitest.
- Evidence:
  - `apps/backend/vitest.config.ts`
  - `apps/ui/vitest.config.ts`
  - `apps/backend/package.json:10`
  - `apps/ui/package.json:10`

4. High-risk areas (integrations + large UI interaction surfaces) are under-tested by behavior.
- Example files:
  - `apps/backend/src/integrations/slack/slack-router.ts`
  - `apps/backend/src/integrations/slack/slack-integration.ts`
  - `apps/backend/src/integrations/telegram/telegram-integration.ts`
  - `apps/ui/src/components/chat/MessageList.tsx`
  - `apps/ui/src/components/settings/SettingsIntegrations.tsx`

## Recommended Triage Order

1. Fix CI to run real package checks and fail on test/typecheck errors.
2. Stabilize and re-baseline tests (backend manager boot assumptions, UI router-context tests).
3. Add lightweight local token auth and strict origin policy for HTTP/WS control surfaces.
4. Lock down `/api/read-file` roots to `rootDir + cwdAllowlistRoots + dataDir`.
5. Enforce CWD allowlist checks in directory validation.
6. Defer attachment quota hardening to later local-dev phase; add basic caps before broader use.
7. Defer production runtime hardening (`vite preview` replacement and robust supervision) until deployment/unattended operation.
