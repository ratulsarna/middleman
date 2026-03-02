---
name: manager integration dogfood
overview: Enable manager/workers to add new Slack/Telegram-like integrations via guided codegen and backend restart, without building any new UI. Reduce future provider churn by refactoring hardcoded integration wiring into a manifest-driven backend path.
todos:
  - id: add-integration-builder-workflow
    content: Add manager/worker archetype guidance for integration-builder delegation and execution runbook
    status: pending
  - id: refactor-provider-registration
    content: Introduce provider manifest and refactor backend integration registry/routes/ws handling to be provider-driven
    status: pending
  - id: generalize-channel-contracts
    content: Generalize channel/source typing and normalization so non-slack/telegram providers are preserved end-to-end
    status: pending
  - id: build-scaffold-cli
    content: Implement integration scaffold CLI and package script for repeatable worker-driven codegen
    status: pending
  - id: update-tests-and-gates
    content: Expand backend tests for provider-matrix behavior and add scaffold command validation checks
    status: pending
isProject: false
---

# Manager-Worker Integration Dogfooding Plan

## Outcome

- Managers can reliably fulfill: "add integration X" by delegating to workers in chat.
- No new UI work; flow is chat-driven + codegen + restart.
- Adding a new provider no longer requires hand-editing many hardcoded files.

## Target Flow (V1)

```mermaid
flowchart LR
  userRequest[UserRequestsNewIntegration] --> managerAgent[ManagerAgent]
  managerAgent --> spawnWorker[SpawnIntegrationBuilderWorker]
  spawnWorker --> runScaffold[RunScaffoldCLI]
  runScaffold --> implementProvider[ImplementProviderSpecificClientAndRouter]
  implementProvider --> runChecks[TypecheckAndBackendTests]
  runChecks --> restartBackend[RestartBackendProcess]
  restartBackend --> reportResult[ManagerReportsStatusToUser]
```



## Phase 1: Manager/Worker Workflow Primitives

- Add a dedicated worker archetype prompt at [.swarm/archetypes/integration-builder.md](.swarm/archetypes/integration-builder.md) with a strict runbook for provider implementation, validation, and restart steps.
- Update manager orchestration guidance in [apps/backend/src/swarm/archetypes/builtins/manager.md](apps/backend/src/swarm/archetypes/builtins/manager.md) to prefer spawning `integration-builder` workers for integration-extension requests.
- Optional ergonomics: map `integration-builder*` worker IDs to archetype automatically in [apps/backend/src/swarm/swarm-manager.ts](apps/backend/src/swarm/swarm-manager.ts) (same pattern used for `merger`).

## Phase 2: Remove Hardcoded Provider Bottlenecks (Backend/Protocol Only)

- Introduce a provider manifest (new file: [apps/backend/src/integrations/provider-manifest.ts](apps/backend/src/integrations/provider-manifest.ts)) as the single registry for provider ids/capabilities/status event mapping.
- Refactor hardcoded Slack/Telegram branching to manifest-driven dispatch in:
  - [apps/backend/src/integrations/registry.ts](apps/backend/src/integrations/registry.ts)
  - [apps/backend/src/ws/routes/integration-routes.ts](apps/backend/src/ws/routes/integration-routes.ts)
  - [apps/backend/src/ws/server.ts](apps/backend/src/ws/server.ts)
  - [apps/backend/src/ws/ws-handler.ts](apps/backend/src/ws/ws-handler.ts)
- Generalize channel handling so new providers do not collapse to `web`:
  - [apps/backend/src/swarm/types.ts](apps/backend/src/swarm/types.ts)
  - [apps/backend/src/swarm/conversation-validators.ts](apps/backend/src/swarm/conversation-validators.ts)
  - [apps/backend/src/swarm/swarm-manager.ts](apps/backend/src/swarm/swarm-manager.ts)
  - [apps/backend/src/swarm/swarm-tools.ts](apps/backend/src/swarm/swarm-tools.ts)
  - [packages/protocol/src/shared-types.ts](packages/protocol/src/shared-types.ts)
- Backward compatibility: keep existing Slack/Telegram endpoints and status events working while enabling additional provider ids.

## Phase 3: Add Scaffold CLI for Worker Automation

- Add a deterministic scaffold command (new file: [scripts/integration-scaffold.mjs](scripts/integration-scaffold.mjs)) that workers run from chat-driven tasks.
- Script responsibilities:
  - create provider skeleton under `apps/backend/src/integrations/<provider>/` (config/types/status/client/router/delivery/integration service stubs),
  - append provider entry to [apps/backend/src/integrations/provider-manifest.ts](apps/backend/src/integrations/provider-manifest.ts),
  - validate naming/capabilities and support `--dry-run` + idempotent reruns,
  - print required follow-up commands (`typecheck`, backend tests, restart command).
- Add script shortcut in [package.json](package.json) so workers can run a stable command from memory.

## Phase 4: Verification + Safety for Dogfooding

- Update regression coverage for manifest-driven provider handling:
  - [apps/backend/src/test/integration-registry.test.ts](apps/backend/src/test/integration-registry.test.ts)
  - [apps/backend/src/test/ws-server-p0-endpoints.test.ts](apps/backend/src/test/ws-server-p0-endpoints.test.ts)
  - [apps/backend/src/test/swarm-manager.test.ts](apps/backend/src/test/swarm-manager.test.ts)
  - [apps/backend/src/test/swarm-tools.test.ts](apps/backend/src/test/swarm-tools.test.ts)
- Add scaffold-focused tests (dry-run/idempotency/name validation) in backend test suite.
- Standard completion gate for workers after scaffold/implementation:
  - `pnpm --filter @nexus/backend test`
  - `pnpm exec tsc --noEmit`
- Restart policy in runbook: worker executes restart command in-session and reports success/failure immediately.

## Definition of Done

- A manager can be told in chat: "add provider X", delegate to workers, and complete the end-to-end change using the scaffold flow.
- New provider onboarding is manifest + provider folder work, not cross-repo manual surgery.
- Existing Slack/Telegram behavior remains intact.
- No new UI components or settings screens added.

