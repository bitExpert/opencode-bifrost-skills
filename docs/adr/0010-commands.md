# ADR-0010: Provide forgiving slash commands with non-model transcript reporting

- **Status:** Superseded by ADR-0012
- **Amended:** 2026-11-16
- **Date:** 2026-11-16
- **Deciders:** Maintainers of `@bitexpert/opencode-bifrost-skills`

## Context

Commands are used interactively in chat. Users expect flexible flag and option spellings,
clear immediate feedback, and deterministic tool-like behavior that does not wake the model.

OpenCode provides a mechanism for plugins to register commands and append synthetic messages
to a session transcript.

## Decision

- Register non-interactive slash commands in the server part:
  - `/bifrost-install <skill> [--project] [--force]`
  - `/bifrost-install-all [--project] [--force]`
  - `/bifrost-list`
  - `/bifrost-update [<skill>|all] [--global|--project]`
  - `/bifrost-remove <skill> [--global|--project]`
  - `/bifrost-config [options] [--reset]`
- The interactive catalog browser lives in the TUI as `/bifrost-skills`.
- Parse arguments with a tolerant tokenizer/parser (`src/args.ts`):
  - Accept `--kebab-case`, `camelCase`, and bare `key=value` forms.
  - Provide aliases (`baseUrl`/`--base-url`/`--url`,
    `timeoutMs`/`--timeout-ms`, etc.).
  - Respect quoted values and a `--` terminator.
  - Treat known options as boolean flags and support `readScope`, `readBoolean`,
    `readString`, `readTimeout` helpers.
- Default behaviors:
  - Install commands default to `global`.
  - `/bifrost-update` defaults to `all`.
  - Commands report results via `format.ts` helpers producing Markdown.
- Report outcomes:
  - Emit a `notice` event to the TUI (toast).
  - Append a **synthetic session message** (resume disabled) with the formatted result so it
    appears in chat history without triggering model inference.
- **Tombstone:** If the user provides `apiKey`, `--api-key`, `--token`, `clearApiKey` or
  `clear-api-key`, the `/bifrost-config` command fails with a clear message: “API keys are no
  longer supported: Bifrost skill routes are public. Remove `apiKey` from your plugin options
  and unset `BIFROST_API_KEY`.”

## Consequences

- **Positive**
  - Low-friction, composable UX for scriptable or manual use.
  - Consistent output formatting across commands.
  - Results are visible in history without adding model turns.
  - No API keys or credentials required for any operation.
- **Negative**
  - Flexible parsing can accept ambiguous inputs; canonicalization rules must be maintained and
    tested.
  - Old command inputs with `apiKey` now fail; users must remove them.
- **Tradeoff**
  - Rich interactivity is concentrated in `/bifrost-skills` (TUI), while other commands remain
    non-interactive and easy to reason about.
