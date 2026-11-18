import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Plugin } from "@opencode/plugin";
import plugin from "../src/index.js";
import { globalSkillsDirectory, MARKER_FILE } from "../src/settings.js";
import { makeZip, memoryStorage, skillMarkdown } from "./helpers.js";

type Context = Plugin.Context;

interface Harness {
  context: Context;
  commands: Map<string, { name: string; execute: (invocation: unknown) => Promise<void> }>;
  rpc: Map<string, (input: unknown, context: unknown) => Promise<unknown>>;
  notices: Array<{ kind: string; message: string; title: string }>;
  synthetic: Array<{ sessionID: string; text: string; description?: string; resume?: boolean }>;
  reloads: number;
  storage: ReturnType<typeof memoryStorage>;
}

let root: string;
let previousXdg: string | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

const state = {
  version: "1.0.0",
  bodies: new Map<string, string>(),
};

function body(_name: string, description: string, version: string): string {
  return skillMarkdown(description, `metadata:\n  version: ${version}\n`);
}

function allZip(): Uint8Array {
  return makeZip(
    Object.fromEntries(
      [...state.bodies.entries()].map(([name, markdown]) => [`${name}/SKILL.md`, markdown]),
    ),
  );
}

function startGateway(): string {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("marketplace.json")) {
        return Response.json({
          plugins: [...state.bodies.keys()].map((name) => ({
            name: `bifrost-${name}`,
            description: `${name} helper`,
            version: state.version,
          })),
        });
      }
      if (url.pathname === "/api/skills/serve/all/download.zip") {
        return new Response(allZip());
      }
      const match = /^\/api\/skills\/serve\/([^/]+)\/download\.zip$/.exec(url.pathname);
      if (match) {
        const name = decodeURIComponent(match[1] as string);
        const markdown = state.bodies.get(name);
        if (!markdown) return new Response("missing", { status: 404 });
        return new Response(makeZip({ [`${name}/SKILL.md`]: markdown }));
      }
      return new Response("missing", { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

async function setup(): Promise<Harness> {
  const storage = memoryStorage();
  const commands = new Map<
    string,
    { name: string; execute: (invocation: unknown) => Promise<void> }
  >();
  const rpc = new Map<string, (input: unknown, context: unknown) => Promise<unknown>>();
  const notices: Harness["notices"] = [];
  const synthetic: Harness["synthetic"] = [];
  let reloads = 0;

  const context = {
    options: {},
    storage,
    skill: {
      reload: async () => {
        reloads += 1;
      },
    },
    rpc: {
      register: async (
        _definition: unknown,
        handlers: Record<string, (input: unknown, context: unknown) => Promise<unknown>>,
      ) => {
        for (const [name, handler] of Object.entries(handlers)) rpc.set(name, handler);
        return {
          events: {
            emit: async (
              _name: string,
              payload: { kind: string; message: string; title: string },
            ) => {
              notices.push(payload);
            },
          },
          dispose: async () => undefined,
        };
      },
    },
    command: {
      transform: async (callback: (editor: { add: (definition: unknown) => void }) => void) => {
        callback({
          add: (definition) => {
            const command = definition as {
              name: string;
              execute: (invocation: unknown) => Promise<void>;
            };
            commands.set(command.name, command);
          },
        });
        return { dispose: async () => undefined };
      },
    },
    session: {
      get: async () => ({ location: { directory: path.join(root, "project") } }),
      synthetic: async (input: {
        sessionID: string;
        text: string;
        description?: string;
        resume?: boolean;
      }) => {
        synthetic.push(input);
      },
    },
  } as unknown as Context;

  await plugin.setup(context);
  return {
    context,
    commands,
    rpc,
    notices,
    synthetic,
    storage,
    get reloads() {
      return reloads;
    },
  };
}

async function run(
  harness: Harness,
  name: string,
  text: string,
  sessionID = "ses_test",
): Promise<void> {
  const command = harness.commands.get(name);
  if (!command) throw new Error(`Command ${name} was not registered`);
  await command.execute({ sessionID, prompt: { text }, delivery: "queue" });
}

function rpcError(type: string, message: string, data: Record<string, unknown>) {
  return { type, message, data };
}

const rpcContext = () => ({ signal: new AbortController().signal, error: rpcError });

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "bifrost-plugin-"));
  previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
  state.version = "1.0.0";
  state.bodies = new Map([["git-release", body("git-release", "Release helper", "1.0.0")]]);
});

afterEach(async () => {
  server?.stop(true);
  server = undefined;
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  await rm(root, { recursive: true, force: true });
});

describe("server plugin", () => {
  test("registers all slash commands", async () => {
    const harness = await setup();
    expect([...harness.commands.keys()].sort()).toEqual([
      "bifrost-config",
      "bifrost-install",
      "bifrost-list",
      "bifrost-remove",
      "bifrost-update",
    ]);
  });

  test("configures the gateway and installs through commands", async () => {
    const baseUrl = startGateway();
    const harness = await setup();

    await run(harness, "bifrost-config", `baseUrl=${baseUrl}`);
    expect(harness.storage.values.get("settings")).toMatchObject({ baseUrl });
    expect(harness.notices.at(-1)?.message).toBe("Bifrost settings saved.");

    await run(harness, "bifrost-install", "git-release");
    const directory = path.join(globalSkillsDirectory(), "git-release");
    expect(await readFile(path.join(directory, "SKILL.md"), "utf8")).toContain("Release helper");
    expect(JSON.parse(await readFile(path.join(directory, MARKER_FILE), "utf8")).version).toBe(
      "1.0.0",
    );
    expect(harness.notices.at(-1)).toMatchObject({
      kind: "success",
      message: "Installed git-release (global)",
    });
    expect(harness.synthetic.at(-1)?.text).toContain("**Installed git-release** v1.0.0 (global)");
    expect(harness.reloads).toBe(1);
  });

  test("rejects apiKey in /bifrost-config", async () => {
    const baseUrl = startGateway();
    const harness = await setup();

    await run(harness, "bifrost-config", `baseUrl=${baseUrl} apiKey=secret`);
    expect(harness.notices.at(-1)?.kind).toBe("error");
    expect(harness.notices.at(-1)?.message).toMatch(/API keys are no longer supported/i);
  });

  test("lists, updates, and removes", async () => {
    const baseUrl = startGateway();
    const harness = await setup();
    await run(harness, "bifrost-config", `baseUrl=${baseUrl}`);
    await run(harness, "bifrost-install", "git-release");
    await run(harness, "bifrost-list", "");
    expect(harness.synthetic.at(-1)?.text).toContain("| `git-release` | v1.0.0 | global |");

    state.version = "1.1.0";
    state.bodies.set("git-release", body("git-release", "Release helper v2", "1.1.0"));
    await run(harness, "bifrost-update", "git-release");
    expect(harness.synthetic.at(-1)?.text).toContain("**Updated 1 skill**");

    const directory = path.join(globalSkillsDirectory(), "git-release");
    expect(await readFile(path.join(directory, "SKILL.md"), "utf8")).toContain("Release helper v2");

    await run(harness, "bifrost-remove", "git-release");
    expect(harness.notices.at(-1)?.message).toBe("Removed 1 skill");
    await expect(stat(directory)).rejects.toBeDefined();
  });

  test("installs all skills into a project scope", async () => {
    state.bodies.set("changelog", body("changelog", "Changelog helper", "1.0.0"));
    const baseUrl = startGateway();
    const harness = await setup();
    await run(harness, "bifrost-config", `baseUrl=${baseUrl}`);
    await run(harness, "bifrost-install", "all --project");

    const project = path.join(root, "project", ".opencode", "skills");
    expect((await stat(path.join(project, "git-release"))).isDirectory()).toBe(true);
    expect((await stat(path.join(project, "changelog"))).isDirectory()).toBe(true);
    expect(harness.synthetic.at(-1)?.text).toContain("**Installed 2 skills**");
  });

  test("installs all skills explicitly with selector", async () => {
    state.bodies.set("changelog", body("changelog", "Changelog helper", "1.0.0"));
    const baseUrl = startGateway();
    const harness = await setup();
    await run(harness, "bifrost-config", `baseUrl=${baseUrl}`);
    await run(harness, "bifrost-install", "all --project");

    const project = path.join(root, "project", ".opencode", "skills");
    expect((await stat(path.join(project, "git-release"))).isDirectory()).toBe(true);
    expect((await stat(path.join(project, "changelog"))).isDirectory()).toBe(true);
    expect(harness.synthetic.at(-1)?.text).toContain("**Installed 2 skills**");
  });

  test("installs with wildcard selector", async () => {
    state.bodies.set("changelog", body("changelog", "Changelog helper", "1.0.0"));
    const baseUrl = startGateway();
    const harness = await setup();
    await run(harness, "bifrost-config", `baseUrl=${baseUrl}`);
    await run(harness, "bifrost-install", "*");

    const global = globalSkillsDirectory();
    expect((await stat(path.join(global, "git-release"))).isDirectory()).toBe(true);
    expect((await stat(path.join(global, "changelog"))).isDirectory()).toBe(true);
    expect(harness.synthetic.at(-1)?.text).toContain("**Installed 2 skills**");
  });

  test("reports command failures in the transcript", async () => {
    const harness = await setup();
    await run(harness, "bifrost-install", "git-release");
    expect(harness.synthetic.at(-1)?.text).toContain("Bifrost skills error");
    expect(harness.notices.at(-1)?.kind).toBe("error");
  });

  test("lists the catalog when /bifrost-install has no selector", async () => {
    const baseUrl = startGateway();
    const harness = await setup();
    await run(harness, "bifrost-config", `baseUrl=${baseUrl}`);
    await run(harness, "bifrost-install", "");

    const text = harness.synthetic.at(-1)?.text ?? "";
    expect(text).toContain("**Available Bifrost skills (1)**");
    expect(text).toContain("| `git-release` | v1.0.0 | — |");
    expect(text).toContain("git-release helper");
    expect(text).toContain("Install with `/bifrost-install <skill>");
    expect(harness.notices.at(-1)?.message).toContain("1 skill from marketplace");
  });

  test("listing the catalog writes no skills", async () => {
    const baseUrl = startGateway();
    const harness = await setup();
    await run(harness, "bifrost-config", `baseUrl=${baseUrl}`);
    await run(harness, "bifrost-install", "");

    await expect(stat(globalSkillsDirectory())).rejects.toBeDefined();
    await expect(stat(path.join(root, "project", ".opencode", "skills"))).rejects.toBeDefined();
    expect(harness.reloads).toBe(0);
  });

  test("marks already installed skills in the catalog", async () => {
    const baseUrl = startGateway();
    const harness = await setup();
    await run(harness, "bifrost-config", `baseUrl=${baseUrl}`);
    await run(harness, "bifrost-install", "git-release");
    await run(harness, "bifrost-install", "");

    const text = harness.synthetic.at(-1)?.text ?? "";
    expect(text).toContain("| `git-release` | v1.0.0 | ✓ global |");
    expect(text).toContain("✓ already installed");
  });

  test("reports an empty catalog gracefully", async () => {
    state.bodies.clear();
    const baseUrl = startGateway();
    const harness = await setup();
    await run(harness, "bifrost-config", `baseUrl=${baseUrl}`);
    await run(harness, "bifrost-install", "");

    const text = harness.synthetic.at(-1)?.text ?? "";
    expect(text).toContain("No skills found in the catalog");
    expect(text).toContain(baseUrl);
  });

  test("/bifrost-update requires a selector", async () => {
    const baseUrl = startGateway();
    const harness = await setup();
    await run(harness, "bifrost-config", `baseUrl=${baseUrl}`);
    await run(harness, "bifrost-install", "git-release");
    await run(harness, "bifrost-update", "");

    const text = harness.synthetic.at(-1)?.text ?? "";
    expect(text).toContain("Usage: `/bifrost-update <skill>|all");
    expect(text).not.toContain("Updated");
    expect(harness.notices.at(-1)).toMatchObject({
      kind: "info",
      message: "A skill name or `all` is required.",
    });
  });

  test("/bifrost-remove reports missing arguments as info", async () => {
    const harness = await setup();
    await run(harness, "bifrost-remove", "");

    const text = harness.synthetic.at(-1)?.text ?? "";
    expect(text).toContain("Usage: `/bifrost-remove <skill>");
    expect(harness.notices.at(-1)).toMatchObject({
      kind: "info",
      message: "A skill name is required.",
    });
  });

  test("serves catalog, install, and list over RPC", async () => {
    const baseUrl = startGateway();
    const harness = await setup();
    await run(harness, "bifrost-config", `baseUrl=${baseUrl}`);

    const catalog = (await (
      harness.rpc.get("catalog") as (input: unknown, ctx: unknown) => Promise<unknown>
    )({}, rpcContext())) as {
      source: string;
      skills: Array<{
        id: string;
        name: string;
        description?: string;
        plugin?: string;
        version?: string;
      }>;
    };
    expect(catalog.source).toBe("marketplace");
    expect(catalog.skills).toEqual([
      {
        name: "git-release",
        id: "git-release",
        plugin: "bifrost-git-release",
        description: "git-release helper",
        version: "1.0.0",
      },
    ]);

    const installed = await (
      harness.rpc.get("install") as (input: unknown, ctx: unknown) => Promise<unknown>
    )(
      { name: "git-release", scope: "global", directory: path.join(root, "project") },
      rpcContext(),
    );
    expect(installed).toMatchObject({ id: "git-release", scope: "global", action: "installed" });

    const listed = (await (
      harness.rpc.get("list") as (input: unknown, ctx: unknown) => Promise<unknown>
    )({ directory: path.join(root, "project") }, rpcContext())) as {
      skills: Array<{ id: string }>;
    };
    expect(listed.skills.map((skill) => skill.id)).toEqual(["git-release"]);
  });

  test("returns RPC errors for missing skills", async () => {
    const baseUrl = startGateway();
    const harness = await setup();
    await run(harness, "bifrost-config", `baseUrl=${baseUrl}`);

    await expect(
      (harness.rpc.get("install") as (input: unknown, ctx: unknown) => Promise<unknown>)(
        { name: "missing", scope: "global" },
        rpcContext(),
      ),
    ).resolves.toMatchObject({ type: "failed" });
  });
});
