import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
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
    writeFileSync(sessionFile, `${serializeSessionEntriesWithHeader(sessionManager, entries)}\n`, "utf8");
    return;
  }

  if (!sessionFileHasValidHeader(sessionFile)) {
    writeFileSync(sessionFile, `${serializeSessionEntriesWithHeader(sessionManager, entries)}\n`, "utf8");
    return;
  }

  const latestEntry = entries[entries.length - 1];
  if (!latestEntry) {
    return;
  }

  appendFileSync(sessionFile, `${JSON.stringify(latestEntry)}\n`, "utf8");
}

function serializeSessionEntriesWithHeader(sessionManager: SessionManager, entries: unknown[]): string {
  const lines: string[] = [];
  const header = sessionManager.getHeader();
  if (header && typeof header === "object") {
    const headerType = (header as { type?: unknown }).type;
    if (headerType === "session") {
      lines.push(JSON.stringify(header));
    }
  }

  for (const entry of entries) {
    lines.push(JSON.stringify(entry));
  }

  return lines.join("\n");
}

function sessionFileHasValidHeader(sessionFile: string): boolean {
  try {
    const firstLine = readFirstLine(sessionFile)?.trim();
    if (!firstLine) {
      return false;
    }

    const parsed = JSON.parse(firstLine) as { type?: unknown; id?: unknown };
    return parsed.type === "session" && typeof parsed.id === "string" && parsed.id.length > 0;
  } catch {
    return false;
  }
}

function readFirstLine(sessionFile: string): string | undefined {
  const fd = openSync(sessionFile, "r");
  try {
    const buffer = Buffer.alloc(512);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytesRead <= 0) {
      return undefined;
    }

    const content = buffer.toString("utf8", 0, bytesRead);
    const newlineIndex = content.indexOf("\n");
    return newlineIndex >= 0 ? content.slice(0, newlineIndex) : content;
  } finally {
    closeSync(fd);
  }
}
