# ADR-0008: Use conservative update and removal semantics

- **Status:** Proposed (implemented)
- **Date:** 2026-11-16
- **Deciders:** Maintainers of `@bitexpert/opencode-bifrost-skills`

## Context

Users need to refresh installed skills from the gateway without unexpected downgrades or
surprises. Installed skill directories may be edited locally; automatic merging is complex
and error-prone. Removal is destructive and must never delete arbitrary or foreign paths.

## Decision

- **Update:**
  - Target installed Bifrost records; default to `all` when no skill name is provided.
  - When both remote and installed versions are parseable as semantic versions, skip the
    update if the remote version is older.
  - Download the current archive and compare its **content hash** with the installed marker's
    hash; if identical, report the skill as `unchanged`.
  - Apply updates through the same atomic commit path used for installs (see ADR-0007).
  - Preserve the original `installedAt` and set `updatedAt` on replacement.
  - No merging of local edits: an update/replace overwrites the entire skill directory.
- **Remove:**
  - Only delete directories that satisfy all of the following:
    - They are direct children of a known skills root.
    - Their basename matches the resolved skill id/name.
    - They contain a valid Bifrost marker whose `id` matches the target.
  - Require `--global` or `--project` when the same skill exists in both scopes.
  - Remove the corresponding plugin storage entry and reload the registry.

## Consequences

- **Positive**
  - Predictable, auditable behavior; prevents silent downgrades and accidental deletion of
    unmanaged files.
  - Content-hash comparison ensures updates are meaningful rather than merely re-applying the
    same files.
- **Negative**
  - Local customizations inside installed skills are lost on update or replacement; this must
    be documented and accepted by users.
- **Tradeoff**
  - Version comparison is best-effort (non-semver strings are treated as incomparable), so
    the content hash is the decisive signal for "no change".
