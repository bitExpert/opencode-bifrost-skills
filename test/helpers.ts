import type { Plugin } from "@opencode/plugin";
import { strToU8, zipSync } from "fflate";
import { BifrostError, type Gateway } from "../src/bifrost.js";
import type { Catalog, SkillSummary } from "../src/types.js";

export type StorageDomain = Plugin.Context["storage"];

/** In-memory stand-in for OpenCode's storage domain. */
export function memoryStorage(initial: Record<string, unknown> = {}): StorageDomain & {
  readonly values: Map<string, unknown>;
} {
  const values = new Map<string, unknown>(Object.entries(initial));
  return {
    values,
    get: async (key) => values.get(key),
    set: async (key, value) => {
      values.set(key, value);
    },
    remove: async (key) => {
      values.delete(key);
    },
    scan: async (options) => {
      const entries = [...values.entries()]
        .filter(([key]) => key.startsWith(options.prefix))
        .map(([key, value]) => ({ key, value }));
      return { entries };
    },
  } as StorageDomain & { readonly values: Map<string, unknown> };
}

export function makeZip(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([name, body]) => [name, strToU8(body)])),
  );
}

export function skillMarkdown(description: string, extra = ""): string {
  return `---\nname: Example Skill\ndescription: ${description}\n${extra}---\n\n# Example\n\nBody.\n`;
}

export interface MockGatewayOptions {
  skills?: Array<{ name: string; description?: string; version?: string }>;
  archives?: Record<string, Uint8Array>;
  all?: Uint8Array;
  onDownloadSkill?: (name: string) => Uint8Array;
}

/** A Gateway whose catalog and archives are fixed, for filesystem tests. */
export function mockGateway(options: MockGatewayOptions = {}): Gateway & {
  readonly downloads: string[];
  readonly catalogs: number;
} {
  const skills: SkillSummary[] = (options.skills ?? []).map((skill) => ({
    name: skill.name,
    id: skill.name,
    ...(skill.description ? { description: skill.description } : {}),
    ...(skill.version ? { version: skill.version } : {}),
  }));
  const downloads: string[] = [];
  let catalogs = 0;

  return {
    baseUrl: "http://gateway.test",
    downloads,
    get catalogs() {
      return catalogs;
    },
    catalog: async (): Promise<Catalog> => {
      catalogs += 1;
      return {
        baseUrl: "http://gateway.test",
        source: "marketplace",
        fetchedAt: new Date(0).toISOString(),
        skills,
        warnings: [],
      };
    },
    downloadSkill: async (name: string): Promise<Uint8Array> => {
      downloads.push(name);
      if (options.onDownloadSkill) return options.onDownloadSkill(name);
      const archive = options.archives?.[name];
      if (!archive) throw new BifrostError("not-found", `No mock archive for '${name}'`);
      return archive;
    },
    downloadAll: async (): Promise<Uint8Array> => {
      if (!options.all) throw new Error("No mock all-skills bundle");
      return options.all;
    },
  };
}
