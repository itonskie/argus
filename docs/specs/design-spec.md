# Design Spec — argus MVP

**PRD:** [`docs/specs/prds/1-argus-mvp.md`](prds/1-argus-mvp.md) · Issue #1
**Scope:** TUI. No `DESIGN.md` — this document owns terminal visual choices (colors, borders, focus, key hints) as well as layout, states, and interactions.

Design-spec conventions apply differently to a TUI than a web UI. "Responsive" here means "how does it behave at 80×24 vs 200×60"; "accessibility" means "how does it behave under a screen reader and with reduced color."

---

## 1. Global visual choices

**Palette (16-color, terminal-safe):**
- Chrome (borders, dividers): default terminal fg, dim.
- Focus indicator: cyan border + bold section title. Only one section is focus-highlighted at a time.
- Selected list item: reverse video (background = terminal fg).
- Success (invocation OK): green.
- Warning (large response, paging suggestion): yellow.
- Error (crash, timeout, validation fail): red.
- Muted text (hints, "no results" copy): dim.

argus does not force color. If `NO_COLOR` env var is set, or the terminal reports no color support, argus falls back to bold / reverse / underline for focus and state. All state must be distinguishable without color.

**Typography:** whatever the terminal provides. argus uses:
- Bold for section titles and focused pane header.
- Dim for hints and secondary info.
- No italics (unreliable across terminals).

**Borders:** single-line Unicode box-drawing (`─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼`). ASCII fallback if the terminal reports no Unicode support.

**Icons:** none. Text labels only. (No emoji, no Nerd Fonts required.)

**Bottom status bar (persistent, one line):**
- Left: contextual key hints for the currently focused pane.
- Right: connection status blip (`● connected` green / `● connecting` yellow / `● disconnected` red).

---

## 2. Layout

### 2.1 Three-pane layout (default)

```
┌─ argus ─────────────────────────────────────────────────────────────┐
│┌─Connection─────┐┌─Capabilities──────┐┌─Detail─────────────────────┐│
││                ││ [t]ools [r]es [p] ││ echo(message: string)      ││
││ ./server.js    ││ ──────────────────││                            ││
││ stdio          ││ > echo            ││ Args:                      ││
││ ● connected    ││   add             ││   message  [__________]    ││
││                ││   list_files      ││                            ││
││ pid 48213      ││   fetch_url       ││                            ││
││                ││                   ││ [enter] focus form         ││
││                ││                   ││                            ││
││                ││                   ││                            ││
││                ││                   ││                            ││
│└────────────────┘└───────────────────┘└────────────────────────────┘│
│ h/l panes  j/k list  t/r/p tabs  enter form  q quit    ● connected  │
└─────────────────────────────────────────────────────────────────────┘
```

Pane widths at 80 cols: left = 18, middle = 22, right = fills. On wider terminals, left and middle stay at their minimums; right pane absorbs the rest.

### 2.2 Right-pane modes

The right pane is a **mode switcher** — it does not scroll off, does not split. Same physical rectangle throughout, so the user's eye doesn't hunt.

- **Preview** (default): schema summary + description of the highlighted middle-pane item.
- **Form** (after Enter): editable form fields.
- **Result** (after submit): pretty-printed response.

Transitions between modes are instant — no animation, no fade. Titlebar of the pane changes to reflect the mode: `Detail` / `Form` / `Result`.

### 2.3 Terminal-size handling

- **Minimum supported:** 80×24. Below this, argus renders a single-line message: `argus requires 80×24 terminal — current: 72×20`. Static message; polls for resize and re-renders when large enough.
- **80×24 to ~120×40:** three panes, no wrapping in list items (list items truncate with `…`).
- **Above ~120 cols:** right pane widens; preview / form fields can render longer strings without truncation.
- **Resize during use:** argus re-lays out. Focus state and selection index preserved.

### 2.4 No responsive breakpoints in the web sense

No mobile mode, no collapsed nav. It's a TUI — the user has a terminal or they don't.

### 2.5 Stable outer frame

The outer three-pane frame locks to terminal dimensions at launch and after each resize. Pane sizes never depend on content. Content that overflows a pane scrolls inside the pane; the pane itself never grows or shrinks.

**Pane sizing (recomputed on resize only):**
- Every pane's inner content height = `terminalRows − 1` (status bar reserves the last row) − 2 (outer frame top/bottom) − 1 (pane title row).
- Left pane: fixed width 18 (unchanged from §2.1). Static content, no scrolling.
- Middle pane: fixed width 22. Content = tab-header row + scrollable list rows. Uses internal scrolling to keep the selected item in view.
- Right pane: fills remaining columns. All four modes (Preview / Form / Invoking / Result) scroll internally.

**Selection-visibility rule:** in the middle-pane list and in Form mode, changing the focused item / field must not scroll unless the focus would leave the visible window. Moving focus down past the last visible row scrolls the window down by one; moving up past the first visible row scrolls up by one. Otherwise `scrollTop` is unchanged. This applies uniformly across all scrollable panes.

**80×24 pane budget (minimum size):**
- 24 rows − 1 status bar − 2 outer frame = 21 usable rows per pane column.
- Minus 1 pane title row = 20 rows of content per pane.
- Middle pane content: 20 rows − 1 tab-header row − 2 scroll-indicator rows = **17 usable list rows**.
- Right pane content: 20 rows − 2 scroll-indicator rows = **18 usable rows** for Preview / Form / Invoking / Result.

**Rationale:** without a fixed outer frame, moving through list items with different preview lengths or through forms with variable field counts causes the whole layout to jitter. Locking the frame trades some vertical density for a stable eye-fixation point. See PRD #19.

### 2.6 Scroll indicators

Every scrollable pane reserves one row at the top and one row at the bottom of its content area for scroll indicators. The rows are always present — they render blank when there is no hidden content, so scrolling never causes a 1-row layout jump.

- **Position:** top row of pane content = `↑` indicator; bottom row = `↓` indicator.
- **Format:** `↑ N` and `↓ N`, where `N` is the count of hidden rows above / below the visible window. When `N === 0` the row is blank.
- **ASCII fallback (`ARGUS_ASCII=1`):** `^ N` / `v N`. Applies globally, not per-pane.
- **Style:** dim (§1 muted palette). Left-aligned within the pane's content column.
- **Applies to:** middle pane list, right pane in Preview / Form / Invoking / Result.
- **Does not apply to:** left pane (static), status bar.

---

## 3. Per-component states

Every user-visible component below has an explicit list of states. "N/A" means the state cannot occur for that component.

### 3.1 Connection pane (left)

| State | Rendering |
|---|---|
| Connecting | `● connecting` yellow, spinner next to path, no PID |
| Connected | `● connected` green, path + transport + PID shown |
| Disconnected (user quit) | Never rendered — we're exiting |
| Error — invalid path | Full pane replaced with red error block: `path not found: ./foo.js` + `q to quit` |
| Error — initialize timeout | Red block: `server did not respond to initialize within 5s` + `q to quit` |
| Error — server crashed mid-session | Red block over pane: `server exited (code 1) — invocations disabled` + `q to quit` |
| First-time / empty | N/A — pane always has content (we always know the path from argv) |
| Loading (post-connect) | N/A — capability lists live in the middle pane |

### 3.2 Capabilities pane (middle)

Tabs: `[t]ools [r]esources [p]rompts`. Active tab is bold + underlined.

| State | Rendering |
|---|---|
| Loading | Spinner + `loading tools…` in the list area |
| Empty (server exposes zero of this category) | Dim italic: `no tools exposed` |
| Populated | Scrollable list, one item per line, truncated with `…` if needed |
| Focused (pane has focus, item selected) | Selected item reverse-video, others normal |
| Unfocused (pane does not have focus, but had selection) | Selected item shown with underline instead of reverse-video |
| Error (list fetch failed) | Red inline: `failed to list tools: <message>` + `r to retry` |

### 3.3 Detail pane (right) — Preview mode

| State | Rendering |
|---|---|
| Default (item highlighted) | Item name + description + condensed schema tree |
| Nothing highlighted (fresh middle-pane load) | Dim: `select an item to preview` |
| Description missing on server | Item name + `(no description provided)` in dim |

### 3.4 Detail pane (right) — Form mode

Each form field renders per the graceful-ladder rules (see PRD § Implementation Decisions).

| State | Rendering |
|---|---|
| Default (populated form, none focused) | Fields stacked, current focus on first field |
| Field focused | Reverse-video field label + cursor visible in input |
| Field validation error (on submit) | Field label + input in red + inline error under the field |
| Field using raw-JSON fallback | Field label + `(raw JSON)` dim tag + multi-line textarea |
| Form disabled (server crashed) | All fields dim, no cursor, footer: `server disconnected — cannot invoke` |
| Submitting | Bottom of pane: spinner + `invoking…`; fields locked, no edits accepted |

### 3.5 Detail pane (right) — Result mode

| State | Rendering |
|---|---|
| Success — small (< 20 KB) | Pretty-printed JSON, syntax-highlighted (keys cyan, strings default, numbers yellow, booleans/null magenta). Scrollable. |
| Success — large (≥ 20 KB) | Warning banner: `response is 84 KB — press o to open in $PAGER`. First 200 lines shown inline. |
| Success — non-JSON result (text, base64) | Rendered as string, prefix tag: `[text]` or `[base64]` |
| Error — server returned error | Red block: server error name + message + JSON detail |
| Error — invocation timed out | Red block: `invocation timed out after 30s` |
| Empty result (`null` / `{}`) | Dim italic: `(empty response)` |

### 3.6 Status bar (bottom, persistent)

Always visible. Hints on the left change per focused pane / mode:

| Context | Left-side hints |
|---|---|
| Focus = left pane | `q quit` |
| Focus = middle pane, preview | `←/→ panes  ↑/↓ list  tab tabs  enter form  s swap  q quit` |
| Focus = right pane, preview | `←/→ panes  ↑/↓ scroll  tab tabs  s swap  q quit` |
| Focus = right pane, form | `tab/shift-tab fields  enter submit  esc cancel  ctrl+r last args  q quit` |
| Focus = right pane, invoking | `esc cancel` |
| Focus = right pane, result | `↑/↓ scroll  tab tabs  o open in $PAGER  esc back to form  s swap  q quit` |
| Connection error state | `s swap  q quit` |
| Startup screen | `tab/shift-tab zone  ↑/↓ list  enter connect  q quit` |

**Rules:**
- `s swap` is only shown in contexts where the keybind is active (Preview, Result, connection Error). It is hidden in Form and Invoking because pressing `s` there is a silent no-op — showing it would invite confusion.
- Vim keys (`h/j/k/l`, `t/r/p`) still work but are not advertised in the hints — arrow keys and `tab` are the discoverable path for new users. This is deliberate; existing vim users already know their keys.
- Hint strings are short enough to fit on 80 columns after the right-side connection blip is subtracted (~25 columns budget for hints on the smallest supported terminal). If a hint string would exceed the budget it truncates from the right with `…`; no wrap.

Right side always shows connection status blip.

### 3.7 Startup screen (`<StartupScreen>`)

Shown when argus is invoked with no path arg, and when the user presses `s` to swap servers mid-session. Replaces the three-pane layout entirely; the outer frame is a single centered card, not the three-pane frame.

Two focus zones:
- **Zone A — path input:** single-line text input, centered, ~60 columns wide (or `terminalCols − 4`, whichever is smaller).
- **Zone B — recent-servers list:** scrollable list below the input, showing up to 10 entries.

| State | Rendering |
|---|---|
| First launch, no history | Zone A focused (cursor blinks); Zone B renders dim `no recent servers — type a path above` |
| History non-empty, launch | Zone B focused (top entry reverse-video); Zone A empty, no cursor |
| History non-empty, swap mid-session | Same as launch with history: Zone B focused, top entry reverse-video |
| Input typing | Zone A focused, cursor visible, live text |
| Entry present + reachable (`fs.stat` OK) | Absolute path only |
| Entry present + missing on disk | Path in dim, ` (missing)` suffix in dim |
| Missing entry selected + `enter` pressed | Inline `path not found` red line under the entry; focus stays on Zone B; no mode change |
| History file unreadable | Zone B empty; one-line stderr warning was already printed before the TUI mounted |
| Zone A empty + `enter` | No-op (does not attempt to connect to an empty path) |
| Connecting after `enter` | Startup screen unmounts; three-pane `connecting…` state takes over |

**Layout at 80×24 (rough):**

```
┌─ argus ─────────────────────────────────────────────────────────────┐
│                                                                     │
│                        Connect to an MCP server                     │
│                                                                     │
│                  ┌───────────────────────────────────┐              │
│                  │ /path/to/server.js_               │              │
│                  └───────────────────────────────────┘              │
│                                                                     │
│                  Recent:                                            │
│                  > /Users/me/servers/filesystem.js                  │
│                    /Users/me/servers/weather.js                     │
│                    /Users/me/servers/old.js (missing)               │
│                                                                     │
│ tab/shift-tab zone  ↑/↓ list  enter connect  q quit    ● disconnected│
└─────────────────────────────────────────────────────────────────────┘
```

---

## 4. User flow

### 4.1 Golden path

```
launch (argus ./server.js)
  │
  ▼
[connecting… spinner]
  │  (< 200ms to first paint per PRD)
  ▼
three-pane view, focus = middle pane, tools tab active
  │
  ▼
user presses j/k to browse tools
  │
  ▼
right pane shows preview per selection
  │
  ▼
user presses enter → right pane switches to Form mode, focus moves to right pane
  │
  ▼
user tab/shift-tab through fields, fills them
  │
  ▼
user presses enter → validate (ajv) → submit
  │        │
  │        └─ validation fail: highlight bad fields in red, do not submit, focus first invalid
  │
  ▼
[invoking… spinner in pane]
  │
  ▼
right pane switches to Result mode, shows response
  │
  ▼
user can:
  - press esc → back to Form (values preserved, "arrow-up recall" is a separate feature)
  - press j/k → scroll
  - press o → open raw JSON in $PAGER
  - press h → back to middle pane, right pane returns to Preview
```

### 4.2 Recall last args (in-session history)

From the form (any field), pressing `ctrl+r` when the focused field is empty re-populates the whole form with the last-invoked args for the same tool. In-memory only, does not survive process restart or a server swap.

The gesture was previously bound to `↑`; it moved to `ctrl+r` so that `↑` could uniformly mean "prev field" in Form mode alongside the rest of the app's arrow-key semantics.

### 4.3 Failure flows

- **Invalid path at launch (path arg present):** print single-line error to stderr, exit 1. Do not enter the TUI. This applies to `argus /does/not/exist`, not to launching without any arg.
- **No path arg:** enter TUI, mount startup screen (§4.4). Not a failure — it's the picker flow.
- **Initialize timeout / server crash pre-connect (from a chosen path):** enter TUI, show error state in left pane (see §3.1). User can press `s` to swap or `q` to quit.
- **Server crashes mid-session:** left pane switches to error state; middle pane stops accepting keys except `q` and `s`; right pane form disables (see §3.4). User presses `s` to pick another server, or quits.

### 4.4 Startup screen flow

```
launch (argus, no args)
  │
  ▼
Ink mounts startup screen (§3.7)
  │
  │  history is loaded from disk before mount (or empty if ARGUS_NO_HISTORY=1)
  │  focus starts on Zone B (list) if history non-empty, else Zone A (input)
  │
  ▼
user does one of:
  ─ types a path in Zone A, presses enter                → connect to that path
  ─ selects an entry in Zone B, presses enter (present)  → connect to that path
  ─ selects an entry in Zone B, presses enter (missing)  → inline error, stay
  ─ presses tab / shift+tab                              → swap zones
  ─ presses q / ctrl+c                                   → quit
  │
  ▼
on enter → startup screen unmounts, three-pane view mounts in connecting state
  │
  ▼
successful initialize → history file records the path (fire-and-forget)
```

Passing `argus <path>` skips this flow entirely — that path is treated as if the user had picked it from the startup screen. `argus /does/not/exist` still exits with a stderr error rather than falling through here (per §4.3), so scripts fail loudly instead of hanging on a TUI.

### 4.5 Swap-server flow

```
in three-pane view, focus ∈ {middle, right(preview), right(result)}
  or connection is in error state
  │
  ▼
user presses s
  │
  ▼
app-shell tears down: client.disconnect() (existing 2s + SIGTERM + SIGKILL ladder)
                       reset pane state (focused pane, selection index, scrollTop,
                                          active tab, last-invocation ref)
  │
  ▼
mount startup screen with the current server history
  │
  ▼
(same as §4.4 from here)
```

No confirmation dialog. State loss is bounded (selection index, scroll positions, recall slot); the user pressed `s` deliberately. In Form and Invoking modes `s` is a silent no-op — swapping while a form has unsent input or an invocation is in flight would be surprising, so those modes require `esc` first.

---

## 5. Interactions

### 5.1 Key bindings (full table)

Arrow keys are the discoverable primary path. Vim keys (`h/j/k/l`, `t/r/p`) are aliases and remain fully supported.

| Key | Global | Left pane | Middle pane | Right (Preview) | Right (Form) | Right (Result) |
|---|---|---|---|---|---|---|
| `←` (left-arrow) | move focus left (alias for `h`) | — | left pane | middle | ignored (form owns focus) | middle |
| `→` (right-arrow) | move focus right (alias for `l`) | middle | right | — | ignored (form owns focus) | — |
| `↑` (up-arrow) | — | — | prev item (alias for `k`) | scroll up one line | prev field (alias for `shift+tab`) | scroll up one line |
| `↓` (down-arrow) | — | — | next item (alias for `j`) | scroll down one line | next field (alias for `tab`) | scroll down one line |
| `tab` | — | — | cycle tabs `tools → resources → prompts` | cycle tabs | next field (unchanged) | cycle tabs (also exits Result) |
| `shift+tab` | — | — | cycle tabs (reverse) | cycle tabs (reverse) | prev field (unchanged) | cycle tabs (reverse; also exits Result) |
| `h` | move focus left | — | left pane | middle | ignored | middle |
| `l` | move focus right | middle | right | — | ignored | — |
| `j` | — | — | next item | scroll down | next field | scroll down |
| `k` | — | — | prev item | scroll up | prev field | scroll up |
| `t` / `r` / `p` | — | — | switch tab | switch tab | ignored | switch tab (also exits Result) |
| `enter` | — | — | focus form (if item highlighted) | — | submit | — |
| `esc` | cancel current mode | — | — | — | discard form, back to Preview | back to Form |
| `ctrl+r` | — | — | — | — | recall last args (if focused field empty) | — |
| `s` | swap server (Preview / Result / Error only) | swap | swap | swap | ignored (silent no-op) | swap |
| `o` | — | — | — | — | — | open response in `$PAGER` |
| `q` | quit | quit | quit | quit | (must esc first) | quit |
| `Ctrl-C` | quit | quit | quit | quit | quit | quit |

**Notes on overlaps and renamed bindings:**
- `tab` in Form mode continues to mean "next field" (unchanged). No collision, because Form mode owns focus and never touches capability tabs.
- `tab` in Middle pane / Preview / Result cycles the three capability tabs, routing around the `r` overload (which means both "resources tab" and "retry list on error" — `tab` gives an unambiguous cycle regardless of the current tab).
- `ctrl+r` recall replaces the previous `↑` recall gesture, so `↑` can mean "prev field" uniformly with the rest of the app.
- `↑` in Result was previously documented as "scroll to top" but that behavior was never wired. Redefined to "scroll up one line" for consistency with Preview and Form.
- Ambiguous cases resolved above (e.g., `q` inside Form is intentionally disabled — user must `esc` first, so they don't lose unsent form input to a typo).

### 5.2 No animations

No fades, no slides, no easing curves. State changes are instant. Spinners are the only motion — braille dots (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) rotating at 80ms/frame. ASCII fallback: `| / - \`.

### 5.3 Hover

N/A — no mouse in MVP. All navigation is keyboard.

---

## 6. Accessibility

- **Screen readers:** Ink's rendering isn't screen-reader-friendly by default. MVP does not commit to full screen-reader support, but must not actively break it — output goes to stdout in a way that a screen reader running on the terminal emulator can read the current pane's contents. Documented as a known limitation in README.
- **Color-blind users:** state distinguishable without color (§ 1). All red states pair with a text prefix (`error:`, `failed to…`). Green success pairs with `● connected`.
- **Reduced motion:** if `PREFERS_REDUCED_MOTION` or equivalent is set, spinners degrade to a static `…` indicator that updates once per second.
- **Focus visibility:** the focused pane always has a bold title + cyan (or bold if no color) border. Never ambiguous which pane owns keyboard input.
- **Key hints always visible:** the bottom status bar removes the need to memorize bindings.

---

## 7. Non-goals for MVP (design-spec scope)

- Themes / user color config.
- Nerd Font glyphs.
- Mouse support.
- Split panes / tabs / multiple simultaneous views.
- Search-as-you-type in capability lists.
