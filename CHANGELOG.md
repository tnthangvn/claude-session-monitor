# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [1.2.9] - 2026-07-17

### Changed

- **Pinned state is minimal per account: `{machine, mid, exp}`.** The per-session
  UUID map (`sessions`) is no longer written to the pinned Telegram message —
  live sessions are counted in a machine-local refcount
  (`~/.claude/session-monitor/active/`) instead. This stops the pinned message
  from bloating with a new UUID for every concurrent session.
- **Lock freshness now uses a holder-declared absolute expiry `exp`.** The holder
  stamps `exp = now + timeout` (epoch **milliseconds**) on the pinned message; a
  reader treats the lock as live while `Date.now() < exp` — judged by the
  **holder's** timeout, not the reader's. This fixes an early takeover when two
  machines ran different `timeout` values (e.g. a machine with `timeout=3600`
  was stolen after ~10 min by one with `timeout=600`).
- **`ttl` now equals the configured `timeout` verbatim.** The 600s floor and the
  reader-side `TTL_FLOOR_SEC` grace window were removed from the active/conflict
  logic (the constant remains for compatibility).
- **Heartbeat remote refreshes are coalesced machine-wide** (`.pushed`): with N
  live sessions, only one `editMessageText` per 120s window extends the shared
  `exp`. The local refcount still refreshes per session.
- **`status`** shows *"Expires in"* (derived from `exp`) instead of *"Active
  for"*; a session count is shown only for legacy entries that still carry one.

### Notes

- A holder still inside its window is **protected**: a second machine posts a
  `⚠️` conflict warning (read-only) instead of stealing the lock.
- A **crashed** holder is taken over only after its `exp` passes (last heartbeat
  + `timeout`) — choose a smaller `timeout` for faster crash recovery.
- Legacy entries (with `ts` / `sessions`) still resolve via a fallback and
  self-migrate to the minimal shape on their next write.
- Cross-machine TOCTOU on the shared pinned message is still not addressed (needs
  a truly atomic store); only same-machine races are eliminated.
- Run `claude-session-monitor upgrade` on each machine to copy the new runtime
  into `~/.claude/session-monitor/runner.js`.

## [1.2.8] - 2026-07-11

> Published to npm as `1.2.8` (the `1.2.7` tag was never published — npm went
> `1.2.6` → `1.2.8`).

### Fixed

- **Notification storm on one machine.** When several Claude sessions launched on
  the same machine at nearly the same moment, each read the pinned Telegram state
  while it was still empty and every one posted its own `✅ mở session` — a burst
  of duplicate notices. Sessions are now reference-counted with machine-local
  files and the open notice is gated by an atomic filesystem flag, so a burst of
  concurrent starts produces exactly **one** `✅`, and the `👋 đóng session`
  notice fires **once**, only when the **last** session on the machine ends.

### Notes

- The gate is machine-local (`~/.claude/session-monitor/active/` +
  `.opennotice`); it does not depend on the slow shared round-trip, so it is
  race-proof for same-machine concurrency. Cross-machine conflict warnings (⚠️)
  are unchanged.
- Run `claude-session-monitor upgrade` on each machine to pick up the new runtime.

## [1.2.6] - 2026-07-11

### Changed

- Session notifications no longer include the public IP or geolocation
  (`city · ISP`). A start notice is now simply
  `✅ <account> mở session @ <machine>.` The same applies to takeover (♻️),
  conflict (⚠️), and conflict-reminder messages.
- `status` no longer shows a **Location** row for active locks — the lock table
  is now Machine / Sessions / Active for.

### Removed

- Public-IP lookup (`api.ipify.org`, `checkip.amazonaws.com`) and geolocation
  lookup (`ipinfo.io`) from the hook runtime, along with the on-disk IP cache
  (`~/.claude/session-monitor/.ipcache`). Each session start now skips two
  network round-trips.
- The `ip` and `loc` fields are no longer written into the shared pinned-message
  state.

### Notes

- Machine identity is the stable hashed NIC MAC (`mid`) introduced in 1.2.4, so
  the public IP had become display-only dead weight — this release drops it.
- Existing pinned state that still carries `ip`/`loc` is read without error;
  those fields are ignored and fall off on the next state write.
- Run `claude-session-monitor upgrade` on each machine to copy the new runtime
  into `~/.claude/session-monitor/runner.js`.
