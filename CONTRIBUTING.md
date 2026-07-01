# Contributing to claude-session-monitor

Thanks for your interest in improving `claude-session-monitor`. This guide covers local setup, conventions, and the pull-request process.

## Development setup

```bash
git clone https://github.com/<your-fork>/claude-session-monitor.git
cd claude-session-monitor
npm install
```

Run the CLI locally without publishing:

```bash
node bin/cli.js --help
# or
npm start -- --help
```

## Running tests

```bash
npm test              # run the Jest suite
npm run test:coverage # run with a coverage report
```

New code must keep total coverage at **80% or higher** (lines, functions, and statements; branches at least 60%). Add tests alongside any behavior change under `tests/`, using the `*.test.js` naming convention.

## Code style

This project uses **ESLint** and **Prettier**. Before committing:

```bash
npm run lint      # report issues
npm run lint:fix  # auto-fix what can be fixed
npm run format    # apply Prettier formatting
```

Style guidelines:

- CommonJS (`require` / `module.exports`) — the package must stay `require()`-compatible (Node 22+).
- Prefer small, focused modules and functions; avoid deep nesting with early returns.
- Prefer immutable patterns — return new objects instead of mutating inputs.
- Never commit secrets. Use `.env` (git-ignored) for local tokens; `.env.example` documents the shape.

## Commit conventions

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <short description>

<optional body>
```

Allowed types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`.

Examples:

```
feat: add --json flag to the status command
fix: handle missing lock file in logs command
test: cover config encryption round-trip
```

## Pull request process

1. Fork the repo and create a feature branch (`feat/my-change`).
2. Make your change with tests and updated docs where relevant.
3. Ensure `npm run lint` and `npm test` both pass locally.
4. Push and open a PR against `main` with a clear description of the change and its motivation.
5. Include a short test plan describing how you verified the change.
6. Address review feedback; keep the branch up to date with `main`.

Only request review once CI is green and there are no merge conflicts.

## Reporting issues

When filing a bug, please include your OS, Node.js version (`node -v`), the command you ran, and the full error output (with the bot token redacted).
