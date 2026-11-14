/**
 * ZIP handling for Bifrost skill archives.
 *
 * Bifrost serves a zip per skill (`<name>/SKILL.md` plus attached files) and
 * one bundle for all skills. Archives come from the network, so every entry
 * is validated before anything touches the filesystem:
 *
 * - no absolute paths, drive letters, backslashes or `..` segments
 * - a cap on entry count, entry size and total uncompressed size
 * - only stored/deflated entries (fflate rejects unsupported methods)
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { unzipSync, type UnzipFileInfo } from "fflate";
import { parse as parseYaml } from "yaml";

export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_ENTRIES = 2_000;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export type ZipErrorCode = "corrupt" | "unsafe-path" | "too-large" | "too-many-files";

export class ZipError extends Error {
  readonly code: ZipErrorCode;

  constructor(code: ZipErrorCode, message: string) {
    super(message);
    this.name = "ZipError";
    this.code = code;
  }
}

export interface SkillPackage {
  /** Directory prefix inside the archive; empty when SKILL.md sits at the root. */
  root: string;
  /** Files relative to `root`, including `SKILL.md`. */
  files: Map<string, Uint8Array>;
  /** Raw `SKILL.md` contents. */
  markdown: string;
  frontmatter: Record<string, unknown>;
  body: string;
  /** Display name from frontmatter, when present. */
  displayName?: string;
  description?: string;
  version?: string;
  /** The archive directory name, suitable as a Bifrost skill name. */
  name: string;
  /** A safe OpenCode skill id derived from the archive directory name. */
  suggestedId: string;
}

export function isZipError(error: unknown): error is ZipError {
  return error instanceof ZipError;
}

/** Normalizes an archive entry to a safe relative path, or throws. */
export function normalizeEntryName(raw: string): string {
  if (raw.includes("\0")) {
    throw new ZipError("unsafe-path", "Archive contains a path with a NUL byte.");
  }
  const slashed = raw.replace(/\\/g, "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed)) {
    throw new ZipError("unsafe-path", `Archive contains an absolute path: ${raw}`);
  }
  const segments: string[] = [];
  for (const segment of slashed.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      throw new ZipError("unsafe-path", `Archive contains a path traversal: ${raw}`);
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    throw new ZipError("unsafe-path", `Archive contains an empty path: ${raw}`);
  }
  return segments.join("/");
}

/**
 * Decompresses an archive with size limits applied before decompression.
 * Throws `ZipError` for unsafe or oversized archives.
 */
export function decodeZip(data: Uint8Array): Map<string, Uint8Array> {
  if (data.byteLength === 0) {
    throw new ZipError("corrupt", "The skill archive is empty.");
  }
  if (data.byteLength > MAX_ARCHIVE_BYTES) {
    throw new ZipError("too-large", "The skill archive exceeds the 64 MiB download limit.");
  }

  let entries = 0;
  let total = 0;
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(data, {
      filter: (file: UnzipFileInfo) => {
        entries += 1;
        if (entries > MAX_ENTRIES) {
          throw new ZipError("too-many-files", `Archive contains more than ${MAX_ENTRIES} entries.`);
        }
        // Directory entries carry a trailing slash and zero bytes.
        if (file.name.replace(/\\/g, "/").endsWith("/")) return true;
        if (file.originalSize > MAX_FILE_BYTES) {
          throw new ZipError("too-large", `Archive entry '${file.name}' exceeds the 8 MiB file limit.`);
        }
        total += file.originalSize;
        if (total > MAX_TOTAL_BYTES) {
          throw new ZipError("too-large", "Archive exceeds the 64 MiB uncompressed limit.");
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ZipError) throw error;
    throw new ZipError("corrupt", `The skill archive is not a valid zip file: ${messageOf(error)}`);
  }

  const files = new Map<string, Uint8Array>();
  for (const [rawName, bytes] of Object.entries(unzipped)) {
    if (rawName.replace(/\\/g, "/").endsWith("/")) continue;
    const name = normalizeEntryName(rawName);
    files.set(name, bytes);
  }

  return files;
}

/** Splits a decoded archive into skill packages, one per `SKILL.md`. */
export function parsePackages(files: Map<string, Uint8Array>): SkillPackage[] {
  const roots: string[] = [];
  for (const name of files.keys()) {
    if (name === "SKILL.md") roots.push("");
    else if (name.endsWith("/SKILL.md")) roots.push(name.slice(0, -"/SKILL.md".length));
  }

  roots.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));

  const packages: SkillPackage[] = [];
  for (const root of roots) {
    // A SKILL.md nested inside another package is part of that package's
    // files, not an independent skill.
    if (roots.some((other) => other !== root && isInside(root, other))) continue;

    const nested = roots.filter((other) => other !== root && isInside(other, root));
    const prefix = root === "" ? "" : `${root}/`;
    const packageFiles = new Map<string, Uint8Array>();
    for (const [name, bytes] of files) {
      if (!name.startsWith(prefix)) continue;
      const relative = name.slice(prefix.length);
      if (relative === "") continue;
      if (nested.some((other) => name.startsWith(`${other}/`))) continue;
      packageFiles.set(relative, bytes);
    }

    const skillMd = packageFiles.get("SKILL.md");
    if (!skillMd) continue;

    const markdown = decodeText(skillMd);
    const parsed = parseSkillMarkdown(markdown);
    const rootName = root === "" ? "" : path.posix.basename(root);
    const displayName = stringValue(parsed.frontmatter.name);
    const name = rootName || displayName || "skill";
    const description = stringValue(parsed.frontmatter.description);
    packages.push({
      root,
      files: packageFiles,
      markdown,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      displayName,
      description,
      version: versionFromFrontmatter(parsed.frontmatter),
      name,
      suggestedId: skillId(name),
    });
  }

  return packages;
}

export function decodeSkillArchive(data: Uint8Array): SkillPackage[] {
  return parsePackages(decodeZip(data));
}

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Parses YAML frontmatter from a Markdown document.
 *
 * Invalid YAML is treated as no frontmatter: the file still installs, and the
 * description check tells the user why OpenCode may not advertise it.
 */
export function parseSkillMarkdown(content: string): ParsedMarkdown {
  const text = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---")) return { frontmatter: {}, body: text };

  const firstLineEnd = text.indexOf("\n");
  if (firstLineEnd === -1) return { frontmatter: {}, body: text };
  const firstLine = text.slice(0, firstLineEnd).trim();
  if (firstLine !== "---") return { frontmatter: {}, body: text };

  const closing = /^---\s*$/m;
  const rest = text.slice(firstLineEnd + 1);
  const match = closing.exec(rest);
  if (!match) return { frontmatter: {}, body: text };

  const yamlText = rest.slice(0, match.index);
  const body = rest.slice(match.index + match[0].length).replace(/^\n/, "");
  try {
    const value = parseYaml(yamlText);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { frontmatter: {}, body };
    }
    return { frontmatter: value as Record<string, unknown>, body };
  } catch {
    return { frontmatter: {}, body };
  }
}

/** Picks a version from common frontmatter locations. */
export function versionFromFrontmatter(frontmatter: Record<string, unknown>): string | undefined {
  const direct = stringValue(frontmatter.version) ?? stringValue(frontmatter["skill-version"]);
  if (direct) return direct;

  const metadata = frontmatter.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const record = metadata as Record<string, unknown>;
    return (
      stringValue(record.version) ??
      stringValue(record["bifrost/version"]) ??
      stringValue(record["skill/version"])
    );
  }
  return undefined;
}

/** Converts a Bifrost skill name into a safe OpenCode skill id. */
export function skillId(name: string): string {
  const id = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/[.-]+$/, "");
  return id || "bifrost-skill";
}

/** Stable SHA-256 over sorted file names and contents. */
export function hashFiles(files: Map<string, Uint8Array>): string {
  const hash = createHash("sha256");
  for (const name of [...files.keys()].sort()) {
    const bytes = files.get(name)!;
    hash.update(name);
    hash.update("\0");
    hash.update(String(bytes.byteLength));
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Picks the filesystem mode for an installed file.
 *
 * fflate does not expose the zip's Unix permission bits, so executability is
 * derived from the content: files starting with a shebang (`#!`) are written
 * executable, everything else is read-only for group/other (0644).
 */
export function fileMode(bytes: Uint8Array): number {
  return bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x21 ? 0o755 : 0o644;
}

export function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

function depth(root: string): number {
  if (!root) return 0;
  return root.split("/").length;
}

function isInside(child: string, parent: string): boolean {
  if (parent === "") return child !== "";
  return child === parent || child.startsWith(`${parent}/`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
