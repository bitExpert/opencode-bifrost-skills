/**
 * TUI part of the Bifrost skills plugin.
 *
 * Only the interactive `/bifrost-skills` command lives here. The other
 * `/bifrost-*` commands are registered by the server part, so their names do
 * not collide with TUI slash completion.
 */

import { Plugin } from "@opencode/plugin/tui";

type Context = Plugin.Context;

import { BifrostRpc } from "./rpc.js";

type Scope = "global" | "project";

interface CatalogSkill {
  name: string;
  id: string;
  description?: string;
  version?: string;
  plugin?: string;
}

interface CatalogOutput {
  baseUrl: string;
  source: string;
  fetchedAt: string;
  skills: CatalogSkill[];
  warnings: string[];
}

interface InstalledSkill {
  id: string;
  name: string;
  scope: Scope;
  directory: string;
  version?: string;
}

interface NoticeData {
  kind: "info" | "success" | "warning" | "error";
  message: string;
  title?: string;
}

interface InstallOutput {
  id: string;
  name: string;
  scope: Scope;
  directory: string;
  version?: string;
  action: string;
}

const PLUGIN_ID = "opencode-bifrost-skills.tui";

export default Plugin.define({
  id: PLUGIN_ID,
  setup(context: Context) {
    const rpc = context.client.rpc(BifrostRpc);

    const unsubscribe = rpc.events.on("notice", (event) => {
      const data = event.data as unknown as NoticeData;
      context.ui.toast.show({
        title: data.title ?? "Bifrost",
        message: data.message,
        variant: data.kind,
      });
    });

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "bifrost.skills",
          title: "Bifrost skills",
          description: "Browse and install Agent Skills from a Bifrost gateway",
          group: "Bifrost",
          palette: true,
          slash: { name: "bifrost-skills" },
          run: async () => {
            await browse(context, rpc as unknown as SkillsRpc);
          },
        },
      ],
    }));

    return () => {
      unsubscribe();
    };
  },
});

interface SkillsRpc {
  catalog: (input: { directory?: string }) => Promise<CatalogOutput>;
  list: (input: { directory?: string }) => Promise<{ skills: InstalledSkill[] }>;
  install: (input: {
    name: string;
    scope: Scope;
    directory?: string;
    force?: boolean;
  }) => Promise<InstallOutput>;
}

async function browse(context: Context, rpc: SkillsRpc): Promise<void> {
  const directory = currentDirectory(context);
  context.ui.toast.show({ message: "Fetching skills from Bifrost…", variant: "info" });

  let catalog: CatalogOutput;
  try {
    catalog = await rpc.catalog({ directory });
  } catch (error) {
    await context.ui.dialog.alert({
      title: "Bifrost skills",
      message: `${messageOf(error)}\n\nCheck the gateway with /bifrost-config.`,
    });
    return;
  }

  if (catalog.skills.length === 0) {
    await context.ui.dialog.alert({
      title: "No skills available",
      message: [
        `The gateway at ${catalog.baseUrl} did not return any skills.`,
        ...(catalog.warnings.length > 0
          ? ["", ...catalog.warnings.map((warning) => `• ${warning}`)]
          : []),
      ].join("\n"),
    });
    return;
  }

  let installed: InstalledSkill[] = [];
  try {
    installed = (await rpc.list({ directory })).skills;
  } catch {
    // A listing failure must not block installing.
  }

  for (;;) {
    const scopesById = new Map<string, Scope[]>();
    for (const record of installed) {
      const scopes = scopesById.get(record.id) ?? [];
      if (!scopes.includes(record.scope)) scopes.push(record.scope);
      scopesById.set(record.id, scopes);
    }

    const selected = await context.ui.dialog.select<CatalogSkill>({
      title: `Bifrost skills (${catalog.skills.length}) — ${sourceLabel(catalog.source)}`,
      placeholder: "Search skills…",
      options: catalog.skills.map((skill) => {
        const scopes = scopesById.get(skill.id);
        const installedLabel =
          scopes && scopes.length > 0 ? `installed ${scopes.join(" + ")}` : undefined;
        const version = skill.version ? `v${skill.version}` : undefined;
        return {
          title: `${skill.id}${installedLabel ? " ✓" : ""}`,
          value: skill,
          description:
            [version, skill.description ?? "No description"].filter(Boolean).join(" · ") ||
            "No description",
          ...(installedLabel ? { footer: installedLabel } : {}),
        };
      }),
      search: (query, options) => {
        const needle = query.trim().toLowerCase();
        if (!needle) return options;
        return options.filter((option) =>
          `${option.title} ${option.description ?? ""} ${option.footer ?? ""}`
            .toLowerCase()
            .includes(needle),
        );
      },
    });

    if (!selected) return;

    const scope = await chooseScope(context, selected, directory, installed);
    if (!scope) return;

    let result: InstallOutput;
    try {
      result = await installWithConfirmation(context, rpc, selected, scope, directory);
    } catch (error) {
      await context.ui.dialog.alert({
        title: "Install failed",
        message: messageOf(error),
      });
      return;
    }

    installed = installed.filter(
      (record) => !(record.id === result.id && record.scope === result.scope),
    );
    installed.push({
      id: result.id,
      name: result.name,
      scope: result.scope,
      directory: result.directory,
      ...(result.version ? { version: result.version } : {}),
    });

    context.data.location.skill.invalidate({ directory });
    context.ui.toast.show({
      title: "Bifrost skills",
      message: `${result.action === "overwritten" ? "Replaced" : "Installed"} ${result.id}${
        result.version ? ` v${result.version}` : ""
      } (${result.scope})`,
      variant: "success",
      duration: 5000,
    });

    const again = await context.ui.dialog.confirm({
      title: "Install another skill?",
      message: `Installed ${result.id} into ${result.directory}.`,
      label: { confirm: "Install another", cancel: "Done" },
    });
    if (!again) return;
  }
}

async function chooseScope(
  context: Context,
  skill: CatalogSkill,
  directory: string,
  installed: InstalledSkill[],
): Promise<Scope | undefined> {
  const existing = installed.filter((record) => record.id === skill.id);
  return context.ui.dialog.select<Scope>({
    title: `Install ${skill.id}`,
    options: [
      {
        title: "Global",
        value: "global",
        description: existing.some((record) => record.scope === "global")
          ? "Already installed globally — will ask before replacing"
          : "Available in every project",
      },
      {
        title: "Project",
        value: "project",
        description: existing.some((record) => record.scope === "project")
          ? "Already installed in this project — will ask before replacing"
          : `Only in ${directory}`,
      },
    ],
  });
}

async function installWithConfirmation(
  context: Context,
  rpc: SkillsRpc,
  skill: CatalogSkill,
  scope: Scope,
  directory: string,
): Promise<InstallOutput> {
  const input = {
    name: skill.name,
    scope,
    ...(scope === "project" ? { directory } : {}),
  };

  try {
    return await rpc.install(input);
  } catch (error) {
    if (codeOf(error) !== "exists" && !/already installed/i.test(messageOf(error))) throw error;

    const confirmed = await context.ui.dialog.confirm({
      title: "Overwrite skill?",
      message: `${skill.id} is already installed in ${scope} scope.\n\nReplace it with the gateway version?`,
      label: { confirm: "Replace", cancel: "Keep existing" },
    });
    if (!confirmed) throw error;

    return await rpc.install({ ...input, force: true });
  }
}

function currentDirectory(context: Context): string {
  const route = context.ui.router.current();
  if (route.type === "session") {
    const session = context.data.session.get(route.sessionID);
    if (session?.location?.directory) return session.location.directory;
  }

  const sessions = context.data.session
    .list()
    .filter((session) => !session.parentID)
    .sort((a, b) => b.time.updated - a.time.updated);
  const latest = sessions[0]?.location?.directory;
  if (latest) return latest;

  return context.location?.directory ?? context.data.location.default().directory;
}

function sourceLabel(source: string): string {
  if (source === "marketplace") return "marketplace catalog";
  if (source === "api") return "skills API";
  return "all-skills bundle";
}

function codeOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const data = (error as { data?: unknown }).data;
  if (data && typeof data === "object" && typeof (data as { code?: unknown }).code === "string") {
    return (data as { code: string }).code;
  }
  return undefined;
}

function messageOf(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
