# claude-session-monitor

> Track each Claude Code CLI account across machines. The shared lock lives in a **pinned Telegram message**, so a second machine that opens Claude with the same account is detected across the network — with real-time start / end / conflict notifications to your group. Notify-only: no session is ever blocked or killed.

<!-- badges: replace with real ones once CI + npm publish are set up -->
![npm](https://img.shields.io/badge/npm-1.0.0-blue)
![node](https://img.shields.io/badge/node-%3E%3D22-green)
![license](https://img.shields.io/badge/license-MIT-lightgrey)

> [!IMPORTANT]
> The Telegram bot **must be a group Admin with the "Pin Messages" permission.** The shared account lock is stored in a single **pinned message** in your group. Without that permission, `init` cannot create the lock and cross-machine detection will not work.

## What it does

Each Claude account (identified by `oauthAccount.emailAddress` in your `~/.claude.json`) may be
**active on only one machine at a time**. Different accounts are fully independent of each other.

The shared source of truth is **one pinned Telegram message** holding JSON:

```json
{ "v": 1, "accounts": { "you@example.com": { "machine": "laptop", "ip": "203.0.113.7", "loc": "Hanoi · VNPT", "session": "…", "ts": 1750000000 } } }
```

Every machine reads that message (`getChat` → `pinned_message`) and updates it (`editMessageText`) when it
acquires or releases a lock. This is what makes cross-machine detection actually work — an earlier
`/tmp` lock file could only see the local machine.

## Features

- **Account-based lock tracking across machines** — one account = one lock holder; a second machine is detected everywhere the bot can reach.
- **Telegram-pinned shared state** — the lock is a single pinned message in your group, read/written by every machine.
- **Real-time notifications** — a ✅ notice when a session starts, a ⚠️ notice on a cross-machine conflict, and a 👋 notice when the last session ends. Notify-only: nothing is blocked or killed.
- **Public-IP + location identification** — each machine is shown by its public/WAN IP (via `api.ipify.org`) plus city · ISP (via `ipinfo.io`) in notifications and in `status`.
- **Three self-contained hooks** — `SessionStart`, `PreToolUse`, and `SessionEnd` are wired into `~/.claude/settings.json` automatically; no manual editing.
- **Dependency-free runtime** — a Node-built-ins-only `runner.js` is installed under `~/.claude/session-monitor/`; only `node` on your `PATH` is required at hook time.
- **Fail-open by design** — any config or network error makes the hooks do nothing, so they never break Claude.
- **Encrypted bot token at rest** — AES-256-GCM, config file written `0600`.

## Prerequisites

You need a Telegram **bot**, a **group** for it to post into, and the bot promoted to **Admin with Pin
Messages**. You also need `node` (v22+) on the `PATH` of every machine where Claude runs.

### 1. Create a bot and get its token

1. Open Telegram and message [`@BotFather`](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts (name + username).
3. BotFather replies with a **token** like `123456789:AAExampleTokenStringHere`. Keep it secret.

### 2. Create a group and get its ID

1. Create a Telegram group (or use an existing one).
2. **Add your bot to the group** as a member.
3. Get the group's numeric chat ID (a **negative** number, e.g. `-1001234567890`):
   - Easiest: add [`@getidsbot`](https://t.me/getidsbot) (or `@RawDataBot`) to the group; it prints the `chat.id`, then remove it. **or**
   - Send any message in the group, then run:
     ```bash
     curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
     ```
     and read `result[].message.chat.id` from the JSON response.

> Note: group IDs are negative. Supergroups typically start with `-100`.

### 3. Promote the bot to Admin with "Pin Messages" **(required)**

Open the group → **Manage group → Administrators → Add Admin → your bot**, and enable at least the
**Pin Messages** permission. The shared account lock is stored in a **pinned message**; without this
permission, `init` will warn that it could not create the pinned lock, and cross-machine detection
cannot function. Do this **before** (or as part of) running `init`.

## Quick Start

No install needed — run it with `npx`:

```bash
npx claude-session-monitor init
```

The wizard will:

1. Ask for your **bot token**, **group ID**, and a **session lock timeout** (default `600` seconds = 10 minutes).
2. **Test the Telegram connection** before saving anything.
3. **Install the runtime + three hooks** into Claude Code.
4. **Create and pin the shared-state message** in your group (this needs the Pin Messages permission).

Not sure what setup will touch? Preview it first — this writes nothing, prompts nothing, and contacts
no one:

```bash
npx claude-session-monitor init --dry-run   # print the runtime/hook/settings paths, then exit
```

Re-running is idempotent; use `--force` to overwrite an existing config without the confirm prompt:

```bash
npx claude-session-monitor init --force
```

Then use the diagnostic commands anytime:

```bash
npx claude-session-monitor status      # config + hook health + the shared lock table
npx claude-session-monitor test        # send a test message to your group
npx claude-session-monitor uninstall   # remove the hooks, runtime, and local config
```

## How it works

Setup installs a dependency-free runtime and three thin bash wrappers, then registers them as hooks:

```
npx claude-session-monitor init
        │
        ▼
prompts for bot token + group ID + timeout (Inquirer)
        │
        ▼
Telegram testConnection() verifies the bot works
        │
        ▼
config saved (token encrypted) to  ~/.claude/session-monitor/config.json
        │
        ▼
runtime copied to  ~/.claude/session-monitor/runner.js   (node built-ins only)
        │
        ▼
three wrappers written to  ~/.claude/hooks/
   csm-session-start.sh · csm-pretooluse.sh · csm-session-end.sh
        │
        ▼
hooks registered in  ~/.claude/settings.json
   SessionStart · PreToolUse · SessionEnd   (existing settings backed up first)
        │
        ▼
shared-state message created + PINNED in the Telegram group
```

At runtime, each wrapper execs `node runner.js <event>` and the runtime does one job per event:

1. **SessionStart** (on `claude` launch) — read the shared state from the pinned message.
   - If the account is **already active on a different machine** → send a **⚠️ conflict** notice naming both
     machines and pass context to Claude. The session keeps running normally — nothing is blocked or killed.
   - Otherwise **acquire the lock**: record `{machine, public IP, city·ISP, session, ts}` into the pinned
     message and send a **✅ started** notice.
2. **PreToolUse** (before every tool call) — heartbeat + conflict reminders.
   - If this session is the **owner** → a throttled heartbeat (at most every ~2 min) refreshes the lock's
     timestamp so long work sessions don't look stale.
   - If this session started **in conflict** → every ~5 min it re-checks the holder: still active elsewhere →
     repeat the **⚠️ reminder** (one per machine per window, however many sessions are open); released or
     stale → silently **take the lock over** and continue as a normal owner (reminders stop).
3. **SessionEnd** (any exit path) — if this session owns the lock, **release it**: remove the account from the
   pinned message and send a **👋 released** notice.

A lock is considered "active" for at least the configured timeout (floored to **10 minutes** of inactivity),
so a crashed session without a clean `SessionEnd` eventually expires and stops raising conflicts.

Re-running `init` updates the config and re-installs cleanly (the old single-hook `check-session-telegram.sh`
from v1 is removed), and `settings.json` is backed up before every modification.

## Commands

| Command | What it does |
|---|---|
| `init` | Interactive setup wizard. Flags: `--dry-run` (preview runtime/hook/settings paths, write nothing), `--force` (overwrite existing config without the confirm prompt). Default lock timeout is `600` seconds (10 minutes). |
| `status` | Show the config summary (masked token, group ID, timeout, machine, pinned-state message id), **hook health** (are the hooks registered? is `runner.js` present?), and the **shared lock table** — which account is active on which machine/IP/location and for how long (read live from the pinned message). |
| `test` | Verify the Telegram connection and send a test message to the group. |
| `pin` | Pin one message of data onto the group, **verbatim**. By default the currently pinned message is edited in place (same `message_id`, so the hook keeps reading it). Flags: `--state` (prepend the `🔒 Claude session locks` header so the runtime parses it as shared lock state — handy for seeding/faking locks when testing conflict enforcement; warns if the JSON doesn't parse as state), `--new` (always send + pin a fresh message instead of editing). |
| `remove-account <account>` | Remove one account's lock from the pinned shared state — recovery for the **power-loss / crash** case where a machine died without a clean `SessionEnd` and its lock would otherwise linger until the TTL expires. Prints the accounts that do hold locks when the name doesn't match, and posts a 🔓 notice to the group on success. |
| `uninstall` | Remove the three hooks from `settings.json`, delete the runtime + wrappers, and delete the local config. Flag: `--yes` (skip the confirm prompt). The pinned shared-state message is **left in place** — unpin it manually if you no longer need it. |
| `logs` | **Legacy.** Reads a local `history.log` file. The v2 runtime does **not** write this file (the live lock state now lives in the pinned Telegram message), so `logs` will normally report "No session history yet." Use `status` to see live lock state. `-n, --lines <n>` limits output (default 20). |

### `pin` examples

```bash
# Pin any line of data verbatim (edits the current pinned message in place)
npx claude-session-monitor pin 'any data line'

# Always send + pin a NEW message instead of editing the pinned one
npx claude-session-monitor pin --new 'any data line'

# Seed/fake lock state (the 🔒 header is prepended automatically) — e.g. to
# simulate an active session on another machine and test conflict enforcement
npx claude-session-monitor pin --state \
  '{"v":1,"accounts":{"you@gmail.com":{"machine":"pc","ip":"1.2.3.4","loc":"Da Nang · ISP","sessions":{"<session-uuid>":1782990021818},"ts":1782990021818}}}'
```

Notes: the bot must be an Admin with the **Pin Messages** permission. Because the default mode edits the
pinned state message in place, `pin` **overwrites the live lock table** — sessions currently holding a lock
will re-acquire on their next heartbeat, but use it deliberately.

## Configuration & files

| Path | Purpose |
|---|---|
| `~/.claude/session-monitor/config.json` | Config (bot token **encrypted** with AES-256-GCM; file mode `0600`). Also holds the pinned-state `stateMessageId`. |
| `~/.claude/session-monitor/.secret` | 32-byte AES key (mode `0600`). |
| `~/.claude/session-monitor/runner.js` | Self-contained hook runtime (Node built-ins only). |
| `~/.claude/hooks/csm-session-start.sh` | `SessionStart` wrapper (matcher `startup\|resume\|clear\|compact`). |
| `~/.claude/hooks/csm-pretooluse.sh` | `PreToolUse` wrapper (matcher `*`). |
| `~/.claude/hooks/csm-session-end.sh` | `SessionEnd` wrapper. |
| `~/.claude/settings.json` | Where the three hooks are registered (backed up before each change). |
| `~/.claude.json` | Read-only: the account email (`oauthAccount.emailAddress`) that identifies the lock. |
| Telegram pinned message | The **shared** account-lock state; the only cross-machine source of truth. |

The bot token is encrypted at rest, but treat it as a secret regardless — anyone with it can post to your group.

### Config example

`~/.claude/session-monitor/config.json` looks like this (the `botToken` is an AES-256-GCM
envelope, **not** a plaintext token):

```json
{
  "version": "1.0.0",
  "botToken": { "iv": "…", "tag": "…", "data": "…" },
  "groupId": "-1001234567890",
  "timeout": 600,
  "machineName": "laptop",
  "installedAt": "2026-01-01T00:00:00.000Z",
  "stateMessageId": 24
}
```

- `groupId` — the shared group (negative; supergroups start with `-100`).
- `stateMessageId` — id of the pinned shared-lock message; **keep this the same across machines** so they all read/write one lock.
- `timeout` — lock inactivity window in seconds. Values below `600` are **clamped up to 600** at runtime (the lock must outlive the 120 s heartbeat), so anything under 10 min has no effect.
- `machineName` — informational; `init`/`runner.js` fall back to the OS hostname.

### Skip the prompts on another machine

`init` reuses an existing valid config and only asks for what is missing (use `--force` to
re-prompt everything). To set up a second machine **without re-entering the token or group**,
copy **both** of these files (the token cannot be decrypted without its matching key):

```bash
# on the new machine, same paths
~/.claude/session-monitor/config.json   # token (encrypted), groupId, stateMessageId, timeout
~/.claude/session-monitor/.secret       # the AES key that decrypts botToken — REQUIRED
```

Then run `npx claude-session-monitor init` — it detects the valid config, skips the token/group/timeout
prompts, and you only confirm installing the hooks. Copying `config.json` **without** `.secret`
makes decryption fail, and `init` falls back to asking from scratch.

## Troubleshooting

- **`Bad Request: chat not found`?** The **group ID is wrong**. Group IDs are negative and supergroups start with `-100`. Re-check it with `curl ".../getUpdates"` or by adding [`@getidsbot`](https://t.me/getidsbot) to the group. `getUpdates` returns nothing until the bot has received at least one message in the group.
- **`getMe` returns 404 / `401 Unauthorized`?** The **bot token is wrong** or was revoked. Regenerate it via `@BotFather` and run `init` again.
- **Lock never gets created / "Could not create the pinned shared-state message"?** The bot is **not an Admin with the "Pin Messages" permission**. Promote it (see Prerequisites step 3) and run `claude-session-monitor init --force` to finish setup.
- **Hooks not firing?** Run `claude-session-monitor status` — it reports whether the hooks are registered in `settings.json` and whether `runner.js` exists. Re-run `init` if either is missing. Also confirm `node` is on the `PATH` (the wrappers fail open — do nothing — when `node` is absent).
- **Conflict notices keep firing?** Close the Claude session on the machine that **owns** the lock (that triggers `SessionEnd` and releases it), or wait for the lock's inactivity timeout (≥10 min) to expire. Check who holds it with `status`.
- **A machine crashed / lost power and its lock is stuck?** Clear it immediately with `claude-session-monitor remove-account you@example.com` — no need to wait for the TTL.
- **Nothing in `logs`?** Expected — the v2 runtime doesn't write `history.log`. Use `status` for live lock state.

## Scope & compatibility

- Supported: **Claude Code CLI**, which exposes a hooks system in `~/.claude/settings.json`. This tool installs `SessionStart`, `PreToolUse`, and `SessionEnd` hooks there.
- **Not supported: the Claude Desktop app.** The desktop app has no bash-hook system (it only supports MCP servers), so there is nowhere to install these shell hooks. Use the CLI if you need account locking.
- Requires `node` (v22 or newer) on the `PATH`. Works on macOS, Linux, and Windows (WSL).

## License

[MIT](./LICENSE) © 2026 Thang TN
