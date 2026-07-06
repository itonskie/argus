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
- A top-level mode: `startup` (renders `<StartupScreen>`) or `connected` (renders the three-pane layout).
- Three-pane layout components (`ConnectionPane`, `CapabilitiesPane`, `DetailPane`) when `mode === 'connected'`.
- Keyboard router: reads focused pane + mode, dispatches key events (see design-spec §5.1). Includes the `s` swap keybind that is active in Preview, Result, and connection-error states, and a silent no-op in Form / Invoking.
- Per-pane `scrollTop` state (middle list, right preview, right form, right result). Each render pass calls `scroll-window` (§2.6) to compute the visible window and the `↑ N / ↓ N` counts.
- Fixed pane sizing from `useWindowSize()` — no content-driven growth (design-spec §2.5). Recomputes on resize only.
- Top-level state machine — connection status, focused pane, right-pane mode (Preview / Form / Invoking / Result), selected capability, form state, last invocation.
- Status bar renderer (design-spec §3.6). Hides `s swap` in Form and Invoking; shows it elsewhere.

Contains **no MCP logic**, **no schema logic**, and **no history-file logic** — those live behind the deep-module interfaces (`mcp-client`, `form-engine`, `server-history`).

### 2.4 `result-view` (thin)

Given an `InvokeResult`, renders it. Owns:
- Pretty-print + syntax highlight for JSON results.
- Size threshold detection (20 KB → suggest `$PAGER`; strict threshold for auto-suggest, user can still scroll inline).
- `o` → spawn `$PAGER`, pipe raw payload, restore Ink on pager exit.

### 2.5 `test-server-fixture` (test infra)

An in-repo MCP server that exposes tools / resources / prompts covering every supported schema shape and every fallback case. See [ADR 6](../adrs/6-in-repo-test-server-fixture.md).

### 2.6 `scroll-window` (deep)

Pure windowing math for every scrollable pane. Encapsulates the "focused row must stay visible" clamp. No React or Ink dependency — plain function, table-driven tests.

**Public interface:**

```ts
type ScrollWindowInput = {
  totalRows: number;
  focusedIndex: number;      // -1 when nothing is focused
  viewportHeight: number;    // rows available for content, excluding scroll-indicator rows
  previousScrollTop: number;
};

type ScrollWindow = {
  startIndex: number;        // inclusive
  endIndex: number;          // exclusive
  scrollTop: number;         // === startIndex; exposed for callers that persist it
  topHidden: number;         // rows above the window (feeds ↑ N indicator)
  bottomHidden: number;      // rows below the window (feeds ↓ N indicator)
};

function computeScrollWindow(input: ScrollWindowInput): ScrollWindow;
```

**Encapsulation:**
- Clamp rule: `focusedIndex < previousScrollTop` → scroll up so `startIndex = focusedIndex`. `focusedIndex >= previousScrollTop + viewportHeight` → scroll down so `endIndex = focusedIndex + 1`. Otherwise `startIndex = previousScrollTop`.
- Degenerate inputs (`viewportHeight <= 0`, `totalRows === 0`, `focusedIndex === -1`) return a zero window without dividing by zero or producing negative counts.
- Caller supplies `viewportHeight` after subtracting scroll-indicator rows — the module treats indicators as caller concern (they're purely visual; the clamp math should not care).

**Consumers:** middle-pane list, right-pane preview text, right-pane result text, right-pane form (via `form-row-flattener`). Each pane owns its own `scrollTop` state and passes it in as `previousScrollTop`.

### 2.7 `form-row-flattener` (deep)

Turns a `FormSpec` + `FormState` + focused-field index into a flat, ordered list of *rendered rows*. Enables `scroll-window` to operate on form content that has variable per-field heights (labels, inputs, inline errors, description lines, array items, "+ add row" affordances).

**Public interface:**

```ts
type FocusRowKind =
  | "field-label" | "field-input" | "field-error" | "field-description"
  | "array-item" | "array-add"
  | "object-header";

type FocusRow = {
  kind: FocusRowKind;
  fieldIndex: number;   // index into FormSpec.fields; -1 for structural rows with no owning field
};

type FlattenedForm = {
  rows: FocusRow[];
  focusedRowIndex: number;  // row that must remain visible; the clamp anchor
};

function flattenForm(
  spec: FormSpec,
  state: FormState,
  focusedFieldIndex: number,
): FlattenedForm;
```

**Encapsulation:**
- Row emission per field kind (see `form-engine.FormFieldKind`): a `string` field emits label + input (+ optional error + optional description); `array-of-primitives` emits label + one row per current item + one `array-add` row; `object` emits an `object-header` then a run of child rows; `raw-json` emits label + a multi-line input treated as a single row for windowing purposes.
- Focused-row selection: the `focusedRowIndex` points to the field's `field-input` row (the anchor `scroll-window` clamps against). Description and error rows attached to the focused field stay in the window whenever possible, but the input row is the source of truth.
- Recomputation is cheap; the flattener runs on every render of the form pane.

### 2.8 `server-history` (deep)

Persistence for the recent-servers list. Owns file layout, atomic writes, schema validation, LRU semantics, and the `ARGUS_NO_HISTORY` opt-out. Consumed by `app-shell` on mount (`list()`) and after a successful `initialize` (`record(path)`).

**Public interface:**

```ts
type HistoryEntry = { path: string; missing: boolean };

interface ServerHistory {
  list(): Promise<HistoryEntry[]>;
  record(path: string): Promise<void>;
}

function createServerHistory(env?: NodeJS.ProcessEnv): ServerHistory;
```

**Encapsulation:**
- **Path resolution.** `$XDG_CONFIG_HOME/argus/history.json` when the env var is set and non-empty; otherwise `~/.config/argus/history.json`. Windows uses the same fallback (best-effort target).
- **Opt-out.** When `ARGUS_NO_HISTORY=1`, `list()` returns `[]` and `record()` is a no-op. No directory is created. No file is read.
- **Schema.** `{ version: 1, servers: string[] }`. Any other shape (missing / non-1 version, non-array `servers`, non-string entries) is treated as corrupted — `list()` returns `[]` and a one-line warning goes to stderr: `argus: history file at <path> couldn't be read, starting fresh`. Malformed JSON gets the same treatment.
- **LRU + cap.** `record(path)` resolves the path with `path.resolve` (so the same server invoked from different CWDs de-dupes), prepends it, drops any duplicates further down the list, truncates to 10 entries, and writes.
- **Atomic write.** Write to `history.json.tmp` first, then `rename()` over `history.json`. The file is never partially written; concurrent argus processes are last-writer-wins with at worst one lost entry, never a corrupt file.
- **Missing-path detection.** `list()` runs `fs.stat` on each entry and sets `missing: true` when it fails. This is per-`list()` (no cache) — an entry that was missing yesterday and is present today reports correctly.

**Not encapsulated (deliberately):**
- The `<StartupScreen>` component reads the array but does not own it — `app-shell` calls `list()` and passes the result down as a prop. Keeps the component pure.
- `record()` failures do not block the UI. `app-shell` calls it fire-and-forget after a successful `initialize`.

### 2.9 `startup-screen` (thin)

Ink component rendered when `app-shell.mode === 'startup'`. Consumes `server-history` results via props, not directly.

**Owns:**
- Two-zone focus model: `input` (path text field) and `list` (recent servers).
- Initial-focus rule: `list` if the received `history` prop is non-empty, else `input`.
- `tab` / `shift+tab` swap zones.
- `enter` in `input` → invokes `onConnect(typedPath)` (empty input is a no-op).
- `enter` in `list` → invokes `onConnect(selectedEntry.path)` unless the entry has `missing === true`, in which case renders the inline `path not found` line and stays put.
- `q` / `ctrl+c` → quit.
- Renders `(missing)` in dim next to entries whose path was deleted / moved after being recorded.

**Props:**

```ts
type StartupScreenProps = {
  history: HistoryEntry[];
  onConnect: (path: string) => void;
  env: UiEnv;   // ASCII / NO_COLOR / reduced-motion flags, mirroring the three-pane view
};
```

**Does not own:** history reads / writes, path resolution, `fs.stat` calls — all encapsulated by `server-history` and called from `app-shell`.

---

## 3. Data flow

### 3.1 Startup

```
node argus.js [./server.js]
  │
  ▼
argv parse
  │
  ├─ 1 arg present → statSync path
  │       │
  │       ├─ ok    → mount app-shell with { path, mode: 'connected' } (continue below)
  │       └─ fail  → stderr, exit 1 (no TUI)
  │
  └─ 0 args → mount app-shell with { path: undefined, mode: 'startup' }
              │
              ▼
              serverHistory.list() (in parallel with first paint)
              │
              ▼
              <StartupScreen> renders with the history array
              │
              ▼
              user picks or types a path → onConnect(path) → mode := 'connected'
  │
  ▼
Ink first paint target: < 200ms (three-pane connecting state OR startup screen; both are cheap)
  │
  ▼
lazy import mcp-client → connect(path)
  │
  ▼
onConnected: fetch tools/resources/prompts concurrently, and serverHistory.record(path) fire-and-forget
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

### 3.3 Swap server (`s` keybind)

```
user presses s (in Preview / Result / connection-Error state only)
  │
  ▼
app-shell → mcp-client.disconnect()   ← existing 2s ladder + SIGTERM + SIGKILL
  │
  ▼
reset pane state: focused pane = middle, active tab = tools,
                  all selectedIndex / scrollTop = 0,
                  lastInvocationRef = null
  │
  ▼
serverHistory.list() → refreshed history array
  │
  ▼
mode := 'startup' → <StartupScreen> mounts
  │
  ▼
(same as §3.1 from user pick onward)
```

Silent no-op in Form and Invoking (form input / in-flight invocation is a costlier state to lose). `esc` first, then `s`.

### 3.4 Shutdown

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

- **Session state lives in app-shell's React state tree.** No global store, no context beyond what's local to each pane.
- **Cross-session persistence is limited to the recent-servers list.** The `server-history` module (§2.8) writes `~/.config/argus/history.json` — path only, no args, no session state. Users can opt out with `ARGUS_NO_HISTORY=1`. See [ADR 7](../adrs/7-recent-servers-history-file.md), which supersedes [ADR 3](../adrs/3-zero-disk-state-mvp.md).
- **Last-invocation cache** is a single ref: `{ tool: string; args: unknown } | null`. In-memory only; cleared when the user switches to a different tool and dropped entirely when the user swaps servers (the previous server's tools no longer apply).
- **Per-pane `scrollTop`** lives in `app-shell` React state (one per scrollable pane). Reset on server swap.
- **Server swap (`s` keybind)** tears down the MCP client, resets all pane state to defaults, and transitions `mode` back to `startup`. Session state does not survive a swap.

---

## 7. Testing strategy

### 7.1 What to test where

| Module | Test level | Framework | Rationale |
|---|---|---|---|
| `form-engine` | unit (heavy) | Vitest, table-driven | Schema walker + graceful-ladder logic — highest-risk, highest-value. Public interface (`schemaToForm`, `submit`) is stable; tests survive internal refactors. |
| `mcp-client` | unit (heavy) | Vitest + `test-server-fixture` as counterparty | Lifecycle correctness. Cover: happy path, `initialize` timeout, server crash mid-session, clean disconnect, `McpError` shapes. |
| `scroll-window` | unit (heavy) | Vitest, table-driven | Pure windowing math. Cover: focused row already visible (no change), focused above window (scroll up), focused below window (scroll down), `totalRows ≤ viewportHeight`, `focusedIndex ∈ {0, totalRows − 1}` edges, degenerate `viewportHeight ≤ 0`. |
| `form-row-flattener` | unit (heavy) | Vitest, table-driven, shares `FormSpec` inputs with `form-engine` tests | Flat spec, nested object, `array-of-primitives`, `raw-json`, inline error row, description row, focused-row index recomputes when array items are added / removed. |
| `server-history` | unit (heavy) | Vitest + tmp dir per test (no `~/.config/` writes) | Missing file, malformed JSON, wrong schema, well-formed round-trip, missing-path `stat` flag, atomic write (assert via `fs.rename` mock or tmp-file presence), CWD-independent dedup, LRU + cap-at-10, `ARGUS_NO_HISTORY=1` opt-out (no directory created), `XDG_CONFIG_HOME` set + unset path resolution. |
| `app-shell` + `result-view` | integration | `ink-testing-library` + `test-server-fixture` | Golden path (connect → browse → invoke → view), server crash mid-invocation, arrow-key routing (extension of the existing pane navigation test), scroll-indicator rendering on long lists, swap flow (`s` in Preview → startup screen → reconnect to a different fixture → assert old child process is killed). |
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
