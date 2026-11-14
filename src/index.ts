/**
 * Server part of the Bifrost skills plugin.
 *
 * Responsibilities:
 * - own the HTTP client, settings and filesystem writes
 * - register the non-interactive `/bifrost-*` commands
 * - expose the same operations over RPC to the TUI part
 *
 * Commands are registered through `ctx.command.transform` and do not prompt
 * the model: they perform the action and append a synthetic message to the
 * session so the result appears in the transcript without waking the agent.
 */

import { Plugin } from "@opencode/plugin";

type Context = Plugin.Context;

import { parseArgs, readBoolean, readScope, readString, readTimeout } from "./args.js";
import { BifrostError, describeError } from "./bifrost.js";
import {
  formatBatch,
  formatConfig,
  formatInstall,
  formatList,
  formatRemove,
  formatUpdate,
} from "./format.js";
import { Operations } from "./operations.js";
import { BifrostRpc } from "./rpc.js";
import type { ConfigPatch, InstallScope } from "./types.js";

const PLUGIN_ID = "opencode-bifrost-skills";
const COMMAND_GROUP = "Bifrost";

type NoticeKind = "info" | "success" | "warning" | "error";

interface CommandOutcome {
  text: string;
  notice: string;
  kind: NoticeKind;
}

interface CatalogInput {
  directory?: string;
  baseUrl?: string;
  apiKey?: string;
}

interface InstallInput {
  name: string;
  scope?: string;
  directory?: string;
  force?: boolean;
  baseUrl?: string;
  apiKey?: string;
}

interface InstallAllInput {
  scope?: string;
  directory?: string;
  force?: boolean;
  baseUrl?: string;
  apiKey?: string;
}

interface ListInput {
  directory?: string;
}

interface UpdateInput {
  name?: string;
  scope?: string;
  directory?: string;
  baseUrl?: string;
  apiKey?: string;
}

interface RemoveInput {
  name: string;
  scope?: string;
  directory?: string;
}

interface ConfigInput {
  baseUrl?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  timeoutMs?: number;
  reset?: boolean;
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx: Context) {
    const operations = new Operations({
      storage: ctx.storage,
      options: ctx.options,
      reload: () => ctx.skill.reload(),
    });

    const notices = await ctx.rpc.register(BifrostRpc, {
      catalog: async (raw, context) => {
        const input = raw as CatalogInput;
        try {
          const catalog = await operations.catalog(overridesOf(input), context.signal);
          return {
            baseUrl: catalog.baseUrl,
            source: catalog.source,
            fetchedAt: catalog.fetchedAt,
            skills: catalog.skills.map((skill) => ({
              name: skill.name,
              id: skill.id,
              ...(skill.description ? { description: skill.description } : {}),
              ...(skill.version ? { version: skill.version } : {}),
              ...(skill.plugin ? { plugin: skill.plugin } : {}),
            })),
            warnings: catalog.warnings,
          };
        } catch (error) {
          return fail(context, error);
        }
      },
      install: async (raw, context) => {
        const input = raw as InstallInput;
        try {
          return await operations.install({
            name: input.name,
            scope: scopeOf(input.scope),
            directory: input.directory,
            force: input.force === true,
            overrides: overridesOf(input),
          });
        } catch (error) {
          return fail(context, error);
        }
      },
      installAll: async (raw, context) => {
        const input = raw as InstallAllInput;
        try {
          return await operations.installAll({
            scope: scopeOf(input.scope),
            directory: input.directory,
            force: input.force === true,
            overrides: overridesOf(input),
            signal: context.signal,
          });
        } catch (error) {
          return fail(context, error);
        }
      },
      list: async (raw, context) => {
        const input = raw as ListInput;
        try {
          return { skills: await operations.list(input.directory) };
        } catch (error) {
          return fail(context, error);
        }
      },
      update: async (raw, context) => {
        const input = raw as UpdateInput;
        try {
          return await operations.update({
            name: input.name,
            scope: input.scope ? scopeOf(input.scope) : undefined,
            directory: input.directory,
            overrides: overridesOf(input),
            signal: context.signal,
          });
        } catch (error) {
          return fail(context, error);
        }
      },
      remove: async (raw, context) => {
        const input = raw as RemoveInput;
        try {
          return await operations.remove({
            name: input.name,
            scope: input.scope ? scopeOf(input.scope) : undefined,
            directory: input.directory,
          });
        } catch (error) {
          return fail(context, error);
        }
      },
      config: async (raw, context) => {
        const input = raw as ConfigInput;
        try {
          const patch: ConfigPatch = {};
          if (input.reset === true) patch.reset = true;
          if (typeof input.baseUrl === "string" && input.baseUrl.trim() !== "")
            patch.baseUrl = input.baseUrl;
          if (input.clearApiKey === true) patch.apiKey = null;
          else if (typeof input.apiKey === "string" && input.apiKey.trim() !== "")
            patch.apiKey = input.apiKey;
          if (typeof input.timeoutMs === "number") patch.timeoutMs = input.timeoutMs;
          return hasPatch(patch) ? await operations.configure(patch) : await operations.summary();
        } catch (error) {
          return fail(context, error);
        }
      },
    });

    const emitNotice = (notice: { kind: NoticeKind; message: string; title: string }) =>
      notices.events.emit("notice", notice);

    await ctx.command.transform((editor) => {
      editor.add({
        name: "bifrost-install",
        description: "Install an Agent Skill from the Bifrost gateway (--project, --force)",
        execute: async (invocation) => {
          const outcome = await runCommand(async () => {
            const args = parseArgs(invocation.prompt.text);
            const name = args.positionals[0];
            if (!name) {
              return {
                text: "Usage: `/bifrost-install <skill> [--project] [--force]`",
                notice: "A skill name is required.",
                kind: "error",
              };
            }
            const scope = readScope(args) ?? "global";
            const directory =
              scope === "project" ? await sessionDirectory(ctx, invocation.sessionID) : undefined;
            const result = await operations.install({
              name,
              scope,
              directory,
              force: readBoolean(args, "force"),
            });
            return {
              text: formatInstall(result),
              notice: `${result.action === "unchanged" ? "Unchanged" : "Installed"} ${result.id} (${result.scope})`,
              kind: "success",
            };
          });
          await report(ctx, emitNotice, invocation.sessionID, outcome);
        },
      });

      editor.add({
        name: "bifrost-install-all",
        description: "Install every skill served by the Bifrost gateway (--project, --force)",
        execute: async (invocation) => {
          const outcome = await runCommand(async () => {
            const args = parseArgs(invocation.prompt.text);
            const scope = readScope(args) ?? "global";
            const directory =
              scope === "project" ? await sessionDirectory(ctx, invocation.sessionID) : undefined;
            const result = await operations.installAll({
              scope,
              directory,
              force: readBoolean(args, "force"),
            });
            const failures = result.failures.length + result.skipped.length;
            return {
              text: formatBatch(result),
              notice:
                result.results.length > 0
                  ? `Installed ${result.results.length} skill${result.results.length === 1 ? "" : "s"}`
                  : failures > 0
                    ? "No skills were installed."
                    : "Nothing to install.",
              kind: result.results.length > 0 ? (failures > 0 ? "warning" : "success") : "error",
            };
          });
          await report(ctx, emitNotice, invocation.sessionID, outcome);
        },
      });

      editor.add({
        name: "bifrost-list",
        description: "List installed Bifrost skills in global and project scope",
        execute: async (invocation) => {
          const outcome = await runCommand(async () => {
            const directory = await sessionDirectory(ctx, invocation.sessionID);
            const skills = await operations.list(directory);
            return {
              text: formatList(skills),
              notice:
                skills.length > 0
                  ? `${skills.length} Bifrost skill${skills.length === 1 ? "" : "s"} installed`
                  : "No Bifrost skills installed.",
              kind: "info",
            };
          });
          await report(ctx, emitNotice, invocation.sessionID, outcome);
        },
      });

      editor.add({
        name: "bifrost-update",
        description: "Update installed Bifrost skills when the gateway has newer content",
        execute: async (invocation) => {
          const outcome = await runCommand(async () => {
            const args = parseArgs(invocation.prompt.text);
            const name = args.positionals[0] ?? "all";
            const scope = readScope(args);
            const directory = await sessionDirectory(ctx, invocation.sessionID);
            const result = await operations.update({ name, scope, directory });
            return {
              text: formatUpdate(result),
              notice:
                result.results.length > 0
                  ? `Updated ${result.results.length} skill${result.results.length === 1 ? "" : "s"}`
                  : "Everything is up to date.",
              kind:
                result.failures.length > 0
                  ? "warning"
                  : result.results.length > 0
                    ? "success"
                    : "info",
            };
          });
          await report(ctx, emitNotice, invocation.sessionID, outcome);
        },
      });

      editor.add({
        name: "bifrost-remove",
        description: "Remove an installed Bifrost skill (--global or --project)",
        execute: async (invocation) => {
          const outcome = await runCommand(async () => {
            const args = parseArgs(invocation.prompt.text);
            const name = args.positionals[0];
            if (!name) {
              return {
                text: "Usage: `/bifrost-remove <skill> [--global|--project]`",
                notice: "A skill name is required.",
                kind: "error",
              };
            }
            const directory = await sessionDirectory(ctx, invocation.sessionID);
            const result = await operations.remove({ name, scope: readScope(args), directory });
            return {
              text: formatRemove(result),
              notice: `Removed ${result.removed.length} skill${result.removed.length === 1 ? "" : "s"}`,
              kind: "success",
            };
          });
          await report(ctx, emitNotice, invocation.sessionID, outcome);
        },
      });

      editor.add({
        name: "bifrost-config",
        description: "Show or change the Bifrost gateway URL and API key",
        execute: async (invocation) => {
          const outcome = await runCommand(async () => {
            const args = parseArgs(invocation.prompt.text);
            const patch: ConfigPatch = {};
            if (readBoolean(args, "reset")) patch.reset = true;
            const baseUrl = readString(args, "baseUrl");
            if (baseUrl) patch.baseUrl = baseUrl;
            if (readBoolean(args, "clearApiKey")) patch.apiKey = null;
            else {
              const apiKey = readString(args, "apiKey");
              if (apiKey) patch.apiKey = apiKey;
            }
            const timeoutMs = readTimeout(args);
            if (timeoutMs) patch.timeoutMs = timeoutMs;

            const summary = hasPatch(patch)
              ? await operations.configure(patch)
              : await operations.summary();
            return {
              text: formatConfig(summary),
              notice: hasPatch(patch) ? "Bifrost settings saved." : `Gateway: ${summary.baseUrl}`,
              kind: "info",
            };
          });
          await report(ctx, emitNotice, invocation.sessionID, outcome);
        },
      });
    });
  },
});

async function runCommand(run: () => Promise<CommandOutcome>): Promise<CommandOutcome> {
  try {
    return await run();
  } catch (error) {
    return {
      text: `**Bifrost skills error**\n\n${describeError(error)}`,
      notice: describeError(error),
      kind: "error",
    };
  }
}

async function report(
  ctx: Context,
  emitNotice: (notice: { kind: NoticeKind; message: string; title: string }) => Promise<void>,
  sessionID: string,
  outcome: CommandOutcome,
): Promise<void> {
  await emitNotice({ kind: outcome.kind, message: outcome.notice, title: COMMAND_GROUP }).catch(
    () => undefined,
  );

  await ctx.session
    .synthetic({
      sessionID,
      text: outcome.text,
      description: `${COMMAND_GROUP}: ${outcome.notice}`,
      resume: false,
    })
    .catch(() => undefined);
}

async function sessionDirectory(ctx: Context, sessionID: string): Promise<string | undefined> {
  try {
    const session = await ctx.session.get({ sessionID });
    return session.location.directory;
  } catch {
    return undefined;
  }
}

function scopeOf(value: unknown): InstallScope {
  return value === "project" ? "project" : "global";
}

function overridesOf(input: { baseUrl?: unknown; apiKey?: unknown }): ConfigPatch {
  const patch: ConfigPatch = {};
  if (typeof input.baseUrl === "string" && input.baseUrl.trim() !== "")
    patch.baseUrl = input.baseUrl;
  if (typeof input.apiKey === "string" && input.apiKey.trim() !== "") patch.apiKey = input.apiKey;
  return patch;
}

function hasPatch(patch: ConfigPatch): boolean {
  return Object.keys(patch).length > 0;
}

function fail<Error>(
  context: { error: (type: "failed", message: string, data: Record<string, unknown>) => Error },
  error: unknown,
): Error {
  const message = describeError(error);
  return context.error("failed", message, {
    message,
    ...(error instanceof BifrostError ? { code: error.code } : {}),
  });
}
