# claude-session-monitor

> Monitor Claude Code CLI sessions, detect concurrent sessions from different machines, and notify a Telegram group in real time — installed as a `PreToolUse` hook.

<!-- badges: replace with real ones once CI + npm publish are set up -->
![npm](https://img.shields.io/badge/npm-1.0.0-blue)
![node](https://img.shields.io/badge/node-%3E%3D14-green)
![license](https://img.shields.io/badge/license-MIT-lightgrey)

## Features

- **Interactive setup wizard** — `init` walks you through bot token, group ID, and timeout, then installs everything for you.
- **Concurrent-session conflict detection** — a lock file records the last machine + timestamp; a new session from a different machine within the timeout window is flagged as a conflict.
- **Telegram group notifications** — session starts, conflicts, and approvals are posted to your group in real time.
- **Approval workflow** — conflicting sessions can be approved or denied by group members via inline buttons.
- **Hook integration** — the monitor is wired into Claude Code's `PreToolUse` hook automatically; no manual editing of `settings.json` required.

## Prerequisites

You need a Telegram **bot** and a **group** for it to post into.

### 1. Create a bot and get its token

1. Open Telegram and message [`@BotFather`](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts (name + username).
3. BotFather replies with a **token** that looks like `123456789:AAExampleTokenStringHere`. Keep it secret.

### 2. Create a group and get its ID

1. Create a Telegram group (or use an existing one).
2. **Add your bot to the group** as a member.
3. Get the group's numeric chat ID (it is a **negative** number, e.g. `-1001234567890`):
   - Easiest: add [`@RawDataBot`](https://t.me/RawDataBot) to the group; it prints the `chat.id` and you can then remove it. **or**
   - Send any message in the group, then run:
     ```bash
     curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
     ```
     and read `result[].message.chat.id` from the JSON response.

> Note: group IDs are negative. Supergroups typically start with `-100`.

## Quick Start

No install needed — run it with `npx`:

```bash
npx claude-session-monitor init
```

The 3-step wizard will:

1. Ask for your **bot token** and **group ID** (and an optional session timeout).
2. **Test the Telegram connection** before saving anything.
3. **Install the hook** into Claude Code and save your config.

Not sure what setup will touch? Preview it first — this writes nothing, prompts
nothing, and contacts no one:

```bash
npx claude-session-monitor init --dry-run   # show which hook lands where, then exit
```

Then use the diagnostic commands anytime:

```bash
npx claude-session-monitor status      # show current config + active session
npx claude-session-monitor test        # send a test message to your group
npx claude-session-monitor logs        # view session/conflict history
npx claude-session-monitor uninstall   # remove the hook + config
```

## How it works

```
npx claude-session-monitor init
        │
        ▼
prompts for bot token + group ID (Inquirer)
        │
        ▼
Telegram API testConnection() verifies the bot works
        │
        ▼
config saved to  ~/.claude/session-monitor/config.json
        │
        ▼
hook script generated at  ~/.claude/hooks/check-session-telegram.sh  (chmod 755)
        │
        ▼
hook injected into  ~/.claude/settings.json  under PreToolUse
        │
        ▼
on each Claude Code session, the hook runs:
        ├─ reads the lock file  /tmp/claude-session-$USER.lock
        ├─ compares last machine + timestamp against SESSION_TIMEOUT
        ├─ notifies the Telegram group
        └─ blocks on conflict (another machine is active within the window)
```

The flow is idempotent: re-running `init` updates the config and re-installs the hook without duplicating it, and the original `settings.json` is backed up before modification.

## Configuration & security

- **Config location:** `~/.claude/session-monitor/config.json`
- **Generated hook:** `~/.claude/hooks/check-session-telegram.sh`
- **Lock file:** `/tmp/claude-session-$USER.lock`
- The bot token is **encrypted at rest** and the config file is written with `0600` permissions (owner read/write only). Treat the token as a secret regardless — anyone with it can post to your group.

## Troubleshooting

- **Hook not firing?** Run `claude-session-monitor test`. It re-checks that the hook is installed in `settings.json` and that the script is executable. Re-run `init` if the hook is missing.
- **Telegram send fails?** Verify the **bot is a member of the group** and that the group ID is the correct **negative** number. `getUpdates` returns nothing until the bot has received at least one message in the group.
- **`401 Unauthorized` from Telegram?** The bot token is wrong or was revoked — regenerate it via `@BotFather` and run `init` again.
- **Nothing in `logs`?** No sessions have been recorded yet, or the lock file at `/tmp/claude-session-$USER.lock` was cleared on reboot.

## Scope & compatibility

- Supported: **Claude Code CLI**, which exposes a hooks system in `~/.claude/settings.json`. This tool installs a bash `PreToolUse` hook there.
- **Not supported: the Claude Desktop app.** The desktop app has no bash-hook system — it only supports MCP servers — so there is no place to install a `PreToolUse` shell hook. Use the CLI if you need session monitoring.
- Works on macOS, Linux, and Windows (WSL). Node.js 22 or newer is required.

## License

[MIT](./LICENSE) © 2026 Thang TN
