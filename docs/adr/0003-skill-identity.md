# ADR-0003: Model skill identity as name, id, and plugin name

- **Status:** Proposed (implemented)
- **Date:** 2026-11-16
- **Deciders:** Maintainers of `@bitexpert/opencode-bifrost-skills`

## Context

Bifrost gateways identify skills by a **raw repository name** (for example `git-release`),
which is used in HTTP routes such as `/api/skills/serve/{skill}/download.zip`.
Claude Code marketplaces prefix plugin names with `bifrost-` (for example
`bifrost-git-release`). OpenCode identifies and loads a skill by its **installed directory
name**, which is kebab-case.

Users may refer to the same skill using any of these forms, and catalog sources expose
different fields. The domain model must keep the concepts distinct while accepting all forms.

## Decision

- Maintain three identity fields in the domain model:
  - `name`: raw Bifrost skill name, used for HTTP routes and persisted in markers.
  - `id`: kebab-case OpenCode skill id, used as the installed directory name and for
    `@skill-id` references.
  - `plugin`: optional Claude Code marketplace plugin name (`bifrost-<name>`), present when
    the catalog came from a marketplace manifest.
- Derive/sanitize ids with `skillId()`: NFKD-normalize, strip diacritics, lowercase, keep
  `[a-z0-9._-]`, collapse multiple dashes, trim leading/trailing dashes or dots, and fall back
  to `bifrost-skill` when the result is empty.
- Resolve user input by matching `name`, `id`, or `plugin` against the catalog when available.
- When downloading, try a list of candidate names (original, stripped of `bifrost-`, plugin
  name) and continue on HTTP 404; other errors abort.
- Persist both `name` and `id` in `.bifrost-skill.json` so updates and removals can match
  records reliably.

## Consequences

- **Positive**
  - Flexible user input: raw name, `bifrost-*` name, or installed id all work.
  - Stable on-disk identity for OpenCode discovery and `@skill-id` usage.
  - Resilience to naming differences across catalog sources and gateway configurations.
- **Negative**
  - Ambiguity must be handled carefully; multi-skill archives are matched by catalog entry and
    fail as corrupt when a package cannot be determined.
  - Normalization is lossy by design, so distinct raw names could theoretically collide to the
    same id.
- **Notes**
  - The fallback id `bifrost-skill` exists only to avoid invalid empty names; such skills are
    unlikely in practice.
