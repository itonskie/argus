# TUI Polish: Arrow Keys, Stable Layout, Server Input

**Date:** 2026-07-05
**Grilled:** 2026-07-05
**Status:** PRD Created
**PRD A:** https://github.com/itonskie/argus/issues/19 — TUI polish (arrow keys + stable outer frame)
**PRD B:** https://github.com/itonskie/argus/issues/20 — Startup screen + swap-server + recent-servers history

## Summary

Three UX upgrades to the argus TUI: (1) arrow-key navigation added alongside the existing vim keys, (2) a stable outer frame — panes lock to terminal size and content scrolls inside them instead of the pane itself resizing, and (3) a startup screen for entering the MCP server path when no path arg is given, plus a mid-session keybind to swap servers.

**Split into two PRDs during the grill.** (1) + (2) travel together as **PRD A ("TUI shape polish")**; (3) becomes **PRD B ("startup + swap + history")** because it introduces a new top-level mode and reverses ADR 3 on zero disk state.

## Problem / Motivation

Current pain points:

- **Vim keys only.** `j/k` for list nav and `h/l` for pane switching aren't discoverable and don't match muscle memory for users who reach for arrow keys.
- **Frame jitters.** Panes today size to their content, so moving through items with different preview lengths / form-field counts causes the entire layout to grow and shrink. Distracting and hard on the eye.
- **Path arg is mandatory.** `argus <path>` is the only way in. There's no way to launch argus first and pick a server after, and no way to swap servers without quitting and re-running.

## Proposed Approach

### Keys — add arrow-key aliases

All existing vim keys stay. Add arrow-key aliases so both work:

- `↑ / ↓` — alias for `j / k` (list selection in middle pane, scroll in Preview / Result). In **Form mode**, `↑ / ↓` = prev / next field (aliases for `shift+tab / tab`).
- `← / →` — alias for `h / l` (pane switching). Ignored in Form mode (form owns focus; `esc` to leave).
- `tab / shift+tab` — cycle capability tabs (tools → resources → prompts → tools; shift reverses). Skipped when Form / Invoking modes own focus. Routes around the existing `r` overload (tab-switch vs list-retry when a tab is in error state).
- `ctrl+r` — recall last-invoked args in Form mode when focused field is empty (relocated from `↑` to avoid the arrow-key collision).
- `s` — new keybind: bring the startup screen back mid-session. Only fires in **Preview / Result / Error** modes. Silent no-op in Form / Invoking — user `esc`s first.
- `↑` in Result mode is now "scroll up one line" (dropping design-spec §5.1's "scroll to top" promise, which was never wired anyway). No `home / end` or `PgUp / PgDn` added — scope creep.
- `q`, `o`, `t`, `r`, `p` — unchanged.

### Stable outer frame

**Full windowing** — every pane is fixed-height (derived from `useWindowSize()` minus 1 row for the status bar) and tracks its own scroll windowing. No pane grows to content.

- Middle-pane list: keeps `selectedIndex` in view via scroll-follows-selection.
- Detail / Form / Result panes: each track a `scrollTop`. Form mode uses a **flat rendered-row model** (label, error, description as separate rows) so windowing math works over variable-height fields with a "focused field always in view" clamp.
- **Scroll indicators** on the pane edge: `↑ N` at the top, `↓ N` at the bottom. Rows are **always reserved** (blank when not scrolled) to avoid a 1-row jump the moment scrolling begins. ASCII fallback: `^ N` / `v N`. Left pane never scrolls, so no reserved rows there.
- At 80×24 the numbers pencil: 20 content rows per pane before indicators / tab row. Middle pane at ~17 usable list rows; right pane at ~18 usable rows.

### Startup screen + swap-server

- **No path arg** → argus opens the startup screen: a **two-zone** layout — a centered input box and a recent-servers list below it. `tab / shift+tab` swap zones. Initial focus: list if history non-empty, else input. Enter in the input zone connects to the typed path; enter in the list zone connects to the selected entry.
- **Path arg given** → skips straight to the three-pane view (backward compatible with `argus <path>` today). A bad path arg still exits with stderr — does *not* redirect to the picker.
- **`s` mid-session** → allowed only in Preview / Result / Error states. Tears down the current MCP client, resets pane state, returns to the startup screen. No confirmation dialog — state loss is bounded (selection index, scroll positions, recall slot). Silent no-op in Form / Invoking.
- **Recent servers list** persists at `~/.config/argus/history.json` (resolved via `XDG_CONFIG_HOME` on all platforms; Windows best-effort). Schema `{ "version": 1, "servers": ["/abs/path", ...] }`. Absolute paths (dedup across CWDs). Front = most-recent. Cap 10, LRU eviction.
- **Write trigger:** on **successful `initialize`** — not on launch, not on invoke. Typos and non-existent paths don't pollute; browse-only sessions count.
- **Concurrency:** last-writer-wins. Atomic write via `writeFile(tmp) + rename(tmp, final)` so partial-write corruption is impossible.
- **Corruption / missing / bad schema:** silent recovery. One-line stderr warning: `argus: history file at <path> couldn't be read, starting fresh`. Next successful connect overwrites with valid content.
- **Opt-out:** `ARGUS_NO_HISTORY=1` — when set, don't read, don't write, don't create the directory. Startup screen still works with an empty list.
- **Missing recent entry** (path deleted / moved): stays in the list rendered dim + `(missing)` tag. Selecting shows an inline `path not found` next to the entry; no exit-to-error-state. LRU eviction handles cleanup over time.

## Structure & Architecture

Files most likely to change, grouped by PRD:

**PRD A (arrow keys + stable frame):**

- `src/app-shell.tsx` — biggest changes:
  - Arrow-key / tab handling in the `useInput` callback (additive — existing branches stay). `ctrl+r` for recall.
  - Stable-frame layout: fixed `height` / `width` on each pane derived from `useWindowSize()`. Every pane tracks its own scroll windowing.
  - Form-mode rendered-row flattener so windowing works over variable-height fields.
  - Scroll-indicator components (always-reserved rows) rendered inside each pane's frame.
- **Docs** — update design-spec §5.1 key-binding table (add arrow rows, move recall to `ctrl+r`, redefine `↑` in Result). Update design-spec §3.6 status-bar hints table.

**PRD B (startup + swap + history):**

- `src/argus.ts` — argv parsing: allow zero args, route to the startup screen instead of exiting. Reject bad path arg with stderr as today.
- `src/app-shell.tsx` — add a new top-level "startup" mode alongside the existing three-pane view. `s` keybind wiring in Preview / Result / Error modes only.
- **New** `src/server-history.ts` — read / atomic-write / append to `history.json`, cap at 10 entries. Honors `ARGUS_NO_HISTORY=1`.
- **New** `src/startup-screen.tsx` — two-zone startup component (input + recent list, `tab` to swap).
- `src/mcp-client.ts` — probably fine as-is; the swap-server flow uses the existing `disconnect()` and re-runs `createMcpClient()` + `connect()`.
- **Docs** — new ADR 7 supersedes ADR 3. Update design-spec §4 (add startup screen + swap flow) and §3.6 (add `s swap` hint). Update README's "nothing written to disk" claim.

## Dependencies

- No new npm deps. Ink already exposes arrow-key events on `key.upArrow` / `key.downArrow` / `key.leftArrow` / `key.rightArrow` / `key.tab` / `key.shift`.
- `~/.config/argus/` — needs XDG-style path resolution (`XDG_CONFIG_HOME` fallback to `~/.config`).

## Design Decisions

Resolved during the brainstorm:

- **Swap-server keybind:** `s` — mnemonic for "server / swap", no collisions with existing preview-mode bindings.
- **Scroll indicator format:** arrow + count (e.g. `↑ 3`, `↓ 12`). Percentage was considered but is less useful for short lists.
- **History size / eviction:** last 10 entries, LRU (most-recent first). Enough for realistic use, small enough to render inline on the startup screen.
- **ADR 3 handling:** write a new ADR (ADR 7) that supersedes ADR 3 and marks it `Status: Superseded by ADR 7`. Preserves the record of why we changed course.
- **Startup screen shape when no path arg:** single centered input box with recent-servers list below. Do *not* render the empty three-pane frame — cleaner and clearly signals "you're not connected yet".
- **Arrow keys are additive, not a swap.** Vim keys stay for muscle-memory users.
- **Tab-key for capability tabs** only applies in preview mode. Form mode continues to use tab for field navigation (no collision, form mode owns focus).

## Out of Scope

- File-browser / picker for the server path input.
- A separate presets file distinct from the history file.
- Multi-server-at-once (already listed as future work in the README).
- Reworking the vim keys themselves.
- Persisting anything else to disk (invocation history, form state, etc.).

## UI/Frontend Impact

Yes — this is entirely a TUI (frontend) change. Ink + React components. Downstream spec work will likely need updates to `docs/specs/design-spec.md` (layout section, keybindings section) and possibly a new engineering-spec entry for the history-file schema.

## Grill Resolutions

**Grilled:** 2026-07-05

### Split into two PRDs

The bundled feature set travels together thematically but has three very different risk profiles. Grill separates them into two shippable PRDs so PRD B (which reverses ADR 3) can't stall PRD A.

- **PRD A — TUI polish:** arrow-key aliases + stable outer frame.
- **PRD B — Startup + swap + history:** startup screen, `s` swap keybind, recent-servers history file, ADR 3 reversal + ADR 7.

### PRD A decisions

- **Windowing scope:** full — every pane fixed-height with per-pane scroll windowing. Loose "outer-frame only" was rejected because the right pane still jitters as schema sizes change; that's the main offender.
- **Form-mode windowing:** flat rendered-row model. Windowing tracks rendered rows so variable-height fields (label + error + description) work correctly with a "focused field always in view" clamp.
- **Scroll indicators:** always-reserved rows (blank when not scrolled) to avoid a 1-row jump on scroll onset. `↑ N / ↓ N`, ASCII `^ N / v N`.
- **Form-mode arrow collision:** `↑` recall moves to `ctrl+r`. `↑ / ↓` become prev / next field aliases. App-wide arrow consistency beats preserving the old recall gesture.
- **Tab-cycles capability tabs:** kept — the direct-jump `r` overloads with list-retry when a tab is in error state (concrete pain point). Tab-cycling routes around it.
- **`↑` in Result:** redefined to "scroll up one line" (design-spec §5.1's "scroll to top" was never wired). No `home / end / PgUp / PgDn` added.
- **`← / →` in Form:** ignored. Form owns focus; `esc` remains the only exit.
- **Design-spec updates required:** §3.6 status-bar hints, §5.1 key-binding table.

### PRD B decisions

- **ADR 3 reversal:** accepted. Trade lands because typing the server path every launch is real repeated friction; disk footprint is tiny; XDG conventions blunt the "polluting home directory" concern.
- **Write trigger:** on successful `initialize`. Typos and non-existent paths don't pollute; browse-only sessions count.
- **Schema:** `{ "version": 1, "servers": ["/abs/path", ...] }`. Version field for future migrations. Absolute paths (dedup across CWDs). Cap 10, LRU eviction.
- **Concurrency:** last-writer-wins + atomic write. No locking — cross-platform Node locking is unreliable, and the race cost is at most 1 lost entry.
- **Corruption handling:** silent recovery + one-line stderr warning. Never blocks startup.
- **Opt-out:** `ARGUS_NO_HISTORY=1` env var. No CLI flag — persistent preference belongs in shell profile.
- **Missing recent entry:** rendered dim + `(missing)` tag; select shows inline error, stays on the startup screen. LRU eviction cleans up over time.
- **Cross-platform path:** XDG on all platforms. Windows best-effort (not a supported target but not deliberately broken).
- **Startup-screen focus model:** two zones (input + list), `tab / shift+tab` to swap. Initial focus: list if history non-empty, else input. Mirrors PRD A's tab-cycling pattern.
- **`s` mid-session:** allowed only in Preview / Result / Error. Silent no-op in Form / Invoking. No confirmation dialog — state loss is bounded.
- **Status bar `s swap`:** shown in Preview, Result, and error states; hidden in Form / Invoking.
- **Design detection:** UI work; `docs/specs/design-spec.md` already owns TUI visual choices — no `DESIGN.md` needed.
- **Docs required:** ADR 7 (supersedes ADR 3), design-spec §4 (startup + swap flow), design-spec §3.6 (`s swap` hint), README (remove "nothing written to disk" claim, describe the recent-servers list).

### Terminology standardization

Grill mixed several terms — standardizing on:

- **Startup screen** (not "input screen").
- **Swap-server flow** (hyphenated compound modifier).
- **Recent servers list** (the picker UI element).
- **History file** or `history.json` (the persistence layer).

## Next Steps

1. ~~Run `/grill-idea` on this brainstorm~~ — done 2026-07-05, resolutions above.
2. Convert to **two PRDs** via `/idea-to-prd`:
   - PRD A — TUI polish: arrow keys + stable frame.
   - PRD B — Startup + swap + history (includes drafting ADR 7 to supersede ADR 3).
