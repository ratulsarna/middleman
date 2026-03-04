### Deprecated: Cron Scheduling

Removed as part of the skills system teardown. Preserved here for reference if we reintroduce scheduling.

### Concept

Agents could create, list, and remove persistent scheduled tasks using cron expressions. Schedules were per-manager and stored as JSON on disk. A scheduler process evaluated them and sent the message payload to the owning manager when a schedule fired.

### How it worked

- Storage: `~/.nexus/schedules/<managerId>.json`
- CLI tool (`schedule.js`) with three commands: `add`, `remove`, `list`
- Each schedule had: name, cron expression, message content, timezone (IANA), one-shot flag
- Next fire time computed via `cron-parser` library
- One-shot schedules fired once and were removed; recurring schedules recomputed their next fire time

### Schedule record shape

```json
{
  "id": "uuid",
  "name": "Daily standup reminder",
  "cron": "0 9 * * 1-5",
  "message": "Remind me about the daily standup",
  "oneShot": false,
  "timezone": "America/Los_Angeles",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "nextFireAt": "2026-01-02T17:00:00.000Z"
}
```

### Usage examples

Add a recurring schedule:
```bash
node schedule.js add \
  --manager "manager" \
  --name "Daily standup reminder" \
  --cron "0 9 * * 1-5" \
  --message "Remind me about the daily standup" \
  --timezone "America/Los_Angeles"
```

Add a one-shot schedule:
```bash
node schedule.js add \
  --manager "manager" \
  --name "One-time deployment check" \
  --cron "30 14 * * *" \
  --message "Check deployment status" \
  --timezone "America/Los_Angeles" \
  --one-shot
```

Remove / list:
```bash
node schedule.js remove --manager "manager" --id "<schedule-id>"
node schedule.js list --manager "manager"
```

### Design notes

- `--manager` was optional; CLI auto-resolved when only one manager existed
- All commands returned JSON (`{ "ok": true, ... }` or `{ "ok": false, "error": "..." }`)
- File writes used atomic rename (write to `.tmp`, then `rename`) to avoid corruption
- Manager resolution fell back to a hardcoded candidates list (`["manager", "opus-manager"]`) — this should be dynamic if reimplemented

### Why it was removed

The skill system it lived in had hardcoded skill names with no dynamic loading. The system was stripped entirely. If scheduling comes back, it should be a proper module — not a skill file with a sidecar script.
