#!/usr/bin/env bash
set -euo pipefail

# Publish team-coding to npm
# Usage: ./scripts/publish.sh [patch|minor|major]
#   Defaults to "patch" if no argument given.

BUMP="${1:-patch}"

if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "Usage: $0 [patch|minor|major]"
  exit 1
fi

echo "==> Building..."
npm run build

echo "==> Running tests..."
npm test

echo "==> Bumping version ($BUMP)..."
npm version "$BUMP"

echo "==> Publishing to npm (public)..."
npm publish --access public

echo "==> Pushing to remote (commits + tags)..."
git push && git push --tags

NEW_VERSION=$(node -p "require('./package.json').version")
echo ""
echo "✅ Published team-coding@${NEW_VERSION}"
echo "   Users can now run: npx team-coding@${NEW_VERSION} host"
