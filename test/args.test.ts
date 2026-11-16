import { describe, expect, test } from "bun:test";
import {
  parseArgs,
  readBoolean,
  readScope,
  readString,
  readTimeout,
  tokenize,
} from "../src/args.js";

describe("tokenize", () => {
  test("splits on whitespace", () => {
    expect(tokenize("  one   two\tthree ")).toEqual(["one", "two", "three"]);
  });

  test("keeps quoted values together", () => {
    expect(tokenize(`config baseUrl="http://a b" 'x y'`)).toEqual([
      "config",
      "baseUrl=http://a b",
      "x y",
    ]);
  });

  test("honours escapes outside single quotes", () => {
    expect(tokenize(String.raw`a\ b "c\"d"`)).toEqual(["a b", 'c"d']);
  });
});

describe("parseArgs", () => {
  test("parses boolean flags and positionals", () => {
    const args = parseArgs("git-release --project --force");
    expect(args.positionals).toEqual(["git-release"]);
    expect(readBoolean(args, "project")).toBe(true);
    expect(readBoolean(args, "force")).toBe(true);
    expect(readScope(args)).toBe("project");
  });

  test("parses spaced values", () => {
    const args = parseArgs("--base-url https://bifrost.example.com --timeout-ms 5000 skill");
    expect(readString(args, "baseUrl")).toBe("https://bifrost.example.com");
    expect(readTimeout(args)).toBe(5000);
    expect(args.positionals).toEqual(["skill"]);
  });

  test("parses kebab and camel case assignments", () => {
    const kebab = parseArgs("base-url=secret timeout=1000");
    expect(readString(kebab, "baseUrl")).toBe("secret");
    expect(readTimeout(kebab)).toBe(1000);

    const camel = parseArgs("baseUrl=secret2 timeout=2000");
    expect(readString(camel, "baseUrl")).toBe("secret2");
    expect(readTimeout(camel)).toBe(2000);
  });

  test("stops option parsing after --", () => {
    const args = parseArgs("--force -- --project value");
    expect(readBoolean(args, "force")).toBe(true);
    expect(args.positionals).toEqual(["--project", "value"]);
  });

  test("returns undefined for conflicting scopes", () => {
    expect(readScope(parseArgs("--project --global"))).toBeUndefined();
  });

  test("ignores invalid timeouts", () => {
    expect(readTimeout(parseArgs("--timeout-ms nope"))).toBeUndefined();
    expect(readTimeout(parseArgs("--timeout-ms -1"))).toBeUndefined();
  });
});
