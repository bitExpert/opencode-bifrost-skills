/**
 * Human-readable formatting shared by command results and TUI dialogs.
 */

import { displayPath } from "./settings.js";
import type {
  Catalog,
  ConfigSummary,
  InstallBatchResult,
  InstalledSkill,
  InstallResult,
  RemoveResult,
  UpdateResult,
} from "./types.js";

export function formatInstall(result: InstallResult): string {
  const version = result.version ? ` v${result.version}` : "";
  const verb =
    result.action === "installed"
      ? "Installed"
      : result.action === "overwritten"
        ? "Replaced"
        : result.action === "updated"
          ? "Updated"
          : "Unchanged";
  return [
    `**${verb} ${result.id}**${version} (${result.scope})`,
    "",
    `\`${displayPath(result.directory)}\``,
    "",
    `Use it with \`@${result.id}\` or let the skill tool load it when relevant.`,
  ].join("\n");
}

export function formatBatch(result: InstallBatchResult): string {
  const lines: string[] = [];
  if (result.results.length > 0) {
    lines.push(
      `**Installed ${result.results.length} skill${result.results.length === 1 ? "" : "s"}**`,
      "",
    );
    for (const item of result.results) {
      const version = item.version ? ` v${item.version}` : "";
      lines.push(`- \`${item.id}\`${version} → \`${displayPath(item.directory)}\``);
    }
  }
  if (result.skipped.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`**Left untouched (${result.skipped.length})**`, "");
    for (const item of result.skipped) lines.push(`- \`${item.name}\` — ${item.message}`);
  }
  if (result.failures.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`**Failed (${result.failures.length})**`, "");
    for (const item of result.failures) lines.push(`- \`${item.name}\` — ${item.message}`);
  }
  if (lines.length === 0) lines.push("Nothing to install.");
  return lines.join("\n");
}

export function formatList(skills: InstalledSkill[]): string {
  if (skills.length === 0) {
    return [
      "No Bifrost skills are installed.",
      "",
      "Run `/bifrost-skills` to browse, or `/bifrost-install <skill>` to install one.",
    ].join("\n");
  }

  const lines = [
    `**Installed Bifrost skills (${skills.length})**`,
    "",
    "| Skill | Version | Scope | Directory |",
    "| --- | --- | --- | --- |",
  ];
  for (const skill of skills) {
    const directory = `\`${displayPath(skill.directory)}\``;
    lines.push(
      `| \`${skill.id}\` | ${skill.version ? `v${skill.version}` : "—"} | ${skill.scope} | ${directory} |`,
    );
  }
  return lines.join("\n");
}

export function formatUpdate(result: UpdateResult): string {
  const lines: string[] = [];
  if (result.results.length === 0 && result.failures.length === 0) {
    lines.push("All installed skills are already up to date.");
  }
  if (result.results.length > 0) {
    lines.push(
      `**Updated ${result.results.length} skill${result.results.length === 1 ? "" : "s"}**`,
      "",
    );
    for (const item of result.results) {
      const version = item.version ? ` v${item.version}` : "";
      lines.push(`- \`${item.id}\`${version}`);
    }
  }
  if (result.unchanged.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`Unchanged: ${result.unchanged.map((item) => `\`${item.id}\``).join(", ")}`);
  }
  if (result.failures.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`**Failed (${result.failures.length})**`, "");
    for (const item of result.failures) lines.push(`- \`${item.name}\` — ${item.message}`);
  }
  return lines.join("\n");
}

export function formatRemove(result: RemoveResult): string {
  if (result.removed.length === 0) return "Nothing was removed.";
  return [
    `**Removed ${result.removed.length} skill${result.removed.length === 1 ? "" : "s"}**`,
    "",
    ...result.removed.map(
      (item) => `- \`${item.id}\` (${item.scope}) — \`${displayPath(item.directory)}\``,
    ),
  ].join("\n");
}

export function formatConfig(summary: ConfigSummary): string {
  const key = summary.hasApiKey
    ? `set (${summary.apiKeyHint ?? "hidden"}, from ${summary.apiKeySource})`
    : "not set";
  return [
    "**Bifrost skills configuration**",
    "",
    `- Gateway: \`${summary.baseUrl}\` (from ${summary.baseUrlSource})`,
    `- API key: ${key}`,
    `- Timeout: ${summary.timeoutMs} ms`,
    `- Global skills: \`${displayPath(summary.globalSkillsDirectory)}\``,
    "",
    "Set a gateway with `/bifrost-config baseUrl=https://bifrost.example.com`.",
    "Set a key with `/bifrost-config apiKey=...` (stored in plugin storage).",
  ].join("\n");
}

export function formatCatalogSummary(catalog: Catalog): string {
  const versioned = catalog.skills.filter((skill) => skill.version).length;
  return [
    `${catalog.skills.length} skill${catalog.skills.length === 1 ? "" : "s"} from ${catalog.source}`,
    versioned > 0 ? `${versioned} with version metadata` : "no version metadata",
  ].join(" · ");
}
