# PRD: Startup Screen + Swap Server + Recent Servers History

**Issue:** #20
**Date:** 2026-07-05
**Status:** Draft
**Brainstorm:** [`docs/brainstorms/tui-polish-arrow-keys-stable-layout-2026-07-05.md`](../../brainstorms/tui-polish-arrow-keys-stable-layout-2026-07-05.md)
**Related PRD:** [`19-tui-polish-arrow-keys-stable-frame.md`](19-tui-polish-arrow-keys-stable-frame.md) (#19) — TUI polish; can ship in either order but expected first
**Design spec:** [`docs/specs/design-spec.md`](../design-spec.md)
**Engineering spec:** [`docs/specs/engineering-spec.md`](../engineering-spec.md)
**Supersedes ADR:** [`docs/adrs/3-zero-disk-state-mvp.md`](../../adrs/3-zero-disk-state-mvp.md) — a new ADR 7 will supersede ADR 3

## Problem Statement

The path arg is mandatory today: `argus <path>` is the only way in. That produces two ongoing frictions:

1. **You can't launch argus first and pick a server after.** Retyping the same absolute path every session, or `↑`-searching bash history, is the workaround. It works, but it's friction on every launch.

2. **You can't swap servers mid-session.** If you're comparing two servers, or realize you launched against the wrong one, the only path is `q`, up-arrow, edit path, enter. It breaks flow.

## Solution

Two coordinated changes, backed by a small on-disk history file:

1. **Startup screen.** When `argus` runs with no path arg, open a startup screen: a centered input for typing a path, and a list of recent servers below it. Enter connects. `tab / shift+tab` swap zones. Passing `argus <path>` behaves exactly as today (backwards compatible).

2. **Swap-server keybind.** A new `s` keybind — allowed only in Preview / Result / Error modes — tears down the current MCP connection, resets pane state, and returns to the startup screen. From there, the user picks a different server and reconnects.

3. **Recent servers history file.** A small JSON file at `~/.config/argus/history.json` records the last 10 successfully connected servers, LRU-ordered. Written on successful `initialize`. Opt-out via `ARGUS_NO_HISTORY=1`.

This solution reverses [ADR 3](../../adrs/3-zero-disk-state-mvp.md) ("zero disk state in MVP"). A new **ADR 7** captures the reversal and the reasoning. ADR 3 is marked `Status: Superseded by ADR 7`.

## User Stories

1. As an argus user launching argus without any arguments, I want a startup screen with a path input and a list of recent servers, so that I don't have to remember or retype full paths every session.

2. As an argus user, I want to type a server path into the startup-screen input and press enter to connect, so that first-time or one-off servers still work with zero setup.

3. As an argus user, I want the startup screen's recent-servers list to remember the last 10 servers I successfully connected to, LRU-ordered, so that my last-used servers are always at the top.

4. As an argus user, I want to press `tab / shift+tab` on the startup screen to move focus between the input and the list, so that keyboard navigation matches the rest of the app.

5. As an argus user opening the startup screen with an existing recent list, I want focus to start on the list (not the input), so that pressing enter connects to my most-recent server without me having to swap zones.

6. As an argus user opening the startup screen with an empty recent list (first launch, or after clearing), I want focus to start on the input, so that I can immediately start typing a path.

7. As an argus user, I want `argus <path>` to keep working exactly as today (skips the startup screen, connects directly), so that existing scripts, aliases, and muscle memory don't break.

8. As an argus user who passed a bad path on the command line, I want argus to exit with a stderr error (as today) rather than fall through to the startup screen, so that scripts fail loudly instead of hanging on a TUI.

9. As an argus user in Preview / Result / Error state, I want to press `s` to swap servers mid-session, so that I can compare two servers without quitting and relaunching.

10. As an argus user, I want the `s` keybind to be silently ignored in Form / Invoking modes, so that pressing `s` while typing into a form doesn't rip the connection out from under me.

11. As an argus user, I want the swap-server flow to skip any confirmation dialog, so that swapping is fast — the state loss (selection index, scroll positions, recall slot) is bounded and I intended to swap.

12. As an argus user swapping servers, I want the current MCP client to be cleanly disconnected (child process killed), so that stray server processes don't accumulate as I hop between servers.

13. As an argus user, I want the recent-servers list to only be written after a successful `initialize` handshake, so that typos and non-existent paths don't pollute my history.

14. As an argus user with a recent-servers entry whose path was later deleted or moved, I want that entry to render dim + `(missing)` on the startup screen, so that I can still see the entry (LRU eventually evicts it) but I know it's no longer usable.

15. As an argus user, I want selecting a missing entry to show an inline `path not found` message on the startup screen rather than crash into an error TUI, so that I stay on the picker and can pick something else.

16. As an argus user who prefers no on-disk state, I want to set `ARGUS_NO_HISTORY=1` in my shell, so that argus never reads, writes, or creates the history file — the startup screen still works, just with an empty recent list.

17. As an argus user whose history file got corrupted (partial write, manual edit, disk error), I want argus to fall back to an empty list with a single one-line stderr warning, so that a bad file never blocks launch.

18. As an argus user on macOS, Linux, or Windows, I want the history file to live at `$XDG_CONFIG_HOME/argus/history.json` (fallback: `~/.config/argus/history.json`), so that the file lives in a predictable, XDG-conformant location.

19. As an argus user running two argus processes concurrently, I want a last-writer-wins outcome without corruption (each write is atomic via tmp + rename), so that at worst I lose one recent entry, never end up with a broken file.

20. As an argus user who reads the README, I want the "nothing written to disk" claim removed and the recent-servers list mentioned as a feature, so that the docs don't lie about behavior.

21. As an argus user, I want the status bar in Preview / Result / Error states to show `s swap` in the hints, so that the new keybind is discoverable without reading the spec.

22. As an argus user in Form / Invoking mode, I want the status bar to hide `s swap` (since it's disabled there), so that I don't wonder why pressing `s` types a letter.

## Implementation Decisions

### Modules

**New deep module (isolated logic, unit-tested):**

- **`server-history`** — the persistence layer for the recent-servers list. **Public interface:**

  ```ts
  type HistoryEntry = { path: string; missing: boolean };

  interface ServerHistory {
    list(): Promise<HistoryEntry[]>;      // reads + validates the file; missing flag set per-entry
    record(path: string): Promise<void>;  // dedup, prepend, cap at 10, atomic write
  }

  function createServerHistory(env?: NodeJS.ProcessEnv): ServerHistory;
  ```

  **What it encapsulates:**
  - XDG path resolution — reads `XDG_CONFIG_HOME`, falls back to `~/.config`, appends `argus/history.json`.
  - `ARGUS_NO_HISTORY=1` opt-out — when set, `list()` returns `[]` and `record()` is a no-op. No directory is created.
  - Atomic write — always writes to `history.json.tmp` first, then `rename()`s over `history.json`. Never leaves a partial file.
  - Schema validation — reads `{ version: 1, servers: string[] }`. On any mismatch (missing file, malformed JSON, wrong shape, wrong version), returns `[]` and prints a one-line stderr warning: `argus: history file at <path> couldn't be read, starting fresh`.
  - LRU semantics — `record(path)` de-dups, prepends `path`, truncates to 10, writes.
  - Missing-path detection — inside `list()`, `fs.stat()` each entry and set `missing: true` if it fails.
  - Dedup uses the absolute path (resolved via `path.resolve`) so the same server invoked from different CWDs is one entry.

  **Concurrency stance:** last-writer-wins. No file locking (cross-platform Node locking is unreliable, and the race cost is at most 1 lost entry). Atomic tmp+rename guarantees the file is never partially written.

**New thin component:**

- **`<StartupScreen>`** (new file `src/startup-screen.tsx`) — the two-zone startup UI. Renders:
  - A centered input box (single-line) for typing a server path.
  - Below it: the recent-servers list (dim `(missing)` tag when the path is gone).
  - Inline error line below the list when a missing entry is selected (`path not found`).
  - Status-bar hints: `tab/shift-tab zone  enter connect  q quit`.

  **Focus model:** two zones (`input` / `list`). Initial focus = `list` if history non-empty, else `input`. `tab / shift+tab` swap zones. Enter in `input` calls back with the typed path; enter in `list` calls back with the selected entry's path (unless it's missing — then shows the inline error and stays put).

  Props:
  ```ts
  type StartupScreenProps = {
    history: HistoryEntry[];
    onConnect: (path: string) => void;
    env: UiEnv;
  };
  ```

  Consumes but does not own the history — `App` calls `serverHistory.list()` on mount and passes the array down. This keeps the component pure and easy to test.

**Modified thin glue:**

- **`src/argus.ts`** — argv parsing:
  - Zero args → mount `App` with `path: undefined` (routes to startup screen). Do **not** print the usage error.
  - One arg → same as today: `statSync` check, exit 1 on failure, otherwise mount `App` with the path.
  - The bad-path-fails-loudly rule is preserved: `argus /does/not/exist` still exits with stderr. It does not fall through to the picker.

- **`src/app-shell.tsx`** — add a top-level mode alongside the existing three-pane view:
  - New state `mode: 'startup' | 'connected'`. `mode === 'startup'` renders `<StartupScreen>`; `mode === 'connected'` renders the existing three-pane layout.
  - `App` now accepts `path?: string`. If `undefined`, initial mode is `startup`; if defined, initial mode is `connected` (existing behavior).
  - `s` keybind: allowed only when `focusedPane !== <form or invoking>` and connection state is `connected` / `error` (i.e. Preview, Result, or Error). Silent no-op otherwise. Handler: call `client.disconnect()`, reset all pane state, transition `mode` back to `'startup'`.
  - Successful `initialize` (in the existing `client.connect(path)` await) calls `serverHistory.record(path)` fire-and-forget. Failures on `record()` don't block the UI.
  - Startup-screen's `onConnect(path)` sets `path` in state, resets tab states / scroll positions, and transitions `mode` back to `'connected'`, letting the existing connect flow take over.

- **`src/mcp-client.ts`** — no interface changes expected. The swap flow uses the existing `disconnect()` (which already handles child cleanup) and creates a fresh client via the existing `createMcpClient()` factory.

- **`docs/adrs/7-recent-servers-history-file.md`** (new) — supersedes ADR 3. Records:
  - Why we reversed course: typing the path every launch is real repeated friction; disk footprint is tiny; XDG conventions blunt the "polluting home directory" concern.
  - Alternatives considered (in-memory only across processes, presets file, environment-variable-based).
  - Consequences: users get persistence, `ARGUS_NO_HISTORY=1` is the escape hatch.
- **`docs/adrs/3-zero-disk-state-mvp.md`** — update the frontmatter: `Status: Superseded by ADR 7 (2026-07-05)`. Do **not** rewrite the body — it stays as-is to preserve the reasoning at the time.

### File layout

```
~/.config/argus/history.json
```

Resolution rules (in order):
1. `$XDG_CONFIG_HOME/argus/history.json` if `XDG_CONFIG_HOME` is set and non-empty.
2. `~/.config/argus/history.json` on macOS / Linux.
3. Windows: same fallback — `%USERPROFILE%/.config/argus/history.json`. Windows is best-effort; not deliberately broken, not a supported target.

Directory is created lazily on first `record()`. Never created just from launching argus.

### Schema

```json
{
  "version": 1,
  "servers": ["/abs/path/to/server-a.js", "/abs/path/to/server-b.js"]
}
```

- `version` — literal `1`. Any other value → treat as corrupted, fall back to empty, print stderr warning.
- `servers` — array of absolute strings. Non-string entries → corrupted, same fallback.
- Order: most-recent first (index 0 is newest).
- Cap: 10 entries. Older entries drop off on `record()`.

### Interactions

- **Startup screen (no path arg):**
  - Zone A: single-line input, centered.
  - Zone B (below): list of recent entries, each on its own line. Selected entry rendered reverse-video.
  - `tab / shift+tab` swap zones.
  - Enter: connect to typed path (input zone) or selected entry (list zone).
  - Missing entry selected + enter: inline `path not found` under the entry; stays on the picker.
  - `q` / `ctrl+c`: quit.

- **Swap flow (from three-pane view):**
  - Press `s` in Preview / Result / Error state.
  - `App` calls `client.disconnect()` and awaits it (best-effort — same 2s / SIGTERM / SIGKILL ladder as `mcp-client.disconnect`).
  - Pane state resets: focused pane = middle, active tab = tools, all `selectedIndex` / `scrollTop` back to zero, `lastInvocationRef` cleared.
  - `mode` transitions to `startup`. `<StartupScreen>` renders with the fresh history from `serverHistory.list()`.
  - No confirmation dialog. State loss is bounded (selection index, scroll positions, recall slot); the user pressed `s` deliberately.

- **`s` in Form / Invoking:** silent no-op. The status bar in those modes does not display `s swap`.

### Docs updates

- **README** — remove the "Nothing written to disk — every session is ephemeral" bullet from the Features section. Add: "Remembers the last 10 servers you connected to (opt out with `ARGUS_NO_HISTORY=1`)." Add a short section under Development documenting the history file path.
- **design-spec §4** — new subsection **§4.4 Startup screen** describing the two-zone layout, focus model, and connect flow. Add **§4.5 Swap-server flow** describing the `s` keybind teardown + return to startup.
- **design-spec §3.6** — add `s swap` to the status-bar hints table for Preview, Result, and Error contexts. Do not add to Form / Invoking.
- **design-spec §5.1** — add `s` to the key-binding table with column values reflecting its restrictions.
- **engineering-spec §6 State management** — update the "In-session only. Nothing persists to disk" sentence; replace with a reference to the recent-servers list and cite ADR 7.
- **ADR 7** — new file, per above.
- **ADR 3** — status frontmatter update per above.

## Testing Decisions

### Written tests (in-scope for this PRD)

- **`server-history`** — unit tests. Public interface only (`list()` / `record()` and the factory). Cover:
  - Missing file → `list()` returns `[]`, no stderr warning.
  - Malformed JSON → `list()` returns `[]`, one-line stderr warning.
  - Wrong schema (missing `version`, wrong `version`, non-array `servers`, non-string entries) → `list()` returns `[]`, warning.
  - Well-formed file → `list()` returns entries in order.
  - Missing path in a listed entry → `HistoryEntry.missing === true`.
  - `record(path)` writes atomically (assert via presence of tmp file mid-write, or by mocking `fs.rename`).
  - `record(path)` dedups on absolute path — same server from different CWDs is one entry.
  - `record(path)` prepends and caps at 10 (`record` an 11th entry → oldest drops off).
  - `ARGUS_NO_HISTORY=1` → `list()` returns `[]`, `record()` is a no-op, no directory created.
  - `XDG_CONFIG_HOME` set → path resolves to `$XDG_CONFIG_HOME/argus/history.json`.
  - `XDG_CONFIG_HOME` unset → path resolves to `~/.config/argus/history.json`.

  All fs mocked via a tmp dir per test — tests do not touch real `~/.config/`.

- **`app-shell` swap flow** — integration test via `ink-testing-library` and `test-server-fixture`. Cover:
  - Launch with `path` set → three-pane view.
  - Press `s` in Preview state → startup screen renders with the current server in the history list.
  - Type a different fixture path + enter → three-pane view reconnects to the new server.
  - Old server's child process is killed (assert via existing `test-server-fixture` machinery for detecting live processes).

### Not separately tested (verified via existing coverage or manual)

- `<StartupScreen>` component in isolation — covered by the swap-flow integration test which drives it end-to-end.
- Windows path resolution — best-effort target; smoke-tested manually if a Windows contributor asks.
- ADR 7 authoring — reviewed in PR, no automated test.

### Prior art

- `tests/mcp-client.test.ts` (or the current equivalent) for lifecycle tests using `test-server-fixture`. Reuse the pattern for the swap-flow integration test.
- Standard Vitest table-driven pattern (see `tests/form-engine.test.ts`) for the schema-validation cases in `server-history`.

## Out of Scope

- File browser / picker for the server path input. Type the path yourself.
- Separate "presets" file distinct from the history file. Recent list is the persistence layer.
- Cross-session history of invocations / form state. In-session only, unchanged.
- Multi-server-at-once (still future work per README).
- Reworking the vim keys, adding arrow-key aliases, stabilizing the outer frame — those are in [PRD #19](19-tui-polish-arrow-keys-stable-frame.md).
- Migrating existing users. There are none — MVP has zero disk state today, so there is nothing to migrate.
- Windows as a first-class supported target. Best-effort only.

## Further Notes

- **ADR 3 reversal is the load-bearing decision.** Everything else follows from the choice to persist recent servers. The reversal was accepted during the grill because the friction is real, the file is tiny, XDG conventions blunt the pollution concern, and `ARGUS_NO_HISTORY=1` gives users a clean opt-out.
- No new npm dependencies. The fs primitives (`readFile`, `writeFile`, `rename`, `stat`, `mkdir`) are all in `node:fs/promises`.
- The swap flow's clean disconnect uses the existing `McpClient.disconnect()` — no changes needed there. The interface was already designed for a single active connection with a lifecycle (see engineering-spec §2.1).
