# ADR-0001: Distribute as a no-build TypeScript OpenCode plugin package

- **Status:** Proposed (implemented)
- **Date:** 2026-11-16
- **Deciders:** Maintainers of `@bitexpert/opencode-bifrost-skills`

## Context

OpenCode 2 plugins run on OpenCode's Bun-based runtime and can load TypeScript/TSX sources
directly. The project provides three public surfaces (server plugin, TUI plugin, RPC contract)
and needs to be easy to develop, test, and consume.

A full transpile/build step would add tooling, create separate `dist/` artifacts, and introduce
the risk of published code diverging from the source tested in CI.

## Decision

- Publish the npm package with **source-level exports**, not built artifacts:
  - `.` → `./src/index.ts` (server plugin)
  - `./tui` → `./src/tui.tsx` (TUI plugin)
  - `./rpc` → `./src/rpc.ts` (typed RPC contract)
- Keep `files` limited to `src`, `README.md`, and `LICENSE`.
- Require Bun for development and tests (`engines.bun >= 1.2`), while relying on OpenCode's
  bundled runtime to execute the plugin in production.
- Use strict TypeScript (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `isolatedModules`, `verbatimModuleSyntax`) with `noEmit`.
- Use Biome for linting and a single `npm run check` command (`lint`, `typecheck`, `test`) for
  CI and local validation.

## Consequences

- **Positive**
  - Single source of truth: the code shipped, tested, and reviewed is identical.
  - Simple packaging and release flow (no build artifacts to publish).
  - Fast local workflow: `bun test` and `tsc --noEmit` run directly against sources.
- **Negative**
  - Consumers must run a runtime that can load TS/TSX (true for OpenCode).
  - The package is not usable as an ordinary Node library without transpilation.
- **Notes**
  - `package.json` currently mixes GitHub and GitLab URLs (repository/CI vs. homepage/issues).
    Aligning those is a separate metadata/hygiene decision, not a change to this ADR.
