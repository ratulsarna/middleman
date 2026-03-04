import { AuthStorage, type AuthCredential } from "@mariozechner/pi-coding-agent";
import type {
  SettingsAuthProvider,
  SettingsAuthProviderName,
  SwarmConfig
} from "./types.js";

const SETTINGS_AUTH_MASK = "********";

const SETTINGS_AUTH_PROVIDER_DEFINITIONS: Array<{
  provider: SettingsAuthProviderName;
  storageProvider: string;
}> = [
  {
    provider: "anthropic",
    storageProvider: "anthropic"
  },
  {
    provider: "openai-codex",
    storageProvider: "openai-codex"
  },
  {
    provider: "claude-agent-sdk",
    storageProvider: "claude-agent-sdk"
  }
];

interface SecretsEnvServiceDependencies {
  config: SwarmConfig;
}

export class SecretsEnvService {
  constructor(private readonly deps: SecretsEnvServiceDependencies) {}

  async listSettingsAuth(): Promise<SettingsAuthProvider[]> {
    const authStorage = AuthStorage.create(this.deps.config.paths.authFile);

    return SETTINGS_AUTH_PROVIDER_DEFINITIONS.map((definition) => {
      const credential = authStorage.get(definition.storageProvider);
      const resolvedToken = extractAuthCredentialToken(credential);
      const configured = isSettingsAuthProviderConfigured(definition.provider, credential, resolvedToken);

      return {
        provider: definition.provider,
        configured,
        authType: resolveAuthCredentialType(credential),
        maskedValue: configured && resolvedToken ? maskSettingsAuthValue(resolvedToken) : undefined
      } satisfies SettingsAuthProvider;
    });
  }

  async updateSettingsAuth(values: Record<string, string>): Promise<void> {
    const entries = Object.entries(values);
    if (entries.length === 0) {
      return;
    }

    const authStorage = AuthStorage.create(this.deps.config.paths.authFile);

    for (const [rawProvider, rawValue] of entries) {
      const resolvedProvider = resolveSettingsAuthProvider(rawProvider);
      if (!resolvedProvider) {
        throw new Error(`Invalid auth provider: ${rawProvider}`);
      }

      if (resolvedProvider.provider === "claude-agent-sdk") {
        throw new Error("claude-agent-sdk auth must be configured via OAuth login flow.");
      }

      const normalizedValue = typeof rawValue === "string" ? rawValue.trim() : "";
      if (!normalizedValue) {
        throw new Error(`Auth value for ${resolvedProvider.provider} must be a non-empty string`);
      }

      const credential = {
        type: "api_key",
        key: normalizedValue,
        access: normalizedValue,
        refresh: "",
        expires: ""
      };

      authStorage.set(resolvedProvider.storageProvider, credential as unknown as AuthCredential);
    }
  }

  async deleteSettingsAuth(provider: string): Promise<void> {
    const resolvedProvider = resolveSettingsAuthProvider(provider);
    if (!resolvedProvider) {
      throw new Error(`Invalid auth provider: ${provider}`);
    }

    const authStorage = AuthStorage.create(this.deps.config.paths.authFile);
    authStorage.remove(resolvedProvider.storageProvider);
  }
}

function resolveSettingsAuthProvider(
  provider: string
): { provider: SettingsAuthProviderName; storageProvider: string } | undefined {
  const normalizedProvider = provider.trim().toLowerCase();
  if (!normalizedProvider) {
    return undefined;
  }

  const definition = SETTINGS_AUTH_PROVIDER_DEFINITIONS.find(
    (entry) => entry.provider === normalizedProvider
  );
  if (!definition) {
    return undefined;
  }

  return {
    provider: definition.provider,
    storageProvider: definition.storageProvider
  };
}

function resolveAuthCredentialType(
  credential: AuthCredential | undefined
): SettingsAuthProvider["authType"] | undefined {
  if (!credential) {
    return undefined;
  }

  if (credential.type === "api_key" || credential.type === "oauth") {
    return credential.type;
  }

  return "unknown";
}

function extractAuthCredentialToken(credential: AuthCredential | undefined): string | undefined {
  if (!credential || typeof credential !== "object") {
    return undefined;
  }

  if (credential.type === "api_key") {
    const apiKey = normalizeAuthToken((credential as { key?: unknown }).key);
    if (apiKey) {
      return apiKey;
    }
  }

  const accessToken = normalizeAuthToken((credential as { access?: unknown }).access);
  if (accessToken) {
    return accessToken;
  }

  return undefined;
}

function isSettingsAuthProviderConfigured(
  provider: SettingsAuthProviderName,
  credential: AuthCredential | undefined,
  resolvedToken: string | undefined
): boolean {
  if (typeof resolvedToken !== "string" || resolvedToken.length === 0) {
    return false;
  }

  if (provider === "claude-agent-sdk") {
    return credential?.type === "oauth";
  }

  return true;
}

function normalizeAuthToken(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed;
}

function maskSettingsAuthValue(value: string): string {
  if (value.length <= 4) {
    return SETTINGS_AUTH_MASK;
  }

  const visibleSuffix = value.slice(-4);
  return `${SETTINGS_AUTH_MASK}${visibleSuffix}`;
}
