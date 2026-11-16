/**
 * HTTP client for a Bifrost gateway's Skills Repository.
 *
 * Two catalog sources are tried in order:
 *
 * 1. `GET /api/skills/serve/claude-code/.claude-plugin/marketplace.json`
 *    (has versions; only registered when the gateway has an external client
 *    URL and `git` on PATH)
 * 2. `GET /api/skills/serve/all/download.zip` (public, but names and
 *    descriptions only, no versions)
 *
 * Installs always use the public per-skill zip endpoint, so they keep working
 * when both catalog endpoints are unavailable.
 */

import type { Catalog, CatalogSource, SkillSummary } from "./types.js";
import { decodeSkillArchive, MAX_ARCHIVE_BYTES, skillId, ZipError } from "./zip.js";

export type BifrostErrorCode =
  | "invalid"
  | "network"
  | "timeout"
  | "cancelled"
  | "unauthorized"
  | "not-found"
  | "unavailable"
  | "http"
  | "corrupt"
  | "exists"
  | "not-installed"
  | "unsafe";

export class BifrostError extends Error {
  readonly code: BifrostErrorCode;
  readonly status?: number;
  readonly retryAfter?: string;

  constructor(
    code: BifrostErrorCode,
    message: string,
    options?: { status?: number; retryAfter?: string },
  ) {
    super(message);
    this.name = "BifrostError";
    this.code = code;
    this.status = options?.status;
    this.retryAfter = options?.retryAfter;
  }
}

export interface Gateway {
  readonly baseUrl: string;
  catalog(signal?: AbortSignal): Promise<Catalog>;
  downloadSkill(name: string, signal?: AbortSignal): Promise<Uint8Array>;
  downloadAll(signal?: AbortSignal): Promise<Uint8Array>;
}

export interface ClientOptions {
  baseUrl: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new BifrostError("invalid", "The Bifrost gateway URL is empty.");

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new BifrostError("invalid", `'${input}' is not a valid gateway URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BifrostError("invalid", "The gateway URL must use http:// or https://.");
  }
  if (url.username || url.password) {
    throw new BifrostError(
      "invalid",
      "Do not put credentials in the gateway URL; use the apiKey option instead.",
    );
  }

  let pathname = url.pathname.replace(/\/+$/, "");
  // Accept a pasted `https://host/api` base URL without producing `/api/api`.
  if (pathname === "/api") pathname = "";
  else if (pathname.endsWith("/api")) pathname = pathname.slice(0, -"/api".length);

  return `${url.protocol}//${url.host}${pathname}`;
}

/** True when a URL can safely be used as a gateway base. */
export function isValidBaseUrl(input: string): boolean {
  try {
    normalizeBaseUrl(input);
    return true;
  } catch {
    return false;
  }
}

export class BifrostClient implements Gateway {
  readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.timeoutMs =
      options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  }

  async catalog(signal?: AbortSignal): Promise<Catalog> {
    const warnings: string[] = [];
    let lastSource: CatalogSource | undefined;

    const marketplace = await this.marketplaceCatalog(signal, warnings);
    if (marketplace) {
      lastSource = "marketplace";
      if (marketplace.length > 0) return this.catalogResult("marketplace", marketplace, warnings);
    } else {
      warnings.push("Marketplace manifest not available (HTTP 404). Using the public bundle.");
    }

    const archive = await this.zipCatalog(signal, warnings);
    if (archive) {
      lastSource = "zip";
      if (archive.length > 0) return this.catalogResult("zip", archive, warnings);
    } else {
      warnings.push("The all-skills bundle is unavailable or empty. Publish skills in the Bifrost dashboard.");
    }

    if (lastSource) return this.catalogResult(lastSource, [], warnings);

    throw new BifrostError(
      "unavailable",
      [
        `Could not read a skill catalog from ${this.baseUrl}.`,
        ...warnings.map((warning) => `- ${warning}`),
        "Install by name still works when the per-skill download route is public.",
      ].join("\n"),
    );
  }

  async downloadSkill(name: string, signal?: AbortSignal): Promise<Uint8Array> {
    if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
      throw new BifrostError("invalid", `'${name}' is not a valid Bifrost skill name.`);
    }
    const url = `${this.baseUrl}/api/skills/serve/${encodeURIComponent(name)}/download.zip`;
    return this.downloadArchive(url, signal, `Skill '${name}'`);
  }

  async downloadAll(signal?: AbortSignal): Promise<Uint8Array> {
    return this.downloadArchive(
      `${this.baseUrl}/api/skills/serve/all/download.zip`,
      signal,
      "The all-skills bundle",
    );
  }

  private catalogResult(
    source: CatalogSource,
    skills: SkillSummary[],
    warnings: string[],
  ): Catalog {
    return {
      baseUrl: this.baseUrl,
      source,
      fetchedAt: new Date().toISOString(),
      skills: dedupe(skills),
      warnings,
    };
  }

  private async marketplaceCatalog(
    signal: AbortSignal | undefined,
    warnings: string[],
  ): Promise<SkillSummary[] | undefined> {
    const url = `${this.baseUrl}/api/skills/serve/claude-code/.claude-plugin/marketplace.json`;
    const response = await this.tryRequest(url, { accept: "application/json", signal });
    if (!response) return undefined;

    try {
      const data = (await response.json()) as unknown;
      const plugins = readPlugins(data);
      if (!plugins) {
        warnings.push("The marketplace manifest did not contain a plugins array.");
        return [];
      }
      const skills: SkillSummary[] = [];
      for (const plugin of plugins) {
        const pluginName = stringField(plugin, "name");
        if (!pluginName) continue;
        const name = pluginName.startsWith("bifrost-")
          ? pluginName.slice("bifrost-".length)
          : pluginName;
        if (!name) continue;
        const description = stringField(plugin, "description");
        const version = stringField(plugin, "version");
        skills.push({
          name,
          id: skillId(name),
          plugin: pluginName,
          ...(description ? { description } : {}),
          ...(version ? { version } : {}),
        });
      }
      return skills;
    } catch (error) {
      warnings.push(`Could not parse the marketplace manifest: ${messageOf(error)}`);
      return undefined;
    }
  }

  private async zipCatalog(
    signal: AbortSignal | undefined,
    warnings: string[],
  ): Promise<SkillSummary[] | undefined> {
    let bytes: Uint8Array;
    try {
      bytes = await this.downloadAll(signal);
    } catch (error) {
      warnings.push(`All-skills bundle unavailable: ${messageOf(error)}`);
      return undefined;
    }
    try {
      const packages = decodeSkillArchive(bytes);
      return packages.map((pkg) => ({
        name: pkg.name,
        id: pkg.suggestedId,
        ...(pkg.description ? { description: pkg.description } : {}),
        ...(pkg.version ? { version: pkg.version } : {}),
      }));
    } catch (error) {
      warnings.push(`Could not read the all-skills bundle: ${messageOf(error)}`);
      return undefined;
    }
  }

  private async downloadArchive(
    url: string,
    signal: AbortSignal | undefined,
    label: string,
  ): Promise<Uint8Array> {
    const response = await this.request(url, {
      accept: "application/zip",
      signal,
      notFound: label,
    });
    const length = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(length) && length > MAX_ARCHIVE_BYTES) {
      throw new BifrostError("corrupt", `${label} archive is larger than the 64 MiB limit.`);
    }
    // Read the body with the timeout still armed and a running byte cap, so a
    // gateway that sends headers and then stalls (or streams gigabytes) can
    // neither hang the command nor exhaust memory before the cap applies.
    const bytes = await this.readBody(response, signal, label);
    if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
      throw new BifrostError("corrupt", `${label} archive is larger than the 64 MiB limit.`);
    }
    if (bytes.byteLength === 0) {
      throw new BifrostError("corrupt", `${label} archive is empty.`);
    }
    return bytes;
  }

  /** Reads a response body under the request timeout and the archive cap. */
  private async readBody(
    response: Response,
    signal: AbortSignal | undefined,
    label: string,
  ): Promise<Uint8Array> {
    if (!response.body) return new Uint8Array(await response.arrayBuffer());

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(
        new BifrostError(
          "timeout",
          `Reading the ${label.toLowerCase()} timed out after ${this.timeoutMs} ms.`,
        ),
      );
    }, this.timeoutMs);
    timeout.unref?.();
    const onAbort = () =>
      controller.abort(new BifrostError("cancelled", "The request was cancelled."));
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_ARCHIVE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new BifrostError("corrupt", `${label} archive is larger than the 64 MiB limit.`);
        }
        chunks.push(value);
      }
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    } catch (error) {
      if (error instanceof BifrostError) throw error;
      const reason = controller.signal.reason;
      if (reason instanceof BifrostError) throw reason;
      if (signal?.aborted) throw new BifrostError("cancelled", "The request was cancelled.");
      if (isAbort(error)) {
        throw new BifrostError(
          "timeout",
          `Reading the ${label.toLowerCase()} timed out after ${this.timeoutMs} ms.`,
        );
      }
      throw new BifrostError(
        "network",
        `Could not read the response from ${this.baseUrl}: ${messageOf(error)}`,
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Requests a URL, returning undefined for 404/503 when probing a catalog. */
  private async tryRequest(
    url: string,
    options: { accept: string; signal?: AbortSignal },
  ): Promise<Response | undefined> {
    try {
      return await this.request(url, { ...options, notFound: "catalog endpoint" });
    } catch (error) {
      if (
        error instanceof BifrostError &&
        (error.code === "not-found" || error.code === "unavailable")
      ) {
        return undefined;
      }
      throw error;
    }
  }

  private async request(
    url: string,
    options: { accept: string; signal?: AbortSignal; notFound: string },
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(
        new BifrostError(
          "timeout",
          `Request to ${this.baseUrl} timed out after ${this.timeoutMs} ms.`,
        ),
      );
    }, this.timeoutMs);
    timeout.unref?.();

    const onAbort = () =>
      controller.abort(new BifrostError("cancelled", "The request was cancelled."));
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    const headers: Record<string, string> = { accept: options.accept };

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers,
        redirect: "follow",
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof BifrostError) throw error;
      const reason = controller.signal.reason;
      if (reason instanceof BifrostError) throw reason;
      if (options.signal?.aborted)
        throw new BifrostError("cancelled", "The request was cancelled.");
      if (isAbort(error)) {
        throw new BifrostError(
          "timeout",
          `Request to ${this.baseUrl} timed out after ${this.timeoutMs} ms.`,
        );
      }
      throw new BifrostError(
        "network",
        `Could not reach ${this.baseUrl}: ${messageOf(error)}. Check the gateway URL and your network.`,
      );
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }

    if (response.ok) return response;

    const retryAfter = response.headers.get("retry-after") ?? undefined;
    const detail = await readErrorBody(response);
    const suffix = detail ? `: ${detail}` : "";

    if (response.status === 401 || response.status === 403) {
      throw new BifrostError(
        "unauthorized",
        `The gateway rejected the request (HTTP ${response.status})${suffix}. Check the gateway URL and your network.`,
        { status: response.status },
      );
    }
    if (response.status === 404) {
      throw new BifrostError(
        "not-found",
        `${options.notFound} was not found on ${this.baseUrl}${suffix}.`,
        {
          status: response.status,
        },
      );
    }
    if (response.status === 503) {
      throw new BifrostError(
        "unavailable",
        `${options.notFound} is temporarily unavailable (HTTP 503)${suffix}${
          retryAfter ? `. Retry after ${retryAfter}s.` : "."
        }`,
        { status: response.status, retryAfter },
      );
    }
    throw new BifrostError(
      "http",
      `${options.notFound} failed with HTTP ${response.status}${suffix}.`,
      {
        status: response.status,
      },
    );
  }
}

export function isBifrostError(error: unknown): error is BifrostError {
  return error instanceof BifrostError;
}

export function describeError(error: unknown): string {
  if (error instanceof BifrostError || error instanceof ZipError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function dedupe(skills: SkillSummary[]): SkillSummary[] {
  const seen = new Set<string>();
  const result: SkillSummary[] = [];
  for (const skill of skills) {
    const key = skill.name;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(skill);
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.trim() !== "" ? field.trim() : undefined;
}

function readPlugins(data: unknown): Array<Record<string, unknown>> | undefined {
  if (!data || typeof data !== "object") return undefined;
  const plugins = (data as { plugins?: unknown }).plugins;
  if (!Array.isArray(plugins)) return undefined;
  return plugins.filter(
    (item): item is Record<string, unknown> => !!item && typeof item === "object",
  );
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = (await response.text()).replace(/\s+/g, " ").trim();
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
  } catch {
    return "";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
