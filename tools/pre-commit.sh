#!/bin/sh
# pre-commit hook: blocks any staged source file containing U+FFFD (replacement
# char). Its presence means the file was saved with the wrong encoding at some
# point and human-readable text (Arabic strings, arrows, dashes) was destroyed.
# Install: sh tools/install-hooks.sh   (copies this file into .git/hooks/)
fail=0
for f in $(git diff --cached --name-only --diff-filter=ACM); do
  case "$f" in
    *.mjs|*.js|*.json|*.md|*.yml|*.yaml|.env.example) ;;
    *) continue ;;
  esac
  if git show ":$f" 2>/dev/null | grep -q $'\xef\xbf\xbd'; then
    echo "pre-commit: U+FFFD (encoding corruption) found in staged file: $f" >&2
    echo "           fix the encoding (UTF-8) before committing." >&2
    fail=1
  fi
done
exit $fail
