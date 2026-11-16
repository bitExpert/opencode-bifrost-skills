# ADR-0007: Install atomically with staging, markers, and content hashes

- **Status:** Proposed (implemented)
- **Date:** 2026-11-16
- **Deciders:** Maintainers of `@bitexpert/opencode-bifrost-skills`

## Context

OpenCode loads skills directly from directories. Partial writes or interrupted installs can
leave a half-written skill directory, which would be loaded as broken content. The plugin must
also distinguish its own managed installs from foreign/manual content and detect "unchanged"
updates reliably.

Archives from the network do not provide trustworthy executable-bit metadata, so the plugin
must choose file modes deterministically.

## Decision

- Install flow:
  1. Create a hidden **staging directory** under the skills root, named
     `.bifrost-staging-<id>-<pid>-<random>`.
  2. Write all archive files into the staging directory, validating that each destination is
     inside it.
  3. Write a `.bifrost-skill.json` marker (schema v1, `source: "bifrost"`) containing
     `id`, `name`, optional `description`/`version`, `scope`, `directory`, `baseUrl`,
     `installedAt`, optional `updatedAt`, and `contentHash`.
  4. Rename the staging directory into the final location.
- Replacements (when allowed by `--force`/UI confirmation or an update) move the existing
  directory to a backup, swap the staging directory into place, then remove the backup
  best-effort.
- Refuse to overwrite an existing install without explicit force/confirmation.
- Treat directories that exist but lack a valid Bifrost marker as **foreign** and refuse
  installation without force.
- Compute a **SHA-256 content hash** over all files, sorted by relative path, as
  `name\0length\0bytes`, to drive update/unchanged decisions and auditing.
- Set file modes by content heuristic: files starting with a shebang (`#!`) are written
  `0755`; all other files are written `0644`.
- Persist an install record in plugin storage keyed by
  `installed:<scope>:<short dir hash>:<id>` as a secondary index; the on-disk marker remains
  the source of truth for recognition and safety.
- Trigger OpenCode's skill registry reload after successful installs, updates, or removals.

## Consequences

- **Positive**
  - Crash-safe installs: failures leave the previous skill intact and clean up staging.
  - Clear provenance and safe detection of plugin-managed directories.
  - Accurate no-op detection during updates; local drift is visible via content hash.
- **Negative**
  - Whole-directory replacement semantics; local edits inside an installed skill are not
    merged and are lost on replace/update.
  - The storage index can drift (for example if the filesystem is manipulated) but is
    non-authoritative.
- **Risk**
  - Concurrent installs into the same target are not explicitly lock-coordinated; unique
    staging names avoid name collisions but do not serialize the operations.
