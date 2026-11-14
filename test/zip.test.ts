import { describe, expect, test } from "bun:test";
import {
  decodeSkillArchive,
  decodeZip,
  fileMode,
  hashFiles,
  normalizeEntryName,
  parsePackages,
  parseSkillMarkdown,
  type SkillPackage,
  skillId,
  versionFromFrontmatter,
  ZipError,
} from "../src/zip.js";
import { makeZip, skillMarkdown } from "./helpers.js";

describe("normalizeEntryName", () => {
  test("normalizes separators and dot segments", () => {
    expect(normalizeEntryName("skill\\references/./a.md")).toBe("skill/references/a.md");
  });

  test("rejects absolute paths and traversal", () => {
    for (const name of ["/etc/passwd", "C:/Windows", "../escape", "a/../../b", "\0bad"]) {
      expect(() => normalizeEntryName(name)).toThrow(ZipError);
    }
  });
});

describe("decodeZip", () => {
  test("decodes and skips directory entries", () => {
    const files = decodeZip(makeZip({ "skill/SKILL.md": skillMarkdown("A skill") }));
    expect([...files.keys()]).toEqual(["skill/SKILL.md"]);
  });

  test("rejects an empty archive", () => {
    expect(() => decodeZip(new Uint8Array())).toThrow(/empty/);
  });

  test("accepts a valid empty zip", () => {
    expect(decodeZip(makeZip({})).size).toBe(0);
  });

  test("rejects a corrupt archive", () => {
    expect(() => decodeZip(new TextEncoder().encode("not a zip"))).toThrow(/valid zip/);
  });
});

describe("parsePackages", () => {
  test("groups files by skill directory", () => {
    const files = decodeZip(
      makeZip({
        "git-release/SKILL.md": skillMarkdown("Releases"),
        "git-release/scripts/release.sh": "echo hi",
        "changelog/SKILL.md": skillMarkdown("Changelogs"),
      }),
    );
    const packages = parsePackages(files);
    expect(packages.map((pkg) => pkg.name)).toEqual(["changelog", "git-release"]);
    const release = packages.find((pkg) => pkg.name === "git-release") as SkillPackage;
    expect([...release.files.keys()].sort()).toEqual(["SKILL.md", "scripts/release.sh"]);
    expect(release.description).toBe("Releases");
  });

  test("keeps a nested package out of its parent", () => {
    const files = decodeZip(
      makeZip({
        "parent/SKILL.md": skillMarkdown("Parent"),
        "parent/child/SKILL.md": skillMarkdown("Child"),
      }),
    );
    const packages = parsePackages(files);
    expect(packages.map((pkg) => pkg.name)).toEqual(["parent"]);
    expect([...(packages[0] as { files: Map<string, Uint8Array> }).files.keys()].sort()).toEqual([
      "SKILL.md",
    ]);
  });

  test("reads a root SKILL.md", () => {
    const files = decodeZip(makeZip({ "SKILL.md": skillMarkdown("Root") }));
    const packages = parsePackages(files);
    expect(packages).toHaveLength(1);
    expect(packages[0]?.root).toBe("");
    expect(packages[0]?.name).toBe("Example Skill");
    expect(packages[0]?.suggestedId).toBe("example-skill");
  });

  test("returns nothing for an archive without SKILL.md", () => {
    expect(decodeSkillArchive(makeZip({ "readme.md": "hi" }))).toEqual([]);
  });
});

describe("parseSkillMarkdown", () => {
  test("reads YAML frontmatter", () => {
    const parsed = parseSkillMarkdown(
      "---\nname: Demo\ndescription: Works\ntags:\n  - a\n---\nBody\n",
    );
    expect(parsed.frontmatter.name).toBe("Demo");
    expect(parsed.frontmatter.tags).toEqual(["a"]);
    expect(parsed.body).toBe("Body\n");
  });

  test("treats invalid YAML as no frontmatter", () => {
    const parsed = parseSkillMarkdown("---\nname: [unclosed\n---\nBody");
    expect(parsed.frontmatter).toEqual({});
  });

  test("leaves plain markdown alone", () => {
    expect(parseSkillMarkdown("# Hi")).toEqual({ frontmatter: {}, body: "# Hi" });
  });

  test("finds versions in metadata", () => {
    expect(versionFromFrontmatter({ version: "1.2.3" })).toBe("1.2.3");
    expect(versionFromFrontmatter({ metadata: { version: 2 } })).toBe("2");
    expect(versionFromFrontmatter({})).toBeUndefined();
  });
});

describe("skillId", () => {
  test("produces safe directory names", () => {
    expect(skillId("Git Release")).toBe("git-release");
    expect(skillId("  --Weird__Name!! ")).toBe("weird__name");
    expect(skillId("***")).toBe("bifrost-skill");
  });

  test("keeps dots and underscores", () => {
    expect(skillId("a.b_c")).toBe("a.b_c");
  });
});

describe("fileMode", () => {
  test("marks shebang files executable and everything else 0644", () => {
    expect(fileMode(new TextEncoder().encode("#!/bin/sh\necho hi\n"))).toBe(0o755);
    expect(fileMode(new TextEncoder().encode("# not a shebang\n"))).toBe(0o644);
    expect(fileMode(new TextEncoder().encode("#"))).toBe(0o644);
    expect(fileMode(new Uint8Array())).toBe(0o644);
    expect(fileMode(new TextEncoder().encode("plain text"))).toBe(0o644);
  });
});

describe("hashFiles", () => {
  test("changes with names and contents", () => {
    const encoder = new TextEncoder();
    const one = new Map([["a", encoder.encode("1")]]);
    const two = new Map([["a", encoder.encode("2")]]);
    const renamed = new Map([["b", encoder.encode("1")]]);
    expect(hashFiles(one)).not.toBe(hashFiles(two));
    expect(hashFiles(one)).not.toBe(hashFiles(renamed));
    expect(hashFiles(one)).toBe(hashFiles(new Map([["a", encoder.encode("1")]])));
  });
});
