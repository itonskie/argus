# PRD: argus MVP

**Issue:** #1
**Date:** 2026-07-03
**Status:** Draft
**Brainstorm:** [`docs/brainstorms/argus-mvp-2026-07-03.md`](../../brainstorms/argus-mvp-2026-07-03.md)

## Problem Statement

MCP server developers today have two options when they want to see what a server does: hand-roll JSON-RPC payloads in a scratch file, or open Anthropic's official web-based Inspector. For the vim / tmux crowd — devs who live in the terminal and treat leaving it as friction — both options are painful. The web Inspector is capable but forces a browser context-switch on every iteration. Hand-rolling JSON-RPC is slow and error-prone. There's no keyboard-first, terminal-native equivalent of the Inspector.

## Solution

argus is a keyboard-first TUI for inspecting and exercising local MCP servers over stdio. Point it at a server binary, get a three-pane view of what the server exposes, invoke tools / resources / prompts with a schema-driven form, see the response. That's the whole job.

argus does **not** compete with the official Inspector on feature breadth. It wins on ergonomics for terminal-native users: instant launch, vim navigation, no browser tab. Success = "the vim crowd reaches for argus instead of switching tabs."

Two non-negotiable UX properties:
- Cold-start to first paint under 200ms (otherwise the already-open browser tab wins).
- UX for shared features must not be worse than the Inspector.

## User Stories

1. As an MCP server dev, I want to launch argus with `argus ./path/to/server.js` and see its capabilities within 200ms, so that starting an inspection feels instant.
2. As an MCP server dev, I want to see which server I'm connected to (path, transport, process status) in a persistent pane, so that I always know what I'm poking at.
3. As an MCP server dev, I want to press `t` to see the server's tools, `r` for resources, `p` for prompts, so that I can browse capabilities by category with one keystroke.
4. As an MCP server dev, I want vim-style pane navigation (`h`/`l` between panes, `j`/`k` within lists), so that I don't need to touch a mouse or learn a new key model.
5. As an MCP server dev, I want to highlight a tool / resource / prompt and see its schema + description as a preview, so that I can decide whether to invoke it without committing to a form.
6. As an MCP server dev, I want to press Enter on a highlighted item to focus a form, so that the transition from "browsing" to "invoking" is one keystroke.
7. As an MCP server dev, I want form fields auto-generated from the JSON Schema for primitives (string, number, boolean, enum), nested objects, and arrays of primitives, so that I don't have to remember the shape of common arguments.
8. As an MCP server dev, I want a per-field raw-JSON textarea fallback for schema shapes argus can't render as real fields (arrays of objects, `oneOf` / `anyOf`, `$ref`, binary), so that unsupported shapes don't block me from invoking the tool.
9. As an MCP server dev, I want ajv to validate my assembled payload on submit — including fields that used the raw-JSON fallback — so that I catch schema errors before the server does.
10. As an MCP server dev, I want the form to fire the call on submit and render the response in the same pane, pretty-printed and scrollable, so that request and response live in the same visual location.
11. As an MCP server dev, I want to press `o` on a large response to open its raw payload in `$PAGER`, so that Ink's rendering doesn't slow me down on 200KB responses.
12. As an MCP server dev, I want in-session history — arrow-up in the form re-runs the last call with the same args, so that iterating on the same tool is one keystroke.
13. As an MCP server dev, I want clear connection error states (server crashed, initialize timeout, invalid path), so that I can diagnose faster than reading a stack trace.
14. As an MCP server dev, I want argus to cleanly shut down the child MCP process when I exit the TUI, so that stray server processes don't accumulate.
15. As an MCP server dev, I want argus to install and run as `npx @itonskie/argus <path>` without a global install, so that trying it out costs nothing.
16. As an MCP server dev, I want argus to work with any stdio-transport MCP server that conforms to the SDK, so that argus is usable on my own in-progress work as well as published servers like `@modelcontextprotocol/server-filesystem`.
17. As an MCP server dev iterating on a schema, I want argus to reflect schema changes on the next connection, so that I can edit → restart argus → re-inspect in a tight loop.

## Implementation Decisions

### Modules

**Deep modules (heavy testing, stable interfaces):**

- **`mcp-client`** — thin conceptual layer over `@modelcontextprotocol/sdk` that manages the single active connection. **Interface:** `connect(path) → Session`, `listTools() / listResources() / listPrompts() → Capability[]`, `invoke(name, args) → Result`, `disconnect()`. **What it hides:** child-process spawn/kill, `initialize` handshake and timeout, crash detection, clean shutdown, error normalization into a small closed set of error types the UI can render. Lazy-loaded — not imported until after Ink's first paint.

- **`form-engine`** — takes a JSON Schema, produces a form definition + a submit function. **Interface:** `schemaToForm(schema) → FormSpec`, `submit(formState) → { valid: true, payload } | { valid: false, errors }`. **What it hides:** the schema walker, the graceful-ladder decision (which fields render as real inputs vs raw-JSON textarea), field-level state management, and ajv assembly + validation of the merged payload. Ajv itself is lazy-loaded — not imported until first form render.

**Thin glue (integration-tested only, no isolated unit suites):**

- **`app-shell`** — Ink app root. Owns the three-pane layout, the keyboard router (which pane has focus, which key mappings apply), and the top-level state machine (browsing / focused-form / viewing-result). Composes the deep modules; contains no MCP or schema logic itself.

- **`result-view`** — takes an MCP invocation result, renders it pretty-printed and scrollable. Exposes an `o` binding that pipes the raw payload to `$PAGER`. Auto-suggests paging above a size threshold (initial: 20KB, tuned during testing).

**Test infra:**

- **`test-server-fixture`** — in-repo MCP server exposing every supported schema shape (flat primitives, nested objects, arrays of primitives) plus one of each fallback case (array of objects, `oneOf`, `$ref`, binary). Drives ajv + form-render tests and end-to-end integration tests. Not tested itself — it is the test bench.

### Layout & interactions (locked)

- Three panes, left → right: connection info | capabilities (tabbed t/r/p) | detail-form-result.
- Right pane is a mode: preview when browsing, form when Enter pressed, result after submit. Same physical location so the user's eye doesn't jump.
- Keybindings: `h`/`l` panes, `j`/`k` list items, `t`/`r`/`p` capability tabs, Enter to focus form, submit runs the call, arrow-up in form re-runs last invocation with same args, `o` opens response in `$PAGER`, `q` / Ctrl-C exits cleanly.

### Launch

- `argus ./path/to/server.js` — path is required. Bare `argus` errors out with a clear message. No saved-configs list in MVP.

### Startup budget

- Cold-start to first paint **< 200ms** on a modern laptop.
- Enforced by: tsup single-file ESM bundle (minified), lazy dynamic import of `@modelcontextprotocol/sdk` and `ajv` after Ink's first render, zero top-level imports of heavyweight deps in the main entry.
- CI adds a startup-timing check so regressions are caught, not discovered post-ship.

### State

- **Zero disk state.** No `~/.argus/`. No `servers.json`, no history file, no cache. When saved configs or cross-session history land later, they land as separate features without breaking anything.
- In-session history only: last-call args live in memory until the process exits.

### Stack (locked in README)

- Node 20+, TypeScript strict
- Ink (React for terminals)
- `@modelcontextprotocol/sdk` (official client)
- ajv (JSON Schema validation for the dynamic forms)
- tsup (bundling)
- Vitest + ink-testing-library (tests)
- Biome (lint + format)
- pnpm (package manager)

### Packaging

- Publishes as `@itonskie/argus`.
- Both `npx @itonskie/argus <path>` and `npm i -g @itonskie/argus` && `argus <path>` are supported entry paths.

## Testing Decisions

### What to test heavily

- **`form-engine`.** The graceful ladder is the highest-risk, highest-value logic in the app. Tests should assert against the module's public interface (`schemaToForm`, `submit`) — given schema X, form spec is Y; given form state Z, payload is W or errors are E. Every branch of the ladder gets covered via the `test-server-fixture` schemas. Tests must survive an internal refactor of the schema walker.

- **`mcp-client`.** Lifecycle correctness is the second-highest risk. Test against the public interface (`connect` / `list*` / `invoke` / `disconnect`) using the `test-server-fixture` as the server side. Cover: happy path, `initialize` timeout, server crashes mid-session, disconnect cleans up child process, error type shapes.

### What to test lightly

- **`app-shell` + `result-view`** — integration-tested end-to-end through `ink-testing-library` driven by the test-server fixture. Assert on rendered TUI output for the golden path (connect → browse → invoke → view result) and one failure path (server crash mid-invocation). No isolated component unit tests — they'd be brittle and low-value.

### What is not unit-tested

- Real published MCP servers (network deps, moving targets). Explicitly rejected during grill.
- Startup performance — separate CI check, not a Vitest suite.

### Manual smoke test

- Before every release: run argus against `@modelcontextprotocol/server-filesystem`, verify list → invoke → view result works.

### Prior art

- No existing tests in the repo yet. First test written establishes the pattern. Preference: table-driven schema tests for `form-engine` (many small inputs, one assertion each), scenario tests for `mcp-client` lifecycle.

## Out of Scope

- **SSE / HTTP transports.** stdio only for MVP. SSE / HTTP add later without breaking the client wrapper interface.
- **Session recording / replay.** Explicitly cut. If regression coverage is needed, it lives in Vitest, not the TUI.
- **Saved server configs.** No `servers.json`. Launch by path each time.
- **Cross-session history.** In-session only.
- **Bookmarks or named saved calls.**
- **OAuth flows.**
- **Multi-server-at-once.**
- **Eval suites.**

## Further Notes

- **No `DESIGN.md`.** This is a TUI, not a web/mobile UI. Terminal visual choices (colors, borders, focus indicators, key hints) belong in an engineering-spec or an inline UX section, not a design system doc.
- **Ink stays.** The form engine alone justifies it — imperative TUI forms would be miserable to build and maintain. Startup latency is mitigated by lazy loading, not by dropping Ink.
- **Definition of Done:**
  - End-to-end works (list → invoke → view result) against the in-repo `test-server-fixture`.
  - Manual smoke test against `@modelcontextprotocol/server-filesystem` passes before release.
  - Cold-start to first paint measured < 200ms on a modern laptop.
  - CI green (lint, type-check, tests) on Node 20 + 22.
  - Package publishes cleanly as `@itonskie/argus` and `npx @itonskie/argus <path>` works.
