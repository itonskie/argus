# ADR 3: Zero disk state in MVP — no `~/.argus/`

**Status:** Accepted
**Date:** 2026-07-03

## Context

The original README v1 scope mentioned "local-only state under `~/.argus/` (servers, sessions, history)." During the 2026-07-03 grill session, we cut saved server configs, persistent history, and session recording from the MVP. That eliminates every reason to touch disk.

## Decision

argus MVP writes zero files. No `~/.argus/`, no `servers.json`, no history file, no cache. Every session is fresh: launch by path, browse, invoke, quit. Anything ephemeral (in-session history — arrow-up recall of last args) lives in process memory and dies with the process.

## Alternatives Considered

- **Empty `~/.argus/` created on first launch, ready for future features.** Rejected: creates a migration surface. Once the directory exists, users notice it, tools index it, dotfile managers back it up. Later we'd be committing to whatever schema was in place, even the empty one.
- **In-memory only for history, `~/.argus/servers.json` for saved configs.** Rejected: saved configs were themselves cut. No reason for the file.
- **`~/.argus/history.jsonl` for cross-session recall.** Rejected: MVP does not need it; adds a schema and a cleanup story.

## Consequences

- When we add saved configs, session recording, or cross-session history later, we design them fresh — no legacy schema to keep compatible with.
- Users cannot recover their last-session args after quitting argus. Documented as MVP behavior in README.
- No permissions issues, no cleanup story, no "argus is polluting my home directory" complaint. Nothing to migrate, nothing to break.
