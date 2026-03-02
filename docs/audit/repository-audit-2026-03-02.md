# Repository Audit - March 2, 2026 (Personal Project + Tailscale Lens)

## Lens And Assumptions

This version is tuned for your stated operating model:

- Personal/internal project, not a shipped product.
- Primary user is you.
- Network exposure, if any, is via your own Tailscale account.
- Main goal is reliability and iteration speed, not enterprise hardening.

Under this lens, the right question is:
- “What breaks my daily flow?”
- “What can corrupt local state or waste debugging time?”
- “Which guardrails are cheap and prevent self-inflicted pain?”

## Baseline Command Results

- `pnpm build` -> passed
- `pnpm test` -> failed
  - Backend: `16 passed files`, `155 passed tests`
  - UI: `3 failed files`, `9 failed tests`, `3` unhandled errors
- `pnpm exec tsc --noEmit` -> failed at repo root (`Command "tsc" not found`)
- `pnpm --filter @middleman/backend exec tsc -p tsconfig.build.json --noEmit` -> passed
- `pnpm --filter @middleman/ui exec tsc --noEmit` -> passed
- `pnpm --filter @middleman/site exec tsc --noEmit` -> passed

## What Improved Since February 27

1. CI package filter mismatch was fixed and backend tests are no longer soft-fail.
- Evidence: `.github/workflows/ci.yml:35`, `.github/workflows/ci.yml:38`, `.github/workflows/ci.yml:40`

2. Backend tests are now healthy.
- Current backend state: `155/155` passing.

3. Protocol drift risk was reduced.
- Backend/UI now share `@middleman/protocol` contracts.
- Evidence: `packages/protocol/src/index.ts:1`, `apps/backend/src/ws/ws-command-parser.ts:1`, `apps/ui/src/lib/ws-client.ts:19`

4. Maintainability improved via decomposition.
- WS server routing and frontend route/hooks were split into more focused modules.

5. Endpoint resolution duplication was reduced.
- Shared helper: `apps/ui/src/lib/api-endpoint.ts:1`

## Re-Prioritized Findings For Your Setup

### Priority A - Fix Now (Direct Personal Productivity Impact)

1. Root typecheck instruction is broken.
- `AGENTS.md` asks for `pnpm exec tsc --noEmit`, but root has no `tsc` wiring.
- Impact: repetitive contributor friction and confusing red command.
- Evidence: `AGENTS.md:100`, `package.json:13`, `package.json:33`

2. UI tests are red and currently non-blocking in CI.
- Backend is green, UI has failing tests + unhandled errors.
- Impact: regressions in your main interface can slip through unnoticed.
- Evidence: `.github/workflows/ci.yml:40`, `apps/ui/src/components/chat/MarkdownMessage.test.ts:27`, `apps/ui/src/components/chat/AgentSidebar.test.ts:132`, `apps/ui/src/routes/-index.test.ts:154`

3. Worker spawn can leave orphaned persisted descriptors if runtime creation fails.
- Impact: stale local state, hard-to-debug behavior during dev.
- Evidence: `apps/backend/src/swarm/swarm-manager.ts:383`, `apps/backend/src/swarm/swarm-manager.ts:384`, `apps/backend/src/swarm/swarm-manager.ts:402`

4. Direct WS attachment path lacks hard size caps.
- Impact: accidental local memory/disk blowups from big attachments.
- Evidence: `apps/backend/src/ws/ws-command-parser.ts:196`, `apps/backend/src/ws/attachment-parser.ts:31`, `apps/backend/src/ws/attachment-parser.ts:166`

### Priority B - Useful Cheap Guardrails (Still Worth Doing)

5. `/api/read-file` allows broad local reads (`homedir` + `/tmp`).
- In a personal setup this may be acceptable, but it is still a high-footgun endpoint.
- Cheap mitigation: limit to repo/data dirs unless explicitly needed.
- Evidence: `apps/backend/src/ws/routes/file-routes.ts:79`, `apps/backend/src/ws/routes/file-routes.ts:82`, `apps/backend/src/ws/routes/file-routes.ts:83`

6. CWD allowlist policy is configured but not enforced in validation/listing.
- Cheap mitigation: actually enforce allowlist in directory validation/listing paths.
- Evidence: `apps/backend/src/swarm/cwd-policy.ts:75`, `apps/backend/src/swarm/cwd-policy.ts:97`, `apps/backend/src/swarm/cwd-policy.ts:133`

7. Optional lightweight control-plane auth.
- For “my devices only” this is optional, but a single token gate is cheap defense if tailnet scope ever widens.
- Evidence: `apps/backend/src/ws/server.ts:118`, `apps/backend/src/ws/ws-handler.ts:33`

### Priority C - Defer For Now (Low ROI For Your Current Use)

8. Strict CORS/origin hardening.
- Keep in backlog unless you start exposing beyond your own trusted devices.
- Evidence: `apps/backend/src/ws/http-utils.ts:95`, `apps/backend/src/ws/http-utils.ts:98`

9. Codex runtime restrictions (`danger-full-access`, `approvalPolicy: "never"`).
- For personal high-velocity use, this can remain intentional.
- Revisit only if trust boundary changes.
- Evidence: `apps/backend/src/swarm/codex-agent-runtime.ts:37`, `apps/backend/src/swarm/codex-agent-runtime.ts:361`, `apps/backend/src/swarm/codex-agent-runtime.ts:383`

10. Slack ACK ordering and startup atomicity edge cases.
- Real reliability concerns, but lower personal ROI unless integration usage scales.
- Evidence: `apps/backend/src/integrations/slack/slack-socket.ts:106`, `apps/backend/src/scheduler/cron-scheduler-service.ts:62`, `apps/backend/src/integrations/registry.ts:58`

11. Production hardening (`vite preview` usage and daemon restart behavior).
- Defer unless you run unattended long-lived instances.
- Evidence: `package.json:20`, `apps/ui/package.json:8`, `scripts/prod-daemon.mjs:195`, `scripts/prod-daemon.mjs:211`

## What Changed vs Previous Audit (Gap Status)

Filled:
- CI filter mismatch and backend soft-fail issue.
- Backend suite stability.
- Shared protocol adoption.
- Large-file decomposition and endpoint helper consolidation.

Partially filled:
- Overall test confidence (backend fixed, UI still unstable).
- Attachment hardening (Slack bounded; direct WS still unbounded).

Still open (but re-ranked for personal use):
- Root typecheck mismatch, UI test reliability, spawn rollback, WS attachment caps.
- Optional guardrails: read-file scope, CWD allowlist enforcement, simple token auth.

## Practical Next Steps (Personal Project Friendly)

1. Remove friction:
- Fix root typecheck command/documentation mismatch.
- Either stabilize UI tests and add to CI, or clearly quarantine flaky tests.

2. Prevent local footguns:
- Add WS attachment size cap.
- Add spawn rollback when runtime creation fails.
- Narrow `/api/read-file` roots to what you actually use.

3. Add one optional trust-boundary control:
- If you plan to use from multiple tailnet devices/users, add a simple shared-token check for HTTP/WS control paths.
