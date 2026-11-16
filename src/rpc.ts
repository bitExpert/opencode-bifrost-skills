/**
 * Typed RPC contract between the server part and the TUI part.
 *
 * The TUI calls these methods; the server owns catalog HTTP requests, storage
 * and filesystem writes. A `notice` event carries server-command results to
 * the TUI so slash commands can show a toast as well as a transcript entry.
 */

import { Rpc } from "@opencode/plugin/rpc";

type JsonSchema = Record<string, unknown>;
/** JSON Schema for an object; the literal `type` is required by RPC event schemas. */
type ObjectSchema = JsonSchema & { type: "object" };

const string = (description?: string): JsonSchema => ({
  type: "string",
  ...(description ? { description } : {}),
});

const boolean = (description?: string): JsonSchema => ({
  type: "boolean",
  ...(description ? { description } : {}),
});

const number = (description?: string): JsonSchema => ({
  type: "number",
  ...(description ? { description } : {}),
});

const array = (items: JsonSchema): JsonSchema => ({ type: "array", items });

const object = (properties: Record<string, JsonSchema>, required: string[] = []): ObjectSchema => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});

const scopeSchema: JsonSchema = { type: "string", enum: ["global", "project"] };

const failureSchema = object(
  {
    name: string(),
    message: string(),
  },
  ["name", "message"],
);

const installResultSchema = object(
  {
    id: string(),
    name: string(),
    description: string(),
    version: string(),
    directory: string(),
    scope: scopeSchema,
    action: { type: "string", enum: ["installed", "overwritten", "updated", "unchanged"] },
    contentHash: string(),
  },
  ["id", "name", "directory", "scope", "action", "contentHash"],
);

const installedSkillSchema = object(
  {
    id: string(),
    name: string(),
    description: string(),
    version: string(),
    scope: scopeSchema,
    directory: string(),
    baseUrl: string(),
    installedAt: string(),
    updatedAt: string(),
    contentHash: string(),
  },
  ["id", "name", "scope", "directory", "baseUrl", "installedAt", "contentHash"],
);

const skillSummarySchema = object(
  {
    name: string(),
    id: string(),
    description: string(),
    version: string(),
    plugin: string(),
  },
  ["name", "id"],
);

const configSummarySchema = object(
  {
    baseUrl: string(),
    baseUrlSource: {
      type: "string",
      enum: ["command", "storage", "options", "environment", "default"],
    },
    timeoutMs: number(),
    globalSkillsDirectory: string(),
  },
  ["baseUrl", "baseUrlSource", "timeoutMs", "globalSkillsDirectory"],
);

const catalogSchema = object(
  {
    baseUrl: string(),
    source: { type: "string", enum: ["marketplace", "zip"] },
    fetchedAt: string(),
    skills: array(skillSummarySchema),
    warnings: array(string()),
  },
  ["baseUrl", "source", "fetchedAt", "skills", "warnings"],
);

const failedErrors = {
  failed: object({ message: string(), code: string() }, ["message"]),
};

export const BifrostRpc = Rpc.define({
  id: "opencode-bifrost-skills",
  methods: {
    catalog: {
      input: object({
        directory: string(),
      }),
      output: catalogSchema,
      errors: failedErrors,
    },
    install: {
      input: object({
        name: string(),
        scope: scopeSchema,
        directory: string(),
        force: boolean(),
        baseUrl: string(),
      }),
      output: installResultSchema,
      errors: failedErrors,
    },
    installAll: {
      input: object({
        scope: scopeSchema,
        directory: string(),
        force: boolean(),
        baseUrl: string(),
      }),
      output: object(
        {
          results: array(installResultSchema),
          failures: array(failureSchema),
          skipped: array(failureSchema),
        },
        ["results", "failures", "skipped"],
      ),
      errors: failedErrors,
    },
    list: {
      input: object({
        directory: string(),
      }),
      output: object({ skills: array(installedSkillSchema) }, ["skills"]),
      errors: failedErrors,
    },
    update: {
      input: object({
        name: string(),
        scope: scopeSchema,
        directory: string(),
        baseUrl: string(),
      }),
      output: object(
        {
          results: array(installResultSchema),
          failures: array(failureSchema),
          unchanged: array(installResultSchema),
        },
        ["results", "failures", "unchanged"],
      ),
      errors: failedErrors,
    },
    remove: {
      input: object(
        {
          name: string(),
          scope: scopeSchema,
          directory: string(),
        },
        ["name"],
      ),
      output: object(
        {
          removed: array(
            object(
              {
                id: string(),
                name: string(),
                directory: string(),
                scope: scopeSchema,
              },
              ["id", "name", "directory", "scope"],
            ),
          ),
        },
        ["removed"],
      ),
      errors: failedErrors,
    },
    config: {
      input: object({
        baseUrl: string(),
        timeoutMs: number(),
        reset: boolean(),
      }),
      output: configSummarySchema,
      errors: failedErrors,
    },
  },
  events: {
    notice: {
      schema: object(
        {
          kind: { type: "string", enum: ["info", "success", "warning", "error"] },
          message: string(),
          title: string(),
        },
        ["kind", "message"],
      ),
    },
  },
});

export type BifrostRpcDefinition = typeof BifrostRpc;
