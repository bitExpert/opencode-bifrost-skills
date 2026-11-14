import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BifrostError } from "../src/bifrost.js";
import {
  displayPath,
  globalSkillsDirectory,
  projectSkillsDirectory,
  resolveTarget,
  SettingsStore,
} from "../src/settings.js";
import { memoryStorage } from "./helpers.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "bifrost-settings-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function store(
  storage: ReturnType<typeof memoryStorage>,
  options: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = {},
) {
  return new SettingsStore({ storage, options, env, home });
}

describe("settings paths", () => {
  test("uses XDG_CONFIG_HOME for global skills", () => {
    expect(globalSkillsDirectory({ XDG_CONFIG_HOME: "/tmp/xdg" }, "/home/me")).toBe(
      "/tmp/xdg/opencode/skills",
    );
  });

  test("uses ~/.config by default", () => {
    expect(globalSkillsDirectory({}, "/home/me")).toBe("/home/me/.config/opencode/skills");
  });

  test("honours OPENCODE_CONFIG_DIR", () => {
    expect(globalSkillsDirectory({ OPENCODE_CONFIG_DIR: "~/custom" }, "/home/me")).toBe(
      "/home/me/custom/skills",
    );
  });

  test("resolves project skills under .opencode", () => {
    expect(projectSkillsDirectory("/work/project")).toBe("/work/project/.opencode/skills");
  });

  test("project scope requires a directory", () => {
    expect(() => resolveTarget("project")).toThrow(BifrostError);
  });

  test("displays paths relative to home", () => {
    expect(displayPath("/home/me/.config/opencode/skills", "/home/me")).toBe(
      "~/.config/opencode/skills",
    );
    expect(displayPath("/etc/skills", "/home/me")).toBe("/etc/skills");
  });
});

describe("SettingsStore precedence", () => {
  test("command beats storage beats options beats environment", async () => {
    const storage = memoryStorage({ settings: { baseUrl: "https://stored.test" } });

    expect(
      (
        await store(
          storage,
          { baseUrl: "https://options.test" },
          { BIFROST_URL: "https://env.test" },
        ).resolve()
      ).baseUrl,
    ).toBe("https://stored.test");
    expect(
      (
        await store(
          storage,
          { baseUrl: "https://options.test" },
          { BIFROST_URL: "https://env.test" },
        ).resolve({ baseUrl: "https://command.test" })
      ).baseUrl,
    ).toBe("https://command.test");
    expect(
      (
        await store(
          memoryStorage(),
          { baseUrl: "https://options.test" },
          { BIFROST_URL: "https://env.test" },
        ).resolve()
      ).baseUrl,
    ).toBe("https://options.test");
    expect(
      (await store(memoryStorage(), {}, { BIFROST_URL: "https://env.test" }).resolve()).baseUrl,
    ).toBe("https://env.test");
    expect((await store(memoryStorage()).resolve()).baseUrl).toBe("http://localhost:8080");
  });

  test("clearing an API key in storage shadows the environment", async () => {
    const storage = memoryStorage({ settings: { apiKey: "" } });
    const resolved = await store(storage, {}, { BIFROST_API_KEY: "env-key" }).resolve();
    expect(resolved.apiKey).toBeUndefined();
    expect(resolved.apiKeySource).toBe("none");
  });

  test("normalizes the base URL", async () => {
    const resolved = await store(
      memoryStorage(),
      {},
      { BIFROST_URL: "bifrost.example.com/" },
    ).resolve();
    expect(resolved.baseUrl).toBe("http://bifrost.example.com");
  });

  test("persists and resets settings", async () => {
    const storage = memoryStorage();
    const settings = store(storage);

    const summary = await settings
      .update({ baseUrl: "https://one.test/", apiKey: "secret-key", timeoutMs: 1234.4 })
      .then(() => settings.summary());
    expect(summary.baseUrl).toBe("https://one.test");
    expect(summary.hasApiKey).toBe(true);
    expect(summary.timeoutMs).toBe(1234);
    expect(summary.apiKeyHint).toBe("secr…-key");

    await settings.update({ reset: true });
    const reset = await settings.summary();
    expect(reset.baseUrl).toBe("http://localhost:8080");
    expect(reset.hasApiKey).toBe(false);
  });

  test("rejects an invalid base URL", async () => {
    await expect(store(memoryStorage()).update({ baseUrl: "ftp://nope" })).rejects.toThrow(
      BifrostError,
    );
  });
});
