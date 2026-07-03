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
| Focus = middle pane, preview | `h/l panes  j/k list  t/r/p tabs  enter form  q quit` |
| Focus = right pane, form | `tab/shift-tab fields  enter submit  esc cancel  ↑ last args  q quit` |
| Focus = right pane, result | `j/k scroll  o open in $PAGER  esc back to form  q quit` |

Right side always shows connection status blip.

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

### 4.2 Arrow-up recall (in-session history)

From the form (any field), pressing `↑` when the field is empty re-populates the whole form with the last-invoked args for the same tool. In-memory only, does not survive process restart.

### 4.3 Failure flows

- **Invalid path at launch:** print single-line error to stderr, exit 1. Do not enter the TUI.
- **Initialize timeout / server crash pre-connect:** enter TUI, show error state in left pane (see § 3.1). User can only press `q`.
- **Server crashes mid-session:** left pane switches to error state; middle pane stops accepting keys except `q`; right pane form disables (see § 3.4). User quits, edits their server, relaunches.

---

## 5. Interactions

### 5.1 Key bindings (full table)

| Key | Global | Left pane | Middle pane | Right (Preview) | Right (Form) | Right (Result) |
|---|---|---|---|---|---|---|
| `h` | move focus left | — | left pane | middle | middle | middle |
| `l` | move focus right | middle | right | — | — | — |
| `j` | — | — | next item | scroll down | next field | scroll down |
| `k` | — | — | prev item | scroll up | prev field | scroll up |
| `t` / `r` / `p` | — | — | switch tab | switch tab | (ignored — form owns focus) | switch tab (also exits Result) |
| `enter` | — | — | focus form (if item highlighted) | — | submit | — |
| `esc` | cancel current mode | — | — | — | discard form, back to Preview | back to Form |
| `↑` (up-arrow) | — | — | — | — | recall last args (if field empty) | scroll to top |
| `o` | — | — | — | — | — | open response in `$PAGER` |
| `q` | quit | quit | quit | quit | (must esc first) | quit |
| `Ctrl-C` | quit | quit | quit | quit | quit | quit |

Ambiguous cases resolved above (e.g., `q` inside Form is intentionally disabled — user must `esc` first, so they don't lose unsent form input to a typo).

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
