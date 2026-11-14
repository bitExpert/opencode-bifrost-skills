import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BifrostError } from "../src/bifrost.js";
import { compareVersions, Operations, readMarker, resolveInput } from "../src/operations.js";
import { MARKER_FILE, globalSkillsDirectory } from "../src/settings.js";
import { hashFiles, skillId } from "../src/zip.js";
import { makeZip, memoryStorage, mockGateway, skillMarkdown, type MockGatewayOptions } from "./helpers.js";

let root: string;
let previousHome: string | undefined;
let previousXdg: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "bifrost-ops-"));
  previousHome = process.env.HOME;
  previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
});

afterEach(async () => {
  process.env.HOME = previousHome;
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  await rm(root, { recursive: true, force: true });
});

function operations(options: MockGatewayOptions, storage = memoryStorage()) {
  const gateway = mockGateway(options);
  const ops = new Operations({
    storage,
    options: {},
    env: {},
    gatewayFactory: () => gateway,
    now: () => new Date("2026-01-02T03:04:05.000Z"),
  });
  return { ops, gateway, storage };
}

function releaseArchive(description = "Release helper", version = "1.0.0") {
  return makeZip({
    "git-release/SKILL.md": skillMarkdown(description, `metadata:\n  version: ${version}\n`),
    "git-release/scripts/release.sh": "#!/bin/sh\n",
  });
}

const catalog = {
  skills: [{ name: "git-release", description: "Release helper", version: "1.0.0" }],
  archives: { "git-release": releaseArchive() },
};

describe("install", () => {
  test("installs a skill globally with a marker", async () => {
    const { ops, gateway } = operations(catalog);
    const result = await ops.install({ name: "git-release", scope: "global" });

    expect(result.action).toBe("installed");
    expect(result.id).toBe("git-release");
    expect(result.version).toBe("1.0.0");
    expect(gateway.downloads).toEqual(["git-release"]);

    const skillDirectory = path.join(globalSkillsDirectory(), "git-release");
    expect(await readFile(path.join(skillDirectory, "SKILL.md"), "utf8")).toContain("Release helper");
    const script = path.join(skillDirectory, "scripts", "release.sh");
    expect(await readFile(script, "utf8")).toBe("#!/bin/sh\n");
    // The shebang script keeps its executable bit.
    expect((await stat(script)).mode & 0o111).not.toBe(0);
    expect((await stat(path.join(skillDirectory, "SKILL.md"))).mode & 0o777).toBe(0o644);

    const marker = JSON.parse(await readFile(path.join(skillDirectory, MARKER_FILE), "utf8"));
    expect(marker.id).toBe("git-release");
    expect(marker.source).toBe("bifrost");
    expect(marker.scope).toBe("global");
    expect(marker.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("refuses to overwrite without force", async () => {
    const { ops } = operations(catalog);
    await ops.install({ name: "git-release", scope: "global" });
    await expect(ops.install({ name: "git-release", scope: "global" })).rejects.toMatchObject({
      code: "exists",
    });
  });

  test("forces an overwrite and keeps the install time", async () => {
    const { ops } = operations(catalog);
    const first = await ops.install({ name: "git-release", scope: "global" });
    const second = await ops.install({ name: "git-release", scope: "global", force: true });
    expect(second.action).toBe("overwritten");

    const marker = await readMarker(first.directory);
    expect(marker?.installedAt).toBe("2026-01-02T03:04:05.000Z");
    expect(marker?.updatedAt).toBe("2026-01-02T03:04:05.000Z");
  });

  test("installs into a project scope", async () => {
    const project = path.join(root, "project");
    await rm(project, { recursive: true, force: true });
    const { ops } = operations(catalog);
    const result = await ops.install({ name: "git-release", scope: "project", directory: project });

    expect(result.scope).toBe("project");
    expect(result.directory).toBe(path.join(project, ".opencode", "skills", "git-release"));
    expect((await stat(result.directory)).isDirectory()).toBe(true);
  });

  test("installs by marketplace plugin name", async () => {
    const { ops } = operations(catalog);
    const result = await ops.install({ name: "bifrost-git-release", scope: "global" });
    expect(result.id).toBe("git-release");
  });

  test("installs by name when the catalog is empty", async () => {
    const { ops } = operations({ archives: { "git-release": releaseArchive() } });
    const result = await ops.install({ name: "git-release", scope: "global" });
    expect(result.id).toBe("git-release");
    expect(result.version).toBe("1.0.0");
  });

  test("rejects an archive without SKILL.md", async () => {
    const { ops } = operations({
      archives: { weird: makeZip({ "weird/readme.md": "hi" }) },
    });
    await expect(ops.install({ name: "weird", scope: "global" })).rejects.toMatchObject({ code: "corrupt" });
  });

  test("refuses to replace a foreign directory", async () => {
    const { ops } = operations(catalog);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(globalSkillsDirectory(), "git-release"), { recursive: true });
    await expect(ops.install({ name: "git-release", scope: "global" })).rejects.toMatchObject({
      code: "exists",
    });
  });
});

describe("installAll", () => {
  test("installs every package from the bundle", async () => {
    const bundle = makeZip({
      "git-release/SKILL.md": skillMarkdown("Release helper"),
      "changelog/SKILL.md": skillMarkdown("Changelog helper"),
    });
    const { ops } = operations({ all: bundle });
    const result = await ops.installAll({ scope: "global" });

    expect(result.results.map((item) => item.id).sort()).toEqual(["changelog", "git-release"]);
    expect(result.failures).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  test("skips existing skills without force", async () => {
    const bundle = makeZip({
      "git-release/SKILL.md": skillMarkdown("Release helper"),
      "changelog/SKILL.md": skillMarkdown("Changelog helper"),
    });
    const { ops } = operations({ all: bundle });
    await ops.installAll({ scope: "global" });
    const again = await ops.installAll({ scope: "global" });
    expect(again.skipped.map((item) => item.name).sort()).toEqual(["changelog", "git-release"]);
  });

  test("falls back to the catalog when the bundle is empty", async () => {
    const { ops } = operations({ ...catalog, all: makeZip({}) });
    const result = await ops.installAll({ scope: "global" });
    expect(result.results.map((item) => item.id)).toEqual(["git-release"]);
  });
});

describe("list", () => {
  test("lists global and project installs", async () => {
    const project = path.join(root, "project");
    const { ops } = operations(catalog);
    await ops.install({ name: "git-release", scope: "global" });
    await ops.install({ name: "git-release", scope: "project", directory: project, force: true });

    const listed = await ops.list(project);
    expect(listed.map((item) => item.scope)).toEqual(["global", "project"]);
  });
});

describe("update", () => {
  test("updates when the content changes", async () => {
    const first = operations(catalog);
    await first.ops.install({ name: "git-release", scope: "global" });

    const second = operations({
      skills: [{ name: "git-release", description: "Release helper", version: "1.1.0" }],
      archives: { "git-release": releaseArchive("New body", "1.1.0") },
    });
    const result = await second.ops.update({ name: "git-release" });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.action).toBe("updated");
    expect(result.results[0]!.version).toBe("1.1.0");
    expect(await readFile(path.join(globalSkillsDirectory(), "git-release", "SKILL.md"), "utf8")).toContain("New body");
  });

  test("reports unchanged content", async () => {
    const { ops } = operations(catalog);
    await ops.install({ name: "git-release", scope: "global" });
    const result = await ops.update({ name: "git-release" });
    expect(result.unchanged.map((item) => item.id)).toEqual(["git-release"]);
    expect(result.results).toEqual([]);
  });

  test("does not downgrade a newer install", async () => {
    const first = operations(catalog);
    await first.ops.install({ name: "git-release", scope: "global" });

    const newerStorage = memoryStorage();
    const marker = await readMarker(path.join(globalSkillsDirectory(), "git-release"));
    expect(marker).toBeDefined();

    const second = operations({ skills: [{ name: "git-release", version: "0.9.0" }], archives: { "git-release": releaseArchive("Old", "0.9.0") } }, newerStorage);
    // The installed marker still says 1.0.0, so the older remote is ignored.
    const result = await second.ops.update({ name: "git-release" });
    expect(result.results).toEqual([]);
    expect(await readFile(path.join(globalSkillsDirectory(), "git-release", "SKILL.md"), "utf8")).toContain("Release helper");
  });

  test("fails when nothing is installed", async () => {
    const { ops } = operations(catalog);
    await expect(ops.update({ name: "git-release" })).rejects.toBeInstanceOf(BifrostError);
  });
});

describe("remove", () => {
  test("removes a marked skill", async () => {
    const { ops, storage } = operations(catalog);
    const installed = await ops.install({ name: "git-release", scope: "global" });
    const result = await ops.remove({ name: "git-release" });

    expect(result.removed).toHaveLength(1);
    await expect(stat(installed.directory)).rejects.toBeDefined();
    expect([...storage.values.keys()].some((key) => key.includes("git-release"))).toBe(false);
  });

  test("refuses to remove a directory whose marker names another id", async () => {
    const { ops } = operations(catalog);
    const { mkdir, writeFile } = await import("node:fs/promises");
    const directory = path.join(globalSkillsDirectory(), "git-release");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, MARKER_FILE),
      JSON.stringify({
        schema: 1,
        id: "other",
        name: "git-release",
        scope: "global",
        directory,
        baseUrl: "http://gateway.test",
        installedAt: "2026-01-01T00:00:00.000Z",
        contentHash: "",
        source: "bifrost",
      }),
    );
    await expect(ops.remove({ name: "git-release" })).rejects.toMatchObject({ code: "unsafe" });
  });

  test("cannot remove an unmarked directory by name", async () => {
    const { ops } = operations(catalog);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(globalSkillsDirectory(), "git-release"), { recursive: true });
    await expect(ops.remove({ name: "git-release" })).rejects.toMatchObject({ code: "not-installed" });
  });

  test("refuses ambiguous scope", async () => {
    const project = path.join(root, "project");
    const { ops } = operations(catalog);
    await ops.install({ name: "git-release", scope: "global" });
    await ops.install({ name: "git-release", scope: "project", directory: project });
    await expect(ops.remove({ name: "git-release", directory: project })).rejects.toMatchObject({
      code: "invalid",
    });
  });
});

describe("helpers", () => {
  test("compares semantic versions", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.4", "1.2.3")).toBe(1);
    expect(compareVersions("1.2.3", "1.10.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-beta")).toBe(1);
    expect(compareVersions("nope", "1.0.0")).toBeUndefined();
  });

  test("resolves input against the catalog", () => {
    const entry = resolveInput("bifrost-git-release", {
      baseUrl: "http://x",
      source: "marketplace",
      fetchedAt: "",
      skills: [{ name: "git-release", id: "git-release", plugin: "bifrost-git-release" }],
      warnings: [],
    });
    expect(entry.id).toBe("git-release");
    expect(entry.candidates).toContain("git-release");

    const unknown = resolveInput("Some Skill", undefined);
    expect(unknown.id).toBe(skillId("Some Skill"));
  });

  test("hashes the installed files", () => {
    const files = new Map([["SKILL.md", new TextEncoder().encode("x")]]);
    expect(hashFiles(files)).toHaveLength(64);
  });
});
