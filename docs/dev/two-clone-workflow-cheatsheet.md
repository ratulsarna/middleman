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

## State Isolation (Current)

Dev and prod are isolated by default:

- `pnpm dev` / `pnpm dev:backend` uses `NEXUS_DATA_DIR=~/.nexus-dev`
- `pnpm prod:start` uses `~/.nexus` (unless `NEXUS_DATA_DIR` is explicitly set)

So running prod in `Nexus` and dev in `Nexus-dev` does not share state.

## When Collisions Can Still Happen

You can still collide if both clones run the same mode:

- prod + prod -> both use `~/.nexus` by default
- dev + dev -> both use `~/.nexus-dev` by default

If needed, isolate per clone by setting `NEXUS_DATA_DIR` explicitly:

```bash
cd ../Nexus
NEXUS_DATA_DIR=$PWD/.nexus-data pnpm prod:start
```

```bash
cd ../Nexus-dev
NEXUS_DATA_DIR=$PWD/.nexus-data pnpm dev
```

## Log Access

Useful places to inspect while debugging:

- Consumer runtime log: `/tmp/nexus-consumer.log`
- Consumer clone files: `../Nexus/*`
- Dev clone files: `../Nexus-dev/*`
