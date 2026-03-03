import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const CLAUDE_SETTINGS_LOCAL_RELATIVE_PATH = [".claude", "settings.local.json"] as const;
const CLAUDE_SETTINGS_RELATIVE_PATH = [".claude", "settings.json"] as const;

type JsonObject = Record<string, unknown>;

export interface ClaudeOutputStyleReadResult {
  settingsPath: string;
  outputStyle: string | null;
  warning?: string;
}

export interface ClaudeOutputStyleStrictReadResult extends ClaudeOutputStyleReadResult {
  settings: JsonObject;
}

export function resolveClaudeSettingsLocalPath(cwd: string): string {
  return join(cwd, ...CLAUDE_SETTINGS_LOCAL_RELATIVE_PATH);
}

export function resolveClaudeSettingsPath(cwd: string): string {
  return join(cwd, ...CLAUDE_SETTINGS_RELATIVE_PATH);
}

export async function readClaudeOutputStyleLenient(cwd: string): Promise<ClaudeOutputStyleReadResult> {
  const localSettingsResult = await readOutputStyleFromSettingsFileLenient(resolveClaudeSettingsLocalPath(cwd));
  if (localSettingsResult.warning) {
    return {
      settingsPath: localSettingsResult.settingsPath,
      outputStyle: null,
      warning: localSettingsResult.warning
    };
  }

  if (localSettingsResult.hasOutputStyleProperty) {
    return {
      settingsPath: localSettingsResult.settingsPath,
      outputStyle: localSettingsResult.outputStyle
    };
  }

  const projectSettingsResult = await readOutputStyleFromSettingsFileLenient(resolveClaudeSettingsPath(cwd));
  if (projectSettingsResult.warning) {
    return {
      settingsPath: projectSettingsResult.settingsPath,
      outputStyle: null,
      warning: projectSettingsResult.warning
    };
  }

  return {
    settingsPath: projectSettingsResult.settingsPath,
    outputStyle: projectSettingsResult.hasOutputStyleProperty ? projectSettingsResult.outputStyle : null
  };
}

export async function readClaudeOutputStyleStrict(cwd: string): Promise<ClaudeOutputStyleStrictReadResult> {
  const settingsPath = resolveClaudeSettingsLocalPath(cwd);
  if (!existsSync(settingsPath)) {
    return {
      settingsPath,
      settings: {},
      outputStyle: null
    };
  }

  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf8");
  } catch (error) {
    throw new Error(`Failed to read ${settingsPath}: ${toErrorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse ${settingsPath}: ${toErrorMessage(error)}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`Expected ${settingsPath} to contain a JSON object`);
  }

  return {
    settingsPath,
    settings: parsed,
    outputStyle: normalizeOutputStyleValue(parsed.outputStyle)
  };
}

export async function writeClaudeOutputStyle(cwd: string, outputStyle: string | null): Promise<ClaudeOutputStyleReadResult> {
  const strictRead = await readClaudeOutputStyleStrict(cwd);
  const nextSettings: JsonObject = {
    ...strictRead.settings
  };

  if (outputStyle) {
    nextSettings.outputStyle = outputStyle;
  } else {
    delete nextSettings.outputStyle;
  }

  await mkdir(dirname(strictRead.settingsPath), { recursive: true });
  await writeFile(strictRead.settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`, "utf8");

  return {
    settingsPath: strictRead.settingsPath,
    outputStyle
  };
}

interface OutputStyleSettingsFileReadResult {
  settingsPath: string;
  outputStyle: string | null;
  hasOutputStyleProperty: boolean;
  warning?: string;
}

async function readOutputStyleFromSettingsFileLenient(settingsPath: string): Promise<OutputStyleSettingsFileReadResult> {
  if (!existsSync(settingsPath)) {
    return {
      settingsPath,
      outputStyle: null,
      hasOutputStyleProperty: false
    };
  }

  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf8");
  } catch (error) {
    return {
      settingsPath,
      outputStyle: null,
      hasOutputStyleProperty: false,
      warning: `Failed to read ${settingsPath}: ${toErrorMessage(error)}`
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      settingsPath,
      outputStyle: null,
      hasOutputStyleProperty: false,
      warning: `Failed to parse ${settingsPath}: ${toErrorMessage(error)}`
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      settingsPath,
      outputStyle: null,
      hasOutputStyleProperty: false,
      warning: `Expected ${settingsPath} to contain a JSON object`
    };
  }

  const hasOutputStyleProperty = Object.prototype.hasOwnProperty.call(parsed, "outputStyle");
  return {
    settingsPath,
    outputStyle: normalizeOutputStyleValue(parsed.outputStyle),
    hasOutputStyleProperty
  };
}

function normalizeOutputStyleValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
