#!/bin/sh
set -eu
SKILL_HOME=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
OS=$(uname -s)
ARCH=$(uname -m)
case "$OS:$ARCH" in
  Darwin:arm64) NODE="$SKILL_HOME/bin/darwin-arm64/node" ;;
  Darwin:x86_64) NODE="$SKILL_HOME/bin/darwin-x64/node" ;;
  *) printf 'Unsupported platform: %s %s (this package supports Windows and macOS only)\n' "$OS" "$ARCH" >&2; exit 1 ;;
esac
if [ ! -x "$NODE" ]; then
  printf 'Missing executable Node.js runtime: %s (check ZIP extraction permissions)\n' "$NODE" >&2
  exit 1
fi
exec "$NODE" "$SKILL_HOME/scripts/device-cli.mjs" "$@"
