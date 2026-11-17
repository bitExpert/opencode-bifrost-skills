# ADR-0013: Unified install slash command

- **Status:** Proposed (implemented)
- **Date:** 2026-11-17
- **Deciders:** Maintainers of `@bitexpert/opencode-bifrost-skills`

## Context

The plugin previously exposed two separate slash commands for installing skills:

- `/bifrost-install <skill>` — installs a single skill by name
- `/bifrost-install-all` — installs every skill served by the gateway

Users had to remember which command to use depending on their goal, and the
duplicated behavior made the command surface area larger than necessary.

The update command already follows a selector pattern:

- `/bifrost-update [<skill>|all]` — defaults to `all` when no selector is given

We wanted to adopt the same convention for install to keep the UX consistent.

## Decision

- **Unify** `/bifrost-install` and `/bifrost-install-all` into a single command.
- **Selector semantics:**
  - No argument, `all`, or `*` → batch install (all skills)
  - Any other name → single install by that name
- **Flags stay the same:** `--global` / `--project`, `--force`
- **RPC and internal operations remain unchanged:** `install` and `installAll` are
  still separate methods; only the slash-command executor dispatches based on the
  selector.
- **The old `/bifrost-install-all` command is removed** from slash registration.

## Consequences

- **Positive**
  - Single command to remember: `/bifrost-install` covers both use cases.
  - Consistent with `/bifrost-update`'s selector convention.
  - Simplified command registration and maintenance.
  - No breaking changes for RPC consumers or internal operations.
- **Negative**
  - A skill literally named `all` or `*` can no longer be installed by name
    (only via batch).
  - Users relying on `/bifrost-install-all` must switch to `/bifrost-install`
    with the appropriate selector (which is a one-character change for most
    workflows).
- **Tradeoff**
  - The risk of "name collision" with `all` or `*` is minimal because Bifrost
    skills use kebab-case names, but the documentation must clarify the
    sentinel values.

## Migration guide

| Old command                      | New equivalent               |
| -------------------------------- | ---------------------------- |
| `/bifrost-install-all`           | `/bifrost-install`           |
| `/bifrost-install-all --project` | `/bifrost-install --project` |
| `/bifrost-install-all --force`   | `/bifrost-install --force`   |

## Notes

- The RPC contract (`install`, `installAll` methods) and `Operations.install`,
  `Operations.installAll` are intentionally unchanged to avoid touching the TUI
  or other consumers.
- The sentinel `*` is supported via the existing tokenizer which treats it as a
  regular positional token.
- This change was made while the plugin is pre-1.0 (`0.1.0`) to keep semver
  breaking-change expectations clear.
