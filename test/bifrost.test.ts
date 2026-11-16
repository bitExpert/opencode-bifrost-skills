import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { BifrostClient, BifrostError, normalizeBaseUrl } from "../src/bifrost.js";
import { makeZip, skillMarkdown } from "./helpers.js";

let server: ReturnType<typeof Bun.serve> | undefined;

function serve(routes: (request: Request) => Response | Promise<Response>) {
  server = Bun.serve({ port: 0, fetch: routes });
  return `http://127.0.0.1:${server.port}`;
}

describe("normalizeBaseUrl", () => {
  afterEach(() => {
    server?.stop(true);
    server = undefined;
  });

  test("adds a scheme and trims slashes", () => {
    expect(normalizeBaseUrl("bifrost.example.com")).toBe("http://bifrost.example.com");
    expect(normalizeBaseUrl("https://bifrost.example.com///")).toBe("https://bifrost.example.com");
  });

  test("accepts a pasted /api suffix", () => {
    expect(normalizeBaseUrl("https://bifrost.example.com/api")).toBe("https://bifrost.example.com");
    expect(normalizeBaseUrl("https://bifrost.example.com/api/")).toBe(
      "https://bifrost.example.com",
    );
  });

  test("rejects credentials and invalid schemes", () => {
    expect(() => normalizeBaseUrl("https://user:pass@host")).toThrow(BifrostError);
    expect(() => normalizeBaseUrl("ftp://host")).toThrow(BifrostError);
    expect(() => normalizeBaseUrl("")).toThrow(BifrostError);
  });
});

describe("BifrostClient.catalog", () => {
  beforeAll(() => {
    if (server) {
      server.stop(true);
    }
  });
  afterEach(() => {
    server?.stop(true);
    server = undefined;
  });

  test("falls back to the public bundle when marketplace is not available", async () => {
    const bundle = makeZip({
      "git-release/SKILL.md": skillMarkdown("Release helper"),
      "changelog/SKILL.md": skillMarkdown("Changelog helper"),
    });
    const baseUrl = serve((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("marketplace.json")) return new Response("nope", { status: 404 });
      if (url.pathname === "/api/skills/serve/all/download.zip") return new Response(bundle);
      return new Response("missing", { status: 404 });
    });

    const catalog = await new BifrostClient({ baseUrl }).catalog();
    expect(catalog.source).toBe("zip");
    expect(catalog.skills.map((skill) => skill.name)).toEqual(["changelog", "git-release"]);
    expect(catalog.warnings.some((warning) => warning.includes("not available (HTTP 404)"))).toBe(
      true,
    );
  });

  test("prefers the marketplace manifest and strips the plugin prefix", async () => {
    const paths: string[] = [];
    const statuses: number[] = [];
    const archive = makeZip({ "git-release/SKILL.md": skillMarkdown("Release helper") });
    const baseUrl = serve((request) => {
      const url = new URL(request.url);
      paths.push(url.pathname);
      if (url.pathname.endsWith("marketplace.json")) {
        statuses.push(200);
        return Response.json({
          plugins: [
            { name: "bifrost-git-release", description: "Release helper", version: "1.2.0" },
            { name: "other", description: "Unrelated" },
          ],
        });
      }
      if (url.pathname === "/api/skills/serve/all/download.zip") {
        statuses.push(200);
        return new Response(archive);
      }
      statuses.push(404);
      return new Response("missing", { status: 404 });
    });

    const client = new BifrostClient({ baseUrl });
    const warnings: string[] = [];
    const marketplace = await (
      client as unknown as {
        marketplaceCatalog: (signal: unknown, warnings: string[]) => Promise<unknown>;
      }
    ).marketplaceCatalog(undefined, warnings);
    expect(marketplace).toBeDefined();
    expect(Array.isArray(marketplace)).toBe(true);
    expect((marketplace as unknown[]).length).toBe(2);

    const catalog = await client.catalog();
    expect(catalog.source).toBe("marketplace");
    expect(catalog.skills).toEqual([
      {
        name: "git-release",
        id: "git-release",
        plugin: "bifrost-git-release",
        description: "Release helper",
        version: "1.2.0",
      },
      { name: "other", id: "other", plugin: "other", description: "Unrelated" },
    ]);
  });

  test("fails when neither catalog source is available", async () => {
    const baseUrl = serve(() => new Response("not found", { status: 404 }));
    const client = new BifrostClient({ baseUrl });
    await expect(client.catalog()).rejects.toMatchObject({ code: "unavailable" });
    await expect(client.catalog()).rejects.toThrow(
      /Marketplace manifest not available|The all-skills bundle/i,
    );
  });
});

describe("BifrostClient.downloadSkill", () => {
  beforeAll(() => {
    // Ensure no leftover server from previous describe blocks
    if (server) {
      server.stop(true);
    }
  });
  afterEach(() => {
    server?.stop(true);
    server = undefined;
  });

  test("requests the encoded per-skill zip route", async () => {
    const archive = makeZip({ "git-release/SKILL.md": skillMarkdown("Release helper") });
    const paths: string[] = [];
    const baseUrl = serve((request) => {
      paths.push(new URL(request.url).pathname);
      return new Response(archive);
    });

    const bytes = await new BifrostClient({ baseUrl }).downloadSkill("git-release");
    expect(bytes.byteLength).toBe(archive.byteLength);
    expect(paths).toEqual(["/api/skills/serve/git-release/download.zip"]);
  });

  test("rejects path-like names without a request", async () => {
    const client = new BifrostClient({ baseUrl: "http://127.0.0.1:1" });
    await expect(client.downloadSkill("../etc")).rejects.toMatchObject({ code: "invalid" });
    await expect(client.downloadSkill("a/b")).rejects.toMatchObject({ code: "invalid" });
  });

  test("maps status codes to errors", async () => {
    const baseUrl = serve((request) => {
      const url = new URL(request.url);
      if (url.pathname.includes("missing")) return new Response("nope", { status: 404 });
      return new Response("", { status: 200 });
    });
    const client = new BifrostClient({ baseUrl });

    await expect(client.downloadSkill("missing")).rejects.toMatchObject({ code: "not-found" });
    await expect(client.downloadSkill("empty")).rejects.toMatchObject({ code: "corrupt" });
  });

  test("rejects a body that exceeds the archive cap without buffering it all", async () => {
    const baseUrl = serve(async () => {
      // No content-length; streams far more than MAX_ARCHIVE_BYTES.
      const chunk = new Uint8Array(1024 * 1024).fill(65);
      return new Response(
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < 128; i += 1) controller.enqueue(chunk);
            controller.close();
          },
        }),
        { status: 200 },
      );
    });
    const client = new BifrostClient({ baseUrl, timeoutMs: 5000 });
    await expect(client.downloadAll()).rejects.toMatchObject({ code: "corrupt" });
  });

  test("times out while reading a stalled body", async () => {
    const baseUrl = serve(
      () =>
        new Response(
          new ReadableStream({
            start() {
              // Headers sent, body never arrives.
            },
          }),
          { status: 200 },
        ),
    );
    const client = new BifrostClient({ baseUrl, timeoutMs: 150 });
    await expect(client.downloadAll()).rejects.toMatchObject({ code: "timeout" });
  });

  test("sends no credential headers", async () => {
    let seen: Headers | undefined;
    const archive = makeZip({ "s/SKILL.md": skillMarkdown("x") });
    const baseUrl = serve((request) => {
      seen = request.headers;
      return new Response(archive);
    });

    await new BifrostClient({ baseUrl }).downloadSkill("s");
    expect(seen?.has("x-bf-vk")).toBe(false);
    expect(seen?.has("authorization")).toBe(false);
  });
});
