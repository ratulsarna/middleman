export type UnhandledRejectionClassification = "known_claude_sdk_shutdown_race" | "unknown";

export interface UnhandledRejectionAssessment {
  classification: UnhandledRejectionClassification;
  message: string;
  stack?: string;
}

export function assessUnhandledRejection(reason: unknown): UnhandledRejectionAssessment {
  const message = extractRejectionMessage(reason);
  const stack = extractRejectionStack(reason);

  if (isKnownClaudeSdkShutdownRace(message, stack)) {
    return {
      classification: "known_claude_sdk_shutdown_race",
      message,
      ...(stack ? { stack } : {})
    };
  }

  return {
    classification: "unknown",
    message,
    ...(stack ? { stack } : {})
  };
}

function isKnownClaudeSdkShutdownRace(message: string, stack?: string): boolean {
  const normalizedMessage = message.trim().toLowerCase();
  if (!normalizedMessage) {
    return false;
  }

  const hasKnownTransportReuseFailure = normalizedMessage.includes("already connected to a transport");
  if (hasKnownTransportReuseFailure) {
    return hasClaudeSdkStackContext(stack);
  }

  const hasKnownWriteFailure =
    normalizedMessage.includes("processtransport is not ready for writing") ||
    normalizedMessage.includes("write after end") ||
    normalizedMessage.includes("cannot write to terminated process");

  if (!hasKnownWriteFailure) {
    return false;
  }

  if (normalizedMessage.includes("processtransport")) {
    return true;
  }

  return hasClaudeSdkStackContext(stack);
}

function hasClaudeSdkStackContext(stack?: string): boolean {
  const normalizedStack = stack?.toLowerCase();
  if (!normalizedStack) {
    return false;
  }

  return (
    normalizedStack.includes("@anthropic-ai/claude-agent-sdk") ||
    normalizedStack.includes("handlecontrolrequest") ||
    normalizedStack.includes("processtransport")
  );
}

function extractRejectionMessage(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }

  if (typeof reason === "string") {
    return reason;
  }

  if (
    reason &&
    typeof reason === "object" &&
    "message" in reason &&
    typeof (reason as { message?: unknown }).message === "string"
  ) {
    return (reason as { message: string }).message;
  }

  return String(reason);
}

function extractRejectionStack(reason: unknown): string | undefined {
  if (reason instanceof Error && typeof reason.stack === "string") {
    return reason.stack;
  }

  if (
    reason &&
    typeof reason === "object" &&
    "stack" in reason &&
    typeof (reason as { stack?: unknown }).stack === "string"
  ) {
    return (reason as { stack: string }).stack;
  }

  return undefined;
}
