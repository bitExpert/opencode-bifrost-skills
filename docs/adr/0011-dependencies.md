# ADR-0011: Use minimal runtime dependencies and Bun-native tooling

- **Status:** Proposed (implemented)
- **Date:** 2026-11-16
- **Deciders:** Maintainers of `@bitexpert/opencode-bifrost-skills`

## Context

The plugin performs ZIP extraction, YAML frontmatter parsing, and integration with OpenCode
APIs. It must keep its bundle and runtime simple, minimize supply-chain surface, and provide
fast, deterministic tests for filesystem/network/ZIP edge cases.

OpenCode runs on Bun, so aligning the development and test tooling with the runtime avoids
extra transpilation steps and behavior differences.

## Decision

- **Runtime dependencies (minimal):**
  - `@opencode/plugin` (host integration and typed RPC).
  - `fflate` (ZIP decode/inflate).
  - `yaml` (frontmatter parsing).
  - Use platform `fetch`, `node:fs`, `node:crypto`, and `node:path` rather than heavier HTTP
    or filesystem libraries.
- **Development dependencies:**
  - `@biomejs/biome` for linting/formatting.
  - `typescript` for type checking (`noEmit`).
  - `@types/bun` and `@types/node` for typing.
- **Testing/tooling:**
  - Use Bun's built-in test runner (`bun test`).
  - Prefer in-memory storage and mocked gateway implementations for most tests, with
    targeted real-local cases where necessary.
  - Cover arguments parsing, Bifrost client fallbacks and error handling, ZIP safety, settings
    precedence, operations (install/list/update/remove), and server plugin behavior.
- **Quality gates:**
  - `npm run check` runs Biome, TypeScript, and the test suite.
  - CI badge/workflow should run the same checks on push/PRs.

## Consequences

- **Positive**
  - Small dependency footprint and clear control over security-sensitive logic (downloads,
    ZIP handling, install paths).
  - Fast feedback loop aligned with Bun's runtime behavior.
- **Negative**
  - More bespoke implementation (HTTP error handling, streaming caps, path normalization,
    install atomicity) to own and maintain compared to higher-level libraries.
- **Risk**
  - Correctness of edge-case handling depends on dedicated tests; regressions in timeouts,
    streaming caps, or path validation must be caught by the suite.
