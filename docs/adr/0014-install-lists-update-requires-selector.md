# ADR-0014: Install without a selector lists; update requires one

- **Status:** Proposed (implemented)
- **Date:** 2026-11-18
- **Deciders:** Maintainers of `@bitexpert/opencode-bifrost-skills`
- **Supersedes:** The no-argument batch-install rule of
  [ADR-0013](0013-unified-install-command.md)

## Context

The interactive catalog browser is registered by the TUI part of the plugin as
`/bifrost-skills`. Headless clients such as the SDK and OpenChamber never load
the TUI part, so that command does not exist there.

An earlier attempt registered a server-side command under the same name so the
catalog would be reachable everywhere. That produced two registrations of
`/bifrost-skills` in the TUI slash completion, because the server cannot detect
whether a TUI is attached:

- `ctx.plugin.list` reports which entrypoints a package exposes, not which ones
  are loaded.
- Server connection events are not visible to plugins.
- The command API can list commands but not remove one.

Renaming the server command to `/bifrost-catalog` removed the duplicate, but
left two names for one concept and still did not make `/bifrost-skills` work
headless.

Every client already has `/bifrost-install`, so that command can carry the
catalog listing instead of a dedicated browse command.

## Decision

- **`/bifrost-skills` stays TUI-only.** The TUI keymap is the sole owner of the
  name; the server part registers no catalog command.
- **`/bifrost-install` without a selector lists the catalog.** It fetches the
  catalog, fetches installed skills from both scopes, and renders one table with
  a status column (`✓ global`, `✓ project`, `✓ global, project`, or `—`). It
  writes nothing and does not reload the skill registry.
- **`/bifrost-install all` and `/bifrost-install *` install every skill**, as
  before. Any other selector installs that skill by name.
- **`/bifrost-update` requires `<skill>` or `all`.** Without a selector it
  prints usage and performs no work. This mirrors `/bifrost-remove`.
- **`/bifrost-update all` keeps the previous batch-update behavior.**
- **Flags are unchanged:** `--global` / `--project` and `--force` still apply to
  installing and updating. They are irrelevant when listing and are ignored in
  that path.
- **RPC and operations are unchanged:** `Operations.catalog`, `list`, `install`,
  `installAll`, and `update` keep their signatures; only slash-command
  dispatch changes.

### Why the two defaults differ

- `/bifrost-install` with no argument is a read-only question ("what can I
  install?"). Listing is the safe default.
- `/bifrost-update` with no argument would silently rewrite every installed
  skill. Requiring `all` makes batch updates explicit, matching `/bifrost-remove`
  and `/bifrost-update`'s narrower scope.

## Consequences

- **Positive**
  - No duplicate slash entries and no client-detection logic.
  - Headless clients reach the catalog through a command that already exists.
  - The catalog listing shows which skills are already installed and in which
    scope.
  - A bare install can no longer modify the filesystem by accident.
- **Negative**
  - `/bifrost-skills` remains unavailable outside the TUI. Headless users must
    know that `/bifrost-install` lists the catalog.
  - Batch installs must use `all` or `*`; a bare `/bifrost-install` no longer
    installs anything.
  - A skill literally named `all` or `*` still cannot be installed by name
    (unchanged from ADR-0013).

## Migration guide

| Old invocation                  | New equivalent                   |
| ------------------------------- | -------------------------------- |
| `/bifrost-install` (batch)      | `/bifrost-install all`           |
| `/bifrost-install --project`    | `/bifrost-install all --project` |
| `/bifrost-install --force`      | `/bifrost-install all --force`   |
| `/bifrost-update` (batch)       | `/bifrost-update all`            |
| `/bifrost-catalog` (if present) | `/bifrost-install`               |
| `/bifrost-skills` (headless)    | `/bifrost-install`               |

## Notes

- The sentinel `*` is supported by the existing tokenizer as a regular positional
  token.
- The change was made pre-1.0 (`0.1.0`) to keep semver breaking-change
  expectations clear.
