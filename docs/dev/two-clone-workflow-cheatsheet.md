# Two-Clone Workflow Cheatsheet

Use this when you want to develop Nexus while also using it as a consumer.

## Clone Roles

- `Nexus-dev` = development clone (edit code, run tests, validate changes)
- `Nexus` = consumer clone (run the app you actively use)

## Recommended Daily Flow

1. Run consumer from `Nexus` and capture logs:

```bash
cd ../Nexus
pnpm prod:start 2>&1 | tee -a /tmp/nexus-consumer.log
```

2. Work in `Nexus-dev`:

```bash
cd ../Nexus-dev
# edit code, run checks, etc.
```

## Important Caveat (State Collision)

Both clones currently use the same default data directory: `~/.nexus`.

That means two simultaneously running backends can collide on shared state even if ports differ.

## If You Must Run Both At The Same Time

Isolate each clone with its own `HOME` so each one gets its own `.nexus`:

```bash
cd ../Nexus
HOME=$PWD/.home pnpm prod:start
```

```bash
cd ../Nexus-dev
HOME=$PWD/.home pnpm dev
```

This creates per-clone state directories:

- `../Nexus/.home/.nexus`
- `../Nexus-dev/.home/.nexus`

## Log Access

Useful places to inspect while debugging:

- Consumer runtime log: `/tmp/nexus-consumer.log`
- Consumer clone files: `../Nexus/*`
- Dev clone files: `../Nexus-dev/*`
