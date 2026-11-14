/**
 * Settings and filesystem locations.
 *
 * Settings precedence (highest first):
 *   command-line override -> plugin storage -> plugin options -> environment -> default
 *
 * Skills live where OpenCode discovers them:
 *   global:  <OpenCode config dir>/skills
 *   project: <project>/.opencode/skills
 */

import { homedir } from "node:os";
import path from "node:path";
import type { Plugin } from "@opencode/plugin";

type StorageDomain = Plugin.Context["storage"];

import { BifrostError, isValidBaseUrl, normalizeBaseUrl } from "./bifrost.js";
import type {
  ConfigPatch,
  ConfigSummary,
  InstallScope,
  ResolvedSettings,
  StoredSettings,
  Target,
} from "./types.js";

export const SETTINGS_KEY = "settings";
export const MARKER_FILE = ".bifrost-skill.json";
export const DEFAULT_BASE_URL = "http://localhost:8080";

export interface SettingsDeps {
  storage: StorageDomain;
  options: Readonly<Record<string, unknown>>;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export function globalConfigDirectory(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  if (env.OPENCODE_CONFIG_DIR) return path.resolve(expandHome(env.OPENCODE_CONFIG_DIR, home));
  const configRoot = env.XDG_CONFIG_HOME
    ? path.resolve(expandHome(env.XDG_CONFIG_HOME, home))
    : path.join(home, ".config");
  return path.join(configRoot, "opencode");
}

export function globalSkillsDirectory(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  return path.join(globalConfigDirectory(env, home), "skills");
}

export function projectSkillsDirectory(directory: string): string {
  return path.join(path.resolve(directory), ".opencode", "skills");
}

export function resolveTarget(scope: InstallScope, directory?: string): Target {
  if (scope === "global") {
    return { scope, root: globalSkillsDirectory() };
  }
  if (!directory) {
    throw new BifrostError(
      "invalid",
      "Project scope needs a project directory. Run the command from a session inside the project, or use --global.",
    );
  }
  const resolved = path.resolve(directory);
  return { scope, root: projectSkillsDirectory(resolved), directory: resolved };
}

export class SettingsStore {
  private readonly storage: StorageDomain;
  private readonly options: Readonly<Record<string, unknown>>;
  private readonly env: NodeJS.ProcessEnv;

  constructor(deps: SettingsDeps) {
    this.storage = deps.storage;
    this.options = deps.options;
    this.env = deps.env ?? process.env;
  }

  async read(): Promise<StoredSettings> {
    const value = await this.storage.get(SETTINGS_KEY).catch(() => undefined);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    return {
      ...(typeof record.baseUrl === "string" ? { baseUrl: record.baseUrl } : {}),
      ...(typeof record.apiKey === "string" ? { apiKey: record.apiKey } : {}),
      ...(typeof record.timeoutMs === "number" ? { timeoutMs: record.timeoutMs } : {}),
    };
  }

  async resolve(overrides: ConfigPatch = {}): Promise<ResolvedSettings> {
    const stored = await this.read();

    const commandUrl = overrides.baseUrl?.trim();
    const storedUrl = stored.baseUrl?.trim();
    const optionUrl = stringOption(this.options.baseUrl);
    const envUrl = this.env.BIFROST_URL?.trim();

    let baseUrl: string;
    let baseUrlSource: ResolvedSettings["baseUrlSource"];
    if (commandUrl) {
      baseUrl = normalizeBaseUrl(commandUrl);
      baseUrlSource = "command";
    } else if (storedUrl) {
      baseUrl = normalizeBaseUrl(storedUrl);
      baseUrlSource = "storage";
    } else if (optionUrl) {
      baseUrl = normalizeBaseUrl(optionUrl);
      baseUrlSource = "options";
    } else if (envUrl) {
      baseUrl = normalizeBaseUrl(envUrl);
      baseUrlSource = "environment";
    } else {
      baseUrl = DEFAULT_BASE_URL;
      baseUrlSource = "default";
    }

    const commandKey = overrides.apiKey === null ? "" : overrides.apiKey?.trim();
    const storedKey = stored.apiKey;
    const optionKey = stringOption(this.options.apiKey);
    const envKey = this.env.BIFROST_API_KEY?.trim();

    let apiKey: string | undefined;
    let apiKeySource: ResolvedSettings["apiKeySource"];
    if (commandKey !== undefined) {
      apiKey = commandKey === "" ? undefined : commandKey;
      apiKeySource = commandKey === "" ? "none" : "command";
    } else if (storedKey !== undefined) {
      apiKey = storedKey === "" ? undefined : storedKey;
      apiKeySource = storedKey === "" ? "none" : "storage";
    } else if (optionKey) {
      apiKey = optionKey;
      apiKeySource = "options";
    } else if (envKey) {
      apiKey = envKey;
      apiKeySource = "environment";
    } else {
      apiKey = undefined;
      apiKeySource = "none";
    }

    const timeoutMs =
      overrides.timeoutMs ??
      stored.timeoutMs ??
      numberOption(this.options.timeoutMs) ??
      numberOption(this.env.BIFROST_TIMEOUT_MS) ??
      20_000;

    return { baseUrl, apiKey, timeoutMs, baseUrlSource, apiKeySource };
  }

  async update(patch: ConfigPatch): Promise<void> {
    if (patch.reset) {
      await this.storage.remove(SETTINGS_KEY);
      return;
    }

    const current = await this.read();
    const next: StoredSettings = { ...current };

    if (patch.baseUrl !== undefined) {
      const normalized = normalizeBaseUrl(patch.baseUrl);
      if (!isValidBaseUrl(normalized)) {
        throw new BifrostError("invalid", `'${patch.baseUrl}' is not a valid gateway URL.`);
      }
      next.baseUrl = normalized;
    }
    if (patch.apiKey !== undefined) {
      if (patch.apiKey === null) next.apiKey = "";
      else next.apiKey = patch.apiKey.trim();
    }
    if (patch.timeoutMs !== undefined) {
      if (patch.timeoutMs <= 0)
        throw new BifrostError("invalid", "timeoutMs must be greater than zero.");
      next.timeoutMs = Math.round(patch.timeoutMs);
    }

    await this.storage.set(SETTINGS_KEY, next as unknown as Parameters<StorageDomain["set"]>[1]);
  }

  async summary(overrides: ConfigPatch = {}): Promise<ConfigSummary> {
    const resolved = await this.resolve(overrides);
    return {
      baseUrl: resolved.baseUrl,
      baseUrlSource: resolved.baseUrlSource,
      hasApiKey: !!resolved.apiKey,
      apiKeySource: resolved.apiKeySource,
      ...(resolved.apiKey ? { apiKeyHint: maskSecret(resolved.apiKey) } : {}),
      timeoutMs: resolved.timeoutMs,
      globalSkillsDirectory: globalSkillsDirectory(),
    };
  }
}

export function maskSecret(secret: string): string {
  if (secret.length <= 8) return "********";
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

/** True when `child` resolves inside `parent` (no path traversal). */
export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function displayPath(target: string, home = homedir()): string {
  const resolved = path.resolve(target);
  const relative = path.relative(home, resolved);
  if (relative === "") return "~";
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return `~/${relative}`;
  return resolved;
}

function stringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function numberOption(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}
