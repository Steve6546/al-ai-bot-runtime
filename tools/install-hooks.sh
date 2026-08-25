#!/bin/sh
# Installs the repo hooks into .git/hooks/ (no git config changes needed).
set -e
root="$(cd "$(dirname "$0")/.." && pwd)"
cp "$root/tools/pre-commit.sh" "$root/.git/hooks/pre-commit"
chmod +x "$root/.git/hooks/pre-commit" 2>/dev/null || true
echo "hooks installed: .git/hooks/pre-commit (blocks U+FFFD encoding corruption)"
