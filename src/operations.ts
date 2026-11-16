/**
 * Filesystem and catalog operations shared by the server commands and the TUI.
 *
 * Every install is written to a hidden staging directory first and then
 * atomically renamed into place. An existing skill directory is only replaced
 * when the caller explicitly allows it (`--force`, or `/bifrost-update`).
 */

import { createHash, randomBytes } from "node:crypto";
import { type Dirent, promises as fs } from "node:fs";
import path from "node:path";
import type { Plugin } from "@opencode/plugin";

type StorageDomain = Plugin.Context["storage"];

import { BifrostClient, BifrostError, describeError, type Gateway } from "./bifrost.js";
import {
  displayPath,
  isInside,
  MARKER_FILE,
  projectSkillsDirectory,
  resolveTarget,
  SettingsStore,
} from "./settings.js";
import type {
  Catalog,
  ConfigPatch,
  ConfigSummary,
  Failure,
  InstallBatchResult,
  InstalledSkill,
  InstallResult,
  InstallScope,
  RemoveResult,
  ResolvedSettings,
  SkillSummary,
  Target,
  UpdateResult,
} from "./types.js";
import { decodeSkillArchive, fileMode, hashFiles, type SkillPackage, skillId } from "./zip.js";

export interface OperationsDeps {
  storage: StorageDomain;
  options: Readonly<Record<string, unknown>>;
  /** Reloads OpenCode's skill registry after a change. */
  reload?: () => Promise<void>;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Overridable for tests. */
  gatewayFactory?: (settings: ResolvedSettings) => Gateway;
  now?: () => Date;
}

export interface InstallInput {
  name: string;
  scope: InstallScope;
  directory?: string;
  force?: boolean;
  overrides?: ConfigPatch;
  signal?: AbortSignal;
  /** Internal: a catalog already fetched by the caller. */
  catalog?: Catalog;
}

export interface BatchInstallInput {
  scope: InstallScope;
  directory?: string;
  force?: boolean;
  overrides?: ConfigPatch;
  signal?: AbortSignal;
}

export interface UpdateInput {
  name?: string;
  scope?: InstallScope;
  directory?: string;
  overrides?: ConfigPatch;
  signal?: AbortSignal;
}

export interface RemoveInput {
  name: string;
  scope?: InstallScope;
  directory?: string;
}

export class Operations {
  readonly settings: SettingsStore;
  private readonly storage: StorageDomain;
  private readonly reloadSkills?: () => Promise<void>;
  private readonly gatewayFactory: (settings: ResolvedSettings) => Gateway;
  private readonly now: () => Date;

  constructor(deps: OperationsDeps) {
    this.storage = deps.storage;
    this.reloadSkills = deps.reload;
    this.now = deps.now ?? (() => new Date());
    this.gatewayFactory =
      deps.gatewayFactory ??
      ((settings) =>
        new BifrostClient({
          baseUrl: settings.baseUrl,
          timeoutMs: settings.timeoutMs,
        }));
    this.settings = new SettingsStore({
      storage: deps.storage,
      options: deps.options,
      env: deps.env,
      home: deps.home,
    });
  }

  async summary(overrides: ConfigPatch = {}): Promise<ConfigSummary> {
    return this.settings.summary(overrides);
  }

  async configure(patch: ConfigPatch): Promise<ConfigSummary> {
    await this.settings.update(patch);
    return this.settings.summary();
  }

  async catalog(overrides: ConfigPatch = {}, signal?: AbortSignal): Promise<Catalog> {
    return this.gateway(overrides).catalog(signal);
  }

  async install(input: InstallInput): Promise<InstallResult> {
    const settings = await this.settings.resolve(input.overrides);
    const target = resolveTarget(input.scope, input.directory);
    const gateway = this.gatewayFactory(settings);

    const latestCatalog = input.catalog ?? (await tryCatalog(gateway, input.signal));
    const resolved = resolveInput(input.name, latestCatalog);
    const bytes = await downloadFirst(gateway, resolved.candidates, input.signal);
    const pkg = selectPackage(decodeSkillArchive(bytes), resolved.entry);
    const existing = await this.findExisting(target.root, [
      resolved.entry?.id ?? "",
      resolved.id,
      pkg.suggestedId,
    ]);
    const result = await this.commitPackage({
      target,
      settings,
      gateway,
      pkg,
      id: existing?.id ?? resolved.entry?.id ?? pkg.suggestedId,
      name: resolved.entry?.name ?? pkg.name,
      description: resolved.entry?.description ?? pkg.description,
      version: resolved.entry?.version ?? pkg.version,
      existing,
      allowExisting: input.force ?? false,
      action: existing ? "overwritten" : "installed",
    });
    await this.reload();
    return result;
  }

  async installAll(input: BatchInstallInput): Promise<InstallBatchResult> {
    const settings = await this.settings.resolve(input.overrides);
    const target = resolveTarget(input.scope, input.directory);
    const gateway = this.gatewayFactory(settings);
    const result: InstallBatchResult = { results: [], failures: [], skipped: [] };

    let packages: SkillPackage[] = [];
    try {
      packages = decodeSkillArchive(await gateway.downloadAll(input.signal));
    } catch (error) {
      result.failures.push({ name: "all", message: describeError(error) });
    }

    if (packages.length === 0) {
      // Some gateways serve a valid but empty bundle. Fall back to the
      // per-skill route when a catalog can still tell us what exists.
      const catalog = await tryCatalog(gateway, input.signal);
      if (!catalog || catalog.skills.length === 0) {
        result.failures.push({
          name: "all",
          message: "The gateway did not return any installable skills.",
        });
        return result;
      }
      for (const skill of catalog.skills) {
        try {
          const installed = await this.install({
            name: skill.name,
            scope: input.scope,
            directory: input.directory,
            force: input.force,
            overrides: input.overrides,
            signal: input.signal,
            catalog,
          });
          result.results.push(installed);
        } catch (error) {
          if (isExistsError(error))
            result.skipped.push({ name: skill.name, message: describeError(error) });
          else result.failures.push({ name: skill.name, message: describeError(error) });
        }
      }
      await this.reload();
      return result;
    }

    await fs.mkdir(target.root, { recursive: true });
    for (const pkg of packages) {
      const id = pkg.suggestedId;
      try {
        const existing = await readMarker(path.join(target.root, id));
        if (existing && !input.force) {
          result.skipped.push({
            name: pkg.name,
            message: `'${id}' is already installed. Use --force to overwrite it.`,
          });
          continue;
        }
        result.results.push(
          await this.commitPackage({
            target,
            settings,
            gateway,
            pkg,
            id,
            name: pkg.name,
            description: pkg.description,
            version: pkg.version,
            existing,
            allowExisting: input.force ?? false,
            action: existing ? "overwritten" : "installed",
          }),
        );
      } catch (error) {
        result.failures.push({ name: pkg.name, message: describeError(error) });
      }
    }

    await this.reload();
    return result;
  }

  async list(directory?: string): Promise<InstalledSkill[]> {
    const global = await listRoot(resolveTarget("global").root, "global");
    const records = [...global];
    if (directory) {
      records.push(...(await listRoot(projectSkillsDirectory(directory), "project")));
    }
    return records.sort((a, b) => a.scope.localeCompare(b.scope) || a.id.localeCompare(b.id));
  }

  async update(input: UpdateInput): Promise<UpdateResult> {
    const settings = await this.settings.resolve(input.overrides);
    const gateway = this.gatewayFactory(settings);
    const catalog = await tryCatalog(gateway, input.signal);

    const records = await this.selectRecords(input.name, input.scope, input.directory);
    if (records.length === 0) {
      throw new BifrostError(
        "not-installed",
        input.name
          ? `No installed Bifrost skill matches '${input.name}'${scopeHint(input.scope)}.`
          : "No Bifrost skills are installed.",
      );
    }

    const result: UpdateResult = { results: [], failures: [], unchanged: [] };
    for (const record of records) {
      try {
        const remote = findRemote(catalog, record);
        if (remote?.version && record.version) {
          const comparison = compareVersions(remote.version, record.version);
          if (comparison !== undefined && comparison < 0) {
            // The installed copy is newer than the gateway's latest version.
            result.unchanged.push(recordAsResult(record, "unchanged"));
            continue;
          }
        }

        const candidates = unique([
          record.name,
          remote?.name,
          stripBifrost(record.name),
          stripBifrost(remote?.name ?? ""),
        ]);
        const bytes = await downloadFirst(gateway, candidates, input.signal);
        const pkg = selectPackage(decodeSkillArchive(bytes), remote);
        const contentHash = hashFiles(pkg.files);
        if (contentHash === record.contentHash) {
          result.unchanged.push(recordAsResult(record, "unchanged"));
          continue;
        }

        const target: Target = { scope: record.scope, root: path.dirname(record.directory) };
        const updated = await this.commitPackage({
          target,
          settings,
          gateway,
          pkg,
          id: record.id,
          name: remote?.name ?? record.name,
          description: remote?.description ?? record.description ?? pkg.description,
          version: remote?.version ?? pkg.version ?? record.version,
          existing: record,
          allowExisting: true,
          action: "updated",
        });
        result.results.push(updated);
      } catch (error) {
        result.failures.push({ name: record.id, message: describeError(error) });
      }
    }

    if (result.results.length > 0) await this.reload();
    return result;
  }

  async remove(input: RemoveInput): Promise<RemoveResult> {
    const records = await this.selectRecords(input.name, input.scope, input.directory);
    if (records.length === 0) {
      throw new BifrostError(
        "not-installed",
        `No installed Bifrost skill matches '${input.name}'.`,
      );
    }
    if (
      !input.scope &&
      records.some((record) => record.scope === "global") &&
      records.some((record) => record.scope === "project")
    ) {
      throw new BifrostError(
        "invalid",
        `'${input.name}' is installed in both global and project scope. Pass --global or --project.`,
      );
    }

    const removed: RemoveResult["removed"] = [];
    for (const record of records) {
      const root = path.dirname(record.directory);
      if (!isInside(root, record.directory) || path.basename(record.directory) !== record.id) {
        throw new BifrostError(
          "unsafe",
          `Refusing to remove '${record.directory}': it is not a skill directory inside ${root}.`,
        );
      }
      const marker = await readMarker(record.directory);
      if (!marker) {
        throw new BifrostError(
          "unsafe",
          `Refusing to remove '${record.directory}': ${MARKER_FILE} is missing.`,
        );
      }
      await fs.rm(record.directory, { recursive: true, force: true });
      await this.storage.remove(storageKey(record)).catch(() => undefined);
      removed.push({
        id: record.id,
        name: record.name,
        directory: record.directory,
        scope: record.scope,
      });
    }

    await this.reload();
    return { removed };
  }

  /** Resolves a raw name, marketplace plugin name, or skill id to a record. */
  async selectRecords(
    name: string | undefined,
    scope: InstallScope | undefined,
    directory?: string,
  ): Promise<InstalledSkill[]> {
    const globalRecords = await listRoot(resolveTarget("global").root, "global");
    const projectRecords = directory
      ? await listRoot(projectSkillsDirectory(directory), "project")
      : [];
    const all = [...globalRecords, ...projectRecords];

    const scoped = scope ? all.filter((record) => record.scope === scope) : all;
    if (!name || name === "all" || name === "*") return scoped;

    const needle = name.trim().toLowerCase();
    const stripped = stripBifrost(needle);
    return scoped.filter(
      (record) =>
        record.id === needle ||
        record.name.toLowerCase() === needle ||
        record.name.toLowerCase() === stripped ||
        record.id === stripped,
    );
  }

  private gateway(overrides: ConfigPatch): Gateway {
    // Resolve lazily so /bifrost-config changes apply without a reload.
    return new LazyGateway(async () => this.gatewayFactory(await this.settings.resolve(overrides)));
  }

  private async findExisting(root: string, ids: string[]): Promise<InstalledSkill | undefined> {
    for (const candidate of unique(ids)) {
      if (!candidate) continue;
      const directory = path.join(root, candidate);
      const marker = await readMarker(directory);
      if (marker) return marker;
      if (await pathExists(directory)) {
        // A directory without our marker belongs to somebody else. Represent
        // it so commitPackage refuses without --force.
        return {
          schema: 1,
          id: candidate,
          name: candidate,
          scope: "global",
          directory,
          baseUrl: "",
          installedAt: "",
          contentHash: "",
          source: "bifrost",
        };
      }
    }
    return undefined;
  }

  private async commitPackage(input: {
    target: Target;
    settings: ResolvedSettings;
    gateway: Gateway;
    pkg: SkillPackage;
    id: string;
    name: string;
    description?: string;
    version?: string;
    existing?: InstalledSkill;
    allowExisting: boolean;
    action: InstallResult["action"];
  }): Promise<InstallResult> {
    const id = skillId(input.id);
    if (!id) throw new BifrostError("invalid", "The skill id is empty after sanitizing.");
    if (!input.pkg.files.has("SKILL.md")) {
      throw new BifrostError(
        "corrupt",
        `The archive for '${input.name}' does not contain SKILL.md.`,
      );
    }

    const finalDirectory = path.join(input.target.root, id);
    const exists = await pathExists(finalDirectory);
    if (exists && !input.allowExisting) {
      throw new BifrostError(
        "exists",
        `Skill '${id}' is already installed at ${displayPath(finalDirectory)}. Use --force to overwrite it.`,
      );
    }

    await fs.mkdir(input.target.root, { recursive: true });
    const staging = path.join(
      input.target.root,
      `.bifrost-staging-${id}-${process.pid}-${randomBytes(4).toString("hex")}`,
    );
    await fs.mkdir(staging, { recursive: true });

    try {
      for (const [relative, bytes] of input.pkg.files) {
        const destination = path.join(staging, ...relative.split("/"));
        if (!isInside(staging, destination)) {
          throw new BifrostError(
            "unsafe",
            `Refusing to write outside the skill directory: ${relative}`,
          );
        }
        await fs.mkdir(path.dirname(destination), { recursive: true });
        // Shebang files keep their executable bit; everything else is 0644.
        await fs.writeFile(destination, bytes, { mode: fileMode(bytes) });
      }

      const now = this.now().toISOString();
      const contentHash = hashFiles(input.pkg.files);
      const record: InstalledSkill = {
        schema: 1,
        id,
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        ...(input.version ? { version: input.version } : {}),
        scope: input.target.scope,
        directory: finalDirectory,
        baseUrl: input.settings.baseUrl,
        installedAt: input.existing?.installedAt || now,
        ...(input.existing ? { updatedAt: now } : {}),
        contentHash,
        source: "bifrost",
      };

      await fs.writeFile(path.join(staging, MARKER_FILE), `${JSON.stringify(record, null, 2)}\n`, {
        mode: 0o644,
      });
      await replaceDirectory(staging, finalDirectory);
      await this.storage
        .set(storageKey(record), record as unknown as Parameters<StorageDomain["set"]>[1])
        .catch(() => undefined);

      return {
        id,
        name: record.name,
        ...(record.description ? { description: record.description } : {}),
        ...(record.version ? { version: record.version } : {}),
        directory: finalDirectory,
        scope: record.scope,
        action: input.action,
        contentHash,
      };
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async reload(): Promise<void> {
    await this.reloadSkills?.().catch(() => undefined);
  }
}

export function storageKey(record: InstalledSkill): string {
  const bucket = createHash("sha256").update(record.directory).digest("hex").slice(0, 16);
  return `installed:${record.scope}:${bucket}:${record.id}`;
}

export async function readMarker(directory: string): Promise<InstalledSkill | undefined> {
  try {
    const raw = await fs.readFile(path.join(directory, MARKER_FILE), "utf8");
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (record.schema !== 1 || typeof record.id !== "string" || typeof record.name !== "string")
      return undefined;
    if (record.source !== "bifrost") return undefined;
    return {
      schema: 1,
      id: record.id,
      name: record.name,
      ...(typeof record.description === "string" ? { description: record.description } : {}),
      ...(typeof record.version === "string" ? { version: record.version } : {}),
      scope: record.scope === "project" ? "project" : "global",
      directory: typeof record.directory === "string" ? record.directory : directory,
      baseUrl: typeof record.baseUrl === "string" ? record.baseUrl : "",
      installedAt: typeof record.installedAt === "string" ? record.installedAt : "",
      ...(typeof record.updatedAt === "string" ? { updatedAt: record.updatedAt } : {}),
      contentHash: typeof record.contentHash === "string" ? record.contentHash : "",
      source: "bifrost",
    };
  } catch {
    return undefined;
  }
}

export async function listRoot(root: string, scope: InstallScope): Promise<InstalledSkill[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const records: InstalledSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const directory = path.join(root, entry.name);
    const record = await readMarker(directory);
    if (!record) continue;
    records.push({ ...record, scope, directory });
  }
  return records;
}

export interface ResolvedSkillInput {
  id: string;
  candidates: string[];
  entry?: SkillSummary;
}

export function resolveInput(name: string, catalog: Catalog | undefined): ResolvedSkillInput {
  const trimmed = name.trim();
  if (!trimmed) throw new BifrostError("invalid", "A skill name is required.");

  const entry = catalog?.skills.find(
    (skill) => skill.name === trimmed || skill.id === trimmed || skill.plugin === trimmed,
  );
  if (entry) {
    return {
      id: entry.id,
      candidates: unique([entry.name, stripBifrost(entry.name), entry.plugin ?? ""]),
      entry,
    };
  }

  const candidates = unique([trimmed, stripBifrost(trimmed)]);
  return { id: skillId(candidates[0] ?? trimmed), candidates };
}

function findRemote(
  catalog: Catalog | undefined,
  record: InstalledSkill,
): SkillSummary | undefined {
  return catalog?.skills.find(
    (skill) => skill.name === record.name || skill.id === record.id || skill.plugin === record.name,
  );
}

export function compareVersions(left: string, right: string): number | undefined {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return undefined;
  const length = Math.max(a.numbers.length, b.numbers.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true }) < 0 ? -1 : 1;
}

function parseVersion(value: string): { numbers: number[]; prerelease?: string } | undefined {
  const match = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?/.exec(value.trim());
  if (!match) return undefined;
  const numbers = (match[1] ?? "").split(".").map((part) => Number(part));
  if (numbers.some((part) => !Number.isFinite(part))) return undefined;
  return { numbers, ...(match[2] ? { prerelease: match[2] } : {}) };
}

async function tryCatalog(gateway: Gateway, signal?: AbortSignal): Promise<Catalog | undefined> {
  try {
    return await gateway.catalog(signal);
  } catch {
    return undefined;
  }
}

async function downloadFirst(
  gateway: Gateway,
  candidates: string[],
  signal?: AbortSignal,
): Promise<Uint8Array> {
  let lastError: unknown;
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return await gateway.downloadSkill(candidate, signal);
    } catch (error) {
      lastError = error;
      if (!(error instanceof BifrostError) || error.code !== "not-found") throw error;
    }
  }
  throw lastError ?? new BifrostError("not-found", "No downloadable skill name was available.");
}

function selectPackage(packages: SkillPackage[], entry: SkillSummary | undefined): SkillPackage {
  if (packages.length === 0) {
    throw new BifrostError("corrupt", "The skill archive does not contain a SKILL.md file.");
  }
  if (packages.length === 1) return packages[0] as SkillPackage;

  const match = packages.find(
    (pkg) =>
      pkg.name === entry?.name ||
      pkg.suggestedId === entry?.id ||
      pkg.root === entry?.name ||
      (pkg.displayName !== undefined && pkg.displayName === entry?.name),
  );
  if (match) return match;
  throw new BifrostError(
    "corrupt",
    `The archive contains ${packages.length} skills (${packages.map((pkg) => pkg.name).join(", ")}); expected one.`,
  );
}

async function replaceDirectory(staging: string, finalDirectory: string): Promise<void> {
  if (!(await pathExists(finalDirectory))) {
    await fs.rename(staging, finalDirectory);
    return;
  }

  const backup = `${finalDirectory}.bak-${process.pid}-${randomBytes(4).toString("hex")}`;
  await fs.rename(finalDirectory, backup);
  try {
    await fs.rename(staging, finalDirectory);
  } catch (error) {
    await fs.rename(backup, finalDirectory).catch(() => undefined);
    throw error;
  }
  await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

function recordAsResult(record: InstalledSkill, action: InstallResult["action"]): InstallResult {
  return {
    id: record.id,
    name: record.name,
    ...(record.description ? { description: record.description } : {}),
    ...(record.version ? { version: record.version } : {}),
    directory: record.directory,
    scope: record.scope,
    action,
    contentHash: record.contentHash,
  };
}

function stripBifrost(name: string): string {
  return name.startsWith("bifrost-") ? name.slice("bifrost-".length) : name;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value))];
}

function isExistsError(error: unknown): boolean {
  return error instanceof BifrostError && error.code === "exists";
}

function scopeHint(scope: InstallScope | undefined): string {
  return scope ? ` in ${scope} scope` : "";
}

/**
 * Creates the gateway only when a request is actually made. This lets
 * `/bifrost-config` change settings between two calls without rebuilding the
 * operations object.
 */
class LazyGateway implements Gateway {
  private gateway?: Promise<Gateway>;

  constructor(private readonly create: () => Promise<Gateway>) {}

  get baseUrl(): string {
    return "";
  }

  private instance(): Promise<Gateway> {
    this.gateway ??= this.create();
    return this.gateway;
  }

  async catalog(signal?: AbortSignal): Promise<Catalog> {
    return (await this.instance()).catalog(signal);
  }

  async downloadSkill(name: string, signal?: AbortSignal): Promise<Uint8Array> {
    return (await this.instance()).downloadSkill(name, signal);
  }

  async downloadAll(signal?: AbortSignal): Promise<Uint8Array> {
    return (await this.instance()).downloadAll(signal);
  }
}

export type { Failure };
