# Engineering Spec — argus MVP

**PRD:** [`docs/specs/prds/1-argus-mvp.md`](prds/1-argus-mvp.md) · Issue #1
**Design spec:** [`design-spec.md`](design-spec.md)
**ADRs:** [`docs/adrs/`](../adrs/)

This spec covers architecture, module boundaries, data flow, lifecycle, and testing strategy. Every non-obvious decision links to an ADR.

---

## 1. Architecture

argus is a single-process Node CLI. It spawns one child process per session (the MCP server) and talks to it over stdio. There is no server, no daemon, no persistent state.

```
┌────────────────────────────────────────────────────────────┐
│                        argus process                       │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │                     app-shell                        │  │
│  │  Ink component tree, keyboard router, focus / mode   │  │
│  │  state machine                                       │  │
│  └───────────────┬────────────────────────┬─────────────┘  │
│                  │                        │                │
│         (invoke, listX, connect)   (schemaToForm, submit)  │
│                  │                        │                │
│  ┌───────────────▼─────────────┐  ┌───────▼─────────────┐  │
│  │        mcp-client           │  │     form-engine     │  │
│  │  wraps @modelcontextprotocol│  │  schema walker      │  │
│  │  /sdk. Owns child-process   │  │  + graceful-ladder  │  │
│  │  lifecycle. Lazy-loaded.    │  │  + ajv assembly.    │  │
│  │                             │  │  Ajv lazy-loaded.   │  │
│  └───────────────┬─────────────┘  └─────────────────────┘  │
│                  │                                         │
│                  │ stdio (JSON-RPC)                        │
└──────────────────┼─────────────────────────────────────────┘
                   │
        ┌──────────▼──────────┐
        │  MCP server child   │
        │  (user-supplied)    │
        └─────────────────────┘
```

---

## 2. Modules

### 2.1 `mcp-client` (deep)

Wraps `@modelcontextprotocol/sdk`. Owns the single active connection.

**Public interface:**

```ts
type ConnectionInfo = { path: string; transport: "stdio"; pid: number };

type Capability = {
  name: string;
  description?: string;
  schema: JSONSchema;
};

type InvokeResult =
  | { ok: true; result: unknown }
  | { ok: false; error: McpError };

type McpError =
  | { kind: "server-error"; code: number; message: string; data?: unknown }
  | { kind: "timeout" }
  | { kind: "disconnected" };

interface McpClient {
  connect(path: string): Promise<ConnectionInfo>;
  listTools(): Promise<Capability[]>;
  listResources(): Promise<Capability[]>;
  listPrompts(): Promise<Capability[]>;
  invoke(name: string, args: unknown): Promise<InvokeResult>;
  disconnect(): Promise<void>;
  onDisconnect(cb: (reason: McpError) => void): void;
}
```

**Encapsulation:**
- Child process spawn / kill.
- `initialize` handshake with a 5s timeout.
- Detection of unexpected child exit → fires `onDisconnect`.
- Clean shutdown on `disconnect()` — sends the shutdown notification, waits up to 2s, then SIGTERM, then SIGKILL.
- Error normalization into the `McpError` union — the UI never sees SDK-internal error types.

**Lazy loading:** `@modelcontextprotocol/sdk` is imported dynamically inside `connect()`, not at module top-level. See [ADR 2](../adrs/2-lazy-load-heavyweight-deps.md).

### 2.2 `form-engine` (deep)

Turns a JSON Schema into a form definition and a validated payload.

**Public interface:**

```ts
type FormFieldKind =
  | { kind: "string" | "number" | "boolean" }
  | { kind: "enum"; options: string[] }
  | { kind: "object"; fields: FormField[] }
  | { kind: "array-of-primitives"; itemKind: "string" | "number" | "boolean" }
  | { kind: "raw-json"; reason: "array-of-objects" | "oneOf" | "anyOf" | "ref" | "binary" };

type FormField = {
  path: string[];          // key path into the payload
  label: string;
  required: boolean;
  fieldKind: FormFieldKind;
  default?: unknown;
  description?: string;
};

type FormSpec = { fields: FormField[] };

type FormState = Record<string /* dotted path */, unknown /* raw input */>;

type SubmitResult =
  | { valid: true; payload: unknown }
  | { valid: false; errors: Array<{ path: string[]; message: string }> };

interface FormEngine {
  schemaToForm(schema: JSONSchema): FormSpec;
  submit(schema: JSONSchema, state: FormState): SubmitResult;
}
```

**Encapsulation:**
- Schema walker (handles `$defs`, nested `object`, `array`).
- Graceful-ladder decision — which fields render as real inputs vs raw-JSON textarea. See [ADR 5](../adrs/5-graceful-ladder-form-fallback.md).
- Payload assembly: reads `FormState`, parses raw-JSON fields, builds the merged object.
- ajv validation of the assembled payload against the original schema.

**Lazy loading:** `ajv` is imported dynamically inside `submit()` and inside `schemaToForm()` only on first call. See [ADR 2](../adrs/2-lazy-load-heavyweight-deps.md).

### 2.3 `app-shell` (thin)

Ink root component. Composes the other modules. Contains:
- Three-pane layout components (`ConnectionPane`, `CapabilitiesPane`, `DetailPane`).
- Keyboard router: reads focused pane + mode, dispatches key events (see design-spec § 5.1).
- Top-level state machine — connection status, focused pane, right-pane mode (Preview / Form / Result), selected capability, form state, last invocation.
- Status bar renderer.

Contains **no MCP logic** and **no schema logic** — those live behind the deep-module interfaces.

### 2.4 `result-view` (thin)

Given an `InvokeResult`, renders it. Owns:
- Pretty-print + syntax highlight for JSON results.
- Size threshold detection (20 KB → suggest `$PAGER`; strict threshold for auto-suggest, user can still scroll inline).
- `o` → spawn `$PAGER`, pipe raw payload, restore Ink on pager exit.

### 2.5 `test-server-fixture` (test infra)

An in-repo MCP server that exposes tools / resources / prompts covering every supported schema shape and every fallback case. See [ADR 6](../adrs/6-in-repo-test-server-fixture.md).

---

## 3. Data flow

### 3.1 Startup

```
node argus.js ./server.js
  │
  ▼
argv parse (only path arg — no flags in MVP)
  │
  ▼
Ink renders app-shell (connecting state)     ← first paint target: < 200ms
  │
  ▼
lazy import mcp-client → connect(path)
  │
  ▼
onConnected: fetch tools/resources/prompts concurrently
  │
  ▼
app-shell renders three-pane view
```

### 3.2 Invocation

```
user selects tool, presses Enter
  │
  ▼
app-shell: lazy import form-engine → schemaToForm(schema)
  │
  ▼
DetailPane renders form
  │
  ▼
user fills fields, presses Enter to submit
  │
  ▼
form-engine.submit(schema, state)
  │        │
  │        └─ invalid: return errors, DetailPane highlights bad fields
  │
  ▼
mcp-client.invoke(name, payload)
  │
  ▼
result-view renders response in DetailPane
```

### 3.3 Shutdown

```
user presses q (or Ctrl-C, or app crashes)
  │
  ▼
Ink unmount
  │
  ▼
mcp-client.disconnect() (best-effort, 2s timeout, then SIGTERM/SIGKILL)
  │
  ▼
process.exit(0)
```

---

## 4. Startup budget

**Target:** cold start to first paint < 200ms on a modern laptop.

**Enforcement:**
- tsup produces a single-file, minified ESM bundle.
- `@modelcontextprotocol/sdk` and `ajv` are imported via dynamic `import()` from within the modules that use them, not at file top-level.
- The main entry does zero MCP or schema work before Ink's first render — it parses argv, mounts Ink with a "connecting…" state, then triggers the dynamic imports.
- CI job `startup-budget` boots argus with a no-op path, measures time from process spawn to Ink's first `stdout.write`, fails if > 200ms.

Rationale: [ADR 2](../adrs/2-lazy-load-heavyweight-deps.md).

---

## 5. Failure handling

| Failure | Detection | Recovery | UX |
|---|---|---|---|
| Path does not exist | `fs.stat` fails at argv-parse time | Fatal — exit 1 with stderr message before Ink mounts | Terminal shows single-line error, no TUI |
| Server never responds to `initialize` | 5s timeout in `mcp-client.connect` | Fatal — cannot recover in-session | Left pane shows error state, only `q` works (design-spec § 3.1) |
| Server exits mid-session | `child.on("exit")` fires unexpectedly | Cannot re-invoke | `onDisconnect` fires → app-shell disables Form + Result modes; left pane error state |
| `listTools/Resources/Prompts` returns error | mcp-client returns typed error | User retries via `r` in that pane | Middle pane inline error (design-spec § 3.2) |
| `invoke` returns server error | Server responds with JSON-RPC error | User edits form and re-submits | Result mode renders error block (design-spec § 3.5) |
| `invoke` times out (30s) | mcp-client timeout | User retries or edits | Result mode error block |
| Form validation fails on submit | `form-engine.submit` returns invalid | User fixes and re-submits | Fields highlighted red (design-spec § 3.4) |
| Terminal too small | Ink `useStdoutDimensions` < 80×24 | Wait for resize | Single-line "requires 80×24" message |

Reasoning: state changes flow one direction. mcp-client is the source of truth for connection state; app-shell subscribes. Never optimistic — no UI state changes until the underlying module confirms.

---

## 6. State management

- **All state lives in app-shell's React state tree.** No global store, no context beyond what's local to each pane.
- **In-session only.** Nothing persists to disk. See [ADR 3](../adrs/3-zero-disk-state-mvp.md).
- **Last-invocation cache** is a single ref: `{ tool: string; args: unknown } | null`. Cleared when the user switches to a different tool.

---

## 7. Testing strategy

### 7.1 What to test where

| Module | Test level | Framework | Rationale |
|---|---|---|---|
| `form-engine` | unit (heavy) | Vitest, table-driven | Schema walker + graceful-ladder logic — highest-risk, highest-value. Public interface (`schemaToForm`, `submit`) is stable; tests survive internal refactors. |
| `mcp-client` | unit (heavy) | Vitest + `test-server-fixture` as counterparty | Lifecycle correctness. Cover: happy path, `initialize` timeout, server crash mid-session, clean disconnect, `McpError` shapes. |
| `app-shell` + `result-view` | integration | `ink-testing-library` + `test-server-fixture` | Assert rendered output for the golden path (connect → browse → invoke → view) and one failure path (server crash mid-invocation). No isolated component units — brittle and low-value. |
| Startup budget | perf | Custom CI job (§ 4) | Not a Vitest suite — measured on the actual bundled entry, not the source tree. |

### 7.2 What is not unit-tested

- Real published MCP servers. Rejected during grill — network deps, moving targets, flaky. See [ADR 6](../adrs/6-in-repo-test-server-fixture.md).
- Ink's internals. We trust the library.
- `$PAGER` spawning. Manual smoke test only.

### 7.3 Manual smoke test (release gate)

Before each release, argus must:
- Launch against `@modelcontextprotocol/server-filesystem`.
- List → invoke `read_file` on a known file → view result.
- Cleanly shut down.

Result recorded in the release PR description.

### 7.4 CI

Runs on Node 20 and Node 22 (matrix):
1. `pnpm install --frozen-lockfile`
2. `pnpm biome check` (lint + format)
3. `pnpm tsc --noEmit` (type-check)
4. `pnpm test` (Vitest, unit + integration)
5. `pnpm startup-budget` (custom job — see § 4)

All must pass to merge.

---

## 8. Packaging

- Package name: `@itonskie/argus`.
- Bin: `argus` → single-file ESM output from tsup.
- Node engines: `>=20`.
- Zero runtime deps in `package.json` after bundling — tsup inlines `@modelcontextprotocol/sdk`, `ajv`, and everything else. (Verify with `pnpm pack` + inspection.)
- Publishes on git tag `v*` via GitHub Actions.

---

## 9. Non-goals (engineering-spec scope)

- Plugin system / theming API.
- Multi-transport abstraction. stdio-only per [ADR 4](../adrs/4-stdio-only-transport-mvp.md); when SSE / HTTP land, `mcp-client.connect` grows a transport parameter — the interface is already shaped for it.
- Structured logging / observability. Stderr + exit codes are the surface area for MVP.
