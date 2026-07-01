# Implementation Plan: Claude Session Monitor

## Requirements Restatement

Build a production-ready NPM CLI package (`claude-session-monitor`) that:
- **Auto-setup wizard**: Interactive CLI to configure Telegram bot + group integration
- **Session monitoring**: Detect and block concurrent sessions from different machines
- **Conflict detection**: Warn via Telegram when same account tries to login from 2+ machines simultaneously
- **Group notifications**: Send real-time updates to Telegram group (session start, conflicts, approvals)
- **Approval workflow**: Allow group members to approve/deny sessions via inline buttons
- **Config management**: Store and manage settings securely in `~/.claude/session-monitor/`
- **Hook integration**: Auto-install bash hooks into Claude CLI settings
- **Publishable on NPM**: Installable via `npx claude-session-monitor init`

---

## Implementation Phases

### Phase 1: Project Setup & Core Infrastructure
**Duration**: 2-3 hours | **Complexity**: LOW

**Tasks:**
- Initialize git repo + npm package.json with dependencies
  - Dependencies: commander, inquirer, chalk, axios, dotenv
  - DevDeps: eslint, prettier, jest
- Create project structure:
  ```
  claude-session-monitor/
  ├── bin/
  │   └── cli.js                    (entry point)
  ├── src/
  │   ├── commands/                 (init, status, test, logs)
  │   ├── services/                 (telegram, config, generator)
  │   ├── utils/                    (validators, formatters)
  │   └── templates/                (hook script, config template)
  ├── tests/
  ├── .npmignore
  ├── package.json
  └── README.md
  ```
- Setup git hooks (pre-commit for linting)
- Create `.env.example` for development
- Write initial README with quick start

**Deliverables:**
- Working Node.js project with npm scripts
- Linting + formatting configured
- Git history ready

---

### Phase 2: CLI Core & Setup Wizard
**Duration**: 4-5 hours | **Complexity**: MEDIUM

**Tasks:**
- **`bin/cli.js`**: Command router
  - Define subcommands: `init`, `status`, `test`, `logs`, `uninstall`
  - Add help messages and version tracking
  - Handle errors gracefully

- **`src/commands/init.js`**: Interactive setup flow
  - Inquirer prompts:
    1. Request bot token (from @BotFather)
    2. Request group ID (with validation helper)
    3. Set timeout threshold (default 300s)
    4. Confirm hook installation
  - Validate inputs (token format, group ID is negative number)
  - Test Telegram connection before saving
  - Generate hook script dynamically
  - Update ~/.claude/settings.json

- **`src/services/config.js`**: Config persistence
  - Load/save to `~/.claude/session-monitor/config.json`
  - Encrypt bot token (optional: use `crypto` module)
  - Validate config on load
  - Support config migration

- **`src/services/telegram.js`**: API wrapper
  - `testConnection(botToken, groupId)` - verify bot works
  - `sendMessage(config, message)` - send to group
  - `sendApprovalPrompt(config, requestId, machine, ip)` - send with buttons
  - Error handling with user-friendly messages
  - Retry logic for failed requests

**Deliverables:**
- `npx claude-session-monitor init` fully functional
- Config saved securely
- Telegram connection verified before proceeding

---

### Phase 3: Hook Script Generation & Installation
**Duration**: 3-4 hours | **Complexity**: MEDIUM

**Tasks:**
- **`src/services/generator.js`**: Dynamic script generation
  - Generate bash hook with embedded config (bot token, group ID, timeout)
  - Create at `~/.claude/hooks/check-session-telegram.sh`
  - Make script executable (chmod 755)
  - Include error handling + curl fallbacks
  - Support multiple hook versions

- **`src/services/claudeSettings.js`**: Settings.json integration
  - Read existing Claude settings.json
  - Inject PreToolUse hook if not already present
  - Handle merge conflicts (idempotent)
  - Backup original settings before modification
  - Validate JSON integrity

- **Hook script logic** in bash:
  - Check lock file at `/tmp/claude-session-${USER}.lock`
  - Extract last machine + timestamp
  - Detect conflict (different machine + within timeout)
  - Send Telegram notification with conflict details
  - Create/update lock file on success
  - Handle network failures gracefully

**Deliverables:**
- Auto-generated hook script
- Safe integration with Claude CLI settings
- Lock file management working
- Backup/restore capability

---

### Phase 4: Status & Diagnostics Commands
**Duration**: 2-3 hours | **Complexity**: LOW

**Tasks:**
- **`src/commands/status.js`**: Show current setup state
  - Display: bot token (masked), group ID, timeout, install date
  - Show active session (if exists): machine name, elapsed time
  - List recent notifications from lock file history
  - Colored output with chalk
  - Health check indicator

- **`src/commands/test.js`**: Connection test
  - Load config
  - Send test message to group
  - Verify response
  - Report results
  - Troubleshooting hints if failed

- **`src/commands/logs.js`**: View session history
  - Read lock file history
  - Pretty-print with timestamps
  - Filter by machine/user (optional)
  - Export to CSV (optional)
  - Show conflict incidents

- **`src/commands/uninstall.js`**: Clean removal
  - Remove hook from Claude settings
  - Remove config directory
  - Confirm with user
  - Backup config before deletion
  - Restore previous settings if needed

**Deliverables:**
- Diagnostic commands working
- User can troubleshoot easily
- Complete audit trail available

---

### Phase 5: Advanced Features (Optional)
**Duration**: 3-4 hours | **Complexity**: MEDIUM

**Tasks:**
- **Approval workflow**:
  - Generate callback_data format: `approve_${requestId}_${machineId}`
  - Store pending approvals in file/memory
  - Poll for approval response (max 30 seconds)
  - Update hook script to wait for approval
  - Support manual override mode

- **Multi-group support**:
  - Allow multiple groups in config
  - Send to all groups simultaneously
  - Per-group timeout overrides
  - Selective notification routing

- **Encrypted token storage**:
  - Use Node.js `crypto` to encrypt bot token
  - Decrypt on-the-fly when needed
  - Store encryption key separately
  - Secure key management

- **Statistics & reporting**:
  - Track: total sessions, conflicts detected, avg session duration
  - Weekly/monthly report to group
  - Metrics export (JSON/CSV)
  - Alerting on high conflict rates

**Deliverables:**
- Advanced features (if selected)
- Documentation updated
- Backwards compatible

---

### Phase 6: Testing & Quality
**Duration**: 3-4 hours | **Complexity**: MEDIUM

**Tasks:**
- **Unit tests** (Jest):
  - Config load/save
  - Token encryption/decryption
  - Input validation
  - Telegram API mocking
  - Lock file logic

- **Integration tests**:
  - Full init flow (mocked Telegram)
  - Hook script generation
  - Settings.json injection
  - Config persistence

- **CLI smoke tests**:
  - All commands can execute
  - Help text displays correctly
  - Error messages are clear
  - Exit codes correct

- **Code quality**:
  - ESLint passes all rules
  - Prettier formatting consistent
  - Test coverage 80%+
  - No security vulnerabilities (npm audit)

**Deliverables:**
- Full test suite (Jest + E2E)
- CI/CD ready
- Security audit passed

---

### Phase 7: Documentation & Publishing
**Duration**: 2-3 hours | **Complexity**: LOW

**Tasks:**
- **README.md**:
  - Quick start (3-step setup)
  - Feature overview with examples
  - Screenshot of setup flow (optional)
  - Troubleshooting guide
  - FAQ section

- **CONTRIBUTING.md**:
  - Dev setup instructions
  - Testing locally (npm test)
  - Commit conventions
  - PR process

- **docs/ directory** (optional):
  - Architecture diagram
  - API reference
  - Hook customization guide
  - Integration examples

- **NPM package config**:
  - Correct `bin` entry point
  - Include necessary files (`.npmignore`)
  - Semantic versioning (start at 1.0.0)
  - Keywords for discoverability
  - Repository links

- **Publish to NPM**:
  - Create npm account (if needed)
  - Run `npm publish`
  - Tag release in git
  - Create GitHub release notes
  - Update package.json version

**Deliverables:**
- Package published on NPM (public)
- Documentation complete + searchable
- Community-ready with examples

---

## Dependencies & Architecture

```
User runs: npx claude-session-monitor init
    ↓
CLI prompts for bot token + group ID (via Inquirer)
    ↓
Telegram API: testConnection() → verify bot works
    ↓
Config saved to ~/.claude/session-monitor/config.json
    ↓
Generator: Create bash hook script with embedded config
    ↓
Hook installed in ~/.claude/settings.json (PreToolUse)
    ↓
Next Claude CLI session:
    ├─ Claude CLI runs PreToolUse hook
    ├─ Bash hook executes with embedded config
    ├─ Telegram API: sendMessage() → notify group
    ├─ Lock file updated/checked
    └─ Session approved or blocked
```

### External Dependencies:
- **Telegram Bot API** (HTTP REST)
- **Claude CLI** (hooks system in settings.json)
- **NPM registry** (distribution)
- **Node.js runtime** (14+)

### Internal Services:
- Config manager (file-based persistence)
- Telegram service (API wrapper)
- Hook generator (dynamic script generation)
- Claude settings patcher (JSON manipulation)

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|-----------|
| **Bot token exposure in config** | HIGH | Encrypt tokens at rest, warn users during setup, document secure practices |
| **Telegram API downtime** | MEDIUM | Add retry logic + exponential backoff, set `continueOnError: true` in hook to not block Claude |
| **Lock file race condition** | MEDIUM | Use atomic file operations, add timestamp validation, file locking |
| **Settings.json corruption** | MEDIUM | Backup before modify, validate JSON before write, provide restore command |
| **Hook doesn't trigger** | MEDIUM | Provide diagnostic command (`test`), clear error messages, documentation |
| **Group ID validation fails** | LOW | Validate format before accepting, test connection before saving |
| **Multiple CLI sessions concurrent** | MEDIUM | Lock file detects + blocks, notification sent, user informed immediately |
| **Token rotation between machines** | LOW | Support config update without re-init, version migration logic |

---

## Estimated Complexity & Timeline

| Phase | Complexity | Hours | Cumulative | Notes |
|-------|-----------|-------|-----------|-------|
| 1. Setup | LOW | 2-3 | 2-3 | Project init, tooling |
| 2. CLI Core | MEDIUM | 4-5 | 6-8 | Setup wizard, main flow |
| 3. Hook Gen | MEDIUM | 3-4 | 9-12 | Integration with Claude CLI |
| 4. Diagnostics | LOW | 2-3 | 11-15 | Status, logs, troubleshooting |
| 5. Advanced | MEDIUM | 3-4 | 14-19 | Approval workflow, encryption |
| 6. Testing | MEDIUM | 3-4 | 17-23 | Unit + integration + e2e |
| 7. Docs & Publish | LOW | 2-3 | 19-26 | README, npm publish |

**Total: 19-26 hours** | **Overall Complexity: MEDIUM**

**Recommended: Phase 1-4 as MVP (11-15h), then 5-7 for v1.0 (19-26h total)**

---

## Success Criteria

- ✅ `npx claude-session-monitor init` runs without errors
- ✅ Telegram notifications send to group on session start
- ✅ Conflicts detected and blocked correctly
- ✅ Hook integrates seamlessly with Claude CLI (no interruption)
- ✅ Package published on NPM with semantic versioning
- ✅ Test coverage >= 80% (Jest)
- ✅ Documentation complete with quick-start examples
- ✅ Security audit passed (npm audit, no vulnerabilities)
- ✅ Works on macOS, Linux, Windows (WSL)

---

## Implementation Order

### Sprint 1 (MVP): Phases 1-4
**Goal**: Functional CLI tool with basic monitoring

1. Phase 1: Setup (Day 1)
2. Phase 2: CLI + Setup Wizard (Days 1-2)
3. Phase 3: Hook Integration (Day 2)
4. Phase 4: Diagnostics (Day 3)

### Sprint 2 (v1.0): Phases 5-7
**Goal**: Production-ready, published on NPM

5. Phase 5: Advanced Features (optional, Day 3-4)
6. Phase 6: Testing (Day 4-5)
7. Phase 7: Docs & Publish (Day 5)

---

## File Structure After Completion

```
claude-session-monitor/
├── bin/
│   └── cli.js
├── src/
│   ├── commands/
│   │   ├── init.js
│   │   ├── status.js
│   │   ├── test.js
│   │   ├── logs.js
│   │   └── uninstall.js
│   ├── services/
│   │   ├── config.js
│   │   ├── telegram.js
│   │   ├── generator.js
│   │   └── claudeSettings.js
│   └── utils/
│       ├── validators.js
│       └── formatters.js
├── templates/
│   └── hook-script.sh
├── tests/
│   ├── config.test.js
│   ├── telegram.test.js
│   ├── generator.test.js
│   └── cli.integration.test.js
├── docs/
│   ├── ARCHITECTURE.md
│   ├── TROUBLESHOOTING.md
│   └── FAQ.md
├── .npmignore
├── .eslintrc.json
├── .prettierrc
├── jest.config.js
├── package.json
├── package-lock.json
├── README.md
├── CONTRIBUTING.md
├── LICENSE
└── PLAN.md
```

---

## Next Steps

**Ready to proceed?** Choose one:

1. **Start Phase 1** → Initialize project structure, setup tooling
2. **Start Phase 2** → Build CLI core + setup wizard (highest priority)
3. **Modify plan** → Adjust phases, skip optional features, reorder tasks
4. **Different approach** → Reconsider requirements or architecture

**Recommendations:**
- ✅ Start with Phase 1-4 (MVP: 11-15 hours)
- ✅ Prioritize Phase 2 (setup wizard) - core feature
- ✅ Do Phase 6 (testing) incrementally, not at the end
- ✅ Phase 5 (advanced) can be deferred to v1.1
