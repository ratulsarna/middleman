import type { IncomingMessage, ServerResponse } from "node:http";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import {
  readClaudeOutputStyleLenient,
  writeClaudeOutputStyle
} from "../../swarm/claude-output-style-settings.js";
import {
  applyCorsHeaders,
  decodePathSegment,
  matchPathPattern,
  readJsonBody,
  sendJson
} from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const MANAGER_CLAUDE_OUTPUT_STYLE_ENDPOINT_PATTERN = /^\/api\/managers\/([^/]+)\/claude\/output-style$/;

export function createClaudeRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  const { swarmManager } = options;

  return [
    {
      methods: "GET, PUT, OPTIONS",
      matches: (pathname) => MANAGER_CLAUDE_OUTPUT_STYLE_ENDPOINT_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        await handleClaudeOutputStyleHttpRequest(swarmManager, request, response, requestUrl);
      }
    }
  ];
}

async function handleClaudeOutputStyleHttpRequest(
  swarmManager: SwarmManager,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL
): Promise<void> {
  const methods = "GET, PUT, OPTIONS";

  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, methods);
    response.statusCode = 204;
    response.end();
    return;
  }

  applyCorsHeaders(request, response, methods);

  const route = resolveClaudeOutputStyleRoute(requestUrl.pathname);
  if (!route) {
    response.setHeader("Allow", methods);
    sendJson(response, 405, { error: "Method Not Allowed" });
    return;
  }

  const manager = swarmManager.getAgent(route.managerId);
  if (!manager || manager.role !== "manager") {
    sendJson(response, 404, { error: `Unknown manager: ${route.managerId}` });
    return;
  }

  if (!isClaudeAgentSdkProvider(manager.model.provider)) {
    sendJson(response, 400, {
      error: `Manager ${route.managerId} is not using claude-agent-sdk`
    });
    return;
  }

  if (request.method === "GET") {
    const settingsResult = await readClaudeOutputStyleLenient(manager.cwd);
    const warnings: string[] = [];

    let availableStyles: string[] = [];
    let runtimeSelectedStyle: string | null = null;
    if (isRuntimeBusyForOutputStyleMetadata(manager.status)) {
      warnings.push("Unable to load runtime output styles: manager is busy processing a turn. Try refresh.");
    } else {
      try {
        const runtimeMetadata = await swarmManager.getClaudeManagerOutputStyleMetadata(route.managerId);
        availableStyles = runtimeMetadata.availableStyles;
        runtimeSelectedStyle = runtimeMetadata.selectedStyle;
      } catch (error) {
        warnings.push(`Unable to load runtime output styles: ${toErrorMessage(error)}`);
      }
    }

    if (settingsResult.warning) {
      warnings.push(settingsResult.warning);
    }

    sendJson(response, 200, {
      managerId: route.managerId,
      selectedStyle: settingsResult.outputStyle ?? runtimeSelectedStyle,
      availableStyles,
      ...(warnings.length > 0
        ? {
            warning: warnings.join(" ")
          }
        : {})
    });
    return;
  }

  if (request.method === "PUT") {
    const payload = parseClaudeOutputStyleUpdateBody(await readJsonBody(request));
    await writeClaudeOutputStyle(manager.cwd, payload.outputStyle);
    await swarmManager.resetManagerSession(route.managerId, "api_reset");
    sendJson(response, 200, {
      ok: true,
      managerId: route.managerId,
      selectedStyle: payload.outputStyle
    });
    return;
  }

  response.setHeader("Allow", methods);
  sendJson(response, 405, { error: "Method Not Allowed" });
}

function resolveClaudeOutputStyleRoute(pathname: string): { managerId: string } | null {
  const match = matchPathPattern(pathname, MANAGER_CLAUDE_OUTPUT_STYLE_ENDPOINT_PATTERN);
  if (!match) {
    return null;
  }

  const managerId = decodePathSegment(match[1]);
  if (!managerId) {
    return null;
  }

  return { managerId };
}

function parseClaudeOutputStyleUpdateBody(value: unknown): { outputStyle: string | null } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }

  const outputStyle = (value as { outputStyle?: unknown }).outputStyle;
  if (outputStyle === null) {
    return { outputStyle: null };
  }

  if (typeof outputStyle !== "string") {
    throw new Error("outputStyle must be a string or null");
  }

  const trimmed = outputStyle.trim();
  return { outputStyle: trimmed.length > 0 ? trimmed : null };
}

function isClaudeAgentSdkProvider(provider: string): boolean {
  return provider.trim().toLowerCase() === "claude-agent-sdk";
}

function isRuntimeBusyForOutputStyleMetadata(status: string): boolean {
  return status === "streaming";
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
