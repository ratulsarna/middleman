# Claude/Codex Manager Controls Plan (Historical)

> **Historical document**: The Pi runtime and `pi-codex`/`pi-opus` presets referenced below have been removed. Only `codex-app` and `claude-agent-sdk` runtimes remain.

Date: 2026-03-02

## Goal

Figure out a clean path for:

1. Loading `CLAUDE.md` for manager project cwd (Claude SDK runtime).
2. Changing system prompt behavior for `claude-agent-sdk`.
3. Changing Codex app instructions (via `developerInstructions`).
4. Making manager model selection configurable for all presets/providers (config first, UI later).
5. Making reasoning/thinking level configurable and actually applied for all providers.

## Current State (confirmed in code)

- Claude SDK call is in `apps/backend/src/swarm/claude-agent-sdk-runtime.ts` and currently sends:
  - `cwd`, `model`, `systemPrompt`, etc.
  - no `settingSources`.
- Runtime factory sets `CLAUDE_CONFIG_DIR` to `~/.nexus/claude-code`:
  - `apps/backend/src/swarm/runtime-factory.ts`.
- Codex app runtime sends:
  - `developerInstructions: this.systemPrompt` in `thread/start` and `thread/resume`.
  - no `model` in `thread/start`, `thread/resume`, or `turn/start`.
  - file: `apps/backend/src/swarm/codex-agent-runtime.ts`.
- Model presets are fixed and hardcoded:
  - `apps/backend/src/swarm/model-presets.ts`
  - `packages/protocol/src/shared-types.ts`.
- `thinkingLevel` exists in descriptors but runtime behavior differs:
  - `pi-*`: applied (`createAgentSession(... thinkingLevel ...)`).
  - `claude-agent-sdk`: currently ignored.
  - `codex-app`: currently ignored.
- UI create-manager model list hides `codex-app`:
  - `apps/ui/src/components/chat/CreateManagerDialog.tsx`.

## External SDK/Protocol Facts (verified)

- Claude Agent SDK:
  - `settingSources` must include `"project"` to load `CLAUDE.md`.
  - when omitted/empty, filesystem settings are not loaded.
  - source: Claude SDK types/docs.
- Codex app-server protocol:
  - `ThreadStartParams` and `ThreadResumeParams` support `developerInstructions`, `model`, `modelProvider`.
  - `TurnStartParams` supports `model` and `effort`.
  - `ReasoningEffort` enum is: `none | minimal | low | medium | high | xhigh`.
  - `model/list` response includes `supportedReasoningEfforts` and `defaultReasoningEffort`.
  - also has `model/list`.
  - source: `openai/codex` app-server protocol schema.
- Claude Agent SDK query options support:
  - `thinking` (`adaptive | enabled | disabled`)
  - `effort` (`low | medium | high | max`)
  - `maxThinkingTokens` (deprecated, still accepted)

## Plan By Item

### 1) Make `CLAUDE.md` load for manager project cwd

#### Minimal change

In `apps/backend/src/swarm/claude-agent-sdk-runtime.ts` query options, add:

- `settingSources: ["project"]`

This is enough to load project `CLAUDE.md` relative to manager `cwd`.

#### Better configurable change

Add config for setting sources:

- `SwarmConfig.claude.settingSources: SettingSource[]`
- default to `["project"]`.
- optional richer default later: `["user", "project", "local"]`.

Then use that config in `claude-agent-sdk-runtime.ts`.

#### Important nuance

Because we set `CLAUDE_CONFIG_DIR` to `~/.nexus/claude-code`, user-scoped Claude settings/styles are read from that config dir, not `~/.claude`, unless changed.

### 2) Change system prompt for `claude-agent-sdk`

#### What already works today

- The string passed into `RuntimeFactory.createRuntimeForDescriptor(...)` becomes Claude SDK `systemPrompt`.
- For managers, base prompt comes from archetype registry (`manager` archetype).
- For workers, you can already override with `spawn_agent.systemPrompt`.

So there are already 2 levers:

- global manager behavior: `.swarm/archetypes/manager.md`
- per worker behavior: `spawn_agent.systemPrompt`

#### Gap

- No per-manager custom prompt persisted in descriptor.
- No websocket/API command to update manager prompt after creation.

#### Recommended backend addition

- Add optional `systemPrompt` to `create_manager`.
- Persist in descriptor as something like `promptOverride?: string`.
- Resolve prompt with precedence:
  1. `descriptor.promptOverride` (if set)
  2. archetype/default logic (existing)
- Add optional update command later (`update_manager`) to change prompt and restart manager runtime cleanly.

### 3) Codex app instructions (`developerInstructions`)

#### What already works today

- Codex runtime already maps `this.systemPrompt` to `developerInstructions` at:
  - `thread/start`
  - `thread/resume`

So if we add manager-level prompt override from item 2, Codex inherits it automatically.

#### Recommended improvements

- Keep passing `developerInstructions` as now.
- If a manager prompt is changed after thread exists, restart/reset the manager runtime so the resumed thread gets new `developerInstructions`.

### 4) Change models for managers for all providers; surface to users

#### Current limitation

- Preset names are fixed (fine), but preset-to-descriptor mapping is hardcoded in backend and mirrored in UI inference logic.
- If model IDs change, normalization/inference logic can break unless updated in multiple places.

#### Config-first design (backend)

Add model preset config to `SwarmConfig`, for example:

- `modelPresets["pi-codex"]`
- `modelPresets["pi-opus"]`
- `modelPresets["codex-app"]`
- `modelPresets["claude-agent-sdk"]`

Each includes:

- `provider`
- `modelId`
- `thinkingLevel`

Then:

- Replace hardcoded descriptor map in `model-presets.ts` with config-backed map.
- Update infer/normalize to compare against configured descriptors (plus explicit legacy aliases where needed).
- Keep websocket command shape as preset enum (`create_manager.model` stays stable).

#### Include reasoning config with model config

Keep one canonical reasoning field in descriptors/config:

- `thinkingLevel`: `off | minimal | low | medium | high | xhigh`

Then apply provider-specific mapping at runtime:

- `pi-*` runtime:
  - use `thinkingLevel` directly (already implemented).
- `codex-app` runtime:
  - map to app-server `turn/start.effort`.
- `claude-agent-sdk` runtime:
  - map to SDK `thinking` + `effort`.

#### Codex model propagation fix (must-do)

After config exists, Codex runtime should actually use selected model:

- pass `model: this.descriptor.model.modelId` into:
  - `thread/start`
  - `thread/resume`
  - optionally `turn/start` for consistency/override safety.

Without this, changing `codex-app` preset model ID still has no runtime effect.

#### Codex reasoning propagation fix (must-do)

Pass reasoning effort on `turn/start` from descriptor `thinkingLevel`:

- `off` -> `none`
- `minimal` -> `minimal`
- `low` -> `low`
- `medium` -> `medium`
- `high` -> `high`
- `xhigh` -> `xhigh`

Use `model/list` at startup (or lazy cache) to clamp effort to supported values per selected model.

### 5) Reasoning/thinking level across providers

#### Current behavior summary

- `pi-*`: `thinkingLevel` is honored.
- `claude-agent-sdk`: currently only `model` and `systemPrompt` are passed; no `thinking`/`effort`.
- `codex-app`: currently `developerInstructions` is passed; no `model`/`effort`.

#### Recommended mapping and implementation

1. Keep canonical `thinkingLevel` in model descriptor/config.
2. Add runtime mapper functions:
   - `mapThinkingLevelToCodexEffort(level)`.
   - `mapThinkingLevelToClaudeOptions(level, modelId)`.
3. Apply per runtime:
   - Codex: include `effort` on `turn/start`.
   - Claude:
     - `off`: `thinking: { type: "disabled" }` (no `effort`).
     - `minimal`/`low`: `effort: "low"` (+ optional adaptive thinking).
     - `medium`: `effort: "medium"`.
     - `high`: `effort: "high"`.
     - `xhigh`: `effort: "max"` for `claude-opus-4-6`, otherwise clamp to `"high"`.
4. Validate/clamp on load:
   - keep descriptor value as requested, but clamp when sending provider call.
5. Observability:
   - add debug logs of effective model + reasoning settings per turn/start call.

#### UI-later design

Phase later:

- Unhide `codex-app` in `CreateManagerDialog`.
- Add model preset metadata endpoint/event so UI can show actual model IDs under each preset.
- Add manager edit action (`update_manager`) for model switch on existing managers.
  - backend behavior: stop/recreate runtime (or reset manager session) with new descriptor.

## Suggested Rollout Order

1. Claude `settingSources` (+ config default `["project"]`).
2. Config-backed preset descriptor mapping in backend.
3. Codex runtime model propagation (`model` in thread/turn calls).
4. Provider reasoning propagation:
   - Codex `effort`
   - Claude `thinking`/`effort`
5. Optional manager prompt override on `create_manager`.
6. UI updates (show codex-app, show model IDs/reasoning, add manager model edit).

## Tests To Update/Add

- `apps/backend/src/test/claude-agent-sdk-runtime-behavior.test.ts`
  - assert `settingSources` is passed.
  - assert `thinking`/`effort` mapping is passed in query options.
- `apps/backend/src/test/codex-agent-runtime-behavior.test.ts`
  - assert `model` is sent in `thread/start`/`thread/resume`.
  - assert `effort` is sent on `turn/start`.
- `apps/backend/src/test/model-presets.test.ts`
  - update for config-backed descriptors.
- `apps/backend/src/test/swarm-manager.test.ts`
  - ensure create_manager preset mapping uses configured descriptors.
- UI tests (`apps/ui/src/routes/-index.test.ts`) once codex-app is unhidden and metadata is surfaced.

## References

- Claude memory/settings docs:
  - https://docs.claude.com/en/docs/claude-code/memory
  - https://docs.claude.com/en/docs/claude-code/settings
- Claude output styles:
  - https://docs.claude.com/en/docs/claude-code/output-styles
- Claude Agent SDK TS types/docs:
  - https://docs.anthropic.com/en/docs/claude-code/sdk/sdk-typescript
- Codex app-server protocol schema:
  - https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol/schema
