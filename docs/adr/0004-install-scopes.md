# ADR-0004: Support global and project install scopes

- **Status:** Proposed (implemented)
- **Date:** 2026-11-16
- **Deciders:** Maintainers of `@bitexpert/opencode-bifrost-skills`

## Context

Users need skills either available in every project or only in a specific workspace.
OpenCode scans fixed skill locations, and the TUI process's current working directory may
differ from the active session's project directory. Project-scoped operations must therefore
target the correct workspace reliably.

## Decision

- Support two scopes:
  - `global`: install under the OpenCode config directory:
    - `$OPENCODE_CONFIG_DIR/skills` when set.
    - `${XDG_CONFIG_HOME:-~/.config}/opencode/skills` otherwise.
  - `project`: install under the session/project directory at
    `<directory>/.opencode/skills`.
- For slash commands, resolve the project directory **on the server** from the invoking
  session (`ctx.session.get(sessionID).location.directory`), not from the process working
  directory. The TUI resolves the directory from its current route/session/location data.
- Default install commands to `global`; `project` requires an available directory and errors
  with guidance when it cannot be resolved.
- List and update inspect both global and project scopes (when a project directory is known),
  while remove requires an explicit scope when the same skill exists in both to avoid
  accidental cross-scope deletion.
- Only directories recognized by a valid Bifrost marker are considered plugin-managed (see
  ADR-0007).

## Consequences

- **Positive**
  - Predictable alignment with OpenCode's skill discovery.
  - Global skills are reusable across projects; project skills stay with a workspace.
  - Resolving project scope from session state keeps installs correct even when OpenCode's
    UI was started elsewhere.
- **Negative**
  - Project operations depend on session/location data being available and up to date.
  - Dual-scope listing makes commands aware of more state, which must be explained in output.
- **Tradeoff**
  - Mutation commands favor explicit scoping (`--global`/`--project`) while read/update
    commands inspect both scopes for convenience.
