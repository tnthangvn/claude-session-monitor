# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

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
