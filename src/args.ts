/**
 * Minimal argument parser for slash commands.
 *
 * OpenCode hands the command implementation the raw text after the command
 * name. We support:
 *
 *   /bifrost-install git-release --project --force
 *   /bifrost-config baseUrl=https://bifrost.example.com apiKey=...
 *   /bifrost-config --base-url https://bifrost.example.com
 *
 * Both `--kebab-case` and `camelCase=` spellings are accepted.
 */

export type OptionValue = string | true;

export interface ParsedArgs {
  positionals: string[];
  options: Map<string, OptionValue>;
}

/** Aliases map user-facing names to canonical option names. */
const ALIASES: Record<string, string> = {
  url: "baseUrl",
  "base-url": "baseUrl",
  baseurl: "baseUrl",
  timeout: "timeoutMs",
  "timeout-ms": "timeoutMs",
};

/** Options that never take a value; the following token is positional. */
const BOOLEAN_OPTIONS = new Set(["project", "global", "force", "verbose", "reset", "help", "all"]);

export function canonicalOption(name: string): string {
  const normalized = name.replace(/^-+/, "");
  return ALIASES[normalized] ?? normalized;
}

/** Splits on whitespace while respecting single/double quotes and escapes. */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let started = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      started = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      started = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }

  if (escaped) current += "\\";
  if (started) tokens.push(current);
  return tokens;
}

export function parseArgs(input: string | undefined): ParsedArgs {
  const tokens = tokenize(input ?? "");
  const positionals: string[] = [];
  const options = new Map<string, OptionValue>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;

    if (token === "--") {
      positionals.push(...tokens.slice(index + 1));
      break;
    }

    if (token.startsWith("--")) {
      const [rawName, inlineValue] = splitAssignment(token.slice(2));
      const name = canonicalOption(rawName);
      if (inlineValue !== undefined) {
        options.set(name, inlineValue);
        continue;
      }
      if (BOOLEAN_OPTIONS.has(name)) {
        options.set(name, true);
        continue;
      }
      const next = tokens[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        options.set(name, next);
        index += 1;
      } else {
        options.set(name, true);
      }
      continue;
    }

    // Bare `baseUrl=...` style, used by `/bifrost-config`.
    const assignment = splitAssignment(token);
    if (assignment[1] !== undefined && assignment[0] !== "") {
      options.set(canonicalOption(assignment[0]), assignment[1]);
      continue;
    }

    positionals.push(token);
  }

  return { positionals, options };
}

function splitAssignment(token: string): [string, string | undefined] {
  const index = token.indexOf("=");
  if (index === -1) return [token, undefined];
  return [token.slice(0, index), token.slice(index + 1)];
}

export function readString(args: ParsedArgs, name: string): string | undefined {
  const value = args.options.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function readBoolean(args: ParsedArgs, name: string): boolean {
  return args.options.get(name) === true || args.options.get(name) === "true";
}

/** Resolves the scope flags, defaulting to global. */
export function readScope(args: ParsedArgs): "global" | "project" | undefined {
  const project = readBoolean(args, "project");
  const global = readBoolean(args, "global");
  if (project && global) return undefined;
  if (project) return "project";
  if (global) return "global";
  return undefined;
}

export function readTimeout(args: ParsedArgs): number | undefined {
  const raw = readString(args, "timeoutMs");
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
