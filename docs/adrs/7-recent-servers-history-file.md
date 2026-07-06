# ADR 7: Persist a recent-servers list to `~/.config/argus/history.json`

**Status:** Accepted
**Date:** 2026-07-05
**Supersedes:** [ADR 3](3-zero-disk-state-mvp.md)

## Context

ADR 3 (2026-07-03) committed to zero disk state in MVP: no `~/.argus/`, no history file, nothing. The reasoning was sound at the time — cutting saved configs, session recording, and cross-session history from MVP scope eliminated every reason to touch disk, and staying disk-free avoided a migration surface.

Practical use since then surfaced a friction that outweighs the reasoning:

- Every session starts by either retyping the same absolute path to the MCP server, or reaching for `↑` in the shell to search bash history. Neither is fatal but both cost seconds every launch.
- Comparing two servers in one sitting means quitting, `↑`-editing the shell command, and relaunching. Session state is lost every time.

The friction is real, it repeats on every launch, and it applies to every user. Meanwhile the objections to disk state have blunted:

- **Migration surface.** The file is a one-line JSON `{ version: 1, servers: string[] }` capped at 10 entries. Any future schema change can be handled with a version-bump-and-fall-back-to-empty. This is not a real migration cost.
- **"Polluting home directory."** XDG (`$XDG_CONFIG_HOME/argus/history.json`, fallback `~/.config/argus/history.json`) is a conventional location that respects user overrides. The file is ~200 bytes.
- **Opt-out.** `ARGUS_NO_HISTORY=1` is a single env var. Users who insist on no disk state get exactly what they had before.

PRD #20 formalizes the change. The startup-screen picker and the mid-session swap keybind (`s`) both depend on this list being available.

## Decision

argus persists a recent-servers list to `$XDG_CONFIG_HOME/argus/history.json` (fallback: `~/.config/argus/history.json`). The file records the last 10 paths the user successfully connected to, most-recent first. It is written after a successful MCP `initialize` handshake, not before — typos and dead paths do not pollute the list. Users can opt out entirely with `ARGUS_NO_HISTORY=1`.

The file is:
- JSON with schema `{ version: 1, servers: string[] }`.
- Written atomically via tmp + `rename`. Concurrent argus processes are last-writer-wins with at worst one lost entry, never a corrupt file.
- Read on launch (for the startup screen) and on `s` swap. On any read failure (missing, malformed, wrong schema), argus falls back to an empty list and prints a one-line stderr warning.

ADR 3 is superseded but not deleted — the earlier reasoning remains a useful record of the state at the time.

## Alternatives Considered

- **Keep ADR 3 as-is; require users to script their own shell aliases.** Rejected. The friction is real and repeats every session for every user. Pushing it to shell aliases means every user re-solves the same problem in their own way, and comparing two servers mid-session still requires a full quit-and-relaunch.

- **In-memory only across processes, e.g. read from a running argus daemon.** Rejected. argus is a single-shot CLI, not a daemon. Adding a background process to avoid a 200-byte file inverts the complexity cost.

- **Environment-variable-based recall.** Rejected. `$ARGUS_RECENT` or similar is invisible to `env` inspection tools, doesn't survive terminal restarts, and offers no way to display a list — it would let the user recall one path, not pick from ten.

- **A separate "presets" or "bookmarks" file distinct from history.** Rejected as scope creep for MVP. If it becomes a real need, it can be added later without changing the history file's schema.

- **Write to disk on every path attempt, not just after successful initialize.** Rejected. Typos would fill the list with `~/foo/servr.js` and `~/bar/serer.js` entries. Writing after `initialize` guarantees every entry was reachable at least once.

## Consequences

- Users get low-friction relaunch and mid-session swap. The startup screen and the `s` keybind both depend on this file existing.
- On-disk state introduces one small responsibility: keep the schema forward-compatible. The `version: 1` field is the escape hatch — future versions bump it and fall back to empty on mismatch.
- Users who insist on ephemerality set `ARGUS_NO_HISTORY=1`. The env var is checked in `server-history` and short-circuits both reads and writes — no directory is created.
- README changes: the old "nothing written to disk" claim (from README v1, per ADR 3) is inaccurate and gets removed. The recent-servers list is added to the Features section, with the opt-out noted.
- Testing gets a new deep module (`server-history`) with unit tests around schema validation, LRU semantics, atomic writes, and the opt-out. See engineering-spec §2.8 and §7.1.
- ADR 3 is marked `Status: Superseded by ADR 7`. Its body is left intact — the reasoning at the time is still valid for readers who want the context of *why* it was reversed.
