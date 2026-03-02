import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionManager } from "@mariozechner/pi-coding-agent";

/**
 * pi-coding-agent only flushes session files after an assistant "message" entry exists.
 * Claude SDK runtimes append only custom entries, so we force persistence for that case.
 */
export function persistSessionManagerCustomEntryIfNeeded(sessionManager: SessionManager): void {
  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile) {
    return;
  }

  const entries = sessionManager.getEntries();
  if (entries.length === 0) {
    return;
  }

  const hasAssistantMessage = entries.some(
    (entry) =>
      entry.type === "message" &&
      entry.message &&
      typeof entry.message === "object" &&
      "role" in entry.message &&
      (entry.message as { role?: unknown }).role === "assistant"
  );

  if (hasAssistantMessage) {
    return;
  }

  mkdirSync(dirname(sessionFile), { recursive: true });

  if (!existsSync(sessionFile)) {
    const serialized = entries.map((entry) => JSON.stringify(entry)).join("\n");
    writeFileSync(sessionFile, `${serialized}\n`, "utf8");
    return;
  }

  const latestEntry = entries[entries.length - 1];
  if (!latestEntry) {
    return;
  }

  appendFileSync(sessionFile, `${JSON.stringify(latestEntry)}\n`, "utf8");
}
