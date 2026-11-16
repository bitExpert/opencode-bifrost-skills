# ADR-0002: Split server plugin, TUI plugin, and shared RPC contract

- **Status:** Proposed (implemented)
- **Date:** 2026-11-16
- **Deciders:** Maintainers of `@bitexpert/opencode-bifrost-skills`

## Context

Installing skills from a Bifrost gateway involves privileged and potentially long-running
operations: HTTP requests, settings persistence, filesystem writes, and reloading OpenCode's
skill registry. The same plugin also needs an interactive catalog browser with dialogs,
toasts, and search.

OpenCode separates server-side plugin capabilities from TUI interactions. Placing all logic
in one component would make it hard to reason about trust boundaries, reuse operations, and
avoid slash-command naming collisions.

## Decision

- **Server part** (`src/index.ts`, backed by `Operations`):
  - Owns the Bifrost HTTP client, settings resolution/storage, archive validation,
    filesystem writes, and registry reloads.
  - Registers all non-interactive `/bifrost-*` slash commands.
  - Executes commands directly and reports results by emitting a `notice` event and appending
    a synthetic session message to the transcript without waking the model.
- **TUI part** (`src/tui.tsx`):
  - Owns the interactive `/bifrost-skills` command (catalog browser with search, scope
    selection, overwrite confirmation, and "install another" loop).
  - Consumes server functionality through the typed RPC contract and reacts to `notice` events
    with toasts.
- **Shared RPC contract** (`src/rpc.ts`, `BifrostRpc`):
  - Defines typed methods for `catalog`, `install`, `installAll`, `list`, `update`, `remove`,
    and `config`, plus a `notice` event schema.
  - Uses explicit object schemas (close to JSON Schema) to keep TUI and server in sync.
- **Operations** (`src/operations.ts`) are a framework-agnostic domain service used by both the
  server commands and RPC handlers, making behavior testable with mocked gateways/storage.

## Consequences

- **Positive**
  - Clear trust/ownership boundary: network and filesystem mutations live in one place.
  - Reusable operations for slash commands and UI flows.
  - Avoids command-name collisions and keeps interactive UI in the TUI where dialogs/toasts
    are available.
- **Negative**
  - More moving parts: the RPC schemas and domain types must be kept aligned.
  - The TUI relies on specific OpenCode context APIs and data shapes
    (`session`, `location`, `ui.dialog`, `ui.toast`, `data.location.skill.invalidate`);
    plugin API changes may require coordinated updates.
- **Notes**
  - The server's synthetic message approach ensures command outcomes appear in chat history
    without triggering model inference.
