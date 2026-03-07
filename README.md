# Nexus

**Stop managing your agents. Hire a middle manager.**

A self-hosted platform for orchestrating AI coding agents. Create a persistent manager for your project — it dispatches workers, coordinates their output, and reports back. You get full observability into every agent's work and can steer any of them at any time.

<img width="1856" height="1454" alt="image" src="https://github.com/user-attachments/assets/64a25dd9-926c-4975-95b1-164db7d0c21f" />

## What is Nexus?

You create a **manager agent** for your project. It breaks down work and spawns **worker agents** that run in parallel in isolated git worktrees. The dashboard streams every agent's messages, tool calls, and status in real time — so you always know what's happening. You can steer or interrupt any agent mid-task, send follow-up instructions, or kill workers that go off track.

Claude Code (Agent SDK) and Codex supported as providers. Managers and workers can be any model from either providers.

## Quick Start

```bash
git clone https://github.com/ratulsarna/nexus.git
cd nexus
pnpm install
pnpm dev
```

Opens at [localhost:47188](http://localhost:47188). Create a manager, point it at a repo, and start delegating.

**Requirements:** Node.js 22+, pnpm 10+, and an [Anthropic](https://console.anthropic.com/) or [OpenAI](https://platform.openai.com/) API key (configured in Settings).

## Key Capabilities

**Parallel execution** — Spawn multiple workers at once. Codex handles backend, Opus handles UI — all running simultaneously in isolated git worktrees.

**Multi-model teams** — Route tasks to the right model. The manager picks the best fit for each job from Claude Opus, Sonnet, Haiku, or Codex.

**Full observability** — Every agent's messages, tool calls, and thinking are streamed to the dashboard in real time. You always know exactly what each agent is doing.

**Steer at any time** — Send follow-up instructions, interrupt agents mid-task, or kill workers that go off track. You stay in control without micromanaging.

**Multi-channel messaging** — Chat via the web dashboard, or connect Slack and Telegram so your manager is reachable wherever you work.

**Custom archetypes** — Define specialized agent roles by dropping markdown files in `.swarm/archetypes/` in your repo. The manager picks them up automatically.

**Voice input & artifacts** — Dictate instructions via your microphone. Inspect files produced by agents directly in the dashboard with markdown rendering, image preview, and Mermaid diagrams.

## How It Works

1. **Create a manager** — Spin one up for your project. Point it at a repo, pick the models you want it to use.
2. **Configure it** — Pick models, set up integrations, define custom archetypes for specialized roles.
3. **Let it manage** — Hand off the work. Your manager dispatches coding agents and tracks progress. Watch everything in real time and steer when needed.

## Development

```bash
pnpm dev            # Start backend (:47187) + UI (:47188)
pnpm build          # Build all packages
pnpm test           # Run tests
pnpm prod           # Build and start production (backend :47287, UI :47289)
```

## Project Layout

```
apps/backend/       Node.js server — agent orchestration, WebSocket, HTTP API
apps/ui/            React dashboard — chat, settings, artifact viewer
packages/protocol/  Shared TypeScript types for the wire protocol
```

## License

[Apache 2.0](LICENSE)
