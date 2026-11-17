/**
 * Shared types for the Bifrost skills plugin.
 *
 * The gateway (Bifrost) exposes skills by their *repository name* (for
 * example `git-release`), while Claude Code marketplaces prefix plugin names
 * with `bifrost-`. OpenCode identifies a skill by the directory name it is
 * installed in, so we keep all three concepts apart:
 *
 * - `name`:  the raw Bifrost skill name, used for HTTP routes.
 * - `id`:    the kebab-case OpenCode skill id (directory name).
 * - `plugin`: the Claude Code marketplace plugin name (`bifrost-<name>`).
 */

/** Where a skill is installed. */
export type InstallScope = "global" | "project";

/** How the catalog was discovered. */
/**
 * The source used to build the catalog. The client first tries the marketplace manifest;
 * if that fails or is empty it falls back to the public all‑skills bundle (`zip`).
 */
export type CatalogSource = "marketplace" | "zip";

export interface SkillSummary {
  /** Raw Bifrost skill name. Used for `/api/skills/serve/{name}/download.zip`. */
  name: string;
  /** OpenCode skill id (directory name, kebab-case). */
  id: string;
  description?: string;
  version?: string;
  /** Present when the catalog came from the Claude Code marketplace. */
  plugin?: string;
}

/**
 * A warning emitted while building the catalog. At the moment this is just a string,
 * but a dedicated type makes it easier to evolve to a richer structure later.
 */
export type CatalogWarning = string;

export interface Catalog {
  baseUrl: string;
  source: CatalogSource;
  fetchedAt: string;
  skills: SkillSummary[];
  /** Non-fatal problems encountered while building the catalog. */
  warnings: CatalogWarning[];
}

/** Persisted next to an installed skill as `.bifrost-skill.json`. */
export interface InstalledSkill {
  schema: 1;
  id: string;
  /** Raw Bifrost skill name. */
  name: string;
  description?: string;
  version?: string;
  scope: InstallScope;
  /** Absolute directory of the installed skill. */
  directory: string;
  baseUrl: string;
  installedAt: string;
  updatedAt?: string;
  /** SHA-256 over the installed file names and contents. */
  contentHash: string;
  source: "bifrost";
}

export type InstallAction = "installed" | "overwritten" | "updated" | "unchanged";

export interface InstallResult {
  id: string;
  name: string;
  description?: string;
  version?: string;
  directory: string;
  scope: InstallScope;
  action: InstallAction;
  contentHash: string;
}

export interface Failure {
  name: string;
  message: string;
}

export interface InstallBatchResult {
  results: InstallResult[];
  failures: Failure[];
  /** Skills that already existed and were left untouched (no `--force`). */
  skipped: Failure[];
}

export interface UpdateResult {
  results: InstallResult[];
  failures: Failure[];
  unchanged: InstallResult[];
}

export interface RemoveResult {
  removed: Array<{
    id: string;
    name: string;
    directory: string;
    scope: InstallScope;
  }>;
}

/** Settings as persisted in plugin storage. */
export interface StoredSettings {
  baseUrl?: string;
  timeoutMs?: number;
}

/** Settings after applying storage -> options -> environment precedence. */
export interface ResolvedSettings {
  baseUrl: string;
  timeoutMs: number;
  /** Where the base URL came from, for `/bifrost-config` output. */
  baseUrlSource: "command" | "storage" | "options" | "environment" | "default";
}

export interface ConfigPatch {
  baseUrl?: string;
  timeoutMs?: number;
  reset?: boolean;
}

export interface ConfigSummary {
  baseUrl: string;
  baseUrlSource: ResolvedSettings["baseUrlSource"];
  timeoutMs: number;
  globalSkillsDirectory: string;
}

export interface Target {
  scope: InstallScope;
  /** Skills root directory (the parent of skill directories). */
  root: string;
  /** Session/project directory; only set for project scope. */
  directory?: string;
}
