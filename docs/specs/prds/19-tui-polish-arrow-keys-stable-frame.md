# PRD: TUI Polish — Arrow Keys + Stable Outer Frame

**Issue:** #19
**Date:** 2026-07-05
**Status:** Draft
**Brainstorm:** [`docs/brainstorms/tui-polish-arrow-keys-stable-layout-2026-07-05.md`](../../brainstorms/tui-polish-arrow-keys-stable-layout-2026-07-05.md)
**Design spec:** [`docs/specs/design-spec.md`](../design-spec.md)
**Engineering spec:** [`docs/specs/engineering-spec.md`](../engineering-spec.md)

## Problem Statement

Two rough edges in the argus TUI make it feel less polished than it should:

1. **Arrow keys don't work.** Navigation is vim-only — `j` / `k` for lists, `h` / `l` for panes. Users who reach for arrow keys hit dead air. Vim-fluent users are fine; everyone else pays a discoverability tax on their first session.

2. **The frame jitters.** Panes size to their content today. Moving through capability items with different preview lengths, or through forms with different field counts, causes the entire outer layout to grow and shrink. It's distracting, and on smaller terminals it can push key hints off-screen.

## Solution

Two additive, backwards-compatible changes:

1. **Arrow-key aliases** alongside every existing vim binding. `↑ / ↓` alias for `j / k`, `← / →` alias for `h / l`. `tab / shift+tab` cycle capability tabs, routing around the existing `r` overload (which currently means both "resources tab" and "retry list on error"). Vim keys stay for muscle-memory users.

2. **Stable outer frame.** Every pane locks to a fixed size derived from the terminal dimensions. Content that exceeds the pane scrolls inside it; the pane itself never grows. Each pane tracks its own `scrollTop`. Small scroll indicators (`↑ N` at top, `↓ N` at bottom) show hidden content and always reserve their row so scrolling never causes a 1-row jump.

## User Stories

1. As an argus user who reaches for arrow keys by default, I want `↑ / ↓` to move the list selection in the middle pane, so that I don't have to learn vim keys just to browse.

2. As an argus user, I want `↑ / ↓` to scroll the preview / result panes when the right pane is focused, so that arrow behavior is consistent across panes.

3. As an argus user, I want `← / →` to move focus between panes (mirroring `h / l`), so that I can navigate the layout without leaving the arrow-key cluster.

4. As an argus user in Form mode, I want `↑ / ↓` to move between fields (mirroring `shift+tab / tab`), so that arrow-key behavior stays consistent inside forms.

5. As an argus user, I want `tab / shift+tab` to cycle the capability tabs (`tools → resources → prompts → tools`; shift reverses), so that I can flip tabs without having to remember which letter maps to which category.

6. As an argus user in Form mode, I want `tab / shift+tab` to keep meaning "next / previous field" (unchanged), so that muscle memory around form field navigation is preserved.

7. As an argus user in Form mode, I want `ctrl+r` to recall the last-invoked args on an empty focused field, so that recall still works after `↑` was rebound to "previous field".

8. As a vim-fluent argus user, I want all my existing keys (`h/j/k/l`, `t/r/p`) to keep working exactly as before, so that adding arrow-key support costs me nothing.

9. As an argus user, I want the outer layout to lock to my terminal size when I launch, so that the frame does not resize as I move through items with different preview lengths.

10. As an argus user, I want the middle-pane list to scroll internally when there are more items than fit on screen, keeping my selection visible, so that I can browse long capability lists without the pane growing.

11. As an argus user, I want the right pane in Preview / Form / Result mode to scroll internally when the content exceeds the pane height, so that no mode ever forces the outer frame to grow.

12. As an argus user, I want scroll indicators (`↑ N` at top, `↓ N` at bottom) to tell me how many rows are hidden above and below the visible window, so that I can tell when there's more content to scroll to.

13. As an argus user on a terminal without Unicode, I want the scroll indicators to render as `^ N / v N`, so that ASCII fallback (`ARGUS_ASCII=1`) doesn't break them.

14. As an argus user, I want the scroll-indicator rows to always be reserved (blank when not scrolled), so that the layout doesn't shift by 1 row the moment scrolling begins.

15. As an argus user in Form mode navigating with `tab`, I want the focused field to always be visible in the pane, so that pressing `tab` past the bottom scrolls the form up automatically.

16. As an argus user in Result mode, I want `↑ / ↓` to scroll one line at a time (dropping the previous "scroll to top" promise that was never wired), so that scrolling behavior is consistent across modes.

17. As an argus user, I want the status bar to still reflect the correct hints for the currently focused pane / mode, so that the new keys are discoverable without reading the spec.

## Implementation Decisions

### Modules

**New deep modules (isolated logic, table-driven tests):**

- **`scroll-window`** — pure windowing math. Given `(totalRows, focusedIndex, viewportHeight, previousScrollTop)`, return `{ startIndex, endIndex, topHidden, bottomHidden }`. Encapsulates the "focused row always in view" clamp: if `focusedIndex < startIndex` scroll up; if `focusedIndex >= endIndex` scroll down; otherwise leave `scrollTop` alone. Reused by every scrollable pane (middle list, preview, form, result). Zero React, zero Ink dependencies — testable as a plain function.

- **`form-row-flattener`** — takes `(FormSpec, FormState, focusedFieldIndex)` and produces a flat, ordered array of *rendered rows* — one entry per label, error, description, array item, or "+ add row" affordance. Enables `scroll-window` to operate over form content with variable per-field heights. The mapping from `focusedFieldIndex` (the current focus model in `app-shell`) to a flat row index lives here, so `scroll-window`'s clamp works consistently.

**Modified thin glue:**

- **`app-shell.tsx`** — the biggest surface. Changes:
  - Extend the `useInput` callback with additive branches for arrow keys, `tab / shift+tab`, and `ctrl+r`. Existing branches for `h/j/k/l/t/r/p/enter/esc/q/o` stay verbatim.
  - Each pane gets a fixed `height` and `width` derived from `useWindowSize()` (minus 1 row for the status bar). No pane uses content-driven sizing.
  - Each pane owns a `scrollTop` state (middle-pane list, preview, form, result). All four call into `scroll-window` on render.
  - Result-mode `↑` behavior redefined to "scroll up one line" (dropping design-spec §5.1's "scroll to top" promise, which was never implemented).

- **`<ScrollIndicator>`** (new small component in `app-shell.tsx`, thin) — renders `↑ N` / `↓ N` in Unicode mode, `^ N / v N` in ASCII mode. Always reserves a single row per edge; renders blank when `N === 0`.

### Key bindings — updated table

| Key | Global | Middle pane | Right (Preview / Result) | Right (Form) |
|---|---|---|---|---|
| `↑` / `↓` | — | prev / next item (alias for `k / j`) | scroll up / down one line | prev / next field (alias for `shift+tab / tab`) |
| `←` / `→` | move focus left / right (alias for `h / l`) | — | — | ignored (form owns focus; `esc` exits) |
| `tab` / `shift+tab` | — | cycle capability tabs `tools → resources → prompts` (shift reverses) | cycle capability tabs (also exits Result) | prev / next field (unchanged) |
| `ctrl+r` | — | — | — | recall last args on empty focused field (relocated from `↑`) |
| `h / j / k / l / t / r / p / enter / esc / q / o / ctrl+c` | — | unchanged | unchanged | unchanged |

Notes:
- `tab` in Form mode continues to mean "next field" — no collision, because form mode owns focus and never touches capability tabs.
- Cycling tabs via `tab` routes around the `r` overload: when the resources tab is in list-fetch error state, `r` means "retry list" (design-spec §3.2), and pressing `r` from another tab is ambiguous. `tab / shift+tab` gives an unambiguous cycle.
- `↑` recall moves to `ctrl+r`. App-wide arrow consistency was chosen over preserving the old recall gesture.

### Stable-frame layout model

- Every pane's `height` = `terminalRows - 1` (reserve one row for the status bar).
- Left pane: fixed width 18 (design-spec §2.1). No scroll — connection pane is static.
- Middle pane: fixed width 22. Content = tab-header row + list rows. Uses `scroll-window` to keep `selectedIndex` visible.
- Right pane: fills remaining width. Content depends on mode; all four modes (Preview / Form / Invoking / Result) use `scroll-window`.
- Form mode uses `form-row-flattener` to convert `(FormSpec, FormState)` into the flat row list `scroll-window` consumes. The focused field's rows (label, input, error, description) all belong to the same field — the clamp uses the field's first row as the "must be visible" anchor and the last row as the boundary for downward scroll.

### Scroll indicators

- Position: bottom row of the pane content area for `↓ N`, top row for `↑ N`.
- Format: `↑ N` / `↓ N` where `N` is the count of hidden rows above / below. ASCII fallback: `^ N` / `v N` (only when `ARGUS_ASCII=1`).
- Reservation: the row is always present. Renders blank (empty text) when `N === 0`. Avoids the visual "jump" the moment scrolling starts.
- Style: dim color (design-spec §1 muted palette).

### 80×24 pane budget

At the minimum supported size (`design-spec §2.3`), the row math works out to:
- Terminal: 24 rows. Minus status bar: 23. Minus outer frame top/bottom: 21. Minus pane title: 20.
- Middle pane: 20 rows − 1 (tab row) − 2 (top/bottom scroll indicator rows) = **17 usable list rows**.
- Right pane: 20 rows − 2 (top/bottom scroll indicator rows) = **18 usable rows** (preview / form / result content).

### Docs updates

- **design-spec §5.1** (key-binding table): add arrow-key rows, add `tab / shift+tab` row for capability tab cycling, move recall from `↑` to `ctrl+r`, redefine `↑` in Result as "scroll up one line".
- **design-spec §3.6** (status-bar hints): update hints per focused pane / mode to reflect new bindings.
- **README**: no user-visible changes to the "Features" or "Install" sections. The arrow-key aliases and stable frame are quality-of-life polish — they don't warrant a top-level feature bullet.

## Testing Decisions

### Written tests (in-scope for this PRD)

- **`scroll-window`** — table-driven unit tests. Public interface only: `(totalRows, focusedIndex, viewportHeight, previousScrollTop) → { startIndex, endIndex, topHidden, bottomHidden }`. Cover:
  - Focused row already visible → `scrollTop` unchanged.
  - Focused row above visible window → scroll up.
  - Focused row below visible window → scroll down.
  - `totalRows ≤ viewportHeight` → no scrolling (`topHidden === 0 && bottomHidden === 0`).
  - `focusedIndex === 0` and `focusedIndex === totalRows - 1` edge cases.
  - Viewport height 1 (degenerate case for very small terminals — argus doesn't render below 80×24 but the function must not divide by zero or return negative counts).

- **`form-row-flattener`** — unit tests using the same `FormSpec` shapes the existing `form-engine` tests use as inputs. Public interface only: `(FormSpec, FormState, focusedFieldIndex) → { rows: FocusRow[], focusedRowIndex: number }`. Cover:
  - Flat spec, one row per field.
  - Nested object: object header row + child field rows below.
  - `array-of-primitives`: one row per item + one `array-add` affordance row.
  - `raw-json`: label row + input row.
  - Error present on a field: adds an inline error row.
  - Description present: adds a dim description row.
  - Focus mapping: adding an array item shifts the focused row index if focus was below the change; removing does the same.

### Verified via existing integration coverage (no new tests needed)

- Arrow-key routing in `useInput` — existing golden-path integration test in `tests/` covers the pane navigation flow; extend the assertion to include the arrow-key variants.
- Scroll-indicator rendering — asserted via the same integration test by scrolling past the fold on a long list and reading the visible output.

### Prior art

- Existing table-driven pattern in `tests/form-engine.test.ts` — same shape (many small inputs, one assertion each). Match that style.
- `ink-testing-library`-driven end-to-end pattern in `tests/app-shell.test.ts` (or the current equivalent) — extend with arrow-key key events.

## Out of Scope

- `home / end / PgUp / PgDn` bindings. Scope creep — file separately if there's demand.
- Reworking or removing any vim key. All existing keys stay verbatim.
- Mouse support.
- Scroll indicators as a percentage (`85%`) instead of a row count. Row count is more useful for short lists.
- Reworking the left pane. It's static and does not scroll.
- Changes to the startup flow, path arg handling, server swapping, or disk state — those are in [PRD #20](20-startup-swap-server-history.md).

## Further Notes

- The two PRDs (this one and PRD B) came out of a single brainstorm and were split during the grill session. This one is deliberately the smaller and lower-risk of the two — no ADR reversal, no new persistence, no changes to argv parsing. It should land first so PRD B can't stall it.
- No new npm dependencies. Ink already exposes `key.upArrow / downArrow / leftArrow / rightArrow / tab / shift / ctrl` on the `useInput` callback.
