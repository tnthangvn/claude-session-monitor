#!/usr/bin/env bash
#
# Deploy claude-session-monitor to npm.
#
#   ./deploy.sh [patch|minor|major]   # default: patch
#
# Bumps the version, runs tests, commits the bump + tag, pushes to origin,
# and publishes to npm. Run it on a clean `main` working tree.
#
# 2FA: if your npm account requires a one-time password, either run this from
# an interactive terminal (npm will prompt) or pass it via the NPM_OTP env var:
#   NPM_OTP=123456 ./deploy.sh patch
#
# Notes:
# - Uses the git author from .git/config as-is (npm version commits with it).
#   This script never touches git config or rewrites authorship.
# - Never force-pushes; never bypasses hooks.
set -euo pipefail

LEVEL="${1:-patch}"
case "$LEVEL" in
  patch|minor|major) ;;
  *) echo "Usage: ./deploy.sh [patch|minor|major]"; exit 1 ;;
esac

# --- Safety checks -----------------------------------------------------------
if [ -n "$(git status --porcelain)" ]; then
  echo "✗ Working tree is dirty. Commit or stash your changes first."
  git status --short
  exit 1
fi

BRANCH="$(git branch --show-current)"
if [ "$BRANCH" != "main" ]; then
  echo "✗ Not on 'main' (currently on '$BRANCH'). Switch to main to release."
  exit 1
fi

if ! npm whoami >/dev/null 2>&1; then
  echo "✗ Not logged in to npm. Run: npm login"
  exit 1
fi
echo "▶ npm user: $(npm whoami)"

# --- Test --------------------------------------------------------------------
echo "▶ Running tests…"
npm test

# --- Preview the tarball -----------------------------------------------------
echo "▶ Package contents preview:"
npm pack --dry-run

# --- Version bump (commit + tag, using the configured git author) ------------
echo "▶ Bumping $LEVEL version…"
npm version "$LEVEL" -m "chore: release v%s"

# --- Push commit + tag -------------------------------------------------------
echo "▶ Pushing commit + tag to origin…"
git push origin HEAD --follow-tags

# --- Publish -----------------------------------------------------------------
echo "▶ Publishing to npm…"
if [ -n "${NPM_OTP:-}" ]; then
  npm publish --otp "$NPM_OTP"
else
  npm publish
fi

NAME="$(node -p "require('./package.json').name")"
VER="$(node -p "require('./package.json').version")"
echo "✓ Published ${NAME}@${VER}"
