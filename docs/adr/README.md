# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for `opencode-bifrost-skills`.

## Purpose

ADRs document important design decisions, the context in which they were made, the chosen
alternatives, and the consequences of the choice. They are intended to make the project's
rationale easier to discover and discuss.

## Conventions

- Each ADR is a single Markdown file named `NNNN-short-title.md`, where `NNNN` is a
  zero-padded sequence number.
- ADRs use a lightweight MADR-inspired structure: **Status**, **Context**, **Decision**, and
  **Consequences**.
- New decisions should get the next available number; existing ADRs are not renumbered.
- When a decision is superseded, mark the old ADR **Superseded** and link to the replacement.

## Current ADRs

| ADR  | Title                                                                                       | Status   |
| ---- | ------------------------------------------------------------------------------------------- | -------- |
| 0001 | [Distribute as a no-build TypeScript OpenCode plugin package](0001-no-build-plugin.md)      | Proposed |
| 0002 | [Split server plugin, TUI plugin, and shared RPC contract](0002-plugin-split.md)            | Proposed |
| 0003 | [Model skill identity as name, id, and plugin name](0003-skill-identity.md)                 | Proposed |
| 0004 | [Support global and project install scopes](0004-install-scopes.md)                         | Proposed |
| 0005 | [Use multi-source catalog fallback with catalog-independent installs](0005-catalog.md)      | Superseded |
| 0006 | [Validate archives and enforce bounded downloads](0006-archive-validation.md)               | Proposed |
| 0007 | [Install atomically with staging, markers, and content hashes](0007-atomic-install.md)      | Proposed |
| 0008 | [Use conservative update and removal semantics](0008-update-removal.md)                     | Proposed |
| 0009 | [Resolve configuration with precedence, normalization, and secret handling](0009-config.md) | Superseded |
| 0010 | [Provide forgiving slash commands with non-model transcript reporting](0010-commands.md)    | Superseded |
| 0011 | [Use minimal runtime dependencies and Bun-native tooling](0011-dependencies.md)             | Proposed |
| 0012 | [Use only public skill routes; no management credentials](0012-public-skill-routes.md)      | Proposed |

## Notes

- The ADRs in this repository describe decisions already implemented in the codebase, so
  their status is **Proposed** until formally reviewed and accepted.
- Where an ADR mentions package metadata inconsistencies (for example repository vs. homepage
  URLs), those are documentation/hygiene items and may be addressed without creating a new ADR.
